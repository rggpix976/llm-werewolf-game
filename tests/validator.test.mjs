import assert from "node:assert/strict";
import test from "node:test";
import { validateNpcResponseRequest } from "../src/validator.mjs";

const validBase = {
  npc: {
    id: "npc1",
    name: "Aoi",
    personality: "Calm",
    speechStyle: "calm",
    conversationPolicy: {
      truthfulness: "honest",
      roleClaim: "never",
      allowedTactics: ["tactic1"],
      forbidden: ["lie"]
    }
  },
  playerInput: "Hello",
  context: {
    day: 1,
    phase: "day_discussion",
    publicEvidence: [{ day: 1, phase: "day_discussion", type: "setup", text: "text" }],
    shareableKnownEvidence: [],
    privateStanceEvidence: [],
    publicClaims: [],
    intent: { asksWerewolfIdentity: false },
    topSuspect: { id: "npc2", name: "Beni", score: 5 }
  },
  policyDecision: {
    publicClaimAllowed: false,
    publicClaim: null,
    disclosedHiddenInfo: false
  },
  responsePlan: {
    baseText: "I am Aoi.",
    speechStyle: "calm"
  },
  evidenceUsed: ["evidence1"]
};

test("validateNpcResponseRequest - valid input", () => {
  const result = validateNpcResponseRequest(validBase);
  assert.deepEqual(result.npc.id, "npc1");
  assert.equal(result.playerInput, "Hello");
  assert.equal(result.context.day, 1);
});

test("validateNpcResponseRequest - rejects arbitrary additional fields", () => {
  const input = { ...validBase, extra: "field" };
  const result = validateNpcResponseRequest(input);
  assert.equal(result.extra, undefined);
});

test("validateNpcResponseRequest - rejects oversized string", () => {
  const input = { ...validBase, playerInput: "a".repeat(1001) };
  assert.throws(() => validateNpcResponseRequest(input), /playerInput too long/);
});

test("validateNpcResponseRequest - rejects invalid types", () => {
  const input = { ...validBase, playerInput: 123 };
  assert.throws(() => validateNpcResponseRequest(input), /playerInput must be a string/);
});

test("validateNpcResponseRequest - rejects missing required fields", () => {
  const input = { ...validBase };
  delete input.npc;
  assert.throws(() => validateNpcResponseRequest(input), /Missing or invalid npc/);
});

test("validateNpcResponseRequest - rejects oversized array", () => {
  const input = { ...validBase, evidenceUsed: Array(21).fill("e") };
  assert.throws(() => validateNpcResponseRequest(input), /evidenceUsed length out of range/);
});
