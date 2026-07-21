# NPC Structured Reaction Acceptance Matrix

## 1. 目的

Phase 6 F-06 replacementとして、default-offでmerge済みのNPC Structured Reaction経路を、実際のEngine、Browser、CLI、Server entrypointと決定論的なpseudo／mock／localhost loopbackだけで検証する。production runtimeを変更せず、PR #66の独立レビューで要求されたacceptance evidenceを補強し、exact latest HEADの再レビューに供する。

## 2. Authoritative baseline

Baselineは`fa7757f72cf4b95b2f52c1f94c0fc6ee2f12b98b`である。PR #65の通常のtwo-parent mergeであり、approved headは`b9670de1a8c0740321f02dbdcd0861f8ec4a48ec`、merge treeとapproved-head treeは一致する。

## 3. F-06 replacement history

- Original F-06は`35ddce7…`でpost-winner defectを検出し、未完了のまま手動削除された。
- PR #64はpost-winner correctionを`1b2db28…`へmergeした。
- First replacement F-06は`1b2db28…`でphase／fallback defectを検出し、未完了のまま手動削除された。
- PR #65はphase lifecycle／fallback correctionを`fa7757f…`へmergeした。
- Current replacementは`fa7757f…`からfreshに実行する。

PR #66のreviewed HEAD `21a166d144d389a389b5193b13b6b3c10e3f7b12`と最初のrepair HEAD `9d1e68d94680d8c12ca1732e1190733e298b78fd`はいずれも独立レビューで`CHANGES_REQUESTED`となった。後者で残ったblocking findingsは、ACC-030のdirect authoritative-state mutation／cross-surface source proof不足とidentity graph不足の2件であり、確認されたproduction runtime defectは0である。現在のfollow-upはproduction codeを変更せず、ACC-030、関連helper、matrix、actual countを記録するstatus docsだけを修正する。

## 4. PR #65 correction overlay

| Correction | Acceptance evidence | Result |
|---|---|---|
| CORR-A | ACC-002／003／013／014／018／019は、consumer OFF／ONのEngine・Browser・CLIで2回の質問を通し、`day_discussion N -> player_question N+1 -> day_discussion N+2`、historical `occurredPhase: player_question`、live Delivery中の`day_discussion`、2回目の質問成功、legacy Provider／display 0を固定する。PR #65 correction suiteのRC-015もhandoff gateを再検証する。 | PASS |
| CORR-B | ACC-007はprovider exhaustionとmalformed resultをclosed terminal settlementへ収束させ、次の質問が成功し、legacy Provider／displayが0であることを固定する。 | PASS |
| CORR-C | ACC-007とPR #65 correction suiteのRC-006／007はnonvalidated／malformed／unknown Interpreter outcomeを`candidate_not_allowed`へ閉じ、legacy fallback 0を固定する。 | PASS |
| CORR-D | PR #65 settlement focused testsを再実行し、owner loss、postcondition verification、fixed redacted fail-stop、authoritative non-overwriteを固定する。 | PASS |
| CORR-E | PR #65 capacity focused testsを再実行し、2-version capacity preflightがturn／ID allocationとInterpreter invocationより前にfail closedすることを固定する。 | PASS |

## 5. Evidence levels

- E2: automated module／integration evidence。本Goalで実施する。
- E3: actual Browser fake DOM、actual CLI、localhost Server evidence。本Goalで実施する。
- E4: manual real-browser evidence。`NOT_RUN`。
- E5: real OpenAI candidate route evidence。`NOT_RUN`。

## 6. Scope

testsとdocsだけを変更する。production runtime diffは0、feature flagはdefault-off、API key操作とbillable callは0である。正式状態は`F06_REPLACEMENT_ACCEPTANCE_CHANGES_REQUESTED`で、latest follow-up HEADの独立再レビューとmergeはpendingである。

## 7. Cross-surface invariants

authoritative stateは`WerewolfGame.state`だけである。one logical reactionにつきNPC commitは最大1回、replayはProvider／Commit／Deliveryを追加実行せず、Structured mode ONでlegacy fallbackを行わない。Deliveryはphase／stateVersionを変更しない。

