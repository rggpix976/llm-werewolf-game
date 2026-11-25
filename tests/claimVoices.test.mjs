import assert from "node:assert/strict";
import test from "node:test";
import { CAST_ROSTER } from "../src/cast.mjs";
import { OpenAIResponseProvider } from "../src/openaiProvider.mjs";
import { buildProactiveSeerClaim, claimOpeningFor, seerClaimClosingFor } from "../src/responseGenerator.mjs";

// D-035: claim announcements speak in the claimant's own set phrases.

const PLAYERS = [
  { id: "npc1", name: "桐生一馬", alive: true },
  { id: "npc2", name: "真島吾朗", alive: true },
  { id: "npc3", name: "冴島大河", alive: true },
  { id: "npc5", name: "春日一番", alive: true }
];

function seerFromCast(member, overrides = {}) {
  return {
    ...structuredClone(member),
    role: "seer",
    alive: true,
    knownInfo: [{ day: 1, type: "seer_result", visibility: "private", shareable: false, targetId: "npc5", result: "werewolf" }],
    publicClaims: [],
    conversationPolicy: { roleClaim: "claim_when_directly_asked_after_result" },
    ...overrides
  };
}

function state() {
  return { day: 2, phase: "day_discussion", players: PLAYERS };
}

test("claim voices: every roster member carries a full claimVoice set", () => {
  for (const member of CAST_ROSTER) {
    assert.ok(member.claimVoice, `${member.id} has claimVoice`);
    for (const role of ["seer", "medium", "knight"]) {
      assert.equal(typeof member.claimVoice.openings?.[role], "string", `${member.id} openings.${role}`);
      assert.ok(member.claimVoice.openings[role].length > 0);
    }
    for (const role of ["seer", "medium"]) {
      assert.equal(typeof member.claimVoice.more?.[role], "string", `${member.id} more.${role}`);
      assert.ok(member.claimVoice.more[role].length > 0);
    }
    assert.equal(typeof member.claimVoice.closing, "string", `${member.id} closing`);
    assert.ok(member.claimVoice.closing.length > 0);
    assert.equal(typeof member.claimVoice.resultEnding, "string", `${member.id} resultEnding`);
    assert.ok(member.claimVoice.resultEnding.length > 0);
  }
  const seerOpenings = CAST_ROSTER.map((member) => member.claimVoice.openings.seer);
  assert.equal(new Set(seerOpenings).size, CAST_ROSTER.length, "seer openings are distinct per character");
  for (const key of ["seer", "medium"]) {
    const leads = CAST_ROSTER.map((member) => member.claimVoice.more[key]);
    assert.equal(new Set(leads).size, CAST_ROSTER.length, `${key} follow-up leads are distinct per character`);
  }
});

test("claim voices: two characters announce the same seer result in their own phrases", () => {
  const saejima = CAST_ROSTER.find((member) => member.id === "npc3");
  const majima = CAST_ROSTER.find((member) => member.id === "npc2");
  const saejimaClaim = buildProactiveSeerClaim(seerFromCast(saejima), state());
  const majimaClaim = buildProactiveSeerClaim(seerFromCast(majima, { id: "npc2" }), state());
  assert.ok(saejimaClaim && majimaClaim);
  assert.notEqual(saejimaClaim.text, majimaClaim.text);
  assert.ok(saejimaClaim.text.startsWith(saejima.claimVoice.openings.seer), saejimaClaim.text);
  assert.ok(majimaClaim.text.startsWith(majima.claimVoice.openings.seer), majimaClaim.text);
  // The result wording itself stays canonical and unambiguous in both;
  // only the sentence ending follows the character.
  assert.ok(saejimaClaim.text.includes("春日一番は人狼判定や。"));
  assert.ok(majimaClaim.text.includes("春日一番は人狼判定や。"));
  assert.ok(saejimaClaim.text.endsWith(saejima.claimVoice.closing));
  assert.ok(majimaClaim.text.endsWith(majima.claimVoice.closing));
});

test("claim voices: Nanba's result ending is だな (user-specified)", () => {
  const nanba = CAST_ROSTER.find((member) => member.id === "npc6");
  assert.equal(nanba.claimVoice.resultEnding, "だな");
  const claim = buildProactiveSeerClaim(seerFromCast(nanba, { id: "npc6" }), state());
  assert.ok(claim.text.includes("春日一番は人狼判定だな。"), claim.text);
});

test("claim voices: an NPC without claimVoice data keeps the canonical claim text", () => {
  const legacy = seerFromCast(CAST_ROSTER[0], { claimVoice: undefined });
  const claim = buildProactiveSeerClaim(legacy, state());
  assert.equal(claim.text, "占い師COします。春日一番は人狼判定です。公開する以上、この結果を軸に考えてください。");
  assert.equal(claimOpeningFor(legacy, "seer"), "占い師COします。");
  assert.equal(claimOpeningFor(legacy, "medium", true), "霊媒結果を追加で公開します。");
  assert.equal(seerClaimClosingFor(legacy), "公開する以上、この結果を軸に考えてください。");
});

test("claim voices: provider instructions pin stance direction and name replacement", () => {
  const instructions = new OpenAIResponseProvider({ apiKey: "test" })._getFixedInstructions();
  assert.match(instructions, /賛成を反対寄りに弱めたり/);
  assert.match(instructions, /addressFormsの呼称に置き換えて話してください/);
});
