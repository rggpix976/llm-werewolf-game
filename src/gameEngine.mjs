import { generateNpcResponse } from "./responseGenerator.mjs";
import { PHASES, ROLES, TEAMS, publicRoleName, publicTeamName, teamForRole } from "./constants.mjs";
import { SeededRandom } from "./seededRandom.mjs";
import { containsAny, extractMentionedPlayerIds } from "./textUtils.mjs";

const DEFAULT_PLAYERS = [
  {
    id: "npc1",
    name: "Aoi",
    aliases: ["A", "青井", "アオイ"],
    personality: "冷静で観察好き",
    speechStyle: "calm"
  },
  {
    id: "npc2",
    name: "Beni",
    aliases: ["B", "紅", "ベニ"],
    personality: "素直でやや不安がり",
    speechStyle: "soft"
  },
  {
    id: "npc3",
    name: "Chika",
    aliases: ["C", "千佳", "チカ"],
    personality: "押しが強く話題転換がうまい",
    speechStyle: "direct"
  },
  {
    id: "npc4",
    name: "Daichi",
    aliases: ["D", "大地", "ダイチ"],
    personality: "慎重で投票理由にこだわる",
    speechStyle: "cautious"
  },
  {
    id: "npc5",
    name: "Ema",
    aliases: ["E", "絵真", "エマ"],
    personality: "論理重視で発言を整理する",
    speechStyle: "logical"
  }
];

const SAMPLE_ROLE_BY_ID = {
  npc1: ROLES.SEER,
  npc2: ROLES.CITIZEN,
  npc3: ROLES.WEREWOLF,
  npc4: ROLES.CITIZEN,
  npc5: ROLES.CITIZEN
};

const SAMPLE_SUSPICION = {
  npc1: { npc2: 0, npc3: 1, npc4: 3, npc5: 1 },
  npc2: { npc1: 0, npc3: 1, npc4: 2, npc5: 0 },
  npc3: { npc1: 1, npc2: 0, npc4: 4, npc5: 2 },
  npc4: { npc1: 0, npc2: 1, npc3: 2, npc5: 0 },
  npc5: { npc1: 0, npc2: 0, npc3: 3, npc4: 2 }
};

export class WerewolfGame {
  static create(options = {}) {
    const rng = new SeededRandom(options.seed ?? Date.now());
    const roles = assignRoles({ rng, shuffleRoles: options.shuffleRoles ?? true, scenario: options.scenario });
    const players = DEFAULT_PLAYERS.map((template) => {
      const role = roles[template.id];
      return createPlayerState(template, role);
    });

    initializeSuspicion(players, rng, options.scenario);

    const state = {
      day: 1,
      phase: "day_discussion",
      players,
      alivePlayers: players.map((player) => player.id),
      deadPlayers: [],
      publicInfo: [],
      voteHistory: [],
      winner: null,
      playerLog: [],
      developerLog: [],
      rng,
      config: {
        seed: options.seed ?? null,
        scenario: options.scenario ?? "default"
      }
    };

    const game = new WerewolfGame(state);
    game.addPublicInfo({
      type: "setup",
      text: "公開情報: 5人村。内訳は人狼1、占い師1、市民3。役職欠けなし。"
    });
    game.addPlayerLog("1日目の昼。5人のNPCが議論を始めました。");
    game.addDeveloperLog("initial_roles", {
      roles: players.map((player) => ({
        id: player.id,
        name: player.name,
        role: player.role,
        team: player.team
      }))
    });
    game.addDeveloperLog("initial_player_states", game.createDeveloperSnapshot());
    return game;
  }

  constructor(state) {
    this.state = state;
  }

  getPlayer(idOrName) {
    const normalized = String(idOrName).toLowerCase();
    return this.state.players.find((player) => {
      const labels = [player.id, player.name, ...(player.aliases ?? [])].map((label) => String(label).toLowerCase());
      return labels.includes(normalized);
    });
  }

