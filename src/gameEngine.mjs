import { buildNpcResponseRequest } from "./responseGenerator.mjs";
import {
  getProviderName,
  PseudoResponseProvider,
  validateProviderResponse
} from "./responseProvider.mjs";
import { PHASES, ROLES, TEAMS, publicRoleName, publicTeamName, teamForRole } from "./constants.mjs";
import { SeededRandom } from "./seededRandom.mjs";
import { containsAny, extractMentionedPlayerIds } from "./textUtils.mjs";
import { createPhase3Binding, validatePhase3Response } from "./interpreterValidation.mjs";
import { canonicalJson, sha256Fingerprint } from "./conversation/ids.mjs";
import { ID_PATTERN, SHA256_PATTERN } from "./conversation/domain.mjs";
import { validateCommittedConversationGraph, validatePlayerLegacyDisplayCompatibilityReferences, validateReactionPlanReferences } from "./conversation/references.mjs";
import { validateConversationCommitResult } from "./conversation/validators.mjs";
import { preparePlayerConversationCommit, resolvePlayerConversationCommitPolicy } from "./playerConversationCommit.mjs";
import { projectMappedPlayerEntries, renderUnacknowledgedPlayerPublications, renderPlayerPublication, resolvePlayerStructuredConsumerPolicy } from "./playerStructuredConsumer.mjs";
import { PlayerPublicationDeliveryController } from "./playerPublicationDelivery.mjs";
import { buildNpcKnownInformationProjection } from "./npcKnownInformationProjection.mjs";
import { createLogicalReactionFoundation, createReactionAttemptFoundation, resolveNpcStructuredReactionPolicy } from "./npcReactionFoundation.mjs";
import { createNpcAuthoritativeConversationRegistries, validateNpcAuthoritativeStateFoundation } from "./npcAuthoritativeStateFoundation.mjs";
import { NPC_REACTION_COMMIT_REJECTION_CODES, commitNpcReactionAuthoritatively } from "./npcReactionAuthoritativeCommit.mjs";
import { validateNpcReactionCoordinatorRoot } from "./npcReactionCoordinator.mjs";
import {
  buildNpcReactionCommitTransactionProjection,
  translateNpcReactionCommitReplacementToAuthorizedDelta,
  validateNpcReactionAuthorizedDelta,
  validateNpcReactionCommitTransactionProjection
} from "./npcReactionAuthorityTranslation.mjs";
import {
  NpcStructuredReactionAuthorityPortInvariantError,
  validateNpcStructuredReactionAuthoritySnapshot
} from "./npcStructuredReactionAuthorityPort.mjs";

const DEFAULT_PLAYERS = [
  {
    id: "npc1",
    name: "Aoi",
    aliases: ["A", "青井", "アオイ"],
    personality: "冷静で観察好き",
    speechStyle: "calm"
  },
  {
    id: "npc2",
    name: "Beni",
    aliases: ["B", "紅", "ベニ"],
    personality: "素直でやや不安がり",
    speechStyle: "soft"
  },
  {
    id: "npc3",
    name: "Chika",
    aliases: ["C", "千佳", "チカ"],
    personality: "押しが強く話題転換がうまい",
    speechStyle: "direct"
  },
  {
    id: "npc4",
    name: "Daichi",
    aliases: ["D", "大地", "ダイチ"],
    personality: "慎重で投票理由にこだわる",
    speechStyle: "cautious"
  },
  {
    id: "npc5",
    name: "Ema",
    aliases: ["E", "絵真", "エマ"],
    personality: "論理重視で発言を整理する",
    speechStyle: "logical"
  }
];

const SAMPLE_ROLE_BY_ID = {
  npc1: ROLES.SEER,
  npc2: ROLES.CITIZEN,
  npc3: ROLES.WEREWOLF,
  npc4: ROLES.CITIZEN,
  npc5: ROLES.CITIZEN
};

const SAMPLE_SUSPICION = {
  npc1: { npc2: 0, npc3: 1, npc4: 3, npc5: 1 },
  npc2: { npc1: 0, npc3: 1, npc4: 2, npc5: 0 },
  npc3: { npc1: 1, npc2: 0, npc4: 4, npc5: 2 },
  npc4: { npc1: 0, npc2: 1, npc3: 2, npc5: 0 },
  npc5: { npc1: 0, npc2: 0, npc3: 3, npc4: 2 }
};

const ACCUSATORY_QUESTION_KEYWORDS = [
  "怪しい",
  "疑",
  "人狼",
  "矛盾",
  "おかしい",
  "黒",
  "suspicious",
  "suspect",
  "werewolf",
  "wolf",
  "black"
];

export class WerewolfGame {
  static create(options = {}) {
    const createId = options.createId ?? (() => globalThis.crypto.randomUUID());
    const rng = new SeededRandom(options.seed ?? Date.now());
    const roles = assignRoles({ rng, shuffleRoles: options.shuffleRoles ?? true, scenario: options.scenario });
    const players = DEFAULT_PLAYERS.map((template) => {
      const role = roles[template.id];
      return createPlayerState(template, role);
    });

    initializeSuspicion(players, rng, options.scenario);
    const npcRegistries = createNpcAuthoritativeConversationRegistries();

    const state = {
      gameSessionId: engineId("game", createId),
      turnId: engineId("turn", createId),
      turnOrder: 0,
      stateVersion: 0,
      day: 1,
      phase: "day_discussion",
      players,
      alivePlayers: players.map((player) => player.id),
      deadPlayers: [],
      publicInfo: [],
      voteHistory: [],
      winner: null,
      playerLog: [],
      developerLog: [],
      conversation: {
        inputRecords: [], acceptedSpeechActs: [], claims: [], events: [], displayPlans: [],
        reactionPlans: npcRegistries.reactionPlans,
        publications: [], playerLegacyDisplayCompatibilityRecords: [], commitResults: [], idempotencyRecords: [],
        npcReactionCommitIdempotencyRecords: npcRegistries.npcReactionCommitIdempotencyRecords,
        nextCreatedOrder: 0, nextPublicationSlotOrder: 0, nextRecordAppendOrder: 0
      },
      rng,
      config: {
        seed: options.seed ?? null,
        scenario: options.scenario ?? "default"
      }
    };

    const game = new WerewolfGame(
      state,
      options.responseProvider ?? new PseudoResponseProvider(),
      { createId, interpreterProvider: options.interpreterProvider, interpreterValidationEnabled: options.interpreterValidationEnabled === true, playerConversationCommitEnabled: options.playerConversationCommitEnabled === true, playerStructuredConsumerEnabled: options.playerStructuredConsumerEnabled === true, npcStructuredReactionEnabled: options.npcStructuredReactionEnabled === true, playerStructuredConsumerObserver: options.playerStructuredConsumerObserver, phase4FaultInjector: options.phase4FaultInjector, npcAuthorityFaultInjector: options.npcAuthorityFaultInjector, interpreterObserver: options.interpreterObserver, now: options.now }
    );
    game.addPublicInfo({
      type: "setup",
      text: "公開情報: 5人村。内訳は人狼1、占い師1、市民3。役職欠けなし。"
    });
    game.addPlayerLog("1日目の昼。5人のNPCが議論を始めました。");
    game.addDeveloperLog("initial_roles", {
      roles: players.map((player) => ({
        id: player.id,
        name: player.name,
        role: player.role,
        team: player.team
      }))
    });
    game.addDeveloperLog("initial_player_states", game.createDeveloperSnapshot());
    return game;
  }

