import { ROLES, publicRoleName } from "./constants.mjs";
import { containsAny, extractMentionedPlayerIds, formatList } from "./textUtils.mjs";

export function buildNpcResponseRequest(npc, gameState, playerInput) {
  if (!npc.alive) {
    throw new Error("Cannot build a response request for a dead NPC");
  }

  const mentionedIds = extractMentionedPlayerIds(playerInput, gameState.players)
    .filter((id) => id !== npc.id);
  const publicEvidence = selectRelevantPublicInfo(gameState, mentionedIds);
  const shareableKnownEvidence = selectShareableKnownInfo(npc, mentionedIds);
  const privateKnownEvidence = selectPrivateKnownInfoForStance(npc, mentionedIds);
  const topSuspect = chooseTopSuspect(npc, gameState);
  const intent = classifyIntent(playerInput);

  let publicClaim = null;
  let text;
  let evidenceUsed = [
    ...publicEvidence.map((info) => evidenceLabel("publicInfo", info)),
    ...shareableKnownEvidence.map((info) => evidenceLabel("knownInfo", info))
  ];
  let disclosedHiddenInfo = false;

  if (intent.asksWerewolfIdentity) {
    const stance = npc.role === ROLES.WEREWOLF
      ? "私は人狼ではありません。今は、疑い先を一つずつ公開情報で確認したいです。"
      : "私は人狼ではありません。ただ、口だけでは証明にならないので発言と投票で見てください。";
    text = addSuspectSentence(stance, npc, topSuspect);
    if (npc.role === ROLES.WEREWOLF) {
      evidenceUsed.push("conversationPolicy: werewolf denies identity and redirects");
    } else {
      evidenceUsed.push("hiddenInfo:self_role used only to answer direct identity question");
    }
  } else if (intent.asksRoleOrClaim) {
    const claimResult = maybeCreateRoleClaim(npc, gameState);
    if (claimResult) {
      text = claimResult.text;
      publicClaim = claimResult.publicClaim;
      evidenceUsed.push(...claimResult.evidenceUsed);
      disclosedHiddenInfo = true;
    } else if (npc.role === ROLES.WEREWOLF) {
      text = addSuspectSentence("役職COはしません。ここで役職の話だけに寄せるより、投票理由を見たいです。", npc, topSuspect);
      evidenceUsed.push("conversationPolicy: werewolf avoids role claim");
    } else {
      text = addSuspectSentence("今は役職COを急ぎません。公開されている発言と投票から考えます。", npc, topSuspect);
      evidenceUsed.push("conversationPolicy: avoid unnecessary role reveal");
    }
  } else if (intent.asksVoteReason) {
    text = answerVoteQuestion(npc, gameState);
    evidenceUsed.push("voteHistory:self");
  } else if (mentionedIds.length > 0) {
    const target = gameState.players.find((player) => player.id === mentionedIds[0]);
    text = answerAboutTarget(npc, target, privateKnownEvidence);
    evidenceUsed.push(`suspicionScores:${target.id}`);
    if (privateKnownEvidence.length > 0) {
      evidenceUsed.push(...privateKnownEvidence.map((info) => evidenceLabel("knownInfo_private_for_stance", info)));
    }
  } else {
    text = addSuspectSentence("今出ている材料だけだと、まだ断定はできません。", npc, topSuspect);
  }

  const promptPreview = buildPromptPreview({
    npc,
    gameState,
    playerInput,
    publicEvidence,
    shareableKnownEvidence,
    privateKnownEvidence,
    intent
  });

  const request = deepFreeze(structuredClone({
    npc: {
      id: npc.id,
      name: npc.name,
      personality: npc.personality,
      speechStyle: npc.speechStyle,
      conversationPolicy: npc.conversationPolicy
    },
    playerInput,
    context: {
      day: gameState.day,
      phase: gameState.phase,
      publicEvidence,
      shareableKnownEvidence,
      privateStanceEvidence: privateKnownEvidence,
      publicClaims: npc.publicClaims,
      intent,
      topSuspect: topSuspect
        ? {
            id: topSuspect.id,
            name: topSuspect.player.name,
            score: topSuspect.score
          }
        : null
    },
    policyDecision: {
      publicClaimAllowed: Boolean(publicClaim),
      publicClaim: publicClaim ? structuredClone(publicClaim) : null,
      disclosedHiddenInfo
    },
    responsePlan: {
      baseText: text,
      speechStyle: npc.speechStyle
    },
    evidenceUsed,
    prompt: promptPreview
  }));

  return {
    request,
    evidenceUsed: [...evidenceUsed],
    promptPreview,
    publicClaim,
    disclosedHiddenInfo
  };
}