  getAlivePlayers() {
    return this.state.alivePlayers.map((id) => this.getPlayer(id));
  }

  getDeadPlayers() {
    return this.state.deadPlayers.map((id) => this.getPlayer(id));
  }

  setPhase(phase) {
    if (!PHASES.includes(phase)) {
      throw new Error(`Unknown phase: ${phase}`);
    }
    this.state.phase = phase;
    this.addDeveloperLog("phase_change", { day: this.state.day, phase });
  }

  addPlayerLog(message) {
    this.state.playerLog.push({
      day: this.state.day,
      phase: this.state.phase,
      message
    });
  }

  addDeveloperLog(kind, detail) {
    this.state.developerLog.push({
      day: this.state.day,
      phase: this.state.phase,
      kind,
      detail
    });
  }

  addPublicInfo(info) {
    this.state.publicInfo.push({
      day: this.state.day,
      phase: this.state.phase,
      ...info
    });
  }

  handlePlayerQuestion(targetIdOrName, playerInput) {
    if (this.state.winner) {
      return {
        responded: false,
        reason: "game_already_finished"
      };
    }

    const npc = this.getPlayer(targetIdOrName);
    if (!npc) {
      throw new Error(`Unknown NPC: ${targetIdOrName}`);
    }

    this.setPhase("player_question");
    const questionText = String(playerInput ?? "").trim();
    this.addPlayerLog(`あなた -> ${npc.name}: ${questionText}`);
    this.addPublicInfo({
      type: "player_question",
      actorId: "player",
      targetId: npc.id,
      text: `プレイヤーが${npc.name}に質問: ${questionText}`
    });
    this.applyQuestionPressure(questionText);

    this.setPhase("npc_response");
    if (!npc.alive) {
      this.addPlayerLog(`${npc.name}は死亡しているため、返答しません。`);
      this.addDeveloperLog("dead_npc_blocked", {
        targetId: npc.id,
        targetName: npc.name,
        playerInput: questionText
      });
      return {
        responded: false,
        reason: "dead_npc"
      };
    }

    const result = generateNpcResponse(npc, this.state, questionText);
    this.addPlayerLog(`${npc.name}: ${result.text}`);
    this.addPublicInfo({
      type: "npc_response",
      actorId: npc.id,
      actorName: npc.name,
      text: `${npc.name}: ${result.text}`
    });
    npc.privateMemory.push({
      day: this.state.day,
      type: "conversation",
      playerInput: questionText,
      response: result.text
    });

    if (result.publicClaim) {
      npc.publicClaims.push(result.publicClaim);
      this.addPublicInfo({
        type: "public_claim",
        actorId: npc.id,
        actorName: npc.name,
        text: `${npc.name}が${publicRoleName(result.publicClaim.role)}COをした。`,
        claim: result.publicClaim
      });
      this.addDeveloperLog("public_claim_registered", result.publicClaim);
    }

    this.addDeveloperLog("npc_response_generated", {
      npcId: npc.id,
      npcName: npc.name,
      playerInput: questionText,
      response: result.text,
      evidenceUsed: result.evidenceUsed,
      disclosedHiddenInfo: result.disclosedHiddenInfo,
      promptPreview: result.promptPreview
    });

    return result;
  }

  applyQuestionPressure(questionText) {
    const mentionedIds = extractMentionedPlayerIds(questionText, this.state.players);
    if (!mentionedIds.length) {
      return;
    }

    const isAccusatory = containsAny(questionText, ["怪しい", "疑", "人狼", "矛盾", "おかしい", "黒"]);
    if (!isAccusatory) {
      return;
    }

    for (const npc of this.getAlivePlayers()) {
      for (const mentionedId of mentionedIds) {
        if (mentionedId === npc.id) {
          continue;
        }
        npc.suspicionScores[mentionedId] = (npc.suspicionScores[mentionedId] ?? 0) + 1;
      }
    }

    this.addDeveloperLog("question_pressure_applied", {
      questionText,
      mentionedIds,
      effect: "alive NPC suspicion +1 for mentioned targets"
    });
  }