  constructor(state, responseProvider = new PseudoResponseProvider(), options = {}) {
    validateNpcAuthoritativeStateFoundation(state);
    this.state = state;
    this.responseProvider = responseProvider;
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID());
    this.interpreterProvider = options.interpreterProvider;
    this.interpreterValidationEnabled = options.interpreterValidationEnabled === true;
    this.playerConversationCommitEnabled = resolvePlayerConversationCommitPolicy({ playerConversationCommitMode: options.playerConversationCommitEnabled === true, interpreterValidationMode: this.interpreterValidationEnabled }).enabled;
    this.playerStructuredConsumerEnabled = resolvePlayerStructuredConsumerPolicy({ playerStructuredConsumerMode: options.playerStructuredConsumerEnabled === true, playerConversationCommitMode: this.playerConversationCommitEnabled }).enabled;
    this.npcStructuredReactionEnabled = resolveNpcStructuredReactionPolicy({ npcStructuredReactionMode: options.npcStructuredReactionEnabled === true, playerConversationCommitMode: this.playerConversationCommitEnabled }).enabled;
    this.playerStructuredConsumerObserver = options.playerStructuredConsumerObserver ?? (() => {});
    this.playerPublicationDeliveryController = new PlayerPublicationDeliveryController({ gameSessionId: state.gameSessionId, createId: this.createId, observer: this.playerStructuredConsumerObserver, enabled: this.playerStructuredConsumerEnabled, initialWatermark: 0, isQuiescent: () => !this._commandInProgress && !this.activeNpcReaction && ![...this.pendingInterpreterRequests.values()].some((pending) => pending.status === "pending"), listPublications: () => this.state.conversation.publications.filter((record) => record.recordType === "player_utterance_published").sort((a, b) => a.publicationSlotOrder - b.publicationSlotOrder), resolvePublication: (publicationId, deliveryMode) => deliveryMode === "structured" ? this._displayPlayerPublication(this._renderPlayerPublication(publicationId)) : this._legacyPlayerPublication(publicationId), resolvePreCutoverIdentity: (publicationId) => { const mapping = this.getPlayerLegacyDisplayCompatibilityRecord({ publicationId }); return { compatibilityMappingId: mapping.compatibilityMappingId, legacyEntryId: mapping.legacyEntryId, legacyLogAppendOrder: mapping.legacyLogAppendOrder, legacyEntryFingerprint: mapping.legacyEntryFingerprint }; } });
    this.phase4FaultInjector = options.phase4FaultInjector ?? (() => {});
    this.npcAuthorityFaultInjector = options.npcAuthorityFaultInjector ?? (() => {});
    this.interpreterObserver = options.interpreterObserver ?? (() => {});
    this.now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
    this.pendingInterpreterRequests = new Map();
    this.interpreterTerminalAudit = new Map();
    this.activeNpcReaction = null;
    this._commandInProgress = false;
    this.npcAuthorityCommitInProgress = false;
    this.npcAuthorityCommitOwner = null;
    this._destroyed = false;
  }

  getPlayer(idOrName) {
    const normalized = String(idOrName).toLowerCase();
    return this.state.players.find((player) => {
      const labels = [player.id, player.name, ...(player.aliases ?? [])].map((label) => String(label).toLowerCase());
      return labels.includes(normalized);
    });
  }

  getAlivePlayers() {
    return this.state.alivePlayers.map((id) => this.getPlayer(id));
  }

  getDeadPlayers() {
    return this.state.deadPlayers.map((id) => this.getPlayer(id));
  }

  buildNpcKnownInformationProjection(actorId, triggerId) {
    return buildNpcKnownInformationProjection(actorId, triggerId, this.state);
  }

  createNpcReactionFoundation(actorId, triggerId) {
    const projection = this.buildNpcKnownInformationProjection(actorId, triggerId);
    const trigger = projection.public.triggeringInput;
    const logicalReaction = createLogicalReactionFoundation({
      gameSessionId: this.state.gameSessionId,
      triggerRequestId: trigger.requestId,
      inputRecordId: trigger.inputRecordId,
      turnId: trigger.turnId,
      turnOrder: this.state.turnOrder,
      phase: projection.public.phase,
      actorId,
      baseStateVersion: trigger.capturedStateVersion + 1,
      createId: this.createId
    });
    return deepFreeze({ logicalReaction, projection });
  }

  createNpcReactionAttemptFoundation(logicalReaction) {
    return createReactionAttemptFoundation(logicalReaction, this.createId);
  }

  setPhase(phase) {
    if (!PHASES.includes(phase)) {
      throw new Error(`Unknown phase: ${phase}`);
    }
    this.state.phase = phase;
    this.addDeveloperLog("phase_change", { day: this.state.day, phase });
  }

  addPlayerLog(message) {
    this.state.playerLog.push({
      day: this.state.day,
      phase: this.state.phase,
      message
    });
  }

  addDeveloperLog(kind, detail) {
    this.state.developerLog.push({
      day: this.state.day,
      phase: this.state.phase,
      kind,
      detail
    });
  }

  addPublicInfo(info) {
    this.state.publicInfo.push({
      day: this.state.day,
      phase: this.state.phase,
      ...info
    });
  }

  async dispatchPlayerAction(action = {}) {
    const logCursor = Number.isInteger(action.logCursor) ? action.logCursor : this.state.playerLog.length;
    if (action.type === "get_state") return this._actionResult(action.type, null, logCursor);
    if (action.type === "ask_npc" && action.replayRequestId) return this._replayPlayerConversation(action, logCursor);
    if (this.playerPublicationDeliveryController.modeState().transitionStatus === "draining_pre_cutover") throw typedError("consumer_mode_transition_pending");
    const rejected = this._validateCommand(action); if (rejected) return this._actionResult(action.type, rejected, logCursor);
    if (this._commandInProgress) throw typedError("input_in_progress");
    if (!Number.isSafeInteger(this.state.stateVersion) || this.state.stateVersion < 0 || this.state.stateVersion === Number.MAX_SAFE_INTEGER) throw typedError("state_version_exhausted");
    if (!Number.isSafeInteger(this.state.turnOrder) || this.state.turnOrder < 0 || this.state.turnOrder === Number.MAX_SAFE_INTEGER) throw typedError("turn_order_exhausted");
    this._commandInProgress = true;
    const preconditionVersion = this.state.stateVersion;
    const continuation = this._clarificationContinuation(action); if (!continuation) { this.state.turnOrder += 1; this.state.turnId = engineId("turn", this.createId); }
    try {
      const interpreted = action.type === "ask_npc" && this.interpreterValidationEnabled ? await this._observeInterpreter(action) : null;
      if (this._destroyed) throw abortError();
      if (action.type === "ask_npc" && this.playerConversationCommitEnabled && interpreted?.outcome?.category === "validated") {
        const result = await this._commitStructuredPlayerQuestion(action, interpreted, preconditionVersion);
        return this._actionResult(action.type, result, logCursor);
      }
      const working = this._workingCopy(), result = await working._executeCompatibilityAction(action);
      if (this._destroyed || this.state.stateVersion !== preconditionVersion || this.state.turnId !== working.state.turnId || this.state.gameSessionId !== working.state.gameSessionId) throw typedError("stale_state_version");
      working.state.stateVersion = preconditionVersion + 1; validateNpcAuthoritativeStateFoundation(working.state); commitState(this.state, working.state);
      return this._actionResult(action.type, result, logCursor);
    } finally { this._commandInProgress = false; }
  }

  async _executeCompatibilityAction(action) {
    if (action.type === "ask_npc") return await this.handlePlayerQuestion(action.targetId ?? action.target ?? action.npcId, action.input ?? action.question);
    if (action.type === "advance_vote") return this.runVote();
    if (action.type === "run_night") return this.runNight();
    throw new Error(`Unknown player action type: ${action.type}`);
  }

  _actionResult(actionType, result, logCursor) {
    const playerLogEntries = this.state.playerLog.slice(logCursor); let structuredPlayerEntries = [], playerFacingEntries = structuredClone(playerLogEntries), deliveryPublicationIds = [], livePlayerDisplayEntries = [];
    const historyEntries = this._renderPlayerPublicationIds(this.playerPublicationDeliveryController.historyPublicationIds()); playerFacingEntries = projectMappedPlayerEntries({ legacyEntries: playerLogEntries, legacyLogStartOrder: logCursor, structuredEntries: historyEntries });
    if (actionType !== "get_state" && result?.replayed !== true) { const candidates = this.playerPublicationDeliveryController.discoverCandidates(); deliveryPublicationIds = candidates.map((candidate) => candidate.publicationId); structuredPlayerEntries = this._renderPlayerPublicationIds(candidates.filter((candidate) => candidate.deliveryMode === "structured" && !candidate.acknowledgementOnly).map((candidate) => candidate.publicationId)).map((entry) => this._displayPlayerPublication(entry)); livePlayerDisplayEntries = this._livePlayerDisplayEntries(playerLogEntries, logCursor, candidates); }
    return { ok: true, actionType, result, publicSnapshot: this.getPublicSnapshot(), playerLogEntries, structuredPlayerEntries, deliveryPublicationIds, livePlayerDisplayEntries, playerFacingEntries, nextLogCursor: this.state.playerLog.length };
  }

  _publicParticipantsById() { return Object.fromEntries([["player", { participantId: "player", displayName: "Player" }], ...this.state.players.map((player) => [player.id, { participantId: player.id, displayName: player.name }])]); }
  _renderPlayerPublication(publicationId) { return renderPlayerPublication({ gameSessionId: this.state.gameSessionId, conversation: this.state.conversation, legacyPlayerLog: this.state.playerLog, publicationId, publicParticipantsById: this._publicParticipantsById(), resolveCompatibilityMapping: (id) => this.getPlayerLegacyDisplayCompatibilityRecord({ publicationId: id }) }); }
  _renderPlayerPublicationIds(publicationIds) { return renderUnacknowledgedPlayerPublications({ gameSessionId: this.state.gameSessionId, conversation: this.state.conversation, legacyPlayerLog: this.state.playerLog, publicationIds, publicParticipantsById: this._publicParticipantsById(), resolveCompatibilityMapping: (id) => this.getPlayerLegacyDisplayCompatibilityRecord({ publicationId: id }) }); }
  _displayPlayerPublication(entry) { const legacy = this.state.playerLog[entry.legacyLogAppendOrder]; return Object.freeze({ day: legacy.day, phase: legacy.phase, message: entry.renderedText, actorId: entry.actorId, publicationId: entry.publicationId, structured: true }); }
  _legacyPlayerPublication(publicationId) { const mapping = this.getPlayerLegacyDisplayCompatibilityRecord({ publicationId }), entry = this.state.playerLog[mapping.legacyLogAppendOrder]; return Object.freeze(structuredClone(entry)); }
  _livePlayerDisplayEntries(entries, startOrder, candidates) { const mappings = new Map(this.state.conversation.playerLegacyDisplayCompatibilityRecords.map((mapping) => [mapping.legacyLogAppendOrder, mapping.publicationId])), mappingByPublication = new Map(this.state.conversation.playerLegacyDisplayCompatibilityRecords.map((mapping) => [mapping.publicationId, mapping])), ordered = candidates.map((candidate) => ({ order: mappingByPublication.get(candidate.publicationId).legacyLogAppendOrder, envelope: Object.freeze({ kind: "player_publication_delivery", ...candidate }) }));
    for (let index = 0; index < entries.length; index += 1) { const order = startOrder + index; if (!mappings.has(order)) ordered.push({ order, envelope: Object.freeze({ kind: "legacy_display", entry: structuredClone(entries[index]) }) }); }
    return ordered.sort((left, right) => left.order - right.order).map(({ envelope }) => envelope); }
  getPlayerPublicationDeliveryCandidates() { return this.playerPublicationDeliveryController.discover(); }
  getPlayerPublicationConsumerModeState() { return this.playerPublicationDeliveryController.modeState(); }
  requestPlayerPublicationConsumerMode({ gameSessionId = this.state.gameSessionId, consumerId, sinkType, requestedMode }) { return this.playerPublicationDeliveryController.requestMode({ gameSessionId, consumerId, sinkType, requestedMode, nextPublicationSlotOrder: this.state.conversation.nextPublicationSlotOrder }); }
  getPendingPreCutoverPlayerPublications(value) { return this.playerPublicationDeliveryController.pendingPreCutover(value); }
  completePlayerPublicationConsumerModeTransition(value) { return this.playerPublicationDeliveryController.completeTransition(value); }
  cancelPlayerPublicationConsumerModeTransition(value) { return this.playerPublicationDeliveryController.cancelTransition(value); }
  recordPreCutoverPlayerPublicationEvidence(receipt) { return this.playerPublicationDeliveryController.recordPreCutoverEvidence(receipt); }
  preparePlayerPublicationDelivery(value) { return this.playerPublicationDeliveryController.prepare(value); }
  beginPlayerPublicationSink(value) { return this.playerPublicationDeliveryController.begin(value); }
  completePlayerPublicationSink(capability) { return this.playerPublicationDeliveryController.complete(capability); }
  failPlayerPublicationSink(capability) { return this.playerPublicationDeliveryController.fail(capability); }
  acknowledgePlayerPublication(receipt) { return this.playerPublicationDeliveryController.acknowledge(receipt); }
  getPlayerPublicationSinkReceipt(value) { return this.playerPublicationDeliveryController.receiptFor(value); }

  _replayPlayerConversation(action, logCursor) {
    if (typeof action.replayRequestId !== "string" || !ID_PATTERN.test(action.replayRequestId) || typeof action.replayRequestFingerprint !== "string" || !SHA256_PATTERN.test(action.replayRequestFingerprint)) throw typedError("invalid_replay_identity");
    const record = this.state.conversation?.idempotencyRecords.find((entry) => entry.requestId === action.replayRequestId);
    if (!record) throw typedError("replay_not_found");
    if (action.replayRequestFingerprint !== record.requestFingerprint) throw typedError("idempotency_conflict");
    this._assertReplayCompatibilityMapping(record.result.playerPublicationId);
    return this._actionResult(action.type, { responded: false, replayed: true, conversationCommitResult: structuredClone(record.result) }, logCursor);
  }

  async _commitStructuredPlayerQuestion(action, interpreted, preconditionVersion) {
    const target = this.getPlayer(action.targetId ?? action.target ?? action.npcId);
    const playerCommitRegistryFingerprint = sha256Fingerprint({ claims: this.state.conversation.claims, mappings: this.state.conversation.playerLegacyDisplayCompatibilityRecords, nextCreatedOrder: this.state.conversation.nextCreatedOrder, playerLogLength: this.state.playerLog.length });
    const prepared = preparePlayerConversationCommit({ state: this.state, binding: interpreted.binding, alternative: interpreted.outcome.selectedAlternative, targetNpcId: target.id, createId: this.createId, fault: this.phase4FaultInjector });
    if (prepared.replay) return { responded: false, replayed: true, conversationCommitResult: prepared.result };
    const working = this._workingCopy(), delta = prepared.delta;
    this._assertPlayerCommitCas(interpreted, delta, target.id, preconditionVersion, playerCommitRegistryFingerprint);
    for (const [key, values] of Object.entries(delta.objects)) working.state.conversation[key].push(...structuredClone(values));
    this.phase4FaultInjector("mapping_registry_staged"); working.state.conversation.idempotencyRecords.push(structuredClone(delta.idempotencyRecord)); this.phase4FaultInjector("commit_result_insertion"); Object.assign(working.state.conversation, delta.counters);
    working.state.playerLog.push(structuredClone(delta.legacyDelta.playerLogEntry)); this.phase4FaultInjector("legacy_log_staged"); working.state.publicInfo.push(structuredClone(delta.legacyDelta.publicInfoEntry));
    validateCommittedConversationGraph(this._conversationGraph(working.state)); this.phase4FaultInjector("mapping_graph_validation");
    working.setPhase("player_question"); working.applyQuestionPressure(String(action.input ?? action.question).trim());
    this.phase4FaultInjector("final_state_replacement"); working.state.stateVersion = preconditionVersion + 1; validateNpcAuthoritativeStateFoundation(working.state); commitState(this.state, working.state);
    const reactionBinding = Object.freeze({ gameSessionId: this.state.gameSessionId, turnId: this.state.turnId, turnOrder: this.state.turnOrder, preconditionPhase: this.state.phase, preconditionStateVersion: this.state.stateVersion, targetNpcId: target.id, requestId: delta.requestId, correlationId: delta.correlationId, inputRecordId: delta.inputRecordId, requestFingerprint: delta.requestFingerprint });
    const controller = new AbortController(), active = { binding: reactionBinding, controller }; this.activeNpcReaction = active;
    try {
      const npcWorking = this._workingCopy(), reaction = await npcWorking.handlePlayerQuestion(target.id, action.input ?? action.question, { skipPlayerSide: true, signal: controller.signal });
      this._assertNpcReactionCas(active, npcWorking);
      if (reaction?.reason === "response_provider_error") return { ...reaction, conversationCommitResult: structuredClone(prepared.result) };
      this.phase4FaultInjector("npc_final_state_replacement"); npcWorking.state.stateVersion = preconditionVersion + 2; validateNpcAuthoritativeStateFoundation(npcWorking.state); commitState(this.state, npcWorking.state);
      return { ...reaction, conversationCommitResult: structuredClone(prepared.result) };
    } finally { if (this.activeNpcReaction === active) this.activeNpcReaction = null; }
  }

  _assertPlayerCommitCas(interpreted, delta, targetNpcId, version, playerCommitRegistryFingerprint) {
    const binding = interpreted.binding, terminal = this.interpreterTerminalAudit.get(binding.requestId), target = this.getPlayer(targetNpcId);
    const identityMatches = binding.requestId === delta.requestId && binding.correlationId === delta.correlationId && binding.inputRecordId === delta.inputRecordId && binding.actorId === "player" && binding.requestFingerprint === delta.requestFingerprint && binding.targetNpcId === targetNpcId && binding.request.requestId === binding.requestId && binding.request.correlationId === binding.correlationId && binding.request.inputRecordId === binding.inputRecordId && sha256Fingerprint(binding.request) === binding.requestFingerprint;
    const terminalMatches = terminal?.status === "completed" && terminal.responseFingerprint === interpreted.responseFingerprint && terminal.outcome?.category === "validated";
    const mapping = delta.objects.playerLegacyDisplayCompatibilityRecords[0];
    const liveRegistryFingerprint = sha256Fingerprint({ claims: this.state.conversation.claims, mappings: this.state.conversation.playerLegacyDisplayCompatibilityRecords, nextCreatedOrder: this.state.conversation.nextCreatedOrder, playerLogLength: this.state.playerLog.length });
    const liveMatches = !this._destroyed && this.state.stateVersion === version && this.state.turnId === delta.turnId && this.state.turnOrder === binding.turnOrder && this.state.phase === delta.preconditionPhase && this.state.gameSessionId === delta.gameSessionId && target?.id === targetNpcId && liveRegistryFingerprint === playerCommitRegistryFingerprint && mapping?.legacyLogAppendOrder === this.state.playerLog.length;
    if (!identityMatches || !terminalMatches || !liveMatches) throw typedError("stale_commit_precondition");
  }

  _conversationGraph(state = this.state) { return { ...state.conversation, gameSessionId: state.gameSessionId, legacyPlayerLog: state.playerLog }; }

  _assertReplayCompatibilityMapping(publicationId) {
    const matches = this.state.conversation.playerLegacyDisplayCompatibilityRecords.filter((record) => record.publicationId === publicationId);
    if (matches.length === 0) throw typedError("replay_mapping_missing");
    if (matches.length !== 1) throw typedError("replay_mapping_conflict");
    try { validatePlayerLegacyDisplayCompatibilityReferences(this.state.conversation.playerLegacyDisplayCompatibilityRecords, this._conversationGraph()); }
    catch { throw typedError("replay_mapping_conflict"); }
  }

  getPlayerLegacyDisplayCompatibilityRecord({ publicationId, compatibilityMappingId, gameSessionId = this.state.gameSessionId } = {}) {
    if (gameSessionId !== this.state.gameSessionId) throw typedError("stale_session");
    if ((publicationId === undefined) === (compatibilityMappingId === undefined)) throw typedError("invalid_mapping_lookup");
    const key = publicationId ?? compatibilityMappingId; if (typeof key !== "string" || !ID_PATTERN.test(key)) throw typedError("invalid_mapping_lookup");
    validatePlayerLegacyDisplayCompatibilityReferences(this.state.conversation.playerLegacyDisplayCompatibilityRecords, this._conversationGraph());
    const matches = this.state.conversation.playerLegacyDisplayCompatibilityRecords.filter((record) => publicationId ? record.publicationId === publicationId : record.compatibilityMappingId === compatibilityMappingId);
    if (matches.length === 0) throw typedError("mapping_not_found"); if (matches.length !== 1) throw typedError("mapping_conflict");
    return deepFreeze(structuredClone(matches[0]));
  }

  _assertNpcReactionCas(active, npcWorking) {
    const binding = active.binding, target = this.getPlayer(binding.targetNpcId), record = this.state.conversation.idempotencyRecords.find((entry) => entry.requestId === binding.requestId);
    const identityMatches = this.activeNpcReaction === active && !active.controller.signal.aborted && record?.requestFingerprint === binding.requestFingerprint && record.result.correlationId === binding.correlationId && record.result.inputRecordId === binding.inputRecordId;
    const liveMatches = !this._destroyed && this.state.gameSessionId === binding.gameSessionId && this.state.turnId === binding.turnId && this.state.turnOrder === binding.turnOrder && this.state.phase === binding.preconditionPhase && this.state.stateVersion === binding.preconditionStateVersion && target?.id === binding.targetNpcId && npcWorking.state.gameSessionId === binding.gameSessionId && npcWorking.state.turnId === binding.turnId;
    if (!identityMatches || !liveMatches) throw typedError("stale_reaction");
  }

  _validateCommand(action) {
    if (!["ask_npc", "advance_vote", "run_night", "get_state"].includes(action.type)) throw new Error(`Unknown player action type: ${action.type}`);
    if (this.state.winner) return action.type === "ask_npc" ? { responded: false, reason: "game_already_finished" } : action.type === "run_night" ? { skipped: true, reason: "game_already_finished" } : null;
    if (action.type === "ask_npc") { const target = action.targetId ?? action.target ?? action.npcId; if (!this.getPlayer(target)) throw new Error(`Unknown NPC: ${target}`); if (!String(action.input ?? action.question ?? "").trim()) throw new TypeError("Player input is required"); }
    if (action.clarificationRequestId && !this._clarificationContinuation(action)) throw typedError("invalid_clarification_continuation");
    return null;
  }

  _clarificationContinuation(action) { if (action.type !== "ask_npc" || !action.clarificationRequestId) return false; const prior = this.interpreterTerminalAudit.get(action.clarificationRequestId); return prior?.outcome?.category === "clarification" && prior.turnId === this.state.turnId; }

  readNpcStructuredReactionSnapshot(input) {
    if (this._destroyed || this.npcAuthorityCommitInProgress) throw npcAuthorityInvariant("invalid_npc_structured_authority_state");
    const request = reconstructNpcAuthorityReadInput(input);
    if (request.gameSessionId !== this.state.gameSessionId) throw npcAuthorityInvariant("invalid_npc_structured_trigger_graph");
    try { validateNpcAuthoritativeStateFoundation(this.state); validateCommittedConversationGraph(this._conversationGraph()); }
    catch { throw npcAuthorityInvariant("invalid_npc_structured_authority_state"); }
    this.npcAuthorityFaultInjector("read_before_trigger_resolution");
    const trigger = resolveNpcStructuredTrigger(this.state, request);
    this.npcAuthorityFaultInjector("read_after_trigger_resolution");
    const replay = resolveNpcStructuredCommittedReplay(this.state, trigger);
    if (replay.status === "replayed") return buildNpcAuthorityReplayReadResult(this.state, request, replay);
    if (replay.status === "conflict") return buildNpcAuthorityConflictReadResult(this.state, request, replay.code);
    if (!isNpcStructuredTriggerCurrentlyApplicable(this.state, trigger)) {
      return buildNpcAuthorityConflictReadResult(this.state, request, "stale_trigger");
    }
    const actor = this.state.players.find((player) => player.id === trigger.targetNpcId);
    if (!actor) throw npcAuthorityInvariant("invalid_npc_structured_trigger_graph");
    let knownInformationProjection;
    try {
      knownInformationProjection = buildNpcKnownInformationProjection(actor.id, trigger.result.requestId, this.state);
    } catch { throw npcAuthorityInvariant("invalid_npc_structured_authority_snapshot"); }
    const preparation = buildNpcPreparationAuthorityContext(this.state, actor);
    const snapshot = {
      schemaVersion: 1,
      snapshotType: "npc_structured_reaction_authority",
      gameSessionId: this.state.gameSessionId,
      turnId: this.state.turnId,
      turnOrder: this.state.turnOrder,
      currentPhase: this.state.phase,
      stateVersion: this.state.stateVersion,
      triggeringCommitResult: structuredClone(trigger.result),
      originatingInputRecord: structuredClone(trigger.input),
      triggeringEvents: structuredClone(trigger.events),
      targetNpcId: actor.id,
      knownInformationProjection: structuredClone(knownInformationProjection),
      currentRoster: structuredClone(preparation.currentRoster),
      actorApplicability: structuredClone(preparation.actorApplicability),
      currentAuthorization: structuredClone(preparation.currentAuthorization),
      currentTargetIds: structuredClone(preparation.currentTargetIds),
      existingClaims: structuredClone(this.state.conversation.claims),
      existingEvents: structuredClone(this.state.conversation.events),
      nextOrderEvidence: {
        nextCreatedOrder: this.state.conversation.nextCreatedOrder,
        nextPublicationSlotOrder: this.state.conversation.nextPublicationSlotOrder,
        nextRecordAppendOrder: this.state.conversation.nextRecordAppendOrder
      },
      occupiedArtifactIds: collectNpcAuthorityIds(this.state),
      publicParticipantsById: buildNpcPublicParticipants(this.state),
      committedReplay: structuredClone(replay)
    };
    try { validateNpcStructuredReactionAuthoritySnapshot(snapshot); }
    catch { throw npcAuthorityInvariant("invalid_npc_structured_authority_snapshot"); }
    this.npcAuthorityFaultInjector("read_before_snapshot_freeze");
    return deepFreeze(snapshot);
  }

  commitPreparedNpcReactionAtomically(input) {
    if (this._destroyed || this.npcAuthorityCommitInProgress) throw npcAuthorityInvariant("invalid_npc_structured_authority_state");
    const request = reconstructNpcAuthorityCommitInput(input);
    if (request.gameSessionId !== this.state.gameSessionId) throw npcAuthorityInvariant("invalid_npc_structured_commit_input");
    if (request.expectedStateVersion !== this.state.stateVersion) {
      return deepFreeze({
        schemaVersion: 1,
        status: "conflict",
        gameSessionId: this.state.gameSessionId,
        expectedStateVersion: request.expectedStateVersion,
        currentStateVersion: this.state.stateVersion
      });
    }
    this.npcAuthorityCommitInProgress = true;
    const transactionOwner = Object.freeze({});
    this.npcAuthorityCommitOwner = transactionOwner;
    try {
      try { validateNpcAuthoritativeStateFoundation(this.state); validateCommittedConversationGraph(this._conversationGraph()); }
      catch { throw npcAuthorityInvariant("invalid_npc_structured_authority_state"); }
      const livePrecondition = captureNpcAuthorityLivePrecondition(this.state);
      this.npcAuthorityFaultInjector("commit_before_working_copy");
      const working = this._workingCopy();
      this.npcAuthorityFaultInjector("commit_after_working_copy");
      try { validateNpcAuthoritativeStateFoundation(working.state); validateCommittedConversationGraph(working._conversationGraph()); }
      catch { throw npcAuthorityInvariant("invalid_npc_structured_working_state"); }
      let currentProjection;
      try { currentProjection = buildNpcReactionCommitTransactionProjection(working.state); validateNpcReactionCommitTransactionProjection(currentProjection); }
      catch { throw npcAuthorityInvariant("invalid_npc_structured_commit_projection"); }
      this.npcAuthorityFaultInjector("commit_after_projection");
      const binding = request.preparedReaction?.delta?.binding;
      if (!binding || binding.gameSessionId !== working.state.gameSessionId) {
        throw npcAuthorityInvariant("invalid_npc_structured_commit_input");
      }
      const actor = working.state.players.find((player) => player.id === binding.npcId);
      const preparation = buildNpcPreparationAuthorityContext(working.state, actor, binding.npcId);
      const liveValidationContext = {
        schemaVersion: 1,
        contextType: "npc_reaction_commit_live",
        gameSessionId: working.state.gameSessionId,
        turnId: working.state.turnId,
        turnOrder: working.state.turnOrder,
        currentPhase: working.state.phase,
        currentStateVersion: working.state.stateVersion,
        actorApplicability: preparation.actorApplicability,
        currentAuthorization: preparation.currentAuthorization,
        currentTargetIds: preparation.currentTargetIds
      };
      try {
        validateNpcReactionCoordinatorRoot(request.coordinatorRoot);
        validateReactionPlanReferences(request.preparedReaction.delta.plan, request.preCommitReferenceContext);
      } catch { throw npcAuthorityInvariant("invalid_npc_structured_commit_input"); }
      this.npcAuthorityFaultInjector("commit_before_pure_commit");
      const commitResult = commitNpcReactionAuthoritatively({
        schemaVersion: 1,
        currentState: currentProjection,
        preparedReaction: request.preparedReaction,
        preCommitReferenceContext: request.preCommitReferenceContext,
        coordinatorRoot: request.coordinatorRoot,
        liveValidationContext
      });
      this.npcAuthorityFaultInjector("commit_after_pure_commit");
      validateNpcAuthorityCommitPrimitiveResult(commitResult, request.preparedReaction, request.expectedStateVersion);
      if (commitResult.status === "replayed" || commitResult.status === "rejected") return deepFreeze(structuredClone(commitResult));
      let authorizedDelta;
      try {
        validateNpcReactionCommitTransactionProjection(commitResult.replacementState);
        this.npcAuthorityFaultInjector("commit_before_translation");
        authorizedDelta = translateNpcReactionCommitReplacementToAuthorizedDelta({
          currentProjection,
          replacementProjection: commitResult.replacementState,
          preparedReaction: request.preparedReaction
        });
        this.npcAuthorityFaultInjector("commit_after_translation");
        validateNpcReactionAuthorizedDelta(authorizedDelta);
      } catch { throw npcAuthorityInvariant("invalid_npc_structured_authorized_delta"); }
      const beforeWorking = cloneState(working.state);
      this.npcAuthorityFaultInjector("commit_before_delta_apply");
      applyNpcAuthorizedDelta(working.state, authorizedDelta);
      this.npcAuthorityFaultInjector("commit_after_delta_apply");
      assertNpcAuthorityForbiddenPathsPreserved(beforeWorking, working.state, authorizedDelta);
      this.npcAuthorityFaultInjector("commit_before_working_validation");
      try {
        validateNpcAuthoritativeStateFoundation(working.state);
        validateCommittedConversationGraph(working._conversationGraph());
        validateNpcReactionCommitTransactionProjection(buildNpcReactionCommitTransactionProjection(working.state));
      } catch { throw npcAuthorityInvariant("invalid_npc_structured_working_state"); }
      if (working.state.stateVersion !== request.expectedStateVersion + 1) throw npcAuthorityInvariant("invalid_npc_structured_state_replacement");
      this.npcAuthorityFaultInjector("commit_after_working_validation");
      const finalResult = deepFreeze({
        schemaVersion: 1,
        status: "committed",
        result: structuredClone(commitResult.result),
        coordinatorCleanupHandoff: structuredClone(commitResult.coordinatorCleanupHandoff)
      });
      validateNpcAuthorityFinalCommittedResult(finalResult, request.preparedReaction, request.expectedStateVersion);
      this.npcAuthorityFaultInjector("commit_before_final_replacement");
      assertNpcAuthorityLivePrecondition(this, livePrecondition, transactionOwner);
      commitState(this.state, working.state);
      return finalResult;
    } finally {
      this.npcAuthorityCommitInProgress = false;
      this.npcAuthorityCommitOwner = null;
    }
  }

  _workingCopy() { validateNpcAuthoritativeStateFoundation(this.state); const clonedState = cloneState(this.state); validateNpcAuthoritativeStateFoundation(clonedState); const working = Object.create(Object.getPrototypeOf(this)); Object.assign(working, this); working.state = clonedState; working.interpreterValidationEnabled = false; return working; }

  async _observeInterpreter(action) {
    if (!this.interpreterProvider?.interpretPlayerInput) return null;
    const rawText = String(action.input ?? action.question).trim(), targetNpcId = this.getPlayer(action.targetId ?? action.target ?? action.npcId).id;
    const binding = createPhase3Binding({ state: this.state, rawText, targetNpcId, createId: this.createId }), controller = new AbortController(), started = this.now();
    const pending = { status: "pending", binding, controller, responseFingerprint: null, outcome: null }; this.pendingInterpreterRequests.set(binding.requestId, pending);
    let observation;
    try { const response = await this.interpreterProvider.interpretPlayerInput(binding.request, { targetNpcId, signal: controller.signal }); pending.attemptCount = response?.result?.diagnostics?.attemptCount ?? 1; observation = this.acceptInterpreterResponse(binding.requestId, response); }
    catch (error) { observation = { category: "failure", reasonCode: error?.name === "AbortError" ? "transport_aborted" : error?.code ?? "provider_failure", stale: this._destroyed, alternativeCount: 0, candidateCount: 0 }; }
    finally {
      pending.status = pending.status === "aborting" || observation?.category === "failure" ? "failed" : "completed"; pending.outcome = observation; this.pendingInterpreterRequests.delete(binding.requestId); this._rememberTerminal(binding.requestId, pending);
      const redacted = Object.freeze({ correlationId: binding.correlationId, inputRecordId: binding.inputRecordId, turnId: binding.turnId, capturedStateVersion: binding.preconditionStateVersion, outcomeCategory: observation?.category ?? "failure", candidateCount: observation?.candidateCount ?? 0, alternativeCount: observation?.alternativeCount ?? 0, reasonCode: observation?.reasonCode ?? "observer_failure", stale: observation?.stale === true, latencyMs: Math.max(0, this.now() - started), retryAttempt: pending.attemptCount ?? 1, terminalStatus: pending.status });
      try { this.interpreterObserver(redacted); } catch {}
    }
    return { binding, outcome: observation, responseFingerprint: pending.responseFingerprint };
  }

  _rememberTerminal(requestId, pending) { const { selectedAlternative: _private, ...safeOutcome } = pending.outcome ?? {}; this.interpreterTerminalAudit.set(requestId, Object.freeze({ status: pending.status, turnId: pending.binding.turnId, responseFingerprint: pending.responseFingerprint, outcome: Object.freeze(safeOutcome) })); while (this.interpreterTerminalAudit.size > 100) this.interpreterTerminalAudit.delete(this.interpreterTerminalAudit.keys().next().value); }

  acceptInterpreterResponse(requestId, response) {
    const fingerprint = sha256Fingerprint(response), pending = this.pendingInterpreterRequests.get(requestId);
    if (!pending) { const terminal = this.interpreterTerminalAudit.get(requestId); if (!terminal) return { category: "stale", reasonCode: "stale_no_pending", stale: true, alternativeCount: 0, candidateCount: 0 }; if (!terminal.responseFingerprint) return { category: "stale", reasonCode: "stale_late_response", stale: true, alternativeCount: 0, candidateCount: 0 }; if (terminal.responseFingerprint === fingerprint) return { ...terminal.outcome, duplicate: true, reasonCode: "duplicate_response" }; return { category: "conflict", reasonCode: "duplicate_response_conflict", stale: false, alternativeCount: 0, candidateCount: 0 }; }
    if (pending.status !== "pending") return { category: "stale", reasonCode: "stale_late_response", stale: true, alternativeCount: 0, candidateCount: 0 };
    const outcome = validatePhase3Response(response, pending.binding, this.state); pending.responseFingerprint = fingerprint; return outcome;
  }

  destroy() { this._destroyed = true; this.playerPublicationDeliveryController.invalidate(); for (const pending of this.pendingInterpreterRequests.values()) { pending.status = "aborting"; pending.controller.abort(abortError()); } this.activeNpcReaction?.controller.abort(abortError()); }

  async handlePlayerQuestion(targetIdOrName, playerInput, options = {}) {
    if (this.state.winner) {
      return {
        responded: false,
        reason: "game_already_finished"
      };
    }

    const npc = this.getPlayer(targetIdOrName);
    if (!npc) {
      throw new Error(`Unknown NPC: ${targetIdOrName}`);
    }

    const questionText = String(playerInput ?? "").trim();
    if (!options.skipPlayerSide) {
      this.setPhase("player_question");
      this.addPlayerLog(`あなた -> ${npc.name}: ${questionText}`);
      this.addPublicInfo({ type: "player_question", actorId: "player", targetId: npc.id, text: `プレイヤーが${npc.name}に質問: ${questionText}` });
      this.applyQuestionPressure(questionText);
    }

    this.setPhase("npc_response");
    if (!npc.alive) {
      this.addPlayerLog(`${npc.name}は死亡しているため、返答しません。`);
      this.addDeveloperLog("dead_npc_blocked", {
        targetId: npc.id,
        targetName: npc.name,
        playerInput: questionText
      });
      return {
        responded: false,
        reason: "dead_npc"
      };
    }

    const prepared = buildNpcResponseRequest(npc, this.state, questionText);
    const providerName = getProviderName(this.responseProvider);
    let providerResult;

    try {
      if (typeof this.responseProvider?.generateResponse !== "function") {
        throw new TypeError("Response provider must implement generateResponse(request)");
      }
      const rawProviderResult = await this.responseProvider.generateResponse(prepared.request, { signal: options.signal });
      providerResult = validateProviderResponse(rawProviderResult, providerName);
    } catch (error) {
      this.addPlayerLog(`${npc.name}から回答を得られませんでした。`);
      this.addPublicInfo({
        type: "npc_response_error",
        actorId: npc.id,
        actorName: npc.name,
        text: `${npc.name}から回答を得られませんでした。`
      });
      this.addDeveloperLog("npc_response_provider_error", {
        npcId: npc.id,
        npcName: npc.name,
        playerInput: questionText,
        providerName: error?.diagnostics?.providerName || providerName,
        errorType: error?.type ?? error?.name ?? "Error",
        message: error?.message ?? String(error),
        diagnostics: error?.diagnostics,
        evidenceUsed: prepared.evidenceUsed,
        promptPreview: prepared.promptPreview
      });
      this.setPhase("day_discussion");
      return {
        responded: false,
        reason: "response_provider_error"
      };
    }

    const result = {
      responded: true,
      text: providerResult.text,
      evidenceUsed: prepared.evidenceUsed,
      promptPreview: prepared.promptPreview,
      publicClaim: prepared.publicClaim,
      disclosedHiddenInfo: prepared.disclosedHiddenInfo,
      provider: providerResult
    };
    this.addPlayerLog(`${npc.name}: ${result.text}`);
    this.addPublicInfo({
      type: "npc_response",
      actorId: npc.id,
      actorName: npc.name,
      text: `${npc.name}: ${result.text}`
    });
    npc.privateMemory.push({
      day: this.state.day,
      type: "conversation",
      playerInput: questionText,
      response: result.text
    });

    if (result.publicClaim) {
      npc.publicClaims.push(result.publicClaim);
      this.addPublicInfo({
        type: "public_claim",
        actorId: npc.id,
        actorName: npc.name,
        text: `${npc.name}が${publicRoleName(result.publicClaim.role)}COをした。`,
        claim: result.publicClaim
      });
      this.addDeveloperLog("public_claim_registered", result.publicClaim);
    }

    this.addDeveloperLog("npc_response_generated", {
      npcId: npc.id,
      npcName: npc.name,
      playerInput: questionText,
      response: result.text,
      evidenceUsed: result.evidenceUsed,
      disclosedHiddenInfo: result.disclosedHiddenInfo,
      promptPreview: result.promptPreview,
      provider: result.provider
    });

    return result;
  }

  applyQuestionPressure(questionText) {
    const mentionedIds = extractMentionedPlayerIds(questionText, this.state.players);
    if (!mentionedIds.length) {
      return;
    }

    const isAccusatory = containsAny(questionText, ACCUSATORY_QUESTION_KEYWORDS);
    if (!isAccusatory) {
      return;
    }

    for (const npc of this.getAlivePlayers()) {
      for (const mentionedId of mentionedIds) {
        if (mentionedId === npc.id) {
          continue;
        }
        npc.suspicionScores[mentionedId] = (npc.suspicionScores[mentionedId] ?? 0) + 1;
      }
    }

    this.addDeveloperLog("question_pressure_applied", {
      questionText,
      mentionedIds,
      effect: "alive NPC suspicion +1 for mentioned targets"
    });
  }

  runVote() {
    if (this.state.winner) {
      return null;
    }

    this.setPhase("vote");
    const votes = this.getAlivePlayers().map((voter) => this.chooseVote(voter));
    for (const vote of votes) {
      const voter = this.getPlayer(vote.voterId);
      voter.voteHistory.push({
        day: this.state.day,
        targetId: vote.targetId,
        reasonPublic: vote.reasonPublic,
        reasonDeveloper: vote.reasonDeveloper
      });
    }

    const result = this.resolveVote(votes);
    this.state.voteHistory.push({
      day: this.state.day,
      votes,
      executedId: result.executedId,
      tie: result.tie
    });

    const voteSummary = votes.map((vote) => {
      const voter = this.getPlayer(vote.voterId);
      const target = this.getPlayer(vote.targetId);
      return `${voter.name}->${target.name}`;
    }).join("、");

    this.addPlayerLog(`投票結果: ${voteSummary}`);
    this.addPublicInfo({
      type: "vote_result",
      text: `投票結果: ${voteSummary}`,
      votes: votes.map(({ voterId, targetId }) => ({ voterId, targetId }))
    });
    this.addDeveloperLog("vote_resolved", {
      votes,
      counts: result.counts,
      tie: result.tie,
      executedId: result.executedId,
      executedName: this.getPlayer(result.executedId).name
    });

    this.setPhase("execution");
    this.killPlayer(result.executedId, "execution");
    const executed = this.getPlayer(result.executedId);
    this.addPlayerLog(`${executed.name}が処刑されました。`);
    this.addPublicInfo({
      type: "execution",
      targetId: executed.id,
      targetName: executed.name,
      text: `${executed.name}が処刑された。`
    });
    this.addDeveloperLog("execution", {
      executedId: executed.id,
      executedName: executed.name,
      role: executed.role,
      team: executed.team
    });

    this.setPhase("win_check");
    this.checkWin("after_execution");
    return {
      votes,
      executedId: result.executedId,
      winner: this.state.winner
    };
  }

  chooseVote(voter) {
    const candidates = this.getAlivePlayers().filter((candidate) => candidate.id !== voter.id);
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        score: voter.suspicionScores[candidate.id] ?? 0
      }))
      .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name));

    const chosen = ranked[0].candidate;
    const privateReason = findPrivateVoteReason(voter, chosen);
    const reasonDeveloper = privateReason
      ? `${privateReason}; suspicionScore=${ranked[0].score}`
      : `highest suspicionScore=${ranked[0].score}`;

    return {
      voterId: voter.id,
      voterName: voter.name,
      targetId: chosen.id,
      targetName: chosen.name,
      reasonPublic: "最も疑いが強い相手に投票",
      reasonDeveloper
    };
  }

  resolveVote(votes) {
    const counts = {};
    for (const vote of votes) {
      counts[vote.targetId] = (counts[vote.targetId] ?? 0) + 1;
    }

    const maxVotes = Math.max(...Object.values(counts));
    const tiedIds = Object.entries(counts)
      .filter(([, count]) => count === maxVotes)
      .map(([id]) => id);

    if (tiedIds.length === 1) {
      return {
        executedId: tiedIds[0],
        counts,
        tie: false
      };
    }

    const aggregateSuspicion = tiedIds.map((id) => {
      const total = this.getAlivePlayers().reduce((sum, voter) => {
        if (voter.id === id) {
          return sum;
        }
        return sum + (voter.suspicionScores[id] ?? 0);
      }, 0);
      return { id, total };
    }).sort((a, b) => b.total - a.total || this.getPlayer(a.id).name.localeCompare(this.getPlayer(b.id).name));

    return {
      executedId: aggregateSuspicion[0].id,
      counts,
      tie: true,
      tieBreak: "aggregate_suspicion"
    };
  }

  runNight() {
    if (this.state.winner) {
      return {
        skipped: true,
        reason: "game_already_finished"
      };
    }

    this.setPhase("night");
    this.addPlayerLog("夜になりました。");

    this.setPhase("seer_action");
    const seerResult = this.runSeerAction();

    this.setPhase("werewolf_attack");
    const attackResult = this.runWerewolfAttack();

    this.setPhase("win_check");
    this.checkWin("after_werewolf_attack");

    if (!this.state.winner) {
      this.state.day += 1;
      this.setPhase("day_discussion");
      this.addPlayerLog(`${this.state.day}日目の昼。議論を再開します。`);
      this.addPublicInfo({
        type: "day_start",
        text: `${this.state.day}日目の昼が始まった。`
      });
    }

    return {
      seerResult,
      attackResult,
      winner: this.state.winner
    };
  }

  runSeerAction() {
    const seer = this.state.players.find((player) => player.role === ROLES.SEER && player.alive);
    if (!seer) {
      this.addDeveloperLog("seer_action", {
        skipped: true,
        reason: "seer_dead_or_missing"
      });
      return null;
    }

    const alreadyChecked = new Set(
      seer.knownInfo
        .filter((info) => info.type === "seer_result")
        .map((info) => info.targetId)
    );
    const candidates = this.getAlivePlayers()
      .filter((player) => player.id !== seer.id)
      .filter((player) => !alreadyChecked.has(player.id));

    if (!candidates.length) {
      this.addDeveloperLog("seer_action", {
        skipped: true,
        reason: "no_valid_target"
      });
      return null;
    }

    const target = candidates
      .map((candidate) => ({
        candidate,
        score: seer.suspicionScores[candidate.id] ?? 0
      }))
      .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name))[0].candidate;

    const result = target.role === ROLES.WEREWOLF ? "werewolf" : "not_werewolf";
    seer.knownInfo.push({
      day: this.state.day,
      type: "seer_result",
      visibility: "private",
      shareable: false,
      targetId: target.id,
      targetName: target.name,
      result,
      text: `占い結果: ${target.name}は${result === "werewolf" ? "人狼" : "人狼ではない"}。`
    });
    seer.privateMemory.push({
      day: this.state.day,
      type: "seer_action",
      targetId: target.id,
      result
    });
    seer.suspicionScores[target.id] = result === "werewolf" ? 8 : -2;

    this.addDeveloperLog("seer_action", {
      seerId: seer.id,
      seerName: seer.name,
      targetId: target.id,
      targetName: target.name,
      result,
      publicInfoAdded: false,
      savedTo: "seer.knownInfo"
    });

    return {
      seerId: seer.id,
      targetId: target.id,
      result
    };
  }

  runWerewolfAttack() {
    const werewolves = this.state.players.filter((player) => player.role === ROLES.WEREWOLF && player.alive);
    if (!werewolves.length) {
      this.addDeveloperLog("werewolf_attack", {
        skipped: true,
        reason: "no_alive_werewolf"
      });
      return null;
    }

    const werewolf = werewolves[0];
    const candidates = this.getAlivePlayers().filter((player) => player.id !== werewolf.id);
    if (!candidates.length) {
      this.addDeveloperLog("werewolf_attack", {
        skipped: true,
        reason: "no_valid_target"
      });
      return null;
    }

    const publicSeerClaim = this.state.publicInfo.find((info) => info.type === "public_claim" && info.claim?.role === ROLES.SEER);
    const claimedSeer = publicSeerClaim ? this.getPlayer(publicSeerClaim.actorId) : null;
    const target = claimedSeer?.alive
      ? claimedSeer
      : candidates
        .map((candidate) => ({
          candidate,
          score: werewolf.suspicionScores[candidate.id] ?? 0
        }))
        .sort((a, b) => a.score - b.score || a.candidate.name.localeCompare(b.candidate.name))[0].candidate;

    this.killPlayer(target.id, "werewolf_attack");
    this.addPlayerLog(`夜が明けました。${target.name}が無残な姿で発見されました。`);
    this.addPublicInfo({
      type: "night_death",
      targetId: target.id,
      targetName: target.name,
      text: `${target.name}が夜に死亡した。`
    });
    this.addDeveloperLog("werewolf_attack", {
      werewolfId: werewolf.id,
      werewolfName: werewolf.name,
      targetId: target.id,
      targetName: target.name,
      targetRole: target.role,
      reason: claimedSeer?.alive ? "attacked_public_seer_claim" : "lowest_suspicion_target_to_keep_suspects_alive"
    });

    return {
      werewolfId: werewolf.id,
      targetId: target.id
    };
  }

  killPlayer(playerId, cause) {
    const player = this.getPlayer(playerId);
    if (!player || !player.alive) {
      throw new Error(`Cannot kill invalid or dead player: ${playerId}`);
    }

    player.alive = false;
    this.state.alivePlayers = this.state.alivePlayers.filter((id) => id !== playerId);
    this.state.deadPlayers.push(playerId);
    player.privateMemory.push({
      day: this.state.day,
      type: "death",
      cause
    });
  }

  checkWin(source) {
    const alive = this.getAlivePlayers();
    const werewolfCount = alive.filter((player) => player.team === TEAMS.WEREWOLF).length;
    const villageCount = alive.filter((player) => player.team === TEAMS.VILLAGE).length;
    let winner = null;

    if (werewolfCount === 0) {
      winner = TEAMS.VILLAGE;
    } else if (werewolfCount >= villageCount) {
      winner = TEAMS.WEREWOLF;
    }

    this.addDeveloperLog("win_check", {
      source,
      werewolfCount,
      villageCount,
      winner
    });

    if (winner) {
      this.state.winner = winner;
      const label = publicTeamName(winner);
      this.addPlayerLog(`勝敗結果: ${label}の勝利です。`);
      this.addPublicInfo({
        type: "winner",
        winner,
        text: `${label}が勝利した。`
      });
    }

    return winner;
  }

  createDeveloperSnapshot() {
    return structuredClone({
      day: this.state.day,
      phase: this.state.phase,
      alivePlayers: this.state.alivePlayers,
      deadPlayers: this.state.deadPlayers,
      winner: this.state.winner,
      players: this.state.players.map((player) => ({
        id: player.id,
        name: player.name,
        role: player.role,
        team: player.team,
        alive: player.alive,
        knownInfo: player.knownInfo,
        hiddenInfo: player.hiddenInfo,
        suspicionScores: player.suspicionScores,
        publicClaims: player.publicClaims,
        privateMemory: player.privateMemory,
        voteHistory: player.voteHistory,
        conversationPolicy: player.conversationPolicy
      }))
    });
  }

  getDeveloperSnapshot() {
    return this.createDeveloperSnapshot();
  }

  getDeveloperDiagnostics(options = {}) {
    let logCursor = Number.isInteger(options.logCursor) ? options.logCursor : 0;
    if (logCursor < 0) logCursor = 0;
    if (logCursor > this.state.developerLog.length) logCursor = this.state.developerLog.length;

    const entries = this.state.developerLog.slice(logCursor);

    return {
      snapshot: this.createDeveloperSnapshot(),
      developerLogEntries: structuredClone(entries),
      nextLogCursor: this.state.developerLog.length
    };
  }

  getPublicSnapshot() {
    return {
      day: this.state.day,
      phase: this.state.phase,
      alivePlayers: [...this.state.alivePlayers],
      deadPlayers: [...this.state.deadPlayers],
      winner: this.state.winner,
      players: this.state.players.map((player) => ({
        id: player.id,
        name: player.name,
        aliases: [...(player.aliases ?? [])],
        alive: player.alive,
        personality: player.personality,
        speechStyle: player.speechStyle,
        publicClaims: player.publicClaims.map((claim) => ({
          day: claim.day,
          actorId: claim.actorId,
          actorName: claim.actorName,
          role: claim.role,
          results: claim.results
        })),
        voteHistory: player.voteHistory.map((vote) => ({
          day: vote.day,
          targetId: vote.targetId,
          reasonPublic: vote.reasonPublic
        }))
      })),
      publicInfo: this.state.publicInfo.map((info) => ({ ...info })),
      voteHistory: this.state.voteHistory.map((round) => ({
        day: round.day,
        votes: round.votes.map((vote) => ({
          voterId: vote.voterId,
          voterName: vote.voterName,
          targetId: vote.targetId,
          targetName: vote.targetName,
          reasonPublic: vote.reasonPublic
        })),
        executedId: round.executedId,
        tie: round.tie
      })),
      playerLog: this.state.playerLog.map((entry) => ({ ...entry }))
    };
  }

  formatPlayerLog(fromIndex = 0) {
    return this.state.playerLog.slice(fromIndex).map((entry) => {
      return `[Day ${entry.day} / ${entry.phase}] ${entry.message}`;
    }).join("\n");
  }

  formatDeveloperLog(options = {}) {
    const entries = options.last
      ? this.state.developerLog.slice(-options.last)
      : this.state.developerLog;

    return entries.map((entry, index) => {
      return [
        `#${index + 1} [Day ${entry.day} / ${entry.phase}] ${entry.kind}`,
        JSON.stringify(entry.detail, null, 2)
      ].join("\n");
    }).join("\n\n");
  }
}