## 8. Engine acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-001 | Engine | flag-off legacy exclusivity | Candidate／structured commit／delivery 0、legacy 1 | `ACC-001 flag-off engine preserves legacy exclusivity` | PASS |
| ACC-002 | Engine | flag-on consumer-off multi-question | 2 questions、phase lifecycle、exactly-once | `ACC-002 flag-on engine accepts two questions with consumer off` | PASS |
| ACC-003 | Engine | flag-on consumer-on multi-question | 2 questions、phase lifecycle、exactly-once | `ACC-003 flag-on engine accepts two questions with consumer on` | PASS |
| ACC-004 | Engine | replay exactly-once | additional Provider／Commit／Delivery 0 | `ACC-004 replay is authoritative and has no additional effects` | PASS |
| ACC-005 | Engine | concurrent command rejection | second mutation `input_in_progress`、read allowed | `ACC-005 concurrent commands reject the second mutation while reads remain available` | PASS |
| ACC-006 | Engine | retryable Provider then success | bounded 2 attempts、one commit／delivery | `ACC-006 one retryable Provider failure then success remains bounded` | PASS |
| ACC-007 | Engine | exhaustion／malformed／closed fallback recovery | terminal settlementまたはpre-Player closed result、legacy 0 | `ACC-007 terminal Provider exhaustion and malformed candidate settle and recover without legacy fallback`＋PR #65 RC-006／007 | PASS |
| ACC-008 | Engine | abort／destroy late-result suppression | late authority／sink effect 0 | `ACC-008 destroy invalidates a pending Provider and suppresses its late result` | PASS |

## 9. Browser acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-013 | Browser | consumer-off multi-question order | Player-A→NPC-A→Player-B→NPC-B | `ACC-013 actual Browser preserves two-question Player-before-NPC order with consumer off` | PASS |
| ACC-014 | Browser | consumer-on multi-question order | Player-A→NPC-A→Player-B→NPC-B | `ACC-014 actual Browser preserves two-question Player-before-NPC order with consumer on` | PASS |
| ACC-015 | Browser | duplicate submit／busy gate | dispatch／candidate／DOM effect exactly once | `ACC-015 actual Browser duplicate submit is rejected by the busy gate without duplicate effects` | PASS |
| ACC-016 | Browser | New Game isolation | pending old Candidate→New Game→late resolveでold DOM／observation／retry／state effect 0。Provider requestでnew `gameSessionId`を確認し、new question usable | `ACC-016 actual Browser New Game invalidates a pending old Provider and isolates its late result` | PASS |
| ACC-017 | Browser | observability／privacy | actual Candidate requestのfrozen Known Information private projectionとmarker-bearing Provider failureをsource側で証明し、normal DOM／Developer observationsで対応object／field／fragment／marker 0 | `ACC-017 actual Browser keeps normal output clean and exposes only redacted structured observations` | PASS |

## 10. CLI acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-018 | CLI | consumer-off multi-action | 2 questions order、vote/night candidate 0 | `ACC-018 actual CLI preserves two-question order and vote/night continuity with consumer off` | PASS |
| ACC-019 | CLI | consumer-on multi-action | 2 questions order、vote/night candidate 0 | `ACC-019 actual CLI preserves two-question order and vote/night continuity with consumer on` | PASS |
| ACC-020 | CLI | explicit retry recovery | Player writer、`repeat_sink`、`ack_only`をactual `runCli()`／`retry`で分離し、redispatch／Provider／Commit additional 0。同一NPC publication identityを維持し、retry後の`state` commandも成功 | `ACC-020 actual CLI retry command preserves Player, repeat_sink, and ack_only authorities`（`Player writer failure retries the same frozen action`、`repeat_sink retries only the actual CLI writer`、`ack_only retries the actual acknowledgement without a second CLI writer call`） | PASS |
| ACC-021 | CLI | observability／privacy | injected OpenAI transportへ渡るactual serialized Known Information private projectionとmarker-bearing failure bodyをsource側で証明する。normal output／error／dev observationsでは対応object／field／fragment／marker 0、explicit `dev` commandのdeveloper-logを含む全出力ではfailure markerとCandidate-private `actorPrivate`／`ownRole`／`ownTeam`／exact fragment 0を固定する | `ACC-021 actual CLI observability is bounded, redacted, and absent from normal output` | PASS |