  runVote() {
    if (this.state.winner) {
      return null;
    }

    this.setPhase("vote");
    const votes = this.getAlivePlayers().map((voter) => this.chooseVote(voter));
    for (const vote of votes) {
      const voter = this.getPlayer(vote.voterId);
      voter.voteHistory.push({
        day: this.state.day,
        targetId: vote.targetId,
        reasonPublic: vote.reasonPublic,
        reasonDeveloper: vote.reasonDeveloper
      });
    }

    const result = this.resolveVote(votes);
    this.state.voteHistory.push({
      day: this.state.day,
      votes,
      executedId: result.executedId,
      tie: result.tie
    });

    const voteSummary = votes.map((vote) => {
      const voter = this.getPlayer(vote.voterId);
      const target = this.getPlayer(vote.targetId);
      return `${voter.name}->${target.name}`;
    }).join("、");

    this.addPlayerLog(`投票結果: ${voteSummary}`);
    this.addPublicInfo({
      type: "vote_result",
      text: `投票結果: ${voteSummary}`,
      votes: votes.map(({ voterId, targetId }) => ({ voterId, targetId }))
    });
    this.addDeveloperLog("vote_resolved", {
      votes,
      counts: result.counts,
      tie: result.tie,
      executedId: result.executedId,
      executedName: this.getPlayer(result.executedId).name
    });

    this.setPhase("execution");
    this.killPlayer(result.executedId, "execution");
    const executed = this.getPlayer(result.executedId);
    this.addPlayerLog(`${executed.name}が処刑されました。`);
    this.addPublicInfo({
      type: "execution",
      targetId: executed.id,
      targetName: executed.name,
      text: `${executed.name}が処刑された。`
    });
    this.addDeveloperLog("execution", {
      executedId: executed.id,
      executedName: executed.name,
      role: executed.role,
      team: executed.team
    });

    this.setPhase("win_check");
    this.checkWin("after_execution");
    return {
      votes,
      executedId: result.executedId,
      winner: this.state.winner
    };
  }

