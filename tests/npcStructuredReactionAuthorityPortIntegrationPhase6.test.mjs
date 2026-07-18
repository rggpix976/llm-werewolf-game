import assert from "node:assert/strict";
import test from "node:test";

import { WerewolfGame } from "../src/gameEngine.mjs";
import { commitInput, createNpcAuthorityPortFixture, readInput } from "./helpers/npcStructuredReactionAuthorityPortFixtures.mjs";

test("WerewolfGame exposes exactly the two approved narrow authority methods", () => {
  assert.equal(typeof WerewolfGame.prototype.readNpcStructuredReactionSnapshot, "function");
  assert.equal(typeof WerewolfGame.prototype.commitPreparedNpcReactionAtomically, "function");
  for (const forbidden of ["getNpcAuthorityState", "readAuthority", "compareAndSwap", "applyNpcDelta", "replaceNpcState", "getNpcRevision", "commitNpcReplacement"]) {
    assert.equal(Object.hasOwn(WerewolfGame.prototype, forbidden), false);
  }
});

test("authority snapshot is absent from existing public and developer snapshots", () => {
  const value = createNpcAuthorityPortFixture();
  value.game.readNpcStructuredReactionSnapshot(readInput(value));
  for (const snapshot of [value.game.getPublicSnapshot(), value.game.getDeveloperSnapshot()]) {
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes("npc_structured_reaction_authority"), false);
    assert.equal(serialized.includes("npcReactionCommitIdempotencyRecords"), false);
  }
});

test("read resolves committed replay from the authoritative graph without coordinator state", () => {
  const value = createNpcAuthorityPortFixture();
  const committed = value.game.commitPreparedNpcReactionAtomically(commitInput(value));
  assert.equal(committed.status, "committed");
  const snapshot = value.game.readNpcStructuredReactionSnapshot(readInput(value));
  assert.equal(snapshot.committedReplay.status, "replayed");
  assert.equal(snapshot.committedReplay.logicalIdentity.reactionPlanId, committed.result.reactionPlanId);
  assert.deepEqual(snapshot.committedReplay.result, committed.result);
});

test("production dispatch and legacy NPC behavior do not invoke the new authority port", async () => {
  const game = WerewolfGame.create({ seed: 1, scenario: "sample", shuffleRoles: false });
  game.readNpcStructuredReactionSnapshot = () => { throw new Error("unexpected read"); };
  game.commitPreparedNpcReactionAtomically = () => { throw new Error("unexpected commit"); };
  const result = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" });
  assert.equal(result.ok, true);
});
