import assert from "node:assert/strict";
import test from "node:test";

import { ROLES, TEAMS } from "../src/constants.mjs";
import { WerewolfGame } from "../src/gameEngine.mjs";

function createSampleGame() {
  return WerewolfGame.create({
    seed: 20260613,
    scenario: "sample",
    shuffleRoles: false
  });
}

function collectObjectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjectKeys(item, keys);
    }
    return keys;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectObjectKeys(child, keys);
    }
  }

  return keys;
}

test("initializes a five-player village with the expected role counts", () => {
  const game = createSampleGame();
  const roleCounts = game.state.players.reduce((counts, player) => {
    counts[player.role] = (counts[player.role] ?? 0) + 1;
    return counts;
  }, {});

  assert.equal(game.state.players.length, 5);
  assert.equal(roleCounts[ROLES.WEREWOLF], 1);
  assert.equal(roleCounts[ROLES.SEER], 1);
  assert.equal(roleCounts[ROLES.CITIZEN], 3);
  assert.equal(game.state.alivePlayers.length, 5);
  assert.deepEqual(game.state.deadPlayers, []);
  assert.equal(game.state.winner, null);
});

test("dispatchPlayerAction returns a public snapshot and incremental player logs", async () => {
  const game = createSampleGame();
  const logCursor = game.state.playerLog.length;

  const action = await game.dispatchPlayerAction({
    type: "ask_npc",
    target: "npc2",
    input: "What do you think?",
    logCursor
  });

  assert.equal(action.ok, true);
  assert.equal(action.actionType, "ask_npc");
  assert.equal(action.result.responded, true);
  assert.equal(action.playerLogEntries.length, 2);
  assert.equal(action.nextLogCursor, logCursor + 2);
  assert.equal(action.publicSnapshot.phase, "npc_response");
  assert.equal(action.publicSnapshot.playerLog.length, action.nextLogCursor);
});

test("public snapshots do not expose private player state", () => {
  const game = createSampleGame();
  const snapshot = game.getPublicSnapshot();
  const keys = collectObjectKeys(snapshot);
  const forbiddenKeys = [
    "role",
    "team",
    "knownInfo",
    "hiddenInfo",
    "suspicionScores",
    "privateMemory",
    "conversationPolicy",
    "reasonDeveloper",
    "developerLog"
  ];

  for (const key of forbiddenKeys) {
    assert.equal(keys.has(key), false, `public snapshot exposed ${key}`);
  }
});

test("accusatory player questions raise living NPC suspicion for mentioned targets", async () => {
  const game = createSampleGame();
  const targetId = "npc3";
  const initialScores = Object.fromEntries(
    game.state.players.map((player) => [player.id, player.suspicionScores[targetId]])
  );

  await game.dispatchPlayerAction({
    type: "ask_npc",
    target: "npc2",
    input: "What do you think about Chika?"
  });

  for (const player of game.state.players) {
    assert.equal(player.suspicionScores[targetId], initialScores[player.id]);
  }

  game.killPlayer("npc5", "test");
  const beforeAccusation = Object.fromEntries(
    game.state.players.map((player) => [player.id, player.suspicionScores[targetId]])
  );

  await game.dispatchPlayerAction({
    type: "ask_npc",
    target: "npc2",
    input: "I suspect Chika is a werewolf"
  });

  for (const player of game.state.players) {
    if (player.id === targetId || player.id === "npc5") {
      assert.equal(player.suspicionScores[targetId], beforeAccusation[player.id]);
    } else {
      assert.equal(player.suspicionScores[targetId], beforeAccusation[player.id] + 1);
    }
  }
  assert.equal(Object.hasOwn(game.getPlayer(targetId).suspicionScores, targetId), false);
  assert.equal(
    game.state.developerLog.some((entry) => entry.kind === "question_pressure_applied"),
    true
  );
});