  chooseVote(voter) {
    const candidates = this.getAlivePlayers().filter((candidate) => candidate.id !== voter.id);
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        score: voter.suspicionScores[candidate.id] ?? 0
      }))
      .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name));

    const chosen = ranked[0].candidate;
    const privateReason = findPrivateVoteReason(voter, chosen);
    const reasonDeveloper = privateReason
      ? `${privateReason}; suspicionScore=${ranked[0].score}`
      : `highest suspicionScore=${ranked[0].score}`;

    return {
      voterId: voter.id,
      voterName: voter.name,
      targetId: chosen.id,
      targetName: chosen.name,
      reasonPublic: "最も疑いが強い相手に投票",
      reasonDeveloper
    };
  }

  resolveVote(votes) {
    const counts = {};
    for (const vote of votes) {
      counts[vote.targetId] = (counts[vote.targetId] ?? 0) + 1;
    }

    const maxVotes = Math.max(...Object.values(counts));
    const tiedIds = Object.entries(counts)
      .filter(([, count]) => count === maxVotes)
      .map(([id]) => id);

    if (tiedIds.length === 1) {
      return {
        executedId: tiedIds[0],
        counts,
        tie: false
      };
    }

    const aggregateSuspicion = tiedIds.map((id) => {
      const total = this.getAlivePlayers().reduce((sum, voter) => {
        if (voter.id === id) {
          return sum;
        }
        return sum + (voter.suspicionScores[id] ?? 0);
      }, 0);
      return { id, total };
    }).sort((a, b) => b.total - a.total || this.getPlayer(a.id).name.localeCompare(this.getPlayer(b.id).name));

    return {
      executedId: aggregateSuspicion[0].id,
      counts,
      tie: true,
      tieBreak: "aggregate_suspicion"
    };
  }

  runNight() {
    if (this.state.winner) {
      return {
        skipped: true,
        reason: "game_already_finished"
      };
    }

    this.setPhase("night");
    this.addPlayerLog("夜になりました。");

    this.setPhase("seer_action");
    const seerResult = this.runSeerAction();

    this.setPhase("werewolf_attack");
    const attackResult = this.runWerewolfAttack();

    this.setPhase("win_check");
    this.checkWin("after_werewolf_attack");

    if (!this.state.winner) {
      this.state.day += 1;
      this.setPhase("day_discussion");
      this.addPlayerLog(`${this.state.day}日目の昼。議論を再開します。`);
      this.addPublicInfo({
        type: "day_start",
        text: `${this.state.day}日目の昼が始まった。`
      });
    }

    return {
      seerResult,
      attackResult,
      winner: this.state.winner
    };
  }

  runSeerAction() {
    const seer = this.state.players.find((player) => player.role === ROLES.SEER && player.alive);
    if (!seer) {
      this.addDeveloperLog("seer_action", {
        skipped: true,
        reason: "seer_dead_or_missing"
      });
      return null;
    }

    const alreadyChecked = new Set(
      seer.knownInfo
        .filter((info) => info.type === "seer_result")
        .map((info) => info.targetId)
    );
    const candidates = this.getAlivePlayers()
      .filter((player) => player.id !== seer.id)
      .filter((player) => !alreadyChecked.has(player.id));

    if (!candidates.length) {
      this.addDeveloperLog("seer_action", {
        skipped: true,
        reason: "no_valid_target"
      });
      return null;
    }

    const target = candidates
      .map((candidate) => ({
        candidate,
        score: seer.suspicionScores[candidate.id] ?? 0
      }))
      .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name))[0].candidate;

    const result = target.role === ROLES.WEREWOLF ? "werewolf" : "not_werewolf";
    seer.knownInfo.push({
      day: this.state.day,
      type: "seer_result",
      visibility: "private",
      shareable: false,
      targetId: target.id,
      targetName: target.name,
      result,
      text: `占い結果: ${target.name}は${result === "werewolf" ? "人狼" : "人狼ではない"}。`
    });
    seer.privateMemory.push({
      day: this.state.day,
      type: "seer_action",
      targetId: target.id,
      result
    });
    seer.suspicionScores[target.id] = result === "werewolf" ? 8 : -2;

    this.addDeveloperLog("seer_action", {
      seerId: seer.id,
      seerName: seer.name,
      targetId: target.id,
      targetName: target.name,
      result,
      publicInfoAdded: false,
      savedTo: "seer.knownInfo"
    });

    return {
      seerId: seer.id,
      targetId: target.id,
      result
    };
  }

  runWerewolfAttack() {
    const werewolves = this.state.players.filter((player) => player.role === ROLES.WEREWOLF && player.alive);
    if (!werewolves.length) {
      this.addDeveloperLog("werewolf_attack", {
        skipped: true,
        reason: "no_alive_werewolf"
      });
      return null;
    }

    const werewolf = werewolves[0];
    const candidates = this.getAlivePlayers().filter((player) => player.id !== werewolf.id);
    if (!candidates.length) {
      this.addDeveloperLog("werewolf_attack", {
        skipped: true,
        reason: "no_valid_target"
      });
      return null;
    }

    const publicSeerClaim = this.state.publicInfo.find((info) => info.type === "public_claim" && info.claim?.role === ROLES.SEER);
    const claimedSeer = publicSeerClaim ? this.getPlayer(publicSeerClaim.actorId) : null;
    const target = claimedSeer?.alive
      ? claimedSeer
      : candidates
        .map((candidate) => ({
          candidate,
          score: werewolf.suspicionScores[candidate.id] ?? 0
        }))
        .sort((a, b) => a.score - b.score || a.candidate.name.localeCompare(b.candidate.name))[0].candidate;

    this.killPlayer(target.id, "werewolf_attack");
    this.addPlayerLog(`夜が明けました。${target.name}が無残な姿で発見されました。`);
    this.addPublicInfo({
      type: "night_death",
      targetId: target.id,
      targetName: target.name,
      text: `${target.name}が夜に死亡した。`
    });
    this.addDeveloperLog("werewolf_attack", {
      werewolfId: werewolf.id,
      werewolfName: werewolf.name,
      targetId: target.id,
      targetName: target.name,
      targetRole: target.role,
      reason: claimedSeer?.alive ? "attacked_public_seer_claim" : "lowest_suspicion_target_to_keep_suspects_alive"
    });

    return {
      werewolfId: werewolf.id,
      targetId: target.id
    };
  }

  killPlayer(playerId, cause) {
    const player = this.getPlayer(playerId);
    if (!player || !player.alive) {
      throw new Error(`Cannot kill invalid or dead player: ${playerId}`);
    }

    player.alive = false;
    this.state.alivePlayers = this.state.alivePlayers.filter((id) => id !== playerId);
    this.state.deadPlayers.push(playerId);
    player.privateMemory.push({
      day: this.state.day,
      type: "death",
      cause
    });
  }

  checkWin(source) {
    const alive = this.getAlivePlayers();
    const werewolfCount = alive.filter((player) => player.team === TEAMS.WEREWOLF).length;
    const villageCount = alive.filter((player) => player.team === TEAMS.VILLAGE).length;
    let winner = null;

    if (werewolfCount === 0) {
      winner = TEAMS.VILLAGE;
    } else if (werewolfCount >= villageCount) {
      winner = TEAMS.WEREWOLF;
    }

    this.addDeveloperLog("win_check", {
      source,
      werewolfCount,
      villageCount,
      winner
    });

    if (winner) {
      this.state.winner = winner;
      const label = publicTeamName(winner);
      this.addPlayerLog(`勝敗結果: ${label}の勝利です。`);
      this.addPublicInfo({
        type: "winner",
        winner,
        text: `${label}が勝利した。`
      });
    }

    return winner;
  }

  createDeveloperSnapshot() {
    return {
      day: this.state.day,
      phase: this.state.phase,
      alivePlayers: [...this.state.alivePlayers],
      deadPlayers: [...this.state.deadPlayers],
      winner: this.state.winner,
      players: this.state.players.map((player) => ({
        id: player.id,
        name: player.name,
        role: player.role,
        team: player.team,
        alive: player.alive,
        knownInfo: player.knownInfo,
        hiddenInfo: player.hiddenInfo,
        suspicionScores: player.suspicionScores,
        publicClaims: player.publicClaims,
        privateMemory: player.privateMemory,
        voteHistory: player.voteHistory,
        conversationPolicy: player.conversationPolicy
      }))
    };
  }

  formatPlayerLog(fromIndex = 0) {
    return this.state.playerLog.slice(fromIndex).map((entry) => {
      return `[Day ${entry.day} / ${entry.phase}] ${entry.message}`;
    }).join("\n");
  }

  formatDeveloperLog(options = {}) {
    const entries = options.last
      ? this.state.developerLog.slice(-options.last)
      : this.state.developerLog;

    return entries.map((entry, index) => {
      return [
        `#${index + 1} [Day ${entry.day} / ${entry.phase}] ${entry.kind}`,
        JSON.stringify(entry.detail, null, 2)
      ].join("\n");
    }).join("\n\n");
  }
}

