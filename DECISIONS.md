# Decisions

## D-001: LLM Does Not Mutate Game State

The LLM or pseudo-LLM response generator must only produce utterance text and response metadata.

Game state changes such as roles, life/death, votes, seer results, attacks, and win checks are handled only by code.

## D-002: CLI Is Temporary UI

PowerShell/CLI is only an input and log display adapter.

Core game behavior must remain usable from browser UI, desktop UI, tests, or scripts without depending on `readline`, `console.log`, or process stdin/stdout.

## D-003: Player-Facing Logs and Developer Logs Stay Separate

Player-facing logs contain only information that a player may see.

Developer logs may contain roles, hidden info, known info, suspicion scores, vote reasons, seer targets/results, attack targets, evidence used, and prompt previews.

## D-004: Seer Results Are Private Until Claimed

Night seer results are added to the seer's `knownInfo`.

They are not added to `publicInfo` automatically. A public claim may expose them later through controlled code paths.

## D-005: NPCs Speak From Limited Information

NPC responses must be grounded in `publicInfo` and that NPC's own `knownInfo`.

`hiddenInfo` may guide behavior only when explicitly allowed by conversation policy, such as a seer intentionally making a role claim. A werewolf must not confess by accident.

## D-006: GitHub Repository Is Private

The remote GitHub repository should be private during early development.

This allows internal design notes, prompt previews, and developer logs to be committed safely while the design is still changing.

## D-007: NPC Response Providers Are Asynchronous and Text-Only

Response providers implement `async generateResponse(request)`.

They receive a frozen, cloned request instead of the live game state. Their accepted output is limited to utterance text and diagnostic metadata. Claims, memory updates, public information, roles, life/death, votes, and win state remain controlled by the game engine.

## D-008: Provider Failure Handling and Fallback

Provider exceptions, empty text, and invalid return values do not end the game.

For transient errors (timeout, network error, rate limit, provider server error), if `OPENAI_FALLBACK_TO_PSEUDO` is enabled, the system falls back to `PseudoResponseProvider` to ensure game continuity.

For non-transient errors (authentication, permission, bad request), the current NPC response is skipped, the failure is recorded in the developer log, the phase returns to `day_discussion`, and the player may ask another question or proceed to voting.

## D-009: Game Sessions Are Not Persisted

Game state exists only in memory for the current process or browser session.

Closing the CLI, refreshing the browser, or closing the application discards the current game. The prototype does not use save files, `localStorage`, IndexedDB, or server-side persistence. A new session always starts a new game.

## D-010: Secure Server-Side LLM Integration

OpenAI API keys must never be exposed to the browser.

All LLM calls are handled by the Node.js server. The browser communicates with the server via a local API endpoint (`/api/npc-response`). This ensures that API keys remain secure in the server's environment and allows for centralized rate limiting and auditing.

## D-011: Real OpenAI Verification is Controlled and Explicit

Real OpenAI API verification is explicit, local, single-request, non-retrying, non-fallback, and never executed by automated tests or AI agents (Jules).

The `npm run smoke:openai` command requires a mandatory opt-in flag `OPENAI_LIVE_SMOKE_TEST=I_ACCEPT_API_CHARGES` to prevent accidental billing and ensures that verification follows the production code path through a temporary local server.

## D-012: WerewolfGame Owns NPC Structured-Reaction Authority

`WerewolfGame.state` remains the sole canonical authoritative state. The state consumed and returned by the pure NPC Authoritative Commit module is a detached, nonauthoritative transaction projection, not a second game root or a live replacement capability.

Canonical NPC reaction plans and NPC commit idempotency records become fields of the existing authoritative `state.conversation` root. Existing players remain the sole stored NPC source; Commit participants are deterministically derived and are never persisted as a second participant registry.

Only a narrow engine-owned read/atomic-commit port may publish a prepared NPC reaction. Generic route-owned compare-and-swap, whole replacement with the Commit projection, route-side partial merge, and a second authoritative structured state are forbidden. See [NPC Authoritative State Integration Decision](docs/npc-authoritative-state-integration-decision.md).

## D-013: The Seer Claims Proactively at Day Start

D-004 is preserved in substance: night seer results live in the seer's `knownInfo` and are exposed only through a public claim registered by engine code; they are never copied raw into `publicInfo`.

