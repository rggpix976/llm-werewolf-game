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
    // The denial wording is identical for every role on purpose: a
    // werewolf-only phrasing would leak the role to anyone who asks.
    const stance = "私は人狼ではありません。ただ、口だけでは証明にならないので発言と投票で見てください。";
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
      // Same deflection wording as every other role on purpose: a
      // werewolf-only phrasing would leak the role to anyone who asks.
      text = addSuspectSentence("今は役職COを急ぎません。公開されている発言と投票から考えます。", npc, topSuspect);
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

export function buildNpcDecisionRequest(npc, gameState, triggeringClaim, candidates, decisionPoint) {
  const mentionedIds = (triggeringClaim?.results ?? []).map(({ targetId }) => targetId);
  return deepFreeze(structuredClone({
    npc: {
      id: npc.id,
      name: npc.name,
      personality: npc.personality,
      speechStyle: npc.speechStyle,
      conversationPolicy: npc.conversationPolicy
    },
    context: {
      day: gameState.day,
      phase: gameState.phase,
      publicEvidence: selectRelevantPublicInfo(gameState, mentionedIds),
      ...(triggeringClaim ? { triggeringClaim } : { publicSituation: "no seer claim has been made yet" })
    },
    candidates,
    decisionPoint,
    private: {
      role: npc.role,
      goals: ["村を混乱させる", "人狼をかばう"]
    }
  }));
}

export function buildProactiveSeerClaim(npc, gameState) {
  if (npc.role !== ROLES.SEER) {
    return null;
  }

  if (npc.conversationPolicy.roleClaim !== "claim_when_directly_asked_after_result") {
    return null;
  }

  const claimedTargetIds = new Set(
    npc.publicClaims.flatMap((claim) => (claim.results ?? []).map((result) => result.targetId))
  );
  const freshResults = npc.knownInfo.filter((info) => {
    return info.type === "seer_result" && !claimedTargetIds.has(info.targetId);
  });

  // Results about players who are already dead are not announced proactively:
  // they stay available for the ask-based claim path instead.
  const announceable = freshResults.filter((result) => {
    const target = gameState.players.find((player) => player.id === result.targetId);
    return target?.alive;
  });

  if (announceable.length === 0) {
    return null;
  }

  const resultLines = announceable.map((result) => {
    const target = gameState.players.find((player) => player.id === result.targetId);
    const label = result.result === "werewolf" ? "人狼判定" : "人狼ではない判定";
    return `${target?.name ?? result.targetId}は${label}`;
  });

  const isFirstClaim = npc.publicClaims.length === 0;
  const text = isFirstClaim
    ? `占い師COします。${resultLines.join("、")}です。公開する以上、この結果を軸に考えてください。`
    : `占い結果を追加で公開します。${resultLines.join("、")}です。`;

  return {
    text,
    publicClaim: {
      day: gameState.day,
      actorId: npc.id,
      actorName: npc.name,
      role: ROLES.SEER,
      results: announceable.map((result) => ({
        targetId: result.targetId,
        result: result.result
      }))
    },
    evidenceUsed: [
      "hiddenInfo:self_role intentionally disclosed by proactive CO",
      ...announceable.map((result) => `knownInfo:seer_result:${result.targetId}`)
    ]
  };
}

export function buildRescueClaim(npc, gameState) {
  if (npc.role !== ROLES.SEER && npc.role !== ROLES.MEDIUM && npc.role !== ROLES.KNIGHT) {
    return null;
  }

  // Rescue claims are engine-triggered survival actions (see D-015), so the
  // conversation ask-policy does not gate them. Contents come only from the
  // claimant's own private knowledge.
  const claimedTargetIds = new Set(
    npc.publicClaims.flatMap((claim) => (claim.results ?? []).map((result) => result.targetId))
  );

  if (npc.role === ROLES.KNIGHT) {
    return {
      text: "騎士COします。私が村を守っています。",
      publicClaim: {
        day: gameState.day,
        actorId: npc.id,
        actorName: npc.name,
        role: ROLES.KNIGHT,
        results: []
      },
      evidenceUsed: ["hiddenInfo:self_role intentionally disclosed by rescue CO"]
    };
  }

  const isSeer = npc.role === ROLES.SEER;
  const resultType = isSeer ? "seer_result" : "medium_result";
  const freshResults = npc.knownInfo.filter((info) => {
    return info.type === resultType && !claimedTargetIds.has(info.targetId);
  });

  const resultLines = freshResults.map((result) => {
    const target = gameState.players.find((player) => player.id === result.targetId);
    const label = isSeer
      ? result.result === "werewolf" ? "人狼判定" : "人狼ではない判定"
      : result.result === "werewolf" ? "人狼でした" : "人狼ではありませんでした";
    return `${target?.name ?? result.targetId}は${label}`;
  });

  let text;
  if (resultLines.length === 0) {
    text = isSeer
      ? "占い師COします。まだ占い結果はありません。"
      : `${publicRoleName(npc.role)}COします。まだ結果はありません。`;
  } else if (isSeer) {
    text = `占い師COします。${resultLines.join("、")}です。公開する以上、この結果を軸に考えてください。`;
  } else {
    text = `${publicRoleName(npc.role)}COします。${resultLines.join("、")}。`;
  }

  return {
    text,
    publicClaim: {
      day: gameState.day,
      actorId: npc.id,
      actorName: npc.name,
      role: npc.role,
      results: freshResults.map((result) => ({
        targetId: result.targetId,
        result: result.result
      }))
    },
    evidenceUsed: [
      "hiddenInfo:self_role intentionally disclosed by rescue CO",
      ...freshResults.map((result) => `knownInfo:${resultType}:${result.targetId}`)
    ]
  };
}

