import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { ROLES, TEAMS, teamForRole } from "../src/constants.mjs";

function village9() {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false });
}

test("village9 has nine specified players and fixed roles without changing five-player scenarios", () => {
  const game = village9();
  assert.equal(game.state.players.length, 9);
  assert.deepEqual(game.state.players.map(({ id, role }) => [id, role]), [
    ["npc1", ROLES.WEREWOLF], ["npc2", ROLES.WEREWOLF], ["npc3", ROLES.SEER],
    ["npc4", ROLES.MEDIUM], ["npc5", ROLES.KNIGHT], ["npc6", ROLES.MADMAN],
    ["npc7", ROLES.CITIZEN], ["npc8", ROLES.CITIZEN], ["npc9", ROLES.CITIZEN]
  ]);
  assert.equal(WerewolfGame.create({ shuffleRoles: false }).state.players.length, 5);
  assert.equal(WerewolfGame.create({ scenario: "sample", shuffleRoles: false }).state.players.length, 5);
});

test("knight prevents an attack, cannot guard the same target twice, and remains private", async () => {
  const game = village9();
  const seer = game.getPlayer("npc3");
  game.state.publicInfo.push({ type: "public_claim", actorId: seer.id, claim: { role: ROLES.SEER } });
  const first = await game.runNight();
  assert.equal(game.getPlayer("npc5").privateMemory.at(-1).targetId, seer.id);
  assert.equal(first.attackResult.prevented, true);
  assert.equal(seer.alive, true);
  assert.equal(game.state.playerLog.some((entry) => /犠牲者はいません/.test(entry.message)), true);
  assert.doesNotMatch(JSON.stringify(game.getPublicSnapshot()), /knight_guard|knight_action/);

  const second = await game.runNight();
  assert.notEqual(game.getPlayer("npc5").privateMemory.at(-1).targetId, seer.id);
  assert.equal(seer.alive, false);
});

test("execution privately gives the living medium a result and direct questions claim it once", async () => {
  const game = village9();
  for (const voter of game.getAlivePlayers()) {
    if (voter.id !== "npc1") voter.suspicionScores.npc1 = 100;
  }
  const vote = game.runVote();
  assert.equal(vote.executedId, "npc1");
  const medium = game.getPlayer("npc4");
  const result = medium.knownInfo.find((info) => info.type === "medium_result");
  assert.deepEqual({ result: result.result, visibility: result.visibility, shareable: result.shareable }, { result: "werewolf", visibility: "private", shareable: false });
  assert.equal(medium.publicClaims.length, 0);

  const claim = await game.handlePlayerQuestion(medium.id, "あなたの役職は霊媒師ですか？ COしてください");
  assert.equal(claim.publicClaim.role, ROLES.MEDIUM);
  assert.match(claim.text, /霊媒師COします.*Aoiは人狼でした/);
  const duplicate = await game.handlePlayerQuestion(medium.id, "役職をCOしてください");
  assert.equal(duplicate.publicClaim, null);
  assert.equal(medium.publicClaims.length, 1);
});

test("madman reads not-werewolf and counts as human for both win conditions", () => {
  assert.equal(teamForRole(ROLES.MADMAN), TEAMS.VILLAGE);
  const game = village9();
  const seer = game.getPlayer("npc3");
  for (const player of game.state.players) seer.suspicionScores[player.id] = player.id === "npc6" ? 100 : 0;
  assert.deepEqual(game.runSeerAction(), { seerId: "npc3", targetId: "npc6", result: "not_werewolf" });

  game.killPlayer("npc1", "test");
  game.killPlayer("npc2", "test");
  assert.equal(game.checkWin("test"), TEAMS.VILLAGE);

  const parity = village9();
  for (const id of ["npc2", "npc3", "npc4", "npc5", "npc7", "npc8", "npc9"]) parity.killPlayer(id, "test");
  assert.equal(parity.getPlayer("npc6").alive, true);
  assert.equal(parity.checkWin("test"), TEAMS.WEREWOLF);
});

test("village9 progresses through night, vote, execution, and win check", async () => {
  const game = village9();
  await assert.doesNotReject(() => game.runNight());
  assert.doesNotThrow(() => game.runVote());
  assert.ok(game.state.voteHistory.at(-1).executedId);
  assert.ok(game.state.developerLog.some((entry) => entry.kind === "win_check"));
});