const NPC_AUTHORITY_READ_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "triggerRequestId", "originatingInputRecordId"
]);
const NPC_AUTHORITY_COMMIT_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "expectedStateVersion", "preparedReaction",
  "coordinatorRoot", "preCommitReferenceContext"
]);

function reconstructNpcAuthorityReadInput(value) {
  assertNpcAuthorityExact(value, NPC_AUTHORITY_READ_FIELDS, "invalid_npc_structured_authority_input");
  if (value.schemaVersion !== 1) throw npcAuthorityInvariant("invalid_npc_structured_authority_input");
  for (const field of ["gameSessionId", "triggerRequestId", "originatingInputRecordId"]) assertNpcAuthorityId(value[field], "invalid_npc_structured_authority_input");
  return structuredClone(value);
}

function reconstructNpcAuthorityCommitInput(value) {
  assertNpcAuthorityExact(value, NPC_AUTHORITY_COMMIT_FIELDS, "invalid_npc_structured_commit_input");
  if (value.schemaVersion !== 1) throw npcAuthorityInvariant("invalid_npc_structured_commit_input");
  assertNpcAuthorityId(value.gameSessionId, "invalid_npc_structured_commit_input");
  if (!Number.isSafeInteger(value.expectedStateVersion) || value.expectedStateVersion < 0) throw npcAuthorityInvariant("invalid_npc_structured_commit_input");
  for (const field of ["preparedReaction", "coordinatorRoot", "preCommitReferenceContext"]) assertNpcAuthorityPlainData(value[field], "invalid_npc_structured_commit_input");
  return structuredClone(value);
}