test("living NPCs respond while dead NPCs are blocked", async () => {
  const game = createSampleGame();
  const livingResponse = await game.dispatchPlayerAction({
    type: "ask_npc",
    target: "npc2",
    input: "Are you alive?"
  });

  assert.equal(livingResponse.result.responded, true);

  const vote = await game.dispatchPlayerAction({ type: "advance_vote" });
  const executedId = vote.result.executedId;
  const responseLogCount = game.state.developerLog.filter(
    (entry) => entry.kind === "npc_response_generated" && entry.detail.npcId === executedId
  ).length;

  const deadResponse = await game.dispatchPlayerAction({
    type: "ask_npc",
    target: executedId,
    input: "Can you still speak?"
  });

  assert.deepEqual(deadResponse.result, {
    responded: false,
    reason: "dead_npc"
  });
  assert.equal(
    game.state.developerLog.filter(
      (entry) => entry.kind === "npc_response_generated" && entry.detail.npcId === executedId
    ).length,
    responseLogCount
  );
  assert.equal(
    game.state.developerLog.some(
      (entry) => entry.kind === "dead_npc_blocked" && entry.detail.targetId === executedId
    ),
    true
  );
});

test("werewolf identity questions are denied and response evidence is logged", async () => {
  const game = createSampleGame();
  const action = await game.dispatchPlayerAction({
    type: "ask_npc",
    target: "npc3",
    input: "Are you a werewolf?"
  });
  const responseLog = game.state.developerLog.find(
    (entry) => entry.kind === "npc_response_generated" && entry.detail.npcId === "npc3"
  );

  assert.equal(action.result.responded, true);
  assert.equal(action.result.disclosedHiddenInfo, false);
  assert.equal(
    action.result.evidenceUsed.includes("conversationPolicy: werewolf denies identity and redirects"),
    true
  );
  assert.ok(responseLog);
  assert.deepEqual(responseLog.detail.evidenceUsed, action.result.evidenceUsed);
  assert.match(responseLog.detail.promptPreview, /never confess/i);
});

test("an injected async response provider supplies only the NPC utterance", async () => {
  let receivedRequest;
  const responseProvider = {
    name: "test-provider",
    async generateResponse(request) {
      receivedRequest = request;
      return {
        text: "Custom provider response",
        providerName: "test-provider",
        model: "test-model",
        usage: { inputTokens: 12, outputTokens: 3 },
        notes: ["test"]
      };
    }
  };
  const game = WerewolfGame.create({
    seed: 20260613,
    scenario: "sample",
    shuffleRoles: false,
    responseProvider
  });

  const action = await game.dispatchPlayerAction({
    type: "ask_npc",
    target: "npc2",
    input: "Question for the provider"
  });

  assert.equal(action.result.text, "Custom provider response");
  assert.equal(action.result.provider.providerName, "test-provider");
  assert.equal(action.result.provider.model, "test-model");
  assert.deepEqual(action.result.provider.usage, {
    inputTokens: 12,
    outputTokens: 3
  });
  assert.ok(receivedRequest);
  assert.equal(Object.isFrozen(receivedRequest), true);
  assert.equal(Object.isFrozen(receivedRequest.npc), true);
  assert.equal("state" in receivedRequest, false);
  assert.equal("gameState" in receivedRequest, false);
  assert.equal("players" in receivedRequest, false);
  assert.equal(receivedRequest.npc.id, "npc2");
  assert.equal(receivedRequest.playerInput, "Question for the provider");
});

test("provider output cannot directly mutate game state or register claims", async () => {
  const responseProvider = {
    name: "untrusted-provider",
    async generateResponse() {
      return {
        text: "Harmless visible text",
        providerName: "untrusted-provider",
        role: ROLES.WEREWOLF,
        alive: false,
        winner: TEAMS.WEREWOLF,
        publicClaim: {
          role: ROLES.SEER,
          results: [{ targetId: "npc3", result: "werewolf" }]
        }
      };
    }
  };
  const game = WerewolfGame.create({
    seed: 20260613,
    scenario: "sample",
    shuffleRoles: false,
    responseProvider
  });
  const npc = game.getPlayer("npc2");
  const originalRole = npc.role;

  const action = await game.dispatchPlayerAction({
    type: "ask_npc",
    target: npc.id,
    input: "Tell me something"
  });

  assert.equal(action.result.responded, true);
  assert.equal(action.result.publicClaim, null);
  assert.equal(npc.role, originalRole);
  assert.equal(npc.alive, true);
  assert.equal(game.state.winner, null);
  assert.deepEqual(npc.publicClaims, []);
  assert.equal(
    game.state.publicInfo.some((info) => info.type === "public_claim"),
    false
  );
});