## 11. Server／transport acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-022 | Server | flag-off candidate 404 | runtime-config false、candidate Provider 0 | `ACC-022 actual Server keeps the candidate endpoint absent when the flag is off` | PASS |
| ACC-023 | Server | flag-on localhost success | HTTP 200、`Cache-Control: no-store`、raw UTF-8 bytes exact、Authorization request header 0、one candidate | `ACC-023 actual HttpResponseProvider and localhost Server complete one candidate, commit, and delivery` | PASS |
| ACC-024 | Server | malformed／aborted／privacy isolation | wrong method／Content-Type／Content-Encoding、65,537 bytes、malformed JSON、strict extra fieldをclosed rejection。actual candidate request disconnectはsame AbortSignalをabortし、late write 0。別のactual frozen request private projectionとmarker-bearing Provider errorをsource側で証明し、503 responseで対応object／field／fragment／marker 0。次request成功、open handle 0 | `ACC-024 actual Server rejects malformed requests, propagates disconnect abort, and remains reusable` | PASS |

## 12. Failure／retry acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-009 | Engine／Delivery | Player display explicit retry | same frozen action、eventual Player/NPC exactly once | `ACC-009 Player display explicit retry preserves the frozen action and starts NPC delivery once` | PASS |
| ACC-010 | Delivery | `repeat_sink` | sinkだけ明示retry、authority delta 0 | `ACC-010 repeat_sink retries only the failed sink` | PASS |
| ACC-011 | Delivery | `ack_only` | actual production compositionでsink 1、ack 2、same publication、explicit retryはacknowledgementだけ、Provider／Commit／phase additional 0。Typed acknowledgement settlement faultのmarker-bearing sourceを事前証明し、両public result／observationでmarker 0 | `ACC-011 ack_only retains one sink effect while explicit completion retries acknowledgement` | PASS |
| ACC-012 | Delivery | terminal ambiguity | automatic retry 0、commits retained | `ACC-012 unknown sink effect closes terminally without automatic redisplay` | PASS |

## 13. Game progression acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-025 | Engine／CLI | vote／night continuity | candidate additional 0、bounded deterministic progression | `ACC-025 ACC-026 ACC-027 ACC-028 public progression, dead NPC, bounded winner, and terminal no-ops`＋ACC-018／019 | PASS |
| ACC-026 | Engine | dead NPC question | dead-target closed rejectionはnew logical turnを消費（`turnOrder +1`、new `turnId`、allocator 4 unique identities）。`stateVersion`、Player／NPC conversation、Candidate、Delivery、legacy effectは0 delta | `ACC-025 ACC-026 ACC-027 ACC-028 public progression, dead NPC, bounded winner, and terminal no-ops` | PASS — dead-target closed rejection consumes the newly allocated logical turn while stateVersion and all Player/NPC conversation, Delivery, and legacy effects remain unchanged |
| ACC-027 | Engine | bounded deterministic winner | terminal winner、open handoff 0 | `ACC-025 ACC-026 ACC-027 ACC-028 public progression, dead NPC, bounded winner, and terminal no-ops` | PASS |
| ACC-028 | Engine | post-winner authoritative no-op | complete state deep-equal | `ACC-025 ACC-026 ACC-027 ACC-028 public progression, dead NPC, bounded winner, and terminal no-ops`＋PW-001〜008／011 | PASS |

## 14. Privacy／security acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-030 | Cross-surface | ID／state／privacy audit | Production-generated frozen `request.knownInformation.actorPrivate`の`ownRole`／`ownTeam`／exact private fragmentとProvider／authorization／stack／cause／path／settlement markerのsource occurrenceを事前証明し、Engine public result／snapshot／Delivery／observations、Browser normal DOM／Developer observations、CLI normal／dev output、Server public error response、typed lifecycle settlement outputで対応object／field／fragment／marker 0。`before -> intermediate authoritative commit -> after Delivery`でDelivery authority delta 0、既存registry prefix不変、`inputRecords` +1、Player publication +1、plan +1、NPC idempotency +1、NPC publication +1、全primary ID nonempty／collision 0／whole-registry duplicate 0、全cross-object bindingをtrace | `ACC-030 engine state, identities, immutability, and privacy remain closed`、`ACC-017 actual Browser keeps normal output clean and exposes only redacted structured observations`、`ACC-021 actual CLI observability is bounded, redacted, and absent from normal output`、`ACC-024 actual Server rejects malformed requests, propagates disconnect abort, and remains reusable`、`ACC-011 ack_only retains one sink effect while explicit completion retries acknowledgement` | PASS |