function resolveNpcStructuredTrigger(state, request) {
  const conversation = state.conversation;
  const results = conversation.commitResults.filter((result) => result.commitType === "player_conversation" && result.requestId === request.triggerRequestId);
  const records = conversation.idempotencyRecords.filter((record) => record.requestId === request.triggerRequestId);
  const inputs = conversation.inputRecords.filter((input) => input.inputRecordId === request.originatingInputRecordId);
  if (results.length !== 1 || records.length !== 1 || inputs.length !== 1) throw npcAuthorityInvariant("invalid_npc_structured_trigger_graph");
  const [result] = results, [record] = records, [input] = inputs;
  if (result.inputRecordId !== input.inputRecordId || result.requestId !== input.requestId
    || result.correlationId !== input.correlationId || record.requestFingerprint !== result.requestFingerprint
    || canonicalJson(record.result) !== canonicalJson(result)) throw npcAuthorityInvariant("invalid_npc_structured_trigger_graph");
  const acts = conversation.acceptedSpeechActs.filter((act) => act.requestId === result.requestId && act.inputRecordId === input.inputRecordId);
  const questions = acts.filter((act) => act.type === "accepted_question" && typeof act.targetId === "string");
  const targetIds = [...new Set(questions.map((act) => act.targetId))];
  if (questions.length !== 1 || targetIds.length !== 1) throw npcAuthorityInvariant("invalid_npc_structured_trigger_graph");
  const targetNpcId = targetIds[0];
  const events = result.createdEventIds.map((eventId) => {
    const matches = conversation.events.filter((event) => event.eventId === eventId);
    if (matches.length !== 1) throw npcAuthorityInvariant("invalid_npc_structured_trigger_graph");
    return matches[0];
  });
  const questionEvent = events.filter((event) => event.eventType === "public_question_recorded"
    && event.targetId === targetNpcId && event.source?.inputRecordId === input.inputRecordId
    && event.source?.requestId === result.requestId);
  if (questionEvent.length !== 1) throw npcAuthorityInvariant("invalid_npc_structured_trigger_graph");
  return { result, input, events, targetNpcId, acceptedQuestion: questions[0] };
}

