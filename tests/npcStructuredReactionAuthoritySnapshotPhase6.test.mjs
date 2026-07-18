import assert from "node:assert/strict";
import test from "node:test";

import {
  NPC_STRUCTURED_REACTION_AUTHORITY_PORT_INVARIANT_CODES,
  NpcStructuredReactionAuthorityPortInvariantError,
  validateNpcStructuredReactionAuthoritySnapshot
} from "../src/npcStructuredReactionAuthorityPort.mjs";
import { canonicalJson } from "../src/conversation/ids.mjs";
import { createNpcAuthorityPortFixture, readInput } from "./helpers/npcStructuredReactionAuthorityPortFixtures.mjs";

const SNAPSHOT_FIELDS = [
  "schemaVersion", "snapshotType", "gameSessionId", "turnId", "turnOrder", "currentPhase",
  "stateVersion", "triggeringCommitResult", "originatingInputRecord", "triggeringEvents",
  "targetNpcId", "knownInformationProjection", "currentRoster", "actorApplicability",
  "currentAuthorization", "currentTargetIds", "existingClaims", "existingEvents",
  "nextOrderEvidence", "occupiedArtifactIds", "publicParticipantsById", "committedReplay"
];

test("authority port module exposes exactly three closed browser-safe exports", async () => {
  const module = await import("../src/npcStructuredReactionAuthorityPort.mjs");
  assert.deepEqual(Object.keys(module).sort(), [
    "NPC_STRUCTURED_REACTION_AUTHORITY_PORT_INVARIANT_CODES",
    "NpcStructuredReactionAuthorityPortInvariantError",
    "validateNpcStructuredReactionAuthoritySnapshot"
  ].sort());
  assert.equal(NPC_STRUCTURED_REACTION_AUTHORITY_PORT_INVARIANT_CODES.length, 12);
  const error = new NpcStructuredReactionAuthorityPortInvariantError("unknown");
  assert.equal(error.name, "NpcStructuredReactionAuthorityPortInvariantError");
  assert.equal(error.message, "Invalid NPC structured reaction authority operation.");
  assert.equal(error.code, "invalid_npc_structured_authority_input");
  assert.equal(Object.hasOwn(error, "cause"), false);
});

test("read resolves exact committed ask_npc graph into a detached frozen 22-field snapshot", () => {
  const value = createNpcAuthorityPortFixture();
  const before = canonicalJson(value.game.state);
  const snapshot = value.game.readNpcStructuredReactionSnapshot(readInput(value));
  assert.deepEqual(Object.keys(snapshot), SNAPSHOT_FIELDS);
  assert.equal(validateNpcStructuredReactionAuthoritySnapshot(snapshot), undefined);
  assert.equal(snapshot.targetNpcId, "npc-aoi");
  assert.equal(snapshot.committedReplay.status, "not_found");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.knownInformationProjection), true);
  assert.equal(canonicalJson(value.game.state), before);
  assert.notEqual(snapshot.existingEvents, value.game.state.conversation.events);
  assert.equal(JSON.stringify(snapshot).includes("private-personality"), false);
});

test("read exact input, trigger identity, reentrancy, and destroy boundaries fail closed", () => {
  const value = createNpcAuthorityPortFixture();
  const base = readInput(value);
  for (const invalid of [null, { ...base, extra: true }, { ...base, schemaVersion: 2 }, { ...base, triggerRequestId: "missing-request" }]) {
    assert.throws(() => value.game.readNpcStructuredReactionSnapshot(invalid), NpcStructuredReactionAuthorityPortInvariantError);
  }
  const accessor = { ...base };
  Object.defineProperty(accessor, "triggerRequestId", { enumerable: true, get() { throw new Error("getter"); } });
  assert.throws(() => value.game.readNpcStructuredReactionSnapshot(accessor), NpcStructuredReactionAuthorityPortInvariantError);
  value.game.npcAuthorityCommitInProgress = true;
  assert.throws(() => value.game.readNpcStructuredReactionSnapshot(base), NpcStructuredReactionAuthorityPortInvariantError);
  value.game.npcAuthorityCommitInProgress = false;
  value.game.destroy();
  assert.throws(() => value.game.readNpcStructuredReactionSnapshot(base), NpcStructuredReactionAuthorityPortInvariantError);
});

test("all read fault stages preserve live authority", async (t) => {
  for (const faultStage of ["read_before_trigger_resolution", "read_after_trigger_resolution", "read_before_snapshot_freeze"]) {
    await t.test(faultStage, () => {
      const value = createNpcAuthorityPortFixture({ npcAuthorityFaultInjector(stage) { if (stage === faultStage) throw new Error("fault"); } });
      const before = canonicalJson(value.game.state);
      assert.throws(() => value.game.readNpcStructuredReactionSnapshot(readInput(value)), /fault/);
      assert.equal(canonicalJson(value.game.state), before);
    });
  }
});
