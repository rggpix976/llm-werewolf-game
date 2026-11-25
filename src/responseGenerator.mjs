import { addressFormsFor } from "./cast.mjs";
import { chooseTopSuspect, strategyProposalFor, strategyReply } from "./personalityStrategy.mjs";
import { assertionFor } from "./persuasion.mjs";
import { boardDigestFor, contestedClaimGroups } from "./boardAssessment.mjs";
import { ROLES, publicRoleName } from "./constants.mjs";
import { compareNames, containsAny, extractMentionedPlayerIds, formatList } from "./textUtils.mjs";

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
  const proposal = gameState.config.scenario === "village9" ? strategyProposalFor(playerInput) : null;
  // D-024: direct result questions to a player who has already claimed
  // ("結果を教えて", "GJ先は？") carry no role keyword, so they never
  // reached the claim path and fresh results stayed unpublished. For an
  // already-claimed responder, result-seeking phrasing also runs the
  // claim builder; when nothing fresh remains, the question falls
  // through to the ordinary branches instead of the claim deflection.
  const resultQuestionToClaimed = !intent.asksRoleOrClaim && npc.publicClaims.length > 0
    && containsAny(playerInput, ["結果", "GJ", "gj", "護衛", "守った", "占った"]);
  let precomputedClaim = (intent.asksRoleOrClaim || resultQuestionToClaimed)
    ? maybeCreateRoleClaim(npc, gameState)
    : null;
  // D-029: claim maintenance on the ask path. maybeCreateRoleClaim only
  // builds from the responder's real role, so a fake claimant (whose
  // fabrication is wired only into the day-start and rescue decision
  // points) fell through to the pre-claim deflection even with fresh
  // nights or executions unpublished — a hard tell that separated fake
  // claimants from genuine ones, who publish or restate. When the real
  // role builder produces nothing for a claimed responder, extend a fake
  // claim with the same engine-owned fabrication rules the decision
  // points use; when nothing fresh remains for anyone, restate the
  // already-published results without registering a new claim.
  let restatedClaim = null;
  if (!precomputedClaim && (intent.asksRoleOrClaim || resultQuestionToClaimed) && npc.publicClaims.length > 0) {
    precomputedClaim = maybeBuildFakeClaimExtension(npc, gameState);
    if (!precomputedClaim) {
      restatedClaim = buildClaimRestatement(npc, gameState);
    }
  }
  const claimQuestion = intent.asksRoleOrClaim || Boolean(precomputedClaim) || Boolean(restatedClaim);

  const acknowledgment = persuasionAcknowledgment(npc, gameState, playerInput, topSuspect);
  const boardChoice = contestedClaimGroups(gameState).find((group) => {
    const assessment = gameState.boardAssessments?.[`${npc.id}:${group.role}`];
    return !group.claimantIds.includes(npc.id) && assessment?.day === gameState.day
      && assessment.firstChoiceId === topSuspect?.id
      && boardDigestFor(gameState, group).claimants.some((c) => c.claimantId === topSuspect?.id && c.bankedBlacks > 0);
  });
  let declaredVoteTargetId = null;
  let publicClaim = null;
  let text;
  let evidenceUsed = [
    ...publicEvidence.map((info) => evidenceLabel("publicInfo", info)),
    ...shareableKnownEvidence.map((info) => evidenceLabel("knownInfo", info))
  ];
  let disclosedHiddenInfo = false;

  if (proposal && topSuspect && !precomputedClaim && !restatedClaim) {
    text = strategyReply(npc, gameState, proposal, topSuspect);
    declaredVoteTargetId = topSuspect.id;
  } else if (intent.asksWerewolfIdentity && !precomputedClaim && !restatedClaim && !acknowledgment && !boardChoice) {
    // The denial wording is identical for every role on purpose: a
    // werewolf-only phrasing would leak the role to anyone who asks.
    const stance = "私は人狼ではありません。ただ、口だけでは証明にならないので発言と投票で見てください。";
    text = addSuspectSentence(stance, npc, topSuspect);
    declaredVoteTargetId = topSuspect?.score > 0 ? topSuspect.id : null;
    if (npc.role === ROLES.WEREWOLF) {
      evidenceUsed.push("conversationPolicy: werewolf denies identity and redirects");
    } else {
      evidenceUsed.push("hiddenInfo:self_role used only to answer direct identity question");
    }
  } else if (claimQuestion) {
    const claimResult = precomputedClaim;
    if (claimResult) {
      text = claimResult.text;
      publicClaim = claimResult.publicClaim;
      evidenceUsed.push(...claimResult.evidenceUsed);
      disclosedHiddenInfo = true;
    } else if (restatedClaim) {
      // D-029: the responder already holds a public claim and has nothing
      // fresh to publish. Restate the published results; nothing new is
      // registered, so no suspicion effect is applied a second time.
      text = restatedClaim.text;
      evidenceUsed.push(...restatedClaim.evidenceUsed);
    } else if (npc.role === ROLES.WEREWOLF) {
      // Same deflection wording as every other role on purpose: a
      // werewolf-only phrasing would leak the role to anyone who asks.
      text = addSuspectSentence("今は役職COを急ぎません。公開されている発言と投票から考えます。", npc, topSuspect);
      evidenceUsed.push("conversationPolicy: werewolf avoids role claim");
      declaredVoteTargetId = topSuspect?.score > 0 ? topSuspect.id : null;
    } else {
      text = addSuspectSentence("今は役職COを急ぎません。公開されている発言と投票から考えます。", npc, topSuspect);
      evidenceUsed.push("conversationPolicy: avoid unnecessary role reveal");
      declaredVoteTargetId = topSuspect?.score > 0 ? topSuspect.id : null;
    }
  } else if (acknowledgment) {
    text = acknowledgment;
  } else if (boardChoice) {
    const chosen = topSuspect.player.name;
    text = `${chosen}は結果を出し終えている。真でも村は保てるので、先に${chosen}に投票したいです。`;
    declaredVoteTargetId = topSuspect.id;
  } else if (intent.asksVoteReason) {
    text = answerVoteQuestion(npc, gameState);
    evidenceUsed.push("voteHistory:self");
  } else if (mentionedIds.length > 0) {
    const target = gameState.players.find((player) => player.id === mentionedIds[0]);
    text = answerAboutTarget(npc, target, privateKnownEvidence);
    // D-026: an answer about one player read as the NPC's whole position
    // when their actual vote intention (the top suspect, ranked exactly
    // as the vote itself is chosen) was someone else. Name the top
    // suspect as well, so statements and votes cannot drift apart.
    if (topSuspect && target.id !== topSuspect.id) {
      text = addSuspectSentence(text, npc, topSuspect);
    }
    if (topSuspect && (target.id === topSuspect.id || topSuspect.score > 0)) declaredVoteTargetId = topSuspect.id;
    evidenceUsed.push(`suspicionScores:${target.id}`);
    if (privateKnownEvidence.length > 0) {
      evidenceUsed.push(...privateKnownEvidence.map((info) => evidenceLabel("knownInfo_private_for_stance", info)));
    }
  } else {
    text = addSuspectSentence("今出ている材料だけだと、まだ断定はできません。", npc, topSuspect);
    declaredVoteTargetId = topSuspect?.score > 0 ? topSuspect.id : null;
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
      voiceProfile: npc.voiceProfile ?? null,
      callName: npc.callName ?? npc.name,
      addressForms: addressFormsFor(npc, gameState.players),
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
    declaredVoteTargetId,
    evidenceUsed: [...evidenceUsed],
    promptPreview,
    publicClaim,
    claimText: publicClaim ? text : null,
    disclosedHiddenInfo
  };
}

