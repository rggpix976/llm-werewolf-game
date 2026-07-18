import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../src/conversation/ids.mjs";
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
  const replay = value.game.readNpcStructuredReactionSnapshot(readInput(value));
  assert.deepEqual(Object.keys(replay), [
    "schemaVersion", "status", "gameSessionId", "triggerRequestId",
    "originatingInputRecordId", "logicalIdentity", "result"
  ]);
  assert.equal(replay.status, "replayed");
  assert.equal(replay.logicalIdentity.reactionPlanId, committed.result.reactionPlanId);
  assert.deepEqual(replay.result, committed.result);
  assert.equal(Object.isFrozen(replay), true);
});

test("historical replay is independent of current turn, applicability, winner, and projections", async (t) => {
  const cases = [
    ["later stateVersion", (state) => { state.stateVersion += 7; }],
    ["later turn and phase", (state) => { state.turnId = "turn-later"; state.turnOrder += 1; state.phase = "night"; state.stateVersion += 1; }],
    ["actor death", (state) => { const actor = state.players.find((player) => player.id === "npc-aoi"); actor.alive = false; state.alivePlayers = state.alivePlayers.filter((id) => id !== actor.id); state.deadPlayers.push(actor.id); }],
    ["actor removal and no projection source", (state) => { state.players = state.players.filter((player) => player.id !== "npc-aoi"); state.alivePlayers = state.alivePlayers.filter((id) => id !== "npc-aoi"); }],
    ["winner determination", (state) => { state.winner = "werewolf"; }]
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const value = createNpcAuthorityPortFixture();
    const committed = value.game.commitPreparedNpcReactionAtomically(commitInput(value));
    mutate(value.game.state);
    const before = canonicalJson(value.game.state);
    const replay = value.game.readNpcStructuredReactionSnapshot(readInput(value));
    assert.equal(replay.status, "replayed");
    assert.deepEqual(replay.result, committed.result);
    assert.equal(canonicalJson(value.game.state), before);
    assert.equal(Object.hasOwn(replay, "knownInformationProjection"), false);
    assert.equal(Object.hasOwn(replay, "currentRoster"), false);
  });
});

test("not-found stale trigger returns redacted conflict without mixed-time projection", () => {
  const value = createNpcAuthorityPortFixture();
  const actor = value.game.state.players.find((player) => player.id === "npc-aoi");
  Object.defineProperty(actor, "knownInfo", { enumerable: true, get() { throw new Error("projection must not run"); } });
  value.game.state.turnId = "turn-later";
  value.game.state.turnOrder += 1;
  value.game.state.phase = "night";
  value.game.state.stateVersion += 1;
  const result = value.game.readNpcStructuredReactionSnapshot(readInput(value));
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: "conflict",
    gameSessionId: value.game.state.gameSessionId,
    triggerRequestId: value.playerResult.requestId,
    originatingInputRecordId: value.playerResult.inputRecordId,
    code: "stale_trigger"
  });
  assert.equal(Object.isFrozen(result), true);
});

test("production dispatch and legacy NPC behavior do not invoke the new authority port", async () => {
  const game = WerewolfGame.create({ seed: 1, scenario: "sample", shuffleRoles: false });
  game.readNpcStructuredReactionSnapshot = () => { throw new Error("unexpected read"); };
  game.commitPreparedNpcReactionAtomically = () => { throw new Error("unexpected commit"); };
  const result = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" });
  assert.equal(result.ok, true);
});
