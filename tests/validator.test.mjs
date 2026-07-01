import assert from "node:assert/strict";
import test from "node:test";
import { validateNpcResponseRequest } from "../src/validator.mjs";

const validRequest = {
  npc: {
    id: "npc1",
    name: "Aoi",
    personality: "P",
    speechStyle: "S",
    conversationPolicy: {
        truthfulness: "t",
        roleClaim: "r",
        allowedTactics: [],
        forbidden: []
    }
  },
  playerInput: "Hello",
  context: {
    day: 1,
    phase: "day",
    publicEvidence: [],
    shareableKnownEvidence: [],
    privateStanceEvidence: [],
    publicClaims: [],
    intent: { asksWerewolfIdentity: false, asksRoleOrClaim: false, asksVoteReason: false },
    topSuspect: null
  },
  policyDecision: { publicClaimAllowed: false, publicClaim: null, disclosedHiddenInfo: false },
  responsePlan: { baseText: "B", speechStyle: "S" },
  evidenceUsed: []
};

test("Validator accepts a real game-generated request", () => {
  const result = validateNpcResponseRequest(validRequest);
  assert.equal(result.npc.id, "npc1");
  assert.equal(result.playerInput, "Hello");
});

test("Strict type validation", () => {
  // Reject string "false" instead of boolean false
  const invalidBool = JSON.parse(JSON.stringify(validRequest));
  invalidBool.policyDecision.publicClaimAllowed = "false";
  assert.throws(() => validateNpcResponseRequest(invalidBool), /must be a boolean/);

  // Reject object instead of array
  const invalidArray = JSON.parse(JSON.stringify(validRequest));
  invalidArray.context.publicEvidence = {};
  assert.throws(() => validateNpcResponseRequest(invalidArray), /must be an array/);

  // Reject missing required fields
  const missingField = JSON.parse(JSON.stringify(validRequest));
  delete missingField.npc.id;
  assert.throws(() => validateNpcResponseRequest(missingField), /npc.id must be a string/);
});

test("Allowlist reconstruction policy", () => {
  const untrusted = JSON.parse(JSON.stringify(validRequest));
  untrusted.extraField = "dangerous";
  untrusted.npc.evil = "hack";

  const result = validateNpcResponseRequest(untrusted);
  assert.ok(!("extraField" in result), "Extra top-level fields should be stripped");
  assert.ok(!("evil" in result.npc), "Extra nested fields should be stripped");
  assert.equal(result.npc.id, "npc1");
});

test("Size and nesting limits", () => {
    // Oversized string
    const bigString = JSON.parse(JSON.stringify(validRequest));
    bigString.playerInput = "a".repeat(10001);
    assert.throws(() => validateNpcResponseRequest(bigString), /too long/);

    // Oversized array
    const bigArray = JSON.parse(JSON.stringify(validRequest));
    for (let i = 0; i < 201; i++) bigArray.evidenceUsed.push("e");
    assert.throws(() => validateNpcResponseRequest(bigArray), /length out of range/);
});

test("PolicyDecision consistency validation", () => {
    // true requires publicClaim
    const t1 = JSON.parse(JSON.stringify(validRequest));
    t1.policyDecision.publicClaimAllowed = true;
    t1.policyDecision.disclosedHiddenInfo = true;
    t1.policyDecision.publicClaim = null;
    assert.throws(() => validateNpcResponseRequest(t1), /true requires a valid publicClaim/);

    // true requires disclosedHiddenInfo
    const t2 = JSON.parse(JSON.stringify(validRequest));
    t2.policyDecision.publicClaimAllowed = true;
    t2.policyDecision.disclosedHiddenInfo = false;
    t2.policyDecision.publicClaim = { day: 1, actorId: "n1", actorName: "A", role: "seer", results: [] };
    assert.throws(() => validateNpcResponseRequest(t2), /true requires disclosedHiddenInfo: true/);

    // false requires null publicClaim
    const t3 = JSON.parse(JSON.stringify(validRequest));
    t3.policyDecision.publicClaimAllowed = false;
    t3.policyDecision.publicClaim = { day: 1, actorId: "n1", actorName: "A", role: "seer", results: [] };
    assert.throws(() => validateNpcResponseRequest(t3), /false requires publicClaim: null/);
});
