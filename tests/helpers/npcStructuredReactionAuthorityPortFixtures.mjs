import { sha256CanonicalJson } from "../../src/conversation/ids.mjs";
import { WerewolfGame } from "../../src/gameEngine.mjs";
import { createAuthorityTranslationFixture } from "./npcReactionAuthorityTranslationFixtures.mjs";

export function createNpcAuthorityPortFixture(options = {}) {
  const fixture = createAuthorityTranslationFixture([
    { proposalType: "role_claim", claimedRole: "seer" }
  ]);
  const actor = fixture.gameState.players.find((player) => player.id === "npc-aoi");
  actor.role = "seer";
  actor.team = "village";
  actor.conversationPolicy = {
    truthfulness: "honest_but_may_withhold_private_info",
    roleClaim: "claim_when_directly_asked_after_result",
    allowedTactics: [],
    forbidden: []
  };
  actor.knownInfo = [{
    day: 1,
    type: "seer_result",
    targetId: "npc-beni",
    result: "werewolf"
  }];
  const playerResult = fixture.gameState.conversation.commitResults.find((result) => result.commitType === "player_conversation");
  const publication = fixture.gameState.conversation.publications.find((record) => record.recordType === "player_utterance_published");
  const input = fixture.gameState.conversation.inputRecords.find((record) => record.inputRecordId === playerResult.inputRecordId);
  const legacyEntry = { day: 1, phase: "player_question", message: "Player -> Aoi: Question?" };
  fixture.gameState.playerLog.push(legacyEntry);
  fixture.gameState.conversation.playerLegacyDisplayCompatibilityRecords.push({
    schemaVersion: 1,
    recordType: "player_legacy_display_compatibility",
    compatibilityMappingId: "compatibility-mapping-1",
    gameSessionId: fixture.gameState.gameSessionId,
    publicationId: publication.publicationId,
    displayPlanId: playerResult.displayPlanId,
    inputRecordId: input.inputRecordId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    turnId: input.turnId,
    legacyEntryId: "legacy-entry-1",
    legacyLogAppendOrder: 0,
    legacyEntryFingerprint: sha256CanonicalJson(legacyEntry),
    playerCommitResultingStateVersion: playerResult.resultingStateVersion,
    createdOrder: 100
  });
  fixture.gameState.conversation.idempotencyRecords.push({
    requestId: playerResult.requestId,
    requestFingerprint: playerResult.requestFingerprint,
    result: structuredClone(playerResult)
  });
  const game = new WerewolfGame(fixture.gameState, undefined, {
    createId: sequentialIds(),
    npcAuthorityFaultInjector: options.npcAuthorityFaultInjector
  });
  return { game, fixture, playerResult };
}

export function readInput(value) {
  return {
    schemaVersion: 1,
    gameSessionId: value.game.state.gameSessionId,
    triggerRequestId: value.playerResult.requestId,
    originatingInputRecordId: value.playerResult.inputRecordId
  };
}

export function commitInput(value) {
  return {
    schemaVersion: 1,
    gameSessionId: value.game.state.gameSessionId,
    expectedStateVersion: value.game.state.stateVersion,
    preparedReaction: structuredClone(value.fixture.preparedReaction),
    coordinatorRoot: structuredClone(value.fixture.coordinatorRoot),
    preCommitReferenceContext: structuredClone(value.fixture.preCommitReferenceContext)
  };
}

function sequentialIds() {
  let value = 0;
  return () => `authority-port-${++value}`;
}