function persuasionAcknowledgment(npc, state, input, top) {
  const assertion = assertionFor(input, state.players);
  const last = state.lastPersuasion;
  if (!assertion || !top || last?.sourceKind !== "player" || last.day !== state.day
    || last.targetId !== assertion.targetId || last.direction !== assertion.direction) return null;
  const result = last.results[npc.id];
  if (!result?.wasTopBefore) return null;
  const target = state.players.find((player) => player.id === assertion.targetId).name;
  const stillTop = top.id === assertion.targetId;
  if (result.accepted && assertion.direction === "white") {
    return stillTop
      ? `${target}が白いという話は分かりましたが、それでも私は${target}が気になります。今日は${target}に投票したいです。`
      : `${target}が白いというのは確かにそう思います。今日は${top.player.name}に投票したいです。`;
  }
  if (result.accepted && assertion.direction === "black" && stillTop) return `${target}は確かに怪しいです。今日は${target}に投票したいです。`;
  if (!result.accepted && assertion.direction === "white" && stillTop) return `それでも私は${target}が気になります。今日は${target}に投票したいです。`;
  return null;
}

export function buildPersuasionDecisionRequest(npc, state, evidence) {
  return deepFreeze(structuredClone({
    npc: { id: npc.id, name: npc.name, personality: npc.personality, speechStyle: npc.speechStyle, conversationPolicy: npc.conversationPolicy },
    decisionPoint: "persuasion",
    context: { day: state.day, phase: state.phase, publicEvidence: [evidence] },
    candidates: [
      { id: "accept_persuasion", description: "主張を受け入れ、対象への疑いを調整する" },
      { id: "reject_persuasion", description: "主張を受け入れず、疑いを維持する" }
    ],
    private: { role: npc.role, goals: [npc.role === ROLES.WEREWOLF || npc.role === ROLES.MADMAN ? "人狼陣営を勝利に導く" : "村を守り人狼を見つける"] }
  }));
}

