# NPC Structured Reaction Acceptance Matrix

## 1. 目的

Phase 6 F-06 replacementとして、default-offでmerge済みのNPC Structured Reaction経路を、実際のEngine、Browser、CLI、Server entrypointと決定論的なpseudo／mock／localhost loopbackだけで検証する。production runtimeを変更せず、独立レビュー前のacceptance evidenceを固定する。

## 2. Authoritative baseline

Baselineは`fa7757f72cf4b95b2f52c1f94c0fc6ee2f12b98b`である。PR #65の通常のtwo-parent mergeであり、approved headは`b9670de1a8c0740321f02dbdcd0861f8ec4a48ec`、merge treeとapproved-head treeは一致する。

## 3. F-06 replacement history

- Original F-06は`35ddce7…`でpost-winner defectを検出し、未完了のまま手動削除された。
- PR #64はpost-winner correctionを`1b2db28…`へmergeした。
- First replacement F-06は`1b2db28…`でphase／fallback defectを検出し、未完了のまま手動削除された。
- PR #65はphase lifecycle／fallback correctionを`fa7757f…`へmergeした。
- Current replacementは`fa7757f…`からfreshに実行する。

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
- E4: manual real-browser evidence。未実施。
- E5: real OpenAI candidate route evidence。未実施。

## 6. Scope

testsとdocsだけを変更する。production runtime diffは0、feature flagはdefault-off、API key操作とbillable callは0である。独立レビューとmergeはpendingである。

## 7. Cross-surface invariants

authoritative stateは`WerewolfGame.state`だけである。one logical reactionにつきNPC commitは最大1回、replayはProvider／Commit／Deliveryを追加実行せず、Structured mode ONでlegacy fallbackを行わない。Deliveryはphase／stateVersionを変更しない。

## 8. Engine acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-001 | Engine | flag-off legacy exclusivity | Candidate／structured commit／delivery 0、legacy 1 | new Engine suite | PASS |
| ACC-002 | Engine | flag-on consumer-off multi-question | 2 questions、phase lifecycle、exactly-once | new Engine suite | PASS |
| ACC-003 | Engine | flag-on consumer-on multi-question | 2 questions、phase lifecycle、exactly-once | new Engine suite | PASS |
| ACC-004 | Engine | replay exactly-once | additional Provider／Commit／Delivery 0 | new Engine suite | PASS |
| ACC-005 | Engine | concurrent command rejection | second mutation `input_in_progress`、read allowed | new Engine suite | PASS |
| ACC-006 | Engine | retryable Provider then success | bounded 2 attempts、one commit／delivery | new Engine suite | PASS |
| ACC-007 | Engine | exhaustion／malformed／closed fallback recovery | terminal settlementまたはpre-Player closed result、legacy 0 | new Engine suite + PR #65 correction suites | PASS |
| ACC-008 | Engine | abort／destroy late-result suppression | late authority／sink effect 0 | new Engine suite | PASS |

## 9. Browser acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-013 | Browser | consumer-off multi-question order | Player-A→NPC-A→Player-B→NPC-B | new Browser suite | PASS |
| ACC-014 | Browser | consumer-on multi-question order | Player-A→NPC-A→Player-B→NPC-B | new Browser suite | PASS |
| ACC-015 | Browser | duplicate submit／busy gate | dispatch／candidate／DOM effect exactly once | new Browser suite | PASS |
| ACC-016 | Browser | New Game isolation | old DOM／observation／late effect 0 | new Browser suite | PASS |
| ACC-017 | Browser | observability／privacy | redacted diagnostics、private marker 0 | new Browser suite | PASS |

## 10. CLI acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-018 | CLI | consumer-off multi-action | 2 questions order、vote/night candidate 0 | new CLI／Server suite | PASS |
| ACC-019 | CLI | consumer-on multi-action | 2 questions order、vote/night candidate 0 | new CLI／Server suite | PASS |
| ACC-020 | CLI | explicit retry recovery | redispatch／Provider／Commit additional 0 | new CLI／Server suite + existing retry suite | PASS |
| ACC-021 | CLI | observability／privacy | bounded redacted output、normal output diagnostic 0 | new CLI／Server suite | PASS |

## 11. Server／transport acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-022 | Server | flag-off candidate 404 | runtime-config false、candidate Provider 0 | new CLI／Server suite | PASS |
| ACC-023 | Server | flag-on localhost success | HTTP 200、strict bytes、one candidate | new CLI／Server suite | PASS |
| ACC-024 | Server | malformed／aborted isolation | closed response、Provider 0、server reusable | new CLI／Server suite + existing Server tests | PASS |

## 12. Failure／retry acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-009 | Engine／Delivery | Player display explicit retry | same frozen action、eventual Player/NPC exactly once | new Engine suite + existing display suite | PASS |
| ACC-010 | Delivery | `repeat_sink` | sinkだけ明示retry、authority delta 0 | new Engine suite + existing delivery suite | PASS |
| ACC-011 | Delivery | `ack_only` | acknowledgementだけretry、sink additional 0 | new Engine suite + existing delivery suite | PASS |
| ACC-012 | Delivery | terminal ambiguity | automatic retry 0、commits retained | new Engine suite + existing delivery suite | PASS |

## 13. Game progression acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-025 | Engine／CLI | vote／night continuity | candidate additional 0、bounded deterministic progression | new Engine and CLI／Server suites | PASS |
| ACC-026 | Engine | dead NPC question | Candidate／NPC commit／delivery／legacy 0 | new Engine suite | PASS |
| ACC-027 | Engine | bounded deterministic winner | terminal winner、open handoff 0 | new Engine suite | PASS |
| ACC-028 | Engine | post-winner authoritative no-op | complete state deep-equal | new Engine suite + merged post-winner suite | PASS |

## 14. Privacy／security acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-030 | Cross-surface | ID／state／privacy audit | unique safe IDs、monotonic state、marker exposure 0 | all new suites | PASS |

## 15. Rollback boundary acceptance

| ID | Surface | Scenario | Expected invariant | Automated evidence | Result |
|---|---|---|---|---|---|
| ACC-029 | Engine | fresh disabled instance after destroy | session isolation、legacy 1、structured effect 0 | new Engine suite + rollback suite | PASS |

## 16. Test execution

Baseline full regressionは731/731 PASS、PR #65 correction suitesは34/34 PASS、post-winner suiteは9/9 PASSである。新規acceptance suitesは29/29 PASS、focused bundleは511/511 PASS、final full regressionは760/760 PASS、`npm.cmd run sample`はPASSである。

## 17. Evidence limitations

E4 manual real-browserは未実施、E5 real OpenAI candidate routeは未実施である。fake DOMをreal-browser evidenceとせず、injected transport／localhostをreal OpenAI evidenceとしない。production-ready、release-ready、flag-on readyは主張しない。

## 18. Remaining operational steps

すべてのE2／E3 evidenceを確定後、Draft PRのlatest HEADを独立レビューする。approval後のmerge判断、新baseline固定、fresh readiness audit、controlled local flag-on判断、real one-call OpenAI candidate smokeは別工程である。