The claim trigger is no longer ask-only. When a day begins after a night (`runNight`), a living seer NPC with results that are not yet public announces them proactively through the same claim-registration path as an ask-based claim. Only results about still-living players are announced proactively; results about dead players stay private unless the seer is asked directly. A result that is already public is never registered as a claim a second time, on either the proactive or the ask-based path.

## D-014: Providers May Select From Engine-Owned Candidate Actions

In addition to D-007's text generation contract, a provider may implement optional asynchronous `chooseAction(request)` for narrowly scoped decisions. The engine offers a closed list of legal candidates in a frozen cloned request, validates the returned candidate ID, and treats the selection as advisory. A missing method, provider error, or invalid selection falls back to the engine-designated safe candidate and is recorded only in developer diagnostics.

The engine remains the sole owner of all effects: it fabricates claim contents, registers claims, updates memory and state, and decides what is public. Decision requests contain public evidence plus only the acting NPC's own role and goals; they never reveal another player's role or private knowledge. The first use is the madman's optional seer counter-claim and later fake-result publication after a real seer's proactive day-start claim. D-007 is otherwise unchanged.

## D-015: Rescue Claims at Vote Time and Claim-Driven Suspicion

When the provisional tally inside `runVote()` would execute a living, not-yet-claimed seer, medium, or knight, that NPC makes a rescue claim before the execution is finalised, and the vote is re-cast. Rescue claims are engine-triggered (like the D-013 proactive claim), so conversation ask-policies do not gate them; their contents are fabricated by the engine from the claimant's own private knowledge only: all not-yet-public seer or medium results (including results about dead players), or a bare declaration when the claimant has no results yet, or for the knight, who has none. Each NPC can rescue-claim only once, because claiming marks them claimed. Werewolves and the madman do not rescue-claim in this slice.

A registered public claim now moves the other NPCs' suspicion, at every registration path (proactive, ask-based, fabricated, rescue). An uncontested claim is believed by default: suspicion of the claimant drops, and published seer results shift suspicion toward or away from their targets. A seer claim registered while another seer claim is already public is contested: suspicion of both claimants rises and the new claim's results count for less. This is what keeps a rescue claim from being automatically believed (真確定): after a rescue seer claim that publishes results, the existing D-014 madman decision runs before the re-vote, so a counter-claim can contest it. A bare rescue claim with no results does not trigger that decision, because there is nothing yet to contradict.

Only the final votes of a `runVote()` call are recorded and shown; provisional tallies exist only in developer diagnostics. `runVote()` is asynchronous because the madman decision may await a provider; all dispatch callers already await it.

## D-016: Broadcast Questions Ask Every Living NPC Once

