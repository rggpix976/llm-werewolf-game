import test from "node:test";
import assert from "node:assert/strict";
import { CAST_ROSTER, castMemberById, addressFormFor, addressFormsFor, selectCast } from "../src/cast.mjs";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { SeededRandom } from "../src/seededRandom.mjs";
import { buildNpcResponseRequest, buildNpcDecisionRequest } from "../src/responseGenerator.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";
import { OpenAIResponseProvider } from "../src/openaiProvider.mjs";

const ids = (cast) => cast.map((member) => member.id);
const seeded = (seed) => { const rng = new SeededRandom(seed); return () => rng.next(); };

test("roster has twelve ordered, unique characters and balanced leans", () => {
  assert.equal(CAST_ROSTER.length, 12);
  assert.deepEqual(ids(CAST_ROSTER), Array.from({ length: 12 }, (_, i) => `npc${i + 1}`));
  for (const field of ["name", "callName"]) assert.equal(new Set(CAST_ROSTER.map((c) => c[field])).size, 12);
  assert.deepEqual(CAST_ROSTER.reduce((counts, c) => {
    counts[c.strategyLean] = (counts[c.strategyLean] ?? 0) + 1;
    return counts;
  }, {}), { neutral: 4, gray: 4, roller: 4 });
  for (const member of CAST_ROSTER) {
    assert.equal(castMemberById(member.id), member);
    assert.ok(member.voiceProfile.length > 0);
    // Every voice pins its dialect/register, so the model cannot fill the
    // gap with another speaker's dialect (Kansai-ben belongs to its two
    // specified members only).
    assert.match(member.voiceProfile, /方言|関西弁/);
    assert.ok(member.aliases.includes(member.name));
    for (const target of Object.keys(member.addressExceptions)) {
      assert.ok(castMemberById(target));
      assert.notEqual(target, member.id);
    }
  }
  assert.equal(castMemberById("missing"), undefined);
});

test("address exceptions and plain/san defaults use standard appellations", () => {
  for (const [speaker, target, expected] of [
    [5, 8, "サッちゃん"], [10, 8, "紗栄子さん"], [6, 4, "堂島さん"],
    [9, 6, "ナンバくん"], [1, 12, "錦"], [2, 3, "兄弟"], [3, 2, "兄弟"], [1, 5, "春日"]
  ]) assert.equal(addressFormFor(castMemberById(`npc${speaker}`), castMemberById(`npc${target}`)), expected);
});

test("address map includes dead participants and excludes only the speaker", () => {
  const players = CAST_ROSTER.map((member) => ({ ...member, alive: member.id !== "npc8" }));
  const forms = addressFormsFor(players[4], players);
  assert.equal(Object.keys(forms).length, 11);
  assert.equal(forms.npc5, undefined);
  assert.equal(forms.npc8, "サッちゃん");
});

test("explicit cast preserves order and takes precedence over pins", () => {
  const castIds = ["npc12", "npc10", "npc8", "npc6", "npc4"];
  assert.deepEqual(ids(selectCast({ castIds, pinnedIds: ["missing"] })), castIds);
});

test("explicit cast rejects invalid size, unknown ids, duplicates and non-arrays", () => {
  for (const [castIds, message] of [
    [["npc1"], /exactly 5/], [["npc1", "npc2", "npc3", "npc4", "missing"], /unknown/],
    [["npc1", "npc2", "npc3", "npc4", "npc1"], /duplicate/], [null, /array/],
    [Array(5), /unknown/]
  ]) assert.throws(() => selectCast({ castIds }), { name: "TypeError", message });
  assert.throws(() => selectCast({ scenario: "village9", castIds: ids(CAST_ROSTER.slice(0, 5)) }), /exactly 9/);
});

test("pins reject unknown ids, duplicates, excessive size and non-arrays", () => {
  for (const [pinnedIds, message] of [
    [["missing"], /unknown/], [["npc1", "npc1"], /duplicate/],
    [ids(CAST_ROSTER.slice(0, 6)), /at most 5/], ["npc1", /array/]
  ]) assert.throws(() => selectCast({ pinnedIds }), { name: "TypeError", message });
});

test("seeded fill is reproducible, without replacement, and keeps pins first", () => {
  for (const scenario of ["default", "village9"]) {
    for (const pinnedIds of [[], ["npc12", "npc10"]]) {
      for (let seed = 0; seed < 20; seed++) {
        const selection = selectCast({ scenario, pinnedIds, rng: seeded(seed) });
        assert.deepEqual(selection, selectCast({ scenario, pinnedIds, rng: seeded(seed) }));
        assert.deepEqual(ids(selection).slice(0, pinnedIds.length), pinnedIds);
        assert.equal(selection.length, scenario === "village9" ? 9 : 5);
        assert.equal(new Set(ids(selection)).size, selection.length);
      }
    }
  }
  const full = ids(CAST_ROSTER.slice(0, 5)).reverse();
  assert.deepEqual(ids(selectCast({ pinnedIds: full, rng: () => { throw new Error("no draw needed"); } })), full);
  assert.equal(selectCast({ pinnedIds: [] }).length, 5);
});

test("default selection is roster order for both sizes and sample", () => {
  for (const scenario of [undefined, "default", "sample", "village9"]) {
    assert.deepEqual(selectCast({ scenario }), CAST_ROSTER.slice(0, scenario === "village9" ? 9 : 5));
  }
});

