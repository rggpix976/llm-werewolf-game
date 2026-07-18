import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../src/conversation/ids.mjs";
import { commitNpcReactionAuthoritatively } from "../src/npcReactionAuthoritativeCommit.mjs";
import {
  buildNpcReactionCommitTransactionProjection,
  translateNpcReactionCommitReplacementToAuthorizedDelta,
  validateNpcReactionAuthorizedDelta
} from "../src/npcReactionAuthorityTranslation.mjs";
import {
  commitInputFromProjection,
  createAuthorityTranslationFixture
} from "./helpers/npcReactionAuthorityTranslationFixtures.mjs";

test("actual Commit replacement translates to one detached authorized delta", () => {
  const fixture = createAuthorityTranslationFixture();
  const gameBefore = canonicalJson(fixture.gameState);
  const currentProjection = buildNpcReactionCommitTransactionProjection(fixture.gameState);
  const projectionBefore = canonicalJson(currentProjection);
  const preparedBefore = canonicalJson(fixture.preparedReaction);
  const commitInput = commitInputFromProjection(fixture, currentProjection);
  const commitResult = commitNpcReactionAuthoritatively(commitInput);
  assert.equal(commitResult.status, "committed");

  const replacementBefore = canonicalJson(commitResult.replacementState);
  const delta = translateNpcReactionCommitReplacementToAuthorizedDelta({
    currentProjection,
    replacementProjection: commitResult.replacementState,
    preparedReaction: fixture.preparedReaction
  });
  assert.equal(validateNpcReactionAuthorizedDelta(delta), undefined);
  assert.deepEqual(delta.precondition, {
    gameSessionId: "game-session-1",
    turnId: "turn-1",
    turnOrder: 1,
    stateVersion: 2,
    phase: "player_question"
  });
  assert.equal(delta.resultingStateVersion, 3);
  assert.deepEqual(Object.fromEntries(Object.entries(delta.appends).map(([key, value]) => [key, value.length])), {
    reactionPlans: 1,
    claims: 0,
    events: 1,
    publications: 1,
    npcReactionCommitIdempotencyRecords: 1,
    commitResults: 1
  });
  assert.deepEqual(delta.counters, {
    nextCreatedOrder: 4,
    nextPublicationSlotOrder: 2,
    nextRecordAppendOrder: 2
  });
  assert.equal(Object.isFrozen(delta), true);
  assert.equal(Object.isFrozen(delta.appends.events[0]), true);
  assert.equal(canonicalJson(fixture.gameState), gameBefore);
  assert.equal(canonicalJson(currentProjection), projectionBefore);
  assert.equal(canonicalJson(fixture.preparedReaction), preparedBefore);
  assert.equal(canonicalJson(commitResult.replacementState), replacementBefore);
  assert.notEqual(delta.appends.reactionPlans[0], commitResult.replacementState.conversation.reactionPlans[0]);
  assert.notEqual(delta.appends.reactionPlans[0], fixture.preparedReaction.delta.plan);
});

test("claim-producing actual Commit preserves exact prepared order and bounds", () => {
  const proposals = [
    { proposalType: "role_claim", claimedRole: "seer" },
    { proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" },
    { proposalType: "suspicion", targetId: "npc-beni" }
  ];
  const fixture = createAuthorityTranslationFixture(proposals);
  const current = buildNpcReactionCommitTransactionProjection(fixture.gameState);
  const committed = commitNpcReactionAuthoritatively(commitInputFromProjection(fixture, current));
  assert.equal(committed.status, "committed");
  const delta = translateNpcReactionCommitReplacementToAuthorizedDelta({
    currentProjection: current,
    replacementProjection: committed.replacementState,
    preparedReaction: fixture.preparedReaction
  });
  assert.deepEqual(delta.appends.claims, fixture.preparedReaction.delta.claims);
  assert.deepEqual(delta.appends.events, fixture.preparedReaction.delta.events);
  assert.equal(delta.appends.claims.length, 2);
  assert.equal(delta.appends.events.length, 3);
});

test("replay and rejection outcomes expose no replacement for translation", () => {
  const fixture = createAuthorityTranslationFixture();
  const current = buildNpcReactionCommitTransactionProjection(fixture.gameState);
  const committed = commitNpcReactionAuthoritatively(commitInputFromProjection(fixture, current));
  const retry = commitInputFromProjection(fixture, committed.replacementState);
  retry.liveValidationContext.currentStateVersion = committed.replacementState.stateVersion;
  const replay = commitNpcReactionAuthoritatively(retry);
  assert.equal(replay.status, "replayed");
  assert.equal(Object.hasOwn(replay, "replacementState"), false);

  const stale = createAuthorityTranslationFixture();
  const staleCurrent = buildNpcReactionCommitTransactionProjection(stale.gameState);
  const staleInput = commitInputFromProjection(stale, staleCurrent);
  staleInput.liveValidationContext.currentPhase = "day_discussion";
  const rejected = commitNpcReactionAuthoritatively(staleInput);
  assert.equal(rejected.status, "rejected");
  assert.equal(Object.hasOwn(rejected, "replacementState"), false);
});

test("production translator remains isolated from Commit and game engine", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/npcReactionAuthorityTranslation.mjs", import.meta.url), "utf8"));
  for (const forbidden of [
    "npcReactionAuthoritativeCommit", "commitNpcReactionAuthoritatively", "gameEngine",
    "commitState", "readNpcStructuredReactionSnapshot", "commitPreparedNpcReactionAtomically"
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});
