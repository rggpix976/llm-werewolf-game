import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { createPhase3Binding } from "../src/interpreterValidation.mjs";
import { preparePlayerConversationCommit } from "../src/playerConversationCommit.mjs";
import { projectMappedPlayerEntries, renderPlayerPublication, renderUnacknowledgedPlayerPublications, resolvePlayerStructuredConsumerPolicy, sanitizeTerminalText } from "../src/playerStructuredConsumer.mjs";
import { deliverLivePlayerEntries } from "../src/playerDisplaySink.mjs";
import { parseConfig } from "../src/config.mjs";

function ids() { let value = 0; return () => String(++value); }
function interpreterFor(acts) { return { async interpretPlayerInput(request) { return { schemaVersion: 1, requestId: request.requestId, correlationId: request.correlationId, serverCorrelationId: "server-1", result: { schemaVersion: 1, requestId: request.requestId, correlationId: request.correlationId, modelOutput: { schemaVersion: 1, alternatives: [{ alternativeId: "alternative-1", confidence: 1, speechActs: acts }] }, diagnostics: { providerName: "test", model: "test", attemptCount: 1, elapsedMs: 0 } } }; } }; }
function game(acts, consumer = true) { return WerewolfGame.create({ seed: 1, scenario: "sample", shuffleRoles: false, createId: ids(), interpreterValidationEnabled: true, playerConversationCommitEnabled: true, playerStructuredConsumerEnabled: consumer, interpreterProvider: interpreterFor(acts), responseProvider: { async generateResponse() { return { text: "NPC response", providerName: "test", model: "test", usage: null, notes: [] }; } } }); }
function participants(instance) { return Object.fromEntries([["player", { participantId: "player", displayName: "Player" }], ...instance.state.players.map((player) => [player.id, { participantId: player.id, displayName: player.name }])]); }
async function committed(acts, raw = "hello") { const instance = game(acts, false); await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: raw }); return instance; }
function render(instance, publicationId = instance.state.conversation.publications[0].publicationId) { return renderPlayerPublication({ gameSessionId: instance.state.gameSessionId, conversation: instance.state.conversation, legacyPlayerLog: instance.state.playerLog, publicationId, publicParticipantsById: participants(instance), resolveCompatibilityMapping: (id) => instance.getPlayerLegacyDisplayCompatibilityRecord({ publicationId: id }) }); }

test("Phase 5 policy is default-off and strictly requires the Phase 4 writer", () => {
  assert.deepEqual(resolvePlayerStructuredConsumerPolicy({}), { enabled: false, playerConversationCommitRequired: true });
  assert.throws(() => resolvePlayerStructuredConsumerPolicy({ playerStructuredConsumerMode: true }), (error) => error.code === "consumer_configuration_invalid");
  assert.throws(() => parseConfig({ PLAYER_STRUCTURED_CONSUMER_MODE: "true" }), /requires PLAYER_CONVERSATION_COMMIT_MODE/);
  assert.equal(parseConfig({ INTERPRETER_VALIDATION_MODE: "true", PLAYER_CONVERSATION_COMMIT_MODE: "true", PLAYER_STRUCTURED_CONSUMER_MODE: "true" }).playerStructuredConsumerMode, true);
});

test("publication resolution renders immutable Unicode raw spans without authoritative mutation", async () => {
  const raw = "日😀e\u0301 <script>x</script>", instance = await committed([{ type: "non_game_statement", sourceSpan: { start: 0, end: [...raw].length } }], raw), before = JSON.stringify(instance.state);
  const result = render(instance); assert.equal(result.renderedText, raw); assert.equal(result.locale, "ja-JP"); assert.equal(JSON.stringify(instance.state), before); assert.equal(sanitizeTerminalText("a\u001bb"), "a[control]b");
});