test("engine maps explicit village cast templates and fixed roles by slot", () => {
  const castIds = ["npc12", "npc10", "npc11", "npc9", "npc8", "npc7", "npc6", "npc5", "npc4"];
  const game = WerewolfGame.create({ scenario: "village9", castIds, shuffleRoles: false, seed: 9 });
  assert.deepEqual(ids(game.state.players), castIds);
  for (const player of game.state.players) {
    const member = castMemberById(player.id);
    for (const key of Object.keys(member)) assert.deepEqual(player[key], member[key]);
  }
  assert.deepEqual(game.state.players.map((p) => p.role),
    ["werewolf", "werewolf", "seer", "medium", "knight", "madman", "citizen", "citizen", "citizen"]);
});

test("engine default and pinned casts retain selection and seeded role reproducibility", () => {
  assert.deepEqual(WerewolfGame.create().state.players.map((p) => p.name), ["桐生一馬", "真島吾朗", "冴島大河", "堂島大吾", "春日一番"]);
  const options = { seed: 42, pinnedCastIds: ["npc12", "npc8"] };
  const first = WerewolfGame.create(options).state.players;
  const second = WerewolfGame.create(options).state.players;
  assert.deepEqual(ids(first).slice(0, 2), options.pinnedCastIds);
  assert.deepEqual(first.map((p) => [p.id, p.role]), second.map((p) => [p.id, p.role]));
  assert.equal(first.filter((p) => p.role === "werewolf").length, 1);
  assert.equal(first.filter((p) => p.role === "seer").length, 1);
});

test("sample keeps per-id roles even when its first five cast members are reordered", () => {
  const castIds = ids(CAST_ROSTER.slice(0, 5)).reverse();
  const game = WerewolfGame.create({ scenario: "sample", castIds, seed: 1 });
  assert.equal(game.getPlayer("npc1").role, "seer");
  assert.equal(game.getPlayer("npc3").role, "werewolf");
});

test("ask_npc passes voice and every participant's address without public snapshot changes", async () => {
  let request;
  const pseudo = new PseudoResponseProvider();
  const game = WerewolfGame.create({ scenario: "village9", shuffleRoles: false, seed: 9,
    responseProvider: { generateResponse: async (value) => { request = value; return pseudo.generateResponse(value); } } });
  game.getPlayer("npc8").alive = false;
  const result = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc5", input: "こんにちは" });
  assert.equal(result.ok, true);
  const speaker = game.getPlayer("npc5");
  assert.equal(request.npc.voiceProfile, speaker.voiceProfile);
  assert.equal(request.npc.callName, speaker.callName);
  assert.deepEqual(request.npc.addressForms, addressFormsFor(speaker, game.state.players));
  for (const player of game.state.players.filter((p) => p.id !== speaker.id)) {
    assert.equal(request.npc.addressForms[player.id], addressFormFor(speaker, player));
  }
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!["voiceProfile", "addressExceptions", "addressForms", "callName", "addressDefault", "addressNote"].includes(key));
      inspect(child);
    }
  };
  inspect(game.getPublicSnapshot());
});

test("legacy NPC utterance defaults are safe and decision requests omit voice materials", () => {
  const game = WerewolfGame.create({ seed: 1 });
  const npc = { ...game.state.players[0] };
  delete npc.voiceProfile;
  delete npc.callName;
  const { request } = buildNpcResponseRequest(npc, game.state, "こんにちは");
  assert.equal(request.npc.voiceProfile, null);
  assert.equal(request.npc.callName, npc.name);
  const decision = buildNpcDecisionRequest(npc, game.state, null, [], "test");
  assert.equal("voiceProfile" in decision.npc, false);
  assert.equal("addressForms" in decision.npc, false);
});

test("OpenAI model materials carry voice/address instructions and absent-field defaults", async () => {
  const game = WerewolfGame.create({ seed: 1 });
  const { request } = buildNpcResponseRequest(game.state.players[0], game.state, "こんにちは");
  let body;
  const provider = new OpenAIResponseProvider({ apiKey: "mock", maxRetries: 0, fallbackToPseudo: false,
    fetch: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "分かった。" }] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    } });
  await provider.generateResponse(request);
  const material = JSON.parse(body.input[0].content[0].text);
  for (const key of ["callName", "voiceProfile", "addressForms"]) assert.deepEqual(material.npc[key], request.npc[key]);
  assert.match(body.instructions, /addressForms/);
  assert.match(body.instructions, /voiceProfile/);
  const legacy = structuredClone(request);
  for (const key of ["callName", "voiceProfile", "addressForms"]) delete legacy.npc[key];
  await provider.generateResponse(legacy);
  const defaults = JSON.parse(body.input[0].content[0].text).npc;
  assert.equal(defaults.callName, null);
  assert.equal(defaults.voiceProfile, null);
  assert.deepEqual(defaults.addressForms, {});
});

test("name tiebreak order is the pinned ja-JP collation of the roster names", async () => {
  const { compareNames } = await import("../src/textUtils.mjs");
  // Regression guard: a bare localeCompare follows the runtime's default
  // locale (en-US on Linux, ja-JP on a Japanese Windows) and orders kanji
  // differently, which changed fabrication filler targets by platform.
  // compareNames pins "ja-JP" so this order holds everywhere.
  const sorted = [...CAST_ROSTER].sort((a, b) => compareNames(a.name, b.name)).map((c) => c.id);
  assert.deepEqual(sorted, ["npc10", "npc1", "npc12", "npc8", "npc3", "npc5", "npc2", "npc7", "npc4", "npc6", "npc11", "npc9"]);
});