export function generatePseudoResponseText(request) {
  return applySpeechStyle(
    { speechStyle: request.responsePlan.speechStyle },
    request.responsePlan.baseText
  );
}

function classifyIntent(input) {
  return {
    asksWerewolfIdentity: containsAny(input, ["あなたは人狼", "君は人狼", "お前は人狼", "人狼ですか", "are you a werewolf"]),
    asksRoleOrClaim: containsAny(input, ["役職", "co", "カミングアウト", "占いco", "占い師", "seer"]),
    asksVoteReason: containsAny(input, ["投票", "票", "なぜ", "どうして", "vote"])
  };
}

function selectRelevantPublicInfo(gameState, mentionedIds) {
  const recent = gameState.publicInfo.slice(-8);
  if (mentionedIds.length === 0) {
    return recent.slice(-4);
  }

  const mentioned = recent.filter((info) => {
    const text = `${info.text ?? ""} ${info.actorId ?? ""} ${info.targetId ?? ""}`;
    return mentionedIds.some((id) => text.includes(id));
  });

  return mentioned.length > 0 ? mentioned : recent.slice(-4);
}

function selectShareableKnownInfo(npc, mentionedIds) {
  return npc.knownInfo.filter((info) => {
    if (!info.shareable) {
      return false;
    }
    return mentionedIds.length === 0 || mentionedIds.includes(info.targetId) || !info.targetId;
  }).slice(-5);
}

function selectPrivateKnownInfoForStance(npc, mentionedIds) {
  return npc.knownInfo.filter((info) => {
    if (info.shareable) {
      return false;
    }
    if (mentionedIds.length === 0) {
      return false;
    }
    return mentionedIds.includes(info.targetId);
  });
}

function chooseTopSuspect(npc, gameState) {
  const candidates = gameState.alivePlayers
    .filter((id) => id !== npc.id)
    .map((id) => ({
      id,
      score: npc.suspicionScores[id] ?? 0,
      player: gameState.players.find((candidate) => candidate.id === id)
    }))
    .sort((a, b) => b.score - a.score || a.player.name.localeCompare(b.player.name));

  return candidates[0] ?? null;
}

function addSuspectSentence(base, npc, topSuspect) {
  if (!topSuspect) {
    return base;
  }

  if (topSuspect.score >= 3) {
    return `${base} 今いちばん気になるのは${topSuspect.player.name}です。`;
  }

  if (topSuspect.score > 0) {
    return `${base} 少し気になるのは${topSuspect.player.name}です。`;
  }

  return `${base} 強く疑っている相手はまだいません。`;
}

function answerVoteQuestion(npc, gameState) {
  const lastVote = npc.voteHistory.at(-1);
  if (!lastVote) {
    return "まだ投票していないので、投票理由はありません。現時点では発言の薄さと矛盾を見ています。";
  }

  const target = gameState.players.find((player) => player.id === lastVote.targetId);
  const targetName = target?.name ?? lastVote.targetId;
  return `前回は${targetName}に投票しました。理由は、私の視点でいちばん疑いが強かったからです。`;
}

function answerAboutTarget(npc, target, privateKnownEvidence) {
  const score = npc.suspicionScores[target.id] ?? 0;
  const hasPrivateWerewolfResult = privateKnownEvidence.some((info) => {
    return info.type === "seer_result" && info.result === "werewolf";
  });
  const hasPrivateVillageResult = privateKnownEvidence.some((info) => {
    return info.type === "seer_result" && info.result === "not_werewolf";
  });

  if (!target.alive) {
    return `${target.name}はすでに死亡しています。今の投票対象にはできませんが、過去の発言は材料として見ています。`;
  }

  if (hasPrivateWerewolfResult) {
    return `${target.name}はかなり気になります。ただ、根拠の出し方は慎重にしたいです。`;
  }

  if (hasPrivateVillageResult) {
    return `${target.name}を強く疑う理由は今のところ薄いです。別の人の発言を見たいです。`;
  }

  if (score >= 3) {
    return `${target.name}は怪しいと思っています。公開されている発言や投票の流れと比べて、違和感があります。`;
  }

  if (score <= 0) {
    return `${target.name}を強く疑ってはいません。今の公開情報だけでは決めきれません。`;
  }

  return `${target.name}は少し気になります。ただ、まだ決め打てるほどの根拠はありません。`;
}