test("canonical claim, suspicion, and vote segments use deterministic engine renderers", async () => {
  const claimGame = await committed([{ type: "result_claim", targetId: "npc1", result: "werewolf", sourceSpan: { start: 0, end: 5 } }]); const first = render(claimGame), second = render(claimGame); assert.equal(first.renderedText, second.renderedText); assert.equal(first.renderedText.includes("Aoi"), true); assert.equal(/truth|true|false/i.test(first.renderedText), false);
  const suspicionGame = await committed([{ type: "suspicion", targetId: "npc2", sourceSpan: { start: 0, end: 5 } }]); assert.equal(render(suspicionGame).renderedText.includes("Beni"), true);
  const voteGame = game([], false); voteGame.state.phase = "vote"; const createId = ids(), binding = createPhase3Binding({ state: voteGame.state, rawText: "vote!", targetNpcId: "npc1", createId }), prepared = preparePlayerConversationCommit({ state: voteGame.state, binding, alternative: { alternativeId: "vote-alt", confidence: 1, speechActs: [{ type: "vote_declaration", targetId: "npc2", sourceSpan: { start: 0, end: 5 } }] }, targetNpcId: "npc1", createId }); for (const [key, values] of Object.entries(prepared.delta.objects)) voteGame.state.conversation[key].push(...structuredClone(values)); voteGame.state.playerLog.push(structuredClone(prepared.delta.legacyDelta.playerLogEntry)); assert.equal(render(voteGame).renderedText.includes("Beni"), true);
});

test("dangling, duplicate, and invalid publication graphs fail closed with typed consumer errors", async () => {
  const instance = await committed([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }]), publicationId = instance.state.conversation.publications[0].publicationId;
  const common = { gameSessionId: instance.state.gameSessionId, legacyPlayerLog: instance.state.playerLog, publicationId, publicParticipantsById: participants(instance) };
  const missingInput = structuredClone(instance.state.conversation); missingInput.inputRecords = []; assert.throws(() => renderPlayerPublication({ ...common, conversation: missingInput }), (error) => error.code === "dangling_input_reference");
  const duplicate = structuredClone(instance.state.conversation); duplicate.publications.push(structuredClone(duplicate.publications[0])); assert.throws(() => renderPlayerPublication({ ...common, conversation: duplicate }), (error) => error.code === "duplicate_publication");
  const missingParticipant = participants(instance); delete missingParticipant.npc1; const claimInstance = await committed([{ type: "result_claim", targetId: "npc1", result: "werewolf", sourceSpan: { start: 0, end: 5 } }]); assert.throws(() => renderPlayerPublication({ gameSessionId: claimInstance.state.gameSessionId, conversation: claimInstance.state.conversation, legacyPlayerLog: claimInstance.state.playerLog, publicationId: claimInstance.state.conversation.publications[0].publicationId, publicParticipantsById: missingParticipant }), (error) => error.code === "missing_public_participant_projection");
  assert.throws(() => renderPlayerPublication({ ...common, activeGameSessionId: "game-new", conversation: instance.state.conversation }), (error) => error.code === "mismatched_session");
});

test("Phase 5 cutover emits one structured entry, suppresses legacy display, and preserves NPC order", async () => {
  const observed = [], visible = []; const instance = game([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }], true); instance.playerPublicationDeliveryController.observer = (entry) => observed.push(entry); const action = await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" });
  assert.equal(action.structuredPlayerEntries.length, 1); assert.equal(action.playerFacingEntries.length, 2); await deliverLivePlayerEntries({ game: instance, entries: action.livePlayerDisplayEntries, consumerId: "test", sinkType: "browser", writeStructured: async (entry) => visible.push(entry), writeLegacy: async (entry) => visible.push(entry) }); assert.equal(visible[0].structured, true); assert.equal(visible[0].message, "hello"); assert.equal(visible[1].message, "Aoi: NPC response"); assert.equal(visible.some((entry) => entry.message.includes("あなた ->")), false); assert.equal(observed.filter((entry) => entry.outcomeCategory === "publication_acknowledged").length, 1);
});