function assignRoles({ rng, shuffleRoles, scenario }) {
  if (scenario === "sample") {
    return { ...SAMPLE_ROLE_BY_ID };
  }

  const roles = [ROLES.WEREWOLF, ROLES.SEER, ROLES.CITIZEN, ROLES.CITIZEN, ROLES.CITIZEN];
  const assignedRoles = shuffleRoles ? rng.shuffle(roles) : roles;
  const result = {};

  DEFAULT_PLAYERS.forEach((player, index) => {
    result[player.id] = assignedRoles[index];
  });

  return result;
}

function createPlayerState(template, role) {
  const team = teamForRole(role);
  const player = {
    ...template,
    role,
    team,
    alive: true,
    knownInfo: [],
    hiddenInfo: [
      {
        type: "role",
        value: role,
        text: `このNPCの役職は${publicRoleName(role)}。`
      },
      {
        type: "team",
        value: team,
        text: `このNPCの陣営は${publicTeamName(team)}。`
      }
    ],
    suspicionScores: {},
    publicClaims: [],
    privateMemory: [],
    voteHistory: [],
    conversationPolicy: createConversationPolicy(role)
  };

  player.knownInfo.push({
    day: 1,
    type: "setup",
    visibility: "public",
    shareable: true,
    text: "5人村の公開内訳は人狼1、占い師1、市民3。"
  });
  player.knownInfo.push({
    day: 1,
    type: "self_presence",
    visibility: "private",
    shareable: false,
    targetId: player.id,
    text: "自分は現在この村に参加している。"
  });

  if (role === ROLES.WEREWOLF) {
    player.hiddenInfo.push({
      type: "werewolf_identity",
      value: player.id,
      text: "自分が唯一の人狼。"
    });
  }

  return player;
}