function classifyIntent(input) {
  return {
    asksWerewolfIdentity: containsAny(input, ["あなたは人狼", "君は人狼", "お前は人狼", "人狼ですか", "are you a werewolf"]),
    asksRoleOrClaim: containsAny(input, ["役職", "co", "カミングアウト", "占いco", "占い師", "seer", "霊媒師", "medium"]),
    asksVoteReason: containsAny(input, ["投票", "票", "なぜ", "どうして", "vote"])
  };
}

function selectRelevantPublicInfo(gameState, mentionedIds) {
  const recent = gameState.publicInfo.slice(-16);
  if (mentionedIds.length === 0) {
    return recent.slice(-8);
  }

  const mentioned = recent.filter((info) => {
    const text = `${info.text ?? ""} ${info.actorId ?? ""} ${info.targetId ?? ""}`;
    return mentionedIds.some((id) => text.includes(id));
  });

  if (mentioned.length === 0) {
    return recent.slice(-8);
  }

  // Keep the most recent mentioned entries, and fill with the latest context
  // so the provider can follow the flow of the discussion, in original order.
  const chosen = new Set(mentioned.slice(-8));
  if (chosen.size < 4) {
    for (const info of [...recent].reverse()) {
      if (chosen.size >= 4) {
        break;
      }
      chosen.add(info);
    }
  }

  return recent.filter((info) => chosen.has(info));
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
  if (npc.role !== ROLES.SEER && npc.role !== ROLES.MEDIUM) {
    return null;
  }

  const resultType = npc.role === ROLES.SEER ? "seer_result" : "medium_result";
  const roleResults = npc.knownInfo.filter((info) => info.type === resultType);
  if (roleResults.length === 0) {
    return null;
  }

  if (npc.conversationPolicy.roleClaim !== "claim_when_directly_asked_after_result") {
    return null;
  }

  // Results that are already public (for example through a proactive claim)
  // are not registered as a claim a second time.
  const claimedTargetIds = new Set(
    npc.publicClaims.flatMap((claim) => (claim.results ?? []).map((result) => result.targetId))
  );
  const freshResults = roleResults.filter((result) => !claimedTargetIds.has(result.targetId));
  if (freshResults.length === 0) {
    return null;
  }

  // Seer keeps its established ask-path wording ("人狼判定") so it matches
  // the proactive claim; medium uses the wording from the issue sheet.
  const isSeer = npc.role === ROLES.SEER;
  const resultLines = freshResults.map((result) => {
    const target = gameState.players.find((player) => player.id === result.targetId);
    const label = isSeer
      ? result.result === "werewolf" ? "人狼判定" : "人狼ではない判定"
      : result.result === "werewolf" ? "人狼でした" : "人狼ではありませんでした";
    return `${target?.name ?? result.targetId}は${label}`;
  });

  const text = isSeer
    ? `占い師COします。${resultLines.join("、")}です。公開する以上、この結果を軸に考えてください。`
    : `${publicRoleName(npc.role)}COします。${resultLines.join("、")}。`;

  return {
    text,
    publicClaim: {
      day: gameState.day,
      actorId: npc.id,
      actorName: npc.name,
      role: npc.role,
      results: freshResults.map((result) => ({
        targetId: result.targetId,
        result: result.result
      }))
    },
    evidenceUsed: [
      "hiddenInfo:self_role intentionally disclosed by CO",
      ...freshResults.map((result) => `knownInfo:${resultType}:${result.targetId}`)
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