export function buildBoardAssessmentDecisionRequest(npc, state, group) {
  const persuasion = buildPersuasionDecisionRequest(npc, state, boardDigestFor(state, group));
  return deepFreeze(structuredClone({
    ...persuasion,
    decisionPoint: "board_assessment",
    candidates: [
      ...group.claimantIds.map((id) => ({ id: `execute_first_${id}`, description: `${state.players.find((p) => p.id === id).name}を先に処刑する` })),
      { id: "no_preference", description: "処刑順の希望なし" }
    ]
  }));
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
      ...(triggeringClaim ? { triggeringClaim } : { publicSituation: decisionPoint === "uncontested_first_claim" ? "no seer claim has been made yet" : "no knight claim has been made yet" })
    },
    candidates,
    decisionPoint,
    private: {
      role: npc.role,
      goals: npc.role === ROLES.KNIGHT
        ? ["村を守る", "真実の護衛記録を適切に公開する"]
        : npc.role === ROLES.MEDIUM
          ? ["村を守る", "真実の霊媒結果を適切に公開する"]
          : ["村を混乱させる", "人狼をかばう"]
    }
  }));
}

// D-035: claim announcements use the claimant's own set phrases
// (cast claimVoice) for the opening and the seer closing, while the
// result lines stay in the canonical wording so they remain
// unambiguous. NPCs without claimVoice data keep the canonical texts.
const CANONICAL_CLAIM_OPENINGS = { seer: "占い師COします。", medium: "霊媒師COします。", knight: "騎士COします。" };
const CANONICAL_CLAIM_MORE = { seer: "占い結果を追加で公開します。", medium: "霊媒結果を追加で公開します。" };
const CANONICAL_SEER_CLAIM_CLOSING = "公開する以上、この結果を軸に考えてください。";

export function claimOpeningFor(npc, role, followUp = false) {
  const voice = npc?.claimVoice ?? null;
  if (followUp) {
    return voice?.more?.[role] ?? CANONICAL_CLAIM_MORE[role] ?? CANONICAL_CLAIM_OPENINGS[role];
  }
  return voice?.openings?.[role] ?? CANONICAL_CLAIM_OPENINGS[role];
}

export function seerClaimClosingFor(npc) {
  return npc?.claimVoice?.closing ?? CANONICAL_SEER_CLAIM_CLOSING;
}

export function claimResultEndingFor(npc) {
  return npc?.claimVoice?.resultEnding ?? "です";
}