function isNpcStructuredTriggerCurrentlyApplicable(state, trigger) {
  const question = trigger.acceptedQuestion;
  return trigger.input.turnId === state.turnId
    && trigger.result.preconditionStateVersion === trigger.input.capturedStateVersion
    && trigger.result.resultingStateVersion === state.stateVersion
    && question.acceptedTurnId === state.turnId
    && question.acceptedStateVersion === trigger.result.preconditionStateVersion
    && question.acceptedPhase === state.phase
    && trigger.events.every((event) => event.turnId === state.turnId
      && event.stateVersion === state.stateVersion && event.occurredPhase === state.phase)
    && state.players.some((player) => player.id === trigger.targetNpcId);
}

function resolveNpcStructuredCommittedReplay(state, trigger) {
  const records = state.conversation.npcReactionCommitIdempotencyRecords;
  const triggerMatches = records.filter((record) => record.causationId === trigger.result.requestId
    || record.originatingInputRecordId === trigger.input.inputRecordId);
  if (triggerMatches.length === 0) return { schemaVersion: 1, status: "not_found" };
  if (triggerMatches.length !== 1) return { schemaVersion: 1, status: "conflict", code: "trigger_identity_conflict" };
  const record = triggerMatches[0];
  if (record.causationId !== trigger.result.requestId || record.originatingInputRecordId !== trigger.input.inputRecordId
    || record.npcId !== trigger.targetNpcId) return { schemaVersion: 1, status: "conflict", code: "trigger_identity_conflict" };
  const plans = state.conversation.reactionPlans.filter((plan) => plan.reactionPlanId === record.reactionPlanId);
  const results = state.conversation.commitResults.filter((result) => result.commitType === "npc_reaction" && result.requestId === record.commitResultRequestId);
  const publications = state.conversation.publications.filter((publication) => publication.publicationId === record.npcPublicationId);
  if (plans.length !== 1 || results.length !== 1 || publications.length !== 1) throw npcAuthorityInvariant("invalid_npc_structured_replay_graph");
  const plan = plans[0], result = results[0];
  if (plan.requestId !== record.requestId || plan.successfulAttemptId !== record.successfulAttemptId
    || result.reactionPlanId !== record.reactionPlanId || result.requestFingerprint !== record.requestFingerprint) {
    return { schemaVersion: 1, status: "conflict", code: "committed_graph_conflict" };
  }
  return {
    schemaVersion: 1,
    status: "replayed",
    logicalIdentity: {
      gameSessionId: record.gameSessionId,
      reactionPlanId: record.reactionPlanId,
      requestId: record.requestId,
      requestFingerprint: record.requestFingerprint,
      originatingInputRecordId: record.originatingInputRecordId,
      turnId: record.turnId,
      turnOrder: record.turnOrder,
      npcId: record.npcId
    },
    result: structuredClone(result)
  };
}

