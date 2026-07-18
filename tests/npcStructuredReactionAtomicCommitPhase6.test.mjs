import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../src/conversation/ids.mjs";
import { NpcStructuredReactionAuthorityPortInvariantError } from "../src/npcStructuredReactionAuthorityPort.mjs";
import { commitInput, createNpcAuthorityPortFixture } from "./helpers/npcStructuredReactionAuthorityPortFixtures.mjs";

test("atomic commit publishes one authorized NPC graph at exact N to N+1", () => {
  const value = createNpcAuthorityPortFixture();
  const input = commitInput(value);
  const inputBefore = canonicalJson(input);
  const before = structuredClone(value.game.state);
  const result = value.game.commitPreparedNpcReactionAtomically(input);
  assert.deepEqual(Object.keys(result), ["schemaVersion", "status", "result", "coordinatorCleanupHandoff"]);
  assert.equal(result.status, "committed");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(value.game.state.stateVersion, before.stateVersion + 1);
  assert.equal(value.game.state.conversation.reactionPlans.length, before.conversation.reactionPlans.length + 1);
  assert.equal(value.game.state.conversation.publications.length, before.conversation.publications.length + 1);
  assert.equal(value.game.state.conversation.npcReactionCommitIdempotencyRecords.length, 1);
  assert.equal(Object.hasOwn(result, "replacementState"), false);
  assert.equal(Object.hasOwn(result, "authorizedDelta"), false);
  assert.equal(canonicalJson(input), inputBefore);
});

test("version conflict returns before working copy and leaves live authority unchanged", () => {
  const value = createNpcAuthorityPortFixture();
  const input = commitInput(value);
  input.expectedStateVersion -= 1;
  const before = canonicalJson(value.game.state);
  const result = value.game.commitPreparedNpcReactionAtomically(input);
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: "conflict",
    gameSessionId: value.game.state.gameSessionId,
    expectedStateVersion: input.expectedStateVersion,
    currentStateVersion: value.game.state.stateVersion
  });
  assert.equal(canonicalJson(value.game.state), before);
});

test("exact retry returns replayed without a second publication", () => {
  const value = createNpcAuthorityPortFixture();
  const input = commitInput(value);
  assert.equal(value.game.commitPreparedNpcReactionAtomically(input).status, "committed");
  const before = canonicalJson(value.game.state);
  input.expectedStateVersion = value.game.state.stateVersion;
  const result = value.game.commitPreparedNpcReactionAtomically(input);
  assert.equal(result.status, "replayed");
  assert.equal(canonicalJson(value.game.state), before);
});

test("live actor eligibility is rebuilt from working authority and rejects without publication", () => {
  const value = createNpcAuthorityPortFixture();
  const input = commitInput(value);
  const actor = value.game.state.players.find((player) => player.id === "npc-aoi");
  actor.alive = false;
  value.game.state.alivePlayers = value.game.state.alivePlayers.filter((id) => id !== actor.id);
  value.game.state.deadPlayers.push(actor.id);
  const before = canonicalJson(value.game.state);
  const result = value.game.commitPreparedNpcReactionAtomically(input);
  assert.equal(result.status, "rejected");
  assert.equal(result.rejection.stage, "authorization");
  assert.equal(result.rejection.reasonCode, "actor_ineligible");
  assert.equal(canonicalJson(value.game.state), before);
});

test("every approved fault stage preserves authority and clears the commit latch", async (t) => {
  const stages = [
    "commit_before_working_copy", "commit_after_working_copy", "commit_after_projection",
    "commit_before_pure_commit", "commit_after_pure_commit", "commit_before_translation",
    "commit_after_translation", "commit_before_delta_apply", "commit_after_delta_apply",
    "commit_before_working_validation", "commit_after_working_validation",
    "commit_before_final_replacement"
  ];
  for (const faultStage of stages) await t.test(faultStage, () => {
    let activeStage = faultStage;
    const value = createNpcAuthorityPortFixture({ npcAuthorityFaultInjector(stage) { if (stage === activeStage) throw new Error("fault"); } });
    const input = commitInput(value), before = canonicalJson(value.game.state);
    assert.throws(() => value.game.commitPreparedNpcReactionAtomically(input));
    assert.equal(canonicalJson(value.game.state), before);
    assert.equal(value.game.npcAuthorityCommitInProgress, false);
    activeStage = null;
    assert.equal(value.game.commitPreparedNpcReactionAtomically(input).status, "committed");
  });
});

test("commit input exactness, nested accessors, reentrancy, and destroy fail closed", () => {
  const value = createNpcAuthorityPortFixture();
  const input = commitInput(value);
  assert.throws(() => value.game.commitPreparedNpcReactionAtomically({ ...input, extra: true }), NpcStructuredReactionAuthorityPortInvariantError);
  const accessor = structuredClone(input);
  Object.defineProperty(accessor.preparedReaction, "delta", { enumerable: true, get() { throw new Error("getter"); } });
  assert.throws(() => value.game.commitPreparedNpcReactionAtomically(accessor), NpcStructuredReactionAuthorityPortInvariantError);
  value.game.npcAuthorityCommitInProgress = true;
  assert.throws(() => value.game.commitPreparedNpcReactionAtomically(input), NpcStructuredReactionAuthorityPortInvariantError);
  value.game.npcAuthorityCommitInProgress = false;
  value.game.destroy();
  assert.throws(() => value.game.commitPreparedNpcReactionAtomically(input), NpcStructuredReactionAuthorityPortInvariantError);
});