export function fabricatedMediumSuffixFor(npc, joinedLines) {
  // The fabricated medium lines end in a noun for a black result
  // ("…は人狼") but in a negated predicate for a white one
  // ("…は人狼ではない"). The character's sentence ending attaches only
  // to the noun form; after "ではない" it breaks the grammar
  // ("ではないだ").
  return joinedLines.endsWith("人狼") ? `${claimResultEndingFor(npc)}。` : "。";
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
    ? `${claimOpeningFor(npc, ROLES.SEER)}${resultLines.join("、")}${claimResultEndingFor(npc)}。${seerClaimClosingFor(npc)}`
    : `${claimOpeningFor(npc, ROLES.SEER, true)}${resultLines.join("、")}${claimResultEndingFor(npc)}。`;

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

export function buildProactiveMediumClaim(npc, gameState) {
  if (npc.role !== ROLES.MEDIUM) {
    return null;
  }

  if (npc.conversationPolicy.roleClaim !== "claim_when_directly_asked_after_result") {
    return null;
  }

  const claimedTargetIds = new Set(
    npc.publicClaims.flatMap((claim) => (claim.results ?? []).map((result) => result.targetId))
  );
  const freshResults = npc.knownInfo.filter((info) => {
    return info.type === "medium_result" && !claimedTargetIds.has(info.targetId);
  });

  if (freshResults.length === 0) {
    return null;
  }

  // Medium results are always about executed (dead) players, so unlike the
  // seer builder there is no alive-target filter: every fresh result is
  // announceable, with the same wording as the ask-based medium claim.
  const resultLines = freshResults.map((result) => {
    const target = gameState.players.find((player) => player.id === result.targetId);
    const label = result.result === "werewolf" ? "人狼でした" : "人狼ではありませんでした";
    return `${target?.name ?? result.targetId}は${label}`;
  });

  return {
    text: `${claimOpeningFor(npc, ROLES.MEDIUM)}${resultLines.join("、")}。`,
    publicClaim: {
      day: gameState.day,
      actorId: npc.id,
      actorName: npc.name,
      role: ROLES.MEDIUM,
      results: freshResults.map((result) => ({
        targetId: result.targetId,
        result: result.result
      }))
    },
    evidenceUsed: [
      "hiddenInfo:self_role intentionally disclosed by proactive CO",
      ...freshResults.map((result) => `knownInfo:medium_result:${result.targetId}`)
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
    const results = knightGuardResults(npc);
    return {
      text: knightClaimText(npc, results),
      publicClaim: {
        day: gameState.day,
        actorId: npc.id,
        actorName: npc.name,
        role: ROLES.KNIGHT,
        results
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
      ? `${claimOpeningFor(npc, ROLES.SEER)}まだ占い結果はありません。`
      : `${claimOpeningFor(npc, ROLES.MEDIUM)}まだ結果はありません。`;
  } else if (isSeer) {
    text = `${claimOpeningFor(npc, ROLES.SEER)}${resultLines.join("、")}${claimResultEndingFor(npc)}。${seerClaimClosingFor(npc)}`;
  } else {
    text = `${claimOpeningFor(npc, ROLES.MEDIUM)}${resultLines.join("、")}。`;
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
    asksRoleOrClaim: containsAny(input, ["役職", "co", "カミングアウト", "占いco", "占い師", "seer", "霊媒師", "medium", "騎士", "knight"]),
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
  if (npc.role === ROLES.KNIGHT) {
    const results = knightGuardResults(npc);
    const publishedNights = new Set(npc.publicClaims.flatMap((claim) => claim.results ?? []).map((result) => result.night));
    const freshResults = results.filter((result) => !publishedNights.has(result.night));
    if (freshResults.length === 0) return null;
    return {
      text: knightClaimText(npc, results),
      publicClaim: { day: gameState.day, actorId: npc.id, actorName: npc.name, role: ROLES.KNIGHT, results },
      evidenceUsed: ["hiddenInfo:self_role intentionally disclosed by CO", ...results.map(({ night }) => `knownInfo:knight_guard:${night}`)]
    };
  }
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
    ? `${claimOpeningFor(npc, ROLES.SEER)}${resultLines.join("、")}${claimResultEndingFor(npc)}。${seerClaimClosingFor(npc)}`
    : `${claimOpeningFor(npc, ROLES.MEDIUM)}${resultLines.join("、")}。`;

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

// D-029: a fake claimant maintains their claim on the ask path. The
// builders below are pure functions over the game state and mirror the
// engine-owned fabrication rules used at the decision points
// (registerFabricatedSeerClaim / registerFabricatedKnightClaim /
// registerFabricatedMediumClaim in gameEngine.mjs): published results
// never change, a fabricated seer claim never names its own claimant,
// werewolves never black a werewolf, and a fake medium holds at most
// one black result across all of its publications.
function maybeBuildFakeClaimExtension(npc, gameState) {
  const fakeClaim = npc.publicClaims.find((claim) => claim.role !== npc.role);
  if (!fakeClaim) {
    return null;
  }
  if (fakeClaim.role === ROLES.KNIGHT) {
    return buildFakeKnightExtension(npc, gameState);
  }
  if (fakeClaim.role === ROLES.SEER) {
    return buildFakeSeerExtension(npc, gameState);
  }
  if (fakeClaim.role === ROLES.MEDIUM) {
    return buildFakeMediumExtension(npc, gameState);
  }
  return null;
}

function buildFakeKnightExtension(npc, gameState) {
  const publishedByNight = new Map();
  for (const claim of npc.publicClaims) {
    if (claim.role !== ROLES.KNIGHT) continue;
    for (const result of claim.results ?? []) {
      publishedByNight.set(result.night, result);
    }
  }
  const attacks = gameState.developerLog.filter((entry) => entry.kind === "werewolf_attack" && entry.detail?.targetId && !entry.detail?.skipped);
  const results = [];
  let previousTargetId = null;
  let freshCount = 0;
  for (const attack of attacks) {
    const night = attack.day;
    const published = publishedByNight.get(night);
    if (published) {
      results.push({ night, targetId: published.targetId, result: "guarded" });
      previousTargetId = published.targetId;
      continue;
    }
    let target = null;
    if (attack.detail.guarded) {
      target = gameState.players.find((player) => player.id === attack.detail.targetId) ?? null;
    } else {
      const eligible = gameState.players.filter((player) => {
        if (player.id === npc.id || player.id === attack.detail.targetId || player.id === previousTargetId) return false;
        const death = player.privateMemory.find((item) => item.type === "death");
        return !death || death.day > night || (death.day === night && death.cause === "werewolf_attack");
      });
      target = eligible.sort((a, b) => (npc.suspicionScores[a.id] ?? 0) - (npc.suspicionScores[b.id] ?? 0) || compareNames(a.name, b.name))[0] ?? null;
    }
    if (!target || target.id === previousTargetId) {
      return null;
    }
    results.push({ night, targetId: target.id, result: "guarded" });
    previousTargetId = target.id;
    freshCount += 1;
  }
  if (freshCount === 0 || results.length !== Math.max(0, gameState.day - 1)) {
    return null;
  }
  const namedResults = results.map((result) => ({
    ...result,
    targetName: gameState.players.find((player) => player.id === result.targetId)?.name
  }));
  return {
    text: knightClaimText(npc, namedResults),
    publicClaim: { day: gameState.day, actorId: npc.id, actorName: npc.name, role: ROLES.KNIGHT, results: namedResults },
    evidenceUsed: ["conversationPolicy: fabricated knight claim maintained on the ask path", ...namedResults.map(({ night }) => `fabricated:knight_guard:${night}`)]
  };
}

function buildFakeSeerExtension(npc, gameState) {
  // D-031: a fabricated seer can never hold more results than the
  // nights that have passed (day - 1), exactly like a genuine seer.
  // Once that budget is spent, the ask path falls back to restating
  // the published results instead of minting an impossible new one.
  const publishedSeerResults = npc.publicClaims
    .filter((claim) => claim.role === ROLES.SEER)
    .reduce((count, claim) => count + (claim.results?.length ?? 0), 0);
  if (publishedSeerResults >= gameState.day - 1) {
    return null;
  }
  const priorTargets = new Set(npc.publicClaims.flatMap((claim) => claim.results ?? []).map((result) => result.targetId));
  const othersResults = [];
  for (const info of gameState.publicInfo) {
    if (info.type !== "public_claim" || info.claim?.role !== ROLES.SEER || info.claim.actorId === npc.id) continue;
    for (const result of info.claim.results ?? []) {
      othersResults.push({ ...result, actorId: info.claim.actorId });
    }
  }
  // Engage the newest published result the fake has not answered yet,
  // mirroring the follow-up publication at the decision points.
  let trigger = null;
  for (let index = othersResults.length - 1; index >= 0; index -= 1) {
    if (!priorTargets.has(othersResults[index].targetId)) {
      trigger = othersResults[index];
      break;
    }
  }
  if (!trigger) {
    return null;
  }
  const aliveOthers = gameState.players.filter((player) => player.alive && player.id !== npc.id);
  let newestTarget = null;
  let newestResult = null;
  if (trigger.result === "werewolf" && trigger.targetId !== npc.id) {
    newestTarget = gameState.players.find((player) => player.id === trigger.targetId) ?? null;
    newestResult = "not_werewolf";
  } else if (trigger.result === "werewolf") {
    // D-021 deny shape: the ask path offers no shape choice, so a black
    // on the claimant himself is answered with a white result only,
    // naming neither the accuser nor the claimant.
    newestTarget = aliveOthers
      .filter((player) => player.id !== trigger.actorId && !priorTargets.has(player.id))
      .sort((a, b) => compareNames(a.name, b.name))[0] ?? null;
    newestResult = newestTarget ? "not_werewolf" : null;
  } else {
    const eligible = (player) => player.id !== trigger.targetId && (npc.role !== ROLES.WEREWOLF || player.role !== ROLES.WEREWOLF);
    newestTarget = aliveOthers.filter((player) => eligible(player) && !priorTargets.has(player.id))
      .sort((a, b) => (npc.suspicionScores[b.id] ?? 0) - (npc.suspicionScores[a.id] ?? 0) || compareNames(a.name, b.name))[0]
      ?? aliveOthers.filter(eligible)
        .sort((a, b) => (npc.suspicionScores[b.id] ?? 0) - (npc.suspicionScores[a.id] ?? 0) || compareNames(a.name, b.name))[0]
      ?? null;
    newestResult = "werewolf";
  }
  if (!newestTarget?.alive || !newestResult) {
    return null;
  }
  const results = [{ targetId: newestTarget.id, result: newestResult }];
  const resultLines = results.map(({ targetId, result }) => `${gameState.players.find((player) => player.id === targetId)?.name ?? targetId}は${result === "werewolf" ? "人狼判定" : "人狼ではない判定"}`);
  return {
    text: `${claimOpeningFor(npc, ROLES.SEER, true)}${resultLines.join("、")}${claimResultEndingFor(npc)}。`,
    publicClaim: { day: gameState.day, actorId: npc.id, actorName: npc.name, role: ROLES.SEER, results },
    evidenceUsed: ["conversationPolicy: fabricated seer claim maintained on the ask path", ...results.map(({ targetId }) => `fabricated:seer_result:${targetId}`)]
  };
}

function buildFakeMediumExtension(npc, gameState) {
  const oldResults = npc.publicClaims.filter((claim) => claim.role === ROLES.MEDIUM).flatMap((claim) => claim.results ?? []);
  const published = new Set(oldResults.map((result) => result.targetId));
  const candidates = gameState.voteHistory.map((vote) => vote.executedId).filter(Boolean)
    .filter((id) => !published.has(id))
    .map((targetId, order) => {
      const seerResult = gameState.publicInfo
        .filter((info) => info.type === "public_claim" && info.claim?.role === ROLES.SEER)
        .flatMap((info) => info.claim.results ?? []).find((result) => result.targetId === targetId);
      const result = seerResult ? (seerResult.result === "werewolf" ? "not_werewolf" : "werewolf")
        : (gameState.players.find((player) => player.id === targetId)?.role === ROLES.WEREWOLF ? "not_werewolf" : "werewolf");
      return { targetId, result, contradictionBlack: Boolean(seerResult && result === "werewolf"), order };
    });
  if (!candidates.length) {
    return null;
  }
  let blackSlots = oldResults.some((result) => result.result === "werewolf") ? 0 : 1;
  for (const item of [...candidates].sort((a, b) => Number(b.contradictionBlack) - Number(a.contradictionBlack) || a.order - b.order)) {
    if (item.result === "werewolf") {
      if (blackSlots) blackSlots -= 1;
      else item.result = "not_werewolf";
    }
  }
  const results = candidates.sort((a, b) => a.order - b.order).map(({ targetId, result }) => ({ targetId, result }));
  const lines = results.map(({ targetId, result }) => `${gameState.players.find((player) => player.id === targetId)?.name ?? targetId}は${result === "werewolf" ? "人狼" : "人狼ではない"}`);
  return {
    text: `${claimOpeningFor(npc, ROLES.MEDIUM, true)}${lines.join("、")}${fabricatedMediumSuffixFor(npc, lines.join("、"))}`,
    publicClaim: { day: gameState.day, actorId: npc.id, actorName: npc.name, role: ROLES.MEDIUM, results },
    evidenceUsed: ["conversationPolicy: fabricated medium claim maintained on the ask path", ...results.map(({ targetId }) => `fabricated:medium_result:${targetId}`)]
  };
}

// D-029: restate what a claimed responder has already published. Used
// when there is nothing fresh to add, so a claimed player never falls
// back to the pre-claim deflection wording.
function buildClaimRestatement(npc, gameState) {
  const claims = npc.publicClaims;
  if (!claims.length) {
    return null;
  }
  const role = claims.at(-1).role;
  const nameOf = (id) => gameState.players.find((player) => player.id === id)?.name ?? id;
  if (role === ROLES.KNIGHT) {
    const byNight = new Map();
    for (const claim of claims) {
      if (claim.role !== ROLES.KNIGHT) continue;
      for (const result of claim.results ?? []) {
        if (!byNight.has(result.night)) byNight.set(result.night, result);
      }
    }
    const results = [...byNight.values()].sort((a, b) => a.night - b.night)
      .map((result) => ({ night: result.night, targetId: result.targetId, targetName: result.targetName ?? nameOf(result.targetId), result: "guarded" }));
    return { text: knightClaimText(npc, results), evidenceUsed: ["publicClaim: restated published knight results"] };
  }
  if (role === ROLES.SEER || role === ROLES.MEDIUM) {
    const byTarget = new Map();
    for (const claim of claims) {
      if (claim.role !== role) continue;
      for (const result of claim.results ?? []) {
        if (!byTarget.has(result.targetId)) byTarget.set(result.targetId, result);
      }
    }
    const results = [...byTarget.values()];
    if (!results.length) {
      return { text: `${claimOpeningFor(npc, role)}まだ結果はありません。`, evidenceUsed: ["publicClaim: restated published claim without results"] };
    }
    if (role === ROLES.SEER) {
      const lines = results.map((result) => `${nameOf(result.targetId)}は${result.result === "werewolf" ? "人狼判定" : "人狼ではない判定"}`);
      return { text: `${claimOpeningFor(npc, ROLES.SEER)}${lines.join("、")}${claimResultEndingFor(npc)}。${seerClaimClosingFor(npc)}`, evidenceUsed: ["publicClaim: restated published seer results"] };
    }
    const lines = results.map((result) => `${nameOf(result.targetId)}は${result.result === "werewolf" ? "人狼でした" : "人狼ではありませんでした"}`);
    return { text: `${claimOpeningFor(npc, role)}${lines.join("、")}。`, evidenceUsed: ["publicClaim: restated published medium results"] };
  }
  return null;
}

function knightGuardResults(npc) {
  return npc.knownInfo.filter((info) => info.type === "knight_guard")
    .sort((a, b) => a.day - b.day)
    .map((info) => ({ night: info.day, targetId: info.targetId, targetName: info.targetName, result: "guarded" }));
}

function knightClaimText(npc, results) {
  if (results.length === 0) return `${claimOpeningFor(npc, ROLES.KNIGHT)}まだ護衛記録はありません。`;
  return `${claimOpeningFor(npc, ROLES.KNIGHT)}${results.map(({ night, targetId, targetName }) => `${night}日目の夜は${targetName ?? targetId}を護衛`).join("、")}しました。`;
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
