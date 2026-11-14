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