function createConversationPolicy(role) {
  if (role === ROLES.WEREWOLF) {
    return {
      truthfulness: "deceptive_when_needed",
      roleClaim: "never_confess_werewolf",
      allowedTactics: ["deny_identity", "redirect_suspicion", "avoid_self_incrimination"],
      forbidden: ["confess_werewolf", "change_game_state"]
    };
  }

  if (role === ROLES.SEER) {
    return {
      truthfulness: "honest_but_may_withhold_private_info",
      roleClaim: "claim_when_directly_asked_after_result",
      allowedTactics: ["withhold_role_until_needed", "state_suspicion_without_explaining_private_result"],
      forbidden: ["invent_results", "change_game_state"]
    };
  }

  return {
    truthfulness: "honest_with_possible_mistakes",
    roleClaim: "avoid_unnecessary_claim",
    allowedTactics: ["reason_from_public_info", "admit_uncertainty"],
    forbidden: ["invent_hidden_info", "change_game_state"]
  };
}

function initializeSuspicion(players, rng, scenario) {
  for (const player of players) {
    for (const other of players) {
      if (player.id !== other.id) {
        player.suspicionScores[other.id] = 0;
      }
    }
  }

  if (scenario === "sample") {
    for (const player of players) {
      Object.assign(player.suspicionScores, SAMPLE_SUSPICION[player.id]);
      addInitialImpression(player, players);
    }
    return;
  }

  for (const player of players) {
    for (const other of players) {
      if (player.id !== other.id) {
        player.suspicionScores[other.id] = rng.int(3);
      }
    }
    addInitialImpression(player, players);
  }
}

function addInitialImpression(player, players) {
  const top = Object.entries(player.suspicionScores)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  if (!top || top[1] <= 0) {
    return;
  }

  const target = players.find((candidate) => candidate.id === top[0]);
  player.knownInfo.push({
    day: 1,
    type: "first_impression",
    visibility: "private",
    shareable: true,
    targetId: target.id,
    targetName: target.name,
    text: `${target.name}の発言には少し違和感がある、という初日の印象を持っている。`
  });
}

function findPrivateVoteReason(voter, chosen) {
  const privateSeerResult = voter.knownInfo.find((info) => {
    return info.type === "seer_result" && info.targetId === chosen.id;
  });

  if (privateSeerResult) {
    return `private seer result=${privateSeerResult.result}`;
  }

  const impression = voter.knownInfo.find((info) => {
    return info.type === "first_impression" && info.targetId === chosen.id;
  });

  if (impression) {
    return "first_impression";
  }

  return null;
}