for (const providerFailure of [
  {
    name: "throws",
    generateResponse: async () => {
      throw new Error("provider unavailable");
    }
  },
  {
    name: "empty",
    generateResponse: async () => ({ text: "   " })
  },
  {
    name: "invalid",
    generateResponse: async () => "not an object"
  }
]) {
  test(`provider failure '${providerFailure.name}' cancels only the response`, async () => {
    const game = WerewolfGame.create({
      seed: 20260613,
      scenario: "sample",
      shuffleRoles: false,
      responseProvider: providerFailure
    });
    const npc = game.getPlayer("npc1");
    const memoryCount = npc.privateMemory.length;
    const claimCount = npc.publicClaims.length;

    const action = await game.dispatchPlayerAction({
      type: "ask_npc",
      target: npc.id,
      input: "Please answer"
    });

    // Utterance Guard wrapped provider will THROW for empty/invalid responses
    // from underlying providers because validateProviderResponse is called
    // within GuardedResponseProvider.generateResponse.
    assert.deepEqual(action.result, {
      responded: false,
      reason: "response_provider_error"
    });
    assert.equal(npc.privateMemory.length, memoryCount);
    assert.equal(
      game.state.developerLog.some(
        (entry) => entry.kind === "npc_response_provider_error"
          && (entry.detail.providerName === providerFailure.name || entry.detail.providerName === "unknown")
      ),
      true
    );
    assert.equal(game.state.phase, "day_discussion");

    assert.equal(npc.publicClaims.length, claimCount);

    const vote = await game.dispatchPlayerAction({ type: "advance_vote" });
    assert.ok(vote.result.executedId);
  });
}

test("votes target living opponents and execution updates life state", async () => {
  const game = createSampleGame();
  const aliveBeforeVote = new Set(game.state.alivePlayers);
  const action = await game.dispatchPlayerAction({ type: "advance_vote" });
  const { votes, executedId } = action.result;

  assert.equal(votes.length, aliveBeforeVote.size);
  for (const vote of votes) {
    assert.equal(aliveBeforeVote.has(vote.voterId), true);
    assert.equal(aliveBeforeVote.has(vote.targetId), true);
    assert.notEqual(vote.voterId, vote.targetId);
  }

  assert.equal(game.getPlayer(executedId).alive, false);
  assert.equal(game.state.alivePlayers.includes(executedId), false);
  assert.equal(game.state.deadPlayers.includes(executedId), true);
  assert.equal(game.state.voteHistory.at(-1).executedId, executedId);
});

test("seer results remain private until the seer explicitly claims", async () => {
  const game = createSampleGame();

  await game.dispatchPlayerAction({ type: "advance_vote" });
  const night = await game.dispatchPlayerAction({ type: "run_night" });
  const seer = game.state.players.find((player) => player.role === ROLES.SEER);
  const privateResult = seer.knownInfo.find((info) => info.type === "seer_result");

  assert.ok(night.result.seerResult);
  assert.ok(privateResult);
  assert.equal(privateResult.visibility, "private");
  assert.equal(privateResult.shareable, false);
  assert.equal(
    game.state.publicInfo.some(
      (info) => info.type === "seer_action" || info.type === "public_claim"
    ),
    false
  );

  const claim = await game.dispatchPlayerAction({
    type: "ask_npc",
    target: seer.id,
    input: "占い師ならCOしてください"
  });

  assert.equal(claim.result.responded, true);
  assert.equal(claim.result.publicClaim?.role, ROLES.SEER);
  assert.equal(seer.publicClaims.length, 1);
  assert.equal(
    game.state.publicInfo.some(
      (info) => info.type === "public_claim" && info.actorId === seer.id
    ),
    true
  );
});

test("werewolf attacks only a living non-werewolf target", async () => {
  const game = createSampleGame();

  await game.dispatchPlayerAction({ type: "advance_vote" });
  const aliveBeforeNight = new Set(game.state.alivePlayers);
  const werewolf = game.state.players.find((player) => player.role === ROLES.WEREWOLF);
  const night = await game.dispatchPlayerAction({ type: "run_night" });
  const attack = night.result.attackResult;

  assert.ok(attack);
  assert.equal(attack.werewolfId, werewolf.id);
  assert.notEqual(attack.targetId, werewolf.id);
  assert.equal(aliveBeforeNight.has(attack.targetId), true);
  assert.equal(game.getPlayer(attack.targetId).alive, false);
  assert.equal(game.state.deadPlayers.includes(attack.targetId), true);
});

