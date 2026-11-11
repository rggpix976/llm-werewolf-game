import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { buildGameLogExport, buildGameLogFilename } from "../public/logExport.mjs";

// village9 fixed roles: npc1/npc2 werewolf, npc3 seer, npc4 medium,
// npc5 knight, npc6 madman, npc7/npc8/npc9 citizen.
async function playedGame() {
  const game = WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false });
  for (const voter of game.getAlivePlayers()) {
    voter.suspicionScores = { npc7: 3 };
  }
  await game.dispatchPlayerAction({ type: "advance_vote" });
  await game.dispatchPlayerAction({ type: "run_night" });
  return game;
}

test("export with developer diagnostics contains the log, votes, roles and event log", async () => {
  const game = await playedGame();
  const text = buildGameLogExport({
    exportedAt: new Date("2026-11-11T12:00:00.000Z"),
    snapshot: game.getPublicSnapshot(),
    playerLogText: game.formatPlayerLog(),
    developerSnapshot: game.getDeveloperDiagnostics({ logCursor: 0 }).snapshot,
    developerLogText: game.formatDeveloperLog()
  });

  assert.match(text, /^LLM Werewolf — Game Log Export/);
  assert.match(text, /Winner: none/);
  assert.match(text, /== Player Log ==/);
  assert.match(text, /が処刑されました/);
  assert.match(text, /== Votes ==/);
  assert.match(text, /Day 1 \/ Executed: Gaku/);
  assert.match(text, /== Developer Snapshot ==/);
  assert.match(text, /Chika \(npc3\): role=seer/);
  assert.match(text, /Aoi \(npc1\): role=werewolf/);
  assert.match(text, /== Developer Event Log ==/);
  assert.match(text, /execution/);
});

test("export without developer diagnostics contains no hidden role information", async () => {
  const game = await playedGame();
  const text = buildGameLogExport({
    exportedAt: new Date("2026-11-11T12:00:00.000Z"),
    snapshot: game.getPublicSnapshot(),
    playerLogText: game.formatPlayerLog()
  });

  assert.match(text, /== Player Log ==/);
  assert.equal(text.includes("Developer Snapshot"), false);
  assert.equal(text.includes("Developer Event Log"), false);
  assert.equal(text.includes("role="), false);
  assert.equal(text.includes("knownInfo"), false);
  assert.equal(text.includes("suspicionScores"), false);
});

test("filename carries a sortable local timestamp", () => {
  const name = buildGameLogFilename(new Date(2026, 10, 11, 20, 55, 15));
  assert.equal(name, "werewolf-log-20261111-205515.txt");
});
