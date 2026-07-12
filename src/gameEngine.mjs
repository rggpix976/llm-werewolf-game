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
import { sha256Fingerprint } from "./conversation/ids.mjs";
import { ID_PATTERN, SHA256_PATTERN } from "./conversation/domain.mjs";
import { validateCommittedConversationGraph, validatePlayerLegacyDisplayCompatibilityReferences } from "./conversation/references.mjs";
import { preparePlayerConversationCommit, resolvePlayerConversationCommitPolicy } from "./playerConversationCommit.mjs";
import { projectMappedPlayerEntries, renderUnacknowledgedPlayerPublications, renderPlayerPublication, resolvePlayerStructuredConsumerPolicy } from "./playerStructuredConsumer.mjs";
import { PlayerPublicationDeliveryController } from "./playerPublicationDelivery.mjs";

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
        inputRecords: [], acceptedSpeechActs: [], claims: [], events: [], displayPlans: [], publications: [], playerLegacyDisplayCompatibilityRecords: [], commitResults: [], idempotencyRecords: [],
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
      { createId, interpreterProvider: options.interpreterProvider, interpreterValidationEnabled: options.interpreterValidationEnabled === true, playerConversationCommitEnabled: options.playerConversationCommitEnabled === true, playerStructuredConsumerEnabled: options.playerStructuredConsumerEnabled === true, playerStructuredConsumerObserver: options.playerStructuredConsumerObserver, phase4FaultInjector: options.phase4FaultInjector, interpreterObserver: options.interpreterObserver, now: options.now }
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
    this.state = state;
    this.responseProvider = responseProvider;
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID());
    this.interpreterProvider = options.interpreterProvider;
    this.interpreterValidationEnabled = options.interpreterValidationEnabled === true;
    this.playerConversationCommitEnabled = resolvePlayerConversationCommitPolicy({ playerConversationCommitMode: options.playerConversationCommitEnabled === true, interpreterValidationMode: this.interpreterValidationEnabled }).enabled;
    this.playerStructuredConsumerEnabled = resolvePlayerStructuredConsumerPolicy({ playerStructuredConsumerMode: options.playerStructuredConsumerEnabled === true, playerConversationCommitMode: this.playerConversationCommitEnabled }).enabled;
    this._consumerModeObserved = this.playerStructuredConsumerEnabled;
    this.playerStructuredConsumerObserver = options.playerStructuredConsumerObserver ?? (() => {});
    this.playerPublicationDeliveryController = new PlayerPublicationDeliveryController({ gameSessionId: state.gameSessionId, createId: this.createId, observer: this.playerStructuredConsumerObserver, enabled: this.playerStructuredConsumerEnabled, initialWatermark: 0, listPublications: () => this.state.conversation.publications.filter((record) => record.recordType === "player_utterance_published").sort((a, b) => a.publicationSlotOrder - b.publicationSlotOrder), resolvePublication: (publicationId) => this._displayPlayerPublication(this._renderPlayerPublication(publicationId)) });
    this.phase4FaultInjector = options.phase4FaultInjector ?? (() => {});
    this.interpreterObserver = options.interpreterObserver ?? (() => {});
    this.now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
    this.pendingInterpreterRequests = new Map();
    this.interpreterTerminalAudit = new Map();
    this.activeNpcReaction = null;
    this._commandInProgress = false;
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
    this._syncStructuredConsumerMode();
    const logCursor = Number.isInteger(action.logCursor) ? action.logCursor : this.state.playerLog.length;
    if (action.type === "get_state") return this._actionResult(action.type, null, logCursor);
    if (action.type === "ask_npc" && action.replayRequestId) return this._replayPlayerConversation(action, logCursor);
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
      working.state.stateVersion = preconditionVersion + 1; commitState(this.state, working.state);
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
    if (this.playerStructuredConsumerEnabled) {
      const historyEntries = this._renderPlayerPublicationIds(this.playerPublicationDeliveryController.historyPublicationIds()); playerFacingEntries = projectMappedPlayerEntries({ legacyEntries: playerLogEntries, legacyLogStartOrder: logCursor, structuredEntries: historyEntries });
      if (actionType !== "get_state" && result?.replayed !== true) { deliveryPublicationIds = this.playerPublicationDeliveryController.discover(); structuredPlayerEntries = this._renderPlayerPublicationIds(deliveryPublicationIds).map((entry) => this._displayPlayerPublication(entry)); livePlayerDisplayEntries = this._livePlayerDisplayEntries(playerLogEntries, logCursor, new Set(deliveryPublicationIds)); }
    } else { const historyEntries = this._renderPlayerPublicationIds(this.playerPublicationDeliveryController.historyPublicationIds()); playerFacingEntries = projectMappedPlayerEntries({ legacyEntries: playerLogEntries, legacyLogStartOrder: logCursor, structuredEntries: historyEntries }); const suppressedPublications = new Set([...this.playerPublicationDeliveryController.acknowledgedPublicationIds(), ...this.playerPublicationDeliveryController.liveScopePublicationIds()]), suppressedOrders = new Set(this.state.conversation.playerLegacyDisplayCompatibilityRecords.filter((mapping) => suppressedPublications.has(mapping.publicationId)).map((mapping) => mapping.legacyLogAppendOrder)); if (actionType !== "get_state" && result?.replayed !== true) livePlayerDisplayEntries = playerLogEntries.map((entry, index) => ({ entry, order: logCursor + index })).filter(({ order }) => !suppressedOrders.has(order)).map(({ entry }) => Object.freeze({ kind: "legacy_display", entry: structuredClone(entry) })); }
    return { ok: true, actionType, result, publicSnapshot: this.getPublicSnapshot(), playerLogEntries, structuredPlayerEntries, deliveryPublicationIds, livePlayerDisplayEntries, playerFacingEntries, nextLogCursor: this.state.playerLog.length };
  }

  _syncStructuredConsumerMode() {
    if (this._consumerModeObserved === this.playerStructuredConsumerEnabled) return;
    this._consumerModeObserved = this.playerStructuredConsumerEnabled; this.playerPublicationDeliveryController.setEnabled(this.playerStructuredConsumerEnabled, this.state.conversation.nextPublicationSlotOrder);
  }

  _publicParticipantsById() { return Object.fromEntries([["player", { participantId: "player", displayName: "Player" }], ...this.state.players.map((player) => [player.id, { participantId: player.id, displayName: player.name }])]); }
  _renderPlayerPublication(publicationId) { return renderPlayerPublication({ gameSessionId: this.state.gameSessionId, conversation: this.state.conversation, legacyPlayerLog: this.state.playerLog, publicationId, publicParticipantsById: this._publicParticipantsById(), resolveCompatibilityMapping: (id) => this.getPlayerLegacyDisplayCompatibilityRecord({ publicationId: id }) }); }
  _renderPlayerPublicationIds(publicationIds) { return renderUnacknowledgedPlayerPublications({ gameSessionId: this.state.gameSessionId, conversation: this.state.conversation, legacyPlayerLog: this.state.playerLog, publicationIds, publicParticipantsById: this._publicParticipantsById(), resolveCompatibilityMapping: (id) => this.getPlayerLegacyDisplayCompatibilityRecord({ publicationId: id }) }); }
  _displayPlayerPublication(entry) { const legacy = this.state.playerLog[entry.legacyLogAppendOrder]; return Object.freeze({ day: legacy.day, phase: legacy.phase, message: entry.renderedText, actorId: entry.actorId, publicationId: entry.publicationId, structured: true }); }
  _livePlayerDisplayEntries(entries, startOrder, deliveryIds) { const mappings = new Map(this.state.conversation.playerLegacyDisplayCompatibilityRecords.map((mapping) => [mapping.legacyLogAppendOrder, mapping.publicationId])); return entries.flatMap((entry, index) => { const publicationId = mappings.get(startOrder + index); if (publicationId) return deliveryIds.has(publicationId) ? [Object.freeze({ kind: "player_publication_delivery", publicationId })] : []; return [Object.freeze({ kind: "legacy_display", entry: structuredClone(entry) })]; }); }
  getPlayerPublicationDeliveryCandidates() { return this.playerPublicationDeliveryController.discover(); }
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
    this.phase4FaultInjector("final_state_replacement"); working.state.stateVersion = preconditionVersion + 1; commitState(this.state, working.state);
    const reactionBinding = Object.freeze({ gameSessionId: this.state.gameSessionId, turnId: this.state.turnId, turnOrder: this.state.turnOrder, preconditionPhase: this.state.phase, preconditionStateVersion: this.state.stateVersion, targetNpcId: target.id, requestId: delta.requestId, correlationId: delta.correlationId, inputRecordId: delta.inputRecordId, requestFingerprint: delta.requestFingerprint });
    const controller = new AbortController(), active = { binding: reactionBinding, controller }; this.activeNpcReaction = active;
    try {
      const npcWorking = this._workingCopy(), reaction = await npcWorking.handlePlayerQuestion(target.id, action.input ?? action.question, { skipPlayerSide: true, signal: controller.signal });
      this._assertNpcReactionCas(active, npcWorking);
      if (reaction?.reason === "response_provider_error") return { ...reaction, conversationCommitResult: structuredClone(prepared.result) };
      this.phase4FaultInjector("npc_final_state_replacement"); npcWorking.state.stateVersion = preconditionVersion + 2; commitState(this.state, npcWorking.state);
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

  _workingCopy() { const working = Object.create(Object.getPrototypeOf(this)); Object.assign(working, this); working.state = cloneState(this.state); working.interpreterValidationEnabled = false; return working; }

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