function buildNpcAuthorityReplayReadResult(state, request, replay) {
  const value = {
    schemaVersion: 1,
    status: "replayed",
    gameSessionId: state.gameSessionId,
    triggerRequestId: request.triggerRequestId,
    originatingInputRecordId: request.originatingInputRecordId,
    logicalIdentity: structuredClone(replay.logicalIdentity),
    result: structuredClone(replay.result)
  };
  validateNpcAuthorityReplayReadResult(value);
  return deepFreeze(value);
}

function buildNpcAuthorityConflictReadResult(state, request, code) {
  if (!["trigger_identity_conflict", "request_identity_conflict", "reaction_identity_conflict", "committed_graph_conflict", "stale_trigger"].includes(code)) {
    throw npcAuthorityInvariant("invalid_npc_structured_replay_graph");
  }
  const value = {
    schemaVersion: 1,
    status: "conflict",
    gameSessionId: state.gameSessionId,
    triggerRequestId: request.triggerRequestId,
    originatingInputRecordId: request.originatingInputRecordId,
    code
  };
  assertNpcAuthorityExact(value, ["schemaVersion", "status", "gameSessionId", "triggerRequestId", "originatingInputRecordId", "code"], "invalid_npc_structured_replay_graph");
  return deepFreeze(value);
}