Actual-schema note: `reactionAttemptId`はCandidate request／Route observationが所有し、committed Plan／NPC idempotencyの`successfulAttemptId`へ等置する。`deliveryAttemptId`はnonauthoritativeなDelivery Controller observation／Orchestrator `deliveryId`／Player bookkeeping identityであり、canonical conversation registryへ追加せずexact NPC／Player publicationへ結び付ける。`gameSessionId` continuityはroot、request、NPC idempotency、mapping、observations、bookkeepingなど実際にfieldを所有するobjectだけで検証し、fieldを持たないpublication／commit resultへは捏造しない。

ACC-030のexact automated identity graphは次を固定する。

- Player chain: added inputの`requestId`／`inputRecordId`をPlayer commit result、Player idempotency、Player publicationへ結び、`playerPublicationId`をcanonical publication、compatibility mapping、action delivery candidate、Player display bookkeepingへ結ぶ。
- Trigger／NPC chain: added inputをPlan／NPC idempotency／NPC publicationの`originatingInputRecordId`へ、Player requestをPlan／NPC idempotencyの`causationId`へ結ぶ。Planの`reactionPlanId`とNPC requestをNPC commit result、NPC idempotency、NPC publicationへ結び、`npcPublicationId`をaction result、Delivery result、controller／orchestrator observationsへ結ぶ。
- Attempt／Delivery chain: actual Candidate requestとRoute observationの`reactionAttemptId`をPlan／NPC idempotencyの`successfulAttemptId`へ結び、Delivery Controllerの`deliveryAttemptId`をOrchestratorの`deliveryId`とexact NPC publicationへ結ぶ。
- Transition／uniqueness: `gameSessionId` continuity、`stateVersion +2`、`turnOrder +1`、fresh `turnId`、全canonical registryのappend-only prefixとexact delta、全owner registryのprimary-ID uniqueness、Player／NPC request-ID disjointnessを検証する。Intentional reference aliasをowner ID 1件へ畳んだうえで、new turn／input／request／act／event／display／plan／attempt／descriptor／segment／publication／mapping／legacy-entry／Player receipt／Player・NPC delivery-attempt identitiesのcross-domain collision 0と、Delivery前後のcomplete authoritative state deep equalityを固定する。

## 15. Rollback boundary acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-029 | Engine | fresh disabled instance after destroy | session isolation、legacy 1、structured effect 0 | `ACC-029 fresh disabled instance is the rollback boundary`＋`WerewolfGame instance mode is fixed and never mixes Structured Route with legacy fallback` | PASS |

## 16. Test execution

Baseline full regressionは731/731 PASS、PR #65 correction suitesは34/34 PASS、post-winner suiteは9/9 PASSである。Review-repair後のEngine acceptanceは17/17、Browser acceptanceは5/5、CLI／Server acceptanceは10/10、新規acceptance suitesは32/32、focused bundleは600/600、final full regressionは763/763 PASSであり、`npm.cmd run sample`もPASSである。

## 17. Evidence limitations

E4 manual real-browserは`NOT_RUN`、E5 real OpenAI candidate routeは`NOT_RUN`である。fake DOMをreal-browser evidenceとせず、injected transport／localhostをreal OpenAI evidenceとしない。production-ready、release-ready、flag-on readyは主張しない。

## 18. Remaining operational steps

すべてのE2／E3 evidenceを確定後、Draft PRのlatest follow-up HEADを独立レビューする。approval後のmerge判断、新baseline固定、fresh readiness audit、controlled local flag-on判断、real one-call OpenAI candidate smokeは別工程である。