test("win checks recognize village and werewolf victories", () => {
  const villageGame = createSampleGame();
  villageGame.killPlayer("npc3", "test");

  assert.equal(villageGame.checkWin("test"), TEAMS.VILLAGE);
  assert.equal(villageGame.state.winner, TEAMS.VILLAGE);

  const werewolfGame = createSampleGame();
  werewolfGame.killPlayer("npc1", "test");
  werewolfGame.killPlayer("npc2", "test");
  werewolfGame.killPlayer("npc4", "test");

  assert.equal(werewolfGame.checkWin("test"), TEAMS.WEREWOLF);
  assert.equal(werewolfGame.state.winner, TEAMS.WEREWOLF);
});

test("finished games reject further vote and night progression", async () => {
  const game = createSampleGame();
  game.killPlayer("npc3", "test");
  game.checkWin("test");

  const stateBefore = {
    day: game.state.day,
    phase: game.state.phase,
    alivePlayers: [...game.state.alivePlayers],
    deadPlayers: [...game.state.deadPlayers],
    voteRounds: game.state.voteHistory.length,
    playerLogs: game.state.playerLog.length
  };

  const vote = await game.dispatchPlayerAction({ type: "advance_vote" });
  const night = await game.dispatchPlayerAction({ type: "run_night" });

  assert.equal(vote.result, null);
  assert.deepEqual(night.result, {
    skipped: true,
    reason: "game_already_finished"
  });
  assert.deepEqual(
    {
      day: game.state.day,
      phase: game.state.phase,
      alivePlayers: game.state.alivePlayers,
      deadPlayers: game.state.deadPlayers,
      voteRounds: game.state.voteHistory.length,
      playerLogs: game.state.playerLog.length
    },
    stateBefore
  );
});

test("getDeveloperDiagnostics returns a structured, read-only clone of the state and logs", async () => {
  const game = createSampleGame();
  const initialLogCount = game.state.developerLog.length;

  const diagnostics = game.getDeveloperDiagnostics();
  assert.ok(diagnostics.snapshot);
  assert.ok(Array.isArray(diagnostics.developerLogEntries));
  assert.equal(diagnostics.developerLogEntries.length, initialLogCount);
  assert.equal(diagnostics.nextLogCursor, initialLogCount);

  // Read-only check: snapshot
  diagnostics.snapshot.day = 999;
  assert.equal(game.state.day, 1);

  // Read-only check: nested player state
  diagnostics.snapshot.players[0].role = "MUTATED";
  assert.notEqual(game.state.players[0].role, "MUTATED");

  // Read-only check: log entries
  diagnostics.developerLogEntries[0].kind = "MUTATED";
  assert.notEqual(game.state.developerLog[0].kind, "MUTATED");

  // Incremental fetch check
  await game.dispatchPlayerAction({
    type: "ask_npc",
    target: "npc2",
    input: "Hello"
  });

  const incremental = game.getDeveloperDiagnostics({ logCursor: diagnostics.nextLogCursor });
  assert.equal(incremental.developerLogEntries.length > 0, true);
  assert.equal(incremental.nextLogCursor > diagnostics.nextLogCursor, true);
  assert.equal(incremental.developerLogEntries[0].kind, "phase_change");
});

test("getDeveloperDiagnostics clamps out-of-range cursors", () => {
  const game = createSampleGame();
  const total = game.state.developerLog.length;

  const negative = game.getDeveloperDiagnostics({ logCursor: -1 });
  assert.equal(negative.developerLogEntries.length, total);

  const overflow = game.getDeveloperDiagnostics({ logCursor: total + 100 });
  assert.equal(overflow.developerLogEntries.length, 0);
  assert.equal(overflow.nextLogCursor, total);
});

test("developer diagnostics return deep read-only clones of nested objects", () => {
  const game = createSampleGame();
  const diagnostics = game.getDeveloperDiagnostics();
  const player = diagnostics.snapshot.players[0];

  // knownInfo
  player.knownInfo.push({ day: 99, text: "CLONE_TEST" });
  assert.equal(game.state.players[0].knownInfo.some(i => i.text === "CLONE_TEST"), false);

  // suspicionScores
  player.suspicionScores.npc2 = 999;
  assert.notEqual(game.state.players[0].suspicionScores.npc2, 999);

  // conversationPolicy
  player.conversationPolicy.forbidden.push("CLONE_TEST");
  assert.equal(game.state.players[0].conversationPolicy.forbidden.includes("CLONE_TEST"), false);

  // nested developer log data
  const entry = diagnostics.developerLogEntries[0];
  entry.detail.roles[0].id = "CLONE_TEST";
  assert.notEqual(game.state.developerLog[0].detail.roles[0].id, "CLONE_TEST");
});