function maybeCreateRoleClaim(npc, gameState) {
  if (npc.role !== ROLES.SEER) {
    return null;
  }

  const seerResults = npc.knownInfo.filter((info) => info.type === "seer_result");
  if (seerResults.length === 0) {
    return null;
  }

  if (npc.conversationPolicy.roleClaim !== "claim_when_directly_asked_after_result") {
    return null;
  }

  const resultLines = seerResults.map((result) => {
    const target = gameState.players.find((player) => player.id === result.targetId);
    const label = result.result === "werewolf" ? "人狼判定" : "人狼ではない判定";
    return `${target?.name ?? result.targetId}は${label}`;
  });

  return {
    text: `占い師COします。${resultLines.join("、")}です。公開する以上、この結果を軸に考えてください。`,
    publicClaim: {
      day: gameState.day,
      actorId: npc.id,
      actorName: npc.name,
      role: ROLES.SEER,
      results: seerResults.map((result) => ({
        targetId: result.targetId,
        result: result.result
      }))
    },
    evidenceUsed: [
      "hiddenInfo:self_role intentionally disclosed by CO",
      ...seerResults.map((result) => `knownInfo:seer_result:${result.targetId}`)
    ]
  };
}

function applySpeechStyle(npc, text) {
  switch (npc.speechStyle) {
    case "calm":
      return `落ち着いて言うと、${text}`;
    case "direct":
      return `はっきり言うと、${text}`;
    case "cautious":
      return `断定は避けますが、${text}`;
    case "logical":
      return `理由から言うと、${text}`;
    case "soft":
      return `今のところ、${text}`;
    default:
      return text;
  }
}

function evidenceLabel(source, info) {
  const target = info.targetId ? `:${info.targetId}` : "";
  return `${source}:${info.type}${target}`;
}

function buildPromptPreview({
  npc,
  gameState,
  playerInput,
  publicEvidence,
  shareableKnownEvidence,
  privateKnownEvidence,
  intent
}) {
  const privateRoleLine = `role=${npc.role}, team=${npc.team}`;
  const publicLines = publicEvidence.map((info) => `- ${info.text}`).join("\n") || "- none";
  const knownLines = shareableKnownEvidence.map((info) => `- ${info.text}`).join("\n") || "- none";
  const privateKnownLines = privateKnownEvidence.map((info) => {
    return `- ${info.text} [private: may guide stance, do not reveal unless policy permits]`;
  }).join("\n") || "- none";

  return [
    `SYSTEM: Generate only ${npc.name}'s in-character utterance. Do not mutate game state.`,
    "RULES: Use only publicInfo and this NPC's knownInfo as factual basis. Do not invent facts.",
    "RULES: Do not reveal hiddenInfo or role unless the conversationPolicy explicitly allows a public claim.",
    "RULES: If this NPC is a werewolf, never confess; deception and redirection are allowed.",
    `PRIVATE_BEHAVIOR_STATE: ${privateRoleLine}, personality=${npc.personality}, speechStyle=${npc.speechStyle}`,
    `CONVERSATION_POLICY: ${JSON.stringify(npc.conversationPolicy)}`,
    `PLAYER_INPUT: ${playerInput}`,
    `INTENT_HINT: ${JSON.stringify(intent)}`,
    "SPEAKABLE_PUBLIC_INFO:",
    publicLines,
    "SPEAKABLE_KNOWN_INFO:",
    knownLines,
    "PRIVATE_KNOWN_INFO_FOR_STANCE:",
    privateKnownLines,
    `PUBLIC_CLAIMS: ${formatList(npc.publicClaims.map((claim) => `${claim.role} claim on day ${claim.day}`))}`,
    "OUTPUT: one short Japanese utterance only."
  ].join("\n");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