function validateNpcAuthorityReplayReadResult(value) {
  assertNpcAuthorityExact(value, ["schemaVersion", "status", "gameSessionId", "triggerRequestId", "originatingInputRecordId", "logicalIdentity", "result"], "invalid_npc_structured_replay_graph");
  if (value.schemaVersion !== 1 || value.status !== "replayed") throw npcAuthorityInvariant("invalid_npc_structured_replay_graph");
  for (const field of ["gameSessionId", "triggerRequestId", "originatingInputRecordId"]) assertNpcAuthorityId(value[field], "invalid_npc_structured_replay_graph");
  assertNpcAuthorityExact(value.logicalIdentity, ["gameSessionId", "reactionPlanId", "requestId", "requestFingerprint", "originatingInputRecordId", "turnId", "turnOrder", "npcId"], "invalid_npc_structured_replay_graph");
  for (const field of ["gameSessionId", "reactionPlanId", "requestId", "originatingInputRecordId", "turnId", "npcId"]) assertNpcAuthorityId(value.logicalIdentity[field], "invalid_npc_structured_replay_graph");
  if (typeof value.logicalIdentity.requestFingerprint !== "string" || !SHA256_PATTERN.test(value.logicalIdentity.requestFingerprint)
    || !Number.isSafeInteger(value.logicalIdentity.turnOrder) || value.logicalIdentity.turnOrder < 0) throw npcAuthorityInvariant("invalid_npc_structured_replay_graph");
  validateConversationCommitResult(value.result);
  if (value.result.commitType !== "npc_reaction" || value.logicalIdentity.gameSessionId !== value.gameSessionId
    || value.logicalIdentity.originatingInputRecordId !== value.originatingInputRecordId
    || value.result.reactionPlanId !== value.logicalIdentity.reactionPlanId
    || value.result.requestId !== value.logicalIdentity.requestId
    || value.result.requestFingerprint !== value.logicalIdentity.requestFingerprint) throw npcAuthorityInvariant("invalid_npc_structured_replay_graph");
}

function captureNpcAuthorityLivePrecondition(state) {
  return Object.freeze({
    gameSessionId: state.gameSessionId,
    stateVersion: state.stateVersion,
    turnId: state.turnId,
    turnOrder: state.turnOrder,
    phase: state.phase,
    rootFingerprint: sha256Fingerprint(state)
  });
}

function assertNpcAuthorityLivePrecondition(game, expected, transactionOwner) {
  const state = game.state;
  let rootFingerprint;
  try { rootFingerprint = sha256Fingerprint(state); }
  catch { throw npcAuthorityInvariant("invalid_npc_structured_state_replacement"); }
  if (game._destroyed || game.npcAuthorityCommitInProgress !== true || game.npcAuthorityCommitOwner !== transactionOwner
    || state.gameSessionId !== expected.gameSessionId || state.stateVersion !== expected.stateVersion
    || state.turnId !== expected.turnId || state.turnOrder !== expected.turnOrder || state.phase !== expected.phase
    || rootFingerprint !== expected.rootFingerprint) throw npcAuthorityInvariant("invalid_npc_structured_state_replacement");
}

function buildNpcPreparationAuthorityContext(state, actor, requestedActorId = actor?.id) {
  const currentRoster = [
    { participantId: "player", participantClass: "player", publicStatus: "alive" },
    ...state.players.map((player) => ({ participantId: player.id, participantClass: "npc", publicStatus: player.alive ? "alive" : "dead" }))
  ];
  if (!actor) return {
    currentRoster,
    actorApplicability: { schemaVersion: 1, presence: "absent", actorId: requestedActorId, absenceReason: "removed_from_roster" },
    currentAuthorization: { schemaVersion: 1, availability: "unavailable", actorId: requestedActorId, reason: "actor_absent" },
    currentTargetIds: state.players.map((player) => player.id)
  };
  const resultFacts = (actor.knownInfo ?? []).filter((fact) => fact?.type === "seer_result")
    .map((fact) => ({ targetId: fact.targetId, result: fact.result }));
  const maySpeak = actor.alive && state.winner === null;
  return {
    currentRoster,
    actorApplicability: { schemaVersion: 1, presence: "present", actorId: actor.id, alive: actor.alive, maySpeak },
    currentAuthorization: {
      schemaVersion: 1,
      availability: "available",
      actorId: actor.id,
      roleDisclosurePolicy: actor.conversationPolicy.roleClaim,
      allowedClaimRoles: actor.role === "seer" && resultFacts.length > 0 ? ["seer"] : [],
      authorizedResultFacts: resultFacts
    },
    currentTargetIds: state.players.filter((player) => player.id !== actor.id).map((player) => player.id)
  };
}

function buildNpcPublicParticipants(state) {
  return Object.fromEntries([
    ["player", { participantId: "player", displayName: "Player" }],
    ...state.players.map((player) => [player.id, { participantId: player.id, displayName: player.name }])
  ]);
}