The player may address the same question to every living NPC at once through the `ask_all` player action (browser "Ask All" button, CLI `ask-all`). The engine records the question once in the player log and public info (addressed to 全員） and applies question pressure exactly once, as if the question had been spoken once to the room; it then asks each living NPC in roster order through the ordinary per-NPC response path, so response composition, ask-based claims, and privacy boundaries are unchanged. Dead NPCs are skipped entirely. A broadcast therefore surfaces exactly the claims a round of individual questions would surface — an NPC claims only under its existing ask-path conditions (for example holding an unpublished result) — but costs the player one action instead of one per NPC. The structured interpreter/commit pipeline remains single-target; broadcast questions use the compatibility dispatch path like the other actions.

## D-017: Log Export Is a One-Way Download, Not Persistence

The browser's "Save Log" button downloads a plain-text export of the current game: the player log and vote record, built from the public snapshot, plus — only while Developer Mode is on — the developer snapshot (roles and internal state) and the full developer event log, built through `getDeveloperDiagnostics()`. The export is assembled by the pure builder in `public/logExport.mjs` and leaves the browser as a file download only; nothing is stored in the browser, on the server, or in the repository, and an exported file cannot be loaded back to resume a game. D-009 therefore stands unchanged: sessions are still not persisted. Developer sections are gated on Developer Mode so a normal export contains no hidden information (roles, known info, suspicion scores).

## D-018: The Player Holds One Simultaneous Vote

The player holds one vote, equal in weight to an NPC's (chosen by the user on 2026-11-13 over a tie-break-only vote and a suspicion-score nudge). Voting is simultaneous: NPC votes are computed from their own suspicion scores exactly as before and never react to the player's vote, which removes the bias pathway the user was concerned about. The player casts through the `cast_player_vote` action or by passing a target with `advance_vote` (browser: a target selector beside the Vote button; CLI: `vote [<npcId|name|alias>]`). The vote is recorded in the round's vote list as voter `player` （あなた） and counts in the tally; ties still resolve by aggregate NPC suspicion. When a rescue claim (D-015) fires while the player holds a vote, resolution pauses (`revoteRequired`) so the player may change their vote before the re-cast — the claim, its suspicion effects, and any madman decision complete first, and the night cannot start mid-vote. Without a player vote, rescue claims keep resolving inside a single `runVote()` call as before. The pending vote lives in game state (`playerVoteTargetId`, `voteResolutionPending`), not in the public snapshot; the structured interpreter path does not originate votes.

## D-019: Werewolves May Make Engine-Fabricated Seer Claims

In the `village9` scenario, the first living werewolf in roster order may use the existing provider-selected action contract to counter a newly published genuine seer result, extend its existing fake claim after a later proactive result, or claim first at day start while no public seer claim exists. The werewolf decision precedes the madman's corresponding decision. Only one werewolf may claim seer per game, and an existing claimant alone may publish follow-up results while alive.

The engine validates every selection, safely falls back to silence, fabricates and registers all public contents, and keeps fake provenance in private/developer records. A werewolf fabrication never calls a werewolf a werewolf, although it may contradict a genuine black result on a werewolf with a white result. Decision requests contain public evidence and only the acting werewolf's own role and goals; they never reveal the other werewolf or the real seer's status. Default and `sample` scenarios remain unchanged.

## D-020: Knight Claims Publish Guard History and May Be Contested

A genuine knight claim publishes every guard record accumulated by that knight, in night order, while the records remain private and non-shareable before a claim. In `village9`, the first living, wholly unclaimed werewolf may make one engine-fabricated knight claim after a no-victim night or counter a rescue claim. Fabrication is deterministic and consistent with public deaths; a living unclaimed real knight alone may then choose whether to counter. Knight-versus-knight claims use the contested claimant suspicion rule but guard entries never act as seer results. All new choices use D-014 safe-silence fallback and preserve the no-double-role-faking rule.

## D-021: A Fake Seer Claim Never Divines Its Own Claimant; the Shape Is Chosen When the Faker Is Blacked

A fabricated seer claim never contains a result about its own claimant: a genuine seer cannot divine themselves, so a self result is an impossible claim that exposes the fake immediately. Previously the fabrication mirrored the triggering claim's newest black into a white on the same target, which produced exactly such a self result whenever the player who had just been blacked counter-claimed — the most common counter-claim situation, first observed in the user's 2026-11-15 real-AI playtest.

When the triggering claim's newest result is a werewolf result on the deciding player himself, the D-014 counter-claim and follow-up decisions for the madman and the werewolf offer two claim shapes plus silence instead of the single default shape: accuse (the fabricated newest result blacks the claimant who blacked him) or deny (the fabricated claim publishes white results only and mentions neither the claimant nor the accuser). The provider selects among the engine-offered candidates as usual, with the same safe-silence fallback; the pseudo provider deterministically prefers accuse. The engine still fabricates and registers all contents, and a werewolf's accuse shape never blacks a werewolf (it falls back to the deny fabrication engine-side). In every other situation the candidate sets and fabrication are unchanged.

## D-022: With a Knight Claim Public, the Werewolf Chooses Whether to Attack the Claimant

Under the previous targeting rule (a living claimed seer first, otherwise the acting werewolf's lowest-suspicion candidate) a knight claim never influenced the attack, so a claimed knight was effectively untouchable at night — and a knight can never guard themselves, so the claim carried no night risk at all (observed in the user's 2026-11-15 real-AI playtest, where the claimed knight was passed over on both nights).

In `village9`, on a night when at least one living player other than the acting werewolf holds a public knight claim, the acting werewolf gets a D-014 decision (`night_attack_target`) before the attack: one candidate per knight claimant (`attack_knight_<playerId>`) plus `attack_as_usual`, which keeps the previous rule unchanged. The provider selects; any failure falls back to attacking as usual, and the pseudo provider deterministically attacks the first claimant. The decision request contains public claims and only the acting werewolf's own role — the night's guard target is private and never shared. A claimant may be a fake (a werewolf), and werewolves do not know each other in this engine, so attacking a claimant can hit the partner; that friendly-fire risk is accepted as a natural consequence of the hidden-partner rule. Nights without a knight claim make no decision call and behave exactly as before.

## D-023: The Medium Publishes Proactively Only in a Decisive Situation

The medium previously surfaced results only when asked or when rescue-claiming, so a game-deciding medium result could stay buried for the rest of the game (the user's 2026-11-15 playtest: the medium privately held a werewolf result on the previous day's executee and had no way to volunteer it). Mirroring the seer's unconditional morning publication was rejected: most medium results merely confirm an ordinary execution, and claiming for them would expose a power role every morning for little gain.

In `village9`, at day start after the seer-claim decisions, the living medium gets a D-014 decision (`medium_proactive_claim`: `claim_medium` / `stay_silent`) only when a decisive situation holds: an executed player had been blacked by a public seer claim registered no later than the execution day, and the medium still holds that result unpublished. A white result then exposes the claiming "seer" as fake; a black result corroborates the claim. Publication reuses the ask-path medium claim (all unpublished results, same wording and registration), the pseudo provider deterministically publishes, and provider failures fall back to silence. Decision requests carry the triggering public seer claim and the medium's own village-aligned goals. Mornings without a decisive result make no decision call and behave exactly as before.

## D-024: Direct Result Questions Reach the Claim Path for Claimed Players

Claim disclosure was gated on role keywords in the question ("占い師", "霊媒師", "騎士", "CO", ...), so asking an already-claimed player directly for a result — "霊能結果を教えて", "GJ先教えて" — never reached the claim builder, and fresh results or guard history stayed unpublished even though the player had already claimed publicly (observed in the user's 2026-11-15 playtest). For a responder who already holds a public claim, result-seeking phrasing (結果, GJ, 護衛, 守った, 占った) now also runs the claim builder; when nothing fresh remains, the question falls through to the ordinary answer branches instead of the claim deflection. Unclaimed players are unaffected: a direct result question alone never forces a first claim.

## D-025: A Medium Result That Disproves a Seer Claim Undoes Its Suspicion Shifts

*Superseded by D-028.*

Claim registration now records the exact suspicion deltas a seer claim applies (the claimant shift, contested-claim rival bumps, and per-result shifts, per observer) in `state.claimEffects`. Medium results are always genuine — no role fakes the medium — so when a medium claim registers a result that contradicts a public seer claim's result for the same target, that seer claim is proven fabricated: every recorded shift is inverted for living observers, exactly once per claim, a `claim_disproven` developer event is logged, and a player-log line states which seer result was shown to be wrong. A medium result that agrees with the claim changes nothing, and other claims' shifts are untouched. This resolves the consideration item the user raised on 2026-11-13.

## D-026: Answers About One Player Also Name the Vote Intention

In the user's 2026-11-15 playtest, several NPCs answered a leading question about the seer with "Ema is suspicious" and then all voted for the seer-blacked Beni. The votes were exactly the suspicion math (Beni was every voter's top score); the answers were the loose end: a mentioned-target answer evaluated only that player, while the NPC's actual vote intention — the top suspect, ranked by the very same calculation the vote uses — never entered the utterance materials, so the discussion never surfaced who each NPC actually meant to execute. When a mentioned-target answer's target is not the responder's top suspect, the engine's base text now appends the top-suspect sentence (the same wording other answer branches already used), and the OpenAI provider instructions gained a vote-intention rule: when the discussed player differs from `context.topSuspect`, phrase the answer so the vote intention is clear (e.g. "X is suspicious too, but today I want to execute Y"), in the NPC's own personality and tone, never contradicting the vote. Vote selection itself is unchanged.

## D-027: A Disproven Claim Also Raises Suspicion of the Claimant

*Superseded by D-028.*

D-025's reversal alone proved insufficient in the user's 2026-11-15 playtest: the medium publicly proved the werewolf's seer claim fabricated on the morning of Day 3, the reversal duly restored every score to its pre-claim baseline — and the proven liar was then treated as an ordinary gray. Quieter citizens out-scored her in the aggregate tiebreaks on Days 3 and 4 and were executed instead; the liar survived and the werewolves won. A proven lie is itself evidence, so the disproof now also adds a fixed suspicion penalty toward the claimant: when `reverseDisprovenSeerClaims` marks a claim record disproven, every living observer except the claimant gains +4 suspicion of the claimant — the same scale as one black seer result — exactly once per disproven claim, alongside the reversal. The penalty is recorded on the `claim_disproven` developer event as `liarPenalty`. Dead observers gain nothing (the reversal already skips them), and the claimant's own scores are untouched.

## D-028: Fake Medium Claims Use Symmetric Public Contradictions

**Supersedes D-025's reversal and D-027's liar penalty.** In `village9`, the first eligible living werewolf and the living madman may fake-claim medium at the same counter, pre-emptive, follow-up, and rescue decision points used by other controlled fakes; the werewolf decides first, one claimant of each kind is allowed, and an actor can hold only one claimed role. Providers decide only whether to act, with safe-silence fallback. The engine fabricates every executed player's result, contradicting the earliest public seer result when present and otherwise inverting truth, preserves published results, and caps each fake medium at one black with contradiction-driven blacks taking priority.

Because medium claims are no longer certainly genuine, a published disagreement involving a medium is a neutral dispute rather than proof. Each living claimant is charged +4 suspicion by every other living NPC once per disputed target; late joiners are charged when they join, dead claimants are recorded but not charged, agreements do nothing, and earlier claim effects are never reversed. State records involved and charged claimant ids per target, the player log neutrally announces a newly active disagreement once, and `claim_contradiction` records its public participants and newly charged claimants. Medium claims also use the ordinary contested-role +2 rule.

## D-029: Claimed Players Maintain Their Claims on the Ask Path

The ask-path claim builder (D-024) builds only from the responder's real role and genuine records, so a fake claimant — whose fabrication was wired only into the day-start and rescue decision points — could never publish when asked directly. In the 2026-11-16 self-play playtest (Muse playing as the player), a werewolf who had fake-claimed knight was asked for the previous night's guard target on two consecutive days and answered both times with the pre-claim deflection ("今は役職COを急ぎません"), although she already held a public claim and fresh nights had passed; she was executed on that tell. Genuine claimants publish fresh results when asked, so the deflection cleanly separated fake from genuine and undermined every fake-claim slice (D-019, D-020, D-028).

Claim maintenance now runs on the ask path under the same gate as D-024 (a role keyword in the question, or result-seeking phrasing toward a claimed responder). When the real-role builder produces nothing for a claimed responder, a fake claimant extends the claim through pure builders that mirror the decision points' engine-owned fabrication: the knight fills unpublished nights from the attack log under the same per-night rules (published entries never change; the full history is re-registered exactly like the genuine knight's), the seer engages the newest published result of another claimant that it has not answered yet (D-021's deny shape when that result blacks the claimant himself), and the medium covers unpublished executions with the earliest-seer contradiction, truth inversion, and D-028's one-black cap. When nothing fresh remains for any claimed responder, the answer restates the already-published results and registers nothing, so no suspicion effect is applied a second time. Unclaimed players keep the existing deflection, and a genuine claimant with fresh results behaves exactly as before.

## D-030: Personality Supplies a Narrow Strategy Lean

In `village9`, one shared top-suspect selector serves both vote selection and response construction. It preserves the existing suspicion scores and name-order ties, but may switch between a living public role claimant and a gray candidate within four points. Gray candidates have no public role claim and no public seer or medium werewolf result against them. Public results remain relevant even after their claimant dies; self and dead targets are excluded. A blacked, unclaimed raw leader is neither side and never triggers a switch.

The sole preference accessor, `strategyLeanFor(npc)`, in Phase A (merged in PR #101) mapped cautious/logical to roller, direct to gray, and calm/soft to neutral, independently of role. This is a staged implementation: the accessor can later read individual NPC settings without changing vote or reply consumers. Scores, claim decisions and fabrication, night actions, and five-player behavior remain unchanged.

Recognized strategy questions receive an explicit agreement or disagreement and the adjusted vote target. Matching lean implies agreement; otherwise the adjusted target's side decides. Gray detection uses グレー or CO者/占い師/霊媒師/騎士 together with ほっとく/放置; roller detection uses ローラー, 両方吊る/両方を吊る, or CO者から吊る. Mixed directions and contextless 詰める/放置 fall through to ordinary replies. D-024/D-029 claim publication and maintenance take precedence. This keeps D-026's stated vote intention and actual selection aligned without changing D-014 action authority or D-028 suspicion effects.

### Phase B: Individual NPC settings (2026-11-17, in review)

Phase B supersedes only the Phase A speech-style mapping above. Each DEFAULT_PLAYERS entry now owns a strategyLean setting, copied into runtime player state by the existing template spread. The sole resolver, strategyLeanFor(npc), reads that setting and defaults to neutral when it is absent, including custom NPCs. This decouples strategy preference from speaking style without changing any vote or reply consumer.

The final assignment is the user decision of 2026-11-17; specifically, Beni is roller and Fumi is neutral.

## D-031: Fabricated Results Never Exceed the Nights That Have Passed

A fabricated seer claim's published results, counted across all of the claimant's public seer claims, never exceed the number of nights that have passed (`day - 1`) — the same total a genuine seer can hold. The cap is enforced at both publication sites that could previously exceed it: the ask-path fake seer extension from D-029 (which minted one new result per qualifying question, with no budget check) and the follow-up branch of the engine's fabricated seer registration (which added one result per decision without checking the cumulative total). The initial fabricated claim already sized its white fillers to the same budget and is unchanged.

When the budget is spent, the ask path falls back to the D-029 restatement of the already-published results (the user decision of 2026-11-22: restate, matching a genuine claimant asked twice on the same day), and a follow-up decision simply publishes nothing. The ordinary cadence is preserved: one new fabricated result per night remains possible, so the pressure a fake claim exerts is unchanged; only same-day extras and stacked publication paths are refused.

Fabricated medium results are bounded by completed executions and fabricated knight results by attacked nights, so both already satisfy the same invariant by construction; regression tests pin the invariant for all three roles. Found in the user's 2026-11-22 playtest, where a madman published three seer results on day 2 — an impossible count for any seer — and then verbally defended the impossibility when asked.

| NPC | Name | Strategy lean |
| --- | --- | --- |
| npc1 | Aoi | neutral |
| npc2 | Beni | roller |
| npc3 | Chika | gray |
| npc4 | Daichi | roller |
| npc5 | Ema | roller |
| npc6 | Fumi | neutral |
| npc7 | Gaku | gray |
| npc8 | Hana | gray |
| npc9 | Itsuki | gray |

The roster has three roller, four gray, and two neutral NPCs. The four-point boundary, candidate eligibility, village9-only behavior, strategy replies, D-026 consistency, suspicion scores, CO decisions and fabrication, night actions, and five-player behavior remain unchanged.

## D-032: Persuasion — NPCs Decide Whether to Take Up an Assertion

User-approved on 2026-11-22: Q1=B (AI decides whether to accept), Q2=A (scores only), Q3=B (NPC declarations also sway others). Previously a player's reasoning such as “Beni is confirmed white” could not change an NPC's position. Both five-player and village9 games now offer the D-014 accept_persuasion / reject_persuasion decision to eligible listeners. The engine conservatively recognizes one mentioned player and one keyword direction; multiple targets or mixed white/black keywords are ignored. It never checks whether the assertion is true.

After unchanged question pressure and before replies, a player assertion reaches the addressed living NPC, or all living NPCs in a broadcast, excluding the assertion target. Acceptance shifts suspicion by -2 for white or +2 for black. Decisions, including rejection and fallback, are capped per listener/day/target/direction to prevent repeated asks from rerolling acceptance. Application and exchange results live in game state so working-copy actions retain them. Matching same-day exchanges may acknowledge acceptance or resistance when the target was the listener's lean-aware top suspect before the shift. Claim maintenance and strategy replies retain priority.

After all broadcast replies, engine-owned vote declarations may sway other living NPCs by +1, once per listener/day/target, independently of player assertions. Targets are deduplicated in response order (the first declarer supplies the public source), must be within four points of the listener's highest current eligible score, and cannot be the listener or their existing lean-aware top suspect. The margin is shared with D-030. Only response-builder metadata supplies declarations; provider wording is never parsed, acknowledgments never declare, and wave decisions cannot cascade.

Frozen detached requests contain the public assertion, target and source plus only the listener's own role and goals. Missing methods, errors and invalid choices safely reject; the pseudo provider's preferences remain unchanged and therefore reject. Engine code owns all effects and the single persuasionShiftFor accessor owns magnitudes. Persuasion state is excluded from public snapshots, with decisions and applied shifts recorded in developer logs. The mechanic lets conversation influence votes without allowing providers to edit game state or turning player assertions into verified facts.

## D-033: Board Assessment — Observers Decide the Execution Order for Contested Claim Groups

User-approved on 2026-11-22: Q1=A (words plus a close-call vote switch), Q2=A (seer and medium groups), Q3=A (all observers, with vote-time fallback). The playtest-22 village executed the white-result counter-claimant because claim registration order made her more suspicious. Observers should also be able to weigh the public board: a black-result medium has already supplied key information, making execution first a reasonable option even if genuine.

Engine code detects groups with at least two living claimants of the same role and opposing published results on the same target. Three-way groups are supported; knights are excluded. A public-only digest lists claimant names and published results, public target status (with a sibling `day` for executions), distinct banked blacks, the scenario's public wolf count minus banked blacks (floored at zero), and medium-only unpublished executions. It makes no recommendation and never reads hidden roles or private results.

Each living non-member observer may choose `execute_first_<claimantId>` or `no_preference` through D-014 once per role per day. Frozen detached requests contain the digest and only the observer's own role and persuasion-aligned goals. Errors, invalid choices, and missing methods record a developer-only fallback to no preference. The pseudo provider's preference list is unchanged, so its unsupported silence choice also safely falls back. Assessments live in `state.boardAssessments`, keyed by observer and role, to survive working-copy actions; they are excluded from public snapshots.

Direct asks (including the structured interpreter path) assess only the addressee after pressure/persuasion; broadcasts assess all eligible observers before replies. Voting assesses eligible voters before the initial cast and before rescue-claim re-casts, including a later player-triggered re-vote. The shared selector applies assessment after D-030's lean adjustment: it may switch only between members of the same active group, within `SWAY_MARGIN` (four points), without editing scores. A matching assessed top claimant with a banked black produces the approved execution-order reply and engine-owned vote declaration. Claims, strategy proposals, and D-032 acknowledgments retain priority. Both village9 and five-player seer conflicts use the same path.

## D-034: Yakuza Cast Selection and Voice Materials

User-requested on 2026-11-24; Slice 1 is in review. A twelve-character Yakuza-inspired roster replaces the generic NPC cast. Game creation chooses an explicit ordered list, or ordered pinned members followed by seeded random draws without replacement, or the first roster members when neither is supplied. Village9 uses nine slots; default and sample use five. Ordinary roles attach to selected slot order; the sample retains its per-id role and suspicion tables.

Each character owns a standard appellation, aliases, personality, voice profile, speech style, strategy lean, and address rule (plain or san) with per-pair exceptions and an optional nuance note. Utterance requests pass voiceProfile, callName and resolved addressForms for every other participant, including dead players, as provider materials only. Decision requests do not receive these additional materials. These public flavor fields are not added to the public snapshot. Engine code still owns all state, claims and votes; D-007 and D-014 are unchanged.

This supersedes only D-030 Phase B's character/lean assignment: npc1 neutral, npc2 gray, npc3 roller, npc4 neutral, npc5 neutral, npc6 gray, npc7 gray, npc8 gray, npc9 neutral, npc10 roller, npc11 roller, npc12 roller (four of each). The strategy resolver and all claim, persuasion and board-assessment logic remain unchanged. The roster and pairwise addresses provide consistent characterization without coupling speech to game authority. Slice 2 will add cast selection UI; until then the web game uses the first nine or five roster members.

## D-035: Claim Announcements Use Per-Character Set Phrases

Decided on 2026-11-25 after the first real-AI game on the voice-fixed build: two different characters' seer claims were word-for-word identical, because claim announcements are engine-published texts that never pass through provider composition. The user chose per-character set phrases over routing claim texts through the LLM (which would add cost, latency and failure modes to every claim) and over leaving the announcements canonical.

Each roster member now carries `claimVoice`: an opening sentence per role (seer / medium / knight), a follow-up lead per result role (seer / medium), a closing sentence for an initial seer claim, and a sentence ending for the result lines (e.g. だ / や / だな / だよ / だね, with です kept for the polite members), so the result sentences themselves also speak in the claimant's register while their wording — the part compared across claims — stays identical. Every claim-text builder — proactive, rescue, ask-path genuine, fabricated (engine and ask path), and restatements — assembles its text as set phrase + canonical result lines, so results stay unambiguous and parseable while the announcement speaks in the claimant's voice. NPCs without claimVoice data keep the previous canonical texts, so legacy fixtures and custom casts are unchanged.

The same playtest produced two instruction-level fixes in the OpenAI provider: names appearing inside baseText or topSuspect must be replaced with the addressForms form when speaking (the model copied the written name, which bypassed the address table in suspect mentions), and the direction of a decided stance must not be softened or flipped (a strategy reply that agreed with a proposal was composed as a hedged refusal while still naming the proposal's vote target).
