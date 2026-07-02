import { buildNpcResponseRequest } from "./responseGenerator.mjs";
import {
  getProviderName,
  PseudoResponseProvider,
  GuardedResponseProvider,
  isGuardedProvider,
  validateProviderResponse
} from "./responseProvider.mjs";
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
    personality: "情熱的で直感的",
    speechStyle: "direct"
  },
  {
    id: "npc3",
    name: "Chika",
    aliases: ["C", "千香", "チカ"],
    personality: "慎重で控えめ",
    speechStyle: "cautious"
  },
  {
    id: "npc4",
    name: "Daichi",
    aliases: ["D", "大地", "ダイチ"],
    personality: "論理的で客観的",
    speechStyle: "logical"
  },
  {
    id: "npc5",
    name: "Ema",
    aliases: ["E", "恵麻", "エマ"],
    personality: "明るく協調的",
    speechStyle: "soft"
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

const ACCUSATORY_QUESTION_KEYWORDS = [
  "怪しい",
  "疑",
  "人狼ですか",
  "嘘",
  "信じられない",
  "suspect",
  "liar",
  "werewolf",
  "wolf"
];

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

    const rawProvider = options.responseProvider ?? new PseudoResponseProvider();
    const guardedProvider = isGuardedProvider(rawProvider)
      ? rawProvider
      : new GuardedResponseProvider(rawProvider);

    const game = new WerewolfGame(state, guardedProvider);
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

  constructor(state, responseProvider = new PseudoResponseProvider()) {
    this.state = state;
    this.responseProvider = responseProvider;
  }

  getPlayer(idOrName) {
    const normalized = String(idOrName).toLowerCase();
    return this.state.players.find((player) => {
      const labels = [player.id, player.name, ...(player.aliases ?? [])].map((label) => String(label).toLowerCase());
      return labels.includes(normalized);
    });
  }

  getAlivePlayers() {
    return this.state.players.filter((player) => player.alive);
  }

  addPlayerLog(message) {
    this.state.playerLog.push({
      day: this.state.day,
      phase: this.state.phase,
      message
    });
  }

  addPublicInfo(info) {
    this.state.publicInfo.push({
      day: this.state.day,
      phase: this.state.phase,
      ...info
    });
  }

  addDeveloperLog(kind, detail) {
    this.state.developerLog.push({
      day: this.state.day,
      phase: this.state.phase,
      timestamp: Date.now(),
      kind,
      detail: structuredClone(detail)
    });
  }

  createDeveloperSnapshot() {
    return structuredClone(this.state);
  }

  getPublicSnapshot() {
    return {
      day: this.state.day,
      phase: this.state.phase,
      players: this.state.players.map((player) => ({
        id: player.id,
        name: player.name,
        alive: player.alive,
        publicClaims: player.publicClaims
      })),
      alivePlayers: [...this.state.alivePlayers],
      deadPlayers: [...this.state.deadPlayers],
      publicInfo: structuredClone(this.state.publicInfo),
      winner: this.state.winner,
      playerLog: structuredClone(this.state.playerLog)
    };
  }

  getDeveloperDiagnostics(options = {}) {
    const logCursor = options.logCursor ?? 0;
    const entries = this.state.developerLog.slice(Math.max(0, logCursor));

    return {
      snapshot: this.createDeveloperSnapshot(),
      developerLogEntries: structuredClone(entries),
      nextLogCursor: this.state.developerLog.length
    };
  }

  setPhase(phase) {
    if (this.state.phase !== phase) {
      this.state.phase = phase;
      this.addDeveloperLog("phase_change", { day: this.state.day, phase });
    }
  }

  async dispatchPlayerAction(action = {}) {
    const logCursor = Number.isInteger(action.logCursor) ? action.logCursor : this.state.playerLog.length;
    let result;

    switch (action.type) {
      case "ask_npc":
        result = await this.handlePlayerQuestion(
          action.targetId ?? action.target ?? action.npcId,
          action.input ?? action.question
        );
        break;
      case "advance_vote":
        result = this.runVote();
        break;
      case "run_night":
        result = this.runNight();
        break;
      case "get_state":
        result = null;
        break;
      default:
        throw new Error(`Unknown player action type: ${action.type}`);
    }

    return {
      ok: true,
      actionType: action.type,
      result,
      publicSnapshot: this.getPublicSnapshot(),
      playerLogEntries: this.state.playerLog.slice(logCursor),
      nextLogCursor: this.state.playerLog.length
    };
  }

  async handlePlayerQuestion(targetIdOrName, playerInput) {
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

    const prepared = buildNpcResponseRequest(npc, this.state, questionText);
    const providerName = getProviderName(this.responseProvider);
    let providerResult;

    try {
      if (typeof this.responseProvider?.generateResponse !== "function") {
        throw new TypeError("Response provider must implement generateResponse(request)");
      }
      const rawProviderResult = await this.responseProvider.generateResponse(prepared.request);
      providerResult = validateProviderResponse(rawProviderResult, providerName);
    } catch (error) {
      this.addPlayerLog(`${npc.name}から回答を得られませんでした。`);
      this.addPublicInfo({
        type: "npc_response_error",
        actorId: npc.id,
        actorName: npc.name,
        text: `${npc.name}から回答を得られませんでした。`
      });
      this.addDeveloperLog("npc_response_provider_error", {
        npcId: npc.id,
        npcName: npc.name,
        playerInput: questionText,
        providerName: error?.diagnostics?.providerName || providerName,
        errorType: error?.type ?? error?.name ?? "Error",
        message: error?.message ?? String(error),
        diagnostics: error?.diagnostics,
        evidenceUsed: prepared.evidenceUsed,
        promptPreview: prepared.promptPreview
      });
      this.setPhase("day_discussion");
      return {
        responded: false,
        reason: "response_provider_error"
      };
    }

    const result = {
      responded: true,
      text: providerResult.text,
      evidenceUsed: prepared.evidenceUsed,
      promptPreview: prepared.promptPreview,
      publicClaim: prepared.publicClaim,
      disclosedHiddenInfo: prepared.disclosedHiddenInfo,
      provider: providerResult
    };
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
      promptPreview: result.promptPreview,
      provider: result.provider
    });

    return result;
  }

  applyQuestionPressure(questionText) {
    const mentionedIds = extractMentionedPlayerIds(questionText, this.state.players);
    const isAccusatory = containsAny(questionText, ACCUSATORY_QUESTION_KEYWORDS);

    if (isAccusatory && mentionedIds.length > 0) {
      for (const player of this.state.players) {
        if (!player.alive) {
          continue;
        }

        for (const targetId of mentionedIds) {
          if (targetId !== player.id) {
            player.suspicionScores[targetId] = (player.suspicionScores[targetId] ?? 0) + 1;
          }
        }
      }
      this.addDeveloperLog("question_pressure_applied", { mentionedIds, input: questionText });
    }
  }

  runVote() {
    if (this.state.winner) {
      return null;
    }

    this.setPhase("vote");
    const votes = this.getAlivePlayers().map((player) => {
      const targetId = this.chooseVoteTarget(player);
      const target = this.getPlayer(targetId);
      return {
        voterId: player.id,
        voterName: player.name,
        targetId: target.id,
        targetName: target.name,
        reasonPublic: "最も疑いが強い相手に投票",
        reasonDeveloper: player.voteReasonDeveloper
      };
    });

    const counts = votes.reduce((acc, vote) => {
      acc[vote.targetId] = (acc[vote.targetId] ?? 0) + 1;
      return acc;
    }, {});

    const sortedCounts = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const maxVotes = sortedCounts[0][1];
    const tiedIds = sortedCounts.filter((item) => item[1] === maxVotes).map((item) => item[0]);

    let executedId;
    let tie = false;

    if (tiedIds.length === 1) {
      executedId = tiedIds[0];
    } else {
      tie = true;
      const tieBreak = this.resolveTie(tiedIds, counts);
      executedId = tieBreak.executedId;
    }

    const executed = this.getPlayer(executedId);
    const voteResult = {
      votes,
      counts,
      tie,
      executedId,
      executedName: executed.name
    };

    this.state.voteHistory.push(voteResult);
    this.addDeveloperLog("vote_resolved", voteResult);
    this.killPlayer(executedId, "execution");
    this.setPhase("day_discussion");

    this.checkWin("after_execution");

    return voteResult;
  }

  chooseVoteTarget(voter) {
    const candidates = this.state.alivePlayers
      .filter((id) => id !== voter.id)
      .map((id) => ({
        id,
        score: voter.suspicionScores[id] ?? 0
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    const top = candidates[0];
    voter.voteReasonDeveloper = `highest suspicionScore=${top.score}`;

    // NPC logic reinforcement: if they have a private seer result, they should act on it.
    const seerResult = voter.knownInfo.find(i => i.type === "seer_result" && i.result === "werewolf" && this.state.alivePlayers.includes(i.targetId));
    if (seerResult) {
        voter.voteReasonDeveloper = `private seer result=werewolf; suspicionScore=${voter.suspicionScores[seerResult.targetId]}`;
        return seerResult.targetId;
    }

    return top.id;
  }

  resolveTie(tiedIds, counts) {
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
      attackResult
    };
  }

  runSeerAction() {
    const seer = this.state.players.find((p) => p.role === ROLES.SEER);
    if (!seer || !seer.alive) {
      return null;
    }

    const target = this.getAlivePlayers()
      .filter((p) => p.id !== seer.id)
      .sort((a, b) => (seer.suspicionScores[b.id] ?? 0) - (seer.suspicionScores[a.id] ?? 0) || a.id.localeCompare(b.id))[0];

    if (!target) {
      return null;
    }

    const result = target.role === ROLES.WEREWOLF ? "werewolf" : "not_werewolf";
    const info = {
      day: this.state.day,
      type: "seer_result",
      visibility: "private",
      shareable: false,
      targetId: target.id,
      targetName: target.name,
      result,
      text: `占い結果: ${target.name}は${result === "werewolf" ? "人狼" : "人狼ではない"}。`
    };

    seer.knownInfo.push(info);
    this.addDeveloperLog("seer_action", {
      seerId: seer.id,
      targetId: target.id,
      result
    });

    return {
      seerId: seer.id,
      targetId: target.id,
      result
    };
  }

  runWerewolfAttack() {
    const werewolf = this.state.players.find((p) => p.role === ROLES.WEREWOLF);
    if (!werewolf || !werewolf.alive) {
      return null;
    }

    const target = this.getAlivePlayers()
      .filter((p) => p.id !== werewolf.id)
      .sort((a, b) => (werewolf.suspicionScores[b.id] ?? 0) - (werewolf.suspicionScores[a.id] ?? 0) || a.id.localeCompare(b.id))[0];

    if (!target) {
      return null;
    }

    this.killPlayer(target.id, "attack");
    this.addDeveloperLog("werewolf_attack", {
      werewolfId: werewolf.id,
      targetId: target.id
    });

    return {
      werewolfId: werewolf.id,
      targetId: target.id
    };
  }

  killPlayer(id, cause) {
    const player = this.getPlayer(id);
    if (player && player.alive) {
      player.alive = false;
      this.state.alivePlayers = this.state.alivePlayers.filter((pId) => pId !== id);
      this.state.deadPlayers.push(id);

      const message = cause === "execution"
        ? `${player.name}が処刑されました。`
        : `${player.name}が襲撃されました。`;

      this.addPlayerLog(message);
      this.addPublicInfo({
        type: cause === "execution" ? "execution_death" : "night_death",
        actorId: id,
        text: message
      });

      player.privateMemory.push({
        day: this.state.day,
        type: "death",
        cause
      });

      this.addDeveloperLog(cause, {
        executedId: cause === "execution" ? id : undefined,
        executedName: cause === "execution" ? player.name : undefined,
        attackedId: cause === "attack" ? id : undefined,
        attackedName: cause === "attack" ? player.name : undefined,
        role: player.role,
        team: player.team
      });
    }
  }

  checkWin(source) {
    const alive = this.getAlivePlayers();
    const werewolfCount = alive.filter((p) => p.role === ROLES.WEREWOLF).length;
    const villageCount = alive.length - werewolfCount;

    let winner = null;
    if (werewolfCount === 0) {
      winner = TEAMS.VILLAGE;
    } else if (werewolfCount >= villageCount) {
      winner = TEAMS.WEREWOLF;
    }

    if (winner) {
      this.state.winner = winner;
      this.addPlayerLog(`ゲーム終了。${publicTeamName(winner)}の勝利です！`);
      this.addDeveloperLog("win_check", {
        source,
        werewolfCount,
        villageCount,
        winner
      });
    } else {
        this.addDeveloperLog("win_check", {
            source,
            werewolfCount,
            villageCount,
            winner: null
        });
    }

    return winner;
  }

  formatPlayerLog(startIndex = 0) {
    return this.state.playerLog.slice(startIndex).map((entry) => entry.message).join("\n");
  }

  formatDeveloperLog(options = {}) {
    const { last } = options;
    const entries = last ? this.state.developerLog.slice(-last) : this.state.developerLog;
    return entries.map((e, i) => `#${i + 1} [Day ${e.day} / ${e.phase}] ${e.kind}\n${JSON.stringify(e.detail, null, 2)}`).join("\n\n");
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
  players.forEach((player) => {
    if (scenario === "sample") {
      player.suspicionScores = { ...SAMPLE_SUSPICION[player.id] };
    } else {
      players.forEach((target) => {
        if (player.id !== target.id) {
          player.suspicionScores[target.id] = rng.int(3);
        }
      });
    }

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

    // Add first impressions
    players.forEach((target) => {
      if (player.id !== target.id && (player.suspicionScores[target.id] ?? 0) >= 3) {
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
    });
  });
}