function collectNpcAuthorityIds(state) {
  const found = new Set([state.gameSessionId, state.turnId, "player", ...state.players.map((player) => player.id)]);
  const visit = (value, key = "") => {
    if (typeof value === "string" && (key.endsWith("Id") || key.endsWith("Ids")) && ID_PATTERN.test(value)) found.add(value);
    else if (Array.isArray(value)) value.forEach((child) => visit(child, key));
    else if (value && typeof value === "object") for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  visit(state.conversation);
  return [...found].sort();
}

function validateNpcAuthorityCommitPrimitiveResult(value, prepared, expectedVersion) {
  try {
    assertNpcAuthorityPlainData(value, "invalid_npc_structured_commit_result");
    if (value.status === "replayed") {
      assertNpcAuthorityExact(value, ["schemaVersion", "status", "result"], "invalid_npc_structured_commit_result");
      validateConversationCommitResult(value.result);
    } else if (value.status === "rejected") {
      assertNpcAuthorityExact(value, ["schemaVersion", "status", "binding", "rejection"], "invalid_npc_structured_commit_result");
      assertNpcAuthorityExact(value.binding, ["schemaVersion", "gameSessionId", "reactionPlanId", "successfulAttemptId", "requestId", "correlationId", "turnId", "preconditionStateVersion", "npcId"], "invalid_npc_structured_commit_result");
      assertNpcAuthorityExact(value.rejection, ["stage", "reasonCode", "retryable", "diagnostics"], "invalid_npc_structured_commit_result");
      if (!["idempotency", "applicability", "authorization", "allocation", "ordering"].includes(value.rejection.stage)
        || !NPC_REACTION_COMMIT_REJECTION_CODES.includes(value.rejection.reasonCode)
        || value.rejection.retryable !== false || !Array.isArray(value.rejection.diagnostics)
        || value.rejection.diagnostics.length !== 1) throw new TypeError("invalid");
      assertNpcAuthorityExact(value.rejection.diagnostics[0], ["code", "location"], "invalid_npc_structured_commit_result");
      if (value.rejection.diagnostics[0].code !== value.rejection.reasonCode
        || typeof value.rejection.diagnostics[0].location !== "string") throw new TypeError("invalid");
    } else if (value.status === "committed") {
      assertNpcAuthorityExact(value, ["schemaVersion", "status", "replacementState", "result", "coordinatorCleanupHandoff"], "invalid_npc_structured_commit_result");
      validateConversationCommitResult(value.result);
      if (value.result.resultingStateVersion !== expectedVersion + 1
        || value.result.reactionPlanId !== prepared.delta.binding.reactionPlanId) throw new TypeError("invalid");
      validateNpcAuthorityCleanupHandoff(value.coordinatorCleanupHandoff, prepared);
    } else throw new TypeError("invalid");
    if (value.schemaVersion !== 1) throw new TypeError("invalid");
  } catch (error) {
    if (error instanceof NpcStructuredReactionAuthorityPortInvariantError) throw error;
    throw npcAuthorityInvariant("invalid_npc_structured_commit_result");
  }
}

function validateNpcAuthorityCleanupHandoff(value, prepared) {
  assertNpcAuthorityExact(value, ["schemaVersion", "gameSessionId", "reactionPlanId", "successfulAttemptId", "preparationFingerprint", "npcPublicationId", "commitResultRequestId"], "invalid_npc_structured_commit_result");
  const delta = prepared.delta;
  if (value.schemaVersion !== 1 || value.gameSessionId !== delta.binding.gameSessionId
    || value.reactionPlanId !== delta.binding.reactionPlanId || value.successfulAttemptId !== delta.binding.successfulAttemptId
    || value.preparationFingerprint !== prepared.preparationFingerprint || value.npcPublicationId !== delta.publication.publicationId
    || value.commitResultRequestId !== delta.expectedCommitResult.requestId) throw npcAuthorityInvariant("invalid_npc_structured_commit_result");
}

function validateNpcAuthorityFinalCommittedResult(value, prepared, expectedVersion) {
  assertNpcAuthorityExact(value, ["schemaVersion", "status", "result", "coordinatorCleanupHandoff"], "invalid_npc_structured_commit_result");
  if (value.schemaVersion !== 1 || value.status !== "committed" || value.result.resultingStateVersion !== expectedVersion + 1) throw npcAuthorityInvariant("invalid_npc_structured_commit_result");
  validateConversationCommitResult(value.result);
  validateNpcAuthorityCleanupHandoff(value.coordinatorCleanupHandoff, prepared);
}

function applyNpcAuthorizedDelta(state, delta) {
  const conversation = state.conversation;
  conversation.reactionPlans.push(...structuredClone(delta.appends.reactionPlans));
  conversation.claims.push(...structuredClone(delta.appends.claims));
  conversation.events.push(...structuredClone(delta.appends.events));
  conversation.publications.push(...structuredClone(delta.appends.publications));
  conversation.npcReactionCommitIdempotencyRecords.push(...structuredClone(delta.appends.npcReactionCommitIdempotencyRecords));
  conversation.commitResults.push(...structuredClone(delta.appends.commitResults));
  conversation.nextCreatedOrder = delta.counters.nextCreatedOrder;
  conversation.nextPublicationSlotOrder = delta.counters.nextPublicationSlotOrder;
  conversation.nextRecordAppendOrder = delta.counters.nextRecordAppendOrder;
  state.stateVersion = delta.resultingStateVersion;
}

function assertNpcAuthorityForbiddenPathsPreserved(before, after, delta) {
  const allowedArrays = ["reactionPlans", "claims", "events", "publications", "npcReactionCommitIdempotencyRecords", "commitResults"];
  const beforeRoot = structuredClone(before), afterRoot = structuredClone(after);
  afterRoot.stateVersion = beforeRoot.stateVersion;
  for (const field of allowedArrays) afterRoot.conversation[field] = beforeRoot.conversation[field];
  for (const field of ["nextCreatedOrder", "nextPublicationSlotOrder", "nextRecordAppendOrder"]) afterRoot.conversation[field] = beforeRoot.conversation[field];
  if (canonicalJson(beforeRoot) !== canonicalJson(afterRoot)) throw npcAuthorityInvariant("invalid_npc_structured_state_replacement");
  for (const field of allowedArrays) {
    const prefix = before.conversation[field], current = after.conversation[field], append = delta.appends[field];
    if (canonicalJson(current.slice(0, prefix.length)) !== canonicalJson(prefix)
      || canonicalJson(current.slice(prefix.length)) !== canonicalJson(append)) throw npcAuthorityInvariant("invalid_npc_structured_state_replacement");
  }
}

function assertNpcAuthorityExact(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw npcAuthorityInvariant(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) throw npcAuthorityInvariant(code);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw npcAuthorityInvariant(code);
  }
}

function assertNpcAuthorityPlainData(value, code, active = new Set()) {
  if (!value || typeof value !== "object") return;
  if (active.has(value)) throw npcAuthorityInvariant(code);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw npcAuthorityInvariant(code);
  active.add(value);
  const keys = Array.isArray(value) ? Object.keys(value) : Reflect.ownKeys(value);
  if (Array.isArray(value) && (Object.getOwnPropertySymbols(value).length > 0
    || keys.some((key, index) => key !== String(index)))) throw npcAuthorityInvariant(code);
  for (const key of keys) {
    if (typeof key !== "string") throw npcAuthorityInvariant(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw npcAuthorityInvariant(code);
    assertNpcAuthorityPlainData(descriptor.value, code, active);
  }
  active.delete(value);
}

function assertNpcAuthorityId(value, code) { if (typeof value !== "string" || !ID_PATTERN.test(value)) throw npcAuthorityInvariant(code); }
function npcAuthorityInvariant(code) { return new NpcStructuredReactionAuthorityPortInvariantError(code); }

function assignRoles({ rng, shuffleRoles, scenario }) {
  if (scenario === "sample") {
    return { ...SAMPLE_ROLE_BY_ID };
  }

  const roles = [ROLES.WEREWOLF, ROLES.SEER, ROLES.CITIZEN, ROLES.CITIZEN, ROLES.CITIZEN];
  const assignedRoles = shuffleRoles ? rng.shuffle(roles) : roles;
  const result = {};

  DEFAULT_PLAYERS.forEach((player, index) => {
    result[player.id] = assignedRoles[index];
  });

  return result;
}

function createPlayerState(template, role) {
  const team = teamForRole(role);
  const player = {
    ...template,
    role,
    team,
    alive: true,
    knownInfo: [],
    hiddenInfo: [
      {
        type: "role",
        value: role,
        text: `このNPCの役職は${publicRoleName(role)}。`
      },
      {
        type: "team",
        value: team,
        text: `このNPCの陣営は${publicTeamName(team)}。`
      }
    ],
    suspicionScores: {},
    publicClaims: [],
    privateMemory: [],
    voteHistory: [],
    conversationPolicy: createConversationPolicy(role)
  };

  player.knownInfo.push({
    day: 1,
    type: "setup",
    visibility: "public",
    shareable: true,
    text: "5人村の公開内訳は人狼1、占い師1、市民3。"
  });
  player.knownInfo.push({
    day: 1,
    type: "self_presence",
    visibility: "private",
    shareable: false,
    targetId: player.id,
    text: "自分は現在この村に参加している。"
  });

  if (role === ROLES.WEREWOLF) {
    player.hiddenInfo.push({
      type: "werewolf_identity",
      value: player.id,
      text: "自分が唯一の人狼。"
    });
  }

  return player;
}

function createConversationPolicy(role) {
  if (role === ROLES.WEREWOLF) {
    return {
      truthfulness: "deceptive_when_needed",
      roleClaim: "never_confess_werewolf",
      allowedTactics: ["deny_identity", "redirect_suspicion", "avoid_self_incrimination"],
      forbidden: ["confess_werewolf", "change_game_state"]
    };
  }

  if (role === ROLES.SEER) {
    return {
      truthfulness: "honest_but_may_withhold_private_info",
      roleClaim: "claim_when_directly_asked_after_result",
      allowedTactics: ["withhold_role_until_needed", "state_suspicion_without_explaining_private_result"],
      forbidden: ["invent_results", "change_game_state"]
    };
  }

  return {
    truthfulness: "honest_with_possible_mistakes",
    roleClaim: "avoid_unnecessary_claim",
    allowedTactics: ["reason_from_public_info", "admit_uncertainty"],
    forbidden: ["invent_hidden_info", "change_game_state"]
  };
}

function cloneState(state) { const { rng, ...plain } = state, clonedRng = new SeededRandom(0); clonedRng.state = rng.state; return { ...structuredClone(plain), rng: clonedRng }; }
function engineId(prefix, createId) { const value = `${prefix}-${createId()}`; if (!ID_PATTERN.test(value)) throw typedError("invalid_engine_id"); return value; }
function commitState(target, source) {
  const currentPlayers = new Map(target.players.map((player) => [player.id, player]));
  const preparedPlayers = source.players.map((player) => structuredClone(player));
  const preparedState = structuredClone(Object.fromEntries(Object.entries(source).filter(([key]) => !new Set(["players", "rng"]).has(key))));
  const publishedPlayers = preparedPlayers.map((next) => {
    const current = currentPlayers.get(next.id);
    if (!current) throw typedError("invalid_player_identity");
    return { current, next };
  });
  const rng = target.rng;
  for (const { current, next } of publishedPlayers) { for (const key of Object.keys(current)) delete current[key]; Object.assign(current, next); }
  for (const key of Object.keys(target)) if (!new Set(["players", "rng"]).has(key)) delete target[key];
  Object.assign(target, preparedState); target.players = publishedPlayers.map(({ current }) => current); rng.state = source.rng.state; target.rng = rng;
}
function typedError(code) { const error = new Error(code); error.code = code; return error; }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
function abortError() { const error = new Error("Aborted"); error.name = "AbortError"; return error; }

function initializeSuspicion(players, rng, scenario) {
  for (const player of players) {
    for (const other of players) {
      if (player.id !== other.id) {
        player.suspicionScores[other.id] = 0;
      }
    }
  }

  if (scenario === "sample") {
    for (const player of players) {
      Object.assign(player.suspicionScores, SAMPLE_SUSPICION[player.id]);
      addInitialImpression(player, players);
    }
    return;
  }

  for (const player of players) {
    for (const other of players) {
      if (player.id !== other.id) {
        player.suspicionScores[other.id] = rng.int(3);
      }
    }
    addInitialImpression(player, players);
  }
}

function addInitialImpression(player, players) {
  const top = Object.entries(player.suspicionScores)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  if (!top || top[1] <= 0) {
    return;
  }

  const target = players.find((candidate) => candidate.id === top[0]);
  player.knownInfo.push({
    day: 1,
    type: "first_impression",
    visibility: "private",
    shareable: true,
    targetId: target.id,
    targetName: target.name,
    text: `${target.name}の発言には少し違和感がある、という初日の印象を持っている。`
  });
}

function findPrivateVoteReason(voter, chosen) {
  const privateSeerResult = voter.knownInfo.find((info) => {
    return info.type === "seer_result" && info.targetId === chosen.id;
  });

  if (privateSeerResult) {
    return `private seer result=${privateSeerResult.result}`;
  }

  const impression = voter.knownInfo.find((info) => {
    return info.type === "first_impression" && info.targetId === chosen.id;
  });

  if (impression) {
    return "first_impression";
  }

  return null;
}