test("developer log contains promptPreview, evidenceUsed, and provider metadata", async () => {
  const responseProvider = {
    name: "test-provider",
    async generateResponse() {
      return {
        text: "Response text",
        providerName: "test-provider",
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        notes: ["note1"]
      };
    }
  };
  const game = WerewolfGame.create({ responseProvider });

  await game.dispatchPlayerAction({
    type: "ask_npc",
    target: "npc1",
    input: "Tell me your role"
  });

  const log = game.state.developerLog.find(e => e.kind === "npc_response_generated");
  assert.ok(log);
  assert.ok(log.detail.promptPreview);
  assert.ok(Array.isArray(log.detail.evidenceUsed));
  assert.equal(log.detail.provider.providerName, "test-provider");
  assert.equal(log.detail.provider.model, "test-model");
  assert.deepEqual(log.detail.provider.usage, { inputTokens: 10, outputTokens: 5 });
});

test("provider failure log contains error details and evidence", async () => {
  const game = WerewolfGame.create({
    responseProvider: {
      name: "failing-provider",
      generateResponse: () => { throw new Error("intentional failure"); }
    }
  });

  await game.dispatchPlayerAction({
    type: "ask_npc",
    target: "npc1",
    input: "Fail now"
  });

  const log = game.state.developerLog.find(e => e.kind === "npc_response_provider_error");
  assert.ok(log);
  assert.equal(log.detail.providerName, "failing-provider");
  assert.equal(log.detail.errorType, "Error");
  assert.equal(log.detail.message, "intentional failure");
  assert.ok(log.detail.promptPreview);
  assert.ok(Array.isArray(log.detail.evidenceUsed));
});

test("public snapshot continues to hide sensitive information after changes", () => {
  const game = createSampleGame();
  const snapshot = game.getPublicSnapshot();

  const sensitiveKeys = [
    "role", "team", "knownInfo", "hiddenInfo",
    "suspicionScores", "privateMemory", "conversationPolicy",
    "developerLog", "developerLogEntries", "snapshot"
  ];

  function check(obj) {
    if (!obj || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      assert.equal(sensitiveKeys.includes(key), false, `Sensitive key '${key}' leaked in public snapshot`);
      check(obj[key]);
    }
  }

  check(snapshot);
});

test("getDeveloperDiagnostics has no side effects on game state", () => {
  const game = createSampleGame();
  const stateBefore = JSON.stringify(game.state);

  game.getDeveloperDiagnostics();
  game.getDeveloperDiagnostics({ logCursor: 5 });

  assert.equal(JSON.stringify(game.state), stateBefore);
});

test("developer log correctly maps NPCs for various log kinds", async () => {
  const game = createSampleGame();

  // npc_response_generated (npcId)
  await game.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "Hi" });

  // vote_resolved (votes[].voterId, votes[].targetId, executedId)
  await game.dispatchPlayerAction({ type: "advance_vote" });

  // seer_action (seerId, targetId)
  // werewolf_attack (werewolfId, targetId)
  await game.dispatchPlayerAction({ type: "run_night" });

  const logs = game.state.developerLog;

  // Aoi (npc1) should be found in: initial_roles, initial_player_states, npc_response_generated, vote_resolved, seer_action
  const aoiLogs = logs.filter(e => {
    const d = e.detail || {};
    if (d.npcId === "npc1") return true;
    if (d.actorId === "npc1") return true;
    if (d.seerId === "npc1") return true;
    if (d.werewolfId === "npc1") return true;
    if (d.executedId === "npc1") return true;
    if (Array.isArray(d.roles) && d.roles.some(p => p.id === "npc1")) return true;
    if (Array.isArray(d.players) && d.players.some(p => p.id === "npc1")) return true;
    if (Array.isArray(d.votes) && d.votes.some(v => v.voterId === "npc1" || v.targetId === "npc1")) return true;
    return false;
  });

  assert.ok(aoiLogs.length >= 5);
  assert.ok(aoiLogs.some(e => e.kind === "npc_response_generated"));
  assert.ok(aoiLogs.some(e => e.kind === "vote_resolved"));
  assert.ok(aoiLogs.some(e => e.kind === "seer_action"));
});