test("exact replay emits no display/history entry and never rewinds the consumer cursor", async () => {
  const instance = game([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }], true), first = await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }); await deliverLivePlayerEntries({ game: instance, entries: first.livePlayerDisplayEntries, consumerId: "test", sinkType: "cli", writeStructured: async () => {}, writeLegacy: async () => {} }); const record = instance.state.conversation.idempotencyRecords[0], version = instance.state.stateVersion, replay = await instance.dispatchPlayerAction({ type: "ask_npc", replayRequestId: record.requestId, replayRequestFingerprint: record.requestFingerprint }); assert.deepEqual(replay.structuredPlayerEntries, []); assert.deepEqual(replay.livePlayerDisplayEntries, []); assert.equal(instance.state.stateVersion, version);
});

test("OFF-to-ON does not backfill old publications and OFF rollback does not delete records", async () => {
  const instance = game([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }], false); const legacy = await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }); assert.equal(legacy.structuredPlayerEntries.length, 0); instance.state.phase = "day_discussion"; instance.playerStructuredConsumerEnabled = true; const next = await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }); assert.equal(next.structuredPlayerEntries.length, 1); assert.equal(instance.state.conversation.publications.length, 2); instance.playerStructuredConsumerEnabled = false; await instance.dispatchPlayerAction({ type: "get_state" }); assert.equal(instance.state.conversation.publications.length, 2);
});

test("slot ordering is authoritative while append order and legacy array position are ignored", async () => {
  const first = await committed([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }]), publicationId = first.state.conversation.publications[0].publicationId, entries = renderUnacknowledgedPlayerPublications({ gameSessionId: first.state.gameSessionId, conversation: first.state.conversation, legacyPlayerLog: first.state.playerLog, publicParticipantsById: participants(first), publicationIds: [publicationId], resolveCompatibilityMapping: (id) => first.getPlayerLegacyDisplayCompatibilityRecord({ publicationId: id }) }); assert.equal(entries.length, 1); const projected = projectMappedPlayerEntries({ legacyEntries: first.state.playerLog, legacyLogStartOrder: 0, structuredEntries: entries }); assert.equal(projected[entries[0].legacyLogAppendOrder].message, "hello"); assert.equal(projected.filter((entry) => entry.structured).length, 1);
});

test("same-message multiple turns, stale cursors, partial acknowledgement, and NPC entries retain exact identity", async () => {
  const instance = game([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }], true), first = await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello", logCursor: 1 }); await deliverLivePlayerEntries({ game: instance, entries: first.livePlayerDisplayEntries, consumerId: "test", sinkType: "browser", writeStructured: async () => {}, writeLegacy: async () => {} }); const firstPublication = first.structuredPlayerEntries[0].publicationId; instance.state.phase = "day_discussion"; instance.interpreterProvider = interpreterFor([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }]); const second = await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello", logCursor: first.nextLogCursor }); const secondPublication = second.structuredPlayerEntries.find((entry) => entry.publicationId !== firstPublication); assert.ok(secondPublication); assert.equal(second.playerFacingEntries.filter((entry) => entry.structured).length, 1); assert.equal(second.playerFacingEntries.some((entry) => entry.message === "Aoi: NPC response"), true); assert.notEqual(instance.getPlayerLegacyDisplayCompatibilityRecord({ publicationId: firstPublication }).legacyLogAppendOrder, instance.getPlayerLegacyDisplayCompatibilityRecord({ publicationId: secondPublication.publicationId }).legacyLogAppendOrder);
});

test("browser and CLI adapters select derived entries and retain safe output boundaries", () => {
  const browser = readFileSync(new URL("../public/browserApp.mjs", import.meta.url), "utf8"), cli = readFileSync(new URL("../src/cli.mjs", import.meta.url), "utf8");
  assert.match(browser, /result\.livePlayerDisplayEntries\.length/); assert.equal(browser.includes("playerFacingLog.push(...structuredClone(result.playerFacingEntries))"), false); assert.match(browser, /message\.textContent = entry\.message/); assert.equal(browser.includes("message.innerHTML = entry.message"), false);
  assert.match(cli, /action\?\.livePlayerDisplayEntries/); assert.match(cli, /sanitizeTerminalText/);
});
