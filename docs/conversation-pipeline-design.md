# Structured Conversation Pipeline Design

## 1. Executive decision summary

- **Decision:** Replace the current natural-language-centered conversation pipeline with a session-local, single-owner structured-event pipeline.
- **Rationale:** The current system allows divergence between displayed NPC utterances and the underlying game state. Moving authority for state changes and claim generation into the active session's `WerewolfGame` instance ensures that all game actions are explicitly validated and recorded before being rendered as natural language.
- **Rejected alternative:** Server-side authoritative state. This was rejected because it would require a complete rewrite of the `WerewolfGame` engine and the HTTP layer, violating the goal of preserving the existing browser-based engine and simple proxy server.
- **Consequences:** A web session is owned by its active browser-process `WerewolfGame`; a CLI-local session is separately owned by its active CLI-process `WerewolfGame`. They never co-own or replicate one active session. The server remains a stateless proxy for AI providers.

## 2. Current architecture analysis

### Execution Boundaries (Verified Repository Facts)

- **Authoritative State Holder:** The `WerewolfGame` class in `src/gameEngine.mjs`. In the browser application, the game instance is held in the `game` variable within `public/browserApp.mjs`.
- **Game Instance Creation:** `WerewolfGame.create()` is called in `public/browserApp.mjs` (for the UI) and `src/cli.mjs` (for the CLI).
- **Player Input Entry Point:** `WerewolfGame.dispatchPlayerAction()` receives actions from the UI or CLI.
- **Server Role:** `src/webServer.mjs` acts as a stateless proxy for AI requests via the `/api/npc-response` endpoint. It performs HTTP and JSON schema validation (`src/validator.mjs`) but holds no game state (no current turn, no roster, no claims).
- **Session Management:** `SessionManager` in `public/httpResponseProvider.mjs` manages browser-side request lifecycles. It uses `AbortController` to cancel pending requests when a new game starts and prevents stale responses from updating the current game UI (`isCurrentGame`). It does NOT represent a server-side game session.

### Current Conversation Flow (Verified Repository Facts)

1.  **Input:** `browserApp.mjs` calls `game.dispatchPlayerAction({ type: 'ask_npc', targetId, input })`.
2.  **Processing:** `WerewolfGame.handlePlayerQuestion` (`src/gameEngine.mjs`):
    - Sets phase to `player_question`. (**State Mutation**)
    - Appends to `playerLog`. (**State Mutation**)
    - Calls `applyQuestionPressure(questionText)`, which immediately updates `npc.suspicionScores` based on keyword matching. (**State Mutation**)
    - Calls `buildNpcResponseRequest(npc, gameState, playerInput)` in `src/responseGenerator.mjs`.
3.  **Plan Generation:** `buildNpcResponseRequest` classifies intent via `classifyIntent` (regex/keyword matching) and **pre-creates** a `publicClaim` object and a `responsePlan.baseText`.
4.  **Provider Call:** `public/httpResponseProvider.mjs` sends the request to `/api/npc-response`.
5.  **Server Validation:** `src/webServer.mjs` uses `validateNpcResponseRequest()` in `src/validator.mjs` to check the envelope.
6.  **AI Rendering:** The AI provider (e.g., `src/openaiProvider.mjs`) paraphrases the `baseText` into natural Japanese.
7.  **Completion:** `handlePlayerQuestion` receives the AI text.
    - Appends response to `playerLog` and `publicInfo`. (**State Mutation**)
    - **Registration:** If a `publicClaim` was generated in Step 3, it is registered in `npc.publicClaims` and `publicInfo`. (**State Mutation**)
8.  **Divergence:** The `publicClaim` is registered even if the AI output fails to express it. The `utteranceGuard.mjs` validator is **not currently used** in the production flow.

## 3. Confirmed problems

1.  **Inconsistency:** Claims are registered in the game state based on an engine-generated plan, not the actual text displayed to the user.
2.  **Shadow Claims:** The AI can express unauthorized claims that are not registered in the game state.
3.  **Fragile Intent Detection:** suspicion updates and intent classification rely on brittle keyword matching in raw natural language.
4.  **Premature Mutation:** State changes (suspicion, logs) occur before the AI response is validated or even successfully returned.

## 4. Scope and non-scope

- **In Scope:** `SpeechActCandidate` schemas, AI Interpreter/Renderer contracts, and validation/atomicity logic in the session-local game engine shared by browser and CLI execution.
- **Out of Scope:** Moving the game engine to the server, adding server-side persistence, changing core game rules (roles, phases). Experimental free-form AI commentary (Natural language generation) is currently out of scope to ensure authoritative consistency.

## 5. Terminology

- **SpeechActCandidate:** An untrusted, structured interpretation of natural language produced by the AI.
- **AcceptedSpeechAct:** An engine-validated and bound communication event that represents an authoritative action.
- **NpcReactionPlan:** Structured instructions from the engine to the AI for selecting a response.
- **CanonicalClaim:** The single source of truth for a role or result claim.
- **Controlled Commentary:** Non-state-changing NPC reactive speech where the AI selects from engine-approved variants instead of generating raw text.
- **PlayerInputRecord:** Immutable record of the player's original natural-language utterance.
- **PlayerUtteranceDisplayPlan:** Authoritative plan for rendering player input segments.
- **Logical turn:** One engine-accepted top-level game command and its directly caused player-conversation and NPC-reaction work. It is not a game phase, provider request, UI interaction count, or werewolf day/night round.
- **Authoritative transaction:** One browser-engine compare-and-set boundary that either publishes its complete mutation set and one state-version transition or publishes neither.
- **Pending runtime state:** Abort, retry, timeout, and correlation state that is session-local and non-authoritative.
- **Logical reaction:** One engine-planned NPC reaction for one exact trigger, identified by `reactionPlanId`; it may own multiple provider attempts but commits at most once.
- **Reaction attempt:** One provider invocation under a logical reaction, identified by a fresh `reactionAttemptId`; an attempt is never reopened after reaching a terminal status.
- **Reaction tombstone:** A bounded, session-local, non-authoritative terminal identity summary used only to reject late or reused reaction/attempt identities after active coordinator cleanup.
- **Route snapshot:** The immutable structured-or-legacy route selected when one logical reaction starts; a later feature-flag value does not rewrite it.
- **Emergency cancellation:** An explicit operational cancellation of one active logical reaction, distinct from changing the deployment feature flag.

## 6. Responsibility boundaries

### Session-local Game Engine (Authority)
- Exactly one active `WerewolfGame` instance owns one active game session and is its sole runtime owner and writer of authoritative turn IDs, turn order, and state versions.
- In web execution, that owner is the active instance in the browser process. In CLI execution, it is the active instance in the CLI process for that separate CLI-local session.
- Browser and CLI instances never co-own, replicate, or reconcile the same active game session. The server, observers, and history readers never arbitrate or acquire this authority. Cross-process single-session authority is outside this design.
- Validates `SpeechActCandidate` against game rules, phase, and roster.
- Generates `AcceptedSpeechAct` and `PublicEvent` only after successful validation.
- Performs atomic state updates (claims, suspicion, history).
- Generates `NpcReactionPlan` (discriminating between `canonical_only` and `controlled_commentary`).
- Manages idempotency and stale response detection using `requestId` and `turnId`.
- Owns all displayable text variants (`ControlledCommentaryVariant`) and templates.
- During Phase 2 only, owns a separate runtime-only `ShadowInterpreterBinding`. Its shadow turn and snapshot version are transport-observation identities, never authoritative game metadata, and are replaced by engine-owned turn/state versions before Phase 3 begins.

### Server (Proxy)
- Proxies requests to AI providers.
- Validates HTTP request/response envelopes.
- Normalizes errors (timeouts, provider failures).
- Does NOT validate game rules or maintain session state.

### AI (Interpreter & Renderer)
- **Interpreter:** Natural language -> `InterpreterModelOutput`.
- **Renderer:** `RendererRequest` -> `RendererModelOutput` (Selects `variantId` and `version`).
- Does NOT decide legality or mutate state.
- Strictly prohibited from generating natural-language text for in-world display.

## 6A. Authoritative turn and state-version lifecycle

This section is normative. It defines the baseline used by Phase 3 and every later structured-conversation phase. Existing compatibility code that does not yet expose these counters is a migration input, not an alternative definition.

### Ownership and identity domains

Each `WerewolfGame.create()` call creates one new game session with exactly one active owner instance. The instance stores exactly one `gameSessionId: ID`, `turnId: ID`, `turnOrder: non-negative safe integer`, and `stateVersion: non-negative safe integer`. Only engine methods executing a top-level command or an authoritative transaction may replace `turnId`, advance `turnOrder`, or advance `stateVersion`. Browser/CLI adapters, `SessionManager`, HTTP providers, the server, provider adapters, AI output, observers, and history readers may copy approved projections but never create, normalize, increment, infer, replicate, or reconcile authoritative values. The server and providers treat them as opaque request metadata.

The three identity domains are disjoint:

- `gameSessionId` identifies one `WerewolfGame` lifetime and rejects responses from a destroyed/reset game.
- `turnId` identifies one logical turn within that session. It satisfies the existing `ID` contract and is session-unique, opaque, and non-ordered.
- `stateVersion` is a numeric compare-and-set guard over authoritative state. It is not an ID.

Ordering uses engine-owned `turnOrder`, never lexical `turnId` comparison. `turnOrder` starts at `0` for the setup turn and increases by exactly one when a new top-level command is accepted. It is internal metadata in this schema baseline; existing records continue to carry `turnId`. Neither timestamps, array indexes, object identity, request counts, UI actions, phase names, nor Phase 2 counters may supply any authoritative identity or ordering.

`ShadowInterpreterBinding.sessionId`, `shadowTurnId`, and `shadowSnapshotVersion` remain a separate Phase 2 transport-observation domain. A Phase 3 implementation discards that binding and captures fresh engine values. It never converts, copies, aliases, seeds, compares, or continues a shadow counter as an authoritative value.

### Logical-turn boundary

The setup turn is allocated during `WerewolfGame.create()` after the initial state has been assembled and before the instance is exposed. Its `turnOrder` is `0`; its opaque `turnId` is newly generated by `WerewolfGame`; and its `stateVersion` is `0`. Initial role assignment, roster construction, and setup records are the construction of version `0`, not transitions from an earlier version.

After setup, the engine allocates a new logical turn when it accepts one top-level command for execution: a player input, vote command, night command, or another game-progression command. Rejected commands (unknown action, invalid target, command after game end) allocate no turn. One logical turn contains the accepted command, its phase transitions and core game-rule transactions, and, for a structured player input, its `PlayerConversationCommit` and directly caused `NpcReactionCommit`. The player and NPC commits therefore share one `turnId` even though they have distinct state-version transitions.

The logical turn becomes terminal when its top-level command has no remaining authoritative transaction to prepare or commit. For a player conversation this is after the NPC reaction commit succeeds or is definitively skipped/rejected; Renderer work is not authoritative and does not keep the turn open. For vote/night/game-progression commands it is after the command's final authoritative transaction. A terminal turn remains the instance's last `turnId` until another command is accepted; termination alone changes neither ID nor version.

Only one non-terminal top-level command is accepted per game instance. A concurrent second input is rejected as `input_in_progress`; it does not allocate IDs or mutate state. A clarification continuation remains in the same logical turn and stages a new request/input identity against the unchanged turn/version. Invalid Interpreter output, candidate rejection, clarification, timeout, abort, provider error, stale discard, retry, duplicate response, and idempotent replay never allocate or advance a turn. Phase transitions within an accepted command never allocate a turn. A reset destroys the complete identity domain; a new game starts a new setup turn with unrelated session/turn IDs and version `0`.

### State protected by `stateVersion`

`stateVersion` protects the complete browser-authoritative game-rule and structured-conversation state that can affect legality or later authoritative results: game phase/day/winner; participant role/team/life status; roster membership; vote/execution/night/seer/attack results; internal suspicion and authoritative memory/history; committed `PlayerInputRecord`, `AcceptedSpeechAct`, `CanonicalClaim`, semantic `PublicEvent`, reaction plan and commit result registries; idempotency records; the single shared canonical publication registry; its existing `state.conversation.nextPublicationSlotOrder` and `state.conversation.nextRecordAppendOrder` counters; and other data applied by an authoritative transaction. A change to any protected member must occur inside one authoritative transaction.

The following are outside that compare-and-set state and never increment `stateVersion`: pending/request controllers and retry timers; staged-but-uncommitted input; provider responses; diagnostic observations; developer-only metrics; DOM/CLI sink delivery order; Renderer request/provider/retry/timeout/abort/result/selection/fallback processing; acknowledgement and receipt order; retry-delivery sequence; UI-history append position; observer-delivery sequence; DOM/UI state; transport/session bookkeeping; and caches derived solely from authoritative records. These delivery/Renderer/acknowledgement orders are not the canonical publication registry counters, share neither field nor counter with them, and cannot be cross-checked against them. A canonical publication record stores its authoritative slot/record order and originating version as provenance; its `recordAppendOrder` is not evidence that a DOM/CLI sink appended anything. Renderer success, fallback selection, and later delivery create no authoritative mutation or version transition. A future Phase 7 append of `NpcUtterancePublicationFinalized` is a separate authoritative copy-on-write transaction: success appends one record, increments `state.conversation.nextRecordAppendOrder` once, leaves `nextPublicationSlotOrder` unchanged, and follows the general rule of exactly one `stateVersion` increment. Its exact input/result/idempotency/CAS API remains a separate Phase 7 docs prerequisite.

Every successful authoritative transaction compares its recorded precondition with the engine immediately before publication, applies all protected mutations atomically, and advances `stateVersion` from `N` to exactly `N + 1`. Object count and act count do not alter that increment. A failed compare, validation failure, thrown application, or rollback publishes no object, counter, phase, history, or idempotency change and leaves version `N`; version gaps are prohibited. Values must remain `Number.isSafeInteger`; a transaction at `Number.MAX_SAFE_INTEGER` is rejected with `state_version_exhausted` before mutation. Future persistence restores the stored session ID, turn ID/order, state version, protected state, and commit results exactly; replay never recomputes counters.

### Mutation classification

“Turn advance” below means allocation of a new logical turn when the command is accepted. “Version advance” means one successful authoritative transaction, not one field write.

| Operation | Authoritative | Turn advance | Version advance | Boundary and stale effect |
| :--- | :---: | :---: | :---: | :--- |
| New game creation | yes | setup turn | initialize to `0` | creates a new identity domain; all older responses are stale |
| Player input capture/staging | staged only | once for a new command | no | engine captures one turn/version/phase binding; clarification continuation reuses the turn |
| Interpreter request/retry/response receipt | no | no | no | pending runtime work; retries reuse the exact binding |
| Candidate validation success/rejection or clarification | no | no | no | diagnostic outcome only in Phase 3 |
| Timeout, abort, provider error, or stale discard | no | no | no | terminalizes pending; late responses are discarded |
| Player conversation commit | yes | no | exactly one | CAS `N -> N+1`; all player-commit objects publish together |
| Duplicate player commit replay | no new mutation | no | no | returns stored result; changed fingerprint is conflict |
| Phase 4 OFF legacy player/NPC compatibility command | yes | no | exactly one | existing combined compatibility transaction `N -> N+1`; no structured player objects |
| Phase 4 ON player-side compatibility effects | yes | no additional turn | with player conversation commit | legacy player-input log/history delta is included in the same atomic `N -> N+1`, never a second transaction |
| Phase 4 ON legacy NPC compatibility effects | yes | no additional turn | exactly one after player commit | provisional reaction transaction `N+1 -> N+2`; includes response and existing NPC-side effects until their owning migration phase |
| NPC reaction preparation | staged only | no | no | captures player-resulting version as precondition |
| NPC reaction commit | yes | no | exactly one | independent CAS `N+1 -> N+2` in the same turn |
| Renderer request/retry | no | no | no | bound to committed reaction version |
| Renderer result/selection/fallback processing | no | no | no | nonauthoritative; never appends a record by itself or changes reaction authority |
| Canonical publication insertion | yes, with containing commit | no | no additional transition beyond containing commit | canonical record and canonical slot/record counters publish in the same player/reaction authoritative transaction |
| Delivery, acknowledgement, receipt, or UI append | no | no | no | nonauthoritative order domains; never change or prove canonical publication order |
| Future Phase 7 authoritative finalization-record append | yes | no | exactly one on successful standalone append | reuses reserved slot, increments record counter once; replay/conflict/failure increment zero; exact Phase 7 API deferred |
| Diagnostic observation append | no | no | no | cannot affect stale comparison |
| Phase transition | yes | no | with its containing transaction | never increments separately inside that transaction |
| Vote commit | yes | once for its command | exactly one | vote effects and directly coupled execution, if any, are one command transaction |
| Execution | yes | no when caused by vote; otherwise once for its command | with containing transaction | no second increment when atomically coupled to vote |
| Night action and resulting day transition | yes | once for night command | exactly one | seer/attack/win/day effects publish as one command transaction |
| Standalone day transition or game end | yes | once only if separately commanded | with containing transaction | no extra increment when part of vote/night transaction |
| Reset/session destruction | destroys authority | no reusable turn | no transition | discards pending and makes all old bindings stale |

This table classifies version behavior only; it does not change vote, execution, night, victory, or phase game rules. Compatibility mutations must be placed behind the listed transaction boundary before Phase 3 can claim readiness.

### Version-field ledger

| Field | Stored value and equality rule |
| :--- | :--- |
| `InterpreterRequest.preconditionStateVersion` | `N`, captured with request `turnId` and `preconditionPhase` before provider work; equals pending and staged input captured version |
| `PlayerInputRecord.capturedStateVersion` | pre-commit `N`; staged once and preserved unchanged when committed/replayed |
| `AcceptedSpeechAct.acceptedStateVersion` | player-commit precondition `N`; every accepted act also shares request turn, phase, input, request, and correlation |
| `CanonicalClaim.createdStateVersion` | resulting version of the transaction that creates the claim: player `N+1` or reaction `N+2` |
| semantic event `stateVersion` | resulting version of its creating transaction; all same-transaction events share it |
| display plan `stateVersion` | player-commit resulting version `N+1` |
| player publication `gameStateVersion` | player-commit resulting version `N+1` |
| `ConversationCommitDelta.preconditionStateVersion` / `resultingStateVersion` | the transaction's `N` / `N+1`, with exact `+1` equality |
| player `CommitResult` versions | the stored player transaction's `N` / `N+1`; replay returns these values unchanged |
| reaction `CommitResult` versions | the stored reaction transaction's `N+1` / `N+2`; replay returns these values unchanged |
| `NpcReactionPlan.preconditionStateVersion` / `resultingStateVersion` | reaction transaction's `N+1` / `N+2`, with exact `+1` equality; its `turnId` equals the originating player turn |
| reaction publication `reactionResultingStateVersion` | same `N+2` as plan and reaction result |
| Renderer request/pending `resultingStateVersion` | copied `N+2` from the committed reaction; it is not a new precondition or transition |
| finalization `stateVersion` | copied reaction result `N+2`; finalization never reads a newer value into this field |

Every object produced by one atomic commit uses the ledger value above. Saved values are provenance and replay data; they are never replaced with the engine's later version.

### Phase 3 request binding and response classification

For Phase 3, `WerewolfGame` accepts a player command, allocates its logical turn, and stages an immutable `PlayerInputRecord` before any provider call or legacy compatibility mutation for that command. In one synchronous capture step it copies `gameSessionId`, `turnId`, `stateVersion` as `preconditionStateVersion`/`capturedStateVersion`, phase as `preconditionPhase`, actor `player`, input ID, request ID, correlation ID, roster, permissions, and public projections into an immutable validation binding. It then creates `PendingInterpreterRequest` from exactly that binding. SessionManager may store the pending record/controller but cannot choose or alter authoritative fields.

Phase 3 allows only one active player command, so no second input or same-turn mutation is accepted while Interpreter validation is pending. Reset is always allowed and destroys the binding. If another authoritative mutation nevertheless completes through an independent engine entry point, its version transition makes the response stale. After Phase 3 observation terminalizes, the existing combined compatibility action runs unchanged as one classified transaction while Phase 4 is off. When Phase 4 is on, section 6A splits that work without adding a ledger position: player-side compatibility effects join `PlayerConversationCommit` at `N -> N+1`, and later NPC-side compatibility effects occupy the provisional reaction `N+1 -> N+2`. Interpreter output never controls the compatibility effect content.

On response arrival the engine first validates the strict HTTP/provider schema, then looks up the pending record by request ID and compares the saved binding against the same game instance. The comparisons are exact: active `gameSessionId`; pending status `pending`; request, correlation, input, turn, precondition version, phase, and actor; and engine `turnId`, `stateVersion`, phase, and player identity. Only then does it validate all alternatives/candidates as one transaction-sized set against the captured allowlists and current matching engine context. Phase 3 records a bounded redacted diagnostic outcome and commits nothing. Success, rejection, clarification, failure, and terminalization leave turn and version unchanged.

Response outcomes are mechanical:

| Condition | Classification | Retry | Diagnostic reason | Effect |
| :--- | :--- | :---: | :--- | :--- |
| Strict response schema/candidate shape invalid, including response request/correlation mismatch | invalid provider response | no | `invalid_provider_response` or `correlation_mismatch` | pending fails; no mutation |
| No pending request, different session, turn/version/phase/actor/input, reset, or response after timeout/abort | stale discard | no | the specific `stale_*` dimension | no validation/application or game-flow effect |
| Pending is already terminal and its response fingerprint equals the recorded terminal response | idempotent duplicate | no | `duplicate_response` | return/retain prior diagnostic outcome only |
| Pending is terminal but response fingerprint differs | conflict | no | `duplicate_response_conflict` | discard; no mutation |
| Same request ID with changed submitted request fingerprint | idempotency conflict | no | `idempotency_conflict` | reject before provider/application |
| Retry of the same active operation | retry | policy only for retryable transport errors | `retry_attempt` | reuses all IDs and captured values |

Diagnostics may contain correlation ID, input ID, turn ID, captured version, category, counts, reason code, stale flag, and latency only. They contain no raw input/provider body or private state. Callback/logging failure is swallowed after pending cleanup and cannot affect the compatibility path.

### Required sequences

1. **Phase 3 valid:** allocate/capture authoritative binding; stage input and pending; call Interpreter; correlate strict response; compare session/turn/version/phase/actor; validate the complete alternative; append redacted diagnostic; terminalize pending; perform no commit; retain captured turn/version.
2. **Phase 3 stale:** capture `N`; an independent authoritative transaction commits `N+1`; response arrives; exact comparison fails; record `stale_state_version`; discard candidates; do not add another increment.
3. **Phase 4 player commit:** reuse staged binding at `N`; validate; prepare all structured objects, the legacy player-input log/history delta, and its `PlayerLegacyDisplayCompatibilityRecord` without mutation; immediately CAS session/turn/phase/version and idempotency; atomically publish all three representations and the stored result while setting version `N+1`; replay returns that result without provider call, mapping/log append, display, or increment.
4. **Player then NPC:** player commit produces `N+1`; only then may the NPC provider run. Before Phase 6, the legacy NPC compatibility transaction captures/rechecks `N+1` and atomically publishes the response and existing NPC-side effects as `N+2`. Phase 6 replaces that provisional transaction with `NpcReactionCommit` at the same `N+1 -> N+2` ledger position; it does not add a third transition. Canonical publication or Renderer pending records the reaction's `N+2` provenance. Renderer processing adds no transition; a future Phase 7 authoritative finalization-record append is a separate transaction and increments version exactly once on success.
5. **Timeout/abort/late:** pending captures `N`; timeout or abort terminalizes and releases runtime resources without mutation; later response finds terminal pending/audit identity, records stale-late reason, and cannot validate, display, commit, advance turn, or advance version.

### Phase 4 commit rules

`PlayerConversationCommit` and `NpcReactionCommit` are separate authoritative transactions in one logical turn. Preparation is pure. Immediately before application each performs compare-and-set on session, turn, phase, precondition version, request identity/fingerprint, and referenced authority. Multi-act input and any number of claims/events still cause one player transition only. The commit result is inserted in the same atomic publication as its objects and version transition; there is no interval in which version advanced but the result is absent. An exception restores the exact pre-transaction snapshot including counters and idempotency index. A duplicate matching fingerprint returns the stored result; a changed fingerprint conflicts; neither executes providers or advances counters.

During Phase 4, player-side compatibility mutation is not a second authoritative transaction. The existing player-input log/history entry needed by the legacy browser and CLI is an explicit effect delta inside `PlayerConversationCommit` and publishes atomically with the structured input, acts, claims/events, display plan, publication, compatibility mapping, idempotency record, result, and `N+1`. Provider wait and NPC response content are excluded from that transaction. After it succeeds, the current NPC provider path runs; its response, NPC memory, suspicion, NPC claim registration, and compatibility phase/log effects form one provisional reaction transaction from `N+1` to `N+2`. Phase 8 later changes how suspicion and memory are derived inside the reaction transaction but never moves them into the player transaction or adds a version transition.

If the Phase 4 player commit succeeds and the later provider or compatibility reaction fails, the committed player input remains at `N+1`. The failed reaction publishes no partial NPC effects and no `N+2`; it cannot roll back the earlier player commit. Exact replay of the player request returns the stored player result and executes neither the player compatibility delta nor the NPC provider/reaction path. A new NPC attempt, if supported by a later phase, requires its own reaction identity and the existing `N+1` precondition; Phase 4 does not invent recovery semantics.

### Player legacy-display compatibility identity

The selected baseline is **Option B: a strict compatibility mapping record**. Option A was rejected because adding structured-only fields to generic `{ day, phase, message }` player/NPC log entries would require a new discriminated log union and broaden an otherwise temporary compatibility schema. Option C was rejected because an action envelope alone cannot reconstruct stale-cursor or historical mixed player/NPC order after the callback; it would still require a durable same-transaction mapping. Option B preserves the generic legacy log, adds the least new authority, and can be deleted with the compatibility path in Phase 9.

`PlayerLegacyDisplayCompatibilityRecord` is a strict append-only display-provenance record with:

- `schemaVersion: 1`
- `recordType: "player_legacy_display_compatibility"`
- `compatibilityMappingId: ID`
- `gameSessionId: ID`
- `publicationId: ID`
- `displayPlanId: ID`
- `inputRecordId: ID`
- `requestId: ID`
- `correlationId: ID`
- `turnId: ID`
- `legacyEntryId: ID`
- `legacyLogAppendOrder: integer >= 0`
- `legacyEntryFingerprint: Sha256Fingerprint`
- `playerCommitResultingStateVersion: integer >= 1`
- `createdOrder: integer >= 0`
- `additionalProperties: false`

The engine generates `compatibilityMappingId` and `legacyEntryId`; neither AI nor a consumer supplies them. `legacyEntryFingerprint` is SHA-256 over canonical JSON of the exact strict legacy entry `{ day, phase, message }`. `legacyLogAppendOrder` is the zero-based append location reserved by the player commit. It is location proof only, never identity by itself: resolution first selects the unique mapping by structured identity, then reads exactly that append location and requires the canonical fingerprint to match. Text, phase, day, current cursor, FIFO position, first-unmatched selection, and array scanning are forbidden as mapping inference.

The registry is `playerLegacyDisplayCompatibilityRecords`, session-scoped under the browser-authoritative game state. It is display/publication provenance rather than `PublicEvent` and never affects game legality. It is nevertheless included in Phase 4 copy-on-write/CAS protection, rollback, committed-graph validation, and the same `N -> N+1` publication. Creating one mapping adds no transition; changing or deleting a committed mapping outside rollback is forbidden. Phase 4 ON creates exactly one mapping per player publication and exactly one mapping per legacy player entry. Phase 4 OFF creates none. Missing, duplicate, dangling, cross-session, or conflicting mappings fail the whole player commit. Replay reuses the stored mapping and appends nothing.

The mapping, publication, display plan, input, and legacy entry must agree on session, request, correlation, turn, input, plan, publication, and resulting version. `legacyLogAppendOrder` is unique among compatibility mappings, `legacyEntryId` is globally unique within the session, and no two mappings may reference one publication or one legacy location. The mapping's `createdOrder` participates in the existing structured created-order uniqueness rule.

`PlayerConversationCommitResult` is not expanded. Its existing `playerPublicationId` uniquely resolves the mapping's `publicationId`; the committed graph requires exactly one such mapping. This avoids a breaking field addition to the existing result union. The new mapping is a new schema-version-1 record and registry, not a new member of `DisplayPublicationRecord` or `PublicEvent`. Phase 4 repair extends the strict player `ConversationCommitDelta` object set and committed-graph validator to include it. No existing schema version increments: the baseline is memory-only, has no persistence/reload migration, and the repair applies only to new sessions/new inputs after deployment. Existing in-memory sessions are not backfilled and cannot be carried across a code reload.

### Player publication delivery and acknowledgement

Live delivery and history projection are separate. History may resolve a committed publication repeatedly as a read-only derived view and never acknowledges it. Live delivery uses a session-local `PlayerPublicationDeliveryController` owned by each `WerewolfGame` instance and shared through explicit methods used identically by browser and CLI. Its attempts, cursors, acknowledgements, cutover watermark, and diagnostics are runtime consumer state: they are not serialized, do not enter authoritative snapshots or commit results, and never change `stateVersion`, phase, turn, claims, events, publications, mappings, or providers.

The controller exposes synchronous boundaries:

1. `getUnacknowledgedPlayerPublications({ gameSessionId, consumerId, consumerGeneration, afterPublicationSlotOrder, limit })` performs bounded read-only discovery in `publicationSlotOrder`; `limit` is 1-32 and the cursor is optional. Duplicate retrieval is allowed. `get_state`, diagnostics, history, snapshots, and replay-result retrieval never call it implicitly.
2. `preparePlayerPublicationDelivery({ gameSessionId, publicationId, consumerId, consumerGeneration, sinkType })` strictly resolves mapping, legacy entry, input, plan, claims/events, locale, and public participant projection; creates one runtime `deliveryAttemptId`; and returns a frozen delivery candidate. It does not acknowledge or suppress anything.
3. `beginPlayerPublicationSink(...)` changes that exact attempt from `prepared` to `in_flight` and returns a one-shot opaque sink-completion capability to the trusted browser/CLI sink wrapper. The wrapper, not an action caller or observer, owns this capability. At most one active attempt exists for `(gameSessionId, publicationId, consumerId, consumerGeneration)`.
4. The browser appends the intended safe text node to the intended conversation container and stores the exact session, publication, consumer generation, attempt, and sink type in controller-owned DOM bookkeeping associated with that node. CLI completes its configured synchronous or awaited output write and stores the same exact identity in same-process controller-owned output bookkeeping. Browser paint confirmation, prompt redraw, rendered text, and observer events are not delivery proof.
5. The trusted wrapper invokes the configured sink and calls `completePlayerPublicationSink(...)` with its one-shot completion capability only after that synchronous call returns or awaited call fulfills. This completion method is not exposed through game actions, result objects, observers, or provider input. The controller consumes the capability, verifies the attempt is `in_flight`, changes it to `sink_succeeded`, and returns an opaque frozen `sinkSuccessReceipt` generated and retained by the controller. The receipt binds the exact session, publication, consumer, generation, attempt, and sink type and cannot be caller-constructed, reused for completion, or transferred to another attempt.
6. Only `acknowledgePlayerPublication({ sinkSuccessReceipt })` may acknowledge. It accepts the exact controller-retained receipt in `sink_succeeded`; it never accepts `in_flight`. Sink not executed, sink failure, a constructed/changed receipt, or a receipt from another attempt returns `publication_not_delivered`. Rendered text and observer outcomes are never acknowledgement identity or proof.
7. Sink exception calls `failPlayerPublicationDelivery(...)`, producing `failed_retryable`; no receipt, acknowledgement, or legacy suppression occurs. A later preparation creates a new attempt for the same session/publication without creating authoritative records or invoking a provider.

Delivery states are `unseen | prepared | in_flight | sink_succeeded | acknowledged | failed_retryable | failed_terminal | stale_session`. Legal transitions are `unseen/failed_retryable -> prepared -> in_flight -> sink_succeeded -> acknowledged`, `prepared/in_flight -> failed_retryable`, resolution failure to `failed_terminal`, and every nonterminal state including `sink_succeeded` to `stale_session` on reset/destroy. Direct `in_flight -> acknowledged` is forbidden. Preparation, retrieval, action-result construction, merge, observer success, `get_state`, and history rendering are never acknowledgement transitions. There is no automatic backoff in the same-session memory-only baseline; retry after sink failure occurs on the next adapter delivery pass or explicit user retry. A retry while `sink_succeeded` is acknowledgement-only and must not execute the DOM/CLI sink again. Resolution/schema failures are terminal for that session and never fall back to text/position matching.

Acknowledgement identity is primarily `(gameSessionId, publicationId)` and is further bound to `consumerId`, monotonically increasing `consumerGeneration`, `deliveryAttemptId`, `sinkType: "browser" | "cli"`, and the controller-issued `sinkSuccessReceipt`. `getCompletedPlayerPublicationSinkReceipt(...)` returns the retained receipt only for an exact live `sink_succeeded` identity; the browser may call it after finding the exact publication/attempt in DOM bookkeeping, and CLI may call it from same-process output bookkeeping. It cannot create a receipt. First valid acknowledgement returns and stores a frozen runtime result with those fields and `status: "acknowledged"`, then attempts exactly one `publication_acknowledged` observer notification. Every exact duplicate API invocation returns the same stored result and attempts exactly one `duplicate_ack_suppressed` observer notification; it performs no cursor movement, sink operation, DOM/CLI output, history append, or state change. Observer failure never changes the stored acknowledgement result or delivery state. A different consumer/generation/attempt/sink/receipt payload for an acknowledged identity is `publication_ack_conflict`. Other machine-readable reasons are `publication_not_found`, `publication_not_prepared`, `publication_not_delivered`, `stale_publication_session`, `stale_consumer_generation`, and `invalid_publication_ack`.

Reset/destroy invalidates the controller, all attempts, DOM/CLI bookkeeping, and all sink-success receipts. An acknowledgement presented to the old controller or to a new controller with the old session/receipt is rejected as `stale_publication_session` and cannot affect the new session. Observer outcomes are `publication_resolved`, `render_prepared`, `sink_started`, `sink_succeeded`, `sink_failed`, `publication_acknowledged`, `duplicate_ack_suppressed`, and `stale_ack_rejected`. `sink_succeeded` is emitted only after the state and receipt are stored, but the observer event is not the proof consumed by acknowledgement. If `displayed` is retained as an alias it means successful first acknowledgement, not render, sink start, or sink completion. Observer failure changes no delivery state or stored receipt/result and initiates no retry or fallback.

Legacy player suppression happens only when building the live adapter view from an acknowledged identity or from the exact in-flight candidate being sent to that sink. The mapping selects the exact legacy entry by `legacyEntryId` and verifies its reserved append location and fingerprint. Missing or wrong identity fails closed. A sink failure leaves the legacy entry stored and the publication retrievable, but the same delivery pass must not display the legacy entry as fallback. This prevents both loss and double display.

### Mixed ordering and feature transitions

The common mixed player/NPC history order remains legacy log append order until Phase 6 migrates NPC publications. An exact mapping replaces only its player entry at `legacyLogAppendOrder`; unmapped NPC entries remain at their existing append locations. `publicationSlotOrder` orders player delivery discovery and later unified publications, but is never numerically compared with a legacy log index. `recordAppendOrder`, state version, turn lexical order, text, and phase are not mixed sort keys. Live action envelopes carry the explicitly mapped player candidate and legacy NPC deltas in legacy append order; stale cursors can omit earlier entries without changing identity resolution.

Each adapter has a requested consumer mode, an effective consumer mode, a `consumerGeneration`, and a committed cutover `publicationSlotOrder` watermark. Requested mode is configuration intent; effective mode alone owns live delivery. They may differ only during the explicit deferred transition below. ON -> OFF is quiescent-only: acknowledged publications remain suppressed by identity, while unacknowledged post-cutover publications use the legacy sink through the same exact attempt/receipt/acknowledgement protocol. A switch requested during `in_flight` or `sink_succeeded` is rejected as `consumer_mode_switch_in_flight`; it never guesses sink outcome or discards an acknowledgement-only retry.

#### Deferred quiescent OFF -> ON cutover

The selected baseline is **deferred quiescent cutover with an explicit pre-cutover drain**. A mode-transition request is a controller-created, session-local, non-authoritative operation. Its minimum frozen identity is `modeTransitionId`, `gameSessionId`, `consumerId`, `sinkType`, `fromMode`, `requestedMode`, `effectiveMode`, `status`, `proposedCutoverPublicationSlotOrder`, `consumerGenerationBefore`, the required publication identities, completed evidence identities, and a runtime creation order. The caller never creates its ID. At most one transition exists per consumer.

Terms are normative:

- **requested consumer mode** is the latest accepted configuration intent: `legacy | structured`.
- **effective consumer mode** is the mode currently permitted to own live delivery.
- A **proposed cutover watermark** is the next publication slot frozen when an OFF -> ON request is accepted. It is not active authority.
- A **committed cutover watermark** is that same value only after successful completion.
- A **pre-cutover publication** belongs to the same session and has slot order below the proposed watermark.
- A **pre-cutover drain** is exact-identity delivery of missing legacy sink evidence without starting a game command.
- **Pre-cutover delivery evidence** is controller-owned proof that the exact legacy candidate completed the configured real sink.
- **Transition-stable state** means no transition is draining or applying and requested/effective modes agree.
- **Live delivery model state** is adapter/controller bookkeeping; **live delivery DOM state** is the actual attached browser node. Model mutation does not prove DOM state.
- **History projection** is repeatable derived data and never delivery, evidence, acknowledgement, or reconciliation authority.
- **Delivery reconciliation** reuses exact identity bookkeeping; it never infers identity from rendered text, cursor, phase, day, or array position.

The controller state model is:

```text
requestedMode: legacy | structured
effectiveMode: legacy | structured
transitionStatus:
  stable | draining_pre_cutover | applying | completed | cancelled | stale_session
```

On OFF -> ON request, the controller validates the live session and quiescence, freezes the current next publication slot as the proposed watermark, resolves every earlier player publication through its exact compatibility mapping, and compares the required set with successful pre-cutover evidence. Quiescence requires no active player command, Interpreter/NPC provider or reaction, `in_flight` sink, or unresolved `sink_succeeded` receipt; a request before those operations become terminal is rejected by the existing pending-operation policy without creating a transition. If evidence is complete, explicit completion may apply immediately. Otherwise it returns a pending transition result with reason `pre_cutover_delivery_pending`, the opaque transition ID, and a bounded missing count; it does not throw as the sole result. Requested mode becomes `structured`, effective mode remains `legacy`, status becomes `draining_pre_cutover`, and generation and committed watermark remain unchanged. No direct feature-flag rewrite or implicit rollback is a recovery API.

The proposed watermark and required set are immutable for one transition. Retry, partial success, cursors, log length, browser/CLI differences, and newly observed history cannot move or recompute them. Because new authoritative commands are gated while draining, the set cannot grow. Cancellation ends that transition; a later request gets a new ID and newly frozen watermark and cannot reuse the old transition.

Recommended conceptual APIs are:

```text
requestPlayerPublicationConsumerMode(...)
getPendingPreCutoverPlayerPublications(...)
completePlayerPublicationConsumerModeTransition(...)
cancelPlayerPublicationConsumerModeTransition(...)
getPlayerPublicationConsumerModeState(...)
```

Exact names may follow repository conventions, but their authority boundaries may not be combined with `dispatchPlayerAction()` boolean synchronization. Pending retrieval requires exact transition/session/consumer identity, is bounded to 1-32 items, and returns only missing-evidence publications below the frozen watermark in publication-slot order. Duplicate retrieval before success is allowed. It is not a history query, game action, provider call, or structured backfill. A terminal resolution failure remains terminal and prevents completion; legacy fallback cannot bypass it.

During `draining_pre_cutover`, a new authoritative top-level command is rejected before input staging, provider invocation, turn allocation, idempotency insertion, Phase 3 request, Phase 4 commit, NPC work, phase change, or `stateVersion` change. The reason is `consumer_mode_transition_pending`, distinct from `pre_cutover_delivery_pending`: the former means a game command was attempted during a transition; the latter means transition completion lacks sink evidence. Browser/CLI may hold a non-authoritative reference to the original command, but must not allocate a new identity or dispatch it until completion. Reset discards it. After completion the adapter may submit it exactly once through the normal command boundary; the transition API never dispatches it.

Completion requires the exact transition/session/consumer/proposed-watermark identity, evidence for every required publication, no `in_flight` or `sink_succeeded` attempt, and no unresolved terminal failure. It changes effective mode to `structured`, increments consumer generation exactly once, commits the frozen watermark, and marks the transition completed. It changes game version zero times. Exact repeated completion returns the stored result without another generation increment. Cutover performs no structured live backfill: pre-cutover publications remain available to structured history exactly once but never become structured live candidates.

Cancellation is allowed only without an active sink or unresolved sink-success receipt. It retains effective `legacy`, generation, committed watermark, and already recorded evidence, marks the transition cancelled, and never executes a queued command. Cancellation does not undo visible output. Reset/destroy marks transition, attempts, receipts, evidence, output/DOM bookkeeping, and queued references stale; late retrieval, completion, cancellation, or evidence is rejected as `stale_publication_session` and cannot affect a new session.

#### Pre-cutover legacy delivery evidence

Initial Phase 5-OFF legacy player delivery and transition drain use the same strict legacy attempt lifecycle:

```text
unseen -> prepared -> in_flight -> sink_succeeded -> evidence_recorded
prepared | in_flight -> failed_retryable
resolution failure -> failed_terminal
```

The attempt is bound to session, publication, consumer, generation, attempt, sink type, and `deliveryMode: "legacy_pre_cutover"`. `PreCutoverLegacyDeliveryEvidence` is runtime-only and minimally binds `gameSessionId`, `publicationId`, `consumerId`, `sinkType`, `deliveryAttemptId`, `consumerGeneration`, controller-issued sink-success receipt identity, compatibility mapping ID, legacy entry ID, legacy append order, and evidence runtime order. Only the controller writes it from its retained exact receipt. A caller, observer, local array push, render preparation, rendered text/hash, or history cannot create it. Exact duplicate evidence is idempotent; a different attempt or receipt conflicts. Evidence changes no authoritative record or `stateVersion` and is valid only for that session lifetime. It proves legacy pre-cutover display solely for cutover eligibility; it does not fabricate the standard structured publication acknowledgement.

Sink failure records no evidence and leaves the publication retrievable. Sink success followed by evidence-recording failure retains the controller receipt and uses evidence-only retry; it must not execute the sink again. Partial multi-publication success is retained: successful items are not redisplayed, failed items remain retrievable, and completion waits for all evidence. No partial failure rolls back an already visible output.

For browser, sink success occurs only after all of these mechanical conditions hold:

1. the frozen prepared candidate is used without caller message/day/phase substitution;
2. safe DOM APIs create the intended node and text content;
3. exact delivery identity is bound to controller-owned node bookkeeping;
4. the node is appended to the intended conversation container without exception;
5. its parent is verified as that container and bookkeeping resolves that same node;
6. only then is the one-shot sink-completion capability passed to the controller;
7. only the resulting exact receipt may create pre-cutover evidence.

`playerFacingLog.push()`, view-model mutation, a scheduled or completed `render()`, `requestAnimationFrame`, browser paint, prompt redraw, and observer success are insufficient. Browser paint is not awaited. Raw input never enters `innerHTML`. If node creation, container lookup, append, parent verification, bookkeeping, or sink completion fails before receipt issuance, the adapter removes any staged node/bookkeeping it owns and records no evidence. If append and receipt succeed but later envelope work fails, the exact receipt/evidence remains and retry cannot append a duplicate node. Later rendering must not clear an acknowledged/evidenced node unconditionally: it either runs before live delivery or performs keyed identity reconciliation and reuses the node. History projection is never appended as a live node.

For CLI, sink success means the configured synchronous write returns or the configured asynchronous write fulfills. Prompt redraw is outside the proof. Throw/rejection records no receipt/evidence. Same-process exact output bookkeeping enables evidence-only retry without another write. Terminal-control sanitization happens before the configured write but is not itself success. Browser and CLI therefore share candidate, attempt, receipt, evidence, retry, cancellation, reset, and stale-session rules; only DOM attachment verification versus configured output completion differs.

The browser processing order is: obtain a non-replay runtime result; update non-conversation UI; complete base rendering that cannot consume live delivery; retrieve exact drain/live candidates; append each exact node; complete sink; record evidence or acknowledgement; and perform no later unkeyed full-log replacement. Replay, `get_state`, history, diagnostics, and snapshots never create a drain/live envelope and never change the visible conversation container.

The selected baseline rejects four alternatives. Implicitly rolling requested mode back to legacy loses transition identity and induces direct flag writes. Repeatedly throwing or auto-retrying during ordinary actions can permanently block access to retry delivery and mixes commands with drain. Carrying missing publications into structured mode violates no-live-backfill and can replace legacy content. Continuing new legacy commands while draining makes the frozen required set race with publication creation and mixes ownership in one action.

The Phase 4 compatibility exception ends only after the mapping repair is deployed, browser and CLI implement the common sink/ack protocol, non-display queries are proven non-consuming, and retry, duplicate/late acknowledgement, stale cursor, repeated text, multiple turn, partial acknowledgement, and flag-transition tests pass. Physical legacy entry and mapping deletion remains Phase 9.

Identity decisions are mechanical:

| Condition | Classification | Effect |
| :--- | :--- | :--- |
| All mapping/publication/input/plan/request/correlation/turn/session/version/location/fingerprint fields match | exact | resolve the mapped legacy entry |
| Publication, input, request, correlation, turn, plan, version, or legacy entry differs | conflict | fail closed; no render or suppression |
| Mapping session differs from active session | stale | reject `stale_publication_session` |
| Mapping or target is missing | invalid | terminal resolution failure; no fallback |
| More than one mapping owns a publication, legacy ID, or append location | invalid | committed-graph/cardinality failure |
| Same text/day/phase but identity differs | unrelated | never match or suppress |

Acknowledgement decisions are also closed:

| Condition | Reason/result | Retryable | Acknowledgement/visible effect | Authoritative effect | Observer effect |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Trusted sink fulfills; exact one-shot completion capability in `in_flight` | `sink_succeeded` + retained receipt | ack-only | record runtime sink success; do not acknowledge yet | none | exactly one `sink_succeeded` invocation |
| Sink completion missing/foreign/reused, or attempt not `in_flight` | `publication_not_delivered` | according to current exact state | none | none | rejection only |
| Exact retained receipt in `sink_succeeded`, first ack | `acknowledged` | no | store runtime ack; one prior visible delivery | none | exactly one `publication_acknowledged` invocation |
| Exact duplicate ack invocation | stored `acknowledged` result | no | no second sink/display/cursor move | none | exactly one `duplicate_ack_suppressed` invocation per API invocation |
| Ack in `prepared` or `in_flight`, or without exact receipt | `publication_not_delivered` | yes after valid sink completion | none | none | rejection only |
| Ack after reported sink failure | `publication_not_delivered` | yes | none | none | rejection only |
| Unknown publication | `publication_not_found` | no | none | none | rejection only |
| Wrong/old/reset session | `stale_publication_session` | no | none | none | `stale_ack_rejected` |
| Superseded generation | `stale_consumer_generation` | no | none | none | `stale_ack_rejected` |
| Ack identity conflicts with stored ack | `publication_ack_conflict` | no | none | none | rejection only |
| Non-display retrieval/history/render | no ack operation | n/a | no live display consumption | none | resolve/render outcomes only |
| Mode switch while `in_flight` or `sink_succeeded` | `consumer_mode_switch_in_flight` | yes after settle/fail/ack | mode unchanged | none | rejection only |
| OFF -> ON with all required evidence and no active attempt | transition may complete | no | commit frozen watermark; no backfill | none | transition completion only |
| OFF -> ON with missing evidence | `pre_cutover_delivery_pending` + transition ID | yes through drain API | requested structured; effective legacy; no display implied | none | bounded redacted pending diagnostic |
| Game command while drain is active | `consumer_mode_transition_pending` | after completion/cancel | no sink, display, or command dispatch | none | bounded redacted rejection |
| Browser model/log array updated but node not attached | no sink success/evidence | yes | rollback owned staging; publication remains pending | none | sink failure only |
| Exact browser node attached and controller receipt issued | evidence may be recorded | evidence-only if recording fails | exactly one attached node | none | sink success, then evidence outcome |
| CLI configured write returns/fulfills and receipt issued | evidence may be recorded | evidence-only if recording fails | exactly one output | none | sink success, then evidence outcome |
| Cancel draining transition with no active sink | `cancelled` | new request allowed | retain effective legacy and prior evidence | none | transition cancellation only |
| Reset during transition or late transition callback | `stale_publication_session` | no | invalidate transition/attempt/receipt/evidence | none | redacted stale diagnostic |

Required implementation sequences are:

- **Phase 4 commit:** prepare structured objects, legacy entry, and mapping; perform final CAS; atomically publish all at `N+1`; store the result; create no delivery acknowledgement.
- **Browser success:** discover unacknowledged publication; exact-resolve mapping/input/plan; prepare; begin sink; append safe DOM node and identity bookkeeping; complete sink; retain the returned receipt; acknowledge with that receipt; emit acknowledgement observer; suppress only the mapped legacy entry.
- **Browser sink-success/ack-failure retry:** find the publication/attempt through publication-ID DOM bookkeeping; reuse the controller-retained receipt; retry acknowledgement only; never append another DOM node.
- **Browser failure:** resolve and prepare; begin sink; sink throws; mark retryable failure; do not acknowledge or legacy-fallback; retrieve and retry the same publication identity later.
- **CLI delivery:** use the same discovery, mapping, begin, sink, completion, acknowledgement, failure, and retry rules; successful configured synchronous/awaited output write creates a same-process memory-only receipt. If acknowledgement must be retried while the process remains alive, reuse that receipt without another output write. Process restart recovery is outside the memory-only baseline.
- **Non-display query:** return state/history/derived render data without beginning a sink or changing acknowledgement.
- **Stale cursor/multiple turns:** select by publication/mapping identity; verify exact legacy location/fingerprint; replace only that entry; acknowledged or omitted earlier entries do not shift the match.
- **Reset/late ack:** invalidate old controller; reject the old callback as stale; do not mutate or display in the new session.
- **Initial OFF legacy success:** exact-resolve the mapped legacy candidate; prepare/begin; complete the browser DOM append or CLI configured write; obtain the controller receipt; record pre-cutover evidence; create no structured acknowledgement and no version transition.
- **OFF -> ON with evidence complete:** request transition; freeze the proposed watermark and required set; verify evidence and quiescence; explicitly complete; increment generation once; commit the watermark; perform no backfill.
- **OFF -> ON with evidence missing:** request transition; retain effective legacy; pause new commands; retrieve exact missing candidates through the drain API; use the real legacy sink; record evidence; explicitly complete only after the full set succeeds.
- **Browser drain failure:** prepare/begin; fail node creation/attachment/verification; clean owned staging; create no receipt/evidence; retrieve the same publication later.
- **Sink-success/evidence-failure retry:** retain the exact receipt and visible node/output; retry evidence only; never execute the sink again.
- **Partial drain:** retain evidence for successful identities, retry only missing identities, and leave the transition pending until the fixed set is complete.
- **Completion and queued command:** apply transition; then the adapter resubmits one held command once through normal dispatch; only that dispatch may allocate a turn or commit.
- **Cancel/reset:** cancellation retains effective legacy and evidence without executing a command; reset makes all transition identities and callbacks stale.

Reaction preparation begins only after the player result `N+1` exists. If another authoritative transaction changes turn, phase, relevant references, or version before reaction commit, preparation is discarded as stale and no reaction object is published. A successful reaction advances once to `N+2`. Renderer failure cannot roll back either commit. Reservation and finalization carry `N+2` as provenance and never advance it.

## 7. `InterpreterModelOutput` Schema (AI Output)

The AI Interpreter model produces only the structured interpretation content.

### InterpreterModelOutput
- **schemaVersion**: 1 (Integer, Required)
- **alternatives**: Array of `SpeechActAlternative` (Required, 1-3 items)
- **additionalProperties**: false

### SpeechActAlternative
- **alternativeId**: String (Required)
- **speechActs**: Array of `SpeechActCandidate` (Required, 1-4 items)
- **confidence**: Number (Required, 0.0 to 1.0)
- **additionalProperties**: false

Zero alternatives is schema-invalid. Semantic failure is represented only by one alternative containing one `UninterpretableCandidate`.

## 8. `SpeechActCandidate` Types (Strict Discriminated Union)

All candidate types follow a strict `additionalProperties: false` policy. Unknown fields are rejected. The AI must NOT include an authoritative `actorId`.

### Individual Type Definitions

#### 1. NonGameStatementCandidate
- **type**: "non_game_statement" (Discriminator)
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 2. QuestionCandidate
- **type**: "question"
- **targetId**: String (Required): Validated ID from `publicRoster`
- **topic**: `QuestionTopic` (Required)
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 3. SuspicionCandidate
- **type**: "suspicion"
- **targetId**: String (Required): Validated ID from `publicRoster`
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 4. VoteDeclarationCandidate
- **type**: "vote_declaration"
- **targetId**: String (Required): Validated ID from `publicRoster`
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 5. RoleClaimCandidate
- **type**: "role_claim"
- **claimedRole**: `ClaimableRole` (Required)
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 6. ResultClaimCandidate
- **type**: "result_claim"
- **targetId**: String (Required): Validated ID from `publicRoster`
- **result**: `ClaimResult` (Required)
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 7. InformationRequestCandidate
- **type**: "information_request"
- **topic**: Enum (Required): "rules", "commands", "history"
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 8. UninterpretableCandidate
- **type**: "uninterpretable"
- **reason**: Enum (Required): "gibberish", "missing_required_reference", "unsupported_intent", "off_topic"
- **sourceSpan**: `SourceSpan` (Required; the entire input span when the whole input is uninterpretable)
- **additionalProperties**: false

### SourceSpan
- **start**: Integer (Required, Unicode code point index)
- **end**: Integer (Required, Unicode code point index)
- **additionalProperties**: false
- **Constraint**: `0 <= start < end <= rawText code point length`

Indices count Unicode code points, not UTF-16 code units or bytes; `start` is inclusive and `end` is exclusive. Within one alternative, every candidate span is pairwise non-overlapping and candidates are ordered by ascending `sourceSpan.start`. Overlap, containment, and crossing are all rejected. Each act uses the smallest non-overlapping semantic span; multiple acts never reuse a whole-sentence span. Punctuation is assigned deterministically to the immediately preceding semantic span; leading punctuation and separators not consumed by a semantic span remain raw. Every unclassified range, including whitespace or punctuation outside accepted spans, becomes a `RawInputSegment`. Accepted acts preserve the candidate span unchanged, and the engine derives the display plan deterministically from accepted spans without asking the AI.

Complete test fixture (all indices are Unicode code points, punctuation included in the preceding semantic span):

```json
{
  "rawText": "私は占い師です。Beniは人狼でした。Aoiはどう思いますか？",
  "modelOutput": {
    "schemaVersion": 1,
    "alternatives": [
      {
        "alternativeId": "alt-1",
        "confidence": 0.91,
        "speechActs": [
          { "type": "role_claim", "claimedRole": "seer", "sourceSpan": { "start": 0, "end": 8 } },
          { "type": "result_claim", "targetId": "npc-beni", "result": "werewolf", "sourceSpan": { "start": 8, "end": 19 } },
          { "type": "question", "targetId": "npc-aoi", "topic": "opinion", "sourceSpan": { "start": 19, "end": 31 } }
        ]
      }
    ]
  },
  "displayPlan": {
    "schemaVersion": 1,
    "displayPlanId": "display-1",
    "inputRecordId": "input-1",
    "turnId": "turn-1",
    "stateVersion": 8,
    "segments": [
      { "segmentId": "segment-1", "type": "canonical_claim", "claimId": "claim-role-1" },
      { "segmentId": "segment-2", "type": "canonical_claim", "claimId": "claim-result-1" },
      { "segmentId": "segment-3", "type": "raw_input", "inputRecordId": "input-1", "sourceSpan": { "start": 19, "end": 31 } }
    ]
  }
}
```

Thus the role claim maps to a canonical claim segment, the result claim maps to a canonical claim segment, and only the question maps to raw input. Neither claim range appears in a raw segment.

## 9. `AcceptedSpeechAct` Types (Strict Discriminated Union)

The engine-generated representation of a bound act.

### Common Required Fields (Metadata)
- **schemaVersion**: 1 (Integer, Required)
- **speechActId**: String (Required, Engine-generated)
- **requestId**: String (Required, Linked to request)
- **acceptedTurnId**: String (Required)
- **acceptedStateVersion**: Integer (Required, Pre-commit version)
- **acceptedPhase**: `GamePhase` (Required, authoritative pre-commit phase in which validation succeeded)
- **inputRecordId**: ID (Required)
- **actorId**: String (Required, Bound by engine)
- **causationId**: String (Required)
- **correlationId**: String (Required)
- **idempotencyKey**: String (Required, `requestId + altIndex + actIndex`)
- **sourceSpan**: `SourceSpan` (Required, copied unchanged from the validated candidate)
- **additionalProperties**: false

All accepted acts created by one player commit share the logical `acceptedTurnId`, `acceptedStateVersion`, and `acceptedPhase` defined by the section 6A field ledger. These are pre-commit values and are preserved on replay.

### Individual Types

#### 1. AcceptedNonGameStatement
- **type**: "accepted_non_game_statement" (Discriminator)
- **sourceSpan**: `SourceSpan` (Required)
- **Forbidden**: `targetId`, `topic`, `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: `PublicStatementRecordedEvent`

#### 2. AcceptedQuestion
- **type**: "accepted_question" (Discriminator)
- **targetId**: String (Required, alive NPC)
- **topic**: `QuestionTopic` (Required)
- **Forbidden**: `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: `PublicQuestionRecordedEvent`

#### 3. AcceptedSuspicion
- **type**: "accepted_suspicion" (Discriminator)
- **targetId**: String (Required, alive NPC)
- **Forbidden**: `topic`, `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: `SuspicionExpressedEvent`
- **Gameplay Effect**: `suspicion_update`

#### 4. AcceptedVoteDeclaration
- **type**: "accepted_vote_declaration" (Discriminator)
- **targetId**: String (Required, alive NPC)
- **Forbidden**: `topic`, `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: `VoteDeclaredEvent`
- **Gameplay Effect**: `memory_update`

#### 5. AcceptedRoleClaim
- **type**: "accepted_role_claim" (Discriminator)
- **claimedRole**: `ClaimableRole` (Required)
- **Forbidden**: `targetId`, `topic`, `result`
- **Generated CanonicalClaim**: `RoleCanonicalClaim`
- **Generated PublicEvent**: `RoleClaimRecordedEvent`
- **Gameplay Effect**: `claim_registration`

#### 6. AcceptedResultClaim
- **type**: "accepted_result_claim" (Discriminator)
- **targetId**: String (Required)
- **result**: `ClaimResult` (Required)
- **Forbidden**: `topic`, `claimedRole`
- **Generated CanonicalClaim**: `ResultCanonicalClaim`
- **Generated PublicEvent**: `ResultClaimRecordedEvent`
- **Gameplay Effect**: `claim_registration`

#### 7. AcceptedInformationRequest
- **type**: "accepted_information_request" (Discriminator)
- **topic**: Enum (Required): "rules", "commands", "history"
- **Forbidden**: `targetId`, `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: none (Internal only)

## 10. `PublicEvent` Types (Strict Discriminated Union)

Authoritative game-rule public records. Every ID is a non-empty ASCII identifier of 1-64 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`. The union has six semantic event types; display publication records are a separate append-only log.

`PublicEvent = PublicStatementRecordedEvent | PublicQuestionRecordedEvent | SuspicionExpressedEvent | VoteDeclaredEvent | RoleClaimRecordedEvent | ResultClaimRecordedEvent`, discriminated by `eventType`.

### Common Required Fields (`EventMetadata`)

- **schemaVersion**: integer literal `1`
- **eventId**, **requestId**, **turnId**, **actorId**, **causationId**, **correlationId**, **idempotencyKey**: ID
- **source**: `SemanticEventSource`
- **stateVersion**: integer, minimum `0`
- **occurredPhase**: `GamePhase` (authoritative phase in which the event semantically occurred)
- **createdOrder**: integer, minimum `0`, unique across the event stream

Event `stateVersion` is the resulting version of its creating player or NPC transaction, never the Interpreter precondition. Same-transaction events share it and replay preserves it.

Semantic events never carry direct provenance IDs, `displayPlanId`, or `sourceSpan`; all provenance is exclusively in `source`. Player events use only `PlayerSpeechEventSource`; NPC reaction events use only `NpcReactionEventSource`. Publication records use their own metadata and do not use this source union.

### SemanticEventSource (Strict Union)

`SemanticEventSource = PlayerSpeechEventSource | NpcReactionEventSource`, discriminated by `sourceType`.

- `PlayerSpeechEventSource` requires discriminator `sourceType: "player_accepted_act"`, `acceptedSpeechActId: ID`, `inputRecordId: ID`, and `requestId: ID`.
- `NpcReactionEventSource` requires discriminator `sourceType: "npc_reaction"`, `reactionPlanId: ID`, `descriptorId: ID`, `originatingInputRecordId: ID`, and `reactionCommitRequestId: ID`.

Both have no optional/null fields and `additionalProperties: false`; the fields of the other member are forbidden. Source actor must equal event actor. Player references resolve to one committed player transaction. NPC references resolve to a committed plan and compatible descriptor. One descriptor may create at most one semantic event of each explicitly compatible event type; its idempotency key is `(reactionPlanId, descriptorId, eventType)`. Player and NPC sources are mutually exclusive.

### Individual Event Types

| Type | Discriminator `eventType` | Additional required fields | Optional fields | Forbidden fields |
| :--- | :--- | :--- | :--- | :--- |
| `PublicStatementRecordedEvent` | `public_statement_recorded` | none | none | `displayPlanId`, `sourceSpan`, `targetId`, `topic`, `claimId`, `claimedRole`, `result` |
| `PublicQuestionRecordedEvent` | `public_question_recorded` | `targetId: ID`, `topic: QuestionTopic` | none | `displayPlanId`, `sourceSpan`, `claimId`, `claimedRole`, `result` |
| `SuspicionExpressedEvent` | `suspicion_expressed` | `targetId: ID` | none | `displayPlanId`, `sourceSpan`, `topic`, `claimId`, `claimedRole`, `result` |
| `VoteDeclaredEvent` | `vote_declared` | `targetId: ID` | none | `displayPlanId`, `sourceSpan`, `topic`, `claimId`, `claimedRole`, `result` |
| `RoleClaimRecordedEvent` | `role_claim_recorded` | `claimId: ID` | none | `displayPlanId`, `sourceSpan`, `targetId`, `topic`, `claimedRole`, `result` |
| `ResultClaimRecordedEvent` | `result_claim_recorded` | `claimId: ID` | none | `displayPlanId`, `sourceSpan`, `topic`, `claimedRole`, `result` |

### PlayerUtterancePublishedEvent

This existing schema is retained as the compatibility alias of `PlayerUtterancePublishedRecord` during migration. It requires `schemaVersion: 1`, `publicationId: ID`, discriminator `recordType: "player_utterance_published"`, `requestId: ID`, `correlationId: ID`, `turnId: ID`, `gameStateVersion: integer >= 0`, `occurredPhase: GamePhase`, `actorId: ID`, `inputRecordId: ID`, `displayPlanId: ID`, `idempotencyKey: ID`, `publicationSlotOrder: integer >= 0`, and `recordAppendOrder: integer >= 0`. It has no optional/null fields and `additionalProperties: false`.

Exactly one is created per committed displayable player input, including claim-only, multi-act, question-only, non-game statement, and accepted information-request input. All accepted player inputs in this baseline are displayable; `UninterpretableCandidate` uses clarification. The record is the sole structured display trigger and the steady-state sole display trigger. It lives in the display log, not `PublicEvent`, and never changes game-rule state/version. Its references resolve to the same player commit. A display plan belongs to exactly one publication. Duplicate replay returns stored results and never displays again.

Phase 4 has one explicit, temporary compatibility exception: the legacy player-question log entry committed in the same player transaction remains the active browser/CLI visible-display trigger, while the matching `PlayerUtterancePublishedRecord` and `PlayerLegacyDisplayCompatibilityRecord` are stored but not consumed. Each successful new input therefore has exactly one structured publication, one explicit mapping, and one visible legacy display in one atomic player commit; it never has two visible displays. The publication ID and stored commit result are the durable replay guard. Exact replay returns no new mapping, legacy entry, or display delta. Phase 5 ends this exception only after every browser/CLI player-input consumer resolves the explicit mapping, completes its sink, explicitly acknowledges the publication, and passes retry/no-loss/no-redisplay tests. From that cutover onward, `PlayerUtterancePublishedRecord` is the sole actual player trigger; legacy entries remain stored and are suppressed only by exact mapping identity until Phase 9.

| Candidate | Accepted act | Semantic event/domain object | Display-owner event |
| :--- | :--- | :--- | :--- |
| statement | `AcceptedNonGameStatement` | `PublicStatementRecordedEvent` | one `PlayerUtterancePublishedEvent` per input |
| question | `AcceptedQuestion` | `PublicQuestionRecordedEvent` | same single owner |
| suspicion | `AcceptedSuspicion` | `SuspicionExpressedEvent` | same single owner |
| vote | `AcceptedVoteDeclaration` | `VoteDeclaredEvent` | same single owner |
| role claim | `AcceptedRoleClaim` | `RoleCanonicalClaim` + `RoleClaimRecordedEvent` | same single owner |
| result claim | `AcceptedResultClaim` | `ResultCanonicalClaim` + `ResultClaimRecordedEvent` | same single owner |
| information request | `AcceptedInformationRequest` | no semantic public event | same single owner |

Semantic events never initiate display. The publication event resolves its `inputRecordId` and `displayPlanId`; the plan then resolves raw ranges from the immutable input and canonical ranges from referenced claims/events through engine-owned renderers.

## 11. `CanonicalClaim` Types (Strict Discriminated Union)

### Claim Metadata
- **schemaVersion**: 1 (Integer, Required)
- **claimId**: String (Required)
- **claimRevision**: Integer (Required, starts at 1)
- **actorId**: String (Required)
- **source**: `ClaimSource` (Required)
- **idempotencyKey**: Sha256Fingerprint (Required, provenance-specific derivation below)
- **createdTurnId**: String (Required)
- **createdStateVersion**: Integer (Required)
- **repeatsClaimId**: String | null (Required)
- **contradictsClaimIds**: Array of String (Required, unique)

`createdTurnId` is the creating transaction's logical turn and `createdStateVersion` is its resulting version under section 6A. Claims created together therefore share both values; replay does not recalculate them.
- **status**: Enum "asserted" (Required)
- **additionalProperties**: false

### Individual Claim Types
1. **RoleCanonicalClaim**: `{ type: "role_claim", claimedRole: ClaimableRole, ...ClaimMetadata }`
   - Forbidden: `targetId`, `result`
2. **ResultCanonicalClaim**: `{ type: "result_claim", targetId: String, result: ClaimResult, ...ClaimMetadata }`
   - Forbidden: `claimedRole`

### Claim Management Rules
- **New Assertion**: `rev=1`, `repeats=null`, `contradicts=[]`.
- **Repeat**: `rev=1`, `repeats=originalId`. Actor, claim type, subject, and normalized payload match exactly. A role claim payload matches only when `claimedRole` matches; a result claim payload matches only when both `targetId` and `result` match.
- **Amendment**: unsupported in this baseline. There is no amendment candidate, accepted act, or `supersedesClaimId` field. No payload change implies correction. Explicit amendment acts are reserved for a later schema version.
- **Contradiction**: `rev=1`, `contradicts=[ids]`. Actor, claim type, and subject match, while normalized payloads logically conflict. Result claims about different targets are not contradictions.
- **Rules**: `repeatsClaimId` and non-empty `contradictsClaimIds` are mutually exclusive. Every referenced claim exists and precedes the new claim. A normal role or result claim that conflicts with a prior same-actor, same-type, same-subject claim is a contradiction, never an amendment.

Examples: `Beni is werewolf` followed by `Beni is not_werewolf` is a contradiction when the same actor made both result claims about Beni. `Beni is werewolf` followed by `Aoi is not_werewolf` is not a contradiction because the subjects differ.

## 11A. Player Result-Claim Authorization Baseline

This section is normative for player-origin `ResultClaimCandidate`, `AcceptedResultClaim`, `ResultCanonicalClaim`, and `ResultClaimRecordedEvent`. It separates whether an assertion may enter the conversation ledger from whether its payload matches hidden game truth.

### Terms and authority

- **Claim legality** means that a schema-valid player assertion is permitted by the current phase, actor class, target constraints, and authoritative request binding. Legality is decided by the browser engine from public identity and lifecycle state.
- **Claim truthfulness** means whether `result` matches the target's hidden authoritative role at that moment. Truthfulness is not an acceptance condition and is not recorded in the claim schema.
- **Known information** is a fact available to an actor from an authoritative source. It is relevant only when a rule explicitly requires knowledge; this baseline does not require it for a player result claim.
- **Private known information** is actor-scoped authoritative information that is not public. The current game has NPC-owned private seer results but no player-owned private-result registry.
- **Public known information** is a structured public event or claim visible to all participants. Its existence does not make a new player assertion more or less legal.
- **Hearsay or attributed information** is content presented as originating from another speaker or source. The current candidate and claim schemas have no attribution field, so a `ResultClaimCandidate` is recorded only as the player's own assertion; attribution is not preserved or inferred.
- **Fabricated claim** and **bluff** mean an assertion made without matching knowledge, or intentionally differing from believed or actual truth. Both are legal under this baseline.
- **Unsupported claim** is an utterance whose intended form cannot be represented by the current strict candidate union, such as a request to persist attribution as provenance. It is not silently upgraded with invented fields.
- **Unauthorized claim** is schema-valid but fails a phase, actor, target, binding, or current-state precondition.
- **Repeated claim** and **contradictory claim** are relations to prior committed `CanonicalClaim` records. They are not truth verdicts.

`CanonicalClaim` records what the player authoritatively claimed, not what is true. The Interpreter classifies the utterance structure; it does not inspect hidden truth. The engine authorizes the structure without exposing hidden role, team, NPC memory, private seer results, or suspicion values to the provider.

### Baseline policy

A player-origin result claim is legal when all of the following are true:

1. The candidate and enclosing alternative satisfy the strict schemas and source-span rules.
2. The captured and current session, turn, phase, version, actor, input, request, correlation, and fingerprint preconditions match.
3. `result` is exactly `werewolf` or `not_werewolf`.
4. The phase is `day_discussion`, the only baseline phase that permits `result_claim`.
5. The target is a public NPC participant in the captured roster and still belongs to the same active game session at final authorization.
6. The target ID is neither the player actor ID nor another player-class ID.

Alive and dead public NPCs are both valid targets. Execution or attack does not erase prior conversational identity. A participant removed by reset, session replacement, or roster replacement is not a valid target. Hidden role or team never affects target authorization.

The player has no game role and no private investigation-result store in the current game model. Consequently, player role, seer status, evidence ownership, public-result existence, actual truth, and possession of private information are deliberately not legality conditions. A non-seer player, an uninformed player, and a player making a bluff use the same legal assertion contract. The engine never derives authority from a same-input role claim, a prior role claim, raw-text phrases such as "I heard", or the target's hidden state.

This policy requires no provenance field. Direct private knowledge, public knowledge, hearsay, and fabrication cannot be distinguished by the current candidate. They are intentionally normalized to one player-owned assertion. A future feature that must preserve attribution or prove evidence ownership requires a separately reviewed schema version; it must not infer provenance from text.

### Normative decision table

| Condition | Schema | Legality / truth relevance | Phase 3 outcome | Phase 4 artifacts | Structured state/version effect |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Valid claim about a public NPC | valid | legal; truth irrelevant | valid diagnostic | accepted act, canonical claim, claim event, display plan and one player publication | one atomic `N -> N+1` |
| Bluff, fabrication, or false result | valid | legal; truth irrelevant | valid diagnostic | same as any legal claim; no truth metadata | one atomic `N -> N+1` |
| Private, public, or hearsay basis | valid | legal; basis is not persisted | valid diagnostic | recorded as the player's own assertion | one atomic `N -> N+1` |
| True but wrong phase or target class | valid | unauthorized despite truth | whole alternative rejected with the applicable reason | none | no structured commit |
| Unknown or old-session target | valid | unauthorized | whole alternative rejected as `invalid_reference` or stale session | none | no structured commit |
| Player/self target | valid | unauthorized target class | whole alternative rejected as `invalid_target_class` | none | no structured commit |
| Invalid result enum or extra provenance field | invalid | legality not evaluated | invalid provider response | none | none |
| Phase other than `day_discussion` | valid | unauthorized phase | whole alternative rejected as `candidate_not_allowed` | none | no structured commit |
| Missing evidence or provenance | valid | evidence is not required | valid diagnostic | normal player assertion | one atomic `N -> N+1` |
| Prior identical claim | valid | legal repeat; truth irrelevant | valid diagnostic | new claim with `repeatsClaimId` | one atomic `N -> N+1` |
| Prior same-target different result | valid | legal contradiction; truth irrelevant | valid diagnostic | new claim with `contradictsClaimIds` | one atomic `N -> N+1` |
| Unsupported attributed-provenance form | not representable as attributed provenance | unsupported, not fabricated metadata | `uninterpretable`/clarification when no faithful candidate exists | none | no structured commit |
| Stale authorization context | valid | authorization must be current | stale diagnostic | none | no structured commit |

An unauthorized candidate rejects its entire alternative. It never produces a partial accepted act, claim, event, display plan, publication, idempotency result, or structured version transition. Phase 3 records only a bounded diagnostic. Phase 4 repeats every authorization and CAS check immediately before publication. Neither layer emits a free-form reason that could reveal hidden truth. These failures are non-retryable unless the stale lifecycle rules explicitly require a new player input.

The logical turn was already allocated when the engine accepted the top-level command. Rejection creates no Phase 4 structured transaction. The independent legacy compatibility action may still perform its existing transaction and version transition; that is not a result-claim commit and must not create structured claim objects.

### Repeat and contradiction

Relations use only prior committed player-origin `CanonicalClaim` records:

- same actor, same target, same result: repeat the earliest matching claim;
- same actor, same target, different result: contradict all prior conflicting result claims, in authoritative claim order;
- same actor, different target: neither repeat nor contradiction;
- different actor, same target: neither repeat nor contradiction;
- attributed language and own assertion: the current schema stores both as the player's own assertion, so the same actor/target/result rules apply;
- a legal bluff participates in repeat and contradiction exactly like any other legal claim;
- an unauthorized claim never enters the claim ledger and cannot become a relation target.

Repeat and contradiction metadata does not block acceptance and does not amend an earlier claim. `claimRevision` remains `1`; amendment remains unsupported. Relation calculation is repeated against current authoritative claim state during the Phase 4 final authorization and pure preparation step.

### Phase responsibility and legacy coexistence

| Artifact or behavior | Phase 3 | Phase 4 | Phase 5 | Authoritative owner / coexistence |
| :--- | :--- | :--- | :--- | :--- |
| `ResultClaimCandidate` | strict validation and diagnostic authorization | final revalidation only | unchanged | Interpreter output bound and checked by browser engine |
| `AcceptedResultClaim` | forbidden | created and committed | read only | Phase 4 player commit is sole writer |
| `ResultCanonicalClaim` and relation metadata | forbidden | created and committed | read only | Phase 4 canonical claim registry is sole writer |
| `ResultClaimRecordedEvent` | forbidden | created and committed | read only | Phase 4 semantic event registry is sole writer |
| Display plan canonical-claim segment | forbidden | created with the claim | consumed for rendering/history | Phase 4 plan writer; Phase 5 consumer migration |
| Player publication record | forbidden | exactly one created per committed input, with exactly one strict legacy-display mapping | prepared for delivery and acknowledged only after a successful browser/CLI sink | Phase 4 display-log and mapping writer; Phase 5 delivery consumer |
| Legacy `publicClaims` | NPC-only behavior unchanged | no player-origin dual-write | unchanged until its NPC migration | no player-origin legacy claim registry exists today |
| Legacy player question log/UI | diagnostic behavior unchanged | player-input entry and its identity mapping are effect deltas inside the same player commit; the legacy entry remains the one active visible-display trigger under the explicit Phase 4 exception | consumer resolves the strict mapping, sinks the structured publication, acknowledges it, and suppresses only that mapped legacy entry | exact replay appends no entry or mapping and produces no display delta |
| Claim rendering and player history | unchanged | no consumer migration | moves to canonical claims and committed display plans | Phase 5 reads Phase 4 records; it never creates a second claim |
| Idempotency result | forbidden | created atomically with all objects | reused | Phase 4 is sole writer; replay is read-only |

Phase 4 is the sole writer of all player-origin structured claim artifacts, including `CanonicalClaim`, repeat/contradiction metadata, display plan, player publication, strict legacy-display compatibility mapping, and commit result. There is no player-origin legacy claim registry to dual-write. The existing legacy player-question entry and its `PlayerLegacyDisplayCompatibilityRecord` are included as effect deltas in that same atomic player commit, and the legacy entry remains the only visible player-input display under the section 10 compatibility exception. It does not register player claims. Structured publications are stored but not additionally rendered during Phase 4, preventing double display.

Phase 5 migrates player-facing claim rendering, player conversation history projection, and display-plan/publication consumers to the records already committed by Phase 4. It does not generate, re-register, or re-version a claim. It prepares an unacknowledged publication, resolves and verifies its strict compatibility mapping, performs the browser/CLI sink, and only then acknowledges the publication and suppresses the mapped legacy entry. Non-display actions and failed sinks do not acknowledge it. After parity, retry, stale-session, and replay tests pass, Phase 5 disables the legacy player-input display consumer; physical deletion of obsolete compatibility paths remains Phase 9. Phase 5 read/render and acknowledgement cause no game-rule version increment.

Changing the Phase 4 feature flag during a session does not backfill old inputs. When off, one combined legacy compatibility transaction advances `N -> N+1`. When on with Phase 3 validation enabled, the structured player objects and player-side legacy display/history delta share one atomic `N -> N+1`; the later legacy NPC compatibility reaction, when successful, advances `N+1 -> N+2`. There is no extra compatibility transition between those ledger positions. Turning the flag off stops new structured writes and leaves committed records readable. Replay executes neither compatibility delta, provider path, nor display. Phase 6 replaces the provisional NPC transaction at the same ledger position, and Phase 8 replaces suspicion/memory derivation inside it; neither migration adds `N+2 -> N+3`.

### Privacy and implementation invariants

- Private seer results remain NPC-owned and are never projected merely to authorize a player assertion.
- The provider never receives hidden actual role/team, private result, private memory, or a truth label.
- Diagnostics and public errors identify only structural authorization failures and cannot reveal whether a result is true.
- `CanonicalClaim` stores only the player's canonical assertion and provenance already defined by `PlayerAcceptedActClaimSource`; it is not a hidden-truth record.
- Semantic claim events announce that a claim was recorded, not that its payload is true, and never trigger display.
- Exact replay returns the stored result without new claim relations, IDs, ordering, display, provider call, or version increment.
- A successful multi-act Phase 4 player commit increments exactly once regardless of claim count. Prepare, authorization, CAS, or publication failure leaves no structured object or counter gap.
- Phase 3 diagnostics cause no version transition. Phase 4 rejection causes no structured version transition. Phase 5 read/render migration causes no game-rule version transition.

### Required implementation tests

Phase 3 and Phase 4 tests must cover legal direct, public, private-language, hearsay-language, fabricated, false, and true assertions without inspecting hidden truth; non-seer behavior; public alive/dead NPC targets; rejected self/player/unknown/old-session targets; invalid enum and phase; stale authorization; whole-alternative rejection; privacy-safe errors; repeat and contradiction relations; exact replay; rollback; one version increment; and the Phase 3/4/5 feature/read/write matrix. Tests must prove that Phase 4 and Phase 5 never double-create or double-display a claim.

## 12. `PlayerInputRecord` and `PlayerUtteranceDisplayPlan`

### PlayerInputRecord
- **schemaVersion**: 1 (Integer, Required)
- **inputRecordId**: ID (Required)
- **requestId**: ID (Required)
- **correlationId**: ID (Required)
- **turnId**: ID (Required)
- **capturedStateVersion**: Integer (Required, minimum 0)
- **actorId**: ID (Required, bound by browser engine)
- **rawText**: String (Required, 1-2000 Unicode scalar values, authoritative player text)
- **locale**: SupportedLocale (Required)
- **createdOrder**: Integer (Required, minimum 0 and unique within session)
- **additionalProperties**: false

### ClaimSource (Strict Union)

`ClaimSource = PlayerAcceptedActClaimSource | NpcReactionClaimSource`, discriminated by `sourceType`.

- `PlayerAcceptedActClaimSource` requires discriminator `sourceType: "player_accepted_act"`, `acceptedSpeechActIds: ID[1..4]`, `inputRecordId: ID`, and `requestId: ID`.
- `NpcReactionClaimSource` requires discriminator `sourceType: "npc_reaction"`, `reactionPlanId: ID`, `descriptorId: ID`, `originatingInputRecordId: ID`, and `reactionCommitRequestId: ID`.

Both members have no optional/null fields and `additionalProperties: false`; cross-member fields are forbidden. Player accepted acts are unique, belong to one player commit/input and actor, and match claim actor. NPC plan and descriptor are committed, descriptor type matches claim type, plan NPC equals claim actor, and originating input caused the reaction. NPC claims never borrow a player accepted-act ID. Both role and result claims use this union.

Claim idempotency uses deterministic canonical JSON with sorted object keys and no display text or locale. Player key is `SHA-256(playerCommitRequestId, sorted acceptedSpeechActIds, actorId, claimKind)`. NPC key is `SHA-256(reactionCommitRequestId, reactionPlanId, descriptorId, actorId, claimKind)`. Equal key and normalized payload returns the existing claim; equal key with different payload is `idempotency_conflict`; replay never creates a new claim ID.

The record is created as an immutable staged value when input is received, before provider work, and is persisted authoritatively only by the atomic commit. Pending state may reference the staged ID. It is separate from prompts and model output. AI never rewrites `rawText` or binds `actorId`. Request, correlation, turn, and `capturedStateVersion` (the section 6A pre-commit value) must match the pending request; replay reuses the committed record and saved version. The raw-text bound exactly matches `InterpreterRequest`.

Phase 2 calls this runtime-only precursor `ShadowPlayerInputRecord`. It belongs to `ShadowInterpreterBinding`, is available to the pending request, retains the same identity across transport retries, and may be discarded after completion or abort. It is not appended to a committed conversation graph and creates no `CommitResult` or publication. Its `rawText` is never written to developer observations. Phase 2 does not change the authoritative `PlayerInputRecord` schema.

### PlayerUtteranceDisplayPlan
- **schemaVersion**: 1 (Integer, Required)
- **displayPlanId**: ID (Required)
- **inputRecordId**: ID (Required, must reference an existing `PlayerInputRecord`)
- **turnId**: ID (Required)
- **stateVersion**: Integer (Required, minimum 0; pre-display authoritative version)
- **segments**: Array of `PlayerDisplaySegment` (Required, 1-64 items, ordered)
- **additionalProperties**: false

Display-plan `stateVersion` is the player commit's resulting version, equal to the player publication `gameStateVersion`, creating event/claim versions, and player `CommitResult.resultingStateVersion`; it is not a display append counter.

### PlayerDisplaySegment (Strict Union)
1. **RawInputSegment** requires `segmentId: ID`, discriminator `type: "raw_input"`, `inputRecordId: ID`, and `sourceSpan: SourceSpan`; it forbids `claimId` and `voteEventId` and has `additionalProperties: false`.
2. **CanonicalClaimSegment** requires `segmentId: ID`, discriminator `type: "canonical_claim"`, and `claimId: ID`; it forbids `inputRecordId`, `sourceSpan`, and `voteEventId` and has `additionalProperties: false`.
3. **CanonicalVoteSegment** requires `segmentId: ID`, discriminator `type: "canonical_vote"`, and `voteEventId: ID`; it forbids `inputRecordId`, `sourceSpan`, `claimId`, and `suspicionEventId` and has `additionalProperties: false`.
4. **CanonicalSuspicionSegment** requires `segmentId: ID`, discriminator `type: "canonical_suspicion"`, and `suspicionEventId: ID`; it forbids `inputRecordId`, `sourceSpan`, `claimId`, and `voteEventId` and has `additionalProperties: false`.

Segments follow source order. Segment IDs are unique. Raw spans belong to the plan's input record, are in bounds, and do not overlap. A span canonicalized as a claim, vote, or suspicion event is omitted from raw segments, so raw and canonical segments never render the same semantic content twice. Canonical segments store only domain-object or public-event IDs, never canonical text. Multiple claims from one input produce multiple canonical segments in source order. Replay uses the stored plan unchanged, never reparses `rawText` after plan creation, and never uses AI-generated display text.

## 13. `NpcReactionPlan` Schema (Strict Union)

`NpcReactionPlan = CanonicalOnlyReactionPlan | ControlledCommentaryReactionPlan`, discriminated by `renderMode`.

For both members, `reactionPlanId` is the engine-owned logical reaction ID, `successfulAttemptId` is the engine-owned provider attempt that supplied the committed candidate, and `preconditionStateVersion + 1 == resultingStateVersion`. `causationId` is the triggering `PlayerConversationCommitResult.requestId`. `originatingInputRecordId` is mandatory and references that result's one committed `PlayerInputRecord`; `locale` is the originating record's `SupportedLocale` and is immutable on replay. The origin ID must equal every derived NPC claim source, event source, pending Renderer, and reservation. `causationEventIds` is auxiliary and contains 0-16 unique game-rule `PublicEvent` IDs committed before `NpcReactionPreparation` begins. Information-request-only input may use `[]`; when semantic events exist, their relevant IDs are normally included. Same-reaction, plan-derived, uncommitted, duplicate, cyclic, and display-log references are forbidden.

### CanonicalOnlyReactionPlan
- **Required**: `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `causationId: ID`, `originatingInputRecordId: ID`, `locale: SupportedLocale`, `causationEventIds: ID[0..16]`, `reactionPlanId: ID`, `successfulAttemptId: ID`, `turnId: ID`, `preconditionStateVersion: integer >= 0`, `resultingStateVersion: integer >= 1`, `npcId: ID`, `renderMode: "canonical_only"`, `intendedSpeechActs: CanonicalSpeechActDescriptor[1..16]`, `policies: ReactionPolicies`, `canonicalSegments: CanonicalSegment[1..16]`, `maxChars: integer 1..1000`
- **Forbidden**: `commentaryPlan`, `allowedVariants`
- **additionalProperties**: false

`successfulAttemptId` and `preconditionStateVersion` remain mandatory authoritative fields. The merged runtime `validateNpcReactionPlan()` currently omits both from its strict field set and therefore rejects a conforming plan as containing unknown fields. That is a known implementation contract gap, not an alternate schema. The first preparation implementation must update the validator, fixtures, and reference checks to this schema without deleting, making optional, or version-shifting either field. This documentation change does not modify runtime validation.

Every plan containing a state-changing descriptor uses this type. `CanonicalSpeechActDescriptor` is exactly `RoleClaimDescriptor | ResultClaimDescriptor | VoteDeclarationDescriptor | SuspicionDescriptor`; answers, acknowledgements, pondering, declines, clarification, and every other non-state-changing descriptor are forbidden. Its ordered canonical segments completely represent every intended descriptor. It never invokes the Renderer; only the engine-owned canonical renderer displays it.

### ControlledCommentaryReactionPlan
- **Required**: `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `causationId: ID`, `originatingInputRecordId: ID`, `locale: SupportedLocale`, `causationEventIds: ID[0..16]`, `reactionPlanId: ID`, `successfulAttemptId: ID`, `turnId: ID`, `preconditionStateVersion: integer >= 0`, `resultingStateVersion: integer >= 1`, `npcId: ID`, `renderMode: "controlled_commentary"`, `intendedSpeechActs: CommentarySpeechActDescriptor[1..16]`, `policies: ReactionPolicies`, `commentaryPlan: ControlledCommentaryPlan`, `maxChars: integer 1..1000`
- **Forbidden**: `canonicalSegments`
- **additionalProperties**: false

This type prohibits every state-changing descriptor, including `RoleClaimDescriptor`, `ResultClaimDescriptor`, `VoteDeclarationDescriptor`, `SuspicionDescriptor`, and any descriptor that updates suspicion score or memory. It permits only non-authoritative answers, acknowledgements, pondering, declines, and clarification requests. The AI selects only an engine-owned variant ID and version; it does not generate display prose.

### SpeechActDescriptor (Strict Union)
1. **RoleClaimDescriptor**: `{ descriptorId: ID, descriptorType: "role_claim", claimedRole: ClaimableRole, additionalProperties: false }`
2. **ResultClaimDescriptor**: `{ descriptorId: ID, descriptorType: "result_claim", targetId: ID, result: ClaimResult, additionalProperties: false }`
3. **VoteDeclarationDescriptor**: `{ descriptorId: ID, descriptorType: "vote_declaration", targetId: ID, additionalProperties: false }`
4. **SuspicionDescriptor**: `{ descriptorId: ID, descriptorType: "suspicion", targetId: ID, additionalProperties: false }`
5. **AnswerDescriptor**: `{ descriptorId: ID, descriptorType: "answer", topic: QuestionTopic, additionalProperties: false }`

`CommentarySpeechActDescriptor` is the strict union below. Every member is non-nullable and has `additionalProperties: false`.

| Member | Discriminator `descriptorType` | Required fields | Optional fields | Forbidden fields |
| :--- | :--- | :--- | :--- | :--- |
| `AnswerDescriptor` | `answer` | `descriptorId: ID`, `topic: QuestionTopic` | none | `targetId`, `claimedRole`, `result`, mutation fields |
| `AcknowledgementDescriptor` | `acknowledgement` | `descriptorId: ID`, `referenceId: ID` | none | `topic`, `targetId`, `claimedRole`, `result`, mutation fields |
| `PonderingDescriptor` | `pondering` | `descriptorId: ID`, `topic: QuestionTopic` | none | `targetId`, `claimedRole`, `result`, mutation fields |
| `DeclineDescriptor` | `decline` | `descriptorId: ID`, `reason: DeclineReason` | none | `topic`, `targetId`, `claimedRole`, `result`, mutation fields |
| `ClarificationRequestDescriptor` | `clarification_request` | `descriptorId: ID`, `reason: ClarificationReason` | `allowedTargetIds: ID[0..16]` | `topic`, `targetId`, `claimedRole`, `result`, mutation fields |

`referenceId` must exist in the controlled plan's allowed public references. `allowedTargetIds` contains unique IDs present in the public roster. All descriptor strings are IDs or closed enums, so no descriptor contains free-form text.

`ReactionPolicies` is a closed, non-nullable object requiring discriminator `policyType: "reaction_policies"`, `allowStateChanges: boolean`, `allowClaims: boolean`, `allowVoteDeclaration: boolean`, `allowSuspicionUpdate: boolean`, and `allowMemoryUpdate: boolean`. It has no optional fields, forbids every unlisted field, contains no references or length-bearing strings, and sets `additionalProperties: false`. Canonical-only policy booleans must exactly reflect its descriptors. Controlled commentary requires all five values to be `false`.

`ControlledCommentaryPlan` is a closed, non-nullable object requiring `intent: CommentaryIntent` and `allowedPublicReferenceIds: ID[0..32]`; it has no optional fields and `additionalProperties: false`. IDs are unique and must resolve to public projections in the eventual renderer request. This plan is the authoritative owner of the list.

### CanonicalSegment (Strict Union)
1. **NpcCanonicalClaimSegment**: `{ segmentId: ID, descriptorId: ID, type: "canonical_claim", claimId: ID, additionalProperties: false }`
2. **NpcCanonicalVoteSegment**: `{ segmentId: ID, descriptorId: ID, type: "canonical_vote", voteEventId: ID, additionalProperties: false }`
3. **NpcCanonicalSuspicionSegment**: `{ segmentId: ID, descriptorId: ID, type: "canonical_suspicion", suspicionEventId: ID, additionalProperties: false }`

Descriptor IDs are engine-generated, unique within the plan, immutable on replay, and never AI-generated. For every canonical-only plan, descriptors and segments have a one-to-one, order-preserving correspondence by `descriptorId`; referenced claim/event provenance carries that same ID. Dangling IDs are rejected. Controlled commentary uses the same unique-ID rule even though it has no canonical segments.

| Descriptor | Allowed plan | Canonical segment | Display source |
| :--- | :--- | :--- | :--- |
| `RoleClaimDescriptor` | canonical-only | `NpcCanonicalClaimSegment` referencing role claim | engine canonical claim renderer |
| `ResultClaimDescriptor` | canonical-only | `NpcCanonicalClaimSegment` referencing result claim | engine canonical claim renderer |
| `VoteDeclarationDescriptor` | canonical-only | `NpcCanonicalVoteSegment` | engine canonical vote renderer |
| `SuspicionDescriptor` | canonical-only | `NpcCanonicalSuspicionSegment` | engine canonical suspicion renderer |
| answer / acknowledgement / pondering / decline / clarification | controlled-commentary only | none | selected engine-owned registry variant |

## 14. `ControlledCommentaryVariant` Registry

### ControlledCommentaryVariant
- **schemaVersion**: 1 (Integer, Required)
- **variantId**: ID (Required, Max 64 chars)
- **variantVersion**: Integer (Required, Min 1)
- **locale**: SupportedLocale (Required)
- **renderMode**: Literal `controlled_commentary` (Required)
- **intent**: CommentaryIntent (Required)
- **text**: String (Required, 1-240 chars, NO placeholders)
- **enabled**: Boolean (Required)
- **maximumRenderedChars**: Integer (Required, 1-240 and not less than the actual text length)
- **toneTags**: Array of ToneTag (Required, 0-4 unique items)
- **lifecycle**: VariantLifecycle (Required)
- **additionalProperties**: false

The registry key is `(variantId, variantVersion, locale)`. Entries are immutable. An entry is never deleted; it moves to `retired` when no longer offered. Retired or disabled entries remain readable for replay.

### AllowedCommentaryVariantProjection (AI-facing)
- **schemaVersion**: 1 (Required)
- **variantId**: ID (Required, Max 64 chars)
- **variantVersion**: Integer (Required, Min 1)
- **locale**: SupportedLocale (Required)
- **intent**: CommentaryIntent (Required)
- **toneTags**: Array of ToneTag (Required, 0-4 unique items)
- **additionalProperties**: false

### RendererRequest and RendererModelOutput

`RendererRequest` requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `reactionPlanId: ID`, `turnId: ID`, `resultingStateVersion: integer >= 1`, `npcId: ID`, `locale: SupportedLocale`, `renderMode: "controlled_commentary"`, `commentaryPlan: ControlledCommentaryPlan`, `publicEvents: PublicEventProjection[0..64]`, `publicClaims: ClaimProjection[0..64]`, `publicVotes: PublicVoteProjection[0..32]`, `executions: ExecutionProjection[0..16]`, `attackDeaths: AttackDeathProjection[0..16]`, `allowedPublicReferenceIds: ID[0..32]`, and `allowedVariants: AllowedCommentaryVariantProjection[1..8]`; it has no optional fields and `additionalProperties: false`.

Every allowed public reference ID is unique and exists in one of the same request's public projection arrays; private and unknown IDs are prohibited. Projection IDs are globally unambiguous within the request. Allowed variants have unique `(variantId, variantVersion)` pairs, and a request must not contain multiple versions of one `variantId`.

`RendererRequest` deliberately does not include `publicRoster`. The Renderer selects only an engine-approved variant ID and version; it cannot generate participant IDs, display names, or utterance text. Public reference validation uses only `publicEvents`, `publicClaims`, `publicVotes`, `executions`, `attackDeaths`, `allowedPublicReferenceIds`, and `allowedVariants`. Participant display-name resolution belongs to the local-only canonical rendering context below and is never provider-facing.

`RendererModelOutput` requires exactly `schemaVersion: 1`, `selectedVariantId: ID`, and `selectedVariantVersion: integer >= 1`, with `additionalProperties: false`. The selected pair must exactly match one allowed variant and an existing enabled registry entry whose locale equals the request locale, render mode is `controlled_commentary`, and intent equals `commentaryPlan.intent`.

Schema-valid example:

```json
{
  "schemaVersion": 1,
  "requestId": "request-1001",
  "correlationId": "correlation-1001",
  "reactionPlanId": "reaction-1001",
  "turnId": "turn-7",
  "resultingStateVersion": 12,
  "npcId": "npc-aoi",
  "locale": "ja-JP",
  "renderMode": "controlled_commentary",
  "commentaryPlan": { "intent": "acknowledge", "allowedPublicReferenceIds": ["event-1001"] },
  "publicEvents": [{ "schemaVersion": 1, "projectionType": "public_statement_event", "eventId": "event-1001", "actorId": "player", "turnId": "turn-7", "occurredPhase": "day_discussion" }],
  "publicClaims": [],
  "publicVotes": [],
  "executions": [],
  "attackDeaths": [],
  "allowedPublicReferenceIds": ["event-1001"],
  "allowedVariants": [{ "schemaVersion": 1, "variantId": "ack-brief", "variantVersion": 2, "locale": "ja-JP", "intent": "acknowledge", "toneTags": ["brief"] }]
}
```

### SelectedCommentaryVariant

The persisted selection requires exactly `variantId: ID`, `variantVersion: integer >= 1`, and `locale: SupportedLocale`, with `additionalProperties: false`. Replay resolves this exact registry key and never substitutes the latest version or current UI locale. Disabled or retired variants remain available for historical reconstruction.

### CanonicalRenderingContext (local-only)

Canonical claim, vote, and suspicion renderers receive a local-only pure validation context that is separate from `RendererRequest`. `CanonicalRenderingContext` requires exactly `locale: SupportedLocale` and `publicParticipantsById: read-only participant projection index`, with no optional or nullable fields and `additionalProperties: false`.

Each participant projection requires exactly `participantId: ID` and `displayName: string[1..80 Unicode code points]`, with `additionalProperties: false`. The browser engine constructs this index through an explicit allowlist. Participant IDs are unique, unknown participant IDs are rejected, and renderer inputs and the index are not mutated. The projection contains no private role, team, memory, internal suspicion, provider diagnostic, or other unlisted field. This context is never sent to a provider and is never included in `RendererRequest`.

## 15. Public Projections (Strict Schemas)

All public projection objects in this section require `schemaVersion: 1`, use the closed `projectionType` discriminator below, have no optional or nullable fields, and set `additionalProperties: false`. Every String typed as ID uses the section 10 ID constraint. No public projection in this section may contain raw text, private memory, hidden role data, internal suspicion scores, provider diagnostics, or fields not listed in its row. String values other than IDs are limited by their referenced closed enum; no free-form public projection text exists. The Section 25A `NpcKnownInformationProjection` is a separate strict request projection with one explicitly allowlisted actor-private group; its public subobject still uses these public projection unions.

| Projection | `projectionType` | Other required fields | Forbidden fields (in addition to every unlisted field) |
| :--- | :--- | :--- | :--- |
| `PublicStatementEventProjection` | `public_statement_event` | `eventId: ID`, `actorId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `targetId`, `claimId`, `role`, `result`, `publicStatus` |
| `PublicQuestionEventProjection` | `public_question_event` | `eventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `occurredPhase: GamePhase`, `topic: QuestionTopic` | `claimId`, `role`, `result`, `publicStatus` |
| `SuspicionEventProjection` | `suspicion_event` | `eventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `claimId`, `role`, `result`, `publicStatus`, `score` |
| `VoteEventProjection` | `vote_event` | `eventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `claimId`, `role`, `result`, `publicStatus` |
| `RoleClaimEventProjection` | `role_claim_event` | `eventId: ID`, `actorId: ID`, `claimId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `targetId`, `role`, `result`, `publicStatus` |
| `ResultClaimEventProjection` | `result_claim_event` | `eventId: ID`, `actorId: ID`, `claimId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `targetId`, `role`, `result`, `publicStatus` |
| `RoleClaimProjection` | `role_claim` | `claimId: ID`, `actorId: ID`, `claimedRole: ClaimableRole` | `targetId`, `result`, `occurredPhase`, `publicStatus` |
| `ResultClaimProjection` | `result_claim` | `claimId: ID`, `actorId: ID`, `targetId: ID`, `result: ClaimResult` | `claimedRole`, `occurredPhase`, `publicStatus` |
| `PublicVoteProjection` | `public_vote` | `voteEventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `claimId`, `role`, `result`, `publicStatus` |
| `ExecutionProjection` | `execution` | `executionEventId: ID`, `executedPlayerId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `actorId`, `targetId`, `claimId`, `role`, `result`, `publicStatus` |
| `AttackDeathProjection` | `attack_death` | `attackEventId: ID`, `attackedPlayerId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `actorId`, `targetId`, `claimId`, `role`, `result`, `publicStatus` |

`PublicRosterEntry` does not contain `publiclyKnownStatus`; public suspicion is represented only by `SuspicionEventProjection`, preserving both the actor and target. It is derived solely from public events and never from internal suspicion scores or private memory.

Each request array has the maximum shown in `RendererRequest`, rejects duplicate primary IDs, preserves authoritative `createdOrder` (or source order for non-event projections), and rejects references to unknown IDs. Claim-event projections reference an existing same-request claim projection with matching actor and claim type. Public votes reference an existing vote event. Execution and attack-death player IDs are validated by the browser engine against its local public participant projection before request construction; the full roster is not copied into `RendererRequest`. Stable ordering is retained on replay.

### Projection unions

`PublicEventProjection` is the strict discriminated union `PublicStatementEventProjection | PublicQuestionEventProjection | SuspicionEventProjection | VoteEventProjection | RoleClaimEventProjection | ResultClaimEventProjection`. Its discriminator is `projectionType`; members, required fields, forbidden fields, ID limits, closed enums, nullability, and `additionalProperties: false` are exactly those in the table above. Event and claim references must resolve inside the same request projection graph. Display records are not model-facing public-event projections.

`ClaimProjection` is the strict discriminated union `RoleClaimProjection | ResultClaimProjection`. Its discriminator is `projectionType`; both members require `schemaVersion`, `claimId`, and `actorId`, accept no nulls or optional fields, and obey the member-specific fields and prohibitions above. Referenced actors and result targets must exist in `publicRoster`.

## 16. Enums

### GameRole
Closed enum: `seer`, `werewolf`, `citizen`. This is the authoritative role model currently implemented by the engine.

### ClaimableRole
Explicit closed subset of `GameRole`: `seer`, `werewolf`, `citizen`. `RoleClaimCandidate`, `AcceptedRoleClaim`, `RoleCanonicalClaim`, descriptors, and projections all reference this single definition. Future engine roles must first be added to `GameRole`; public claim support is then an explicit `ClaimableRole` decision.

### ClaimResult
Closed enum: `werewolf`, `not_werewolf`. Every candidate, accepted act, canonical claim, descriptor, event-derived view, and projection references this single definition.

### Other Closed Enums

- **PublicEventType**: `public_statement_recorded`, `public_question_recorded`, `suspicion_expressed`, `vote_declared`, `role_claim_recorded`, `result_claim_recorded`
- **QuestionTopic**: `role`, `result`, `vote`, `suspicion`, `opinion`, `reasoning`, `rules`, `other`. Candidate, accepted act, interpreter request/output validation, public event, and public projection all reference this one enum; no implicit topic conversion is permitted.
- **GamePhase**: `day_discussion`, `player_question`, `npc_response`, `vote`, `execution`, `night`, `seer_action`, `werewolf_attack`, `win_check`. These exact values come from the authoritative `PHASES` in `src/constants.mjs` and are enforced by `src/gameEngine.mjs`; any rename requires a future migration and schema-version change.
- **PublicStatus**: `alive`, `dead`; suspicion is deliberately not a roster status
- **CommentaryIntent**: `acknowledge`, `ponder`, `decline`, `ask_for_clarification`, `neutral_reaction`
- **ToneTag**: `formal`, `casual`, `brief`, `detailed`
- **VariantLifecycle**: `active`, `retired`
- **DeclineReason**: `not_allowed`, `insufficient_public_information`, `unsupported_topic`
- **ClarificationReason**: `ambiguous_target`, `ambiguous_intent`, `multiple_alternatives`, `uninterpretable`
- **ClarificationTemplateId**: `ask_for_target`, `ask_for_clarification`, `report_gibberish`
- **CandidateType**: `non_game_statement`, `question`, `suspicion`, `vote_declaration`, `role_claim`, `result_claim`, `information_request`, `uninterpretable`
- **RenderMode**: `canonical_only`, `controlled_commentary`
- **CommitType**: `player_conversation`, `npc_reaction`
- **PendingStatus**: `pending`, `aborting`, `completed`, `failed`
- **LogicalReactionStatus**: `planned`, `active`, `committed`, `rejected`, `superseded`, `cancelled`, `exhausted`
- **ReactionAttemptStatus**: `attempting`, `candidate_received`, `validated`, `accepted`, `failed`, `timed_out`, `rejected`, `aborted`
- **NpcReactionProposalType**: `role_claim`, `result_claim`, `vote_declaration`, `suspicion`
- **NpcRoleDisclosurePolicy**: `never_confess_werewolf`, `claim_when_directly_asked_after_result`, `avoid_unnecessary_claim`
- **Sha256Fingerprint**: 64 lowercase ASCII hexadecimal characters matching `^[0-9a-f]{64}$`
- **RFC3339Utc**: 20-35 ASCII characters, UTC timestamp ending in `Z`
- **ClientCorrelationId**: ID supplied for browser-domain causality and validated as untrusted input
- **ServerCorrelationId**: ID generated by the server immediately on HTTP receipt, before body parsing
- **LocaleTag**: syntactically valid String, 2-35 ASCII characters matching `^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$`; this accepts language-only tags such as `ja` and `en`
- **SupportedLocale**: closed deployment policy `ja`, `ja-JP`, `en`, `en-US`; requests/registry entries must be both a valid `LocaleTag` and a member of this allowlist

### Phase permission table

All candidate, accepted-act, interpreter-request, public-event, and stale-response checks use `GamePhase` without aliases.

| Phase | Player speech acts accepted | Notes |
| :--- | :--- | :--- |
| `day_discussion` | statements, questions, suspicions, role/result claims, information requests | vote declarations are rejected until `vote` |
| `player_question` | none in the structured pipeline | compatibility-only phase; never represents pending interpretation |
| `npc_response` | none in the structured pipeline | compatibility-only phase; never represents pending rendering |
| `vote` | vote declarations and information requests | claims/questions are rejected |
| `execution` | none | engine transition only |
| `night` | none | engine transition only |
| `seer_action` | none | engine-owned action only |
| `werewolf_attack` | none | engine-owned action only |
| `win_check` | none | engine-owned check only |

## 17. Atomic conversation commits

The structured order is `PlayerConversationCommit -> NpcReactionPreparation -> NpcReactionCommit -> optional Renderer call -> NPC utterance display`. Player and NPC commits are separate atomic transactions with distinct state-version increments.

### PlayerConversationCommit

One player commit contains one immutable `PlayerInputRecord`, `AcceptedSpeechAct[]`, `CanonicalClaim[]`, semantic `PublicEvent[]`, one `PlayerUtteranceDisplayPlan`, exactly one `PlayerUtterancePublishedRecord` (compatibility alias `PlayerUtterancePublishedEvent`), exactly one `PlayerLegacyDisplayCompatibilityRecord` while the legacy entry exists, suspicion/memory/history deltas, one idempotency record, and any turn/phase transition. For precondition version N, success produces N+1.

Prepare order is: capture staged immutable input; validate interpretation; bind actor; validate all acts; prepare accepted acts, claims, semantic events, display plan, publication event, and deltas; verify idempotency and state/phase preconditions; then commit. Preparation mutates no authoritative state.

### ConversationCommitDelta

The strict runtime delta requires `schemaVersion: 1`, `commitType: CommitType`, `requestId: ID`, `correlationId: ID`, `turnId: ID`, `preconditionPhase: GamePhase`, `resultingPhase: GamePhase`, `preconditionStateVersion: integer >= 0`, `resultingStateVersion: integer >= 1`, the complete prepared object/delta sets, and `requestFingerprint: Sha256Fingerprint`. It has no optional or nullable fields and `additionalProperties: false`. `resultingStateVersion` must equal precondition plus one.

Immediately before application, the engine rechecks turn, precondition phase/version, request idempotency, referenced IDs, alive/dead conditions, and phase permissions. Failure persists nothing and changes no counter, phase, turn, history, suspicion, memory, or version. Application uses copy-on-write or a reversible delta; exceptions restore the exact snapshot. All acts commit together. `AcceptedSpeechAct.acceptedStateVersion` and `acceptedPhase` store preconditions; claims, events, display plan, and publication store the common resulting version, while events store their semantic `occurredPhase`.

### NpcReactionPreparation

After player success at N+1, initial Phase 6 uses the pure preparation contract in section 25A to construct without side effects one canonical-only `NpcReactionPlan`, any canonical claims, semantic public events, exactly one canonical publication record, zero-valued suspicion/memory/legacy-history/vote/phase deltas, and one uncommitted idempotency reservation. Controlled-publication reservation remains Phase 7. Preparation stores the turn, `preconditionPhase`, `resultingPhase`, and precondition version N+1, but stores nothing authoritatively until the separately specified final commit succeeds.

### NpcReactionCommit

Immediately before commit, the engine requires matching current turn, phase, and N+1 version; an uncommitted reaction request; existing participants and referenced claims/events; valid phase permission; and a living actor when speech requires it. Failure discards preparation. Success atomically applies all reaction objects/deltas and increments N+1 to N+2. The reaction plan, claims, semantic events, and display reservation/immediate canonical record all reference N+2. Partial commit is prohibited and exceptions roll back exactly.

Canonical-only plans display immediately after commit, never call Renderer, and reference only claims/events committed in that same or an earlier transaction. Controlled commentary contains no state-changing claim/event, calls Renderer only after commit, and accepts only an engine-owned variant ID/version. Timeout, abort, or Renderer failure displays a deterministic engine-owned fallback and never rolls back committed NPC state.

### DisplayPublicationRecord (Separate Append-only Display Log)

`DisplayPublicationRecord = PlayerUtterancePublishedRecord | NpcCanonicalUtterancePublishedRecord | NpcUtterancePublicationReserved | NpcUtterancePublicationFinalized`, discriminated by `recordType`. This registry is session-authoritative for replay/UI, is part of protected structured-conversation state, and is excluded from game-rule `PublicEvent`; publication content never changes phase, permissions, or victory. Each successful authoritative append follows the general one-transaction/one-version-increment rule; Renderer processing, sink delivery, acknowledgement, and reads are separate nonauthoritative operations with increment zero. `publicationSlotOrder` is allocated once per publication ID and determines conversation position; `recordAppendOrder` is unique/monotonic per appended record and determines audit processing only. A reservation is never rendered as speech. Finalization resolves content into its existing slot, so delay never reorders later utterances; an unresolved slot shows an engine-owned loading indicator until same-session fallback policy finalizes it. Phase 7 must define the finalization append input, precondition/resulting version, idempotency lookup, CAS order, execution result, replay/conflict, and rollback before activation.

Phase 4 moves player publication into this log while retaining `PlayerUtterancePublishedEvent` as a read-compatibility alias; Phase 9 removes consumers that treat the alias as a game-rule event after replay fixtures are migrated.

`NpcCanonicalUtterancePublishedRecord` requires `schemaVersion: 1`, discriminator `recordType: "npc_canonical_published"`, `publicationId: ID`, `reactionPlanId: ID`, `reactionCommitRequestId: ID`, `originatingInputRecordId: ID`, `correlationId: ID`, `turnId: ID`, `reactionResultingStateVersion: integer >= 1`, `actorId: ID`, `locale: SupportedLocale`, `canonicalRendererVersion: integer >= 1`, `canonicalSegmentIds: ID[1..16]`, `publicationSlotOrder: integer >= 0`, and `recordAppendOrder: integer >= 0`, with no optional/null fields and `additionalProperties: false`. Canonical-only creates this exactly once inside `NpcReactionCommit`. Origin and locale match the plan/input. Replay uses stored locale/renderer version plus segments, never current UI locale; canonical text is not stored.

### NpcUtterancePublicationReserved

Controlled commentary creates exactly one reservation inside `NpcReactionCommit`, after its plan is prepared but in the same atomic commit. The strict record requires `schemaVersion: 1`, discriminator `recordType: "npc_publication_reserved"`, `publicationId: ID`, `reservationId: ID`, `reactionPlanId: ID`, `reactionCommitRequestId: ID`, `originatingInputRecordId: ID`, `correlationId: ID`, `turnId: ID`, `reactionResultingStateVersion: integer >= 1`, `actorId: ID`, `locale: SupportedLocale`, `renderMode: "controlled_commentary"`, `fallbackVariantId: ID`, `fallbackVariantVersion: integer >= 1`, `status: "reserved"`, `publicationSlotOrder: integer >= 0`, and `recordAppendOrder: integer >= 0`; it has no optional/null fields and `additionalProperties: false`.

`publicationId` and slot order are stable for the lifecycle; `reservationId` identifies this append-only record. The fallback registry key is exactly `(fallbackVariantId, fallbackVariantVersion, locale)`. Locale matches plan and originating input. Neither record nor fields are updated, replaced, or deleted.

### NpcUtterancePublicationFinalized

This append-only controlled-commentary record requires `schemaVersion: 1`, discriminator `recordType: "npc_publication_finalized"`, `finalizationId: ID`, `publicationId: ID`, `reservationId: ID`, `reactionPlanId: ID`, `source: FinalizationSource`, `correlationId: ID`, `turnId: ID`, `stateVersion: integer >= 1`, `actorId: ID`, `locale: SupportedLocale`, `selectedVariantId: ID`, `selectedVariantVersion: integer >= 1`, `finalizationReason: FinalizationReason`, `fallbackUsed: boolean`, `publicationSlotOrder: integer >= 0`, `recordAppendOrder: integer >= 0`, and `createdAt: RFC3339Utc`; it has no optional/null fields and `additionalProperties: false`. Its `stateVersion` is provenance for the originating NPC reaction's already committed resulting version and equals the reservation, reaction plan, and Renderer request reaction version. It is not the finalization append transaction's precondition version, resulting version, append-time current engine version, or the version that published this record.

`FinalizationSource` is a versioned strict discriminated-union type. Its baseline member set is exactly `RendererRequestFinalizationSource`, which requires discriminator `sourceType: "renderer_request"` and `rendererRequestId: ID`, forbids recovery fields, and has `additionalProperties: false`. It is used for success, timeout, abort, provider error, and invalid output; at append time the ID resolves to the still-active `PendingRendererRequest` and matches plan, publication, and locale. The embedded source is a self-contained provenance snapshot after validation; replay does not dereference runtime pending state. A future schema version may expand the union to `RendererRequestFinalizationSource | RecoveryFinalizationSource`; the reserved future member would require `sourceType: "session_recovery"`, `recoveryId`, and `recoveredSessionId`, and forbid `rendererRequestId`, but baseline validators reject it.

`FinalizationReason` is the baseline closed enum `renderer_selected | renderer_timeout_fallback | renderer_abort_fallback | renderer_error_fallback | renderer_invalid_output_fallback`. Selected registry key is exactly `(selectedVariantId, selectedVariantVersion, locale)` and matches the reservation. Timeout, abort, provider failure, or invalid output selects the reserved fallback key. Missing exact selected and fallback keys is a design error. Renderer failure never rolls back reaction state.

Finalization is compare-and-set on unfinalized `publicationId`: reservation exists, plan and pending renderer request match, locale matches, and selected triple is allowed. Renderer/provider success or fallback selection alone never creates this record. A future authoritative finalization append rereads the reservation and current publication ledger, validates finalization identity/idempotency, reuses the reservation's `publicationSlotOrder`, assigns current `nextRecordAppendOrder`, appends exactly one record, increments only `nextRecordAppendOrder`, and publishes the authoritative root once with exactly one general state-version increment. An identical replay increments neither counter nor version; conflict, stale, or failure publishes nothing. Append failure never rolls back the originating NPC reaction commit or its reservation. Initial Phase 6 canonical-only publication never uses this later transaction.

Required same-session order is: detect success/failure/timeout/abort; validate reservation; append finalization; persist finalization result; mark pending renderer terminal; remove it from active map. Pending is never removed before durable in-session finalization; failed finalization is safely retryable, and its audit-ring copy is never the authoritative source reference.

`NpcPublicationFinalizationResult` requires `schemaVersion: 1`, `publicationId: ID`, `reservationId: ID`, `finalizationId: ID`, `reactionPlanId: ID`, `source: FinalizationSource`, `locale: SupportedLocale`, `selectedVariantId: ID`, `selectedVariantVersion: integer >= 1`, `fallbackUsed: boolean`, `finalizationReason: FinalizationReason`, `publicationSlotOrder: integer >= 0`, `recordAppendOrder: integer >= 0`, and `createdAt: RFC3339Utc`, with no optional fields and `additionalProperties: false`. It exactly mirrors the stored finalization and never references an uncreated record; duplicate finalization returns it. This existing result does not contain complete authoritative append-transaction version evidence. Before Phase 7 implementation, separate authoritative docs must define the finalization append input, precondition/resulting state versions, idempotency record/lookup, CAS order, append execution result, replay/conflict, rollback, and exact delivery/finalization ownership. C1 does not invent those API or schema members.

### Baseline Recovery Scope

Reload/session rehydration recovery is explicitly unsupported in this baseline because no durable game session, display log, reservation, registry-version, or commit-result store exists. Same-session timeout/abort/error paths always finalize fallback before pending removal; page reload/session destruction may discard an unresolved runtime reservation. A future persistence phase is owned by the browser-session/storage subsystem and must persist `gameSessionId`, game-rule state, display log, unresolved reservations, registry version, locale, publication slot allocation, and commit results. Acceptance requires versioned serialization/migration, ordered rehydration, exact registry restoration, corruption/quota handling, multi-tab locking/CAS, fallback finalization, and rollback tests. Until then `RecoveryFinalizationSource` and all recovery-only finalization reasons are rejected by baseline schemas.

### ConversationCommitResult

`ConversationCommitResult = PlayerConversationCommitResult | NpcReactionCommitResult`, discriminated by `commitType`. This persisted strict union is keyed by request ID and fingerprint:

- `PlayerConversationCommitResult` requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `requestFingerprint: Sha256Fingerprint`, discriminator `commitType: "player_conversation"`, `preconditionStateVersion: integer >= 0`, `resultingStateVersion: integer >= 1`, `inputRecordId: ID`, `displayPlanId: ID`, `playerPublicationId: ID`, `createdEventIds: ID[0..64]`, `createdClaimIds: ID[0..4]`, and `createdAtOrder: integer >= 0`.
- `NpcReactionCommitResult = CanonicalNpcReactionCommitResult | ControlledNpcReactionCommitResult`, discriminated by `resultMode`. Both require `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `requestFingerprint: Sha256Fingerprint`, `commitType: "npc_reaction"`, `preconditionStateVersion: integer >= 0`, `resultingStateVersion: integer >= 1`, `reactionPlanId: ID`, `npcPublicationId: ID`, `createdEventIds: ID[0..64]`, `createdClaimIds: ID[0..4]`, and `createdAtOrder: integer >= 0`.
  - `CanonicalNpcReactionCommitResult` requires `resultMode: "canonical_only"` and forbids `reservationId`; `npcPublicationId` targets the immediate canonical record.
  - `ControlledNpcReactionCommitResult` requires `resultMode: "controlled_commentary"` and `reservationId: ID`; `npcPublicationId` targets the same-commit reservation's stable publication ID.

Both have no optional fields and `additionalProperties: false`. NPC result references the canonical record or same-commit reservation, never an uncreated finalization. Finalization result is stored separately. A committed duplicate does not invoke providers, create objects, advance version, or redisplay; it returns original IDs, including the same reservation. Fingerprint mismatch is `idempotency_conflict`.

`PlayerConversationCommitResult` deliberately has no mapping field. Its `playerPublicationId` must resolve exactly one `PlayerLegacyDisplayCompatibilityRecord.publicationId`; the committed graph rejects missing or multiple mappings. This provides indexed result-to-mapping traversal without changing the strict result union or scanning legacy text/log tails.

## 18. Pending conversation request

Provider waiting is runtime control state, not authoritative phase. From Phase 6, `PendingConversationRequest = PendingInterpreterRequest | PendingNpcReactionAttempt | PendingRendererRequest`, discriminated by `pendingType`; every member has no optional/null fields and `additionalProperties: false`.

- `PendingInterpreterRequest` requires `schemaVersion: 1`, `pendingType: "interpreter"`, `requestId: ID`, `correlationId: ID`, `turnId: ID`, `preconditionStateVersion: integer >= 0`, `inputRecordId: ID`, `targetNpcId: ID`, `operation: "interpret_player_input"`, `status: PendingStatus`, and `startedAt: RFC3339Utc`.
- `PendingNpcReactionAttempt` requires `schemaVersion: 1`, `pendingType: "npc_reaction"`, `gameSessionId: ID`, `requestId: ID`, `requestFingerprint: Sha256Fingerprint`, `correlationId: ID`, `causationId: ID`, `reactionPlanId: ID`, `reactionAttemptId: ID`, `originatingInputRecordId: ID`, `turnId: ID`, `turnOrder: safe integer >= 0`, `preconditionStateVersion: safe integer >= 0`, `preconditionPhase: GamePhase`, `targetNpcId: ID`, `operation: "generate_npc_reaction_candidate"`, `status: ReactionAttemptStatus`, and `startedAt: RFC3339Utc`.
- `PendingRendererRequest` requires `schemaVersion: 1`, `pendingType: "renderer"`, a distinct `requestId: ID`, `correlationId: ID`, `causationId: ID`, `turnId: ID`, `resultingStateVersion: integer >= 1`, `reactionPlanId: ID`, `originatingInputRecordId: ID`, `locale: SupportedLocale`, `targetNpcId: ID`, `operation: "render_npc_utterance"`, `status: PendingStatus`, and `startedAt: RFC3339Utc`.

The Interpreter member forbids `resultingStateVersion`, `reactionPlanId`, `reactionAttemptId`, `originatingInputRecordId`, and `causationId`. The NPC-reaction member forbids `resultingStateVersion`, `inputRecordId`, and Renderer selection/finalization fields. The Renderer member forbids `preconditionStateVersion`, `inputRecordId`, and `reactionAttemptId`. This exclusion prevents one version field or attempt identity from acquiring two meanings.

Interpreter pending stores the player precondition version and complete section 6A binding. Renderer pending is created only after `NpcReactionCommit`, stores that committed resulting version, and starts only while the just-committed reaction is at that version. Its originating input, locale, correlation ID, turn, and version exactly equal the reaction plan and RendererRequest. Later unrelated authoritative transitions do not rewrite those provenance values and do not by themselves invalidate Renderer selection; Renderer validation compares with the committed reaction/reservation, never the old player precondition or a later engine version. A future authoritative finalization append must nevertheless perform its separately defined append-time CAS. Interpreter and Renderer request IDs are different/session-unique. Renderer `causationId` resolves to the NPC reaction commit result or reaction plan.

In Phase 2, `InterpreterRequest.inputRecordId == PendingInterpreterRequest.inputRecordId == ShadowPlayerInputRecord.inputRecordId`. A transport `requestId` is never reused as an input-record ID.

### ShadowInterpreterBinding (Phase 2 runtime only)

`ShadowInterpreterBinding` requires exactly `schemaVersion: 1`, `sessionId: ID`, `inputRecordId: ID`, `shadowTurnId: ID`, and `shadowSnapshotVersion: integer >= 0`, with `additionalProperties: false`. The browser session runtime is its sole owner; it is neither authoritative game state nor a persisted-domain object.

Each new game receives a new session ID. Each logical shadow input receives one stable input-record ID and shadow turn ID. `shadowSnapshotVersion` increases monotonically within that session. Retries reuse the complete binding; edited or resubmitted input creates a new binding. Stale-session responses are rejected. Phase 2 maps `inputRecordId`, `shadowTurnId`, and `shadowSnapshotVersion` respectively to `InterpreterRequest.inputRecordId`, `turnId`, and `preconditionStateVersion`, without changing game phase or game state. Before Phase 3, these shadow fields are replaced by engine-owned authoritative turn/state metadata rather than being reinterpreted as authoritative values.

The runtime map is keyed by request ID. Active records reject duplicate submission. Interpreter terminal records may be removed after their result/failure is durably handled in session. A controlled Renderer record remains active through reservation validation, finalization append, and finalization-result persistence; only then is it marked terminal, its controller released, and it moved to a bounded developer-only audit ring. Aborted requests use `aborting`, then terminal status after fallback finalization. The audit ring is not an authoritative finalization reference and is discarded on reload/session destruction.

No provider operation changes authoritative phase. Timeout, abort, disconnect, schema/provider failure, or stale discard leaves phase/turn/version unchanged. Responses match the member-specific correlation, turn, operation, status, and version field. Pending-map state, not phase, blocks duplicate input. `player_question` and `npc_response` remain compatibility-only legacy phases and are not accepted-input phases in the structured pipeline; Phase 9 removes their premature-mutation call sites and legacy pending control.

## 19. Alternative acceptance and clarification

`confidence` is diagnostics-only. No threshold, margin, sort order, or "highest confidence" rule may affect acceptance.

- Zero alternatives is an invalid provider response and maps through `ErrorEnvelope`; it is never semantic success.
- Semantic uninterpretable is exactly one alternative containing exactly one `UninterpretableCandidate`. It means provider call and schema validation succeeded and produces clarification.
- Malformed JSON, wrong request/correlation ID, unsupported schema version, timeout, and transport/provider failure never become `UninterpretableCandidate`; they map to `ErrorEnvelope` or stale-response discard.
- Exactly one alternative proceeds to engine validation.
- More than one alternative always produces `ClarificationOutcome`; no state-changing or non-state-changing alternative is auto-selected.
- Every act in the sole alternative is validated as one transaction. Multiple state-changing acts are all-or-nothing, partial acceptance is prohibited, and one invalid act rejects the entire alternative.
- A sole alternative containing only valid non-state-changing acts may be accepted atomically and may create display/public statement events but no state mutation.
- `UninterpretableCandidate` never becomes an `AcceptedSpeechAct`; it produces clarification.

### ClarificationOutcome

This strict schema requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `turnId: ID`, `preconditionStateVersion: integer >= 0`, `reason: ClarificationReason`, `templateId: ClarificationTemplateId`, and `allowedTargetIds: ID[0..16]` with unique items. It has no optional or nullable fields and `additionalProperties: false`. Target IDs must exist in the request's public roster.

The engine applies the exact Phase 3 response classification in section 6A: request/correlation schema mismatch is invalid provider output; absent/terminal pending or session/turn/version/phase/actor/input mismatch is stale; an identical already-recorded terminal response is an idempotent duplicate. A clarification continuation retains the captured logical turn, stages a new input/request identity against the unchanged version, and creates no accepted act, public event, canonical claim, turn advance, or state-version advance. Display uses only the engine-owned template identified by `templateId`; AI-generated explanation text is prohibited.

## 20. Input Interpreter contract

### Provider interface

```js
interpretPlayerInput(request, { signal })
```

### InterpreterRequest

Required fields are `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `inputRecordId: ID`, `turnId: ID`, `preconditionStateVersion: integer >= 0`, `preconditionPhase: GamePhase`, `locale: SupportedLocale`, `rawText: string[1..2000 code points]`, `playerContext: InterpreterPlayerContext`, `publicRoster: PublicRosterEntry[1..16]`, `allowedCandidateTypes: CandidateType[1..8]`, `publicContext: InterpreterPublicContext`, and `limits: InterpreterLimits`. There are no optional or nullable fields and `additionalProperties: false`.

`InterpreterPlayerContext` requires only `playerId: ID` and `publicStatus: PublicStatus`. `PublicRosterEntry` requires `playerId: ID`, `displayName: string[1..80]`, and `publicStatus: PublicStatus`. `InterpreterPublicContext` requires `publicEvents: PublicEventProjection[0..64]`, `publicClaims: ClaimProjection[0..64]`, `publicVotes: PublicVoteProjection[0..32]`, `executions: ExecutionProjection[0..16]`, and `attackDeaths: AttackDeathProjection[0..16]`. `InterpreterLimits` requires `maxAlternatives: integer 1..3`, `maxActsPerAlternative: integer 1..4`, and `maxNestingDepth: integer 1..8`. Each nested type has no optional fields, rejects null, and has `additionalProperties: false`; IDs are unique and references resolve within the request.

Phase 2 always includes the allowlisted public roster. The five structured projection arrays contain records only when the browser engine already owns their authoritative structured IDs. Until those records exist, an empty array means `authoritative structured-ID projection is not yet available`. Implementations must not synthesize IDs from legacy `publicInfo`, legacy claims, vote/execution/attack history, array indexes, display text, or any other unstable source. Legacy free-form public information is not added to `InterpreterRequest.rawText` or another model-facing field.

Schema-valid Phase 2 request excerpt:

```json
{"schemaVersion":1,"requestId":"interpreter-1","correlationId":"correlation-1","inputRecordId":"shadow-input-1","turnId":"shadow-turn-1","preconditionStateVersion":0,"preconditionPhase":"day_discussion","locale":"ja-JP","rawText":"Aoiはどう思う？","playerContext":{"playerId":"player","publicStatus":"alive"},"publicRoster":[{"playerId":"player","displayName":"Player","publicStatus":"alive"},{"playerId":"npc-aoi","displayName":"Aoi","publicStatus":"alive"}],"allowedCandidateTypes":["question","uninterpretable"],"publicContext":{"publicEvents":[],"publicClaims":[],"publicVotes":[],"executions":[],"attackDeaths":[]},"limits":{"maxAlternatives":3,"maxActsPerAlternative":4,"maxNestingDepth":8}}
```

`CandidateType` is the closed enum matching the eight candidate discriminators. `allowedCandidateTypes` is derived from the phase permission table. The request never includes private roles, hidden teams, private results, NPC private memory, internal suspicion scores, API credentials, or provider diagnostics.

### Prompt-injection boundary

`rawText`, roster `displayName`, and every public projection value are untrusted data, never instructions. Fixed system/developer instructions and serialized data payloads use separate provider fields or message parts; player/public text is never concatenated into an instruction string. Text such as "ignore the schema" has no authority. The model may select only allowlisted IDs supplied in data and may emit only schema fields. Schema-valid output still requires browser-engine phase, roster, reference, authorization, and atomic-commit validation. Confidence, explanations, and diagnostics never authorize behavior. Injection detection is not implemented with Japanese regexes or other semantic keyword blocks. Public projections are constructed by an explicit allowlist, and private facts never enter the prompt.

### InterpreterModelOutput

The model output is exactly the schema in section 7: structured semantic alternatives only. It contains no correlation envelope, diagnostics, provider metadata, accepted acts, public events, state updates, or display text.

### InterpreterProviderResult

This strict provider-layer schema requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `modelOutput: InterpreterModelOutput`, and `diagnostics: ProviderDiagnostics`; it has no optional or nullable fields and `additionalProperties: false`. `ProviderDiagnostics` is developer-only and requires `providerName: string[1..64]`, `model: string[1..128]`, `attemptCount: integer 1..3`, and `elapsedMs: integer >= 0`, with `additionalProperties: false`. Diagnostics never enter public projections.

The provider receives the validated `InterpreterRequest`, including `inputRecordId`, unchanged across attempts. The result does not duplicate the input ID; the browser correlates it through the still-active pending request. Phase 2 additionally requires the complete shadow binding; Phase 3 replaces that check with the engine-owned session/turn/version/phase/actor/input binding in section 6A.

### InterpreterHttpResponse

The HTTP success envelope requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ClientCorrelationId`, `serverCorrelationId: ServerCorrelationId`, and `result: InterpreterProviderResult`, with no optional fields, no nulls, and `additionalProperties: false`. Client IDs must equal the validated request and nested provider result; server correlation is transport-owned.

The endpoint strictly validates `InterpreterRequest.inputRecordId`. In Phase 2 the browser accepts a success response only while the matching pending request carries the same input ID and complete shadow binding. In Phase 3 it instead requires the complete authoritative binding and exact stale checks in section 6A; no shadow field participates.

## 21. Renderer contract

### Provider interface

```js
renderNpcUtterance(request, { signal })
```

Canonical-only plans never call this interface. Controlled commentary supplies the `RendererRequest` in section 14, and the model returns only `selectedVariantId` plus `selectedVariantVersion`; raw in-world text is prohibited.

The renderer correlation chain is an exact invariant: `RendererRequest.correlationId == PendingRendererRequest.correlationId == RendererProviderResult.correlationId == RendererHttpResponse.correlationId == NpcReactionPlan.correlationId`. Any mismatch is stale or invalid and is rejected without state mutation.

`ControlledCommentaryPlan.allowedPublicReferenceIds` is the authoritative source. `RendererRequest.allowedPublicReferenceIds` is an engine-produced projection copy that must be byte-for-byte equal in order and content; neither server nor provider may independently add, remove, or reorder IDs. Duplicate, private, and unknown IDs are rejected.

### RendererProviderResult

This strict schema requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `reactionPlanId: ID`, `modelOutput: RendererModelOutput`, and `diagnostics: ProviderDiagnostics`; it has no optional or nullable fields and `additionalProperties: false`. Its request ID, correlation ID, and reaction plan ID exactly match `RendererRequest`. The selected variant pair is validated against the request before return.

### RendererHttpResponse

The HTTP success envelope requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ClientCorrelationId`, `serverCorrelationId: ServerCorrelationId`, `reactionPlanId: ID`, and `result: RendererProviderResult`, with no optional fields, no nulls, and `additionalProperties: false`. Its request ID, client correlation ID, and reaction plan ID exactly match both `RendererRequest` and the nested provider result. A stale or mismatched response is discarded without retry or state mutation.

## 22. HTTP endpoint contract

All endpoints accept only `Content-Type: application/json; charset=utf-8`, reject content encoding, and limit the decoded request body to 64 KiB. Before reading or parsing the body, the server generates a unique `ServerCorrelationId`; it is returned in every success/error response and used in logs. Body `correlationId` is an untrusted `ClientCorrelationId` and never replaces the server ID. The server validates transport schemas and correlation only; it never decides authoritative game state, phase legality, claim permission, or roster membership.

| Endpoint | Request | 200 response |
| :--- | :--- | :--- |
| `POST /api/interpret-player-input` | `InterpreterRequest` | `InterpreterHttpResponse` |
| `POST /api/generate-npc-reaction-candidate` (Phase 6) | `NpcReactionCandidateRequest` | `NpcReactionCandidateHttpResponse` |
| `POST /api/render-npc-utterance` | `RendererRequest` | `RendererHttpResponse` |

For all endpoints: malformed JSON returns 400 `malformed_json`; schema violations return 400 `invalid_schema`; unsupported `schemaVersion` returns 400 `unsupported_schema_version`; idempotency fingerprint conflict returns 409 `idempotency_conflict`; unsupported media type returns 415; oversized body returns 413; server rate limit returns 429; invalid provider output or provider authentication failure returns 502; unavailable provider returns 503; provider timeout returns 504. Client disconnect aborts body read, provider call, and backoff and sends no new response. The request `AbortSignal` is propagated through the entire chain.

Logs always include `serverCorrelationId` and may include a validated client correlation/request ID, endpoint, status, duration, attempt count, and normalized error code. They must not include raw bodies, raw provider responses, stack traces in client responses, API keys, prompts, private data, variant registry text, or raw player text.

## 23. ErrorEnvelope

`ErrorEnvelope` requires `schemaVersion: 1`, `requestId: ID | null`, `correlationId: ServerCorrelationId`, and `error: ErrorDetail`; it has no optional fields and `additionalProperties: false`. Here `correlationId` is always the server-generated transport ID, including malformed JSON; `requestId` is null when safe extraction is impossible. A parsed client correlation is never trusted as this field. `ErrorDetail` requires `code: ErrorCode` and `retryable: boolean`, has no optional or nullable fields, and sets `additionalProperties: false`. `retryable` means `clientRequestRetryable`, not internal attempt state.

| HTTP | ErrorCode | Retryable |
| :--- | :--- | :--- |
| 400 | `malformed_json`, `invalid_schema`, `unsupported_schema_version` | false |
| 409 | `idempotency_conflict` | false |
| 413 | `body_too_large` | false |
| 415 | `unsupported_media_type` | false |
| 429 | `server_rate_limited` | true only when a usable `Retry-After` fits the deadline |
| 502 | `invalid_provider_response`, `provider_auth_failure` | false |
| 503 | `provider_unavailable` | conditionally true |
| 504 | `provider_timeout` | conditionally true |

The error response contains no message field and never exposes provider bodies, stack traces, credentials, prompts, private data, or raw player text.

## 24. Timeout, retry, and AbortSignal

- Global deadline: 15 seconds from server receipt.
- Maximum attempts: 3 including the first.
- Maximum per-attempt timeout: 5 seconds; actual timeout is `min(5 seconds, remaining deadline)`.
- Backoff before attempts two and three: 1 second, then 2 seconds.
- `minimumAttemptBudget`: 1 second.
- `responseValidationBudget`: 500 milliseconds.
- `maximumRetryAfter`: 2 seconds.
- `requestId`, `correlationId`, `turnId`, and the operation-specific precondition/resulting version remain unchanged across attempts; an Interpreter retry also preserves input ID, captured phase, actor, game session, and request fingerprint.
- One AbortSignal chain covers HTTP body/request lifecycle, provider call, per-attempt timeout, and backoff; client disconnect aborts the same chain.
- A next attempt starts only when `remaining deadline >= backoff + minimumAttemptBudget + responseValidationBudget`. Its attempt timeout is capped by the remaining deadline after reserved validation budget.
- Provider authentication failure, invalid request/output schema, wrong correlation ID, and stale response are never retried. Stale responses are discarded.
- Only explicitly classified transient network failures, timeouts, and selected provider-unavailable responses may retry; provider 5xx is not automatically transient.
- `Retry-After` is honored only when valid, at most `maximumRetryAfter`, and the wait plus minimum attempt and validation budgets fits the remaining deadline.

`providerInternalRetryable` controls hidden attempts inside one HTTP request; the request ID and idempotency key remain unchanged. `clientRequestRetryable` is the public `ErrorEnvelope.error.retryable`. An exact browser retry of the same logical input reuses `requestId`, `correlationId`, `inputRecordId`, and the stable idempotency key; it is a transport re-attempt, not a new logical request. A user-edited or newly submitted input gets new IDs. Server-internal retry details are never exposed as authorization or state.

## 25. Referential integrity

Targets must exist before the source or be created in the same atomic commit. Dangling references are rejected. Replay never substitutes IDs. Committed history objects are append-only and never physically deleted; cleanup is limited to derived caches and bounded runtime pending-audit records.

| Source object | Reference field | Target object | Cardinality | Creation ordering | Replay rule | Deletion rule |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `InterpreterRequest` (Phase 2) | `inputRecordId` | runtime-only staged `ShadowPlayerInputRecord` | exactly 1 equal to pending input ID | before provider call | retry reuses complete shadow binding | removable after terminal handling |
| `PlayerInputRecord` | `requestId` | `ConversationRequestIdentity` / idempotency record | exactly 1 | identity staged before provider; committed together | reuse same request/fingerprint | append-only |
| `AcceptedSpeechAct` | `inputRecordId` | `PlayerInputRecord` | exactly 1 | same player commit | preserve ID | append-only |
| `CanonicalClaim.source` (player) | `acceptedSpeechActIds` | `AcceptedSpeechAct[]` | 1-4 unique | same player commit; same actor/input | preserve ordered IDs; exact duplicate reuses claim | append-only |
| `CanonicalClaim.source` (NPC) | `reactionPlanId` | committed `NpcReactionPlan` | exactly 1 | same NPC commit plan created before claim | preserve ID; duplicate reaction reuses claim | append-only |
| `CanonicalClaim.source` (NPC) | `descriptorId` | plan `intendedSpeechActs[].descriptorId` | exactly 1 | same commit; descriptor prepared first | preserve ID; dangling/conflict rejected | append-only |
| semantic `PublicEvent.source` (player) | `acceptedSpeechActId` | `AcceptedSpeechAct` | exactly 1 | same player commit | preserve ID; exact duplicate reuses event | append-only |
| semantic `PublicEvent.source` (NPC) | `reactionPlanId` | committed `NpcReactionPlan` | exactly 1 | same NPC commit plan prepared first | preserve ID; duplicate reuses event | append-only |
| semantic `PublicEvent.source` (NPC) | `descriptorId` | plan `intendedSpeechActs[].descriptorId` | exactly 1 | same NPC commit | preserve ID; dangling/conflict rejected | append-only |
| reaction `CanonicalSegment` | `descriptorId` | plan `intendedSpeechActs[].descriptorId` | exactly 1 | same NPC commit; order-preserving | preserve ID; dangling/conflict rejected | append-only |
| `PlayerUtterancePublishedRecord` | `inputRecordId` | `PlayerInputRecord` | exactly 1 | same player commit | reuse record | append-only |
| `PlayerUtterancePublishedRecord` | `displayPlanId` | `PlayerUtteranceDisplayPlan` | exactly 1 and target unique | same player commit | never redisplay | append-only |
| `PlayerLegacyDisplayCompatibilityRecord` | `publicationId` | `PlayerUtterancePublishedRecord` | exactly 1 and target unique | same player commit | reuse mapping | Phase 9 |
| `PlayerLegacyDisplayCompatibilityRecord` | `legacyEntryId` + `legacyLogAppendOrder` | exact legacy player entry verified by canonical fingerprint | exactly 1 and location unique | same player commit | reuse mapping; never infer | Phase 9 |
| `PlayerLegacyDisplayCompatibilityRecord` | `inputRecordId` / `displayPlanId` | player input / display plan | exactly 1 each | same player commit | preserve IDs | append-only targets |
| `PlayerConversationCommitResult` | `playerPublicationId` | compatibility mapping `publicationId` | exactly 1 | same player commit | return original ID | mapping removed only in Phase 9 |
| `NpcReactionPlan` | `originatingInputRecordId` | committed `PlayerInputRecord` | exactly 1 | before reaction preparation | preserve ID; derived sources must match | append-only |
| `NpcReactionPlan` | `locale` | originating `PlayerInputRecord.locale` | exactly 1 equal | copied during preparation | preserve stored locale | append-only |
| `NpcReactionPlan` | `causationEventIds` | previously committed `PublicEvent` | 0-16 unique | strictly before reaction preparation; same-commit forbidden | preserve IDs; cycles rejected | append-only |
| `PendingRendererRequest` | `originatingInputRecordId` | plan `originatingInputRecordId` | exactly 1 equal | after reaction commit | preserve ID | runtime source removable only after finalization |
| `PendingRendererRequest` | `locale` | `RendererRequest.locale` and reservation locale | exactly 1 equal | after reservation | preserve locale | runtime source removable only after finalization |
| `RendererRequest` | `correlationId` | plan, pending Renderer, provider result, and HTTP response correlation IDs | exactly 1 equal | copied from committed reaction | mismatch rejected as stale/invalid | immutable request |
| `NpcUtterancePublicationReserved` | `reactionPlanId` | `ControlledCommentaryReactionPlan` | exactly 1 | same NPC commit, plan prepared first | reuse reservation | append-only |
| `NpcUtterancePublicationReserved` | `locale` | plan `locale` | exactly 1 equal | same NPC commit | preserve locale; no UI substitution | append-only |
| `NpcUtterancePublicationFinalized` | `publicationId` | reservation `publicationId` | exactly 1 | later display-log CAS | return stored finalization on duplicate | append-only |
| `NpcUtterancePublicationFinalized` | `reservationId` | reservation `reservationId` | exactly 1 | reservation must preexist | preserve ID; conflict rejected | append-only |
| `NpcUtterancePublicationFinalized` | `locale` | reservation `locale` | exactly 1 equal | reservation preexists | replay exact registry triple | append-only |
| `NpcUtterancePublicationFinalized` | `source.rendererRequestId` | active `PendingRendererRequest` | exactly 1 in baseline | before pending terminal/removal | duplicate returns stored result | runtime target removed only after result persistence |
| `NpcPublicationFinalizationResult` | `finalizationId` | `NpcUtterancePublicationFinalized` | exactly 1 | finalization appended first | exact mirror returned | append-only |
| `PendingRendererRequest` | `reactionPlanId` | committed `ControlledCommentaryReactionPlan` | exactly 1 | after reaction commit | validate same plan/version | runtime record removable; target append-only |
| `NpcReactionCandidateRequest` | complete immutable reaction binding | one expected logical reaction/attempt, triggering player result/input, and captured engine snapshot | exactly 1 of each | before provider invocation | request fingerprint stable; attempt ID changes only on retry | runtime-only; no authoritative target created |
| `NpcReactionCandidateProviderResult` | every binding echo | exact request plus expected active or retained-terminal `PendingNpcReactionAttempt`/logical preparation binding | exactly 1 | response validation only | equal candidate may deduplicate only after all echoes match | provider object discarded after detached validation |
| `NpcReactionProposal.targetId` | captured public participant and current authoritative roster | exactly 1 in each; kind-specific allowlist also required | exactly 1 | validation only | no proposal replay creates authority | runtime-only candidate reference |
| `PlayerConversationCommitResult` | `playerPublicationId` | `PlayerUtterancePublishedRecord.publicationId` | exactly 1 | same player commit | return original ID | append-only |
| `ControlledNpcReactionCommitResult` | `reservationId` | `NpcUtterancePublicationReserved.reservationId` | exactly 1 | same NPC commit; never finalization | return original ID | append-only |
| `CanonicalClaim` | `idempotencyKey` | provenance-specific canonical derivation | exactly 1 | computed before claim creation | same payload returns existing claim; mismatch conflicts | immutable |

`ConversationRequestIdentity` is the pair `(requestId, requestFingerprint)` stored in the idempotency index; request ID is unique, and a mismatched fingerprint is rejected.

## 25A. Phase 6 structured NPC reaction migration

This section is normative for Phase 6. It defines the transport and validation schemas needed by a future implementation; the design change itself does not implement an endpoint, provider, feature flag, validator, commit, or runtime behavior. Section 25A is the single normative source for the Phase 6 candidate contract; status, roadmap, and changelog summaries must not restate or vary its schemas.

### Audited baseline and ownership

| Boundary | Implemented baseline | Existing documented contract | Phase 6 decision | Deferred |
| :--- | :--- | :--- | :--- | :--- |
| Authoritative owner | `WerewolfGame` in `src/gameEngine.mjs` owns state; browser and CLI each create a separate process-local instance/session | sections 6 and 6A require exactly one active owner per active session | unchanged; that session's owner alone allocates identities, validates, commits, and increments version | shared cross-process sessions, persistence, reload, multi-tab, and server authority |
| Player transaction | `dispatchPlayerAction()` and `_commitStructuredPlayerQuestion()` perform the Phase 4 player `N -> N+1` transaction | sections 6A and 17 define atomic `PlayerConversationCommit` | unchanged and completed before reaction planning | no Phase 4 rewrite |
| Current NPC transaction | `_commitStructuredPlayerQuestion()` creates a reaction binding, calls `handlePlayerQuestion()` on a copy, applies a final CAS, and publishes the compatibility copy as `N+1 -> N+2`; failure retains `N+1` | the version ledger already reserves `N+1 -> N+2` for the reaction and says Phase 6 replaces, never follows, the compatibility transition | replace that one transition when the Phase 6 route is selected; never add a third transition | legacy physical deletion in Phase 9 |
| Legacy NPC content | `buildNpcResponseRequest()` in `src/responseGenerator.mjs` derives a request and `generateResponse()` returns text; `validateProviderResponse()` checks a nonempty text envelope; `handlePlayerQuestion()` then writes legacy log, public info, memory, and optional claim to a working copy | provider output is untrusted and AI-generated authoritative/display text is prohibited by the target design | the enabled route accepts only a strict structured candidate and constructs engine-owned plans/effects; raw text cannot commit or display | prompt-quality changes and controlled Renderer integration |
| Provider and server | `public/httpResponseProvider.mjs` sends `/api/npc-response`; `src/webServer.mjs` is a request validator/proxy and owns no game session | sections 6, 22, and 24 require stateless transport, bounded payloads, abort, timeout, and redaction | new candidate transport remains stateless; a server success is not a game commit acknowledgement | distributed coordination and server transactions |
| Stale/abort control | Phase 4 reaction binding rechecks session, turn, order, phase, version, target, and request identity; `destroy()` aborts active work | final CAS is required immediately before every commit | preserve those dimensions and add logical-reaction/attempt/terminal-result checks | durable queues and crash recovery |
| Known information | `buildNpcResponseRequest()` currently selects recent `publicInfo`, actor `knownInfo`, actor suspicion, and policy-derived data, but its request is not a strict Phase 6 allowlist projection | sections 15 and 28 prohibit private facts in provider projections without defining an NPC actor-private projection | replace it in the enabled route with the strict engine-owned projection below | legacy request remains only on the disabled route |
| Player display | Phase 5 uses exact mapping, requested/effective modes, sink-success receipts, acknowledgement, and non-consuming history | sections 6A and 17 define the completed player delivery contract | unchanged; Phase 6 adds a separate NPC publication consumer keyed by NPC publication identity | unified physical cleanup in Phase 9 |
| Browser/CLI sinks | `public/browserApp.mjs` owns DOM adaptation; `src/cli.mjs` uses the same `WerewolfGame` module and a process-local sink | sinks and observers are non-authoritative | both consume only committed NPC publication records and share one engine contract | remote observer guarantees |

The implemented compatibility provider can return free-form text and the target `NpcReactionPlan` contract cannot. That mismatch is the migration boundary, not permission to wrap legacy text in a structured record. The current provider remains selected only when the Phase 6 flag is disabled. The Phase 6 route needs a separately validated structured-candidate response in a later implementation PR.

### Non-negotiable authority and transaction rules

Authority is session-local and single-owner: exactly one active `WerewolfGame` instance owns one active game session. In web execution, the owner is the active instance in the browser process. In CLI execution, the owner is the active instance in the CLI process for a distinct CLI-local session. Browser and CLI never jointly own or act as authoritative replicas of the same active session. Phase 6 adds no cross-process reconciliation; the proxy server, browser/CLI adapters, observers, and history readers cannot arbitrate or acquire authority.

Provider output is untrusted even when its JSON is structurally valid. The provider, proxy server, browser DOM, CLI writer, observer, history reader, and legacy fallback own no game state and cannot assign an authoritative ID, authorize an actor, project known information, apply a state patch, increment a version, or prove a commit. Server acknowledgement proves transport completion only; sink success proves delivery only.

Player and NPC work are two separate transactions. A player commit at version `N` completes as `N -> N+1` before a reaction is planned. A successful NPC reaction commit compares against that committed state and performs exactly `N+1 -> N+2`. Provider failure, timeout, cancellation, structural or semantic rejection, stale or duplicate output, and preparation/commit exception perform zero increments and retain the player commit at `N+1`. A browser or CLI failure after reaction commit retains `N+2`, performs no rollback or compensating version change, and leaves publication retryable. One authoritative commit always equals one version increment.

The enabled route and legacy route are selected once, before reaction execution, and stored as the logical reaction's immutable route snapshot. A failed enabled-route attempt never invokes the legacy route for the same logical reaction. A normal flag change affects only later logical reactions; it neither cancels nor converts an already planned reaction.

### Identity model and trigger binding

Phase 6 reuses repository-native identities:

- `reactionPlanId` is both the **logical reaction ID** and the primary ID of the eventual authoritative `NpcReactionPlan`; there is no second authoritative reaction-record ID. `WerewolfGame` allocates it once after the player commit and before provider work. It is unique within `gameSessionId`, stable across retries, and commits at most once.
- `reactionAttemptId` is the only new identity primitive. `WerewolfGame` allocates a new value for every engine-level provider attempt. It is runtime control/provenance until the winning value is copied into `NpcReactionPlan.successfulAttemptId`; an attempt ID is never reused.
- `npcId`/`targetNpcId` is the engine-selected **actor ID**. A provider only echoes it; it cannot substitute another actor.
- `causationId` is the exact **trigger identity**, equal to the triggering `PlayerConversationCommitResult.requestId`. `originatingInputRecordId` is that result's `inputRecordId`. The result, input, turn, player correlation, actor, and player resulting version must form one exact committed graph. That originating player correlation remains in `knownInformation.public.triggeringInput`; it is distinct from the new reaction `correlationId` below.
- `requestId` is the stable, session-unique reaction commit/idempotency operation ID. It remains unchanged across attempts so every retry addresses the same intended commit; reuse by another logical reaction is an identity conflict.
- `correlationId` is the stable trace ID for all attempts, transport observations, commit, and publication of one logical reaction. It remains unchanged across attempts but never acts as an idempotency key or authorizes a commit. Its separate role from `requestId` is observability, not operation identity.
- `requestFingerprint` is the engine-computed SHA-256 fingerprint of the immutable logical request/binding/projection and remains fixed across attempts.
- `candidateFingerprint` is the engine-computed `sha256CanonicalJson()` value of the strict normalized `NpcReactionCandidate` object alone, under the exact algorithm below. It identifies exact repeated output within one attempt and is stored only in runtime idempotency/tombstone control; the provider neither supplies nor authorizes it.

The preparation binding is exactly `(gameSessionId, reactionPlanId, requestId, correlationId, causationId, originatingInputRecordId, turnId, turnOrder, preconditionPhase, preconditionStateVersion, npcId, requestFingerprint)`. `preconditionStateVersion` is the player result's `N+1`. The final commit must re-read every live dimension; an immutable preparation snapshot alone is insufficient.

`NpcReactionPlan.successfulAttemptId` records the one engine-issued attempt whose validated candidate was committed. `NpcReactionPlan.preconditionStateVersion` records `N+1`, and `resultingStateVersion` must equal it plus one. Provider-supplied IDs are correlation echoes only and never become authoritative merely by matching syntax.

### Deterministic actor policy

Initial Phase 6 permits exactly one logical NPC reaction for one committed `ask_npc` player action. The actor is the already validated target NPC captured by the Phase 4 commit binding. The engine does not ask the provider to choose an actor, does not fan out to other NPCs, and does not run parallel candidate generation. Other top-level action types schedule no Phase 6 reaction unless a later design explicitly defines their trigger.

This restriction makes ordering deterministic: player commit first, then at most one reaction commit for the same `turnId`. A failed or exhausted reaction has no later actor to block. A future ordered multi-NPC queue may derive multiple logical reactions from one trigger, but it must use deterministic engine ordering, capture each next base version after the prior commit, serialize commits, and increment once per committed NPC. Parallel authoritative commits are prohibited; that future extension is outside Phase 6.

### Logical reaction and attempt state machines

The session-local reaction coordinator owns two separate state machines. A logical reaction owns zero or more attempts; an attempt never owns or substitutes the logical status. Runtime states and redacted observations are non-authoritative and never increment `stateVersion`.

#### Logical reaction status

| Status | Meaning | Legal next statuses | Terminal |
| :--- | :--- | :--- | :--- |
| `planned` | immutable binding, route snapshot, projection, logical ID, and policy are prepared without provider work | `active`, `cancelled`, `superseded` | no |
| `active` | one attempt is active or a retry remains eligible | `committed`, `rejected`, `superseded`, `cancelled`, `exhausted` | no |
| `committed` | one attempt won the atomic NPC commit | none | yes |
| `rejected` | non-retryable structural, semantic, authorization, identity, or provider-contract failure ended the reaction | none | yes |
| `superseded` | session/turn/phase/version/actor/target applicability no longer matches | none | yes |
| `cancelled` | reset/destroy or explicit emergency cancellation ended the reaction before commit | none | yes |
| `exhausted` | every allowed retryable attempt ended and no attempt/deadline budget remains | none | yes |

`exhausted` is required and is distinct from an attempt's `failed` or `timed_out`. A logical reaction never leaves a terminal status. Only `committed` corresponds to an authoritative NPC reaction.

#### Reaction attempt status

| Status | Meaning | Legal next statuses | Terminal for this attempt |
| :--- | :--- | :--- | :--- |
| `attempting` | one exact `reactionAttemptId` has an active provider invocation | `candidate_received`, `failed`, `timed_out`, `aborted` | no |
| `candidate_received` | one correlated candidate exists but has no authority | `validated`, `rejected`, `aborted` | no |
| `validated` | the detached candidate passed correlation, strict structure, fingerprint, and semantic authorization; no authoritative delta or object exists yet | `accepted`, `rejected`, `aborted` | no |
| `accepted` | this attempt supplied the candidate committed by the logical reaction | none | yes |
| `failed` | transport/provider operation failed | none | yes |
| `timed_out` | the attempt deadline expired and its signal was aborted | none | yes |
| `rejected` | candidate/identity/authorization validation failed | none | yes |
| `aborted` | reset, destroy, emergency cancellation, or stale/superseded final CAS stopped the attempt | none | yes |

An attempt terminal status is immutable; retry never reopens it and always creates a new `reactionAttemptId` under the same logical reaction. A retryable `failed` or `timed_out` attempt returns its logical owner to the retry-eligible portion of `active`; a fresh attempt then starts. A non-retryable provider/auth/schema failure uses attempt `failed` and logical `rejected`. Structural, semantic, authorization, correlation, actor, or identity validation failure uses attempt `rejected` and logical `rejected`; validation failure is never retryable. A stale base/applicability result uses attempt `aborted` with reason `stale_result` and logical `superseded`. Explicit emergency cancellation uses attempt `aborted` and logical `cancelled`.

Exact duplicate responses do not transition either machine. A late result for a timed-out/failed/aborted attempt is duplicate or stale diagnostic input according to the conflict matrix below. After logical `committed`, every non-winning attempt is terminal or forced to `aborted`, and none can commit.

```text
LogicalReaction:
planned -> active -> committed
planned -> active -> exhausted
planned -> active -> rejected
planned -> active -> superseded
planned -> active -> cancelled
planned -> superseded/cancelled

ReactionAttempt:
attempting -> candidate_received -> validated -> accepted
attempting -> failed
attempting -> timed_out
candidate_received -> rejected
validated -> rejected
attempting/candidate_received/validated -> aborted
```

### Structured candidate transport and validation

The Phase 6 transport operation is the literal `generate_npc_reaction_candidate`. The provider receives one strict request for one engine-issued attempt and returns one strict semantic candidate. No request or response object has optional or nullable fields. Every object has `additionalProperties: false`; forbidden and unknown fields are rejected rather than stripped. IDs use the section 10 `ID` pattern, fingerprints use `Sha256Fingerprint`, and every integer is a nonnegative JavaScript safe integer unless a smaller bound is stated. Decoded request and response bodies are each at most 65,536 bytes. The section 28 nesting limits remain request 8, candidate/model 5, and HTTP 10.

#### `NpcReactionCandidateRequest`

`NpcReactionCandidateRequest` has exactly these fields:

| Field | Required type and rule |
| :--- | :--- |
| `schemaVersion` | literal `1` |
| `operation` | literal `generate_npc_reaction_candidate` |
| `gameSessionId` | `ID`; active engine session |
| `reactionPlanId` | `ID`; stable logical reaction ID |
| `reactionAttemptId` | `ID`; unique to this provider invocation |
| `requestId` | `ID`; stable logical operation ID |
| `requestFingerprint` | `Sha256Fingerprint`; stable across attempts |
| `correlationId` | `ID`; stable trace ID |
| `causationId` | `ID`; triggering player commit request ID |
| `originatingInputRecordId` | `ID`; exact committed player input |
| `turnId` | `ID`; originating logical command |
| `turnOrder` | safe integer `>= 0` |
| `preconditionPhase` | literal `player_question` in initial Phase 6 |
| `preconditionStateVersion` | safe integer `>= 0`; the player commit's `N+1` |
| `npcId` | `ID`; engine-selected alive NPC actor |
| `knownInformation` | strict `NpcKnownInformationProjection` from the next subsection |
| `limits` | exact `NpcReactionCandidateLimits` |

`NpcReactionCandidateLimits` is exactly `{ "maxProposals": 16, "maxNestingDepth": 5 }`. The candidate constraints are exactly `knownInformation.constraints`; they are not duplicated as another request field. The request validator requires `knownInformation.public.phase == preconditionPhase`, `knownInformation.actorPrivate.actorId == npcId`, and the triggering result/input/turn/version graph to match `causationId`, `originatingInputRecordId`, `turnId`, and `preconditionStateVersion`. The player result/input correlation must match within that originating graph; it is not required to equal the separately allocated reaction `correlationId`.

The engine computes `requestFingerprint` with `sha256CanonicalJson()` over a new plain object reconstructed from every request field except `reactionAttemptId` and `requestFingerprint`. The reconstruction preserves the field values and array order, and includes `schemaVersion`, `operation`, the remaining complete binding, `knownInformation`, and `limits`. Excluding only the per-attempt ID and the fingerprint itself makes the value stable across retries without weakening any attempt echo check. The provider never computes or replaces it.

#### Candidate and proposal union

`NpcReactionCandidate` has exactly `schemaVersion: 1` and `proposals: NpcReactionProposal[1..16]`. Proposal order is semantic and is preserved through validation and later descriptor construction. In initial Phase 6, the combined number of `role_claim` and `result_claim` proposals is additionally bounded to `0..4`, matching unchanged `CanonicalNpcReactionCommitResult.createdClaimIds: ID[0..4]`. Five claim-producing proposals are a stage-11 `invalid_candidate_schema` bound violation before candidate fingerprinting or preparation; they are never a valid `ValidatedNpcReactionCandidate`. The merged candidate validator does not yet enforce this combined sub-bound and must be aligned in the later preparation implementation together with the plan-validator gap. The provider-facing union uses discriminator `proposalType` and is separate from the authoritative `CanonicalSpeechActDescriptor` union:

| Member | Exact required fields | All other fields |
| :--- | :--- | :--- |
| `NpcRoleClaimProposal` | `proposalType: "role_claim"`, `claimedRole: ClaimableRole` | forbidden, including `targetId` and `result` |
| `NpcResultClaimProposal` | `proposalType: "result_claim"`, `targetId: ID`, `result: ClaimResult` | forbidden, including `claimedRole` |
| `NpcVoteDeclarationProposal` | `proposalType: "vote_declaration"`, `targetId: ID` | forbidden, including `claimedRole` and `result` |
| `NpcSuspicionProposal` | `proposalType: "suspicion"`, `targetId: ID` | forbidden, including `claimedRole` and `result` |

Every proposal is a strict non-null object. No member may carry `descriptorId`, `claimId`, `eventId`, `segmentId`, `publicationId`, any authoritative or resulting version, an effect, a state patch, a policy/disclosure boolean, a confidence, an explanation, or display prose. Initial Phase 6 has no arbitrary proposal reference field: `targetId` is the only proposal-level reference. `knownInformation.constraints.allowedReferenceIds` bounds projected context and prompt use, but the provider cannot return one of those IDs as a proposal field. Trigger identity remains in the request binding.

Exact proposal duplicates are determined by canonical JSON equality after strict reconstruction and reject the whole candidate as `duplicate_proposal`. Contradiction rules are also whole-candidate atomic, but stage 16 receives only proposals that each passed stage-15 authorization:

- at most one role claim is allowed; a second identical authorized claim is a duplicate. Initial v1 authorizes only the actor's seer claim, so a different role fails stage-15 `permission_denied` and cannot be used as a `contradictory_proposals` reachability vector;
- one result claim is allowed per target; an identical authorized target/result pair is a duplicate and two independently authorized results for one target would be contradictory. Initial engine-owned facts cannot authorize a false cross-result pair, so that pair first fails stage-15 `result_fact_mismatch`; different authorized result targets are allowed;
- at most one vote declaration is allowed; an identical second vote is a duplicate and a different second target is contradictory;
- one suspicion is allowed per target; an identical target is a duplicate and different targets are allowed;
- different proposal kinds may coexist and retain their original order, but each is authorized independently from pre-candidate state.

Any invalid member rejects the complete candidate; no valid subset is retained. The reserved future discriminator literals `commentary`, `answer`, `acknowledgement`, `decline`, and `clarification` are rejected as `unsupported_in_phase6`. Every other unrecognized discriminator, unknown field, missing field, null, wrong enum, wrong type, bound violation, or nesting violation is `invalid_candidate_schema`. The provider cannot create a controlled-commentary reservation; Phase 7 owns that design.

After parsing, the engine validates the source object, reconstructs a new plain `NpcReactionCandidate` containing only the exact fields above, recursively freezes the detached reconstruction, and never reuses or shares provider-owned objects. Structural reconstruction is not semantic authorization.

#### Target and proposal authorization matrix

All proposal kinds must appear in `knownInformation.constraints.allowedCandidateKinds`. A proposal with a target must satisfy every common rule: its ID occurs exactly once in captured `public.participants`, belongs to `allowedTargetIds`, is neither `npcId` nor the player-class participant, resolves exactly once in the current authoritative roster for the same active session, and has not disappeared through reset or roster replacement. The final live check repeats the kind-specific eligibility; “live check” means checking current state, not requiring `publicStatus: "alive"` for kinds whose row does not require it.

| Proposal kind | Target rule |
| :--- | :--- |
| `role_claim` | `targetId` is forbidden |
| `result_claim` | the common reference/target rules apply: the target is one captured/current NPC other than the actor and player; the target need not be alive. `allowedResultTargetIds`, `allowedResultValues`, and the exact actor-owned fact are checked later as one result-fact authorization step, not as common target eligibility |
| `vote_declaration` | target is in `allowedLivingTargetIds` and remains alive at final validation |
| `suspicion` | target is in `allowedLivingTargetIds` and remains alive at final validation |

For `result_claim`, membership of `targetId` in `allowedResultTargetIds` and membership of `result` in `allowedResultValues` are necessary but not sufficient. These two memberships are part of exact result-fact authorization and do not make a resolved NPC target ineligible. `knownInformation.actorPrivate.investigationResults` must contain an exact actor-owned fact with the same `targetId` and `result`; changing the target or result independently is rejected as `result_fact_mismatch`. Public hearsay, provider assertion, the target's hidden role, another actor's fact, and a same-candidate role claim never substitute for that exact fact. Initial Phase 6 deliberately permits no NPC result bluff.

The stage-15 `result_claim` first-failure order is exact:

| Order | Check | Exact failure |
| :--- | :--- | :--- |
| 1 | `result_claim` belongs to `allowedCandidateKinds` | `authorization/permission_denied/policy` |
| 2 | the closed seer-disclosure policy, direct role/result question, actor role, actor-owned-result presence, phase, and every other disclosure precondition permit the claim | `authorization/permission_denied/policy`; an unknown engine-owned policy is a stage-0 request/projection invariant failure, not a provider rejection |
| 3 | `targetId` resolves exactly once in captured participants/reference graph and the current same-session roster | a provider target absent from the valid captured graph is `authorization/unknown_reference/reference`; a duplicated engine-owned participant ID is a stage-0 request/live-snapshot invariant failure, and a hard session/turn/roster replacement is stage-10 `applicability/stale_request/live_state` |
| 4 | the resolved target is an NPC other than `npcId` and the player-class participant and satisfies the common proposal target class rule | `authorization/target_ineligible/target`; dead-but-rostered is valid for `result_claim` |
| 5 | `targetId` is in `allowedResultTargetIds`, `result` is in `allowedResultValues`, and one exact same-target/same-result actor-owned investigation fact exists | `authorization/result_fact_mismatch/known_information` |
| 6 | stage 17 deterministically repeats the current target/reference/applicability predicates against the same immutable snapshot | the same specific code that owns the failed predicate; there is no generic final-live code |

The exact-fact step classifies a target-only change, result-only change, cross-pair assembled from two different facts, public hearsay only, another actor's fact only, provider assertion only, hidden-role agreement only, and same-candidate role-claim support as `result_fact_mismatch`. A target absent from the common graph remains `unknown_reference`; a self or player-class target remains `target_ineligible`. Death alone never rejects a uniquely resolved result target.

Normative result-claim vectors use otherwise conforming input and differ only as stated:

| Vector | Minimum captured/current facts | Candidate difference | First outcome |
| :--- | :--- | :--- | :--- |
| exact valid fact | actor owns `(npc-beni, werewolf)`; target is a rostered NPC | `(npc-beni, werewolf)` | continue through stage 15 |
| target-only mismatch | actor owns `(npc-beni, werewolf)`; `npc-chika` is another eligible rostered NPC | `(npc-chika, werewolf)` | `authorization/result_fact_mismatch/known_information` |
| result-only mismatch | actor owns `(npc-beni, werewolf)` | `(npc-beni, not_werewolf)` | `authorization/result_fact_mismatch/known_information` |
| cross-pair mismatch | actor owns `(npc-beni, werewolf)` and `(npc-chika, not_werewolf)` | `(npc-beni, not_werewolf)` | `authorization/result_fact_mismatch/known_information` |
| absent common reference | target ID is well formed but absent from captured/current participants | absent target | `authorization/unknown_reference/reference` |
| self target | actor resolves uniquely | `targetId == npcId` | `authorization/target_ineligible/target` |
| player-class target | the single player resolves uniquely | player target | `authorization/target_ineligible/target` |
| dead-but-rostered exact fact | actor owns the exact fact; the target is uniquely rostered with `publicStatus: "dead"` | exact target/result | continue through stage 15 and 17 |
| public hearsay only | public projection contains the assertion but actor owns no matching investigation fact | same assertion | `authorization/result_fact_mismatch/known_information` |
| another actor's fact only | selected actor owns no matching fact | same assertion | `authorization/result_fact_mismatch/known_information` |
| policy denied | target/fact would otherwise be exact; known closed policy denies disclosure | exact target/result | `authorization/permission_denied/policy` before fact inspection |

#### Closed role-disclosure policy

`NpcRoleDisclosurePolicy` is the closed enum projected from the current engine policy. Its meanings are:

| Policy | Authoritative meaning | `role_claim` | `result_claim` |
| :--- | :--- | :--- | :--- |
| `never_confess_werewolf` | werewolf policy; never reveal the actor's werewolf role or fabricate investigation authority | denied | denied |
| `claim_when_directly_asked_after_result` | seer policy; disclosure is permitted only after the actor owns at least one investigation result and the triggering player question directly targets that actor about role or result | allowed only by the rules below | allowed only by the rules below |
| `avoid_unnecessary_claim` | citizen policy; the initial structured route does not create a role or result claim | denied | denied |

“Directly asked” is not inferred from raw-text keywords or provider output. It requires a captured `PublicQuestionEventProjection` with `actorId: "player"`, `targetId == npcId`, `turnId == request.turnId`, `occurredPhase: "day_discussion"`, `topic` equal to `role` or `result`, and `eventId` in `allowedReferenceIds`. Candidate validation itself runs with captured and current `preconditionPhase == "player_question"`.

A role claim is allowed only when all of the following hold: the kind is allowlisted; the policy is `claim_when_directly_asked_after_result`; the direct-question event exists; the authoritative actor role is `seer`; the actor owns at least one investigation result; `allowedClaimRoles` is exactly `["seer"]`; and `claimedRole` is both in that list and equal to the actor's own role. Otherwise `allowedClaimRoles` is exactly `[]` and a role claim is denied. A citizen claim, werewolf confession, and false role claim are therefore impossible in the initial provider contract.

A result claim is allowed only when the same seer policy, phase, and direct-question conditions hold and the exact target/result fact passes the preceding matrix. A role claim earlier in the same candidate cannot create or broaden result permission; all proposals are authorized against the captured pre-candidate policy and facts. Prior public disclosure neither grants permission nor blocks a currently permitted repeat. Repeat/contradiction relations with committed claims are derived later by the authoritative preparation/commit phase; they are not provider fields and do not alter validation permission.

Semantic denial precedence is exact: stale session/turn/version/phase/actor or broken trigger binding; candidate-kind allowlist; closed disclosure-policy and role conditions; common reference resolution; common target eligibility; exact result-fact authorization; then within-candidate duplicate/contradiction checks. Structural validation always precedes these semantic checks. `roleDisclosurePolicy` is engine-owned and strictly validated as part of the captured projection at stage 0; an unknown value is `invalid_expected_request`, never a provider rejection. Public diagnostics expose only the normalized reason code, never the actor's hidden role, team, fact, or policy text.

The initial strict projection requires `allowedCandidateKinds` to equal all four initial proposal kinds, so a conforming v1 request cannot produce a candidate-kind denial. The ordered check remains mandatory, but the provider-reachable `permission_denied` vector is a known-policy/direct-question/actor-role disclosure denial. Likewise, duplicate engine-owned participant IDs are stage-0 invariants; `unknown_reference` is reached by a well-formed provider `targetId` absent from an otherwise valid captured graph, not by corrupting that graph.

#### Provider result and HTTP success envelope

`NpcReactionCandidateProviderResult` requires exactly `schemaVersion: 1`, `operation: "generate_npc_reaction_candidate"`, every immutable binding echo (`gameSessionId`, `reactionPlanId`, `reactionAttemptId`, `requestId`, `requestFingerprint`, `correlationId`, `causationId`, `originatingInputRecordId`, `turnId`, `turnOrder`, `preconditionPhase`, `preconditionStateVersion`, and `npcId`), `candidate: NpcReactionCandidate`, and `diagnostics: ProviderDiagnostics`. It has no optional/null fields. For Phase 6, the existing strict `ProviderDiagnostics` schema applies and `attemptCount` must be literal `1`, because one engine attempt maps to one provider invocation. Diagnostics are untrusted transport observations, excluded from all candidate fingerprints, projections, authority, public errors, and commit decisions.

`NpcReactionCandidateHttpResponse` requires exactly `schemaVersion: 1`, `operation: "generate_npc_reaction_candidate"`, `requestId: ID`, `correlationId: ClientCorrelationId`, `serverCorrelationId: ServerCorrelationId`, `reactionPlanId: ID`, `reactionAttemptId: ID`, and `result: NpcReactionCandidateProviderResult`. The top-level request, correlation, plan, and attempt fields must equal both the request and nested result; `serverCorrelationId` is transport-owned and has no nested copy.

The nested provider result echoes every immutable binding field and the engine compares each echo byte-for-byte with both `NpcReactionCandidateRequest` and the expected `PendingNpcReactionAttempt`/logical preparation binding. That pending snapshot may be active or a retained terminal attempt used only to classify a late response; terminal status does not weaken any echo comparison. The pending NPC member stores the complete identity needed for this comparison, with `targetNpcId == request.npcId`. `knownInformation` and `limits` are not echoed: their exact values are held in the immutable request and covered by the recomputed `requestFingerprint`. An echo can correlate but never authorize; a mismatch is rejected before candidate semantic validation.

Normative conforming request example:

```json
{
  "schemaVersion": 1,
  "operation": "generate_npc_reaction_candidate",
  "gameSessionId": "game-session-1",
  "reactionPlanId": "reaction-plan-1",
  "reactionAttemptId": "reaction-attempt-1",
  "requestId": "reaction-request-1",
  "requestFingerprint": "ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6",
  "correlationId": "correlation-1",
  "causationId": "player-request-1",
  "originatingInputRecordId": "input-1",
  "turnId": "turn-1",
  "turnOrder": 1,
  "preconditionPhase": "player_question",
  "preconditionStateVersion": 2,
  "npcId": "npc-aoi",
  "knownInformation": {
    "schemaVersion": 1,
    "projectionType": "npc_known_information",
    "public": {
      "day": 1,
      "phase": "player_question",
      "participants": [
        { "participantId": "npc-aoi", "displayName": "Aoi", "publicStatus": "alive" },
        { "participantId": "npc-beni", "displayName": "Beni", "publicStatus": "alive" },
        { "participantId": "player", "displayName": "Player", "publicStatus": "alive" }
      ],
      "events": [
        {
          "schemaVersion": 1,
          "projectionType": "public_question_event",
          "eventId": "event-question-1",
          "actorId": "player",
          "turnId": "turn-1",
          "occurredPhase": "day_discussion",
          "targetId": "npc-aoi",
          "topic": "result"
        }
      ],
      "claims": [],
      "votes": [],
      "executions": [],
      "attackDeaths": [],
      "triggeringInput": {
        "schemaVersion": 1,
        "inputRecordId": "input-1",
        "requestId": "player-request-1",
        "correlationId": "player-correlation-1",
        "turnId": "turn-1",
        "capturedStateVersion": 1,
        "actorId": "player",
        "rawText": "Aoi, what is your role and result?",
        "locale": "en"
      }
    },
    "actorPrivate": {
      "actorId": "npc-aoi",
      "ownRole": "seer",
      "ownTeam": "village",
      "investigationResults": [
        { "day": 1, "targetId": "npc-beni", "result": "werewolf", "disclosurePolicy": "engine_policy_required" }
      ],
      "voteHistory": [],
      "suspicionScores": [{ "targetId": "npc-beni", "score": 2 }]
    },
    "constraints": {
      "allowedTargetIds": ["npc-beni"],
      "allowedLivingTargetIds": ["npc-beni"],
      "allowedResultTargetIds": ["npc-beni"],
      "allowedCandidateKinds": ["role_claim", "result_claim", "vote_declaration", "suspicion"],
      "allowedClaimRoles": ["seer"],
      "allowedResultValues": ["werewolf"],
      "allowedReferenceIds": ["event-question-1", "input-1"],
      "roleDisclosurePolicy": "claim_when_directly_asked_after_result"
    },
    "presentation": { "speechStyleId": "brief" }
  },
  "limits": { "maxProposals": 16, "maxNestingDepth": 5 }
}
```

Normative conforming HTTP success example for that request:

```json
{
  "schemaVersion": 1,
  "operation": "generate_npc_reaction_candidate",
  "requestId": "reaction-request-1",
  "correlationId": "correlation-1",
  "serverCorrelationId": "server-correlation-1",
  "reactionPlanId": "reaction-plan-1",
  "reactionAttemptId": "reaction-attempt-1",
  "result": {
    "schemaVersion": 1,
    "operation": "generate_npc_reaction_candidate",
    "gameSessionId": "game-session-1",
    "reactionPlanId": "reaction-plan-1",
    "reactionAttemptId": "reaction-attempt-1",
    "requestId": "reaction-request-1",
    "requestFingerprint": "ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6",
    "correlationId": "correlation-1",
    "causationId": "player-request-1",
    "originatingInputRecordId": "input-1",
    "turnId": "turn-1",
    "turnOrder": 1,
    "preconditionPhase": "player_question",
    "preconditionStateVersion": 2,
    "npcId": "npc-aoi",
    "candidate": {
      "schemaVersion": 1,
      "proposals": [
        { "proposalType": "role_claim", "claimedRole": "seer" },
        { "proposalType": "result_claim", "targetId": "npc-beni", "result": "werewolf" }
      ]
    },
    "diagnostics": {
      "providerName": "example-provider",
      "model": "example-model",
      "attemptCount": 1,
      "elapsedMs": 125
    }
  }
}
```

The examples' `requestFingerprint` is the exact `sha256CanonicalJson()` value over the request-fingerprint input defined above; both copies must be byte-equal.

#### Candidate transport evidence contract

Candidate validation accepts raw success-response evidence, not a pre-parsed JavaScript object. `NpcReactionCandidateTransportEvidence` is a strict runtime-only object with exactly the following required fields, no optional or additional fields, and only the two explicitly nullable header fields:

| Field | Required type and rule |
| :--- | :--- |
| `schemaVersion` | literal `1` |
| `evidenceType` | literal `npc_reaction_candidate_http_success` |
| `httpStatus` | literal `200`; non-success responses are provider/coordinator failures outside candidate validation |
| `contentTypeHeader` | string `[0..256 Unicode code points]` or literal `null`; the transport adapter copies the received field value without semantic normalization, and `null` means the field was absent |
| `contentEncodingHeader` | string `[0..128 Unicode code points]` or literal `null`; the transport adapter copies the received field value without semantic normalization, and `null` means the field was absent |
| `bodyBytes` | `Uint8Array`; the exact HTTP entity-body prefix after transfer framing and before UTF-8 decoding, length `[0..65,537]` |

`null` is permitted only for the two header-evidence fields so absence can be validated rather than guessed. An empty or whitespace-only string is present but semantically invalid untrusted evidence, not a stage-0 invariant failure. Stage 0 checks the exact root field set, required-field presence, `null | string` type, Unicode-code-point bounds, exact `Uint8Array`, and other engine-owned input invariants only. A missing header-evidence field, wrong type, over-bound string, additional field, or non-`Uint8Array` body throws the closed `NpcReactionCandidateValidationInvariantError`; empty, whitespace-only, or otherwise semantically invalid header content reaches stage 1 and returns `invalid_envelope`.

The object itself remains strict. The producer is the HTTP transport adapter at the successful-response boundary. For a body of at most 65,536 bytes it copies the complete entity body; for a larger body it stops bounded collection after and copies exactly the first 65,537 bytes, which is sufficient proof of overflow. It does not expose a mutable transport buffer, does not parse JSON, and does not call the candidate validator for a non-200 response. Accepted identity-encoded evidence is therefore both after all permitted content decoding and before UTF-8 decoding; a non-identity Content-Encoding is rejected without decoding. The synchronous validator treats the evidence as read-only for the duration of the call, makes no network call, and never returns a reference to `bodyBytes` or either header string.

The exact media rules are:

- `Content-Type` is required. HTTP optional whitespace means only ASCII SP (`U+0020`) or HTAB (`U+0009`). The validator parses the complete field value itself, permits OWS before/after the media type and around the single semicolon and equals sign, and compares the ASCII media type, parameter name, and token value case-insensitively. The media type must be exactly `application/json` and the parameter list must contain exactly one unquoted token `charset=utf-8`. A `null`, empty, whitespace-only, syntactically malformed, omitted-charset, duplicate-charset, contradictory-charset, empty-value, quoted-value (including quoted UTF-8), comma-joined, or additional/unknown-parameter value is `invalid_envelope` at `transport/http_envelope`. Non-ASCII whitespace is not OWS and is invalid. The transport adapter does not normalize or decide acceptance.
- `Content-Encoding` may be `null` or may contain exactly one ASCII case-insensitive token `identity`, with only leading/trailing OWS. An empty, whitespace-only, comma-separated, duplicate, parameterized, quoted, or non-identity value is `invalid_envelope` at `transport/http_envelope`. Candidate validation never decompresses or otherwise decodes a content encoding.
- `bodyBytes.byteLength` is measured from the copied `Uint8Array` before UTF-8 decoding. Length `65,536` is accepted for further validation and length `65,537` is `body_too_large`; later parse/shape failure may still reject a 65,536-byte body. No caller-supplied integer or completion flag is accepted as byte evidence.
- UTF-8 decoding is fatal. A malformed UTF-8 byte sequence is `malformed_json` at `transport/http_envelope`; no replacement character is inserted. An empty body or a decoded string that JSON parsing rejects is also `malformed_json`.
- JSON parsing occurs exactly once inside this validator after size and header checks. The parsed value is then validated as the exact `NpcReactionCandidateHttpResponse`. There is no alternate parsed-object entry point that may emit raw-transport reason codes.

The normative header vectors and their first outcomes are exact:

| Evidence difference | Stage-0 shape result | First public outcome |
| :--- | :--- | :--- |
| `contentTypeHeader: "application/json; charset=utf-8"`, `contentEncodingHeader: null` | valid | continue to body-size validation |
| `contentTypeHeader: ""` or SP/HTAB-only | valid | stage 1 `transport/invalid_envelope/http_envelope` |
| `contentEncodingHeader: ""` or SP/HTAB-only | valid | stage 1 `transport/invalid_envelope/http_envelope` |
| unsupported media type/charset, duplicate or contradictory charset, quoted charset, unknown parameter, non-identity encoding, or comma-joined encoding | valid | stage 1 `transport/invalid_envelope/http_envelope` |
| either header is a number, object, array, or boolean | invalid | stage 0 `invalid_transport_evidence_shape` invariant exception; no rejection result |
| Content-Type exceeds 256 code points or Content-Encoding exceeds 128 code points | invalid | stage 0 `invalid_transport_evidence_shape` invariant exception; no rejection result |
| either required evidence field is missing | invalid | stage 0 `invalid_transport_evidence_shape` invariant exception; no rejection result |

This evidence covers only the provider HTTP **success response**. The engine-owned outbound `NpcReactionCandidateRequest` is validated as a runtime object and fingerprinted before a later transport adapter serializes it. Outbound request bytes, request headers, network failures, non-200 response bodies, retry, timeout, and abort ownership remain later provider/transport work and are not measured or classified by this validator.

Normative valid evidence construction, where the referenced response is the conforming HTTP success object above:

```js
const evidence = Object.freeze({
  schemaVersion: 1,
  evidenceType: "npc_reaction_candidate_http_success",
  httpStatus: 200,
  contentTypeHeader: "application/json; charset=utf-8",
  contentEncodingHeader: null,
  bodyBytes: new TextEncoder().encode(
    JSON.stringify(NORMATIVE_NPC_REACTION_CANDIDATE_HTTP_RESPONSE)
  )
});
```

#### Pure candidate-validation input contract

The validation-only API is the synchronous pure function `validateNpcReactionCandidate(input) -> NpcReactionCandidateValidationResult`. `NpcReactionCandidateValidationInput` is a strict runtime-only object with exactly these required fields, no nullable fields, and `additionalProperties: false`:

| Field | Exact type and ownership |
| :--- | :--- |
| `schemaVersion` | literal `1` |
| `request` | detached, strict `NpcReactionCandidateRequest`; engine-owned expected request |
| `pendingAttempt` | detached, strict `PendingNpcReactionAttempt`; engine-owned expected attempt snapshot |
| `transportEvidence` | strict `NpcReactionCandidateTransportEvidence`; untrusted response evidence copied by the transport adapter |
| `observedCandidate` | strict `NpcReactionCandidateObservedResponse`; coordinator-owned read-only prior-observation snapshot |
| `liveApplicability` | strict `NpcReactionCandidateLiveApplicabilitySnapshot`; engine-owned read-only live snapshot |

The input does not duplicate `knownInformation`, limits, binding echoes, or fingerprints outside their owning values. `request.knownInformation` is the captured authorization projection. `pendingAttempt` and `liveApplicability` are comparison inputs only; validation never transitions them. The validator reconstructs every accepted request, pending, parsed response, candidate, projection, observation, and live-snapshot value into detached plain data before comparison. It never freezes, strips, normalizes, or otherwise mutates caller/provider objects.

Malformed engine-owned input is a programmer/invariant failure, not a provider rejection. Before examining response semantics, the validator synchronously throws `NpcReactionCandidateValidationInvariantError`, a repository-local error with exactly `name: "NpcReactionCandidateValidationInvariantError"`, one closed `code`, and a redacted fixed message. The closed codes are `invalid_validation_input`, `invalid_expected_request`, `invalid_expected_pending_attempt`, `invalid_transport_evidence_shape`, `invalid_observed_candidate`, `invalid_live_applicability_snapshot`, and `validation_input_binding_mismatch`. It contains no raw body, provider value, private fact, free-form path, or nested cause. Invalid header **content**, oversize bytes, invalid UTF-8, malformed JSON, and malformed provider envelopes are well-shaped untrusted evidence and return the rejection union instead of throwing.

At API entry, `request` and `pendingAttempt` must identify one expected session/logical reaction/attempt/request/trigger/turn/phase/version/actor graph. `pendingAttempt.targetNpcId == request.npcId`, `pendingAttempt.operation == request.operation`, and its complete immutable binding (excluding runtime `status` and `startedAt`) equals the request. `observedCandidate` may be `observed` only for that exact expected attempt. These expected-context relations are the only cross-object equalities checked as stage-0 invariants. Failure throws `validation_input_binding_mismatch`.

`liveApplicability` is different: it must be internally self-consistent, but it is an independent current-state projection and is **not** required to equal either expected object at API entry. No live-to-request or live-to-pending equality for session, reaction, attempt, request, correlation, trigger/input, turn/order, phase, version, actor, roster, or status is a stage-0 invariant. A well-formed difference is evidence used by steps 9, 10, and 17 to return `idempotency_conflict`, `stale_request`, or a more specific closed applicability/authorization rejection. Treating such a difference as an invariant exception would make stale validation unreachable and is prohibited. A well-formed provider echo that differs from the expected request/pending graph returns `binding_mismatch` before those live comparisons.

Normative validation-input construction, using the strict values defined in this section:

```js
const validationInput = Object.freeze({
  schemaVersion: 1,
  request: EXPECTED_NPC_REACTION_CANDIDATE_REQUEST,
  pendingAttempt: EXPECTED_PENDING_NPC_REACTION_ATTEMPT,
  transportEvidence: evidence,
  observedCandidate: Object.freeze({
    schemaVersion: 1,
    observationStatus: "none"
  }),
  liveApplicability: EXPECTED_NPC_REACTION_LIVE_APPLICABILITY_SNAPSHOT
});
```

The uppercase names identify the normative strict objects defined by their respective contracts; this JavaScript example demonstrates runtime composition and is not a JSON schema.

#### Observed-candidate union and fingerprint ownership

`NpcReactionCandidateObservedResponse` is the strict union `NpcReactionCandidateUnobserved | NpcReactionCandidateObserved`, discriminated by `observationStatus`; every member has `schemaVersion: 1` and `additionalProperties: false`:

- `NpcReactionCandidateUnobserved` has exactly `schemaVersion: 1` and `observationStatus: "none"`.
- `NpcReactionCandidateObserved` has exactly `schemaVersion: 1`, `observationStatus: "observed"`, `reactionAttemptId: ID`, and `candidateFingerprint: Sha256Fingerprint`.

The provider never supplies an observation or candidate fingerprint. After strict structural reconstruction of the current candidate, the engine computes `candidateFingerprint = sha256CanonicalJson(detachedCandidate)`. The session-local reaction coordinator owns the prior observation and passes a detached read-only snapshot to the pure validator. This contract defines no registry, insertion, transition, retry, tombstone, or persistence API; producing and retaining the snapshot belongs to the later coordinator implementation.

The union is evaluated only after transport, envelope, binding, request-fingerprint, hard-stale/status routing, and candidate-structure checks have succeeded. For an ordinary active `candidate_received` route, `none` continues to authorization. For a terminal-repeat route, `none` produces `duplicate_response` because terminal ownership alone suppresses the late delivery without storing or asserting equality. For `observed`, exact attempt equality is an input invariant; session ownership comes from the containing validation input and is not redundantly stored in this minimum union. Engine-computed fingerprints then classify the current candidate: equal is `duplicate_response`; unequal is `attempt_response_conflict`. Both are validation rejections with no state transition. A response cannot select the duplicate classification by echoing a fingerprint.

Normative members:

```json
{ "schemaVersion": 1, "observationStatus": "none" }
```

```json
{
  "schemaVersion": 1,
  "observationStatus": "observed",
  "reactionAttemptId": "reaction-attempt-1",
  "candidateFingerprint": "64a82470787c3492e03bca709c779088957fa0b451481c3386aa5c494af7b481"
}
```

#### Live applicability snapshot contract

`NpcReactionCandidateLiveApplicabilitySnapshot` is the strict union `NpcReactionCandidateLiveApplicabilityAvailable | NpcReactionCandidateLiveApplicabilityUnavailable`, discriminated by `snapshotStatus`. It is detached, recursively frozen, and built synchronously by `WerewolfGame` from the current session immediately before candidate validation. Building it is a pure read that allocates no authoritative ID, mutates no state, and increments no version. It is valid for this validation call only and is never provider-facing, authoritative history, a registry entry, or permission to commit. Every member has `schemaVersion: 1`, no optional/null fields, and `additionalProperties: false` at every level.

`NpcReactionCandidateLiveApplicabilityAvailable` has `snapshotStatus: "available"`, `engineLifecycleStatus: "active"`, and exactly the remaining fields below:

| Field | Exact type and rule |
| :--- | :--- |
| `gameSessionId` | `ID`; current session |
| `turnId` | `ID`; current originating turn |
| `turnOrder` | safe integer `>= 0` |
| `phase` | current authoritative `GamePhase`; stage 10 compares it with expected precondition phase or the exact same-reaction committed resulting phase |
| `stateVersion` | current authoritative safe integer `>= 0` at snapshot generation; stage 10 compares it with request/pending precondition version or the exact same-reaction committed resulting version, never as a type or stage-0 cross-input invariant |
| `reactionPlanId` | `ID`; current logical reaction |
| `logicalReactionStatus` | `ReactionLogicalStatus` |
| `reactionAttemptId` | `ID`; current retained lookup result for the expected attempt, whether active, winning, losing, or terminal |
| `reactionAttemptStatus` | current `ReactionAttemptStatus` of that retained attempt |
| `requestId` | `ID` |
| `requestFingerprint` | `Sha256Fingerprint`; engine recomputation target |
| `correlationId` | `ID` |
| `causationId` | `ID`; triggering player commit request |
| `originatingInputRecordId` | `ID` |
| `npcId` | `ID`; expected actor |
| `reactionCommit` | exact `NpcReactionCandidateLiveCommitSnapshot`; proves whether current phase/version are still the precondition or the result of this exact logical reaction |
| `triggeringPlayerCommit` | exact `NpcReactionTriggeringPlayerCommitSnapshot` |
| `triggeringInput` | exact `NpcReactionTriggeringInputSnapshot` |
| `participants` | dense `NpcReactionLiveParticipantSnapshot[2..16]` |

`NpcReactionTriggeringPlayerCommitSnapshot` requires exactly `requestId: ID`, `requestFingerprint: Sha256Fingerprint`, `correlationId: ID`, `inputRecordId: ID`, `turnId: ID`, and `resultingStateVersion: safe integer >= 1`. `NpcReactionTriggeringInputSnapshot` requires exactly `inputRecordId: ID`, `requestId: ID`, `correlationId: ID`, `turnId: ID`, `capturedStateVersion: safe integer >= 0`, and `actorId: "player"`. `NpcReactionLiveParticipantSnapshot` requires exactly `participantId: ID`, `participantClass: "player" | "npc"`, and `publicStatus: "alive" | "dead"`.

`NpcReactionCandidateLiveCommitSnapshot` is the strict union below, discriminated by `commitStatus` and with `additionalProperties: false`:

- `NpcReactionCandidateLiveUncommitted` has exactly `commitStatus: "uncommitted"`. It is required for logical `active`, `rejected`, `superseded`, `cancelled`, and `exhausted`.
- `NpcReactionCandidateLiveCommitted` has exactly `commitStatus: "committed"`, `reactionPlanId: ID`, `requestId: ID`, `requestFingerprint: Sha256Fingerprint`, `successfulAttemptId: ID`, `turnId: ID`, `preconditionPhase: GamePhase`, `resultingPhase: GamePhase`, `preconditionStateVersion: safe integer >= 0`, and `resultingStateVersion: safe integer >= 1`; the versions differ by exactly one. It is required only for logical `committed` and is reconstructed from the exact authoritative `NpcReactionPlan`, `NpcReactionCommitResult`, and engine-owned committed-delta metadata. It is comparison evidence only and is not another commit record.

Within an available snapshot, the commit member must match the snapshot's own logical reaction, request, fingerprint, and turn. For `uncommitted`, current `phase` and `stateVersion` are compared at stage 10 with the request/pending precondition. For `committed`, the commit member's precondition phase/version must equal the request/pending precondition, while current `phase` and `stateVersion` must equal its resulting phase/version. This exact same-logical-reaction transition is the only permitted terminal baseline and allows committed late responses to reach stage 14. Any missing/corrupt committed graph, a different commit identity, or a later unrelated phase/version transition is stale (or authoritative committed-graph corruption outside this pure validator), never silently treated as a duplicate.

`NpcReactionCandidateLiveApplicabilityUnavailable` represents a current lookup that cannot produce the complete available member without fabrication. It has exactly `schemaVersion: 1`, `snapshotStatus: "unavailable"`, `currentGameSessionId: ID`, `engineLifecycleStatus: "active" | "destroyed"`, and `missingDimension: "session_replaced" | "turn" | "logical_reaction" | "reaction_attempt" | "trigger_graph" | "roster"`. It contains no expected/request IDs, private facts, or partial roster. Session replacement uses the new current session ID and `missingDimension: "session_replaced"`; destruction uses `engineLifecycleStatus: "destroyed"`. A well-formed unavailable member is valid input and returns `stale_request` at step 10. It is never an invariant exception and prevents a caller from fabricating old IDs after reset, terminal removal, or destruction.

Participant entries are ordered by `participantId`, IDs are unique, exactly one entry has class `player`, and `npcId` resolves exactly once to an `npc` entry; whether that entry remains alive is evaluated as applicability. The exact participant ID/status set must equal the current authoritative roster projection for the snapshot's own `gameSessionId`; replacement/reset produces a current snapshot whose session or roster comparison invalidates the expected request. The snapshot's trigger subgraphs must internally resolve the same current player result and input: commit/request/turn/input identities match the snapshot's own `causationId`, `originatingInputRecordId`, and `turnId`, and input identities match that player commit. The player result's `resultingStateVersion` is the reaction precondition `N+1`; it equals root `stateVersion` only while uncommitted and equals `reactionCommit.preconditionStateVersion` after the exact reaction commit advances root state to `N+2`. Equality with the expected request and `request.knownInformation.public.triggeringInput` is a step-10 stale/identity comparison, not an input-shape invariant.

Initial applicability first checks the hard live dimensions: available snapshot; session; reaction/request/correlation; trigger/input graph; turn/order; status-aware phase/version baseline; actor identity/membership/alive status; roster continuity; and exact expected/live attempt identity. Any mismatch is `stale_request` before candidate parsing or fingerprint comparison. An uncommitted status uses request/pending precondition phase/version; a committed status uses only the exact same-reaction commit member described above. `logicalReactionStatus: "superseded"` is always stale. A terminal status by itself is **not** a hard stale dimension.

After hard stale checks pass, stage 10 requires `pendingAttempt.status == liveApplicability.reactionAttemptStatus` and routes the exact status combination using the tables below. A status mismatch is a well-formed race and returns `stale_request`, not an invariant exception. An internally impossible logical/attempt combination in an `available` snapshot is `invalid_live_applicability_snapshot` at stage 0; an `unavailable` snapshot remains the normal stale representation when the current graph has been removed. Candidate-sensitive final applicability additionally resolves every proposal target exactly once in `participants` and reapplies the kind-specific current-alive requirements. The validator never refreshes or mutates the snapshot and never treats it as a later commit CAS.

##### Pending-attempt status applicability

Every `ReactionAttemptStatus` is schema-valid in `PendingNpcReactionAttempt`; status applicability is closed as follows:

| `pendingAttempt.status` (equal live status) | Compatible logical status | Stage-10 route |
| :--- | :--- | :--- |
| `attempting` | `active` | `stale_request`; a response has not yet been captured as `candidate_received`, so validation does not transition it |
| `candidate_received` | `active` | ordinary validation may continue; an existing observation instead reaches stage 14 |
| `validated` | `active` | retained response reaches stage 14; `observedCandidate: "none"` is `invalid_observed_candidate` because validated status requires the prior engine-owned fingerprint |
| `accepted` | `committed` | terminal repeat reaches stage 14; `observedCandidate: "none"` is `invalid_observed_candidate` because a winning accepted attempt necessarily has an engine-owned fingerprint; every other logical status is an internally invalid available snapshot |
| `failed` | `active`, `rejected`, `exhausted`, or `committed` for a losing attempt | terminal repeat reaches stage 14 |
| `timed_out` | `active`, `exhausted`, or `committed` for a losing attempt | terminal repeat reaches stage 14 |
| `rejected` | `active`, `rejected`, or `committed` for a losing attempt | terminal repeat reaches stage 14 |
| `aborted` | `active`, `superseded`, `cancelled`, `rejected`, or `committed` for a losing attempt | `superseded` is stale; every other listed status is a terminal repeat that reaches stage 14 |

Logical-status constraints complete the matrix:

| `logicalReactionStatus` | Compatible attempt state and classification after hard stale checks |
| :--- | :--- |
| `planned` | no attempt may exist; an available snapshot containing one is `invalid_live_applicability_snapshot`, while an unavailable current attempt is `stale_request` |
| `active` | route by the complete pending-status table above |
| `committed` | `accepted` winning attempt or terminal losing attempt; reach stage 14 and never alter the stored commit |
| `rejected` | terminal `failed`, `rejected`, or `aborted`; reach stage 14 and retain rejection |
| `superseded` | always `stale_request` before stage 14, including an `aborted` attempt |
| `cancelled` | terminal `aborted`; reach stage 14 when hard live dimensions still match (reset/destroy normally fails the earlier unavailable/session check) |
| `exhausted` | terminal `failed` or `timed_out`; reach stage 14 and retain exhaustion |

For every terminal-repeat route, candidate strict structure/reconstruction and engine fingerprinting still run. If `observedCandidate` contains a fingerprint, equality is `duplicate_response` and inequality is `attempt_response_conflict`. If no prior candidate fingerprint exists because the attempt ended before observing a valid candidate, any structurally valid late delivery for that already terminal attempt is `duplicate_response`; no fingerprint is stored and no state changes. Thus status alone suppresses a terminal late delivery but never fabricates an equality claim. On an already terminal logical/attempt state, `attempt_response_conflict` is diagnostic only and retains that terminal state.

Normative live snapshot example:

```json
{
  "schemaVersion": 1,
  "snapshotStatus": "available",
  "engineLifecycleStatus": "active",
  "gameSessionId": "game-session-1",
  "turnId": "turn-1",
  "turnOrder": 1,
  "phase": "player_question",
  "stateVersion": 2,
  "reactionPlanId": "reaction-plan-1",
  "logicalReactionStatus": "active",
  "reactionAttemptId": "reaction-attempt-1",
  "reactionAttemptStatus": "candidate_received",
  "requestId": "reaction-request-1",
  "requestFingerprint": "ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6",
  "correlationId": "correlation-1",
  "causationId": "player-request-1",
  "originatingInputRecordId": "input-1",
  "npcId": "npc-aoi",
  "reactionCommit": { "commitStatus": "uncommitted" },
  "triggeringPlayerCommit": {
    "requestId": "player-request-1",
    "requestFingerprint": "f474c5f4b65312fb30d0edb4a35b12e4406d3e2e112c5470af6ee8c2f508bc22",
    "correlationId": "player-correlation-1",
    "inputRecordId": "input-1",
    "turnId": "turn-1",
    "resultingStateVersion": 2
  },
  "triggeringInput": {
    "inputRecordId": "input-1",
    "requestId": "player-request-1",
    "correlationId": "player-correlation-1",
    "turnId": "turn-1",
    "capturedStateVersion": 1,
    "actorId": "player"
  },
  "participants": [
    { "participantId": "npc-aoi", "participantClass": "npc", "publicStatus": "alive" },
    { "participantId": "npc-beni", "participantClass": "npc", "publicStatus": "alive" },
    { "participantId": "player", "participantClass": "player", "publicStatus": "alive" }
  ]
}
```

Normative unavailable member after session replacement:

```json
{
  "schemaVersion": 1,
  "snapshotStatus": "unavailable",
  "currentGameSessionId": "game-session-2",
  "engineLifecycleStatus": "active",
  "missingDimension": "session_replaced"
}
```

#### Exact candidate-validation evaluation order

The pure validator executes the following total order. The first failing step returns or throws as stated; no later step executes, and diagnostics cannot change precedence:

0. Validate and strictly reconstruct each engine-owned input member; cross-check only the expected request/pending/observation relations and the live snapshot's own internal status/commit graph. No expected-to-live equality is checked here. Malformed expected context or internally impossible live data throws an invariant error.
1. Validate transport metadata: HTTP status evidence, `Content-Type`, charset, and `Content-Encoding`.
2. Measure `bodyBytes.byteLength`; reject evidence proving more than 65,536 bytes.
3. Decode fatal UTF-8.
4. Parse JSON exactly once.
5. Validate the strict outer field sets of `NpcReactionCandidateHttpResponse` and its nested provider result.
6. Validate their literal schema versions and operations plus top-level/nested envelope echo agreement.
7. Reconstruct the expected request fingerprint input and recompute `requestFingerprint`. A mismatch within the engine-owned request is `fingerprint_mismatch`; no provider echo is trusted during recomputation.
8. Compare every provider binding echo, including its request-fingerprint echo, with the validated expected request and pending attempt.
9. Apply logical/request identity-conflict checks, including plan/request aliasing represented in the supplied expected context; `idempotency_conflict` precedes stale and duplicate classification.
10. Apply hard live applicability for session, trigger/input graph, turn/order, phase, version, actor/roster, and exact attempt identity; `superseded` is stale. Then compare pending/live attempt status and route the closed logical/attempt combination to ordinary validation, terminal-repeat comparison, or `stale_request`. Terminal status alone is not stale.
11. Strictly validate the candidate/proposal union, bounds, nesting, nullability, and unknown fields.
12. Reconstruct a detached normalized candidate.
13. Compute the engine-owned `candidateFingerprint` from that reconstruction.
14. Apply the stage-10 route. For ordinary validation, `none` continues and an observation is compared. For terminal repeat, no observation is `duplicate_response`; with an observation, equal fingerprint is `duplicate_response` and different fingerprint is `attempt_response_conflict`.
15. Strictly reconstruct the captured `knownInformation`, compute engine-owned `projectionFingerprint`, verify request/live graph relations, and apply per-proposal authorization in proposal order: candidate-kind allowlist, disclosure policy, actor/target/reference eligibility, and exact actor-owned result-fact checks.
16. Apply whole-candidate duplicate and contradiction rules.
17. Apply candidate-sensitive final applicability against the same immutable live snapshot, including current target eligibility and every step-10 dimension. This is a final logical validation boundary, not a second state read and not a commit CAS.
18. Construct the detached recursively frozen `ValidatedNpcReactionCandidate`, then return the exact validated union member.

The candidate fingerprint is not available before step 13, and the projection fingerprint is not available before step 15. Duplicate classification therefore cannot precede strict candidate structure/reconstruction. Semantic authorization cannot precede observation conflict classification. No raw/provider object is frozen or returned, and no step allocates an authoritative ID, calls a provider, changes an attempt status, writes a registry, publishes, displays, or increments a version.

The exhaustive stage contract is:

| Step | Accepted input / validation | Success output | Primary failure | Location | Later stages | Mutation / version |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 0 | unknown root; strict reconstruction, expected request/pending/observation cross-check, and internal live-snapshot consistency only | detached expected context | closed invariant exception, including impossible available status combination or `validated`/`accepted` status without observation | none/public diagnostic forbidden | no on failure | `0 / 0` |
| 1 | exact transport evidence; validate status/header grammar | accepted identity JSON metadata | `invalid_envelope` | `http_envelope` | no on failure | `0 / 0` |
| 2 | accepted metadata; measure actual `Uint8Array` | complete body of at most 65,536 bytes | `body_too_large` | `http_envelope` | no on failure | `0 / 0` |
| 3 | bounded bytes; fatal UTF-8 decode | decoded Unicode text | `malformed_json` | `http_envelope` | no on failure | `0 / 0` |
| 4 | decoded text; JSON parse | one parsed value | `malformed_json` | `http_envelope` | no on failure | `0 / 0` |
| 5 | parsed value; strict HTTP/provider outer field sets | strict outer envelope shape | `invalid_envelope` | `http_envelope` or `provider_result` | no on failure | `0 / 0` |
| 6 | strict outer shape; literal versions/operations and envelope echoes | supported operation envelope | `unsupported_schema_version` or `invalid_envelope` | `http_envelope` or `provider_result` | no on failure | `0 / 0` |
| 7 | validated expected request; engine request-fingerprint recomputation | trustworthy expected request fingerprint | `fingerprint_mismatch` | `fingerprint` | no on failure | `0 / 0` |
| 8 | strict envelope and expected request/pending; all echo comparisons | correlated provider candidate | `binding_mismatch` | `binding` | no on failure | `0 / 0` |
| 9 | correlated identities; logical/request alias checks | conflict-free logical identity | `idempotency_conflict` | `binding` | no on failure | `0 / 0` |
| 10 | conflict-free identity; hard live dimensions, superseded precedence, pending/live status equality, and closed lifecycle routing | ordinary-validation or terminal-repeat route | `stale_request`; impossible internal status combination was already stage 0 | `live_state` | no on stale; routed terminal repeats continue only through structure/fingerprint/stage 14 | `0 / 0` |
| 11 | untrusted candidate; strict proposal shape/bounds | structurally valid candidate source | `invalid_candidate_schema` or `unsupported_in_phase6` | `candidate` or `proposal` | no on failure | `0 / 0` |
| 12 | valid source; detached candidate reconstruction | normalized candidate | structural failure from step 11 only | `candidate` | yes | `0 / 0` |
| 13 | normalized candidate; canonical hash | engine-owned candidate fingerprint | invariant exception only if canonical engine data is invalid | none/public diagnostic forbidden | yes | `0 / 0` |
| 14 | normalized candidate, stage-10 route, and observation union | unobserved ordinary candidate | `duplicate_response` or `attempt_response_conflict`; unobserved terminal repeat is duplicate suppression | `provider_result` | no on duplicate/conflict | `0 / 0` |
| 15 | unobserved candidate and captured projection; strict projection/hash/graph plus ordered authorization | normalized projection, projection fingerprint, individually authorized proposals | applicable closed authorization code | corresponding closed location | no on failure | `0 / 0` |
| 16 | authorized proposals; whole-candidate duplicate/contradiction rules | coherent whole candidate | `duplicate_proposal` or `contradictory_proposals` | `proposal` | no on failure | `0 / 0` |
| 17 | coherent candidate; deterministic candidate-sensitive recheck against the same immutable snapshot | finally applicable candidate | a failed predicate retains its specific owner: `stale_request`, `unknown_reference`, `target_ineligible`, `permission_denied`, or `result_fact_mismatch`; no generic final-live code exists | `live_state`, `reference`, `target`, `policy`, or `known_information`, matching the failed predicate | no on failure | `0 / 0` |
| 18 | all prior outputs; detached value assembly and recursive freeze | exact validated result union member | invariant exception only if engine assembly violates its contract | none/public diagnostic forbidden | complete | `0 / 0` |

#### Transport reason-code responsibility boundary

Reason ownership is exact and prevents a parsed-object harness from claiming evidence it cannot prove:

| Evidence/layer | Codes this validator may issue | Rule |
| :--- | :--- | :--- |
| raw success-response transport evidence | `body_too_large`, `malformed_json`, `invalid_envelope` | size, fatal UTF-8/JSON, media type/charset/encoding respectively |
| parsed HTTP/provider envelope | `invalid_envelope`, `unsupported_schema_version` | strict envelope/operation/echo shape and literal schema versions |
| expected/provider binding | `binding_mismatch`, `idempotency_conflict`, `fingerprint_mismatch` | candidate fingerprint never produces `fingerprint_mismatch` |
| observed-candidate / terminal-status comparison | `duplicate_response`, `attempt_response_conflict` | engine-computed candidate fingerprints when observed; an unobserved retained terminal attempt may only suppress as duplicate |
| live snapshot and status route | `stale_request` | hard live mismatch, unavailable graph, superseded state, pending/live status race, or not-yet-captured `attempting`; terminal status alone is not stale |
| candidate structure/semantics/final applicability | the active closed structure, authorization, and applicability codes below | no transport code, invariant identifier, or reserved identifier is copied into these layers |

There is no exported parsed-object-only candidate validator. Internal helpers that receive an already parsed value may emit only envelope, binding, structure, fingerprint, duplicate, authorization, or applicability outcomes, never `body_too_large` or `malformed_json`. A future HTTP endpoint may translate invalid request media type to the existing HTTP `ErrorEnvelope` code `unsupported_media_type`, but this provider-success validator returns runtime `invalid_envelope`; neither code is mechanically copied into the other contract. Network errors, non-200 statuses, timeouts, aborts, and unavailable providers are coordinator/provider outcomes and cannot be synthesized as candidate-validation rejections.

Normative classification vectors:

| Input condition | First outcome |
| :--- | :--- |
| 65,537 response body bytes | `transport/body_too_large/http_envelope` |
| fatal UTF-8 failure or syntactically invalid JSON | `transport/malformed_json/http_envelope` |
| missing charset or non-identity content encoding | `transport/invalid_envelope/http_envelope` |
| valid envelope with mismatched provider request echo | `binding/binding_mismatch/binding` |
| recomputed request fingerprint differs | `fingerprint/fingerprint_mismatch/fingerprint` |
| same attempt and same engine-computed observed candidate fingerprint | `duplicate/duplicate_response/provider_result` |
| same attempt and different engine-computed observed candidate fingerprint | `duplicate/attempt_response_conflict/provider_result` |
| terminal `timed_out` attempt, stable hard live dimensions, no observed fingerprint | structure/fingerprint proceeds, then `duplicate/duplicate_response/provider_result` |
| terminal attempt, stable hard live dimensions, same observed fingerprint | `duplicate/duplicate_response/provider_result` |
| terminal attempt, stable hard live dimensions, different observed fingerprint | `duplicate/attempt_response_conflict/provider_result`; terminal status is retained |
| logical `committed`, `exhausted`, `rejected`, or explicit `cancelled`, stable hard live dimensions | compatible terminal attempt reaches the preceding terminal-repeat rules |
| request precondition `N+1`, logical `committed`, current `N+2`, and exact same-reaction committed member proving `N+1 -> N+2` | the version is the compatible terminal baseline; stage 14 classifies duplicate/conflict |
| logical `committed` but current phase/version is later than or differs from its exact committed member | `applicability/stale_request/live_state`; stage 14 does not execute |
| logical `superseded`, even with matching candidate fingerprint | `applicability/stale_request/live_state`; stage 14 does not execute |
| reset/session replacement, changed turn/phase/version/actor/trigger, or different current attempt | `applicability/stale_request/live_state`; status/fingerprint comparison does not execute |
| request/pending `preconditionStateVersion: 2`, live current `stateVersion: 3` | valid input shape, then `applicability/stale_request/live_state` at stage 10 |
| pending status `candidate_received`, live same-attempt status `timed_out` | well-formed status race, then `applicability/stale_request/live_state` at stage 10 |
| pending/live status `candidate_received`, logical `active`, no observation | ordinary authorization continues |
| structurally valid unobserved candidate denied by disclosure policy | `authorization/permission_denied/policy` |

The byte-boundary and malformed-input vectors are constructed without embedding a large raw body in this document:

```js
const maxAcceptedBody = new Uint8Array(65_536);

const tooLargeEvidence = Object.freeze({
  ...evidence,
  bodyBytes: new Uint8Array(65_537)
});

const malformedUtf8Evidence = Object.freeze({
  ...evidence,
  bodyBytes: Uint8Array.of(0xc3, 0x28)
});

const malformedJsonEvidence = Object.freeze({
  ...evidence,
  bodyBytes: new TextEncoder().encode("{")
});
```

`maxAcceptedBody.byteLength === 65_536` and proceeds past the byte-limit step, where only its later content can reject it. `tooLargeEvidence.bodyBytes.byteLength === 65_537` and fails before decoding. `malformedUtf8Evidence` is bounded but fails fatal UTF-8 decoding before `JSON.parse`; `malformedJsonEvidence` decodes successfully and then fails `JSON.parse`. Both latter failures use `malformed_json`.

#### Candidate fingerprint

After the complete response and proposal shapes pass strict structural validation, the engine reconstructs the detached normalized `NpcReactionCandidate` and computes:

```text
candidateFingerprint = lowercaseHex(SHA-256(UTF-8(canonicalJson(normalizedCandidate))))
```

This is exactly repository `sha256CanonicalJson(normalizedCandidate)`, producing 64 lowercase hexadecimal characters. It does not use the variadic `sha256Fingerprint()` wrapper, because the fingerprint input is the candidate object itself rather than an array of parts. Canonical JSON sorts object keys lexicographically, preserves array/proposal order, rejects sparse arrays, non-finite numbers, cycles, symbol keys, and non-plain objects, and JSON-encodes strings exactly. The engine does not sort proposals and does not trim, case-fold, or Unicode-normalize enum, ID, or string values.

The complete fingerprint input for the response example is exactly:

```json
{
  "schemaVersion": 1,
  "proposals": [
    { "proposalType": "role_claim", "claimedRole": "seer" },
    { "proposalType": "result_claim", "targetId": "npc-beni", "result": "werewolf" }
  ]
}
```

Its canonical JSON is `{"proposals":[{"claimedRole":"seer","proposalType":"role_claim"},{"proposalType":"result_claim","result":"werewolf","targetId":"npc-beni"}],"schemaVersion":1}` and its `candidateFingerprint` is `64a82470787c3492e03bca709c779088957fa0b451481c3386aa5c494af7b481`.

Excluded from the input are the request and HTTP envelopes; every binding/echo field; `reactionAttemptId`; `serverCorrelationId`; provider/transport diagnostics; provider name, model, latency, attempt count, usage, notes, headers, and status metadata; and any later engine-created descriptor, claim, event, segment, publication, or commit ID. Unknown fields are not excluded and hashed: they reject the response before fingerprint calculation. Reordering proposals changes the fingerprint. Changing only a response echo does not change a candidate fingerprint, but the separate identity/correlation layer rejects the response before candidate use.

#### Validated candidate runtime contract

`ValidatedNpcReactionCandidate` is the one exact success value produced by candidate validation. It is a strict non-null object with exactly `schemaVersion`, `binding`, `candidate`, `candidateFingerprint`, and `validationContext`; it has no optional or nullable fields and sets `additionalProperties: false` at every level. The binding is nested and is never also expanded at the top level.

`ValidatedNpcReactionCandidateBinding` has exactly these required fields:

| Field | Required type and rule |
| :--- | :--- |
| `gameSessionId` | `ID`; copied from the active engine-owned preparation binding |
| `reactionPlanId` | `ID`; stable logical reaction ID |
| `reactionAttemptId` | `ID`; exact engine-issued attempt that supplied the candidate |
| `requestId` | `ID`; stable logical operation ID |
| `requestFingerprint` | `Sha256Fingerprint`; recomputed by the engine and equal to the active request fingerprint |
| `correlationId` | `ID`; stable reaction trace ID |
| `causationId` | `ID`; triggering player commit request ID |
| `originatingInputRecordId` | `ID`; exact committed player input record |
| `turnId` | `ID`; originating logical command |
| `turnOrder` | safe integer `>= 0` |
| `preconditionPhase` | literal `player_question` in initial Phase 6 |
| `preconditionStateVersion` | safe integer `>= 0`; the player commit's `N+1` |
| `npcId` | `ID`; engine-selected actor |

`ValidatedNpcReactionCandidateValidationContext` is also strict and has exactly:

| Field | Required type and rule |
| :--- | :--- |
| `projectionFingerprint` | `Sha256Fingerprint`; engine-computed `sha256CanonicalJson()` of the detached strict `NpcKnownInformationProjection` used for validation |
| `roleDisclosurePolicy` | `NpcRoleDisclosurePolicy`; copied from that captured projection after strict validation |
| `permissionResult` | literal `allowed`; engine semantic-authorization result at validation time |
| `finalApplicabilityResult` | literal `applicable`; engine live applicability result at validation time |

The root `schemaVersion` is literal `1`. `candidate` is one detached strict `NpcReactionCandidate`, and `candidateFingerprint` is the engine-computed `Sha256Fingerprint` defined above. Arrays retain the exact bounds, uniqueness, and order of their referenced candidate/projection schemas. Every `ID` is a nonempty ASCII identifier of 1-64 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`; the runtime value introduces no other free-form string or array.

The engine constructs every binding and validation-context field from its active request, pending attempt, captured projection, and live state. Provider echoes are comparison input only and are never copied into the runtime value. Candidate proposal semantics originate with the provider, but `candidate` is a newly reconstructed plain object containing only allowed fields. `candidate`, its fingerprint, the validation outcome, `permissionResult`, and `finalApplicabilityResult` are therefore engine-owned results. No object or nested array is shared with the provider result, request decoder, or caller input. The complete value is recursively frozen before return.

A later engine-owned authoritative preparation stage may trust only that the returned binding, normalized candidate, fingerprints, and validation-time results were produced together by this validator. They are provenance for one validation instant, not authority to commit. Preparation must re-read and compare the active session, logical reaction, attempt, request, correlation, trigger/input graph, turn/order, phase, version, actor, targets, projection/policy, and final applicability before deriving any authoritative object. In particular, `permissionResult: "allowed"` and `finalApplicabilityResult: "applicable"` cannot bypass a later live check.

#### Validation result union

`NpcReactionCandidateValidationResult` is the closed union `NpcReactionCandidateValidatedResult | NpcReactionCandidateRejectedResult`, discriminated by `status`. Both members are strict non-null objects with `schemaVersion: 1`, no optional fields, and `additionalProperties: false`.

- `NpcReactionCandidateValidatedResult` has exactly `schemaVersion: 1`, `status: "validated"`, and `value: ValidatedNpcReactionCandidate`.
- `NpcReactionCandidateRejectedResult` has exactly `schemaVersion: 1`, `status: "rejected"`, `binding: ValidatedNpcReactionCandidateBinding`, and `rejection: NpcReactionCandidateRejection`. The binding always comes from the engine's expected active preparation/attempt, never from a malformed or mismatched provider echo, so none of its fields is nullable even when JSON or envelopes are rejected.

`NpcReactionCandidateRejection` has exactly `stage`, `reasonCode`, `retryable`, and `diagnostics`, with `additionalProperties: false`:

- `stage` is the closed enum `transport | binding | structure | fingerprint | authorization | applicability | duplicate`.
- `reasonCode` is one closed `NpcReactionCandidateRejectionCode` from the table below.
- `retryable` is literal `false`. Candidate validation never decides that another provider attempt is safe. Only the later reaction coordinator may retry separately classified transient network/unavailable failures or timeouts under section 25A policy; those coordinator failures are not converted to a validation rejection.
- `diagnostics` is a dense `NpcReactionCandidateValidationDiagnostic[0..8]`. Each diagnostic has exactly `code: NpcReactionCandidateRejectionCode` and `location: NpcReactionCandidateValidationLocation`, with no optional/null fields and `additionalProperties: false`. `location` is the closed enum `http_envelope | provider_result | binding | candidate | proposal | reference | actor | target | policy | known_information | fingerprint | live_state`. No diagnostic message, path string, provider value, raw body, raw candidate, private fact, policy text, display text, or hidden-information value is permitted.

The **active initial Phase 6 v1** rejection codes, stages, and normal diagnostic locations are exact:

| `reasonCode` | `stage` | Normal `location` | Covered classification |
| :--- | :--- | :--- | :--- |
| `body_too_large` | `transport` | `http_envelope` | raw identity entity-body evidence exceeds 65,536 bytes before UTF-8 decoding |
| `malformed_json` | `transport` | `http_envelope` | body is not fatal UTF-8 or is not valid JSON |
| `invalid_envelope` | `transport` | `http_envelope` or `provider_result` | media/charset/encoding, operation, required envelope, or strict provider-result shape is invalid |
| `unsupported_schema_version` | `transport` | `http_envelope` or `provider_result` | any required schema version is not literal `1` |
| `binding_mismatch` | `binding` | `binding` | an echo differs from the active request/pending binding |
| `stale_request` | `applicability` | `live_state` | a hard current session/turn/phase/version/actor/target/attempt dimension, status race, unavailable graph, or superseded logical reaction is no longer applicable |
| `duplicate_response` | `duplicate` | `provider_result` | equal observed candidate, or a structurally valid late delivery for a retained terminal attempt that has no prior candidate fingerprint |
| `attempt_response_conflict` | `duplicate` | `provider_result` | one attempt ID is reused with a different candidate fingerprint |
| `idempotency_conflict` | `duplicate` | `binding` | logical/request identity is reused with a different fingerprint or graph |
| `invalid_candidate_schema` | `structure` | `candidate` or `proposal` | candidate/proposal field, type, enum, nullability, bound, nesting, or strictness violation |
| `unsupported_in_phase6` | `structure` | `proposal` | a reserved but unsupported proposal discriminator is supplied |
| `duplicate_proposal` | `authorization` | `proposal` | exact duplicate proposal in one candidate |
| `contradictory_proposals` | `authorization` | `proposal` | the candidate violates a whole-candidate contradiction rule |
| `unknown_reference` | `authorization` | `reference` | a referenced identity is absent, duplicated, or outside the captured reference graph |
| `target_ineligible` | `authorization` | `target` | a uniquely resolved target fails the common target-class/self/player rule or the proposal kind's current-alive rule; result-fact allowlists are excluded |
| `permission_denied` | `authorization` | `policy` | a proposal kind or disclosure is not permitted by captured policy |
| `result_fact_mismatch` | `authorization` | `known_information` | result target/value lacks the exact actor-owned projected fact |
| `fingerprint_mismatch` | `fingerprint` | `fingerprint` | request fingerprint does not equal engine recomputation; candidate fingerprints use the duplicate/conflict codes |

The following identifiers are reserved for possible future schemas and are **not** members of `NpcReactionCandidateRejectionCode`, diagnostic codes, active exports, accepted provider values, or normative rejection results in initial Phase 6 v1:

| Reserved identifier | Why it is unreachable in initial Phase 6 | Required current classification |
| :--- | :--- | :--- |
| `actor_ineligible` | the provider cannot select or return an actor; `npcId` is fixed by the engine-owned request/pending/live graph | malformed or self-contradictory engine actor data is a stage-0 invariant; current session/roster/alive mismatch is stage-10 `stale_request`; role/disclosure denial is `permission_denied`; a provider-added actor field is `invalid_candidate_schema` |
| `known_information_boundary_violation` | the strict four-member proposal union has no generic private-information or evidence field | graph/reference failures are `unknown_reference`; common target failure is `target_ineligible`; exact fact failure is `result_fact_mismatch`; kind/role/disclosure failure is `permission_denied`; an added hidden/private/provider field is `invalid_candidate_schema` |
| `final_live_validation_failure` | stage 17 repeats named predicates against the same immutable live snapshot and has no unnamed predicate | retain the owning specific code (`stale_request`, `unknown_reference`, `target_ineligible`, `permission_denied`, or `result_fact_mismatch`); if every named predicate passes, continue to stage 18 |
| `role_disclosure_policy_unknown` | `roleDisclosurePolicy` is an engine-owned closed projection enum validated before provider evidence is interpreted; no provider field can create an unknown policy | malformed expected request/projection throws stage-0 `invalid_expected_request`; a structurally valid proposal denied by a known policy returns `permission_denied` |

Reactivating any reserved identifier requires a separately reviewed authoritative contract/schema change and a new strict provider-reachable vector. Reserved identifiers do not force a schema-version increment now and must not be implemented through a test hook or fabricated field.

##### Active rejection-code reachability matrix

Each active code has exactly one primary row. “Earlier stages pass” means the strict engine-owned input is conforming, transport/envelope/binding values not named as the trigger match, and every preceding stage succeeds. The vector column names the minimum intentional difference; it never relies on malformed engine-owned data.

| Active `reasonCode` | Exact step; public stage/location | Input owner | Minimum conforming preconditions and one triggering difference | Why no earlier stage intercepts; first-failure precedence | Later stages | Result kind | Required implementation vector |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `invalid_envelope` | 1; `transport/http_envelope` | provider/transport-derived | exact evidence shape; `contentTypeHeader: ""` | empty is a valid `[0..256]` string, so stage 0 passes; header semantics are first | no | rejection | empty and whitespace-only Content-Type/Encoding; valid OWS/case control |
| `body_too_large` | 2; `transport/http_envelope` | provider/transport-derived | valid headers; exact `Uint8Array(65_537)` | header stage passes and shape permits the bounded overflow proof | no | rejection | 65,536 continues; 65,537 rejects |
| `malformed_json` | 3; `transport/http_envelope` | provider/transport-derived | valid headers and bounded body; `Uint8Array.of(0xc3, 0x28)` | size is valid; fatal UTF-8 decode is first | no | rejection | invalid UTF-8 plus separate stage-4 syntactically invalid JSON |
| `unsupported_schema_version` | 6; `transport/http_envelope` | provider-derived | parsed strict HTTP field set; root `schemaVersion: 2` | shape is valid at stage 5; literal version is first examined at stage 6 | no | rejection | root version 2 plus nested provider-result version 2 |
| `fingerprint_mismatch` | 7; `fingerprint/fingerprint` | engine-owned expected request | exact request shape with a well-formed but non-recomputed request fingerprint | transport/envelope/version pass; recomputation owns the first mismatch | no | rejection | change one covered request value without updating fingerprint |
| `binding_mismatch` | 8; `binding/binding` | provider-derived echo | valid recomputed request fingerprint; change only provider `npcId` echo | request remains valid; provider echo comparison follows fingerprint verification | no | rejection | one vector for every immutable echo dimension |
| `idempotency_conflict` | 9; `duplicate/binding` | live snapshot | correlated provider echoes; live graph reuses the reaction/request alias with a different request fingerprint or graph | binding to the expected request passes; alias reuse is checked before stale applicability | no | rejection | same reaction plan/request identity with conflicting fingerprint/graph |
| `stale_request` | 10; `applicability/live_state` | live snapshot | all prior identity checks pass; current session/turn/phase/version/actor/trigger/attempt/status baseline differs, is unavailable, or is superseded | identity conflict is absent; hard live comparison is the first owner | no | rejection | each hard dimension, unavailable snapshot, status race, `attempting`, and superseded vectors |
| `invalid_candidate_schema` | 11; `structure/candidate` | provider-derived candidate | correlated active response; candidate has `proposals: []` | candidate is not examined before live routing; bound failure is not reserved-kind handling | no | rejection | missing/null/extra/wrong-type/bound/nesting, exactly 4/5 combined role/result proposals, plus proposal-location cases |
| `unsupported_in_phase6` | 11; `structure/proposal` | provider-derived candidate | otherwise strict candidate; one proposal discriminator is literal `commentary` | discriminator is a reserved provider literal, not an unknown shape | no | rejection | each reserved Phase-7 discriminator |
| `duplicate_response` | 14; `duplicate/provider_result` | caller-owned observation/status route | strict reconstructed candidate; observed same-attempt fingerprint equals engine computation, or a retained terminal attempt has no observation | structure and stage-13 engine hash must exist first | no | rejection | observed equal, terminal-none suppression, and terminal-observed-equal |
| `attempt_response_conflict` | 14; `duplicate/provider_result` | caller-owned observation | strict reconstructed candidate; same attempt observation carries a different prior candidate fingerprint | exact attempt equality is stage-0 input invariant and current hash first exists at stage 13 | no | rejection | active and compatible-terminal observed mismatch |
| `permission_denied` | 15; `authorization/policy` | engine-owned captured projection plus provider proposal | ordinary unobserved candidate; e.g. a structurally valid role claim under `avoid_unnecessary_claim` | policy value itself is valid; structure/duplicate routing pass; denial precedes target/fact checks | no | rejection | each known-policy, direct-question, actor-role, and disclosure denial; fixed v1 kind allowlist is a passing control |
| `unknown_reference` | 15; `authorization/reference` | provider proposal against captured/live graph | permitted targeted kind; well-formed `targetId` is absent from the otherwise valid common graph | policy passes; reference resolution precedes target eligibility and exact facts | no | rejection | absent and graph-outside provider target; duplicate engine graph is separately a stage-0 invariant and reset/roster replacement is stage-10 stale |
| `target_ineligible` | 15; `authorization/target` | provider proposal against captured/live graph | reference resolves uniquely; target is self, player-class, wrong class, or fails kind-specific current eligibility | reference exists; common target eligibility precedes exact result fact | no | rejection | self, player, dead vote/suspicion, and wrong-class vectors; dead result target must pass |
| `result_fact_mismatch` | 15; `authorization/known_information` | provider proposal against engine-owned actor-private projection | permitted result claim with a uniquely resolved eligible target; target/value/pair lacks the exact same actor-owned fact | kind, policy, reference, and common target checks pass first | no | rejection | target-only, result-only, cross-pair, hearsay-only, other-actor-only, and exact valid control |
| `duplicate_proposal` | 16; `authorization/proposal` | provider-derived candidate | every proposal is individually authorized; append an exact canonical duplicate | authorization passes for both; whole-candidate coherence owns equality | no | rejection | each proposal kind's exact duplicate |
| `contradictory_proposals` | 16; `authorization/proposal` | provider-derived candidate | every proposal is individually authorized; two valid vote declarations use different eligible living targets | neither proposal is duplicate or denied; contradiction is whole-candidate | no | rejection | different-target vote declarations provide the reachable vector; role/result alternatives that cannot both be authorized must prove their earlier `permission_denied`/`result_fact_mismatch` precedence instead of faking stage 16 |

The complete active step/stage/location set is closed by this coverage matrix. Rows sharing a code are additional mandatory vectors, not additional primary reachability rows:

| Step | Active `reasonCode` | Public `stage/location` |
| ---: | :--- | :--- |
| 1 | `invalid_envelope` | `transport/http_envelope` |
| 2 | `body_too_large` | `transport/http_envelope` |
| 3 | `malformed_json` | `transport/http_envelope` |
| 4 | `malformed_json` | `transport/http_envelope` |
| 5 | `invalid_envelope` | `transport/http_envelope` |
| 5 | `invalid_envelope` | `transport/provider_result` |
| 6 | `invalid_envelope` | `transport/http_envelope` |
| 6 | `invalid_envelope` | `transport/provider_result` |
| 6 | `unsupported_schema_version` | `transport/http_envelope` |
| 6 | `unsupported_schema_version` | `transport/provider_result` |
| 7 | `fingerprint_mismatch` | `fingerprint/fingerprint` |
| 8 | `binding_mismatch` | `binding/binding` |
| 9 | `idempotency_conflict` | `duplicate/binding` |
| 10 | `stale_request` | `applicability/live_state` |
| 11 | `invalid_candidate_schema` | `structure/candidate` |
| 11 | `invalid_candidate_schema` | `structure/proposal` |
| 11 | `unsupported_in_phase6` | `structure/proposal` |
| 14 | `duplicate_response` | `duplicate/provider_result` |
| 14 | `attempt_response_conflict` | `duplicate/provider_result` |
| 15 | `permission_denied` | `authorization/policy` |
| 15 | `unknown_reference` | `authorization/reference` |
| 15 | `target_ineligible` | `authorization/target` |
| 15 | `result_fact_mismatch` | `authorization/known_information` |
| 16 | `duplicate_proposal` | `authorization/proposal` |
| 16 | `contradictory_proposals` | `authorization/proposal` |

No other active step/stage/location combination exists.

Stage 17 adds no independently provider-reachable code/location combination in initial v1. It deterministically reruns the named stage-10/stage-15 predicates against the same immutable snapshot. A conforming input that passed those predicates must pass the recheck; implementations must test this equivalence and must never force a stage-17 failure with mutation, a second state read, or a hook. If a named predicate is reported there because an implementation decomposes the checks across stages, its public code/location remains the same specific owner shown above; `final_live_validation_failure` is never returned.

The first failing layer controls `reasonCode`; later layers are not executed. A diagnostic may repeat that reason and may add only other codes already observed in the same executed layer, up to eight total. It cannot expose which hidden role, team, investigation fact, private score, or policy payload caused a denial. The exact `reasonCode`, but never the diagnostics array, may be copied into the existing redacted lifecycle observation. HTTP outcomes remain the coarser `ErrorEnvelope`; this runtime result is never returned to the provider or copied into public history.

Constructing or returning either union member allocates no authoritative ID, mutates no registry or game state, invokes no sink, and increments `stateVersion` by `0`; the authoritative graph remains exactly the player-committed `N+1` graph.

Normative validation success example for the request/response above:

```json
{
  "schemaVersion": 1,
  "status": "validated",
  "value": {
    "schemaVersion": 1,
    "binding": {
      "gameSessionId": "game-session-1",
      "reactionPlanId": "reaction-plan-1",
      "reactionAttemptId": "reaction-attempt-1",
      "requestId": "reaction-request-1",
      "requestFingerprint": "ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6",
      "correlationId": "correlation-1",
      "causationId": "player-request-1",
      "originatingInputRecordId": "input-1",
      "turnId": "turn-1",
      "turnOrder": 1,
      "preconditionPhase": "player_question",
      "preconditionStateVersion": 2,
      "npcId": "npc-aoi"
    },
    "candidate": {
      "schemaVersion": 1,
      "proposals": [
        { "proposalType": "role_claim", "claimedRole": "seer" },
        { "proposalType": "result_claim", "targetId": "npc-beni", "result": "werewolf" }
      ]
    },
    "candidateFingerprint": "64a82470787c3492e03bca709c779088957fa0b451481c3386aa5c494af7b481",
    "validationContext": {
      "projectionFingerprint": "12b85c8ef13ca8b42101fb15df59e9c3a1918b33402aaf0ef786138a746a13b6",
      "roleDisclosurePolicy": "claim_when_directly_asked_after_result",
      "permissionResult": "allowed",
      "finalApplicabilityResult": "applicable"
    }
  }
}
```

Normative validation rejection example against the same expected binding:

```json
{
  "schemaVersion": 1,
  "status": "rejected",
  "binding": {
    "gameSessionId": "game-session-1",
    "reactionPlanId": "reaction-plan-1",
    "reactionAttemptId": "reaction-attempt-1",
    "requestId": "reaction-request-1",
    "requestFingerprint": "ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6",
    "correlationId": "correlation-1",
    "causationId": "player-request-1",
    "originatingInputRecordId": "input-1",
    "turnId": "turn-1",
    "turnOrder": 1,
    "preconditionPhase": "player_question",
    "preconditionStateVersion": 2,
    "npcId": "npc-aoi"
  },
  "rejection": {
    "stage": "authorization",
    "reasonCode": "permission_denied",
    "retryable": false,
    "diagnostics": [
      { "code": "permission_denied", "location": "policy" }
    ]
  }
}
```

#### Validation-only boundary

The first implementation enabled by this contract ends at a validated candidate. Its successful value is session-local, runtime-only, nonauthoritative, detached from provider objects, recursively immutable, and bound to the exact preparation/attempt identity plus the engine-computed candidate fingerprint. It is not stored in an authoritative registry, does not allocate descriptor/claim/event/segment/publication/commit IDs, does not prepare or apply an authoritative delta, does not increment `stateVersion`, does not publish or display content, does not acknowledge a commit, does not call the provider/retry/timeout coordinator, and does not invoke either structured or legacy fallback. The authoritative state remains `N+1`; validation never performs `N+1 -> N+2`.

Validation success means only that one untrusted response was correlated, structurally normalized, semantically authorized, and made eligible for a later pure preparation step. Authoritative ID allocation, delta preparation, `NpcReactionPlan` creation, `N+1 -> N+2`, canonical publication, delivery, and replayable commit results require separately reviewed implementation stages. No code may infer those later effects from validation success.

The session-local reaction coordinator owns a validated value only while its exact attempt remains in `validated`; a pure validation harness owns it only for the duration of that call/test. It is never placed in an authoritative registry, tombstone, history, diagnostic record, publication log, browser state, CLI state, or provider cache. Reset/destroy, session replacement, turn/phase/version replacement, logical cancellation/rejection/supersession/exhaustion/commit, or activation of a newer attempt immediately expires and discards it. Attempt supersession cannot transfer the value to a new `reactionAttemptId`. Garbage collection after expiry has no externally visible effect.

The future engine-owned authoritative preparation stage is responsible for the repeated live applicability and policy check immediately before it derives any authoritative delta. This contract defines that responsibility and the validation-only input boundary; it does not define a new commit/coordinator API. Until that later stage is approved, validated values cannot be routed into production commands.

While only the validation stage exists, it is exercised through pure contract/validator APIs and an explicit non-routing integration harness. `NPC_STRUCTURED_REACTION_MODE` must not route an ordinary top-level command into a live provider workflow that can stop with logical `active` or attempt `validated`; the current inert route remains unchanged until a later reviewed coordinator stage can either continue through preparation/commit or reach an existing legal terminal status. Validation-only code must not invent a terminal “success”, mark an attempt `accepted`, or hold a player command open.

Validation is ordered and fail-closed by the exact nineteen-stage evaluation order numbered 0 through 18 above. In summary, raw transport evidence precedes envelope and binding checks; request fingerprint and initial live applicability precede candidate reconstruction; observed-candidate duplicate/conflict comparison follows engine-owned candidate fingerprint computation and precedes semantic authorization/projection fingerprinting; final applicability is last. A successful validation retains only the immutable runtime candidate/binding/fingerprints and redacted outcome with zero authoritative writes or external display effects. Later preparation and commit remain outside validation-only implementation and must repeat live session/turn/order/phase/version/actor/target/identity/policy/CAS checks before any atomic publication.

Validation never degrades on retry. Raw provider text, a legacy text field, display output, a server response, or sink acknowledgement cannot bypass a failed layer. The provider selects semantic proposals only; later engine rule functions alone may construct closed authoritative effects.

### Pure authoritative NPC reaction preparation

This subsection is normative for the separately reviewed preparation stage in migration step 5. It defines what is prepared from one `ValidatedNpcReactionCandidate`; it does not perform final replay lookup, compare-and-commit, atomic application, coordinator/tombstone transition, provider routing, or publication delivery. The following Authoritative Commit Contract defines the commit responsibilities without implementing them.

Initial Phase 6 preparation is canonical-only. Every one of the four accepted proposal types becomes a canonical descriptor/artifact set. Preparation never accepts or returns controlled commentary, commentary descriptors, a `RendererRequest`, a controlled-publication reservation, a fallback variant, or a finalization record. Those remain Phase 7.

#### Audit closure matrix

| Contract | Existing authority | Existing runtime | Pre-change gap | Contract closed here |
| :--- | :--- | :--- | :--- | :--- |
| plan schema | section 13 requires attempt and both versions | validator omits `successfulAttemptId` and `preconditionStateVersion` | contradiction | authoritative fields retained; runtime follow-up required |
| preparation API | section 17 prose | none | undefined | one synchronous pure entrypoint and closed result/error contracts |
| snapshot | validation applicability projections | none for preparation | undefined | strict local-only preparation snapshot |
| allocation | engine-owned identity rules | ID helpers and logical/attempt foundation | partial | exact preallocated artifact bundle and cardinality |
| order reservation | version/order ledger | player preparation counters | partial | exact non-mutating reservation arithmetic |
| proposal mapping | descriptor/reference/completeness validators | graph validators | partial | exact proposal-to-descriptor/claim/event/segment mapping |
| effect boundary | section 17 prose and Phase 8 deferral | legacy text effects | partial | exact zero deltas for initial Phase 6 |
| result union | none | none | undefined | strict prepared/rejected union and invariant error |
| prepared delta | generic prose | player-only delta | undefined | canonical-only `NpcReactionCommitDelta` |

#### One public preparation boundary

The only public preparation entrypoint is:

```text
prepareNpcReaction(input: NpcReactionPreparationInput)
  -> NpcReactionPreparationResult
```

It is synchronous and pure. It performs no state read, state mutation, ID generation, counter update, provider/network work, timer, callback, observer notification, publication delivery, sink, or acknowledgement. It never imports or dereferences `WerewolfGame`; all required current evidence is supplied in the strict input. It reconstructs new plain objects, shares no reference with the input/provider/validated candidate, mutates no input, and recursively freezes a successful value before return.

Malformed engine-owned input throws `NpcReactionPreparationInvariantError` synchronously. A well-shaped snapshot that no longer matches the validated binding or current eligibility returns the closed rejection member. A validated candidate proves only a prior validation instant and never authorizes preparation or commit by itself.

#### `NpcReactionPreparationInput`

`NpcReactionPreparationInput` requires exactly `schemaVersion: 1`, `validatedCandidate: ValidatedNpcReactionCandidate`, `preparationSnapshot: NpcReactionPreparationSnapshot`, `artifactAllocation: NpcReactionArtifactAllocation`, and `orderReservation: NpcReactionOrderReservation`. It has no optional or nullable fields and `additionalProperties: false`.

Every nested object is a non-null plain object with `additionalProperties: false`; every array is dense and uses the bounds below. IDs and fingerprints use section 10 types, integers are safe non-negative integers, and duplicates are rejected where uniqueness is stated. The engine reconstructs and freezes the complete input before calling preparation. The input is runtime-only, expires with its exact session/logical-reaction/attempt applicability, is never sent to a provider, and is not a commit capability.

`validatedCandidate` must pass the exact merged `ValidatedNpcReactionCandidate` contract. Preparation recomputes its candidate fingerprint, validates its projection fingerprint syntax, and compares every binding field to the snapshot. An externally constructed object is not trusted merely because it has the success discriminator.

#### `NpcReactionPreparationSnapshot`

The active `WerewolfGame` synchronously creates one detached, recursively immutable, runtime-only snapshot immediately before preparation. The snapshot requires exactly the following fields:

| Field | Exact type and rule |
| :--- | :--- |
| `schemaVersion` | literal `1` |
| `snapshotType` | literal `npc_reaction_preparation` |
| `gameSessionId` | `ID` |
| `turnId` | `ID` |
| `turnOrder` | safe integer `>= 0` |
| `currentPhase` | `GamePhase` |
| `currentStateVersion` | safe integer `>= 0` |
| `logicalReaction` | exact `NpcReactionPreparationLogicalReaction` |
| `winningAttempt` | exact `NpcReactionPreparationWinningAttempt` |
| `triggeringCommitResult` | exact `PlayerConversationCommitResult` |
| `originatingInputRecord` | exact `PlayerInputRecord` |
| `triggeringEvents` | `PublicEvent[0..64]`, in `triggeringCommitResult.createdEventIds` order |
| `currentRoster` | `NpcPreparationRosterEntry[2..16]`, sorted by `participantId` |
| `actorApplicability` | exact `NpcPreparationActorApplicability` union |
| `currentAuthorization` | exact `NpcReactionPreparationAuthorization` |
| `currentTargetIds` | unique `ID[0..16]`, first proposal-reference order |
| `existingClaims` | committed `CanonicalClaim[0..4096]`, authoritative registry order |
| `existingEvents` | committed `PublicEvent[0..4096]`, authoritative registry order |
| `nextOrderEvidence` | exact `NpcReactionNextOrderEvidence` |
| `occupiedArtifactIds` | unique `ID[0..65536]`, ASCII-lexicographic order, complete collision projection |

`NpcReactionPreparationLogicalReaction` requires exactly `schemaVersion: 1`, `gameSessionId`, `reactionPlanId`, `requestId`, `requestFingerprint`, `correlationId`, `causationId`, `originatingInputRecordId`, `turnId`, `turnOrder`, `preconditionPhase`, `preconditionStateVersion`, `npcId`, and `status: LogicalReactionStatus`. All identity fields are `ID`; the fingerprint and integer/phase fields use their existing types. `NpcReactionPreparationWinningAttempt` requires exactly `schemaVersion: 1`, `reactionPlanId: ID`, `reactionAttemptId: ID`, and `status: ReactionAttemptStatus`. Every closed status is a well-shaped current-state observation; only unknown values or wrong types are stage-0 invariants.

`NpcPreparationRosterEntry` requires exactly `participantId: ID`, `participantClass: "player" | "npc"`, and `publicStatus: "alive" | "dead"`. IDs are unique, exactly one entry is class `player`, and the expected actor resolves either zero or one time as class `npc`; duplicate actor identity or a present actor with another class is an invariant. `NpcPreparationActorApplicability` is a strict union discriminated by `presence`. Its present member requires exactly `schemaVersion: 1`, `presence: "present"`, `actorId: ID`, `alive: boolean`, and `maySpeak: boolean`. Its absent member requires exactly `schemaVersion: 1`, `presence: "absent"`, `actorId: ID`, and `absenceReason: "removed_from_roster"`, and forbids `alive`/`maySpeak`. The actor ID always equals the logical actor. Present requires exactly one matching roster member and `alive` must equal that member's public status; absent requires zero. These are self-consistency rules, not eligibility assertions. Absent, present/dead, and present/unable-to-speak are well-shaped and return `actor_ineligible`.

`NpcReactionPreparationAuthorization` is a local-only strict union discriminated by `availability`. Its available member requires exactly `schemaVersion: 1`, `availability: "available"`, `actorId: ID`, `roleDisclosurePolicy: NpcRoleDisclosurePolicy`, unique `allowedClaimRoles: ClaimableRole[0..1]`, and unique `authorizedResultFacts: NpcPreparationAuthorizedResultFact[0..16]`. `NpcPreparationAuthorizedResultFact` requires exactly `targetId: ID` and `result: ClaimResult`; pairs are unique and contain no day, source evidence, hidden role/team, or truth label. Its unavailable member requires exactly `schemaVersion: 1`, `availability: "unavailable"`, `actorId: ID`, and `reason: "actor_absent"`, and forbids policy/claim/result fields. Actor present requires the available member; actor absent requires the unavailable member. This cross-member equality is snapshot self-consistency and permits absence without inventing policy or private facts. The minimal available projection is reconstructed from current actor-owned state solely to recheck a candidate already validated for this actor and is never sent to the provider, stored, logged, returned, or copied into a prepared artifact. The actor ID must equal `logicalReaction.npcId`. `allowedClaimRoles` is exactly `["seer"]` only when current policy/actor authority and at least one current authorized result fact permit it, and otherwise `[]`; contradictions are invariant failures. A valid current projection that differs from the captured validation context produces the applicable `permission_denied` or `result_fact_mismatch` rejection without exposing the differing value.

`NpcReactionNextOrderEvidence` requires exactly `nextCreatedOrder`, `nextPublicationSlotOrder`, and `nextRecordAppendOrder`, each a safe integer `>= 0`. `nextPublicationSlotOrder` is the captured projection of existing authoritative field `state.conversation.nextPublicationSlotOrder`, and `nextRecordAppendOrder` is the captured projection of existing authoritative field `state.conversation.nextRecordAppendOrder`; the evidence names do not create separate counters. Runtime fields named `nextCanonicalPublicationSlotOrder` or `nextCanonicalPublicationRecordAppendOrder`, and aliases, mirrors, renamed copies, NPC-only counters, or per-record-type counters for the same meaning, are forbidden. The two existing counters reserve the future authoritative `NpcCanonicalUtterancePublishedRecord` in the same global registry used by player publications and are unrelated to delivery, Renderer, acknowledgement, retry, UI-history, or observer ordering. `occupiedArtifactIds` is the complete local-only union of IDs already used by the session's authoritative conversation graph and logical-reaction identities. It carries identities only, no private payload, and is never sent to a provider.

The triggering result, input, and events must form one internally consistent captured player graph. `triggeringCommitResult.requestId == logicalReaction.causationId`; its `inputRecordId` equals the logical origin; its `resultingStateVersion` equals the logical precondition; the input matches request/input/turn/correlation/version; and `triggeringEvents` exactly resolves the result's event IDs in stored order. Snapshot-internal contradictions throw an invariant. `existingEvents` and `existingClaims` are separate current committed-registry projections: a captured trigger/reference missing from or differing in that current graph is a reachable `invalid_reference`, not an input invariant. Equality between a valid snapshot and the validated candidate is an applicability comparison and rejects normally.

The snapshot is not authoritative state and does not promise that state remains unchanged after preparation. The future final commit must reread current state and perform the separately specified CAS.

#### Causation and identity derivation

Preparation generates none of the logical identities. `reactionPlanId`, reaction `requestId`, `correlationId`, `causationId`, `originatingInputRecordId`, `turnId`, and `npcId` come from the logical reaction. `successfulAttemptId` is the validated binding's `reactionAttemptId` and must equal the winning attempt. `causationId` is the triggering player result request ID; the origin is that result's exact input.

`causationEventIds` is derived by scanning `triggeringEvents` in stored result order and retaining only `public_question_recorded` events whose source resolves to the exact originating input and whose `targetId` equals `npcId`. IDs remain unique and in source order. Same-reaction, display, uncommitted, foreign-input, and other-target records are forbidden. Zero matches yields `[]`. More than 16 matches returns `causation_event_overflow`; no truncation is allowed.

#### `NpcReactionArtifactAllocation`

Preparation generates no ID. Before the call, `WerewolfGame` supplies one allocation object requiring exactly:

- `schemaVersion: 1`
- `allocationType: "npc_reaction_artifacts"`
- `descriptorIds: ID[1..16]`
- `claimAllocations: NpcReactionClaimAllocation[0..4]`
- `eventIds: ID[1..16]`
- `segmentIds: ID[1..16]`
- `publicationId: ID`

`NpcReactionClaimAllocation` requires exactly `proposalIndex: safe integer 0..15` and `claimId: ID`. Descriptor, event, and segment arrays each have exactly the proposal count and correspond by index. Claim allocations exist exactly for the at most four role/result proposal indexes, in proposal order, with no other index. Publication count is exactly one. A fifth claim-producing proposal cannot reach preparation because candidate structure rejects it. More than four claim allocations, or missing, unused, reordered, or duplicate allocation fields, are invariant failures; a valid allocation collision with the current occupied projection returns `artifact_id_collision`. All allocated IDs are pairwise unique, absent from `occupiedArtifactIds`, and never supplied by the provider.

Logical reaction, request, correlation, causation, origin, attempt, turn, and actor IDs are pre-existing and forbidden in this allocation. An allocation-generator failure occurs before preparation and is not a provider or preparation rejection. An allocated but uncommitted ID is nonauthoritative and is never copied to history, an authoritative registry, an observer, or a tombstone after rejection/commit failure.

The claim-capacity boundary is exact across layers:

| Evidence | Count | Classification |
| :--- | :--- | :--- |
| provider candidate role/result proposals | `0..4` | candidate validation may continue |
| provider candidate role/result proposals | `5..16` | stage-11 `invalid_candidate_schema`; no validated value or preparation input |
| preparation claim allocations for a valid candidate | exactly the role/result count, therefore `0..4` | continue |
| engine-owned preparation allocation with more than four claim allocations | malformed input; `invalid_artifact_allocation` invariant |
| prepared claims and expected result `createdClaimIds` | same IDs in proposal order, both `0..4` | continue |

#### `NpcReactionOrderReservation`

The engine derives a reservation synchronously from current counters but does not advance them. It requires exactly:

- `schemaVersion: 1`
- `reservationType: "npc_reaction_orders"`
- `preconditionNextCreatedOrder: safe integer >= 0`
- `eventCreatedOrders: safe integer[1..16]`
- `commitResultCreatedAtOrder: safe integer >= 0`
- `resultingNextCreatedOrder: safe integer >= 0`
- `preconditionNextPublicationSlotOrder: safe integer >= 0`
- `publicationSlotOrder: safe integer >= 0`
- `resultingNextPublicationSlotOrder: safe integer >= 0`
- `preconditionNextRecordAppendOrder: safe integer >= 0`
- `publicationRecordAppendOrder: safe integer >= 0`
- `resultingNextRecordAppendOrder: safe integer >= 0`
- `priorClaimCount: safe integer >= 0`
- `priorEventCount: safe integer >= 0`

For `P` proposals, `eventCreatedOrders` is exactly the consecutive range `[nextCreatedOrder, nextCreatedOrder + P - 1]`; the commit result order is `nextCreatedOrder + P`; and `resultingNextCreatedOrder` is `nextCreatedOrder + P + 1`. Publication slot and append order each equal their authoritative canonical-counter precondition and each resulting canonical counter is precondition plus one. `priorClaimCount` and `priorEventCount` equal the lengths of the frozen committed prefixes in the snapshot. Claims have no independent created-order field; their relation boundary is the exact `existingClaims[0..priorClaimCount)` prefix plus the lower-created-version rule. No prepared same-transaction claim is part of that prefix.

Every addition is checked before preparation and must remain a safe integer. Overflow returns `order_exhausted`; a `Number.MAX_SAFE_INTEGER` state-version precondition returns `state_version_exhausted`. Duplicate, missing, unused, nonconsecutive, or arithmetically inconsistent order fields are invariant failures. Rejection and commit failure advance no authoritative counter and create no gap. The future final CAS must compare all three current next-order values with these preconditions.

#### Proposal-to-artifact mapping

Proposal order is preserved unchanged as descriptor, event, and canonical segment order. Each proposal creates exactly one descriptor, one semantic event, and one segment. Only role/result proposals create a claim. Every source uses the plan's request, correlation, causation, origin, turn, phase, actor, and resulting version; every event consumes its same-index event order.

| Proposal | Descriptor | Claim | Event | Segment | Additional game-state effect |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `role_claim` | `RoleClaimDescriptor` with allocated descriptor ID and validated role | one `RoleCanonicalClaim` | one `role_claim_recorded` referencing the claim | one `NpcCanonicalClaimSegment` | none |
| `result_claim` | `ResultClaimDescriptor` with validated target/result | one `ResultCanonicalClaim` containing only that public assertion | one `result_claim_recorded` referencing the claim | one `NpcCanonicalClaimSegment` | none; no hidden truth/fact is copied |
| `vote_declaration` | `VoteDeclarationDescriptor` with validated target | none | one `vote_declared` | one `NpcCanonicalVoteSegment` | declaration only; no ballot/tally/action mutation |
| `suspicion` | `SuspicionDescriptor` with validated target | none | one `suspicion_expressed` | one `NpcCanonicalSuspicionSegment` | public expression only; no numeric score mutation |

NPC claims use `claimRevision: 1`, actor `npcId`, status `asserted`, the resulting turn/version, exact `NpcReactionClaimSource`, and the existing NPC claim idempotency formula `SHA-256(reactionCommitRequestId, reactionPlanId, descriptorId, actorId, claimKind)`. Events use exact `NpcReactionEventSource` and idempotency key `(reactionPlanId, descriptorId, eventType)` under the repository fingerprint algorithm.

Claim relations consult only the committed `existingClaims` prefix. The same subject is the actor for role claims and `(actorId, targetId)` for result claims. Normalized payload is `claimedRole` or `(targetId, result)`. If an exact prior payload exists, `repeatsClaimId` is the first matching claim in authoritative registry order and `contradictsClaimIds` is `[]`. Otherwise `repeatsClaimId` is `null` and contradictions contain every conflicting same-actor/type/subject prior claim ID in registry order, without duplicates. Amendment is unsupported. Hidden truth is never read. Prepared claims do not relate to each other because candidate validation already rejects within-candidate duplicates and contradictions.

#### Phase 6/Phase 8 effect boundary and policies

Initial Phase 6 has exact zero deltas for numeric suspicion, private memory, legacy free-form public history, actual vote state, and phase transition. `NpcReactionZeroEffects` requires exactly `suspicionScoreUpdates: []`, `memoryUpdates: []`, `legacyPublicHistoryEntries: []`, `voteStateUpdates: []`, and `phaseTransitions: []`. These fields are always present and empty. Structured claims, semantic events, the plan/segments, and the canonical publication are authoritative artifacts, not legacy history deltas.

Phase 8 may later add numeric suspicion/memory derivation inside the same reaction transaction. It cannot change proposal meaning, plan/descriptor/event/segment/publication identity, provider authority, or the one-transition ledger. Before Phase 8, legacy prose, provider text, and keyword matching never derive those effects.

`ReactionPolicies` is deterministic: `allowStateChanges` is always `true`; `allowClaims`, `allowVoteDeclaration`, and `allowSuspicionUpdate` equal whether their corresponding proposal kinds occur; and `allowMemoryUpdate` is always `false`. In initial Phase 6 `allowSuspicionUpdate` authorizes creation of the public `SuspicionExpressedEvent`, not numeric suspicion mutation.

#### Canonical presentation policy

The plan locale is copied only from `originatingInputRecord.locale`; current UI locale and provider values cannot select it. `maxChars` is engine literal `1000`. `canonicalRendererVersion` is engine literal `1`, is stored in the canonical publication, and is reused from that record on replay. Initial preparation never calls Renderer.

Preparation creates exactly one `NpcCanonicalUtterancePublishedRecord`. Its plan, reaction request, origin, correlation, turn, resulting version, actor, locale, ordered segment IDs, allocated publication ID, reserved slot, and reserved append order must match the prepared graph. It stores no canonical text. Creating the record is preparation/commit data; live delivery, sink success, acknowledgement, and history consumption are later nonauthoritative responsibilities.

#### `NpcReactionCommitDelta` and prepared value

`NpcReactionPreparationBinding` requires exactly `schemaVersion: 1`, `gameSessionId`, `reactionPlanId`, `successfulAttemptId`, `requestId`, `requestFingerprint`, `correlationId`, `causationId`, `originatingInputRecordId`, `turnId`, `turnOrder`, `preconditionPhase`, `preconditionStateVersion`, and `npcId`, using the types above.

`NpcReactionCommitDelta` is a strict canonical-only value requiring exactly:

- `schemaVersion: 1`, `commitType: "npc_reaction"`, `resultMode: "canonical_only"`
- `binding: NpcReactionPreparationBinding`
- `preparationFingerprint: Sha256Fingerprint`, the preparation-integrity value defined below
- `requestFingerprint`, `candidateFingerprint`, and `projectionFingerprint`: distinct `Sha256Fingerprint` values with their existing meanings
- `preconditionPhase: GamePhase`, `resultingPhase: GamePhase`, equal in initial Phase 6
- `preconditionStateVersion` and `resultingStateVersion`, safe integers with exact `+1`
- `plan: CanonicalOnlyReactionPlan`
- `claims: CanonicalClaim[0..4]`, exactly the bounded role/result proposal set in proposal order
- `events: PublicEvent[1..16]`, exactly one per proposal in proposal order
- `publication: NpcCanonicalUtterancePublishedRecord`
- `effects: NpcReactionZeroEffects`
- `artifactAllocation: NpcReactionArtifactAllocation`
- `orderReservation: NpcReactionOrderReservation`
- `expectedCommitResult: CanonicalNpcReactionCommitResult`
- `idempotencyReservation: NpcReactionIdempotencyReservation`

It has no optional/null fields and `additionalProperties: false`. `NpcReactionIdempotencyReservation` requires exactly `schemaVersion: 1`, `requestId: ID`, `requestFingerprint: Sha256Fingerprint`, `reactionPlanId: ID`, `successfulAttemptId: ID`, and `preparationFingerprint: Sha256Fingerprint`. It is an uncommitted reservation payload, not an index entry. Lookup, replay priority, insertion, and commit ordering belong to the next commit-contract PR.

`expectedCommitResult` uses the existing canonical result schema unchanged. Its created event/claim IDs exactly equal the prepared arrays, its publication and plan IDs match, and its `createdAtOrder` is the reservation value. Candidate/projection fingerprints are not added to the result; successful attempt ownership remains in the plan.

`PreparedCanonicalNpcReaction` requires exactly `schemaVersion: 1`, `preparationType: "canonical_npc_reaction"`, `delta: NpcReactionCommitDelta`, and `preparationFingerprint: Sha256Fingerprint`. It is detached, recursively frozen, runtime-only, nonauthoritative, and not stored before final commit success.

The preparation fingerprint is `sha256CanonicalJson(fingerprintInput(delta))`: lowercase 64-hex SHA-256 over a detached reconstruction of the strict delta in which both `delta.preparationFingerprint` and `delta.idempotencyReservation.preparationFingerprint` are replaced by 64 lowercase zeroes. It includes all binding/allocation/order evidence, plan, claims, events, segments through the plan, publication, zero effects, expected result, and every other idempotency-reservation field. The final fingerprint is copied into the delta, reservation, and outer prepared value; all three must match. Verification reconstructs the same `fingerprintInput(delta)` and repeats the two-field zero-substitution algorithm. This breaks the self-reference deterministically. Raw/provider bodies, diagnostics, timestamps, coordinator status, and delivery state are excluded. Object-key order is irrelevant; array order is preserved. It is distinct from request, candidate, and projection fingerprints and grants no authority.

#### Preparation result and invariant error

`NpcReactionPreparationResult = NpcReactionPreparedResult | NpcReactionPreparationRejectedResult`, discriminated by `status`. Both are strict, non-null, schema version 1 objects.

- `NpcReactionPreparedResult` requires exactly `schemaVersion: 1`, `status: "prepared"`, and `value: PreparedCanonicalNpcReaction`.
- `NpcReactionPreparationRejectedResult` requires exactly `schemaVersion: 1`, `status: "rejected"`, `binding: NpcReactionPreparationRejectionBinding`, and `rejection: NpcReactionPreparationRejection`.

The rejection binding requires exactly `schemaVersion`, `gameSessionId`, `reactionPlanId`, `successfulAttemptId`, `requestId`, `correlationId`, `turnId`, `preconditionStateVersion`, and `npcId`; it comes from the engine-expected snapshot, never provider content. Rejection requires exactly `stage`, `reasonCode`, `retryable: false`, and `diagnostics`. Diagnostics are dense `NpcReactionPreparationDiagnostic[0..8]`, each exactly `{ code, location }`; they contain no message or free-form path.

Stages are `binding | applicability | authorization | allocation | ordering | construction`. Locations are `validated_candidate | session | turn | phase | state_version | logical_reaction | attempt | actor | target | reference | policy | known_information | artifact_allocation | order_reservation | causation_events`. The first failure controls the result; later work is not executed. Fingerprint primitive/integrity failure is engine-internal and therefore belongs only to the invariant error contract, not these rejection enums.

The exact first-failure order is: (0) validate/reconstruct all engine-owned shapes and snapshot self-consistency or throw the invariant error; (1) recompute and verify the candidate fingerprint without classifying live equality; (2) compare candidate and current session; (3) turn ID/order; (4) phase; (5) state version and exhaustion; (6) compare immutable request/fingerprint/correlation/trigger/origin/actor binding and then logical reaction identity/status; (7) winning attempt; (8) actor eligibility; (9) current role/result disclosure permission, including the direct-question and at-least-one-actor-owned-result requirements; (10) captured/current reference resolution; (11) kind-specific current target eligibility; (12) exact actor-owned result-fact authorization; (13) allocation cardinality/uniqueness/collision; (14) order arithmetic/exhaustion; (15) causation derivation and overflow; (16) complete artifact graph construction and strict cross-reference verification; and (17) preparation fingerprint calculation, reconstruction, three-way fingerprint equality, and recursive freeze. At step 6, immutable binding inequality returns `stale_validated_binding`; exact binding with a non-active or different logical reaction returns `logical_reaction_mismatch`. A fingerprint primitive throw, non-fingerprint return, or internal three-way mismatch at step 17 throws the fixed `preparation_fingerprint_failure` invariant; it is never a rejection result and requires no injectable/test-only failure hook. Each failure terminates immediately. Diagnostics cannot change the primary stage, reason, or location.

Status and actor applicability use the following exhaustive first-failure matrix. A result in an earlier row group prevents evaluation of later groups.

| Current dimension | Closed value | Classification |
| :--- | :--- | :--- |
| logical status | `active` | continue to attempt applicability |
| logical status | `planned` | `logical_reaction_mismatch` |
| logical status | `committed` | `logical_reaction_mismatch` |
| logical status | `rejected` | `logical_reaction_mismatch` |
| logical status | `superseded` | `logical_reaction_mismatch` |
| logical status | `cancelled` | `logical_reaction_mismatch` |
| logical status | `exhausted` | `logical_reaction_mismatch` |
| attempt status, after logical `active` | `validated` | continue to actor applicability |
| attempt status, after logical `active` | `attempting` | `attempt_mismatch` |
| attempt status, after logical `active` | `candidate_received` | `attempt_mismatch` |
| attempt status, after logical `active` | `accepted` | `attempt_mismatch` |
| attempt status, after logical `active` | `failed` | `attempt_mismatch` |
| attempt status, after logical `active` | `timed_out` | `attempt_mismatch` |
| attempt status, after logical `active` | `rejected` | `attempt_mismatch` |
| attempt status, after logical `active` | `aborted` | `attempt_mismatch` |
| actor, after logical/attempt continue | `present`, alive, may speak | continue to semantic authorization |
| actor, after logical/attempt continue | `absent` | `actor_ineligible` |
| actor, after logical/attempt continue | `present`, dead | `actor_ineligible` |
| actor, after logical/attempt continue | `present`, alive, may not speak | `actor_ineligible` |
| any dimension | unknown enum, wrong type, duplicate actor, or actor/roster/authorization self-contradiction | stage-0 `NpcReactionPreparationInvariantError` |

| Reason code | Stage/location | Exact primary reachable vector |
| :--- | :--- | :--- |
| `stale_validated_binding` | `binding/validated_candidate` | valid candidate binding differs from the expected logical request/correlation/trigger/origin/actor binding |
| `stale_session` | `applicability/session` | snapshot session was replaced or unavailable |
| `stale_turn` | `applicability/turn` | turn ID/order differs |
| `stale_phase` | `applicability/phase` | current phase differs from `player_question`/binding phase |
| `stale_state_version` | `applicability/state_version` | current version differs from the player-result `N+1` |
| `logical_reaction_mismatch` | `applicability/logical_reaction` | logical ID/request/status is not the exact active reaction |
| `attempt_mismatch` | `applicability/attempt` | winning attempt differs or is not `validated` |
| `actor_ineligible` | `authorization/actor` | current actor is missing, dead, or cannot speak |
| `target_ineligible` | `authorization/target` | a proposal target is removed, replaced, self/player class, or no longer kind-eligible |
| `invalid_reference` | `authorization/reference` | trigger/input/event/claim reference no longer resolves in the supplied current graph |
| `permission_denied` | `authorization/policy` | current disclosure policy no longer permits role/result publication |
| `result_fact_mismatch` | `authorization/known_information` | exact actor-owned result fact no longer authorizes the target/result pair |
| `state_version_exhausted` | `ordering/state_version` | precondition is `Number.MAX_SAFE_INTEGER` |
| `order_exhausted` | `ordering/order_reservation` | any required reservation addition exceeds the safe-integer range |
| `artifact_id_collision` | `allocation/artifact_allocation` | a well-shaped allocated ID exists in the complete occupied-ID projection |
| `causation_event_overflow` | `construction/causation_events` | more than 16 otherwise eligible triggering question events exist |

Every rejection performs zero authoritative mutations, counter updates, publications, status transitions, callbacks, or delivery effects. It stores no raw candidate/body, hidden role/team, private result, policy payload, memory, internal suspicion score, stack, provider metadata, or free-form diagnostic.

`NpcReactionPreparationInvariantError` has exact `name: "NpcReactionPreparationInvariantError"`, fixed message `Invalid NPC reaction preparation input.`, and one closed `code`. It stores no nested cause, raw value, free-form path, provider data, or additional field. Codes are `invalid_preparation_input | unsupported_preparation_schema | invalid_validated_candidate | invalid_snapshot | contradictory_snapshot | invalid_artifact_allocation | invalid_order_reservation | duplicate_engine_id | invalid_committed_graph_projection | preparation_fingerprint_failure`. Duplicate IDs inside the allocation are malformed input (`duplicate_engine_id`); collision between a valid allocation and current occupied projection is the rejection above. `preparation_fingerprint_failure` is reserved to an unexpected failure of the fixed repository fingerprint primitive or the engine's own post-construction equality assertion; it cannot be induced by conforming provider/state input and is not exposed through a test hook. Expected current-state mismatch never becomes an invariant error.

#### Normative preparation examples

The following compact examples are schema-complete for the preparation-owned types. Existing referenced `PlayerInputRecord`, `PublicEvent`, `CanonicalClaim`, and commit-result members retain their exact schemas from earlier sections; the examples use empty prior registries where permitted.

Valid artifact allocation:

```json
{"schemaVersion":1,"allocationType":"npc_reaction_artifacts","descriptorIds":["desc-1"],"claimAllocations":[],"eventIds":["event-2"],"segmentIds":["segment-1"],"publicationId":"publication-2"}
```

Valid order reservation:

```json
{"schemaVersion":1,"reservationType":"npc_reaction_orders","preconditionNextCreatedOrder":3,"eventCreatedOrders":[3],"commitResultCreatedAtOrder":4,"resultingNextCreatedOrder":5,"preconditionNextPublicationSlotOrder":1,"publicationSlotOrder":1,"resultingNextPublicationSlotOrder":2,"preconditionNextRecordAppendOrder":1,"publicationRecordAppendOrder":1,"resultingNextRecordAppendOrder":2,"priorClaimCount":0,"priorEventCount":1}
```

Valid snapshot skeleton with an exact committed trigger/input/event graph:

```json
{"schemaVersion":1,"snapshotType":"npc_reaction_preparation","gameSessionId":"game-session-1","turnId":"turn-1","turnOrder":1,"currentPhase":"player_question","currentStateVersion":2,"logicalReaction":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","turnId":"turn-1","turnOrder":1,"preconditionPhase":"player_question","preconditionStateVersion":2,"npcId":"npc-aoi","status":"active"},"winningAttempt":{"schemaVersion":1,"reactionPlanId":"reaction-plan-1","reactionAttemptId":"reaction-attempt-1","status":"validated"},"triggeringCommitResult":{"schemaVersion":1,"requestId":"player-request-1","correlationId":"player-correlation-1","requestFingerprint":"1111111111111111111111111111111111111111111111111111111111111111","commitType":"player_conversation","preconditionStateVersion":1,"resultingStateVersion":2,"inputRecordId":"input-1","displayPlanId":"display-1","playerPublicationId":"publication-1","createdEventIds":["event-1"],"createdClaimIds":[],"createdAtOrder":2},"originatingInputRecord":{"schemaVersion":1,"inputRecordId":"input-1","requestId":"player-request-1","correlationId":"player-correlation-1","turnId":"turn-1","capturedStateVersion":1,"actorId":"player","rawText":"Aoiはどう思う？","locale":"ja-JP","createdOrder":0},"triggeringEvents":[{"schemaVersion":1,"eventId":"event-1","requestId":"player-request-1","turnId":"turn-1","actorId":"player","causationId":"input-1","correlationId":"player-correlation-1","idempotencyKey":"2222222222222222222222222222222222222222222222222222222222222222","source":{"sourceType":"player_accepted_act","acceptedSpeechActId":"act-1","inputRecordId":"input-1","requestId":"player-request-1"},"stateVersion":2,"occurredPhase":"day_discussion","createdOrder":1,"eventType":"public_question_recorded","targetId":"npc-aoi","topic":"opinion"}],"currentRoster":[{"participantId":"npc-aoi","participantClass":"npc","publicStatus":"alive"},{"participantId":"npc-beni","participantClass":"npc","publicStatus":"alive"},{"participantId":"player","participantClass":"player","publicStatus":"alive"}],"actorApplicability":{"schemaVersion":1,"presence":"present","actorId":"npc-aoi","alive":true,"maySpeak":true},"currentAuthorization":{"schemaVersion":1,"availability":"available","actorId":"npc-aoi","roleDisclosurePolicy":"avoid_unnecessary_claim","allowedClaimRoles":[],"authorizedResultFacts":[]},"currentTargetIds":["npc-beni"],"existingClaims":[],"existingEvents":[{"schemaVersion":1,"eventId":"event-1","requestId":"player-request-1","turnId":"turn-1","actorId":"player","causationId":"input-1","correlationId":"player-correlation-1","idempotencyKey":"2222222222222222222222222222222222222222222222222222222222222222","source":{"sourceType":"player_accepted_act","acceptedSpeechActId":"act-1","inputRecordId":"input-1","requestId":"player-request-1"},"stateVersion":2,"occurredPhase":"day_discussion","createdOrder":1,"eventType":"public_question_recorded","targetId":"npc-aoi","topic":"opinion"}],"nextOrderEvidence":{"nextCreatedOrder":3,"nextPublicationSlotOrder":1,"nextRecordAppendOrder":1},"occupiedArtifactIds":["act-1","display-1","event-1","game-session-1","input-1","publication-1","reaction-attempt-1","reaction-plan-1","reaction-request-1","turn-1"]}
```

Valid preparation input uses a strict validation-success value and a self-contained no-causation-event variant of the snapshot/allocation/reservation contracts above (`priorEventCount: 0`):

```json
{"schemaVersion":1,"validatedCandidate":{"schemaVersion":1,"binding":{"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","reactionAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","turnId":"turn-1","turnOrder":1,"preconditionPhase":"player_question","preconditionStateVersion":2,"npcId":"npc-aoi"},"candidate":{"schemaVersion":1,"proposals":[{"proposalType":"suspicion","targetId":"npc-beni"}]},"candidateFingerprint":"895b02e355f391fc91c247d42891cecbebc0b40fa3773f8e47325b2544444ecb","validationContext":{"projectionFingerprint":"4444444444444444444444444444444444444444444444444444444444444444","roleDisclosurePolicy":"avoid_unnecessary_claim","permissionResult":"allowed","finalApplicabilityResult":"applicable"}},"preparationSnapshot":{"schemaVersion":1,"snapshotType":"npc_reaction_preparation","gameSessionId":"game-session-1","turnId":"turn-1","turnOrder":1,"currentPhase":"player_question","currentStateVersion":2,"logicalReaction":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","turnId":"turn-1","turnOrder":1,"preconditionPhase":"player_question","preconditionStateVersion":2,"npcId":"npc-aoi","status":"active"},"winningAttempt":{"schemaVersion":1,"reactionPlanId":"reaction-plan-1","reactionAttemptId":"reaction-attempt-1","status":"validated"},"triggeringCommitResult":{"schemaVersion":1,"requestId":"player-request-1","correlationId":"player-correlation-1","requestFingerprint":"1111111111111111111111111111111111111111111111111111111111111111","commitType":"player_conversation","preconditionStateVersion":1,"resultingStateVersion":2,"inputRecordId":"input-1","displayPlanId":"display-1","playerPublicationId":"publication-1","createdEventIds":[],"createdClaimIds":[],"createdAtOrder":1},"originatingInputRecord":{"schemaVersion":1,"inputRecordId":"input-1","requestId":"player-request-1","correlationId":"player-correlation-1","turnId":"turn-1","capturedStateVersion":1,"actorId":"player","rawText":"Aoiはどう思う？","locale":"ja-JP","createdOrder":0},"triggeringEvents":[],"currentRoster":[{"participantId":"npc-aoi","participantClass":"npc","publicStatus":"alive"},{"participantId":"npc-beni","participantClass":"npc","publicStatus":"alive"},{"participantId":"player","participantClass":"player","publicStatus":"alive"}],"actorApplicability":{"schemaVersion":1,"presence":"present","actorId":"npc-aoi","alive":true,"maySpeak":true},"currentAuthorization":{"schemaVersion":1,"availability":"available","actorId":"npc-aoi","roleDisclosurePolicy":"avoid_unnecessary_claim","allowedClaimRoles":[],"authorizedResultFacts":[]},"currentTargetIds":["npc-beni"],"existingClaims":[],"existingEvents":[],"nextOrderEvidence":{"nextCreatedOrder":2,"nextPublicationSlotOrder":1,"nextRecordAppendOrder":1},"occupiedArtifactIds":["game-session-1","input-1","publication-1","reaction-attempt-1","reaction-plan-1","reaction-request-1","turn-1"]},"artifactAllocation":{"schemaVersion":1,"allocationType":"npc_reaction_artifacts","descriptorIds":["desc-1"],"claimAllocations":[],"eventIds":["event-2"],"segmentIds":["segment-1"],"publicationId":"publication-2"},"orderReservation":{"schemaVersion":1,"reservationType":"npc_reaction_orders","preconditionNextCreatedOrder":2,"eventCreatedOrders":[2],"commitResultCreatedAtOrder":3,"resultingNextCreatedOrder":4,"preconditionNextPublicationSlotOrder":1,"publicationSlotOrder":1,"resultingNextPublicationSlotOrder":2,"preconditionNextRecordAppendOrder":1,"publicationRecordAppendOrder":1,"resultingNextRecordAppendOrder":2,"priorClaimCount":0,"priorEventCount":0}}
```

The following five values are complete NpcReactionPreparedResult examples for role-claim-only, result-claim-only, vote-only, suspicion-only, and mixed-proposal preparation, in that order. Each value includes the exact plan, artifacts, zero effects, allocation/order evidence, expected result, idempotency reservation, and deterministically verified preparation fingerprint:

```json
[{"schemaVersion":1,"status":"prepared","value":{"schemaVersion":1,"preparationType":"canonical_npc_reaction","delta":{"schemaVersion":1,"commitType":"npc_reaction","resultMode":"canonical_only","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","turnId":"turn-1","turnOrder":1,"preconditionPhase":"player_question","preconditionStateVersion":2,"npcId":"npc-aoi"},"requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","candidateFingerprint":"4e903df998bd84901093699d36f69c19cfcffab6fa5a257c19587e8ad1c11545","projectionFingerprint":"4444444444444444444444444444444444444444444444444444444444444444","preconditionPhase":"player_question","resultingPhase":"player_question","preconditionStateVersion":2,"resultingStateVersion":3,"plan":{"schemaVersion":1,"requestId":"reaction-request-1","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","locale":"ja-JP","causationEventIds":[],"reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","turnId":"turn-1","preconditionStateVersion":2,"resultingStateVersion":3,"npcId":"npc-aoi","renderMode":"canonical_only","intendedSpeechActs":[{"descriptorId":"case-1-descriptor-1","descriptorType":"role_claim","claimedRole":"seer"}],"policies":{"policyType":"reaction_policies","allowStateChanges":true,"allowClaims":true,"allowVoteDeclaration":false,"allowSuspicionUpdate":false,"allowMemoryUpdate":false},"canonicalSegments":[{"segmentId":"case-1-segment-1","descriptorId":"case-1-descriptor-1","type":"canonical_claim","claimId":"case-1-claim-1"}],"maxChars":1000},"claims":[{"schemaVersion":1,"claimId":"case-1-claim-1","claimRevision":1,"actorId":"npc-aoi","source":{"sourceType":"npc_reaction","reactionPlanId":"reaction-plan-1","descriptorId":"case-1-descriptor-1","originatingInputRecordId":"input-1","reactionCommitRequestId":"reaction-request-1"},"idempotencyKey":"310c04c4e8b82559ea548ac75bf729092bac2b9c9f56e55c73ce7b08e22a2540","createdTurnId":"turn-1","createdStateVersion":3,"repeatsClaimId":null,"contradictsClaimIds":[],"status":"asserted","type":"role_claim","claimedRole":"seer"}],"events":[{"schemaVersion":1,"eventId":"case-1-event-1","requestId":"reaction-request-1","turnId":"turn-1","actorId":"npc-aoi","causationId":"player-request-1","correlationId":"correlation-1","idempotencyKey":"c59048e555c1b6e81fbb727e3a123afb27d03eb874eb6c17f5be734cf9b0529b","source":{"sourceType":"npc_reaction","reactionPlanId":"reaction-plan-1","descriptorId":"case-1-descriptor-1","originatingInputRecordId":"input-1","reactionCommitRequestId":"reaction-request-1"},"stateVersion":3,"occurredPhase":"player_question","createdOrder":2,"eventType":"role_claim_recorded","claimId":"case-1-claim-1"}],"publication":{"schemaVersion":1,"recordType":"npc_canonical_published","publicationId":"case-1-publication","reactionPlanId":"reaction-plan-1","reactionCommitRequestId":"reaction-request-1","originatingInputRecordId":"input-1","correlationId":"correlation-1","turnId":"turn-1","reactionResultingStateVersion":3,"actorId":"npc-aoi","locale":"ja-JP","canonicalRendererVersion":1,"canonicalSegmentIds":["case-1-segment-1"],"publicationSlotOrder":1,"recordAppendOrder":1},"effects":{"suspicionScoreUpdates":[],"memoryUpdates":[],"legacyPublicHistoryEntries":[],"voteStateUpdates":[],"phaseTransitions":[]},"artifactAllocation":{"schemaVersion":1,"allocationType":"npc_reaction_artifacts","descriptorIds":["case-1-descriptor-1"],"claimAllocations":[{"proposalIndex":0,"claimId":"case-1-claim-1"}],"eventIds":["case-1-event-1"],"segmentIds":["case-1-segment-1"],"publicationId":"case-1-publication"},"orderReservation":{"schemaVersion":1,"reservationType":"npc_reaction_orders","preconditionNextCreatedOrder":2,"eventCreatedOrders":[2],"commitResultCreatedAtOrder":3,"resultingNextCreatedOrder":4,"preconditionNextPublicationSlotOrder":1,"publicationSlotOrder":1,"resultingNextPublicationSlotOrder":2,"preconditionNextRecordAppendOrder":1,"publicationRecordAppendOrder":1,"resultingNextRecordAppendOrder":2,"priorClaimCount":0,"priorEventCount":0},"expectedCommitResult":{"schemaVersion":1,"requestId":"reaction-request-1","correlationId":"correlation-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","commitType":"npc_reaction","preconditionStateVersion":2,"resultingStateVersion":3,"reactionPlanId":"reaction-plan-1","npcPublicationId":"case-1-publication","createdEventIds":["case-1-event-1"],"createdClaimIds":["case-1-claim-1"],"createdAtOrder":3,"resultMode":"canonical_only"},"idempotencyReservation":{"schemaVersion":1,"requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","preparationFingerprint":"11f631540601d7a54500d0e19de74432163acf7a599d054f1f89d2eacda4de5a"},"preparationFingerprint":"11f631540601d7a54500d0e19de74432163acf7a599d054f1f89d2eacda4de5a"},"preparationFingerprint":"11f631540601d7a54500d0e19de74432163acf7a599d054f1f89d2eacda4de5a"}},{"schemaVersion":1,"status":"prepared","value":{"schemaVersion":1,"preparationType":"canonical_npc_reaction","delta":{"schemaVersion":1,"commitType":"npc_reaction","resultMode":"canonical_only","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","turnId":"turn-1","turnOrder":1,"preconditionPhase":"player_question","preconditionStateVersion":2,"npcId":"npc-aoi"},"requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","candidateFingerprint":"95c2e3914fe7999880bb140314a20bba16c48d29b1ed8ae911ca7b9fa4ae3656","projectionFingerprint":"4444444444444444444444444444444444444444444444444444444444444444","preconditionPhase":"player_question","resultingPhase":"player_question","preconditionStateVersion":2,"resultingStateVersion":3,"plan":{"schemaVersion":1,"requestId":"reaction-request-1","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","locale":"ja-JP","causationEventIds":[],"reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","turnId":"turn-1","preconditionStateVersion":2,"resultingStateVersion":3,"npcId":"npc-aoi","renderMode":"canonical_only","intendedSpeechActs":[{"descriptorId":"case-2-descriptor-1","descriptorType":"result_claim","targetId":"npc-beni","result":"werewolf"}],"policies":{"policyType":"reaction_policies","allowStateChanges":true,"allowClaims":true,"allowVoteDeclaration":false,"allowSuspicionUpdate":false,"allowMemoryUpdate":false},"canonicalSegments":[{"segmentId":"case-2-segment-1","descriptorId":"case-2-descriptor-1","type":"canonical_claim","claimId":"case-2-claim-1"}],"maxChars":1000},"claims":[{"schemaVersion":1,"claimId":"case-2-claim-1","claimRevision":1,"actorId":"npc-aoi","source":{"sourceType":"npc_reaction","reactionPlanId":"reaction-plan-1","descriptorId":"case-2-descriptor-1","originatingInputRecordId":"input-1","reactionCommitRequestId":"reaction-request-1"},"idempotencyKey":"ad8cfecfaad120c03dc667bdeac40872e8c0953ede115800fc4ad9079cdc4f77","createdTurnId":"turn-1","createdStateVersion":3,"repeatsClaimId":null,"contradictsClaimIds":[],"status":"asserted","type":"result_claim","targetId":"npc-beni","result":"werewolf"}],"events":[{"schemaVersion":1,"eventId":"case-2-event-1","requestId":"reaction-request-1","turnId":"turn-1","actorId":"npc-aoi","causationId":"player-request-1","correlationId":"correlation-1","idempotencyKey":"6d2a25b5d80ade0f5817783b9be35b05226744100be7768fea116fbf83f8b55c","source":{"sourceType":"npc_reaction","reactionPlanId":"reaction-plan-1","descriptorId":"case-2-descriptor-1","originatingInputRecordId":"input-1","reactionCommitRequestId":"reaction-request-1"},"stateVersion":3,"occurredPhase":"player_question","createdOrder":2,"eventType":"result_claim_recorded","claimId":"case-2-claim-1"}],"publication":{"schemaVersion":1,"recordType":"npc_canonical_published","publicationId":"case-2-publication","reactionPlanId":"reaction-plan-1","reactionCommitRequestId":"reaction-request-1","originatingInputRecordId":"input-1","correlationId":"correlation-1","turnId":"turn-1","reactionResultingStateVersion":3,"actorId":"npc-aoi","locale":"ja-JP","canonicalRendererVersion":1,"canonicalSegmentIds":["case-2-segment-1"],"publicationSlotOrder":1,"recordAppendOrder":1},"effects":{"suspicionScoreUpdates":[],"memoryUpdates":[],"legacyPublicHistoryEntries":[],"voteStateUpdates":[],"phaseTransitions":[]},"artifactAllocation":{"schemaVersion":1,"allocationType":"npc_reaction_artifacts","descriptorIds":["case-2-descriptor-1"],"claimAllocations":[{"proposalIndex":0,"claimId":"case-2-claim-1"}],"eventIds":["case-2-event-1"],"segmentIds":["case-2-segment-1"],"publicationId":"case-2-publication"},"orderReservation":{"schemaVersion":1,"reservationType":"npc_reaction_orders","preconditionNextCreatedOrder":2,"eventCreatedOrders":[2],"commitResultCreatedAtOrder":3,"resultingNextCreatedOrder":4,"preconditionNextPublicationSlotOrder":1,"publicationSlotOrder":1,"resultingNextPublicationSlotOrder":2,"preconditionNextRecordAppendOrder":1,"publicationRecordAppendOrder":1,"resultingNextRecordAppendOrder":2,"priorClaimCount":0,"priorEventCount":0},"expectedCommitResult":{"schemaVersion":1,"requestId":"reaction-request-1","correlationId":"correlation-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","commitType":"npc_reaction","preconditionStateVersion":2,"resultingStateVersion":3,"reactionPlanId":"reaction-plan-1","npcPublicationId":"case-2-publication","createdEventIds":["case-2-event-1"],"createdClaimIds":["case-2-claim-1"],"createdAtOrder":3,"resultMode":"canonical_only"},"idempotencyReservation":{"schemaVersion":1,"requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","preparationFingerprint":"36e09ac7d649aa0b0c9b9c0211231b674290e0101cb405a160a3dcf66c3fded8"},"preparationFingerprint":"36e09ac7d649aa0b0c9b9c0211231b674290e0101cb405a160a3dcf66c3fded8"},"preparationFingerprint":"36e09ac7d649aa0b0c9b9c0211231b674290e0101cb405a160a3dcf66c3fded8"}},{"schemaVersion":1,"status":"prepared","value":{"schemaVersion":1,"preparationType":"canonical_npc_reaction","delta":{"schemaVersion":1,"commitType":"npc_reaction","resultMode":"canonical_only","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","turnId":"turn-1","turnOrder":1,"preconditionPhase":"player_question","preconditionStateVersion":2,"npcId":"npc-aoi"},"requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","candidateFingerprint":"d592ff34640fa5447302b92f670171750de8a4593870af192130074784854c5d","projectionFingerprint":"4444444444444444444444444444444444444444444444444444444444444444","preconditionPhase":"player_question","resultingPhase":"player_question","preconditionStateVersion":2,"resultingStateVersion":3,"plan":{"schemaVersion":1,"requestId":"reaction-request-1","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","locale":"ja-JP","causationEventIds":[],"reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","turnId":"turn-1","preconditionStateVersion":2,"resultingStateVersion":3,"npcId":"npc-aoi","renderMode":"canonical_only","intendedSpeechActs":[{"descriptorId":"case-3-descriptor-1","descriptorType":"vote_declaration","targetId":"npc-cyan"}],"policies":{"policyType":"reaction_policies","allowStateChanges":true,"allowClaims":false,"allowVoteDeclaration":true,"allowSuspicionUpdate":false,"allowMemoryUpdate":false},"canonicalSegments":[{"segmentId":"case-3-segment-1","descriptorId":"case-3-descriptor-1","type":"canonical_vote","voteEventId":"case-3-event-1"}],"maxChars":1000},"claims":[],"events":[{"schemaVersion":1,"eventId":"case-3-event-1","requestId":"reaction-request-1","turnId":"turn-1","actorId":"npc-aoi","causationId":"player-request-1","correlationId":"correlation-1","idempotencyKey":"fc2b94ff27b7866a033db1990eaa1d0c704137ffcf49433100cd7ce562c4e220","source":{"sourceType":"npc_reaction","reactionPlanId":"reaction-plan-1","descriptorId":"case-3-descriptor-1","originatingInputRecordId":"input-1","reactionCommitRequestId":"reaction-request-1"},"stateVersion":3,"occurredPhase":"player_question","createdOrder":2,"eventType":"vote_declared","targetId":"npc-cyan"}],"publication":{"schemaVersion":1,"recordType":"npc_canonical_published","publicationId":"case-3-publication","reactionPlanId":"reaction-plan-1","reactionCommitRequestId":"reaction-request-1","originatingInputRecordId":"input-1","correlationId":"correlation-1","turnId":"turn-1","reactionResultingStateVersion":3,"actorId":"npc-aoi","locale":"ja-JP","canonicalRendererVersion":1,"canonicalSegmentIds":["case-3-segment-1"],"publicationSlotOrder":1,"recordAppendOrder":1},"effects":{"suspicionScoreUpdates":[],"memoryUpdates":[],"legacyPublicHistoryEntries":[],"voteStateUpdates":[],"phaseTransitions":[]},"artifactAllocation":{"schemaVersion":1,"allocationType":"npc_reaction_artifacts","descriptorIds":["case-3-descriptor-1"],"claimAllocations":[],"eventIds":["case-3-event-1"],"segmentIds":["case-3-segment-1"],"publicationId":"case-3-publication"},"orderReservation":{"schemaVersion":1,"reservationType":"npc_reaction_orders","preconditionNextCreatedOrder":2,"eventCreatedOrders":[2],"commitResultCreatedAtOrder":3,"resultingNextCreatedOrder":4,"preconditionNextPublicationSlotOrder":1,"publicationSlotOrder":1,"resultingNextPublicationSlotOrder":2,"preconditionNextRecordAppendOrder":1,"publicationRecordAppendOrder":1,"resultingNextRecordAppendOrder":2,"priorClaimCount":0,"priorEventCount":0},"expectedCommitResult":{"schemaVersion":1,"requestId":"reaction-request-1","correlationId":"correlation-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","commitType":"npc_reaction","preconditionStateVersion":2,"resultingStateVersion":3,"reactionPlanId":"reaction-plan-1","npcPublicationId":"case-3-publication","createdEventIds":["case-3-event-1"],"createdClaimIds":[],"createdAtOrder":3,"resultMode":"canonical_only"},"idempotencyReservation":{"schemaVersion":1,"requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","preparationFingerprint":"05c18027a3720dd7b8f8a65f1613881dbaa5e8a1365fbe9039707ddd1000a4bf"},"preparationFingerprint":"05c18027a3720dd7b8f8a65f1613881dbaa5e8a1365fbe9039707ddd1000a4bf"},"preparationFingerprint":"05c18027a3720dd7b8f8a65f1613881dbaa5e8a1365fbe9039707ddd1000a4bf"}},{"schemaVersion":1,"status":"prepared","value":{"schemaVersion":1,"preparationType":"canonical_npc_reaction","delta":{"schemaVersion":1,"commitType":"npc_reaction","resultMode":"canonical_only","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","turnId":"turn-1","turnOrder":1,"preconditionPhase":"player_question","preconditionStateVersion":2,"npcId":"npc-aoi"},"requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","candidateFingerprint":"1711403d1daf5450be599ff9103ed5b1ad2c198d94d9ef1a590baa5bca214b8f","projectionFingerprint":"4444444444444444444444444444444444444444444444444444444444444444","preconditionPhase":"player_question","resultingPhase":"player_question","preconditionStateVersion":2,"resultingStateVersion":3,"plan":{"schemaVersion":1,"requestId":"reaction-request-1","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","locale":"ja-JP","causationEventIds":[],"reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","turnId":"turn-1","preconditionStateVersion":2,"resultingStateVersion":3,"npcId":"npc-aoi","renderMode":"canonical_only","intendedSpeechActs":[{"descriptorId":"case-4-descriptor-1","descriptorType":"suspicion","targetId":"npc-dai"}],"policies":{"policyType":"reaction_policies","allowStateChanges":true,"allowClaims":false,"allowVoteDeclaration":false,"allowSuspicionUpdate":true,"allowMemoryUpdate":false},"canonicalSegments":[{"segmentId":"case-4-segment-1","descriptorId":"case-4-descriptor-1","type":"canonical_suspicion","suspicionEventId":"case-4-event-1"}],"maxChars":1000},"claims":[],"events":[{"schemaVersion":1,"eventId":"case-4-event-1","requestId":"reaction-request-1","turnId":"turn-1","actorId":"npc-aoi","causationId":"player-request-1","correlationId":"correlation-1","idempotencyKey":"5d2230d1789c1ec3bdd0d1ffd410e4b1f451ffdd32834dd730796410af4788a8","source":{"sourceType":"npc_reaction","reactionPlanId":"reaction-plan-1","descriptorId":"case-4-descriptor-1","originatingInputRecordId":"input-1","reactionCommitRequestId":"reaction-request-1"},"stateVersion":3,"occurredPhase":"player_question","createdOrder":2,"eventType":"suspicion_expressed","targetId":"npc-dai"}],"publication":{"schemaVersion":1,"recordType":"npc_canonical_published","publicationId":"case-4-publication","reactionPlanId":"reaction-plan-1","reactionCommitRequestId":"reaction-request-1","originatingInputRecordId":"input-1","correlationId":"correlation-1","turnId":"turn-1","reactionResultingStateVersion":3,"actorId":"npc-aoi","locale":"ja-JP","canonicalRendererVersion":1,"canonicalSegmentIds":["case-4-segment-1"],"publicationSlotOrder":1,"recordAppendOrder":1},"effects":{"suspicionScoreUpdates":[],"memoryUpdates":[],"legacyPublicHistoryEntries":[],"voteStateUpdates":[],"phaseTransitions":[]},"artifactAllocation":{"schemaVersion":1,"allocationType":"npc_reaction_artifacts","descriptorIds":["case-4-descriptor-1"],"claimAllocations":[],"eventIds":["case-4-event-1"],"segmentIds":["case-4-segment-1"],"publicationId":"case-4-publication"},"orderReservation":{"schemaVersion":1,"reservationType":"npc_reaction_orders","preconditionNextCreatedOrder":2,"eventCreatedOrders":[2],"commitResultCreatedAtOrder":3,"resultingNextCreatedOrder":4,"preconditionNextPublicationSlotOrder":1,"publicationSlotOrder":1,"resultingNextPublicationSlotOrder":2,"preconditionNextRecordAppendOrder":1,"publicationRecordAppendOrder":1,"resultingNextRecordAppendOrder":2,"priorClaimCount":0,"priorEventCount":0},"expectedCommitResult":{"schemaVersion":1,"requestId":"reaction-request-1","correlationId":"correlation-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","commitType":"npc_reaction","preconditionStateVersion":2,"resultingStateVersion":3,"reactionPlanId":"reaction-plan-1","npcPublicationId":"case-4-publication","createdEventIds":["case-4-event-1"],"createdClaimIds":[],"createdAtOrder":3,"resultMode":"canonical_only"},"idempotencyReservation":{"schemaVersion":1,"requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","preparationFingerprint":"c1469d46a3b84c40a481f1accb54b8b3c77fea09ad04d5c9587a192c54c9b605"},"preparationFingerprint":"c1469d46a3b84c40a481f1accb54b8b3c77fea09ad04d5c9587a192c54c9b605"},"preparationFingerprint":"c1469d46a3b84c40a481f1accb54b8b3c77fea09ad04d5c9587a192c54c9b605"}},{"schemaVersion":1,"status":"prepared","value":{"schemaVersion":1,"preparationType":"canonical_npc_reaction","delta":{"schemaVersion":1,"commitType":"npc_reaction","resultMode":"canonical_only","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","turnId":"turn-1","turnOrder":1,"preconditionPhase":"player_question","preconditionStateVersion":2,"npcId":"npc-aoi"},"requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","candidateFingerprint":"1cfca839da621a22ff0693a63479bdee9f5d16aa2bb5a8d2469546ace7352e3c","projectionFingerprint":"4444444444444444444444444444444444444444444444444444444444444444","preconditionPhase":"player_question","resultingPhase":"player_question","preconditionStateVersion":2,"resultingStateVersion":3,"plan":{"schemaVersion":1,"requestId":"reaction-request-1","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","locale":"ja-JP","causationEventIds":[],"reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","turnId":"turn-1","preconditionStateVersion":2,"resultingStateVersion":3,"npcId":"npc-aoi","renderMode":"canonical_only","intendedSpeechActs":[{"descriptorId":"case-5-descriptor-1","descriptorType":"role_claim","claimedRole":"seer"},{"descriptorId":"case-5-descriptor-2","descriptorType":"result_claim","targetId":"npc-beni","result":"werewolf"},{"descriptorId":"case-5-descriptor-3","descriptorType":"vote_declaration","targetId":"npc-cyan"},{"descriptorId":"case-5-descriptor-4","descriptorType":"suspicion","targetId":"npc-dai"}],"policies":{"policyType":"reaction_policies","allowStateChanges":true,"allowClaims":true,"allowVoteDeclaration":true,"allowSuspicionUpdate":true,"allowMemoryUpdate":false},"canonicalSegments":[{"segmentId":"case-5-segment-1","descriptorId":"case-5-descriptor-1","type":"canonical_claim","claimId":"case-5-claim-1"},{"segmentId":"case-5-segment-2","descriptorId":"case-5-descriptor-2","type":"canonical_claim","claimId":"case-5-claim-2"},{"segmentId":"case-5-segment-3","descriptorId":"case-5-descriptor-3","type":"canonical_vote","voteEventId":"case-5-event-3"},{"segmentId":"case-5-segment-4","descriptorId":"case-5-descriptor-4","type":"canonical_suspicion","suspicionEventId":"case-5-event-4"}],"maxChars":1000},"claims":[{"schemaVersion":1,"claimId":"case-5-claim-1","claimRevision":1,"actorId":"npc-aoi","source":{"sourceType":"npc_reaction","reactionPlanId":"reaction-plan-1","descriptorId":"case-5-descriptor-1","originatingInputRecordId":"input-1","reactionCommitRequestId":"reaction-request-1"},"idempotencyKey":"66d782aad50b756239ac7b7b0f2562dcb7500b2afb3177d99d65931fae9ea010","createdTurnId":"turn-1","createdStateVersion":3,"repeatsClaimId":null,"contradictsClaimIds":[],"status":"asserted","type":"role_claim","claimedRole":"seer"},{"schemaVersion":1,"claimId":"case-5-claim-2","claimRevision":1,"actorId":"npc-aoi","source":{"sourceType":"npc_reaction","reactionPlanId":"reaction-plan-1","descriptorId":"case-5-descriptor-2","originatingInputRecordId":"input-1","reactionCommitRequestId":"reaction-request-1"},"idempotencyKey":"cecfb3d7dc47c388893d221b6c26e681242adc9b542301fc3a697efb617cfd9d","createdTurnId":"turn-1","createdStateVersion":3,"repeatsClaimId":null,"contradictsClaimIds":[],"status":"asserted","type":"result_claim","targetId":"npc-beni","result":"werewolf"}],"events":[{"schemaVersion":1,"eventId":"case-5-event-1","requestId":"reaction-request-1","turnId":"turn-1","actorId":"npc-aoi","causationId":"player-request-1","correlationId":"correlation-1","idempotencyKey":"7e44edff71893fa12de91130f81d379f7babc9f4a79580829e5638217de72da8","source":{"sourceType":"npc_reaction","reactionPlanId":"reaction-plan-1","descriptorId":"case-5-descriptor-1","originatingInputRecordId":"input-1","reactionCommitRequestId":"reaction-request-1"},"stateVersion":3,"occurredPhase":"player_question","createdOrder":2,"eventType":"role_claim_recorded","claimId":"case-5-claim-1"},{"schemaVersion":1,"eventId":"case-5-event-2","requestId":"reaction-request-1","turnId":"turn-1","actorId":"npc-aoi","causationId":"player-request-1","correlationId":"correlation-1","idempotencyKey":"99cc1393d7ebbbf5a2e4aa2857c2fcba352797cf6a4ded9893b2007233e43f62","source":{"sourceType":"npc_reaction","reactionPlanId":"reaction-plan-1","descriptorId":"case-5-descriptor-2","originatingInputRecordId":"input-1","reactionCommitRequestId":"reaction-request-1"},"stateVersion":3,"occurredPhase":"player_question","createdOrder":3,"eventType":"result_claim_recorded","claimId":"case-5-claim-2"},{"schemaVersion":1,"eventId":"case-5-event-3","requestId":"reaction-request-1","turnId":"turn-1","actorId":"npc-aoi","causationId":"player-request-1","correlationId":"correlation-1","idempotencyKey":"a06198ce355e5cdd4ee87af7714748f870dfa3424166dcd4169ab700d068a2c5","source":{"sourceType":"npc_reaction","reactionPlanId":"reaction-plan-1","descriptorId":"case-5-descriptor-3","originatingInputRecordId":"input-1","reactionCommitRequestId":"reaction-request-1"},"stateVersion":3,"occurredPhase":"player_question","createdOrder":4,"eventType":"vote_declared","targetId":"npc-cyan"},{"schemaVersion":1,"eventId":"case-5-event-4","requestId":"reaction-request-1","turnId":"turn-1","actorId":"npc-aoi","causationId":"player-request-1","correlationId":"correlation-1","idempotencyKey":"6172df43b7b25bdae0dd0507bc5063abbfdc72fe71b22a95a639dbca21624f28","source":{"sourceType":"npc_reaction","reactionPlanId":"reaction-plan-1","descriptorId":"case-5-descriptor-4","originatingInputRecordId":"input-1","reactionCommitRequestId":"reaction-request-1"},"stateVersion":3,"occurredPhase":"player_question","createdOrder":5,"eventType":"suspicion_expressed","targetId":"npc-dai"}],"publication":{"schemaVersion":1,"recordType":"npc_canonical_published","publicationId":"case-5-publication","reactionPlanId":"reaction-plan-1","reactionCommitRequestId":"reaction-request-1","originatingInputRecordId":"input-1","correlationId":"correlation-1","turnId":"turn-1","reactionResultingStateVersion":3,"actorId":"npc-aoi","locale":"ja-JP","canonicalRendererVersion":1,"canonicalSegmentIds":["case-5-segment-1","case-5-segment-2","case-5-segment-3","case-5-segment-4"],"publicationSlotOrder":1,"recordAppendOrder":1},"effects":{"suspicionScoreUpdates":[],"memoryUpdates":[],"legacyPublicHistoryEntries":[],"voteStateUpdates":[],"phaseTransitions":[]},"artifactAllocation":{"schemaVersion":1,"allocationType":"npc_reaction_artifacts","descriptorIds":["case-5-descriptor-1","case-5-descriptor-2","case-5-descriptor-3","case-5-descriptor-4"],"claimAllocations":[{"proposalIndex":0,"claimId":"case-5-claim-1"},{"proposalIndex":1,"claimId":"case-5-claim-2"}],"eventIds":["case-5-event-1","case-5-event-2","case-5-event-3","case-5-event-4"],"segmentIds":["case-5-segment-1","case-5-segment-2","case-5-segment-3","case-5-segment-4"],"publicationId":"case-5-publication"},"orderReservation":{"schemaVersion":1,"reservationType":"npc_reaction_orders","preconditionNextCreatedOrder":2,"eventCreatedOrders":[2,3,4,5],"commitResultCreatedAtOrder":6,"resultingNextCreatedOrder":7,"preconditionNextPublicationSlotOrder":1,"publicationSlotOrder":1,"resultingNextPublicationSlotOrder":2,"preconditionNextRecordAppendOrder":1,"publicationRecordAppendOrder":1,"resultingNextRecordAppendOrder":2,"priorClaimCount":0,"priorEventCount":0},"expectedCommitResult":{"schemaVersion":1,"requestId":"reaction-request-1","correlationId":"correlation-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","commitType":"npc_reaction","preconditionStateVersion":2,"resultingStateVersion":3,"reactionPlanId":"reaction-plan-1","npcPublicationId":"case-5-publication","createdEventIds":["case-5-event-1","case-5-event-2","case-5-event-3","case-5-event-4"],"createdClaimIds":["case-5-claim-1","case-5-claim-2"],"createdAtOrder":6,"resultMode":"canonical_only"},"idempotencyReservation":{"schemaVersion":1,"requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","preparationFingerprint":"13c781950502c019d7cf20e704f9ddb49d1ee089403a23fb68f5e8de65ffa81b"},"preparationFingerprint":"13c781950502c019d7cf20e704f9ddb49d1ee089403a23fb68f5e8de65ffa81b"},"preparationFingerprint":"13c781950502c019d7cf20e704f9ddb49d1ee089403a23fb68f5e8de65ffa81b"}}]
```

Normative rejection examples:

For status/actor reachability, start from the valid preparation input above and change only the named current evidence: set `logicalReaction.status` to any non-`active` closed value for `logical_reaction_mismatch`; with logical `active`, set `winningAttempt.status` to any non-`validated` closed value for `attempt_mismatch`; or remove `npc-aoi` from `currentRoster`, replace `actorApplicability` with exactly `{ "schemaVersion": 1, "presence": "absent", "actorId": "npc-aoi", "absenceReason": "removed_from_roster" }`, and replace `currentAuthorization` with exactly `{ "schemaVersion": 1, "availability": "unavailable", "actorId": "npc-aoi", "reason": "actor_absent" }` for `actor_ineligible`. Present/dead changes only `publicStatus` and `actorApplicability.alive`; present/unable changes only `maySpeak`. Unknown statuses, a roster/applicability disagreement, an actor/authorization availability disagreement, or duplicate actor IDs are invariant inputs instead.

```json
[{"schemaVersion":1,"status":"rejected","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","correlationId":"correlation-1","turnId":"turn-1","preconditionStateVersion":2,"npcId":"npc-aoi"},"rejection":{"stage":"applicability","reasonCode":"stale_state_version","retryable":false,"diagnostics":[{"code":"stale_state_version","location":"state_version"}]}},{"schemaVersion":1,"status":"rejected","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","correlationId":"correlation-1","turnId":"turn-1","preconditionStateVersion":2,"npcId":"npc-aoi"},"rejection":{"stage":"allocation","reasonCode":"artifact_id_collision","retryable":false,"diagnostics":[{"code":"artifact_id_collision","location":"artifact_allocation"}]}},{"schemaVersion":1,"status":"rejected","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","correlationId":"correlation-1","turnId":"turn-1","preconditionStateVersion":9007199254740991,"npcId":"npc-aoi"},"rejection":{"stage":"ordering","reasonCode":"state_version_exhausted","retryable":false,"diagnostics":[{"code":"state_version_exhausted","location":"state_version"}]}},{"schemaVersion":1,"status":"rejected","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","correlationId":"correlation-1","turnId":"turn-1","preconditionStateVersion":2,"npcId":"npc-aoi"},"rejection":{"stage":"applicability","reasonCode":"logical_reaction_mismatch","retryable":false,"diagnostics":[{"code":"logical_reaction_mismatch","location":"logical_reaction"}]}},{"schemaVersion":1,"status":"rejected","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","correlationId":"correlation-1","turnId":"turn-1","preconditionStateVersion":2,"npcId":"npc-aoi"},"rejection":{"stage":"applicability","reasonCode":"attempt_mismatch","retryable":false,"diagnostics":[{"code":"attempt_mismatch","location":"attempt"}]}},{"schemaVersion":1,"status":"rejected","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","correlationId":"correlation-1","turnId":"turn-1","preconditionStateVersion":2,"npcId":"npc-aoi"},"rejection":{"stage":"authorization","reasonCode":"actor_ineligible","retryable":false,"diagnostics":[{"code":"actor_ineligible","location":"actor"}]}}]
```

Invariant errors are runtime errors, not JSON result members. Example: malformed allocation with duplicate IDs throws `NpcReactionPreparationInvariantError` with `code == "duplicate_engine_id"` and the fixed redacted message.

#### Explicit preparation/commit boundary

This preparation contract constructs an expected result and an uncommitted idempotency reservation but performs none of the commit operations below. The following Authoritative Commit Contract closes idempotency lookup, replay priority, final CAS, atomic insertion/application order, rollback, lifecycle/tombstone ordering, compatibility-route replacement, and `N+1 -> N+2`. Neither contract connects a prepared value to production; runtime implementation remains a later separately reviewed stage.

### Authoritative NPC reaction commit

This subsection is normative for initial Phase 6 canonical-only commit. It defines how one previously prepared value may become authoritative. It does not implement preparation, commit, replay, coordinator/tombstone runtime, provider routing, delivery, Renderer, or any Phase 7/8/9 behavior.

#### Commit audit closure matrix

| Commit contract | Existing authority | Runtime evidence | Exact pre-change gap | Contract closed here |
| :--- | :--- | :--- | :--- | :--- |
| replay lookup | section 6A and reaction identity prose | player replay by request/fingerprint | no reaction lookup/result union | exact pre-provider lookup and stored-graph verification |
| idempotency record | preparation reservation only | player idempotency records | no committed reaction record/index | strict reaction record, separate registry, shared uniqueness constraints |
| commit API | none | internal player commit method | no reaction entrypoint/input/result | one synchronous internal entrypoint and closed unions |
| final CAS | section 6A prose | Phase 4 live checks | incomplete dimension/order list | exact current-state dimensions and first-failure order |
| atomic apply | copy-on-write requirement | `_workingCopy()` plus one `commitState()` | no reaction graph apply order | detached graph stages, validation, one root publication |
| lifecycle | reaction state-machine prose | foundation status validators | no commit outcome transition matrix | exact attempt/logical terminal classification |
| tombstone | bounded registry prose | none | capacity could fail after commit | provider-before terminal-slot reservation and strict tombstone union |
| publication ownership | canonical publication prose | shared publication registry | transaction boundary incomplete | exactly one same-transaction canonical publication |
| legacy replacement | section 6A principle | provisional Phase 4 reaction transaction | replacement call site not closed | route-fixed replacement at the same `N+1 -> N+2` ledger position |

#### Authority and exact entrypoints

Only the active browser- or CLI-process `WerewolfGame` that owns the session may commit. The server, provider, browser/CLI adapter, publication sink, history reader, observer, tombstone, caller snapshot, and prepared value are not authorities. Immediately before commit, `WerewolfGame` rereads its current authoritative root; supplied preparation evidence never substitutes for current truth.

The one internal commit entrypoint is:

```js
_commitPreparedNpcReaction(input)
```

It is synchronous and returns `NpcReactionCommitExecutionResult`. It is not a public browser/CLI API and cannot be called directly by a server, provider, adapter, sink, or observer. From input reconstruction through authoritative root publication it performs no `await`, provider/network operation, timer, callback, observer, DOM/CLI write, Renderer work, or event-loop yield. No external code executes after final CAS begins and before the root is published.

`NpcReactionCommitInput` requires exactly `schemaVersion: 1` and `preparedReaction: PreparedCanonicalNpcReaction`; it has no optional/null fields and `additionalProperties: false`. Commit reconstructs a detached value, recalculates the preparation fingerprint, requires outer/delta/idempotency-reservation fingerprint equality, and shares no caller-owned reference. Raw candidate, provider body, preparation snapshot, current state, lifecycle state, or registry is forbidden in the input. Indexes are read only from the owning `WerewolfGame`; current state, active logical reaction, winning attempt, and terminal-slot reservation are read only if lookup proves that a new commit path is required.

The pre-provider read-only entrypoint is:

```js
_lookupNpcReactionCommitReplay(input)
```

It is synchronous and returns `NpcReactionCommitReplayLookupResult`. It never validates a candidate, prepares, allocates an ID/order, advances a counter/version, mutates lifecycle/state, appends a publication, delivers, or reopens a terminal operation.

#### Pre-provider replay lookup contract

`NpcReactionCommitReplayLookupInput` requires exactly `schemaVersion: 1`, `gameSessionId`, `reactionPlanId`, `requestId`, `requestFingerprint`, `correlationId`, `causationId`, `originatingInputRecordId`, `turnId`, `turnOrder`, `preconditionPhase`, `preconditionStateVersion`, and `npcId`. IDs/fingerprint/phase use existing types; integers are safe and non-negative. It has no optional/null fields and `additionalProperties: false`.

`NpcReactionCommitReplayLookupResult` is the strict union:

- `not_found`: exactly `{ schemaVersion: 1, status: "not_found" }`.
- `replayed`: exactly `{ schemaVersion: 1, status: "replayed", result: CanonicalNpcReactionCommitResult }`.
- `conflict`: exactly `{ schemaVersion: 1, status: "conflict", conflictCode: NpcReactionCommitLookupConflictCode }`.

`NpcReactionCommitLookupConflictCode` is `idempotency_conflict | identity_conflict`. A primary-key/request-fingerprint disagreement is `idempotency_conflict`; any request/plan/trigger/attempt alias disagreement is `identity_conflict`. Exact replay is resolved before current phase/version stale checks and remains valid after later unrelated transactions, provided the complete stored graph is intact. It returns a detached recursively frozen stored result and never rebuilds from current locale, renderer version, roster, tombstone, or display state.

The replay trace is exact:

| Lookup evidence | Index | Stored graph checked | Outcome | Mutation |
| :--- | :--- | :--- | :--- | :---: |
| no primary record and no alias | reaction primary plus secondary uniqueness | none | `not_found` | 0 |
| exact primary/request identity | primary reaction index | plan, result, publication, claims, events, segments, idempotency record | `replayed` | 0 |
| exact primary, different request fingerprint | primary reaction index | no stale/CAS work | `conflict/idempotency_conflict` | 0 |
| request, plan, trigger, or attempt alias | secondary uniqueness indexes | no stale/CAS work | `conflict/identity_conflict` | 0 |
| primary exists but committed graph is corrupt | all authoritative registries | complete integrity check | throw `corrupt_committed_reaction_graph` | 0 |

#### Committed idempotency record and indexes

`NpcReactionCommitIdempotencyRecord` requires exactly `schemaVersion: 1`, `recordType: "npc_reaction_commit_idempotency"`, `gameSessionId`, `reactionPlanId`, `requestId`, `requestFingerprint`, `preparationFingerprint`, `successfulAttemptId`, `correlationId`, `causationId`, `originatingInputRecordId`, `turnId`, `turnOrder`, `npcId`, `preconditionStateVersion`, `resultingStateVersion`, `npcPublicationId`, and `commitResultRequestId`.

It has no optional/null fields and `additionalProperties: false`. All identity fields use `ID`; both fingerprints use `Sha256Fingerprint`; order/version values are safe non-negative integers; resulting version is precondition plus one; `commitResultRequestId == requestId`. Plan, result, publication, successful attempt, request, version, and origin identities resolve exactly in the stored graph. It has no separate record ID and stores no candidate/projection fingerprint, provider metadata/body, private projection/fact, display/rendered text, policy payload, or diagnostic.

The authoritative reaction primary key is `(gameSessionId, reactionPlanId, requestId)` with exact `requestFingerprint`. Reaction records use a separate `npcReactionCommitIdempotencyRecords` registry because the existing player idempotency record has a different exact schema. Separation does not permit request reuse: one shared session-scoped request-identity uniqueness index covers player and reaction result/idempotency registries. The commit-result registry key is `(gameSessionId, requestId)`; inside the session-scoped state root this is physically the unique `requestId`. No new commit-result payload or schema version is introduced.

The transaction enforces these logical indexes together:

1. reaction primary `(gameSessionId, reactionPlanId, requestId)`;
2. shared session request ID uniqueness;
3. session reaction-plan ID uniqueness;
4. initial one-reaction trigger `(gameSessionId, causationId, originatingInputRecordId, npcId)`;
5. successful-attempt-to-committed-plan uniqueness;
6. artifact-ID-to-object uniqueness;
7. commit-result `(gameSessionId, requestId)`;
8. reaction-plan and canonical-publication registries.

Same primary with different request or preparation fingerprint is `idempotency_conflict`. Same request/different plan, same plan/different request, same trigger/different logical reaction, same attempt/different plan, same publication/different reaction, or same artifact ID/different object is `identity_conflict`. Only a byte-for-byte canonical-equal committed graph is replay. Pre-provider lookup has no preparation fingerprint, so it proves request identity plus stored graph integrity; a final-commit race additionally requires the stored preparation fingerprint to equal the supplied prepared value.

Replay trusts no idempotency record in isolation. It resolves exactly one `NpcReactionPlan`, `CanonicalNpcReactionCommitResult`, `NpcCanonicalUtterancePublishedRecord`, every created claim/event/segment, the successful attempt identity stored by the authoritative graph, and all request/correlation/causation/origin/turn/actor/version/fingerprint/order identities. Missing, dangling, duplicate, or mismatched authoritative data throws `corrupt_committed_reaction_graph`; it never returns replay/conflict. Tombstones and terminal-slot reservations are not replay authority. A complete authoritative graph replays after active cleanup, without a reservation, at `N+2` or any later current version. A missing tombstone does not reject or downgrade replay and replay never creates one; cleanup repair is a separate idempotent control operation. A structurally corrupt tombstone registry is a control-plane invariant but does not negate the authoritative committed graph. Replay allocates/publishes/increments nothing and never reopens or mutates lifecycle.

#### Commit result and failure contracts

`NpcReactionCommitExecutionResult` is exactly:

- committed: `{ schemaVersion: 1, status: "committed", result: CanonicalNpcReactionCommitResult }`;
- replayed: `{ schemaVersion: 1, status: "replayed", result: CanonicalNpcReactionCommitResult }`;
- rejected: `{ schemaVersion: 1, status: "rejected", binding: NpcReactionCommitRejectionBinding, rejection: NpcReactionCommitRejection }`.

Every member has no optional/null fields and `additionalProperties: false`. Committed/replayed results have the same shape; replay changes no authoritative/lifecycle/counter/publication state.

`NpcReactionCommitRejectionBinding` requires exactly `schemaVersion: 1`, `gameSessionId`, `reactionPlanId`, `successfulAttemptId`, `requestId`, `correlationId`, `turnId`, `preconditionStateVersion`, and `npcId`, copied from reconstructed engine-owned preparation evidence. `NpcReactionCommitRejection` requires exactly `stage`, `reasonCode`, `retryable: false`, and `diagnostics`. Diagnostics are dense `NpcReactionCommitDiagnostic[0..8]`, each exactly `{ code, location }`; there is no message/free-form path/body/private fact/role/team/policy/provider/stack/prepared graph.

Stages are `idempotency | applicability | authorization | allocation | ordering | integrity | application`. Locations are `idempotency_record | identity_index | session | turn | phase | state_version | logical_reaction | attempt | actor | target | reference | policy | known_information | artifact_allocation | order_reservation`. Initial Phase 6 emits no ordinary rejection at `application`; application failures are invariant errors.

| Active reason code | Stage/location | Exact first reachable vector |
| :--- | :--- | :--- |
| `idempotency_conflict` | `idempotency/idempotency_record` | existing primary/request record has a different request or preparation fingerprint |
| `identity_conflict` | `idempotency/identity_index` | request/plan/trigger/publication/attempt/artifact alias conflicts with another owner |
| `stale_session` | `applicability/session` | no replay/conflict; current session differs or is destroyed |
| `stale_turn` | `applicability/turn` | session matches; current turn ID/order differs |
| `stale_phase` | `applicability/phase` | turn matches; current phase differs |
| `stale_state_version` | `applicability/state_version` | phase matches; current version differs from prepared `N+1` |
| `logical_reaction_mismatch` | `applicability/logical_reaction` | immutable binding/trigger matches but active logical identity/status is not exact `active` |
| `attempt_mismatch` | `applicability/attempt` | logical reaction is active but winning attempt identity/status is not exact `validated` |
| `actor_ineligible` | `authorization/actor` | actor is removed, dead, or cannot speak |
| `target_ineligible` | `authorization/target` | referenced target is removed/reclassified or fails kind-specific life eligibility |
| `invalid_reference` | `authorization/reference` | triggering result/input/event or referenced prior claim/event no longer resolves exactly |
| `permission_denied` | `authorization/policy` | current disclosure policy no longer authorizes a role/result proposal |
| `result_fact_mismatch` | `authorization/known_information` | no exact current actor-owned target/result pair authorizes the result claim |
| `artifact_id_collision` | `allocation/artifact_allocation` | a prepared artifact ID is now occupied by a different object |
| `order_precondition_mismatch` | `ordering/order_reservation` | any captured next-created/publication-slot/record-append value differs |
| `state_version_exhausted` | `ordering/state_version` | current precondition is `Number.MAX_SAFE_INTEGER` |
| `order_exhausted` | `ordering/order_reservation` | a required counter addition exceeds safe-integer range |

The first row that applies ends evaluation and later diagnostics are not added. All rejected results preserve authoritative state/version/counters exactly and terminalize only through the lifecycle table below.

`NpcReactionCommitInvariantError` has exact `name: "NpcReactionCommitInvariantError"`, fixed message `Invalid NPC reaction commit operation.`, and exactly one `code`; it stores no cause, raw value, free-form path, provider data, or additional field. Closed codes are `invalid_commit_input | unsupported_commit_schema | invalid_prepared_reaction | preparation_fingerprint_mismatch | invalid_commit_delta | corrupt_committed_reaction_graph | invalid_idempotency_record | invalid_authoritative_registry | invalid_terminal_slot_reservation | invalid_committed_tombstone_attempt_summary | invalid_non_commit_tombstone_attempt_summary | terminal_lifecycle_graph_mismatch | invalid_canonical_publication_counter_state | commit_application_failure | working_copy_validation_failure`. Malformed engine input, corrupt stored graphs/registries, impossible prepared graphs, a missing/foreign reservation on the new-commit or active-terminalization path, impossible terminal lifecycle/tombstone combinations, canonical-counter corruption, and internal application failure throw; expected current-state mismatch returns the closed rejection union. Replay/conflict after successful cleanup does not require a reservation and therefore cannot throw `invalid_terminal_slot_reservation` merely because cleanup released it.

#### Terminal-slot reservation and tombstone union

`NpcReactionCoordinatorControlRoot` is the one complete session-local, nonauthoritative control root. It requires exactly `schemaVersion: 1`, `gameSessionId: ID`, `nextTerminalOrder: safe integer >= 0`, `logicalReactions`, `reactionAttempts`, `terminalSlotReservations`, and `reactionTombstones`; no optional/null/extra fields and `additionalProperties: false`. All four registries are runtime-private maps. Every control-plane mutation constructs a detached copy, validates the complete graph, and replaces this root exactly once. Separate live instance fields or a five-field ledger-only root for logical reactions, attempts, reservations, or tombstones are forbidden.

Server, provider, authoritative state, public snapshot, history, browser/CLI sink, preparation input, and candidate-validation input neither own nor contain this root. It is not protected by `stateVersion`, persisted, reconstructed, or replay authority. An observer may receive only a separately contracted redacted terminal outcome. Reset destroys the root and all coordinator-owned timers, backoff, and abort handles rather than reusing any member.

`logicalReactions` is keyed by `reactionPlanId` and contains strict `NpcReactionCoordinatorLogicalReaction` values. Each value requires exactly `schemaVersion: 1`, `gameSessionId: ID`, `reactionPlanId: ID`, `requestId: ID`, `requestFingerprint: Sha256Fingerprint`, `correlationId: ID`, `causationId: ID`, `originatingInputRecordId: ID`, `turnId: ID`, `turnOrder: safe integer >= 0`, `preconditionPhase: GamePhase`, `preconditionStateVersion: safe integer >= 0`, `npcId: ID`, `routeSnapshot: NpcReactionRouteSnapshot`, `projectionFingerprint: Sha256Fingerprint`, `status: LogicalReactionStatus`, `attemptIds: unique ID[0..maxAttempts]`, `createdAt: RFC3339Utc`, and `retryPolicy: NpcReactionRetryPolicySnapshot`; no optional/null/extra fields. `NpcReactionRouteSnapshot` is exactly `{ schemaVersion: 1, route: "structured" | "legacy" }`. `NpcReactionRetryPolicySnapshot` requires exactly `schemaVersion: 1`, `maxAttempts: safe integer >= 1`, `backoffDelaysMs: safe-integer[0..maxAttempts-1]` with every value non-negative, and `logicalDeadlineMs: safe integer >= 1`; it is captured once and immutable. Request/correlation/trigger/actor/turn/base/route/policy bindings never change during the logical lifetime; feature-flag changes do not rewrite the route; `attemptIds` is creation order; `planned` permits zero attempts. Raw candidate/provider body/private projection payload is forbidden; any necessary private working projection remains detached runtime-only evidence outside history/public output.

`reactionAttempts` is keyed by `reactionAttemptId` and contains the exact strict `PendingNpcReactionAttempt` contract. Each key equals its value ID; its `reactionPlanId` resolves exactly one logical entry; it appears exactly once at the matching position in that logical entry's `attemptIds`; all request/fingerprint/correlation/trigger/turn/actor fields equal the logical binding; status is `ReactionAttemptStatus`; retries use fresh attempt IDs under the same logical identity; and at most one winning attempt exists. Terminal attempts may remain until terminalization, but raw provider body/candidate is never retained. Logical and attempt registries are never mutated separately.

The control-root validator proves only root shape and internal references: the root session equals every entry; all map keys equal their value identities and are unique; terminal orders are unique across reservation and tombstone registries; one reaction plan ID has only a compatible logical/reservation/tombstone ownership combination; every planned or active logical entry owns exactly one reservation; planned/active request IDs are unique; the ordered `attemptIds` list equals the attempt-registry owner set; every attempt has one logical owner; tombstoned reactions have no logical/attempt/reservation entry; reservation and tombstone never coexist; capacity counts only reservations plus tombstones; logical/attempt counts do not consume the 1024 bound; and all status combinations follow the existing 7-by-8 lifecycle matrix. A separate cross-root lifecycle validator compares this internally valid control root with the current authoritative graph. `active + validated + reservation + no tombstone` is an ordinary commit candidate only when no authoritative committed graph exists; when the exact authoritative committed graph exists, the same unchanged control shape is derived cleanup-pending evidence and permits replay or cleanup only. A partially published `committed` logical or `accepted` attempt that remains beside a reservation is an impossible control graph, never cleanup-pending. Every impossible combination is a coordinator invariant.

`NpcReactionPlanIdentityCollisionProjection` is engine-owned strict evidence with exactly `schemaVersion: 1`, `gameSessionId: ID`, and `occupiedReactionPlanIds: unique ID[]` in ASCII lexical order. The engine synchronously builds it from every current authoritative owner: reaction plans, NPC reaction idempotency records, NPC commit results, NPC publication records, and any other strict authoritative registry containing `reactionPlanId`. Multiple records for the same committed reaction collapse to one set member. Provider/caller input, raw state exposure, public snapshot, and history are forbidden. Completeness is an engine invariant; the current authoritative session and projection are rechecked immediately before control-root publication. The allocated plan ID is also checked against logical, reservation, and tombstone IDs in the current control root. Tombstone eviction never permits reuse while the authoritative committed graph owns the ID.

New logical creation is one **complete planned logical-reaction creation transaction**; standalone terminal-slot allocation/publication is abolished. Its strict result is either a created member containing the complete planned logical value and matching reservation, or `{ schemaVersion: 1, status: "rejected", reasonCode: "terminal_capacity_exhausted" | "terminal_order_exhausted" }`; the exact runtime API remains coordinator-internal. The operation order is: (1) recheck current authoritative session and triggering player commit; (2) validate the current control root; (3) clone it; (4) select but do not evict the unique minimum-order tombstone if capacity requires; (5) reject terminal-order exhaustion; (6) reject all-reservation capacity; (7) build/validate the authoritative plan-ID projection; (8) allocate reaction plan ID; (9) allocate request ID; (10) allocate correlation ID; (11) check all session-wide plan/request/correlation/trigger/origin/actor/route collisions; (12) capture immutable route; (13) construct exact player-trigger binding; (14) build the detached private projection; (15) compute projection/request fingerprints; (16) construct the complete `planned` logical entry; (17) construct its exact reservation with the same plan ID/current terminal order; (18) evict the selected tombstone only on the detached copy; (19) insert the logical entry; (20) insert the reservation; (21) increment `nextTerminalOrder` exactly once; (22) validate the complete control graph and recheck current authoritative session/projection; and (23) replace the control root once. Attempt creation/provider work begins only afterward; no callback, observer, provider, timer, or event-loop yield occurs before replacement.

Capacity remains `reactionTombstones.size + terminalSlotReservations.size <= 1024`. Reservations are never evicted. If all 1024 entries are reservations, `terminal_capacity_exhausted` occurs before any ID/projection/provider work. If `nextTerminalOrder == Number.MAX_SAFE_INTEGER`, `terminal_order_exhausted` occurs before ID allocation or live eviction. Otherwise an at-capacity creation stages exactly one minimum-order tombstone eviction in the same detached copy as logical/reservation insertion. The eviction becomes visible only with successful root replacement. Successful complete planned creation alone consumes terminal order.

Engine-owned secure ID allocator exception/collision is `terminal_identity_collision`; there is no silent retry. Reaction plan IDs use the complete authoritative projection above plus all control-root registries. Request IDs are checked against authoritative NPC plans, reaction idempotency records, NPC commit results, reaction publication `reactionCommitRequestId` fields, logical reactions, and tombstones. Correlation IDs are checked against those authoritative reaction-owned records plus logical reactions and tombstones. Trigger uniqueness is checked against committed player result/input identity and the authoritative reaction trigger index; originating input, actor, and route must form the exact same trigger binding and cannot alias another logical reaction. Any ID, route, trigger, projection, fingerprint, logical/reservation construction, graph validation, or root-replacement failure publishes logical insert `0`, attempt insert `0`, reservation insert `0`, tombstone eviction `0`, terminal-order increment `0`, observer/provider/timer work `0`, and authoritative/version mutation `0`. An orphan reservation without its planned logical entry is `invalid_terminal_registry`.

`NpcReactionCoordinatorInvariantError` is synchronous and redacted, is never a planned-creation rejected result, and has exact `name: "NpcReactionCoordinatorInvariantError"`, fixed message `Invalid NPC reaction coordinator state.`, and one closed code: `invalid_coordinator_state | coordinator_session_mismatch | terminal_identity_collision | invalid_terminal_registry`. It stores no raw registry value, candidate, provider body, private fact, free-form path, nested cause, or extra field. Wrong/missing field, unsafe/negative counter, incomplete authoritative collision projection, duplicate/cross-registry identity, wrong session, malformed logical/attempt/reservation/tombstone, allocator failure/collision, impossible lifecycle, or impossible capacity is invariant failure; only well-shaped all-reservation capacity or safe-integer exhaustion returns the rejected union.

Attempt creation is a later separate transaction on the same control root: validate root; resolve exact planned/active logical entry; check retry/attempt/deadline policy; allocate and collision-check one fresh attempt ID; construct the strict attempt; append its ID to the logical order; transition `planned -> active` when needed; insert the attempt; validate the full graph; replace the root once; then and only then call the provider. Failure publishes no attempt/observer/provider work, no root mutation, no terminal-order change, and no new reservation.

The reservation requires exactly `schemaVersion: 1`, `reservationType: "reaction_terminal_slot"`, `gameSessionId: ID`, `reactionPlanId: ID`, `terminalOrder: safe integer >= 0`, and `status: "reserved"`; no optional/null/extra fields. Its planned or active logical reaction exclusively owns it. It is published only with the complete planned logical entry, is nonauthoritative, changes version by zero, is never history/observer data, is never selected for capacity eviction, and is destroyed on reset. A successful first complete creation uses terminal order `0`, a successful second uses `1`, and so on; failure/replay/lookup/attempt/cleanup produces no counter gap. Cleanup-pending does not change this shape: it is inferred only when the exact authoritative committed graph exists while the published control root still contains this pre-terminalization active logical/attempt/reservation graph.

Capacity is always `reactionTombstones.size + terminalSlotReservations.size <= 1024`. At capacity, the oldest tombstone by minimum `terminalOrder` is the only evictable entry; reservations are never evicted. If at least one tombstone exists, exactly one oldest tombstone is evicted atomically only with successful complete planned-logical creation. If all 1024 entries are reservations, creation returns `terminal_capacity_exhausted`. Terminalization converts the exact reservation into exactly one tombstone using the same terminal order, in one control-root replacement, so conversion does not change capacity or `nextTerminalOrder`. The commit entrypoint does **not** inspect this reservation at stage 0. Only after primary replay and every stored alias conflict are absent may the ordinary new-commit path require: one reservation exists; the expected plan and session own it; status is `reserved`; terminal order is unique; capacity still holds; and no tombstone duplicates its reaction/terminal identity. Missing, foreign, duplicate, malformed, or capacity-inconsistent reservation on that path is `invalid_terminal_slot_reservation`. An active conflict terminalization uses the same exact owned reservation, but classification precedes that control-plane operation. Exact replay and conflict for an already-terminal reaction require no reservation, do not recreate/release one, do not increment terminal order, and accept its normal absence after cleanup.

`ReactionTombstoneAttemptSummary` is a strict union. Common fields are `schemaVersion: 1`, `reactionAttemptId`, and terminal `status: "accepted" | "failed" | "timed_out" | "rejected" | "aborted"`; `attempting`, `candidate_received`, and `validated` are forbidden. The `observation: "none"` member forbids a fingerprint; the `observation: "fingerprinted"` member additionally requires `candidateFingerprint: Sha256Fingerprint`. Attempt IDs are unique, summaries include every observed attempt exactly once in attempt-creation order, the sequence is bounded by configured `maxAttempts`, and no summary contains a raw candidate, provider body, or private projection.

`ReactionTombstone` is the union below. Common fields are `schemaVersion: 1`, `gameSessionId`, `reactionPlanId`, `requestId`, `requestFingerprint`, `correlationId`, `causationId`, `originatingInputRecordId`, `npcId`, `preconditionStateVersion`, `terminalOrder`, and `attempts: ReactionTombstoneAttemptSummary[0..maxAttempts]`.

- committed member requires `tombstoneType: "committed"`, `terminalStatus: "committed"`, `successfulAttemptId`, `preparationFingerprint`, `npcPublicationId`, and `commitResultRequestId`; its summaries contain exactly one entry whose ID equals `successfulAttemptId` and whose status is `accepted`, and no other entry is `accepted`;
- non-commit member requires `tombstoneType: "non_commit"`, `terminalStatus: "rejected" | "superseded" | "cancelled" | "exhausted"`, and `reason: "identity_conflict" | "stale_applicability" | "authorization_failure" | "allocation_failure" | "ordering_failure" | "retry_exhausted" | "cancelled" | "internal_failure"`.

Members have no optional/null/extra fields. They contain no raw candidate/provider body/projection/private fact/display/rendered text/sink/DOM/stack. A non-commit member contains zero `accepted` summaries and forbids every committed-only field. A committed tombstone missing its successful summary, using a non-accepted winning summary, or containing multiple accepted summaries throws `invalid_committed_tombstone_attempt_summary`; a non-commit member containing an accepted/nonterminal summary, duplicate ID, missing observed attempt, or creation-order violation throws `invalid_non_commit_tombstone_attempt_summary`. A committed tombstone is only a lookup hint: replay must verify authoritative plan/result/publication. Non-commit tombstones never reconstruct authority.

Authoritative reaction commit and coordinator cleanup are separate copy-on-write transactions over separate roots. Stage 21 publishes the authoritative reaction plan, claims, semantic events, canonical publication, idempotency record, commit result, counters, and `N+1 -> N+2` exactly once. Once that root replacement succeeds, no coordinator failure rolls it back or changes the stored commit result to failure. Stage 22 then performs coordinator cleanup; it has authoritative mutation and version increment zero.

`commit_cleanup_pending` is not a persisted enum, logical/attempt status, record type, diagnostic, or schema member. It is a runtime-private cross-root condition derived only when the complete authoritative committed graph and the unchanged pre-terminalization coordinator graph both exist for the same reaction. The authoritative side must resolve one mutually consistent `NpcReactionPlan`, `NpcReactionCommitIdempotencyRecord`, `CanonicalNpcReactionCommitResult`, `NpcCanonicalUtterancePublishedRecord`, every result-referenced claim/event, every plan-referenced segment, and the exact request ID/fingerprint, reaction plan ID, successful attempt ID, correlation, causation, originating input, actor, and precondition/resulting versions. The coordinator side must retain the matching `active` logical entry, its owned reservation, its exact `validated` winning attempt, every required nonwinning attempt in creation order, and no tombstone. Session, plan, request/fingerprint, correlation, causation, origin, actor, and successful-attempt identities must match across roots. This condition is never stored in authoritative state or exposed through public snapshot, history, provider, sink, Renderer, delivery controller, or observer payload.

The authoritative graph always wins over the stale pre-terminalization control statuses. While the cross-root condition holds, the reaction is already committed and cannot start another provider attempt, validate another candidate, prepare or commit again, recreate a reservation, reselect its route, fall back to legacy, reopen the logical reaction, or schedule timeout/retry provider work. Evaluation order is: (1) exact authoritative replay or stored conflict; (2) coordinator-owned cleanup repair when independently invoked; and only when no authoritative committed graph exists, (3) ordinary lifecycle applicability. Replay never performs cleanup implicitly.

Coordinator cleanup is one synchronous, session-local, nonauthoritative control-root transaction owned only by the NPC reaction coordinator. Provider, server, browser/CLI sink, Renderer, delivery controller, history consumer, observer, and replay caller cannot execute it. Before staging, it verifies the current session; complete authoritative graph and idempotency record; exact plan/result/publication; successful attempt ID; current control root; matching logical entry, reservation, winning attempt, request/fingerprint/correlation/causation/origin/actor identities; absence of a tombstone; and presence of every cleanup-owned attempt. Missing/corrupt authoritative evidence throws the existing authoritative graph invariant; missing/corrupt control evidence throws the coordinator invariant. Neither becomes an ordinary rejection result.

On a detached copy cleanup (1) resolves the exact logical entry; (2) resolves its reservation; (3) resolves the exact successful attempt; (4) rechecks every cross-root identity; (5) stages only that winning attempt as `accepted`; (6) preserves already-terminal nonwinning statuses and stages every nonterminal nonwinner as `aborted`; (7) stages logical `committed`; (8) constructs unique terminal attempt summaries in attempt-creation order; (9) constructs the committed tombstone with exactly one accepted summary and the reservation's terminal order; (10) inserts it; (11) removes the reservation; (12) removes the logical entry; (13) removes all its attempt entries; (14) validates the complete detached root; and (15) replaces the control root exactly once. Only afterward may step 16 notify the redacted observer. No live status, registry, capacity, or terminal-order field changes before step 15. Any failure through step 15 preserves the old root byte-for-byte: logical remains `active`, winner remains `validated`, each nonwinner retains its prior status, reservation and all entries remain, tombstone remains absent, and `nextTerminalOrder`/capacity are unchanged. Partial mutation followed by manual rollback is prohibited.

`NpcReactionControlCleanupResult` is a runtime-private strict union. Its cleaned member is exactly `{ schemaVersion: 1, status: "cleaned", reactionPlanId: ID, terminalOrder: safe integer >= 0 }`; its already-cleaned member has the same fields with `status: "already_cleaned"`. No field is optional/null and `additionalProperties` is false. It duplicates no authoritative result, provider/private/rendered value, or state version and is never a public/history/provider response. The first successful replacement returns `cleaned`. A repeat while the exact committed tombstone remains and logical/attempt/reservation entries are all absent returns `already_cleaned` with mutation and observer notification zero. A tombstone coexisting with any active entry, or active entries without their reservation, is an invariant error with mutation zero. Tombstone eviction ends addressable cleanup-result retention; authoritative replay remains valid and does not reconstruct it.

The failure boundary is exact:

| Failure point | Authoritative root | Control root | Tombstone | Reservation | Observer |
| :--- | :--- | :--- | ---: | :--- | :--- |
| before authoritative root publish | `N+1` | pre-commit | 0 | retained | 0 |
| authoritative publish success | `N+2` | pre-terminalization old root | 0 | retained | 0 |
| cleanup working-copy construction failure | `N+2` | unchanged old root | 0 | retained | 0 |
| cleanup validation failure | `N+2` | unchanged old root | 0 | retained | 0 |
| cleanup root replacement failure | `N+2` | unchanged old root | 0 | retained | 0 |
| cleanup root replacement success | `N+2` | cleaned root | 1 | removed | after publish |
| observer failure | `N+2` | cleaned root | retained | removed | isolated |

If observer notification fails after replacement, the tombstone and removals remain final and cleanup is not repeated. Reset during cleanup pending aborts/stales old-session work, destroys the entire old control root and its cleanup retry, and creates a new-session empty root at terminal order `0`; it never transfers or repairs the old authoritative graph in the new session.

The terminal summary matrix is exact:

| Logical terminal status | Permitted attempt-summary statuses | Additional requirement |
| :--- | :--- | :--- |
| `committed` | `accepted | failed | timed_out | rejected | aborted` | committed member only; exactly one accepted and it is `successfulAttemptId` |
| `exhausted` | `failed | timed_out | rejected | aborted` | no accepted summary |
| `rejected` | `rejected | failed | aborted` | no accepted summary |
| `superseded` | `failed | timed_out | rejected | aborted` | the attempt active/winning when superseded is normalized to `aborted` |
| `cancelled` | `failed | timed_out | rejected | aborted` | every previously nonterminal attempt is normalized to `aborted` |

`cancelled` is the closed logical status corresponding to an aborted logical operation; there is no separate logical `aborted` member. Unknown status or any combination outside this matrix throws the applicable tombstone-summary invariant error without mutating lifecycle or authority.

#### Exact replay/CAS order and traces

The commit entrypoint executes exactly these stages:

0. strict commit-input/prepared-graph/schema/fingerprint/detached-reconstruction invariants, excluding all current lifecycle/reservation/state checks;
1. primary idempotency lookup;
2. exact committed graph replay verification;
3. request/plan/trigger/publication/attempt/artifact alias checks and, only after classification, active-conflict control-plane terminalization;
4. active terminal-slot reservation invariant, only for an ordinary new commit;
5. current session;
6. current turn ID/order;
7. current phase;
8. current state version;
9. triggering player result/origin input/causation graph;
10. logical reaction identity/status;
11. winning attempt identity/status;
12. actor roster/alive/speech eligibility;
13. target/reference current integrity;
14. current disclosure/result-fact authorization;
15. artifact collisions;
16. authoritative created/canonical-publication-slot/canonical-publication-record counter preconditions;
17. state-version/counter exhaustion;
18. complete prepared graph referential integrity;
19. detached authoritative working-copy construction;
20. complete working-copy validation;
21. exactly one authoritative root publication;
22. nonauthoritative lifecycle/tombstone finalization;
23. redacted observer notification.

Malformed input precedes lookup. Stage 0 never checks reservation existence/ownership/status, logical/attempt status, or current session/turn/phase/version. Exact replay and stored conflict precede reservation and stale checks and terminate without entering ordinary stages 4-23. Only `not_found` with no alias conflict proceeds to stage 4 and CAS. After stage-3 conflict classification, an active reaction may run the exact conflict terminalization sub-operation defined below inside the stage-3 exit; its reservation validation is control-plane finalization, not the ordinary new-commit stage-4 precondition. Already-terminal conflict returns directly with mutation zero. Final CAS failure mutates nothing. No external callback occurs before step 23. A first failure returns/throws immediately, later-stage diagnostics are not added, and no partial result is returned.

The CAS trace is normative:

| Step | Current source | Prepared evidence | Failure | Lifecycle outcome |
| ---: | :--- | :--- | :--- | :--- |
| 1-3 | idempotency/result/plan/publication/index registries | request, preparation, artifact identities | replay, conflict, or invariant corruption | replay/terminal conflict retain lifecycle; active conflict follows its terminalization row |
| 4 | coordinator terminal-slot registry | reaction/session/terminal identity | invariant throw only on new-commit or active-conflict terminalization path | no authoritative mutation |
| 5-8 | root session/turn/phase/version | binding and precondition | exact `stale_*` | attempt `aborted`, logical `superseded` |
| 9-11 | committed trigger graph and active coordinator | causation/origin/logical/attempt | reference/logical/attempt rejection | rejection-specific terminal row |
| 12-14 | current roster/rules/private actor-owned authorization | actor/target/claim descriptors | authorization rejection | attempt/logical `rejected` |
| 15-17 | occupied IDs, created counter, two canonical publication counters, and version | allocation/reservation/version arithmetic | allocation/ordering rejection | attempt `failed`, logical `rejected` |
| 18-20 | complete current graph and detached working copy | prepared delta/fingerprint | invariant throw | internal failure terminalization after discarding copy |
| 21 | current live root | fully validated working root | single synchronous replacement | authoritative `N+2` committed |
| 22-23 | complete authoritative graph plus pre-terminalization coordinator root / observer | exact cross-root identities and redacted outcome | cleanup failure retains old control root; observer failure retains cleaned root | authoritative commit remains committed |

Final CAS rereads and compares every dimension: session ID; turn ID/order; phase; state version; reaction plan; request ID/fingerprint; correlation; causation; originating input; triggering player result; logical identity/status; winning attempt identity/status; actor identity/roster/life/speech; every target identity/class/life eligibility; disclosure policy; actor-owned exact result facts; referenced input/claim/event identities; occupied artifact IDs; `nextCreatedOrder`; `state.conversation.nextPublicationSlotOrder`; `state.conversation.nextRecordAppendOrder`; trigger uniqueness index; and terminal-slot reservation. Preparation snapshot is evidence, never current truth. Delivery/Renderer/acknowledgement/UI counters are neither read nor compared.

#### Lifecycle and tombstone ordering

The lifecycle trace is exact:

| Commit outcome | Attempt status | Logical status | Tombstone | Active removal | Version |
| :--- | :--- | :--- | :--- | :--- | ---: |
| new commit, cleanup succeeds | `validated -> accepted` only on detached cleanup copy | `active -> committed` only on detached cleanup copy | committed | logical/all attempts/reservation removed in the same root replacement | authoritative stage 21 is exactly `N+1 -> N+2`; cleanup is 0 |
| new commit, cleanup fails | published status remains `validated` | published status remains `active` | none | none; reservation/logical/attempts all retained | authoritative `N+2` remains; cleanup is 0 |
| exact replay | retain existing | retain existing | unchanged, including missing | none; cleanup repair is separate | 0 |
| hard stale | `aborted` | `superseded` | non-commit `stale_applicability` | after tombstone | 0 |
| active identity/idempotency conflict | relevant nonterminal/validated attempt -> `rejected` | `active -> rejected` | one non-commit `identity_conflict` | reservation release and removal after tombstone | 0 |
| already-terminal identity/idempotency conflict | unchanged | unchanged | unchanged; no insert | none; no reopening/repair | 0 |
| authorization/reference failure | `rejected` | `rejected` | non-commit `authorization_failure` | after tombstone | 0 |
| allocation/order/exhaustion failure | `failed` | `rejected` | corresponding non-commit reason | after tombstone | 0 |
| malformed input invariant | unchanged | unchanged | none | none | 0 |
| application invariant after valid CAS input | coordinator normalizes attempt `failed` | logical `rejected` | non-commit `internal_failure` | after tombstone | 0; live root remains `N+1` |

Exact authoritative replay is decided before this lifecycle matrix and returns with mutation zero even during cleanup pending, after reservation release/entry removal, at a later version, or with a missing/evicted tombstone. Replay never invokes cleanup. A stored conflict against a complete authoritative graph also returns before ordinary control applicability and leaves the old cleanup-pending root byte-for-byte unchanged: it cannot reject the active logical, reject the validated winner, insert a tombstone, or release the reservation. With no authoritative graph and no stored conflict, only logical `active` plus winning attempt `validated` may create a new commit. Only an active reaction with no committed graph may use active-conflict terminalization. A terminal lifecycle state whose required authoritative graph or tombstone is missing/mismatched throws `terminal_lifecycle_graph_mismatch` and performs no lifecycle or authoritative mutation; missing tombstone alone after a complete authoritative commit is the explicit replay exception.

The complete 7-by-8 applicability matrix below applies after replay is `not_found`; `C` means ordinary commit is possible only without conflict (and active conflict uses terminalization), `A` means active conflict may terminalize but ordinary commit rejects, `P` means preserve lifecycle with no conflict-driven mutation, and `I` means an impossible lifecycle combination and `terminal_lifecycle_graph_mismatch`. A stored exact conflict result still precedes ordinary applicability classification.

| Logical status / relevant attempt | `attempting` | `candidate_received` | `validated` | `accepted` | `failed` | `timed_out` | `rejected` | `aborted` |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `planned` | I | I | I | I | I | I | I | I |
| `active` | A | A | C | I | P | P | P | P |
| `committed` | I | I | I | I | I | I | I | I |
| `rejected` | I | I | I | I | P | I | P | P |
| `superseded` | I | I | I | I | I | I | I | P |
| `cancelled` | I | I | I | I | I | I | I | P |
| `exhausted` | I | I | I | I | P | P | P | P |

`planned` legitimately has no attempt, so every cell in a matrix that assumes a relevant attempt is impossible. For `P` under logical `active`, absent conflict continues to the normal `attempt_mismatch` rejection without changing the pre-existing status. For terminal non-commit rows, a valid matching tombstone allows conflict or late input to return its already-classified result with mutation zero. A `committed` status after authoritative replay returned `not_found` is always a terminal graph mismatch, including `committed + accepted`; when its graph exists, stage 2 replays or stage 3 classifies conflict before this matrix. `committed -> rejected`, `exhausted -> rejected`, `superseded -> rejected`, and every other terminal-to-terminal overwrite are prohibited. The matrix classifies ordinary control state only after authoritative lookup: the same `active + validated` cell means ordinary commit candidate when the authoritative graph is absent, but cleanup pending and replay/cleanup-only when that graph is complete.

| Control status | Authoritative committed graph | Meaning | Allowed action |
| :--- | ---: | :--- | :--- |
| `active + validated` | no | ordinary commit candidate | commit path |
| `active + validated` | yes, complete | cleanup pending | exact replay or separate coordinator cleanup only |
| `committed + accepted` entries remain | yes | invalid partial control publication | invariant; mutation 0 |
| terminal tombstone and no logical/attempt/reservation entries | yes, complete | cleaned committed state | replay; cleanup retry returns `already_cleaned` while tombstone remains |
| `active + validated` | corrupt/incomplete | cross-root invariant | mutation 0 |

New commit ordering is: validate and publish the authoritative working graph; then run the coordinator cleanup transaction described above; then notify the observer. Active rejection/conflict uses a one-root non-commit terminalization only after authoritative lookup proves no committed graph. Exact replay/conflict against a committed graph changes no status, tombstone, reservation, logical, or attempt entry and never performs cleanup repair inline. Lifecycle/tombstone changes are nonauthoritative and increment zero. If post-publication cleanup fails, the authoritative root/result/idempotency/publication remain committed and the byte-identical pre-terminalization control root remains available for a separate coordinator-only idempotent cleanup retry. Observer notification is last, redacted, and isolated; its exception changes no stored terminal state.

#### Atomic graph, copy-on-write, and publication

One canonical commit transaction contains exactly one `CanonicalOnlyReactionPlan`, `CanonicalClaim[0..4]`, `PublicEvent[1..16]`, one `NpcCanonicalUtterancePublishedRecord`, one `NpcReactionCommitIdempotencyRecord`, one `CanonicalNpcReactionCommitResult`, exact zero suspicion/memory/legacy-history/vote/phase deltas, three counter updates, and one state-version update. Every created object uses resulting `N+2`; object count never changes the one increment.

The atomic graph trace is exact:

| Artifact/index/counter | Working-copy stage | Validation | Root publication | Replay source |
| :--- | ---: | ---: | ---: | :--- |
| reaction plan | 2 | graph/reference/policy | one object | plan registry |
| claims | 3 | strict source/relation/cardinality | `0..4` | result claim IDs |
| events | 4 | source/descriptor/order/version | `1..16` | result event IDs |
| canonical publication | 5 | plan/segment/request/turn/version/actor/locale/order | exactly one | result publication ID |
| idempotency record and indexes | 6 | all primary/secondary uniqueness | exactly one record | primary reaction key |
| commit result | 7 | canonical-equal to prepared expected result | exactly one | session/request result key |
| created/shared-publication-slot/shared-record-append counters | 8-10 | exact reservation arithmetic | three resulting authoritative values | stored result/publication/orders |
| phase and state version | 11-12 | unchanged phase; exact `+1` | resulting phase and `N+2` | plan/result provenance |

The engine creates a detached working copy of the current root, then stages plan; claims in proposal order; events in created order; publication; idempotency record/indexes; expected result; counters; unchanged resulting phase; and finally state version. It validates the complete working graph, then calls the existing root publication primitive exactly once. It never pushes/sets/increments live structures early and never uses partial manual undo. Any exception before root publication discards the copy and leaves exact `N+1`, including counters and indexes.

Canonical publication counter behavior is exact. The two existing conversation-root counters initialize to `0`, must remain non-negative safe integers, and advance only with an authoritative canonical publication. Preparation evidence fields map as follows:

```text
prepared.orderReservation.publicationSlotOrder
  == prepared.orderReservation.preconditionNextPublicationSlotOrder
  == current.conversation.nextPublicationSlotOrder

prepared.orderReservation.publicationRecordAppendOrder
  == prepared.orderReservation.preconditionNextRecordAppendOrder
  == current.conversation.nextRecordAppendOrder
```

One successful canonical publication sets `state.conversation.nextPublicationSlotOrder` and `state.conversation.nextRecordAppendOrder` to their respective precondition plus exactly one in the same working copy. No canonical publication means neither counter may change. A missing, wrong-type, negative, non-safe, or registry-inconsistent authoritative canonical counter is `invalid_canonical_publication_counter_state`; a well-formed current/prepared mismatch yields `order_precondition_mismatch`; occupied publication identity yields `artifact_id_collision` or `identity_conflict` according to the earlier index table; and either valid counter at `Number.MAX_SAFE_INTEGER` yields `order_exhausted` before working-copy construction. Failure and replay increment both by zero and leave no gap. Delivery, Renderer, acknowledgement, retry, UI-history, and observer ordering are separate nonauthoritative domains and are never compared with these counters.

##### Shared authoritative publication ledger

`state.conversation.publications` is one append-only authoritative registry for every structured publication record in the game session. It is shared by existing `PlayerUtterancePublishedRecord`, initial Phase 6 `NpcCanonicalUtterancePublishedRecord`, and future Phase 7 reservation/finalization records; no producer owns a private sub-ledger or counter. A record's discriminator selects its strict schema but never selects a different ordering domain. Array order is authoritative append order and must equal ascending `recordAppendOrder`.

The active browser- or CLI-process `WerewolfGame` owns the registry and both counters for its one session. Server, provider, browser/CLI sink, Renderer, observer, history consumer, receipt, and acknowledgement controller own none of them and cannot allocate, increment, repair, or mirror them. The counters remain part of the authoritative copy-on-write root and are protected by the same final CAS and `stateVersion` transaction as the publication that consumes them. This repository has no save/load migration: a current in-memory session keeps its existing values, while a new session initializes the registry empty and both counters to `0`; no startup conversion derives a second counter from stored publications.

`state.conversation.nextPublicationSlotOrder` is the next unallocated conversation-position slot. Creating a new publication identity consumes exactly its current value and increments it by one. A later record that finalizes an already reserved publication ID reuses that publication's existing `publicationSlotOrder` and does not increment the slot counter. `state.conversation.nextRecordAppendOrder` is the next append order for any record added to the shared registry; every appended player, NPC, reservation, or finalization record consumes exactly its current value and increments it by one. Initial Phase 6 appends one complete NPC canonical publication with a new publication ID, so its one commit increments both counters exactly once.

| Operation | Slot increment | Record increment | State-version behavior |
| :--- | ---: | ---: | :--- |
| Phase 4 player publication | 1 | 1 | inside its existing player authoritative transaction |
| Phase 6 canonical NPC publication | 1 | 1 | inside reaction `N+1 -> N+2` |
| Phase 6 preparation | 0 | 0 | increment 0 |
| Phase 6 replay | 0 | 0 | increment 0 |
| Phase 6 rejection/conflict/stale | 0 | 0 | increment 0 |
| delivery/Renderer/acknowledgement | 0 | 0 | increment 0 |
| Phase 7 commentary reservation | 1 | 1 | future reaction commit; Phase 7 owns the exact transaction |
| Phase 7 commentary finalization | 0 | 1 | successful standalone authoritative append increments version exactly once; exact API remains Phase 7-owned |

For an initial Phase 6 successful commit the exact equalities are:

```text
prepared.orderReservation.publicationSlotOrder
  === prepared.orderReservation.preconditionNextPublicationSlotOrder
  === current.state.conversation.nextPublicationSlotOrder

prepared.orderReservation.publicationRecordAppendOrder
  === prepared.orderReservation.preconditionNextRecordAppendOrder
  === current.state.conversation.nextRecordAppendOrder

prepared.delta.publication.publicationSlotOrder
  === current.state.conversation.nextPublicationSlotOrder

prepared.delta.publication.recordAppendOrder
  === current.state.conversation.nextRecordAppendOrder

resulting.state.conversation.nextPublicationSlotOrder
  === current.state.conversation.nextPublicationSlotOrder + 1

resulting.state.conversation.nextRecordAppendOrder
  === current.state.conversation.nextRecordAppendOrder + 1
```

The plan, claims, events, publication, idempotency record, commit result, both counter results, and resulting state version are staged in the same detached working copy. A player publication followed by NPC preparation captures the resulting shared values; an NPC publication followed by a player publication likewise starts from the NPC result. Feature-flag state never changes these semantics.

The ledger integrity equations are mandatory at initialization, before preparation evidence is captured, during final CAS, on the complete working copy, and after authoritative root replacement:

```text
state.conversation.nextRecordAppendOrder == state.conversation.publications.length
state.conversation.publications[i].recordAppendOrder == i
state.conversation.nextPublicationSlotOrder == 0 when publications is empty
state.conversation.nextPublicationSlotOrder == max(publications[*].publicationSlotOrder) + 1 otherwise
```

Every `recordAppendOrder` is unique and dense from `0`; distinct publication identities have unique slots dense from `0` through `nextPublicationSlotOrder - 1`; every `publicationSlotOrder` is a non-negative safe integer below `nextPublicationSlotOrder`; different publication IDs never share a slot; records for one existing publication ID share its slot; and every repeated publication ID must be a schema-permitted continuation of the same immutable identity graph. A gap, duplicate, out-of-order append, mismatched repeated identity, counter not equal to the equations, wrong type, negative value, or unsafe integer is `invalid_canonical_publication_counter_state`. Integrity failure throws before preparation/commit mutation; it is never repaired by recomputing or renumbering stored records.

Allocation and failure behavior is exact. A new publication first validates both counters and the full registry, then checks whether any required `+1` would exceed `Number.MAX_SAFE_INTEGER`, then compares prepared preconditions, and only then constructs a detached working copy. Exhaustion returns `order_exhausted`; a valid but changed current counter returns `order_precondition_mismatch`. Neither outcome inserts a record, increments a counter/version, consumes an ID, creates a delivery candidate, or leaves a gap. Successful player and NPC commits insert their complete record and counter updates atomically with their existing one-version transaction. Exact replay, duplicate, stale, rejection, rollback, application exception, and read-only history increment both counters by zero.

The state-boundary ownership table is normative:

| Data | Owner | Authoritative | Protected by `stateVersion` | Root | Reset | Replay authority |
| :--- | :--- | :---: | :---: | :--- | :--- | :---: |
| publication registry | `WerewolfGame.state.conversation` | yes | yes | authoritative state root | new state is empty | yes |
| `nextPublicationSlotOrder` | `WerewolfGame.state.conversation` | yes | yes | authoritative state root | `0` | indirect through stored graph |
| `nextRecordAppendOrder` | `WerewolfGame.state.conversation` | yes | yes | authoritative state root | `0` | indirect through stored graph |
| logical reactions | NPC coordinator | no | no | `NpcReactionCoordinatorControlRoot` | discard | no |
| reaction attempts | NPC coordinator | no | no | `NpcReactionCoordinatorControlRoot` | discard | no |
| terminal reservations | NPC coordinator | no | no | `NpcReactionCoordinatorControlRoot` | discard | no |
| tombstones | NPC coordinator | no | no | `NpcReactionCoordinatorControlRoot` | discard | no |
| `nextTerminalOrder` | NPC coordinator | no | no | `NpcReactionCoordinatorControlRoot` | `0` | no |
| private projection working value | NPC coordinator/engine | no | no | bounded detached runtime evidence | discard | no |
| NPC delivery attempts/receipts/acks/runtime orders | `NpcPublicationDeliveryController` | no | no | session-local NPC delivery root | discard controller root and capabilities | no |
| observer state | observer owner | no | no | owner-specific | owner policy | no |

The authoritative state root and coordinator control root are never merged into one copy-on-write domain. Partial mutation is prohibited inside each root, but a successful authoritative reaction commit may be followed by an independently retryable coordinator cleanup without making the coordinator authoritative.

The following documentation-only ledger traces are normative audit vectors; they are parseable JSON projections, not new runtime objects or APIs:

```json
[
  {"case":"empty","before":{"nextPublicationSlotOrder":0,"nextRecordAppendOrder":0,"records":[]},"outcome":"valid"},
  {"case":"one_player_publication","after":{"nextPublicationSlotOrder":1,"nextRecordAppendOrder":1,"records":[{"recordType":"player_utterance_published","publicationId":"publication-player-1","publicationSlotOrder":0,"recordAppendOrder":0}]},"outcome":"valid"},
  {"case":"npc_preparation_after_player","current":{"nextPublicationSlotOrder":1,"nextRecordAppendOrder":1},"evidence":{"nextPublicationSlotOrder":1,"nextRecordAppendOrder":1},"outcome":"valid"},
  {"case":"player_then_npc","after":{"nextPublicationSlotOrder":2,"nextRecordAppendOrder":2,"records":[{"recordType":"player_utterance_published","publicationId":"publication-player-1","publicationSlotOrder":0,"recordAppendOrder":0},{"recordType":"npc_canonical_published","publicationId":"publication-npc-1","publicationSlotOrder":1,"recordAppendOrder":1}]},"outcome":"valid"},
  {"case":"renderer_success_only","before":{"nextPublicationSlotOrder":2,"nextRecordAppendOrder":2,"stateVersion":13},"after":{"nextPublicationSlotOrder":2,"nextRecordAppendOrder":2,"stateVersion":13},"recordCountDelta":0,"outcome":"nonauthoritative"},
  {"case":"future_finalize_existing_slot","before":{"nextPublicationSlotOrder":2,"nextRecordAppendOrder":2,"stateVersion":13},"appended":{"recordType":"npc_publication_finalized","publicationId":"publication-npc-1","stateVersion":12,"publicationSlotOrder":1,"recordAppendOrder":2},"after":{"nextPublicationSlotOrder":2,"nextRecordAppendOrder":3,"stateVersion":14},"recordStateVersionMeaning":"originating_reaction_result","outcome":"valid_phase7_only"},
  {"case":"future_finalization_replay","before":{"nextPublicationSlotOrder":2,"nextRecordAppendOrder":3,"stateVersion":14},"after":{"nextPublicationSlotOrder":2,"nextRecordAppendOrder":3,"stateVersion":14},"recordCountDelta":0,"outcome":"replayed_phase7_only"},
  {"case":"replay","before":{"nextPublicationSlotOrder":2,"nextRecordAppendOrder":2},"after":{"nextPublicationSlotOrder":2,"nextRecordAppendOrder":2},"outcome":"replayed"},
  {"case":"commit_failure","before":{"nextPublicationSlotOrder":2,"nextRecordAppendOrder":2},"after":{"nextPublicationSlotOrder":2,"nextRecordAppendOrder":2},"publicationCountDelta":0,"stateVersionDelta":0,"outcome":"failed"},
  {"case":"counter_mismatch","state":{"publicationCount":2,"nextPublicationSlotOrder":3,"nextRecordAppendOrder":2},"outcome":"invalid_canonical_publication_counter_state"},
  {"case":"slot_exhausted","state":{"nextPublicationSlotOrder":9007199254740991,"nextRecordAppendOrder":8},"outcome":"order_exhausted"},
  {"case":"append_exhausted","state":{"nextPublicationSlotOrder":8,"nextRecordAppendOrder":9007199254740991},"outcome":"order_exhausted"}
]
```

The Phase 4 player writer already uses these fields and remains the compatibility baseline. Initial Phase 6 must join that registry without changing the player schema, player allocation arithmetic, Phase 5 consumption/acknowledgement, or the legacy compatibility mapping writer. Phase 7 may add strict reservation/finalization record variants only through a separately reviewed contract; this C1 contract grants no Renderer, finalization, delivery, acknowledgement, or sink authority.

Stored `CanonicalNpcReactionCommitResult` is canonically equal to `delta.expectedCommitResult`; commit does not recalculate or replace its payload. It only verifies shape, references, versions, IDs, order, request/correlation/fingerprint, and current registry collision. `commitResultRequestId` resolves exactly one result from the `(gameSessionId, requestId)` registry. Candidate/projection fingerprints and provider metadata are not added to the result.

Exactly one canonical publication is inserted in the same transaction and checked for plan/segment/request/turn/version/actor/locale equality, ID uniqueness, and authoritative canonical slot/record CAS. Commit performs no canonical-text generation, Renderer, DOM/CLI delivery, retry, acknowledgement, receipt, history consumption, or observer-driven delivery. `recordAppendOrder` records canonical registry order and is never DOM/CLI sink evidence. Sink failure retains `N+2`; replay inserts no publication or counter increment.

#### Legacy replacement and one-transition ledger

At logical-reaction creation the engine freezes one route. Structured selection replaces, never follows, the Phase 4 provisional NPC transaction at the identical `N+1 -> N+2` ledger position. It does not run legacy `handlePlayerQuestion()` NPC working-copy mutation, free-form response persistence, NPC log/publicInfo/memory/claim mutation, or fallback after any structured failure. Legacy selection preserves existing Phase 4 behavior and never invokes structured preparation/commit. Mid-flight flags cannot change the route. Physical deletion remains Phase 9.

The initial Phase 6 ledger is exact: player commit `N -> N+1`; preparation `0`; one successful reaction commit `N+1 -> N+2`; replay/rejection/stale/conflict/preparation exception/commit exception/lifecycle/tombstone/delivery/Renderer/observer/history `0`. Initial Phase 6 performs no finalization append and creates no `N+2 -> N+3`. A future Phase 7 authoritative finalization append is a separate successful transaction with one version increment; its Renderer processing remains increment `0` and its exact API is not defined by C1.

#### Normative commit examples

The marker string `preparation-example:suspicion-only.value` below is a documentation reference to the exact `value` object in the earlier suspicion-only `NpcReactionPreparedResult`. Dereferencing it before validation produces the schema-complete commit input without duplicating the large delta; `$ref` is documentation notation and is never a runtime field.

Valid replay lookup input:

```json
{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","turnId":"turn-1","turnOrder":1,"preconditionPhase":"player_question","preconditionStateVersion":2,"npcId":"npc-aoi"}
```

Replay lookup results (`not_found`, exact replay, request-fingerprint conflict):

```json
[{"schemaVersion":1,"status":"not_found"},{"schemaVersion":1,"status":"replayed","result":{"schemaVersion":1,"requestId":"reaction-request-1","correlationId":"correlation-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","commitType":"npc_reaction","preconditionStateVersion":2,"resultingStateVersion":3,"reactionPlanId":"reaction-plan-1","npcPublicationId":"case-4-publication","createdEventIds":["case-4-event-1"],"createdClaimIds":[],"createdAtOrder":3,"resultMode":"canonical_only"}},{"schemaVersion":1,"status":"conflict","conflictCode":"idempotency_conflict"}]
```

Valid committed idempotency record:

```json
{"schemaVersion":1,"recordType":"npc_reaction_commit_idempotency","gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","preparationFingerprint":"c1469d46a3b84c40a481f1accb54b8b3c77fea09ad04d5c9587a192c54c9b605","successfulAttemptId":"reaction-attempt-1","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","turnId":"turn-1","turnOrder":1,"npcId":"npc-aoi","preconditionStateVersion":2,"resultingStateVersion":3,"npcPublicationId":"case-4-publication","commitResultRequestId":"reaction-request-1"}
```

Valid commit input after deterministic documentation-reference dereference:

```json
{"schemaVersion":1,"preparedReaction":{"$ref":"preparation-example:suspicion-only.value"}}
```

Committed and replayed execution results:

```json
[{"schemaVersion":1,"status":"committed","result":{"schemaVersion":1,"requestId":"reaction-request-1","correlationId":"correlation-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","commitType":"npc_reaction","preconditionStateVersion":2,"resultingStateVersion":3,"reactionPlanId":"reaction-plan-1","npcPublicationId":"case-4-publication","createdEventIds":["case-4-event-1"],"createdClaimIds":[],"createdAtOrder":3,"resultMode":"canonical_only"}},{"schemaVersion":1,"status":"replayed","result":{"schemaVersion":1,"requestId":"reaction-request-1","correlationId":"correlation-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","commitType":"npc_reaction","preconditionStateVersion":2,"resultingStateVersion":3,"reactionPlanId":"reaction-plan-1","npcPublicationId":"case-4-publication","createdEventIds":["case-4-event-1"],"createdClaimIds":[],"createdAtOrder":3,"resultMode":"canonical_only"}}]
```

Stale, idempotency-conflict, and order-precondition rejections:

```json
[{"schemaVersion":1,"status":"rejected","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","correlationId":"correlation-1","turnId":"turn-1","preconditionStateVersion":2,"npcId":"npc-aoi"},"rejection":{"stage":"applicability","reasonCode":"stale_state_version","retryable":false,"diagnostics":[{"code":"stale_state_version","location":"state_version"}]}},{"schemaVersion":1,"status":"rejected","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","correlationId":"correlation-1","turnId":"turn-1","preconditionStateVersion":2,"npcId":"npc-aoi"},"rejection":{"stage":"idempotency","reasonCode":"idempotency_conflict","retryable":false,"diagnostics":[{"code":"idempotency_conflict","location":"idempotency_record"}]}},{"schemaVersion":1,"status":"rejected","binding":{"schemaVersion":1,"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","successfulAttemptId":"reaction-attempt-1","requestId":"reaction-request-1","correlationId":"correlation-1","turnId":"turn-1","preconditionStateVersion":2,"npcId":"npc-aoi"},"rejection":{"stage":"ordering","reasonCode":"order_precondition_mismatch","retryable":false,"diagnostics":[{"code":"order_precondition_mismatch","location":"order_reservation"}]}}]
```

Committed and non-commit tombstones:

```json
[{"schemaVersion":1,"tombstoneType":"committed","gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","npcId":"npc-aoi","preconditionStateVersion":2,"terminalOrder":1,"attempts":[{"schemaVersion":1,"reactionAttemptId":"reaction-attempt-1","status":"accepted","observation":"fingerprinted","candidateFingerprint":"895b02e355f391fc91c247d42891cecbebc0b40fa3773f8e47325b2544444ecb"}],"terminalStatus":"committed","successfulAttemptId":"reaction-attempt-1","preparationFingerprint":"c1469d46a3b84c40a481f1accb54b8b3c77fea09ad04d5c9587a192c54c9b605","npcPublicationId":"case-4-publication","commitResultRequestId":"reaction-request-1"},{"schemaVersion":1,"tombstoneType":"non_commit","gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-2","requestId":"reaction-request-2","requestFingerprint":"1111111111111111111111111111111111111111111111111111111111111111","correlationId":"correlation-2","causationId":"player-request-1","originatingInputRecordId":"input-1","npcId":"npc-aoi","preconditionStateVersion":2,"terminalOrder":2,"attempts":[{"schemaVersion":1,"reactionAttemptId":"reaction-attempt-2","status":"aborted","observation":"none"}],"terminalStatus":"superseded","reason":"stale_applicability"}]
```

An empty control root has this exact parseable shape; `{}` denotes an empty runtime-private map, not a public JSON storage format:

```json
{"schemaVersion":1,"gameSessionId":"game-session-1","nextTerminalOrder":0,"logicalReactions":{},"reactionAttempts":{},"terminalSlotReservations":{},"reactionTombstones":{}}
```

The following parseable documentation-only coordinator projections are normative graph and transaction audit vectors. They deliberately show identities/status/counts rather than inventing a serialization format for runtime-private map instances or exposing private projection values:

```json
[
  {"case":"empty","before":{"gameSessionId":"game-session-1","nextTerminalOrder":0,"logicalIds":[],"attemptIds":[],"reservations":[],"tombstones":[]},"outcome":"valid"},
  {"case":"complete_planned_creation","before":{"nextTerminalOrder":0,"logicalIds":[],"attemptIds":[],"reservations":[],"tombstoneOrders":[]},"after":{"nextTerminalOrder":1,"logical":[{"reactionPlanId":"reaction-plan-1","status":"planned","attemptIds":[]}],"attempts":[],"reservations":[{"reactionPlanId":"reaction-plan-1","terminalOrder":0}],"tombstoneOrders":[]},"rootReplacementCount":1,"outcome":"created"},
  {"case":"before_authoritative_commit","authoritativeGraph":"absent","root":{"nextTerminalOrder":1,"logical":[{"reactionPlanId":"reaction-plan-1","status":"active","attemptIds":["reaction-attempt-1"]}],"attempts":[{"reactionAttemptId":"reaction-attempt-1","reactionPlanId":"reaction-plan-1","status":"validated"}],"reservations":[{"reactionPlanId":"reaction-plan-1","terminalOrder":0}],"tombstones":[]},"outcome":"ordinary_commit_candidate"},
  {"case":"authoritative_commit_succeeded_cleanup_not_run","authoritativeGraph":{"reactionPlanId":"reaction-plan-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","npcId":"npc-aoi","successfulAttemptId":"reaction-attempt-1","preconditionStateVersion":2,"resultingStateVersion":3,"complete":true},"root":{"nextTerminalOrder":1,"logicalStatus":"active","winningAttemptStatus":"validated","reservationTerminalOrder":0,"tombstoneCountForReaction":0},"outcome":"commit_cleanup_pending"},
  {"case":"cleanup_working_copy_failure","before":{"logicalStatus":"active","winningAttemptStatus":"validated","reservationTerminalOrder":0,"tombstoneCountForReaction":0,"nextTerminalOrder":1},"after":{"logicalStatus":"active","winningAttemptStatus":"validated","reservationTerminalOrder":0,"tombstoneCountForReaction":0,"nextTerminalOrder":1},"authoritativeGraph":"committed","outcome":"cleanup_retryable"},
  {"case":"cleanup_retry_cross_root_evidence","authoritative":{"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","npcId":"npc-aoi","successfulAttemptId":"reaction-attempt-1"},"control":{"gameSessionId":"game-session-1","reactionPlanId":"reaction-plan-1","requestId":"reaction-request-1","requestFingerprint":"ac741b97386d4f344cfc4f6139d90089bce90f612122599bafd3af860057b1a6","correlationId":"correlation-1","causationId":"player-request-1","originatingInputRecordId":"input-1","npcId":"npc-aoi","winningAttemptId":"reaction-attempt-1","logicalStatus":"active","winningAttemptStatus":"validated","reservationTerminalOrder":0,"tombstoneCountForReaction":0},"outcome":"cleanup_allowed"},
  {"case":"cleanup_retry_succeeded","before":{"logicalStatus":"active","winningAttemptStatus":"validated","reservationTerminalOrder":0,"tombstoneCountForReaction":0},"after":{"logicalCountForReaction":0,"attemptCountForReaction":0,"reservationCountForReaction":0,"tombstones":[{"reactionPlanId":"reaction-plan-1","terminalOrder":0,"terminalStatus":"committed"}]},"result":{"schemaVersion":1,"status":"cleaned","reactionPlanId":"reaction-plan-1","terminalOrder":0}},
  {"case":"already_cleaned_retry","root":{"logicalCountForReaction":0,"attemptCountForReaction":0,"reservationCountForReaction":0,"tombstones":[{"reactionPlanId":"reaction-plan-1","terminalOrder":0,"terminalStatus":"committed"}]},"result":{"schemaVersion":1,"status":"already_cleaned","reactionPlanId":"reaction-plan-1","terminalOrder":0},"mutationCount":0},
  {"case":"cleanup_pending_exact_replay","authoritativeGraph":"complete","control":{"logicalStatus":"active","winningAttemptStatus":"validated","reservationTerminalOrder":0,"tombstoneCountForReaction":0},"outcome":"replayed","authoritativeMutation":0,"controlMutation":0,"providerCalls":0},
  {"case":"cleanup_pending_identity_conflict","authoritativeGraph":"complete_conflicting_request","controlBefore":{"logicalStatus":"active","winningAttemptStatus":"validated","reservationTerminalOrder":0,"tombstoneCountForReaction":0},"controlAfter":{"logicalStatus":"active","winningAttemptStatus":"validated","reservationTerminalOrder":0,"tombstoneCountForReaction":0},"outcome":"idempotency_conflict","authoritativeMutation":0},
  {"case":"invalid_partial_committed_control","root":{"logicalStatus":"committed","winningAttemptStatus":"accepted","reservationTerminalOrder":0,"tombstoneCountForReaction":0},"outcome":"invalid_coordinator_state"},
  {"case":"invalid_tombstone_active_coexistence","root":{"logicalStatus":"active","winningAttemptStatus":"validated","reservationTerminalOrder":0,"tombstones":[{"reactionPlanId":"reaction-plan-1","terminalOrder":0,"terminalStatus":"committed"}]},"outcome":"invalid_terminal_registry"},
  {"case":"terminalized","root":{"nextTerminalOrder":1,"logical":[],"attempts":[],"reservations":[],"tombstones":[{"reactionPlanId":"reaction-plan-1","terminalOrder":0,"terminalStatus":"committed"}]},"outcome":"valid"},
  {"case":"invalid_orphan_reservation","root":{"logicalIds":[],"attemptOwners":[],"reservations":[{"reactionPlanId":"reaction-plan-1","terminalOrder":0}],"tombstones":[]},"outcome":"invalid_terminal_registry"},
  {"case":"invalid_attempt_without_owner","root":{"logicalIds":[],"attemptOwners":[{"reactionAttemptId":"reaction-attempt-1","reactionPlanId":"reaction-plan-1"}],"reservations":[],"tombstones":[]},"outcome":"invalid_terminal_registry"},
  {"case":"invalid_attempt_order","root":{"logical":[{"reactionPlanId":"reaction-plan-1","attemptIds":["reaction-attempt-2","reaction-attempt-1"]}],"attemptRegistryCreationOrder":["reaction-attempt-1","reaction-attempt-2"],"reservations":[{"reactionPlanId":"reaction-plan-1","terminalOrder":0}]},"outcome":"invalid_coordinator_state"},
  {"case":"reservation_to_committed_tombstone","before":{"nextTerminalOrder":2,"reservation":{"reactionPlanId":"reaction-plan-1","terminalOrder":0}},"after":{"nextTerminalOrder":2,"tombstone":{"reactionPlanId":"reaction-plan-1","terminalOrder":0,"terminalStatus":"committed"}},"outcome":"converted"},
  {"case":"reservation_to_non_commit_tombstone","before":{"nextTerminalOrder":2,"reservation":{"reactionPlanId":"reaction-plan-2","terminalOrder":1}},"after":{"nextTerminalOrder":2,"tombstone":{"reactionPlanId":"reaction-plan-2","terminalOrder":1,"terminalStatus":"superseded"}},"outcome":"converted"},
  {"case":"evict_oldest_tombstone","before":{"nextTerminalOrder":1024,"reservationCount":1023,"tombstoneOrders":[0]},"reservation":{"reactionPlanId":"reaction-plan-1025","terminalOrder":1024},"after":{"nextTerminalOrder":1025,"reservationCount":1024,"tombstoneOrders":[]},"evictedTerminalOrder":0,"outcome":"reserved"},
  {"case":"all_reservations_capacity","before":{"nextTerminalOrder":1024,"reservationCount":1024,"tombstoneOrders":[]},"after":{"nextTerminalOrder":1024,"reservationCount":1024,"tombstoneOrders":[]},"outcome":"terminal_capacity_exhausted"},
  {"case":"terminal_order_exhausted_before_eviction","before":{"nextTerminalOrder":9007199254740991,"reservationCount":1023,"tombstoneOrders":[0]},"after":{"nextTerminalOrder":9007199254740991,"reservationCount":1023,"tombstoneOrders":[0]},"outcome":"terminal_order_exhausted"},
  {"case":"authoritative_plan_id_collision","authoritativeProjection":{"occupiedReactionPlanIds":["reaction-plan-1"]},"allocatedReactionPlanId":"reaction-plan-1","mutation":{"logicalInsert":0,"reservationInsert":0,"tombstoneEviction":0,"terminalOrderIncrement":0,"providerCalls":0},"outcome":"terminal_identity_collision"},
  {"case":"request_id_collision","allocatedRequestId":"reaction-request-1","authoritativeRequestOwnerExists":true,"mutation":{"logicalInsert":0,"reservationInsert":0,"tombstoneEviction":0,"terminalOrderIncrement":0,"providerCalls":0},"outcome":"terminal_identity_collision"},
  {"case":"projection_failure_no_gap","before":{"nextTerminalOrder":9,"reservationCount":2,"tombstoneOrders":[3]},"after":{"nextTerminalOrder":9,"reservationCount":2,"tombstoneOrders":[3]},"providerCalls":0,"outcome":"projection_failure"},
  {"case":"root_validation_failure_no_gap","before":{"nextTerminalOrder":9,"reservationCount":2,"tombstoneOrders":[3]},"after":{"nextTerminalOrder":9,"reservationCount":2,"tombstoneOrders":[3]},"providerCalls":0,"outcome":"invalid_coordinator_state"},
  {"case":"successful_creation_with_eviction","before":{"nextTerminalOrder":1024,"reservationCount":1023,"tombstoneOrders":[0]},"after":{"nextTerminalOrder":1025,"logicalInsert":1,"reservationInsert":1,"reservationCount":1024,"tombstoneOrders":[]},"evictedTerminalOrder":0,"rootReplacementCount":1,"outcome":"created"},
  {"case":"cleanup_failure_old_root_retained","before":{"nextTerminalOrder":9,"logicalStatus":"active","winningAttemptStatus":"validated","losingAttemptStatuses":["failed"],"reservationCount":1,"tombstoneCountForReaction":0},"after":{"nextTerminalOrder":9,"logicalStatus":"active","winningAttemptStatus":"validated","losingAttemptStatuses":["failed"],"reservationCount":1,"tombstoneCountForReaction":0},"authoritativeCommitState":"committed","outcome":"cleanup_retryable"},
  {"case":"replay_no_change","before":{"nextTerminalOrder":9,"reservationCount":0,"tombstoneOrders":[7,8]},"after":{"nextTerminalOrder":9,"reservationCount":0,"tombstoneOrders":[7,8]},"outcome":"replayed"},
  {"case":"reset","before":{"gameSessionId":"game-session-1","nextTerminalOrder":9,"logicalCount":1,"attemptCount":2,"reservationCount":1,"tombstoneOrders":[7,8]},"after":{"gameSessionId":"game-session-2","nextTerminalOrder":0,"logicalCount":0,"attemptCount":0,"reservationCount":0,"tombstoneOrders":[]},"oldCallbacks":"stale","outcome":"new_coordinator"}
]
```

Invariant errors are synchronous errors and never JSON result members.

The correction vectors below are normative and use zero mutation unless a new commit or active terminalization is stated:

| Domain | Input state | Required outcome |
| :--- | :--- | :--- |
| replay | complete authoritative graph; committed/accepted cleanup complete; reservation absent; tombstone present; current version `>= N+2` | exact `replayed`; lifecycle/tombstone/reservation/publication/counters/version unchanged |
| replay | same complete graph; pre-terminalization control root remains after cleanup failure | exact `replayed`; no status change, tombstone creation, reservation release, or cleanup repair |
| replay | complete graph; reservation absent; same request fingerprint | exact `replayed`; reservation is not inspected |
| conflict | committed graph; reservation absent; different request fingerprint | `idempotency_conflict`; terminal lifecycle unchanged |
| conflict | committed graph; reservation absent; same request but different preparation fingerprint at final commit lookup | `idempotency_conflict`; terminal lifecycle unchanged |
| conflict | committed graph; cleanup-pending active/validated/reservation control shape remains | closed conflict; old control root byte-identical, no rejected overwrite/tombstone/release |
| cleanup | complete authoritative graph plus matching active/validated/reservation root and no tombstone | coordinator-only detached cleanup returns `cleaned` after one root replacement |
| cleanup | complete authoritative graph plus exact committed tombstone and no active entries/reservation | `already_cleaned`; mutation and observer notification zero |
| cleanup | committed/accepted entries remain with reservation, tombstone coexists with active entries, or active entries lack reservation | coordinator invariant; mutation zero |
| reservation | no committed record/alias; exact owned unique reservation | continue new-commit CAS path |
| reservation | no committed record/alias; reservation missing, foreign, malformed, duplicate terminal order, or capacity inconsistent | `invalid_terminal_slot_reservation`; no mutation |
| reservation | replay or already-terminal conflict with no reservation | replay/conflict succeeds; no reservation recreation |
| canonical counters | both prepared preconditions equal current authoritative canonical counters | working copy increments each by exactly one with publication |
| canonical counters | slot mismatch or record mismatch | `order_precondition_mismatch`; gap zero |
| canonical counters | slot or record counter exhausted | `order_exhausted` before working-copy construction |
| canonical counters | replay/failure or delivery-only counter movement | canonical increments zero; delivery order does not participate in CAS |
| tombstone | committed; winning summary present once and accepted; every other summary terminal/non-accepted | valid committed member |
| tombstone | winning summary missing/non-accepted, multiple accepted, nonterminal summary, duplicate, or creation-order violation | closed tombstone-summary invariant; no mutation |
| tombstone | non-commit; zero accepted; allowed terminal subset in creation order | valid non-commit member |
| tombstone | non-commit with accepted/nonterminal/duplicate/out-of-order summary | `invalid_non_commit_tombstone_attempt_summary`; no mutation |
| conflict lifecycle | active plus relevant nonterminal/validated attempt and exact reservation | return conflict; rejected terminalization, one tombstone, release, removal; authority/version zero |
| conflict lifecycle | committed/exhausted/superseded/rejected/cancelled or terminal relevant attempt | return conflict; existing status/tombstone/reservation/active state preserved exactly |
| terminal integrity | terminal lifecycle has missing/inconsistent required tombstone or authoritative graph, except complete-graph replay with missing tombstone | `terminal_lifecycle_graph_mismatch`; authoritative and lifecycle mutation zero |

#### Commit implementation acceptance tests

The later implementation must cover pre-provider exact replay including later current versions; replay before reservation inspection; replay after reservation release; conflict after reservation release; complete-graph replay with missing or evicted tombstone; no replay reservation/tombstone recreation; request/preparation fingerprint conflicts; every request/plan/trigger/publication/attempt/artifact alias; every final CAS dimension independently; all 7 logical by 8 attempt status combinations with the cross-root annotation; every terminal conflict with lifecycle mutation zero; active conflict terminalization only when no authoritative graph exists; authoritative committed-plan identity collision even after tombstone eviction; existing tombstone preservation except the exact oldest-capacity eviction; impossible lifecycle combinations; actor removed/dead/unable; target removed/reclassified/dead eligibility; permission/result-fact changes; artifact collision; all three order mismatches; shared player/NPC publication-ledger CAS; dense/max-plus-one registry integrity; delivery-counter isolation; slot/record exhaustion; version exhaustion; every dangling plan/claim/event/segment/publication reference; corrupt idempotency/stored replay graph; faults before/after every authoritative working-copy stage; exact rollback to `N+1` before authoritative publication; zero counter gaps and partial inserts; one authoritative root publication; exactly one `N+1 -> N+2`; replay publication zero; no delivery during commit; observer isolation; exact seven-field coordinator root; planned-logical plus reservation atomic publication; zero-based successful-complete-creation-only terminal order; orphan rejection; all-reservation capacity rejection; oldest-tombstone eviction only on successful creation; terminal-order exhaustion before projection/ID allocation; same-order reservation/tombstone conversion; and the complete cleanup fault matrix. Cleanup tests inject a fault after authoritative publish/before cleanup, during cleanup-copy construction, at every cleanup staging/validation step, and at root replacement; every fault preserves the old control root byte-for-byte (`active`, validated winner, prior nonwinner statuses, reservation, no tombstone) while authoritative `N+2` remains. They also prove replay succeeds without cleanup, provider/attempt/preparation/commit retry is suppressed, exact cleanup retry can fail then succeed, `already_cleaned` is mutation zero, cleanup-pending identity conflict is mutation zero, partial committed/accepted and tombstone-plus-active graphs are invariant failures, reset destroys pending cleanup, observer failure after cleanup does not roll back, structured routing never falls back, and Phase 4/5 regression remains unchanged.

Tests also prove exact input/result/invariant schemas, diagnostic bounds/privacy, registry/index set equality, three-way preparation fingerprint verification, full rejection reachability, stage 0 through 23 continuity, final-CAS checklist completeness, created plus the two existing shared publication-counter arithmetic, atomic graph completeness, terminal-only attempt-summary status, committed tombstone accepted-count exactly one, non-commit accepted-count zero, strict coordinator/allocation/tombstone unions and 1024 capacity, observer exception isolation, and zero authoritative effects for every non-commit outcome.

### Successful-attempt reference contract

This subsection is normative for Runtime Contract Alignment after this documentation is merged. It resolves successful-attempt references without extending any existing schema. In particular, `NpcReactionPlan` does not own `requestFingerprint` or `turnOrder`; `NpcReactionPreparationBinding` does not own `resultingStateVersion`; and `CanonicalNpcReactionCommitResult` does not own `successfulAttemptId` or `turnOrder`. Validators must not synthesize, alias, or silently add any of those fields.

`NpcReactionPlan.successfulAttemptId` is the engine-owned `reactionAttemptId` of the winning provider attempt that produced the validated candidate adopted by that plan. It is not provider-generated and is not a request, plan, correlation, retry-group, terminal-order, tombstone, publication, or other artifact ID. One committed reaction plan owns exactly one successful attempt, the value is immutable for the plan lifetime, and two different committed plans in one game session may not share it.

#### Exact field ownership

The table records actual strict-schema ownership. For `NpcReactionCommitDelta`, "binding" means the existing nested `binding: NpcReactionPreparationBinding`; only the fingerprint and version fields identified as top-level are owned directly by the delta. "No" forbids direct equality against that object.

| Field | Plan | Preparation binding | Commit delta | Idempotency record | Commit result |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `reactionPlanId` | yes | yes | binding and `plan` | yes | yes |
| `requestId` | yes | yes | binding and `plan` | yes | yes |
| `requestFingerprint` | no | yes | binding plus top-level | yes | yes |
| `correlationId` | yes | yes | binding and `plan` | yes | yes |
| `causationId` | yes | yes | binding and `plan` | yes | no |
| `originatingInputRecordId` | yes | yes | binding and `plan` | yes | no |
| `turnId` | yes | yes | binding and `plan` | yes | no |
| `turnOrder` | no | yes | binding only | yes | no |
| `npcId` | yes | yes | binding and `plan` | yes | no |
| `successfulAttemptId` | yes | yes | binding and `plan` | yes | no |
| `preconditionStateVersion` | yes | yes | binding plus top-level and `plan` | yes | yes |
| `resultingStateVersion` | yes | no | top-level and `plan` | yes | yes |

The corresponding comparison matrix is closed:

| Field | Exact existing owner | Pre-commit comparison | Post-commit rule |
| :--- | :--- | :--- | :--- |
| `successfulAttemptId` | plan, preparation binding, delta binding/plan, idempotency record; candidate binding names it `reactionAttemptId` | candidate `reactionAttemptId` equals preparation/delta/plan `successfulAttemptId` | plan equals idempotency record; unique across committed plans in the session |
| `requestFingerprint` | validated-candidate binding, preparation binding, delta binding/top-level, idempotency record, commit result | all candidate/binding/delta owners are equal | idempotency value is authoritative; equality with the existing commit-result value is required |
| `turnOrder` | validated-candidate binding, preparation binding, delta binding; post-commit idempotency record | all candidate/binding/delta owners are equal | idempotency record is the sole persisted authoritative owner; no cross-record equality is invented |
| `preconditionStateVersion` | plan, candidate binding, preparation binding, delta binding/top-level, idempotency record, commit result | candidate/binding/delta/plan owners are equal | plan, idempotency record, and result are equal |
| `resultingStateVersion` | plan, delta top-level, idempotency record, commit result, publication provenance | plan equals delta; both are precondition plus one | plan, idempotency record, result, and publication provenance are equal |

#### Three validation layers

1. **Schema-only plan validation.** `validateNpcReactionPlan(plan)` accepts only the plan. It checks the required strict field set, ID and safe-integer syntax, member constraints, mandatory `successfulAttemptId`, and `preconditionStateVersion + 1 === resultingStateVersion`. It does not look up an attempt, fingerprint, turn order, binding, delta, idempotency record, coordinator, or committed graph.
2. **Pre-commit prepared-graph reference validation.** This checks one strict runtime-private context containing the exact preparation binding, complete commit delta, and validated-candidate binding. It compares plan-owned identity, binding-owned fingerprint/order, delta-owned resulting version, and the successful-attempt chain. It is not authoritative committed-graph validation.
3. **Post-commit authoritative-graph validation.** This checks the stored plan, NPC idempotency record, commit result, publication, claims, events, and segments. It proves successful-attempt ownership and graph completeness without coordinator, tombstone, reservation, delivery, history, provider, or observer state.

`NpcReactionPlanPreCommitReferenceContext` is a strict runtime-only object requiring exactly `schemaVersion: 1`, discriminator `contextType: "pre_commit"`, `preparationBinding: NpcReactionPreparationBinding`, `commitDelta: NpcReactionCommitDelta`, and `validatedCandidateBinding: ValidatedNpcReactionCandidateBinding`. It has no optional/null/extra fields. It is engine-owned, detached, recursively immutable, never provider/server/sink-visible, and contains neither a mutable coordinator object nor callback/metadata bag.

`NpcReactionCommittedGraphReferenceContext` is a strict detached authoritative projection requiring exactly `schemaVersion: 1`, discriminator `contextType: "committed_graph"`, `reactionPlan`, `idempotencyRecord`, `commitResult`, `publication`, `claims`, `events`, and `segments`. It has no optional/null/extra fields. `claims`, `events`, and `segments` are the exact bounded transaction-owned arrays in authoritative order. It contains no preparation binding, fabricated triggering binding, coordinator, tombstone, reservation, delivery state, provider value, callback, or generic record bag.

`NpcReactionPlanReferenceContext` is the strict union of those two members. Context members may not be mixed. Missing or malformed engine-owned context is an invariant rather than a provider-facing rejection.

#### Pre-commit comparison rules

The complete `commitDelta.binding` must be canonical-equal to `preparationBinding`, and `commitDelta.plan` must be canonical-equal to the plan being checked. Plan-owned fields are then compared only where they actually exist:

```text
plan.reactionPlanId           == preparationBinding.reactionPlanId           == commitDelta.binding.reactionPlanId
plan.requestId                == preparationBinding.requestId                == commitDelta.binding.requestId
plan.correlationId            == preparationBinding.correlationId            == commitDelta.binding.correlationId
plan.causationId              == preparationBinding.causationId              == commitDelta.binding.causationId
plan.originatingInputRecordId == preparationBinding.originatingInputRecordId == commitDelta.binding.originatingInputRecordId
plan.turnId                   == preparationBinding.turnId                   == commitDelta.binding.turnId
plan.npcId                    == preparationBinding.npcId                    == commitDelta.binding.npcId
plan.successfulAttemptId      == preparationBinding.successfulAttemptId      == commitDelta.binding.successfulAttemptId
plan.preconditionStateVersion == preparationBinding.preconditionStateVersion == commitDelta.preconditionStateVersion
plan.resultingStateVersion    == commitDelta.resultingStateVersion
```

The winning-attempt chain uses the existing candidate field name:

```text
validatedCandidateBinding.reactionAttemptId
  == preparationBinding.successfulAttemptId
  == commitDelta.binding.successfulAttemptId
  == plan.successfulAttemptId
```

The winning attempt object, its mutable status, provider response, and raw candidate are not reference authority.

Plan-nonowned fields compare only between their real owners:

```text
validatedCandidateBinding.requestFingerprint
  == preparationBinding.requestFingerprint
  == commitDelta.binding.requestFingerprint
  == commitDelta.requestFingerprint

validatedCandidateBinding.turnOrder
  == preparationBinding.turnOrder
  == commitDelta.binding.turnOrder
```

There is no top-level `commitDelta.turnOrder`. There is no `plan.requestFingerprint` or `plan.turnOrder`.

The exact version chain is:

```text
validatedCandidateBinding.preconditionStateVersion
  == preparationBinding.preconditionStateVersion
  == commitDelta.binding.preconditionStateVersion
  == commitDelta.preconditionStateVersion
  == plan.preconditionStateVersion

plan.resultingStateVersion
  == commitDelta.resultingStateVersion
  == commitDelta.preconditionStateVersion + 1
  == plan.preconditionStateVersion + 1
```

`plan.resultingStateVersion == preparationBinding.resultingStateVersion` is forbidden because the binding has no such field. No validator may add or infer it.

#### Post-commit comparison rules

`NpcReactionCommitIdempotencyRecord.successfulAttemptId` is the primary authoritative reference target after commit. It must equal `plan.successfulAttemptId`. Plan and idempotency record also compare their common plan, request, correlation, causation, origin, turn, actor, precondition-version, and resulting-version fields. The commit result is not extended with successful-attempt identity.

The version graph requires:

```text
plan.preconditionStateVersion
  == idempotencyRecord.preconditionStateVersion
  == commitResult.preconditionStateVersion

plan.resultingStateVersion
  == idempotencyRecord.resultingStateVersion
  == commitResult.resultingStateVersion
  == publication.reactionResultingStateVersion

resultingStateVersion == preconditionStateVersion + 1
```

The idempotency record's `requestFingerprint` is required, strict lower-case SHA-256 hex, immutable, and authoritative after commit. It equals the existing commit-result fingerprint. Same reaction primary identity with a different incoming fingerprint is `idempotency_conflict`; two stored records for the same identity with different fingerprints are a corrupt authoritative graph. The plan is never given this field.

The idempotency record is the sole persisted authoritative owner of post-commit `turnOrder`. It must be a required non-negative safe integer, immutable under the reaction primary key, retained unchanged on replay, and unique for that stored identity. Graph validation checks the record's strict shape, primary/index uniqueness, absence of duplicate/alias records, and stored replay equality. It does not compare turn order to the plan, commit result, preparation binding, coordinator, or tombstone, and it does not create a second persisted owner. Two records for the same reaction identity with different turn orders are a corrupt graph.

`validateReactionPlanReferences(plan, context)` is the future strict reference entrypoint. It validates the context discriminator, plan-owned equality, binding-owned equality, delta-owned version equality, successful-attempt identity, and missing/malformed evidence. The existing array/graph reference helper does not yet implement this signature; Runtime Contract Alignment must migrate it explicitly rather than treating the current helper as conforming.

`validateCommittedConversationGraph(graph)` remains responsible for complete authoritative graph integrity: plan/idempotency successful-attempt equality, plan/idempotency/result/publication version equality, idempotency fingerprint and turn-order strictness, uniqueness, and dangling/alias conflicts. It does not require coordinator attempts, tombstones, delivery receipts, preparation bindings, or provider state.

#### Cleanup independence and lifetime

Post-commit validation produces the same result before cleanup, during `commit_cleanup_pending`, after cleanup, and after tombstone eviction. Coordinator and tombstone data are nonauthoritative and removable; exact replay and reference validation reconstruct authority from the persisted conversation graph.

| Stage | Successful-attempt owner | Request-fingerprint owner | Turn-order owner | Resulting-version owner | Authoritative |
| :--- | :--- | :--- | :--- | :--- | :---: |
| attempt active | coordinator attempt | logical/preparation binding | logical/preparation binding | none | no |
| candidate validated | candidate binding | candidate/preparation binding | candidate/preparation binding | none | no |
| preparation | preparation binding | preparation binding and delta | preparation binding/delta binding | commit delta | no |
| commit CAS | binding and delta | binding and delta | binding and delta | delta | mixed |
| commit success | plan and idempotency record | idempotency record | idempotency record only | plan, idempotency record, result | yes |
| cleanup pending | same authoritative graph | idempotency record | idempotency record only | same graph | yes |
| cleanup complete | same authoritative graph | idempotency record | idempotency record only | same graph | yes |
| tombstone evicted | same authoritative graph | idempotency record | idempotency record only | same graph | yes |
| replay | same authoritative graph | idempotency record | idempotency record only | same graph | yes |

#### Error and identity classification

Schema-only failures are missing/invalid `successfulAttemptId`, any unknown field, and invalid version arithmetic. Pre-commit missing or malformed context/binding/delta is an engine invariant; successful-attempt, plan-owned, fingerprint, turn-order, or version-chain mismatch is a reference failure. Post-commit missing idempotency is an incomplete graph; duplicate idempotency, malformed fingerprint/order, attempt mismatch, or version mismatch is a corrupt graph; same key with another fingerprint/turn order or the same attempt owned by another plan/request/trigger is an authoritative identity conflict; and dangling plan/result/publication/artifact references are dangling authoritative references. None maps to candidate validation's provider-facing rejection union, whose active 18 codes remain unchanged.

Within one game session, one `successfulAttemptId` maps to exactly one committed plan and one matching idempotency record. The inverse also holds. Same attempt with a different plan, request, or trigger is forbidden. Exact replay reads the same stored graph and is not duplicate ownership.

#### Normative reference vectors

The complete valid plan, preparation binding, and commit delta are the parseable canonical preparation examples above; the complete idempotency record, result, publication, claims, events, and segments are the parseable commit examples above. This contract does not duplicate or extend their strict fields. The following parseable vectors specify assembly and outcomes without replacing those complete object examples:

```json
[
  {"case":"valid_pre_commit","contextType":"pre_commit","candidateAttempt":"reaction-attempt-1","planAttempt":"reaction-attempt-1","bindingAttempt":"reaction-attempt-1","requestFingerprintEqual":true,"turnOrderEqual":true,"resultingVersionEqual":true,"outcome":"valid"},
  {"case":"successful_attempt_mismatch","contextType":"pre_commit","candidateAttempt":"reaction-attempt-2","planAttempt":"reaction-attempt-1","bindingAttempt":"reaction-attempt-1","outcome":"reference_failure"},
  {"case":"request_fingerprint_mismatch","contextType":"pre_commit","requestFingerprintEqual":false,"outcome":"reference_failure"},
  {"case":"turn_order_mismatch","contextType":"pre_commit","turnOrderEqual":false,"outcome":"reference_failure"},
  {"case":"resulting_version_mismatch","contextType":"pre_commit","resultingVersionEqual":false,"outcome":"reference_failure"},
  {"case":"valid_committed_graph","contextType":"committed_graph","planAttempt":"reaction-attempt-1","idempotencyAttempt":"reaction-attempt-1","storedTurnOrder":1,"coordinatorPresent":false,"tombstonePresent":false,"outcome":"valid"},
  {"case":"missing_idempotency","contextType":"committed_graph","idempotencyCount":0,"outcome":"incomplete_authoritative_graph"},
  {"case":"duplicate_turn_order_conflict","contextType":"committed_graph","idempotencyCount":2,"storedTurnOrders":[1,2],"outcome":"corrupt_authoritative_graph"},
  {"case":"attempt_owned_by_two_plans","contextType":"committed_graph","successfulAttemptId":"reaction-attempt-1","planIds":["reaction-plan-1","reaction-plan-2"],"outcome":"authoritative_identity_conflict"},
  {"case":"cleanup_pending","contextType":"committed_graph","coordinatorPresent":true,"tombstonePresent":false,"outcome":"valid"},
  {"case":"cleanup_complete","contextType":"committed_graph","coordinatorPresent":false,"tombstonePresent":true,"outcome":"valid"},
  {"case":"tombstone_evicted","contextType":"committed_graph","coordinatorPresent":false,"tombstonePresent":false,"outcome":"valid"}
]
```

The `coordinatorPresent` and `tombstonePresent` members above describe the scenario harness only; they are not members of `NpcReactionCommittedGraphReferenceContext` and cannot affect its result.

#### Runtime Alignment handoff and future tests

Runtime Contract Alignment must preserve the plan, preparation-binding, delta, and commit-result schemas; make `successfulAttemptId` required in schema-only plan validation; reject extra plan `requestFingerprint`/`turnOrder`; reject extra binding `resultingStateVersion`; compare pre-commit resulting version only through plan/delta; compare pre-commit fingerprint/order through candidate/binding/delta owners; compare post-commit successful attempt through plan/idempotency; treat post-commit fingerprint and turn order as idempotency-owned, with turn order having no second owner; validate post-commit versions through plan/idempotency/result/publication; and keep committed validation coordinator/tombstone independent. It must not alter candidate validation's active rejection set.

Future tests cover schema-only valid/missing/invalid attempt, exact `+1`, no-context use, and forbidden extra plan fields; pre-commit exact equality plus missing/malformed/mixed context, binding/delta absence, wrong attempt/fingerprint/order/version, and the real `reactionAttemptId` name; and post-commit attempt/fingerprint/order/version integrity, missing/duplicate idempotency, same-key differing fingerprint/order, duplicate attempt ownership, cleanup-pending/complete/tombstone-evicted validity, and validity without a coordinator root. Retrieval and validation never supplement an old fixture or infer a missing field.

### Engine-owned known-information projection

`buildNpcKnownInformationProjection(actorId, triggerId, snapshot)` is a pure browser-engine function used by both browser and CLI flows before provider invocation. For one immutable snapshot it is deterministic, ordered, bounded, non-mutating, and independently testable. It lives with engine/domain projection code, not in the server or display adapters.

The strict projection contains four allowlisted groups:

| Group | Examples | Rule |
| :--- | :--- | :--- |
| Public | day/phase, public participant ID/display name/alive status, public events, claims, votes, executions, attack deaths, and the triggering public player input | visible to all; copied from structured authoritative records only |
| Actor-private | acting NPC's own role/team, own rule-granted investigation results, own vote history, own suspicion scores, and explicitly actor-owned known facts | may influence validation/proposal only; each fact carries an engine disclosure policy and is never automatically published |
| Engine-derived constraints | `allowedTargetIds`, allowed candidate kinds, legal claim/result values, disclosure permissions, and bounded reference IDs | computed by engine rules; provider cannot expand them |
| Presentation hints | allowlisted personality/speech-style identifiers needed by a later renderer | may affect presentation intent only and cannot create effects |

`NpcKnownInformationProjection` requires exactly `schemaVersion: 1`, `projectionType: "npc_known_information"`, `public`, `actorPrivate`, `constraints`, and `presentation`. Its nested objects are exact:

- `public` requires `day: safe integer >= 0`, `phase: GamePhase`, `participants: NpcPublicParticipantProjection[2..16]`, `events: PublicEventProjection[0..64]`, `claims: ClaimProjection[0..64]`, `votes: PublicVoteProjection[0..32]`, `executions: ExecutionProjection[0..16]`, `attackDeaths: AttackDeathProjection[0..16]`, and one strict `triggeringInput`.
- `triggeringInput` requires `schemaVersion: 1`, `inputRecordId: ID`, `requestId: ID`, `correlationId: ID`, `turnId: ID`, `capturedStateVersion: safe integer >= 0`, `actorId: "player"`, `rawText: string[1..2000 Unicode code points]`, and `locale: SupportedLocale`.
- `NpcPublicParticipantProjection` requires exactly `participantId: ID`, `displayName: string[1..80 Unicode code points]`, and `publicStatus: "alive" | "dead"`.
- `actorPrivate` requires `actorId: ID`, `ownRole: GameRole`, `ownTeam: "village" | "werewolf"`, `investigationResults: NpcInvestigationResultProjection[0..16]`, `voteHistory: NpcVoteHistoryProjection[0..32]`, and `suspicionScores: NpcSuspicionScoreProjection[0..16]`.
- `NpcInvestigationResultProjection` requires exactly `day: safe integer >= 0`, `targetId: ID`, `result: ClaimResult`, and `disclosurePolicy: "engine_policy_required"`. `NpcVoteHistoryProjection` requires exactly `day: safe integer >= 0` and `targetId: ID`. `NpcSuspicionScoreProjection` requires exactly `targetId: ID` and finite `score: number`.
- `constraints` requires exactly unique `allowedTargetIds: ID[0..16]`, unique `allowedLivingTargetIds: ID[0..16]`, unique `allowedResultTargetIds: ID[0..16]`, `allowedCandidateKinds` equal in order to `["role_claim", "result_claim", "vote_declaration", "suspicion"]`, unique `allowedClaimRoles: ClaimableRole[0..1]`, unique `allowedResultValues: ClaimResult[0..2]`, unique `allowedReferenceIds: ID[0..161]`, and `roleDisclosurePolicy: NpcRoleDisclosurePolicy`.
- `presentation` requires exactly `speechStyleId: string[1..32 Unicode code points]`.

Every nested object has `additionalProperties: false`, no value is optional or nullable, and all arrays are dense. Participant, event, claim, vote, execution, and attack-death primary IDs are unique. Investigation results are unique by `(targetId, day)`, suspicion scores by target, and every constraint array is duplicate-free. `allowedTargetIds` equals all non-actor, non-player public participant IDs; `allowedLivingTargetIds` equals the alive subset; and `allowedResultTargetIds` equals the unique targets projected from actor-owned investigation facts. For a seer with at least one such fact, `allowedResultValues` equals the unique projected result values; for every other actor it is `[]`. `allowedReferenceIds` equals, without omission or addition, the union of projected event, claim, vote, execution, attack-death, and triggering-input IDs. Claim-event and vote-event references obey section 15 integrity rules.

The engine builds participants in participant-ID order, public structured records in authoritative order, actor-private facts in their documented deterministic order, and constraint arrays from those ordered sources. A validator preserves those arrays; it never sorts provider-facing input after construction. The root must contain both the player participant and the alive actor participant, `public.phase` is `player_question`, and the exact trigger/result/input/version graph is revalidated before request construction.

Never exposed are another participant's hidden role/team/result, another actor's private memory or suspicion, secret actions, unrestricted game-state objects, pending/idempotency registries, validation internals, prompts, credentials, provider bodies/diagnostics, or developer logs. The full state is never sent with an instruction to ignore private fields. Free-form legacy `publicInfo` without authoritative structured provenance is not promoted into the Phase 6 projection.

The projection's `roleDisclosurePolicy` is `NpcRoleDisclosurePolicy`, not an arbitrary string. Initial Phase 6 always emits all four `NpcReactionProposalType` values in the order above. `allowedClaimRoles` is exactly `["seer"]` only for a seer actor with at least one actor-owned investigation result and is otherwise exactly `[]`. These projection lists are necessary allowlists, never standalone permission or truth proofs.

A candidate referencing hidden information must be authorized against the captured actor-private projection and disclosure policy. Unauthorized result claims or targets are rejected. Authorized private information may justify an engine-created structured claim only under the applicable game rule; otherwise it may influence a future prose variant but cannot mutate state or be represented as public fact.

### Identity, idempotency, and terminal retention

The reaction idempotency key is `(gameSessionId, reactionPlanId, requestId)` with exact `requestFingerprint`. `correlationId` is checked for equality but is not part of the key. Attempt response deduplication additionally uses `(reactionAttemptId, candidateFingerprint)`. An exact committed replay is resolved before provider work and therefore never invokes candidate validation. For a raw response that does enter the pure validator, section 25A's exact stages 0 through 18 control precedence: transport/envelope/request-fingerprint/binding checks, logical identity conflict, stale applicability, candidate structure/fingerprint, observed duplicate/conflict, authorization, and final applicability. This is the exact interpretation of the cases in the matrix below. None of these read/classification paths commits or increments a version.

| Case | Required classification | State-machine/result behavior |
| :--- | :--- | :--- |
| same logical ID, request ID, and request fingerprint | `idempotent replay` when a commit result exists; otherwise `duplicate` while the logical request is already active/terminal without commit | return stored commit only in the first case; no provider, publication, transition, or increment |
| same logical ID and request ID, different request fingerprint | `identity conflict` (`idempotency_conflict`) | active logical reaction becomes `rejected` if this is its first terminal conflict; otherwise retain terminal status |
| same logical ID, different request ID | `identity conflict` | reject both attempted aliasing and replay; no new logical reaction |
| different logical ID, same request ID | `identity conflict` | reject request-ID reuse; no new logical reaction |
| different logical ID, same trigger identity | `identity conflict` in initial one-reaction-per-trigger Phase 6 | reject the second logical reaction; future multi-NPC design must introduce an explicit actor-order key before changing this rule |
| multiple responses for one attempt ID, same observed candidate fingerprint | `duplicate` (`duplicate_response`) | first accepted response controls; later copies cause no transition |
| multiple responses for one attempt ID, different observed candidate fingerprint | `invalid` response (`attempt_response_conflict`) | attempt/logical reaction become `rejected` only when not already terminal; terminal state is retained otherwise |
| late response from `timed_out`, `failed`, `rejected`, or `aborted` attempt with no prior candidate fingerprint | `duplicate` after strict candidate reconstruction/fingerprinting | suppress delivery and retain terminal attempt/logical status; do not store the newly computed fingerprint |
| late response from a terminal attempt with a prior candidate fingerprint | same fingerprint is `duplicate_response`; different fingerprint is `attempt_response_conflict` | hard live stale dimensions take precedence; otherwise retain any existing terminal state |
| late result from a winning or losing compatible terminal attempt after logical `committed` | terminal-repeat classification above | return/suppress against stored commit; never publish again |
| late result for logical `exhausted`, `rejected`, or explicit `cancelled` with unchanged hard live dimensions | terminal-repeat classification above | retain the exact logical terminal status |
| late result for logical `superseded`, or after reset/session/turn/phase/version/actor/trigger/current-attempt change | `stale` (`stale_request`) before fingerprint comparison | retain terminal/current state; stage 14 does not execute |
| response whose actor ID alone differs | `invalid` | attempt `rejected`, logical `rejected`; no actor substitution |
| provider response whose echoed base version alone differs from request/pending | `invalid` (`binding_mismatch`) | attempt/logical reaction reject under the non-retryable binding rule unless already terminal |
| live current version differs from its status-aware uncommitted/committed baseline | `stale` | attempt `aborted` with `stale_result`, logical `superseded`, unless an existing terminal state must be retained |

`rejected` in the table is a logical terminal transition caused by an `identity conflict` or `invalid` classification; those terms are not synonyms. `stale` means a hard live applicability dimension no longer matches or the logical reaction is `superseded`; terminal status alone is not stale. `duplicate` means an already observed/terminal operation is being delivered again. `idempotent replay` is reserved for an exact committed operation and returns its stored result. Every row has commit count `0` and version increment `0` for the repeated/conflicting input.

For a committed logical reaction, phase/version matching is status-aware: the authoritative plan/result plus committed-delta metadata must prove that the current values are the exact resulting phase and `N+2` of the same request whose precondition was the candidate request's phase and `N+1`. That transition is not an unrelated stale mutation. Any later or differently owned phase/version value remains stale and precedes duplicate comparison.

#### Session-bounded tombstone registry

After a logical entry reaches a terminal status, one coordinator control-root transaction stages a compact `ReactionTombstone` before removing that logical entry, its attempts, and its reservation in the same detached replacement. The tombstone contains only `gameSessionId`, `reactionPlanId`, `requestId`, `requestFingerprint`, `correlationId`, trigger ID, actor ID, base version, terminal logical status, all bounded attempt IDs with terminal attempt status and candidate fingerprint when one exists, terminal order, and either the committed result ID or a normalized non-commit reason. It contains no raw candidate, projection, provider body, private fact, display text, or sink state.

Committed lookups first verify the authoritative `NpcReactionPlan`/`NpcReactionCommitResult`; their IDs and fingerprint must exactly match the tombstone. Tombstones for `rejected`, `cancelled`, `exhausted`, and `superseded` have no authoritative commit target and only suppress late/reused identities. History records remain authoritative/non-consuming read data and are never reconstructed from tombstones; tombstones remain non-authoritative coordinator control data and never become history.

The combined reservation-plus-tombstone capacity is exactly `1024`; each tombstone stores no more attempt summaries than configured finite `maxAttempts`. A tombstone remains until it is the unique minimum-`terminalOrder` tombstone selected for atomic eviction by a successful later complete planned-logical creation, or until reset/destruction clears the coordinator. Reservations are never evicted. If all 1024 entries are reservations, creation returns `terminal_capacity_exhausted` before projection or ID allocation. If terminal order is exhausted, creation returns `terminal_order_exhausted` before capacity eviction or ID allocation. Reset first aborts coordinator-owned provider/backoff/timer work and makes old-session callbacks stale, then destroys the complete `NpcReactionCoordinatorControlRoot`, including logical reactions, attempts, reservations, tombstones, and terminal order. The new session creates a different empty root with all four registries empty and `nextTerminalOrder: 0`; no old-session callback can insert into it. Lookup, terminalization, eviction, capacity/order failure, replay, cleanup, and destruction change `stateVersion` by `0`. Persistence, reload reconstruction, and cross-tab sharing are explicitly unsupported.

### Retry, timeout, stale, and duplicate policy

#### Design invariants

- A retry remains under the same `reactionPlanId`, request/correlation/trigger/binding/fingerprint/base/projection and creates a fresh `reactionAttemptId`.
- Attempt count and logical deadline are finite; changing their policy values cannot remove either bound.
- A terminal attempt is never reopened. A committed, rejected, superseded, cancelled, or exhausted logical reaction is never retried.
- A complete authoritative committed graph suppresses provider/attempt retry even when cleanup failure leaves the published control root at `active + validated`; only exact replay and separately invoked coordinator cleanup are allowed.
- Retry never relaxes transport, structural, semantic, privacy, or final compare-and-commit validation; every retry that reaches `validated` must pass the same final live CAS before commit.
- Retry never switches to legacy fallback, rolls back the player `N+1`, or adds hidden authoritative information to the provider projection.
- The Phase 6 candidate server performs no hidden provider retry. One engine attempt maps to one provider invocation so attempt identity and accounting remain complete.
- Timeout aborts the exact attempt signal and every late result is classified by the matrix above. Backoff, provider work, listeners, and timers share the logical-reaction AbortSignal and are cleaned at terminal completion/cancellation.

Only explicitly transient network/unavailable failures and timeout are retryable. Authentication failure, malformed or unsupported schema, correlation/identity/actor mismatch, authorization or semantic rejection, stale applicability, duplicate delivery, and idempotency conflict are non-retryable. If the authoritative base no longer equals captured `N+1`, the attempt becomes `aborted`, the logical reaction becomes `superseded`, and it is never regenerated against a new version under the same logical ID.

#### Initial tunable policy

| Policy | Initial value | Contract status |
| :--- | :--- | :--- |
| `maxAttempts` | `3` including the first attempt | tunable finite operational policy, not a protocol invariant |
| retry backoff | `1 second`, then `2 seconds` | tunable bounded operational policy using injected clock/delay/timeout |
| logical deadline | `15 seconds` from first attempt start | tunable finite operational policy |

No runtime configuration is added by this docs-only change. A later policy/configuration change may adjust these values within finite implementation bounds without changing authority, identity, validation, no-fallback, transaction, or version invariants. Existing section 24 policy for Interpreter and Renderer remains unchanged and does not authorize Phase 6 server-side hidden retries.

### Authoritative record and field classification

The existing `NpcReactionPlan` is the authoritative structured NPC reaction record; Phase 6 does not add a second competing aggregate. It is committed atomically with engine-created claims/events/effects, one NPC publication record, the idempotency record, and `NpcReactionCommitResult`. The following classification resolves the candidate field evaluation:

| Candidate field | Decision |
| :--- | :--- |
| schema version, logical reaction ID, successful attempt ID, trigger/input/turn IDs, actor ID, base/resulting versions | authoritative, engine assigned or verified; stored in plan/result graph |
| target IDs and reaction kind | authoritative only through validated engine-created descriptors; `renderMode` plus descriptors is the reaction kind |
| structured state effect | authoritative only as closed engine-derived claims/events/deltas; arbitrary provider patches are prohibited |
| validated display text | excluded; canonical text is derived from committed segments and local context, while controlled prose remains Phase 7 engine-owned variant selection |
| provider metadata, latency, rejected attempt IDs, timeout reason | redacted diagnostics only; never in authoritative plan/effects |
| created/committed timestamp | diagnostic only; authoritative ordering uses existing `createdAtOrder`, publication slot/order, turn order, and versions |
| validation outcome | rejected outcomes are diagnostic; existence of a committed plan/result is the authoritative successful outcome |
| feature-flag/source mode | deployment observation only; not authoritative state. `renderMode` records the presentation contract, not flag state |
| delivery/publication status | separate publication-controller state; never part of reaction commit authority |

Design-only, non-runtime example of the canonical plan shape:

```json
{
  "schemaVersion": 1,
  "requestId": "reaction-request-1",
  "correlationId": "correlation-1",
  "causationId": "player-commit-request-1",
  "originatingInputRecordId": "player-input-1",
  "locale": "ja-JP",
  "causationEventIds": [],
  "reactionPlanId": "reaction-plan-1",
  "successfulAttemptId": "reaction-attempt-2",
  "turnId": "turn-1",
  "preconditionStateVersion": 12,
  "resultingStateVersion": 13,
  "npcId": "npc-1",
  "renderMode": "canonical_only",
  "intendedSpeechActs": [
    {
      "descriptorId": "descriptor-1",
      "descriptorType": "vote_declaration",
      "targetId": "npc-2"
    }
  ],
  "policies": {
    "policyType": "reaction_policies",
    "allowStateChanges": true,
    "allowClaims": false,
    "allowVoteDeclaration": true,
    "allowSuspicionUpdate": false,
    "allowMemoryUpdate": false
  },
  "canonicalSegments": [
    {
      "segmentId": "segment-1",
      "descriptorId": "descriptor-1",
      "type": "canonical_vote",
      "voteEventId": "vote-event-1"
    }
  ],
  "maxChars": 1000
}
```

### Publication, delivery, history, and observers

Reaction commit and display delivery are distinct. A canonical Phase 6 commit appends exactly one `NpcCanonicalUtterancePublishedRecord` in the same `N+1 -> N+2` transaction. Only that committed publication can enter Phase 6 live NPC delivery. Delivery never creates, replaces, or repairs an authoritative plan, result, claim, event, publication, counter, turn, phase, or version. Re-publication and a second publication slot are prohibited.

#### Delivery ownership and non-ownership

Each active `WerewolfGame` session owns exactly one session-local `NpcPublicationDeliveryController`. It is distinct from `PlayerPublicationDeliveryController` and shares no attempt, generation, acknowledgement, cutover, receipt, retry, or observer state with the Phase 5 player controller. It owns live discovery, head-of-line ordering, attempt identity and state, timeout/abort handles, controller capabilities, receipts, acknowledgements, retry tokens, duplicate suppression, reset invalidation, and redacted delivery observations. All of those values are nonauthoritative runtime state.

The engine-owned pure canonical renderer owns deterministic reconstruction of canonical display payloads from the committed publication, matching reaction plan, committed claims/events, stored locale, stored `canonicalRendererVersion`, ordered canonical segment IDs, and a strict local-only `CanonicalRenderingContext`. It neither owns delivery state nor performs a sink write. It never reads the provider candidate or current UI locale and never calls the AI Renderer.

The trusted browser and CLI delivery wrappers own only their concrete sink operations and exact sink bookkeeping. The browser owns safe DOM-node construction, attachment to the intended conversation container, and rollback of an unproved attachment. The CLI owns one configured synchronous or awaited writer invocation. Neither adapter discovers eligibility, constructs receipt identity, acknowledges by inference, retries a provider, or mutates authoritative state.

The coordinator may request explicit delivery discovery after an eligible non-replay command or through a delivery-only pump, but it does not render, write, acknowledge, or infer success. The AI Renderer, candidate provider, server, HTTP endpoint, observers, history readers, replay readers, diagnostics, and snapshots never own delivery and never receive a delivery capability, receipt, acknowledgement, or retry token. Phase 6 does not activate `RendererRequest`, `PendingRendererRequest`, controlled-commentary reservation/finalization, or any Renderer provider call; those remain Phase 7 responsibilities.

#### Eligibility, discovery, and the canonical delivery payload

An NPC publication is Phase 6 live-eligible only when all of the following hold: it is an authoritative `NpcCanonicalUtterancePublishedRecord`; the matching canonical-only plan, commit result, claims/events, segment graph, session, actor, locale, renderer version, slot, and reaction-resulting version validate exactly; the publication belongs to the current session; it has no stored publication-level acknowledgement; and no earlier displayable NPC slot remains unacknowledged or terminally unresolved. `NpcUtterancePublicationReserved` is never eligible. `NpcUtterancePublicationFinalized` remains ineligible until Phase 7 defines and activates controlled delivery.

The controller has exactly one current consumer registration. It is created with `consumerGeneration: 0` and one fixed `(consumerId, sinkType)` chosen by the local browser or CLI instance. Explicit consumer replacement is permitted only through the controller while no current attempt is `prepared`, `in_flight`, or `sink_succeeded`. Browser and CLI cannot coexist as consumers of one session.

Consumer replacement is one detached controller-root transaction. Before staging, the controller validates the proposed consumer identity, safe generation increment, every current-record/attempt edge, retained attempt bound, and absence of an active sink-success capability. In the detached root it then performs the following exact operations:

1. Each current `pending` record is rebound to the new consumer ID, generation, and sink type without creating an attempt.
2. Each current `failed_retryable` record resolves its exact old attempt, changes that retained attempt to `abandoned` with `abandonedFromState: "failed_retryable"`, deletes its `repeat_sink` retry token and invalidates every old capability, timer, and abort handle, then replaces only the current publication record with a new-consumer `pending` record whose `currentAttemptId` is null.
3. Every `acknowledged` or `failed_terminal` current record, its attempt, receipt/acknowledgement if any, and its original consumer identity remain byte-for-byte unchanged and continue to suppress discovery. No such terminal record is rebound.
4. The root consumer generation increments exactly once, the complete detached graph is revalidated, and the controller root is replaced exactly once. Failure before replacement preserves the old root, counters, tokens, handles, and observer state byte-for-byte.

The abandoned old attempt remains in `attemptsById`; it is not overwritten by the new `pending` record. A later attempt number is one plus the number of retained attempts for that publication and never exceeds 3, so consumer replacement does not reset the attempt budget. The old generation's callbacks, receipts, retry tokens, and capabilities fail closed by exact session, consumer, generation, sink, publication, and attempt identity; retained attempts make old-generation rejection and attempt-ID collision detection possible. Replacement emits exactly one `npc_publication_delivery_abandoned` outcome for each transformed retryable attempt and, after the root replacement, exactly one `npc_delivery_consumer_replaced` outcome. Observer failure is isolated. Consumer replacement never changes authoritative state/version and never invokes render, sink, acknowledgement, history, provider, or Renderer work.

`discoverPendingNpcPublications(input)` is a synchronous non-consuming controller operation over authoritative publication state. Its strict input requires exactly `schemaVersion: 1`, `gameSessionId: ID`, `consumerId: ID`, `consumerGeneration: non-negative safe integer`, `sinkType: "browser" | "cli"`, `afterPublicationSlotOrder: null | non-negative safe integer`, and `limit: integer 1..32`, with `additionalProperties: false`. It may materialize a missing `pending` controller record exactly once but never writes authoritative state. It returns frozen `NpcPublicationDeliverySummary` values in ascending `publicationSlotOrder`; repeated retrieval is idempotent. Only the lowest unresolved publication is preparable. The cursor is pagination only, not acknowledgement or a delivery cursor, and cannot hide an older pending publication.

`NpcPublicationDeliverySummary` requires exactly `schemaVersion: 1`, `summaryType: "npc_publication_delivery"`, `gameSessionId: ID`, `publicationId: ID`, `reactionPlanId: ID`, `actorId: ID`, `publicationSlotOrder: non-negative safe integer`, `recordAppendOrder: non-negative safe integer`, `consumerId: ID`, `consumerGeneration: non-negative safe integer`, `sinkType: "browser" | "cli"`, `state: "pending" | "failed_retryable" | "sink_succeeded"`, `currentAttemptId: null | ID`, and `retryTokenId: null | ID`, with `additionalProperties: false`. Both IDs are null for `pending`; both are set for `failed_retryable` and `sink_succeeded`. Acknowledged, terminal, abandoned, and non-head entries are not returned as live candidates.

`prepareNpcPublicationDelivery(input)` is the only preparation entrypoint. Its strict input requires exactly the discovery identity plus `publicationId: ID`; `afterPublicationSlotOrder` and `limit` are absent. It reserves one runtime attempt key and returns one frozen `NpcPublicationDeliveryRequest`. Preparation is synchronous and pure with respect to authoritative state.

`NpcCanonicalDeliveryPayload` requires exactly:

- `schemaVersion: 1`
- `payloadType: "npc_canonical_utterance"`
- `publicationId: ID`
- `reactionPlanId: ID`
- `reactionCommitRequestId: ID`
- `turnId: ID`
- `reactionResultingStateVersion: integer >= 1`
- `actorId: ID`
- `locale: SupportedLocale`
- `canonicalRendererVersion: integer >= 1`
- `canonicalSegmentIds: ID[1..16]`, unique and in plan order
- `displayText: string[1..1000 Unicode code points]`
- `payloadFingerprint: Sha256Fingerprint`
- `additionalProperties: false`

The canonical renderer reconstructs a detached payload, checks `displayText` against the plan `maxChars`, computes `payloadFingerprint = sha256CanonicalJson(payload without payloadFingerprint)`, and recursively freezes the result. `displayText` is runtime-only and is not appended to the publication ledger or supplied by a caller. Browser/CLI callers cannot override text, locale, actor, segment order, or presentation metadata. A render failure before a sink makes the publication `failed_terminal` for that session and consumer generation; it is never rerouted to legacy text or the AI Renderer.

`NpcPublicationDeliveryRequest` requires exactly `schemaVersion: 1`, `gameSessionId: ID`, `consumerId: ID`, `consumerGeneration: non-negative safe integer`, `sinkType: "browser" | "cli"`, `deliveryAttemptId: ID`, `deliveryAttemptOrder: non-negative safe integer`, `attemptNumber: integer 1..3`, `publicationSlotOrder: non-negative safe integer`, `recordAppendOrder: non-negative safe integer`, and `payload: NpcCanonicalDeliveryPayload`, with `additionalProperties: false`. The controller, not the adapter, allocates `deliveryAttemptId` and attempt order. The request is a frozen runtime value and is never a provider/HTTP request.

#### Delivery record, receipt, acknowledgement, and retry token

`NpcPublicationDeliveryControllerRoot` requires exactly `schemaVersion: 1`, `gameSessionId: ID`, `consumer: NpcPublicationDeliveryConsumer`, `invalidated: boolean`, `nextDeliveryAttemptOrder: non-negative safe integer`, `nextSinkStartedOrder: non-negative safe integer`, `nextSinkSucceededOrder: non-negative safe integer`, `nextAcknowledgedOrder: non-negative safe integer`, `currentRecordsByPublicationId: read-only index of NpcPublicationDeliveryRecord[0..1024]`, `attemptsById: read-only index of NpcPublicationDeliveryAttemptRecord[0..3072]`, `acknowledgementsByPublicationId: read-only index of NpcPublicationDeliveryAcknowledgement[0..1024]`, and `retryTokensById: read-only index of NpcPublicationDeliveryRetryToken[0..1024]`, with `additionalProperties: false`. `NpcPublicationDeliveryConsumer` requires exactly `consumerId: ID`, `consumerGeneration: non-negative safe integer`, and `sinkType: "browser" | "cli"`. Index keys equal their embedded IDs; foreign, duplicate, dangling, or cross-session members are invariant failures. Controller capabilities, timers, abort handles, and concrete sink bookkeeping are runtime handles outside the data root but are invalidated atomically with it.

`NpcPublicationDeliveryRecord` is the current publication-level state and requires exactly `schemaVersion: 1`, `gameSessionId: ID`, `publicationId: ID`, `consumerId: ID`, `consumerGeneration: non-negative safe integer`, `sinkType: "browser" | "cli"`, `publicationSlotOrder: non-negative safe integer`, `recordAppendOrder: non-negative safe integer`, `state: NpcPublicationDeliveryState`, and `currentAttemptId: null | ID`, with `additionalProperties: false`. `pending` has a null attempt ID. Every other state has a non-null attempt ID resolving to one exact `attemptsById` member whose publication, consumer identity, and state equal the current record. Terminal acknowledged/failure records retain the consumer identity that produced them; they are not rebound during consumer replacement.

`NpcPublicationDeliveryAttemptRecord` requires exactly `schemaVersion: 1`, `gameSessionId: ID`, `publicationId: ID`, `consumerId: ID`, `consumerGeneration: non-negative safe integer`, `sinkType: "browser" | "cli"`, `deliveryAttemptId: ID`, `deliveryAttemptOrder: non-negative safe integer`, `attemptNumber: integer 1..3`, `publicationSlotOrder: non-negative safe integer`, `recordAppendOrder: non-negative safe integer`, `state: "prepared" | "in_flight" | "sink_succeeded" | "failed_retryable" | "failed_terminal" | "acknowledged" | "abandoned"`, `abandonedFromState: null | "prepared" | "in_flight" | "sink_succeeded" | "failed_retryable"`, `payloadFingerprint: Sha256Fingerprint`, `sinkStartedOrder: null | non-negative safe integer`, `sinkSucceededOrder: null | non-negative safe integer`, `acknowledgedOrder: null | non-negative safe integer`, `failure: null | NpcPublicationDeliveryFailure`, `receiptId: null | ID`, and `retryTokenId: null | ID`, with `additionalProperties: false`. Every allocated attempt remains in `attemptsById` until session reset; it is never overwritten, reused, or evicted. At most three attempts exist for one publication. Runtime orders are zero-based safe integers owned by the NPC controller and share no value or counter with authoritative publication or terminal orders. Each next-order counter advances exactly once with successful creation of its corresponding record transition; failure before that transition leaves no gap.

The controller retains at most 1024 current publication records and 3072 attempt records. Capacity is checked before publication-state materialization, attempt ID allocation, order allocation, or consumer replacement staging. Exhaustion throws `npc_delivery_capacity_exhausted` and changes no record, attempt, token, capability, counter, or observer state. There is no attempt eviction because retained identity is required to reject old callbacks and ID reuse. Reset is the only operation that discards retained attempts.

`NpcPublicationDeliveryState` is the closed enum `pending | prepared | in_flight | sink_succeeded | failed_retryable | failed_terminal | acknowledged | abandoned`. `pending` is derived and inserted when an eligible committed publication first enters controller discovery; `prepared` means the exact payload and attempt reservation exist; `in_flight` means the trusted wrapper consumed the controller-issued begin capability; `sink_succeeded` means the exact sink boundary completed and one receipt exists; `acknowledged` means that receipt was accepted; `failed_retryable` means a proved no-visible-effect sink failure permits a fresh attempt; `failed_terminal` means canonical reconstruction, retry exhaustion, or ambiguous sink outcome forbids automatic replay; and `abandoned` terminalizes an old attempt during consumer replacement or reset without acknowledging its publication.

The attempt-field matrix is normative:

| State | Started | Sink success | Ack | Failure | Receipt | Retry token | `abandonedFromState` |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `prepared` | null | null | null | null | null | null | null |
| `in_flight` | set | null | null | null | null | null | null |
| `sink_succeeded` | set | set | null | null | set | `ack_only` | null |
| `failed_retryable` | set | null | null | retryable transport | null | `repeat_sink` | null |
| `failed_terminal` | null or set | null | null | resolution, ambiguous transport, or exhaustion | null | null | null |
| `acknowledged` | set | set | set | null | set | null | null |
| `abandoned` | preserved from source | preserved only when source was `sink_succeeded` | null | preserved or null | preserved only when source was `sink_succeeded` | null | exact source state |

No other nullability combination is valid. Consumer replacement retains an abandoned old attempt while publishing a new `pending` current record for the same publication; therefore an abandoned attempt need not be referenced by `currentRecordsByPublicationId`. Reset may abandon `prepared`, `in_flight`, `sink_succeeded`, or `failed_retryable`; `failed_terminal` and `acknowledged` are already terminal and are simply destroyed with the old root.

`NpcPublicationSinkSuccessReceipt` requires exactly `schemaVersion: 1`, `receiptType: "npc_sink_success"`, `receiptId: ID`, `gameSessionId: ID`, `publicationId: ID`, `consumerId: ID`, `consumerGeneration: non-negative safe integer`, `deliveryAttemptId: ID`, `deliveryAttemptOrder: non-negative safe integer`, `attemptNumber: integer 1..3`, `sinkType: "browser" | "cli"`, `payloadFingerprint: Sha256Fingerprint`, and `sinkSucceededOrder: non-negative safe integer`, with `additionalProperties: false`. It is an opaque frozen object created and retained by the controller only after the exact attempt is `in_flight` and the trusted completion capability is returned. A caller-created, cloned, changed, cross-attempt, cross-sink, or cross-session receipt is invalid even if its fields are equal.

`NpcPublicationDeliveryAcknowledgement` requires exactly `schemaVersion: 1`, `acknowledgementType: "npc_publication_acknowledged"`, `gameSessionId: ID`, `publicationId: ID`, `consumerId: ID`, `consumerGeneration: non-negative safe integer`, `deliveryAttemptId: ID`, `deliveryAttemptOrder: non-negative safe integer`, `attemptNumber: integer 1..3`, `sinkType: "browser" | "cli"`, `receiptId: ID`, `payloadFingerprint: Sha256Fingerprint`, and `acknowledgedOrder: non-negative safe integer`, with `additionalProperties: false`. It is a controller-private stored result keyed by `(gameSessionId, publicationId)`. It is not authoritative history and does not survive session destruction. Consumer replacement never makes an acknowledged publication live again.

`NpcPublicationDeliveryRetryToken` requires exactly `schemaVersion: 1`, `tokenType: "npc_delivery_retry"`, `retryTokenId: ID`, `gameSessionId: ID`, `publicationId: ID`, `consumerId: ID`, `consumerGeneration: non-negative safe integer`, `deliveryAttemptId: ID`, `deliveryAttemptOrder: non-negative safe integer`, `attemptNumber: integer 1..3`, `sinkType: "browser" | "cli"`, `payloadFingerprint: Sha256Fingerprint`, and `retryKind: "repeat_sink" | "ack_only"`, with `additionalProperties: false`. The controller alone issues and retains it. `repeat_sink` is valid only after a proved no-visible-effect `failed_retryable` outcome and creates a fresh `deliveryAttemptId` with the next attempt number; `ack_only` is created by successful sink completion, not by a transport failure, and reuses the exact retained receipt without invoking the renderer or sink. Tokens are one-session capabilities, are invalidated by their successful next step, consumer replacement, or reset, and are never serialized, exposed to providers/observers/history, or inferred from a publication ID.

`completeNpcPublicationSink(capability)` returns a frozen `NpcPublicationSinkCompletion` requiring exactly `schemaVersion: 1`, `status: "sink_succeeded"`, `receipt: NpcPublicationSinkSuccessReceipt`, and `retryToken: NpcPublicationDeliveryRetryToken` with `retryKind: "ack_only"`, with `additionalProperties: false`. `recordNpcPublicationSinkFailure(capability, failureEvidence)` returns a frozen `NpcPublicationSinkFailureResult` requiring exactly `schemaVersion: 1`, `status: "failed_retryable" | "failed_terminal"`, `failure: NpcPublicationTransportFailure`, and `retryToken: null | NpcPublicationDeliveryRetryToken`, with `additionalProperties: false`; the token is present exactly for `failed_retryable` and has `retryKind: "repeat_sink"`.

`getNpcPublicationDeliveryRetryToken(input)` requires exactly `schemaVersion: 1`, `gameSessionId: ID`, `publicationId: ID`, `consumerId: ID`, `consumerGeneration: non-negative safe integer`, `sinkType: "browser" | "cli"`, `deliveryAttemptId: ID`, `deliveryAttemptOrder: non-negative safe integer`, `attemptNumber: integer 1..3`, `payloadFingerprint: Sha256Fingerprint`, and `retryTokenId: ID`, with `additionalProperties: false`. It returns only the controller-retained exact token. Publication-ID-only lookup and caller-created/cloned/changed tokens are forbidden. `retryNpcPublicationDelivery(token)` accepts only that retained capability: `repeat_sink` consumes the token and returns a new frozen `NpcPublicationDeliveryRequest` with a fresh attempt ID/order and the next attempt number; `ack_only` calls acknowledgement with the retained exact receipt and returns the acknowledgement result without renderer, sink, history append, or authoritative mutation. Wrong session, consumer, generation, sink, publication, attempt, order, attempt number, fingerprint, token, or capability identity fails closed.

The initial retry policy is exactly three total sink attempts per publication and a 15,000 ms deadline per attempt, with no automatic backoff or hidden retry. Attempt/deadline values are controller policy, not provider policy. After attempt 3 fails without visible effect, the publication becomes `failed_terminal` with `sink_retry_exhausted`; an explicit future recovery design is required to reopen it.

#### Exact lifecycle and ordering

The Phase 6 order is exact:

1. `NpcReactionCommit` authoritatively publishes the canonical graph and one publication at `N+2`.
2. Controller discovery derives `delivery pending`; it does not write authority.
3. Preparation verifies the complete committed graph, head-of-line eligibility, consumer generation, and identity, reserves one attempt, renders the exact payload, and changes `pending -> prepared`.
4. `beginNpcPublicationSink(...)` consumes one controller capability and changes `prepared -> in_flight`.
5. The browser attaches and verifies the exact safe node, or the CLI configured writer returns/fulfills. No other event is sink success.
6. `completeNpcPublicationSink(capability)` validates exact identity, changes `in_flight -> sink_succeeded`, assigns one sink-success order, and returns the retained receipt plus its controller-issued `ack_only` token.
7. `acknowledgeNpcPublication(receipt)` accepts only that exact receipt, changes `sink_succeeded -> acknowledged`, assigns one acknowledgement order, stores the acknowledgement result, and then emits its observer outcome.
8. Only after acknowledgement may discovery expose the next publication slot.

Publication display order is ascending `publicationSlotOrder`. Delivery attempt order, sink-success order, and acknowledgement order are distinct controller counters but, because of head-of-line gating, successful first acknowledgements follow publication slot order. `recordAppendOrder` is audit order only. Canonical renderer execution occurs during preparation for the current head only. Phase 7 Renderer completion order cannot reorder delivery: a controlled slot is blocked until its finalization exists, and later slots cannot pass it. History projection is always ordered by `publicationSlotOrder` and has no append counter. Observer notification occurs after the corresponding controller transition/result is stored and never participates in ordering proof.

`NPC_STRUCTURED_REACTION_MODE` controls reaction-route selection only. Once a canonical publication commits, later flag disablement does not abandon it, make it legacy-eligible, or remove it from discovery; the controller completes or terminalizes its delivery under the captured structured route. A reaction that selected the legacy route creates no C2 publication-delivery record and is never imported into the NPC controller. Re-enabling the flag affects only a later logical reaction. There is no NPC cutover watermark, dual delivery, backfill, or flag-driven acknowledgement, and Phase 5 requested/effective player mode is not consulted.

#### Sink, timeout, abort, and retry ownership

The NPC controller owns one bounded sink deadline, one AbortController, timer cleanup, and retry eligibility for each active attempt. The browser/CLI wrapper receives only the exact attempt capability and abort signal. It may stop its own pending sink work on abort but cannot extend the deadline, create a retry, or convert an ambiguous failure into retryable evidence. Provider retry, Renderer retry, reaction retry, and delivery retry are separate domains and never call one another.

Browser success is the exact safe text node attached to and verified under the intended conversation container with controller identity bookkeeping stored on that node. Array/view-model insertion, render scheduling, paint, observer notification, or text equality is insufficient. If post-attachment bookkeeping fails, the wrapper must remove the exact node and verify removal before reporting `failed_retryable`; inability to prove removal is `failed_terminal`.

CLI success is fulfillment of the configured writer for the exact payload. A writer failure is retryable only when the writer contract proves `visibleEffect: false`; a throw/rejection after an unknown or partial write is terminal to prevent duplicate output. Prompt redraw and console buffer inspection are not proof. Sink timeout or abort is retryable only when the wrapper proves the operation produced no visible effect and completed cleanup; otherwise it is terminal.

Sink failure before success produces no receipt or acknowledgement, leaves authoritative state at `N+2`, and emits a redacted failure observation after the failure record is stored. Retry is explicit through a controller token or later delivery-only pump; no history/replay/action result implicitly retries. After sink success, every failure before acknowledgement is acknowledgement-only through the `ack_only` token created by sink completion and must never repeat rendering or output. This is not a transport-failure disposition. A terminal delivery failure does not invoke legacy NPC display, provider, Renderer, reaction preparation, or commit again.

#### Idempotency, replay, history, and acknowledgement

The delivery idempotency key is exactly `(gameSessionId, publicationId)`. One current record and at most one active attempt exist per key; all older attempts remain immutable in `attemptsById`. A fresh retry changes only `deliveryAttemptId`, `attemptNumber`, and its controller orders. Consumer replacement preserves publication-level acknowledgement/terminal suppression while invalidating old-generation attempts and capabilities and retaining their terminal identity evidence. The authoritative reaction commit idempotency key and delivery key are unrelated.

An exact duplicate acknowledgement using the retained receipt under the same current consumer generation returns the stored acknowledgement result, changes no state/order, performs no sink/history write, and emits exactly one `npc_publication_duplicate_ack_suppressed` observer outcome per duplicate API invocation. After consumer replacement, even an exact old-generation receipt is stale and cannot invoke duplicate acknowledgement; the stored acknowledgement alone continues publication-level redisplay suppression. A different current-generation receipt or payload fingerprint for an acknowledged key is `npc_acknowledgement_conflict`. Receipt lookup requires the complete receipt identity; publication-ID-only lookup is forbidden.

Reaction commit replay returns the stored commit result and never discovers, prepares, renders, sinks, acknowledges, or suppresses delivery. Delivery replay means only `repeat_sink` or `ack_only` through an exact retained retry token. History, `get_state`, diagnostics, snapshots, observer subscription, and publication lookup produce no live delivery request or token. Repeated history reads deterministically reconstruct the same canonical entry from authoritative records whether delivery is pending, acknowledged, failed, or the current consumer no longer exists. History completeness and live redisplay suppression never share one mutable set.

#### Visibility and trust classification

| Domain | Visible values | Forbidden values and authority |
| :--- | :--- | :--- |
| Authoritative | reaction plan/result, canonical claims/events/segments, `NpcCanonicalUtterancePublishedRecord`, slot/append orders, originating `N+2` | no delivery attempt, receipt, acknowledgement, retry token, DOM/CLI status, observer order, or rendered text |
| Runtime private | controller root, generation, attempt record, capabilities, deadlines, abort handles, receipt, acknowledgement, retry token, runtime orders | not serialized, not returned by public snapshots/history, no state-version authority |
| Observer visible | closed redacted outcome, session/publication/attempt IDs, consumer generation, sink type, normalized code, bounded duration/order | no payload text/fingerprint, raw candidate, prompt, projection, private fact, receipt/token/capability, stack/cause |
| History visible | deterministic canonical player-facing entry ordered by publication slot | no live envelope, acknowledgement state, retry state, receipt, observer outcome, provider/Renderer data |
| Renderer private | Phase 7 request/pending/provider result/selected variant/fallback bookkeeping only | inactive in Phase 6; never receives canonical delivery objects and never proves a sink |
| Provider private | candidate request/response and redacted provider diagnostics only | never receives publication delivery identity, payload, receipt, acknowledgement, token, DOM/CLI state, or history cursor |

#### Closed failure contracts

Public controller methods either return their strict frozen success value or synchronously throw `NpcPublicationDeliveryError`. Its exact fields are `name: "NpcPublicationDeliveryError"`, `code: NpcPublicationDeliveryErrorCode`, and fixed message `"NPC publication delivery failed"`; it stores no raw payload, receipt, provider value, free-form path, nested cause, DOM node, or private state.

`NpcPublicationDeliveryErrorCode` is the closed rejection set `npc_publication_not_found | npc_publication_not_eligible | npc_publication_already_acknowledged | npc_delivery_order_blocked | npc_delivery_in_progress | npc_delivery_not_prepared | npc_delivery_not_delivered | npc_delivery_terminal | npc_delivery_identity_conflict | npc_delivery_capacity_exhausted | sink_retry_exhausted | stale_npc_delivery_session | stale_npc_consumer_generation`.

`NpcPublicationDeliveryInvariantError` is reserved for malformed engine-owned controller/publication input. Its exact fields are `name: "NpcPublicationDeliveryInvariantError"`, `code: NpcPublicationDeliveryInvariantCode`, and fixed message `"NPC publication delivery invariant failed"`. The closed invariant set is `invalid_npc_delivery_controller_root | invalid_npc_delivery_publication_graph | invalid_npc_delivery_attempt | invalid_npc_delivery_receipt | invalid_npc_delivery_acknowledgement | npc_delivery_identity_collision | npc_delivery_order_corruption | npc_delivery_state_transition_invalid`. Invariants do not terminalize or repair authority.

`NpcPublicationDeliveryFailure = NpcPublicationResolutionFailure | NpcPublicationTransportFailure`, discriminated by `failureType`. `NpcPublicationResolutionFailure` requires exactly `schemaVersion: 1`, `failureType: "npc_delivery_resolution"`, `code: "canonical_render_failed" | "canonical_render_limit_exceeded"`, and `disposition: "terminal"`, with `additionalProperties: false`. It contains no rendered or source text. A malformed authoritative graph is an invariant, not a resolution failure.

`NpcPublicationTransportFailure` is controller-private and requires exactly `schemaVersion: 1`, `failureType: "npc_delivery_transport"`, `code: "browser_sink_container_missing" | "browser_sink_attachment_failed" | "browser_sink_bookkeeping_failed" | "cli_sink_write_failed" | "sink_timeout" | "sink_aborted" | "sink_retry_exhausted"`, and `disposition: "retry_sink" | "terminal_exhausted" | "terminal_ambiguous"`, with `additionalProperties: false`. `retry_sink` requires proof of no visible effect, complete sink cleanup, and remaining attempt budget; it produces `failed_retryable` and one `repeat_sink` token. `terminal_exhausted` is used only for `sink_retry_exhausted` when the final operation proved no visible effect but attempt 3 consumed the budget; it produces `failed_terminal` and no token. `terminal_ambiguous` requires that visible effect is unknown or removal/write rollback cannot be proved; it produces `failed_terminal` immediately and no token regardless of remaining budget. Exhaustion and visibility ambiguity are distinct evidence and never substitute for one another. No transport operation produces `retry_ack_only`; successful sink completion creates the `ack_only` token.

The failure/state/token matrix is normative:

| Operation evidence | Failure code | Disposition | Resulting state | Token | Automatic sink retry |
| :--- | :--- | :--- | :--- | :--- | :---: |
| No visible effect proved, cleanup complete, attempt 1 or 2 | exact sink/timeout/abort code | `retry_sink` | `failed_retryable` | `repeat_sink` | no |
| No visible effect proved, cleanup complete, attempt 3 | `sink_retry_exhausted` | `terminal_exhausted` | `failed_terminal` | none | no |
| Visible effect unknown or cleanup/rollback unproved, any attempt | exact sink/timeout/abort code | `terminal_ambiguous` | `failed_terminal` | none | no |
| Exact browser/CLI sink boundary succeeds | no transport failure | not applicable | `sink_succeeded` | `ack_only` | forbidden |
| Exact acknowledgement succeeds | no transport failure | not applicable | `acknowledged` | consumed | forbidden |

These examples are normative and contain no rendered content:

```json
[
  {
    "case": "consumer_replacement_after_retryable_failure",
    "before": {
      "consumerGeneration": 0,
      "currentState": "failed_retryable",
      "currentAttemptId": "attempt-1",
      "retainedAttemptIds": ["attempt-1"],
      "retryTokenIds": ["retry-1"]
    },
    "after": {
      "consumerGeneration": 1,
      "currentState": "pending",
      "currentAttemptId": null,
      "retainedAttempts": [
        {
          "deliveryAttemptId": "attempt-1",
          "state": "abandoned",
          "abandonedFromState": "failed_retryable"
        }
      ],
      "retryTokenIds": []
    },
    "authoritativeVersionDelta": 0
  },
  {
    "case": "third_no_effect_failure",
    "attemptNumber": 3,
    "visibleEffect": false,
    "code": "sink_retry_exhausted",
    "disposition": "terminal_exhausted",
    "resultingState": "failed_terminal"
  },
  {
    "case": "ambiguous_first_attempt",
    "attemptNumber": 1,
    "visibleEffect": "unknown",
    "code": "cli_sink_write_failed",
    "disposition": "terminal_ambiguous",
    "resultingState": "failed_terminal"
  },
  {
    "case": "sink_success_before_acknowledgement",
    "transportFailure": null,
    "resultingState": "sink_succeeded",
    "retryKind": "ack_only"
  }
]
```

Receipt lookup and acknowledgement methods instead synchronously throw `NpcPublicationAcknowledgementError`, with exact `name: "NpcPublicationAcknowledgementError"`, fixed message `"NPC publication acknowledgement failed"`, and closed code `npc_acknowledgement_not_delivered | npc_acknowledgement_identity_mismatch | npc_acknowledgement_conflict | stale_npc_acknowledgement_session | stale_npc_acknowledgement_generation`. It retains no receipt, payload, cause, or free-form path. A stale acknowledgement emits exactly one redacted `npc_publication_stale_ack_rejected` outcome per invocation and changes nothing. Observer failure cannot change the primary code or stored result.

#### Reset and late callbacks

Session reset first prevents new preparation, aborts every active sink and timer, marks each nonterminal attempt `abandoned` in the old controller, invokes exactly one redacted abandonment observation per active attempt, and then destroys the complete NPC delivery controller root and all capabilities, receipts, acknowledgements, retry tokens, bookkeeping, and runtime counters. Observer failure is swallowed and does not alter this sequence. Reset does not mutate the old authoritative graph before that graph is destroyed with the session and does not copy delivery state into the new session.

Every late completion, retry, receipt lookup, acknowledgement, observer callback, canonical-render callback, or adapter callback carries the old `gameSessionId` and fails closed as stale. It cannot attach to, acknowledge, suppress, reorder, or create output in the new session. If a sink became visible immediately before reset but acknowledgement did not complete, the old-session callback remains stale; no cross-session redisplay or reconciliation is attempted. Persistence/reload and multi-tab delivery coordination remain out of scope.

#### Observer outcomes

Redacted observer outcomes are exactly `reaction_planned`, `reaction_activated`, `reaction_attempt_started`, `reaction_attempt_failed`, `reaction_attempt_timed_out`, `reaction_attempt_aborted`, `reaction_candidate_rejected`, `reaction_exhausted`, `reaction_superseded`, `reaction_cancelled`, `reaction_committed`, `reaction_duplicate_suppressed`, `reaction_identity_conflict`, `npc_publication_delivery_prepared`, `npc_publication_sink_started`, `npc_publication_delivered`, `npc_publication_delivery_failed`, `npc_publication_acknowledged`, `npc_publication_duplicate_ack_suppressed`, `npc_publication_stale_ack_rejected`, `npc_publication_delivery_abandoned`, and `npc_delivery_consumer_replaced`.

Delivery observations may contain only session/publication/attempt IDs, consumer generation, normalized reason code, originating reaction version, actor ID, bounded duration, runtime order, and sink type. They exclude payload text/fingerprint, raw player/provider text, hidden facts, projection contents, prompts, credentials, private memory, receipts/tokens/capabilities, DOM nodes, and stack traces. Observer exceptions are isolated after the owning controller transition/result is stored. An observer event is never sink evidence, acknowledgement evidence, retry authorization, or history content.

#### C2 self-review closure

- Current publication state and retained attempt history are separate bounded indexes, so consumer replacement can preserve the old abandoned identity and publish a new pending state without overwrite or ambiguity.
- Old-generation attempts, receipts, tokens, capabilities, and callbacks remain exactly classifiable until reset; no bounded-retention rule permits silent eviction or attempt-ID reuse.
- Every transport disposition is reachable through a real sink operation. `ack_only` is a sink-success capability, not a transport failure.
- Retry exhaustion with proved no visible effect is `terminal_exhausted`; unknown visible effect is `terminal_ambiguous`. Both are terminal, but their machine-readable evidence is never conflated.
- Consumer replacement, delivery, retry, receipt, acknowledgement, observer, and history operations change authoritative state/version by exactly zero.
- Phase 6 does not invoke the AI Renderer, provider, server, endpoint, Phase 7 finalization, or player-delivery protocol, and no such responsibility is inferred by this contract.

### Browser and CLI responsibilities

The browser flow invokes the authoritative `WerewolfGame` coordinator to allocate identities, select the actor, project knowledge, construct requests, validate responses, perform final CAS/commit, and expose explicit committed publication history and delivery-controller APIs. `public/browserApp.mjs` remains a non-authoritative DOM adapter and feature-control surface. It cannot reconstruct a reaction from display text, discover from a history/result object, or treat DOM success as commit success. It passes only the controller-frozen payload to the sink and returns only the controller capability.

The CLI uses the same `WerewolfGame` module and process-local authoritative instance, the same projection/validation/coordinator, and the same NPC delivery controller contract. `src/cli.mjs` may frame the controller-owned `displayText` for its configured writer but cannot replace it, call a weaker provider path, apply legacy text after structured rejection, or consume delivery through history reads. Browser and CLI may differ only in the exact sink-success proof described above, not authority, retry, timeout/abort policy, validation, ordering, acknowledgement, or publication eligibility.

### Feature flag, coexistence, and rollback

The proposed deployment flag is `NPC_STRUCTURED_REACTION_MODE`, owned and evaluated by the active session's `WerewolfGame` at reaction-route selection. Its default is `false`. Browser and CLI configuration map the same flag into their separate engine instances; adapters do not evaluate an independent policy.

`PLAYER_CONVERSATION_COMMIT_MODE=true` is a hard prerequisite because Phase 6 requires the committed input/result/turn/version graph. `PLAYER_STRUCTURED_CONSUMER_MODE` is not an authority prerequisite and its requested/effective value is neither read nor changed by Phase 6; Phase 5 player delivery remains independent. Enabling Phase 6 changes only the NPC route after a successful Phase 4 player commit.

#### Normal flag evaluation

When a logical reaction starts, the engine snapshots exactly one route: flag `true` selects structured and flag `false` selects compatibility legacy. That route remains immutable until the logical reaction terminates. A normal configuration change while work is active does not cancel, abort, restart, or reroute it; the new value applies only to the next logical reaction trigger. Already committed plans, publications, legacy structures, and player records remain readable. Rollback sets the flag to `false` for future triggers and requires no deletion or data rewrite.

#### No mid-flight fallback

A structured route never switches to legacy for the same logical reaction after provider failure, timeout, parse/schema failure, validation rejection, stale/duplicate result, publication/delivery failure, or a mid-flight flag change. The player commit remains at `N+1` when no NPC commit occurred; publication failure after commit retains `N+2`. No shadow dual commit is allowed.

#### Emergency cancellation

Emergency cancellation is a separate explicit engine operation, not an implication of setting the deployment flag to `false`. It targets one active logical reaction and must atomically mark the logical reaction `cancelled`, mark its active attempt `aborted`, abort provider/backoff/timers/listeners, write the redacted `reaction_cancelled` observation and tombstone, and reject every late result. It creates no NPC commit/publication, increments version by `0`, retains the successful player commit at `N+1`, and never invokes legacy fallback. If the reaction already committed or otherwise reached a terminal logical status, cancellation is an idempotent no-op or typed terminal conflict and cannot undo state.

This section defines only the operational contract. Phase 6 does not add an emergency-cancellation UI, CLI command, HTTP endpoint, or runtime API in this docs-only change. Physical removal of legacy NPC/player paths remains Phase 9.

Required comparison observability includes route selected, logical outcome, attempt count, normalized rejection/timeout/stale/duplicate reason, `N+1`/`N+2` transition outcome, publication delivery outcome, and privacy-redaction status. Metrics never grant authority and contain no private projection or raw text.

### Migration sequence and rollback gates

1. **Docs PR C1 — runtime ownership and ledgers:** establish the existing shared publication-counter authority and the session-local coordinator terminal-order/capacity contract. This step changes documentation only and grants no runtime or delivery API.
2. **Docs PR C2 — NPC delivery contract:** define the independent NPC controller, exact committed-publication discovery and payload, browser/CLI sink evidence, retry/acknowledgement, history/replay separation, reset invalidation, visibility, ordering, observer, and Renderer non-ownership contract without changing the player protocol by inference. This section closes that design boundary without runtime changes.
3. **Post-C2 implementation re-audit:** reread the merged candidate, preparation, commit, C1, and C2 contracts against current runtime and split implementation only where each owner/API/rollback boundary is closed.
4. **Validator/schema alignment:** align the merged candidate/plan validators with the preparation contract, including canonical-only required fields and the four-claim cap, without routing or authority changes.
5. **Pure authoritative preparation implementation:** convert a validated runtime candidate to the exact detached engine-owned prepared value; publish nothing and preserve version/counters.
6. **Non-routing authoritative commit implementation:** implement replay, final CAS, copy-on-write graph publication, shared publication-ledger increments, exactly one `N+1 -> N+2`, and coordinator finalization behind a non-routing harness.
7. **Provider and delivery non-routing integration:** implement provider adapter and the C2 browser/CLI delivery controller independently of normal command routing; validation/commit authority remains in the engine.
8. **Coordinator and production-route integration:** only after the prior reviews, connect logical reaction lifecycle, provider invocation, preparation, commit, and committed-record delivery under one frozen route.
9. **Default-off verification:** prove browser/CLI parity, replay/failure/rollback, no fallback, privacy, shared-ledger integrity, terminal capacity/order behavior, and unchanged Phase 4/5 behavior while `NPC_STRUCTURED_REACTION_MODE` remains default-off.
10. **Later phases:** Phase 7 enables controlled Renderer/finalization under the same shared publication ledger; Phase 8 migrates suspicion/memory effects without an extra version; Phase 9 may physically remove legacy paths after separate approval.

Each implementation stage is independently reviewable and may be rolled back by disabling/removing only that stage before structured route selection. No stage deletes or rewrites Phase 4/5 records. Once a structured reaction commits, rollback changes future routing only and never compensates or deletes its `N+2` state.

### Later implementation acceptance tests

The implementation PR must add tests; this docs-only PR adds none. Passing requires state and external-effect assertions, not only error-code assertions:

- **Authority/unit:** one browser session has exactly one active browser-process `WerewolfGame`; one CLI-local session has exactly one active CLI-process `WerewolfGame`; the two processes never co-own one session; server/sink/observer/history access cannot create authority.
- **Identity/unit:** logical/request/correlation/trigger identities remain byte-equal across retries; every attempt ID is unique; provider-chosen/replaced IDs are rejected; exact trigger/result/input/turn/version graph is required; every required conflict-matrix case, including the split exact/conflicting-response subcases, produces its specified classification and version increment `0`.
- **Projection/unit:** deterministic deep-equal output for equal snapshots; public, actor-private, derived, and presentation groups are allowlisted; every other participant private role/team/memory/result, raw legacy info, prompt, diagnostic, and credential field is absent; input is not mutated.
- **Validation/unit:** strict fields, enums, IDs, bounds, array uniqueness, payload/nesting/code-point limits, actor/target eligibility, claim/disclosure permission, illegal effects, arbitrary patches, and syntactically valid but semantically invalid candidates fail closed with state deeply equal to `N+1`.
- **Candidate envelope/unit:** validate every exact request/provider-result/HTTP field and echo, both normative JSON examples, `requestFingerprint` reconstruction across changed attempt IDs, 64 KiB and 8/5/10 nesting boundaries, null/unknown/missing fields, safe-integer exhaustion, and the complete pending-binding comparison.
- **Proposal union/unit:** cover all four strict members, 1/16/17 total proposal bounds, the combined 4/5 role/result claim-producing bound, preserved order, every forbidden authoritative/effect/prose field, unsupported commentary/answer/acknowledgement, unknown kind, exact duplicates for each kind, the reachable different-vote contradiction, the earlier authorization precedence for unreachable role/result contradiction shapes, mixed legal kinds, whole-candidate rejection, detached reconstruction, deep immutability, and provider-input nonmutation.
- **Target and disclosure/unit:** cover each allowlist intersection, captured/current unknown or duplicate participant, actor/player target, dead vote/suspicion target, roster replacement/reset, dead-but-still-rostered result target, exact fact, target-only mismatch, result-only mismatch, cross-pair mismatch, public-hearsay-only and other-actor-only facts, all three known role policies, direct role/result question matching, wrong phase/trigger, `allowedClaimRoles` `["seer"]`/`[]`, false/werewolf/citizen claim denial, prior disclosure neutrality, same-candidate permission independence, and deny precedence. An unknown engine-owned policy is tested as stage-0 `invalid_expected_request`, not as a rejection result.
- **Candidate fingerprint/unit:** prove the exact canonical JSON and digest example, lower-hex form, object-key-order independence, proposal-order dependence, no trim/case/Unicode normalization, echo/attempt/diagnostic exclusion, malformed-extra-field rejection before hashing, and separate correlation rejection when equal candidate fingerprints arrive under different echoes.
- **Validation-only boundary/integration:** browser and CLI reach the same validator and may retain only the exact immutable `ValidatedNpcReactionCandidate`/closed `NpcReactionCandidateValidationResult`. Cover every required binding/context field, nested-only binding, null/unknown/missing rejection, provider detachment and nonmutation, candidate/projection fingerprint recomputation, both normative result examples, every **active initial Phase 6** rejection code and every active public stage/location combination in the reachability matrix, the eight-diagnostic bound, retryability ownership, and expiry on reset/turn/attempt/logical-terminal changes. Separately prove that reserved identifiers are absent from the active enum, exported rejection constants, diagnostic codes, and returned results; do not force them through hooks. Stage 17 must be proven equivalent to its earlier checks on the same immutable snapshot and must not create a new generic outcome. Success, rejection, retry, timeout, abort, duplicate, stale, and reset create no authoritative object/ID/delta/publication/display/fallback and leave the complete state/version graph equal to `N+1`.
- **Preparation/unit:** cover every `LogicalReactionStatus` and `ReactionAttemptStatus`, present/alive/speaking, absent, dead, and unable-to-speak actor states, and every malformed roster/applicability/authorization disagreement according to the exhaustive first-failure matrix. Cover combined role/result proposal counts `4` and `5`, claim-allocation and prepared-result bounds `0..4`, exact allocation/result ID equality, and rejection before preparation for the fifth claim-producing proposal. Fingerprint primitive or internal equality failure is tested only as the fixed redacted `preparation_fingerprint_failure` invariant through the real repository primitive/assertion boundary; no provider/state vector or test-only hook may manufacture it as a rejection.
- **Lifecycle/state machines:** logical and attempt machines are tested separately; terminal attempts never reopen; retry creates a new attempt under the same logical ID; retry exhaustion produces logical `exhausted`; committed/rejected/superseded/cancelled/exhausted reactions never reopen; timeout late result, racing attempts, post-commit result, superseded base, reset/destroy, and emergency cancellation cannot commit.
- **Version/atomicity:** player success is exactly `N -> N+1`; reaction success is exactly `N+1 -> N+2`; provider failure, timeout, reject, stale, duplicate, abort, and preparation/publication exception increment zero; commit exception restores the exact `N+1` graph; sink failure retains exact `N+2`.
- **Idempotency/tombstones:** one logical reaction commits at most once; exact replay returns the stored result with no provider/sink/version effect; changed fingerprint conflicts; duplicate transport and concurrent late responses create no second claim/event/publication; the complete coordinator root publishes planned logical plus reservation atomically, converts reservations without changing terminal order, evicts only the oldest tombstone with a successful complete planned creation, rejects all-reservation capacity and terminal-order exhaustion without gaps, cross-checks committed IDs through authoritative projections, and destroys every logical/attempt/reservation/tombstone member on reset; late old-session results remain rejected.
- **Retry invariants:** logical ID is stable, attempt ID changes, attempt count/deadline remain finite, validation and privacy do not weaken, player `N+1` remains committed, no legacy/hidden server retry occurs, final CAS repeats, and all terminal cleanup completes under injected time.
- **Initial retry policy:** separately assert initial `maxAttempts = 3`, 1-second/2-second backoff, and 15-second logical deadline; a test with different finite policy values must preserve all authority/identity/validation/version invariants.
- **Browser integration:** actual dispatch through `WerewolfGame`, stateless proxy adapter, commit, canonical record, DOM sink, acknowledgement, failure/retry, history-only read, and replay are exercised. Only committed canonical content is visible; sink failure never rolls back.
- **CLI integration:** the same engine/projection/validator path reaches the configured writer; throw/rejection is retryable delivery only; history read emits no live output; no legacy bypass exists.
- **Compatibility/flag:** route is snapshotted when the logical reaction starts; mid-flight flag changes do not reroute/cancel; disabled future routes preserve legacy behavior; enabled routes require Phase 4 and do not change Phase 4/5; every mid-flight failure has no fallback; explicit emergency cancellation produces logical `cancelled`/attempt `aborted`, zero increment, retained player `N+1`, late-result rejection, and no runtime route switch. All existing Phase 4 and Phase 5 tests remain unchanged and pass; 321/321 is the current docs-only baseline after the merged isolated candidate validator and preparation design, not a preparation/commit runtime-completion claim.
- **Adversarial:** actor/logical/attempt/version substitution, hidden-information request or response, illegal/unknown target, oversized/malformed/extra-field payload, arbitrary patch, stale base, duplicate delivery, mismatched attempt, valid syntax/invalid semantics, and concurrent late output all produce zero unauthorized display, mutation, or increment.
- **Single-actor policy:** exactly one target reaction may derive from `ask_npc`; provider cannot add/reorder actors; no parallel commit occurs. A future multi-NPC fixture is rejected until a separately approved serialized policy exists.
- **Observers/privacy:** only redacted lifecycle outcomes and committed records are observed; observer throw cannot change stored results; observer/history count changes no version; raw candidate/projection/private fields never reach logs, history, browser diagnostics, CLI diagnostics, or HTTP errors.

Acceptance additionally requires the existing sample command, syntax checks, diff checks, privacy/default-ignorable Unicode scans, and GitHub Actions to pass. It must demonstrate that the server retains no game session and that no runtime path treats transport or delivery acknowledgement as commit confirmation.

### Documentation Unicode verification record

Unicode verification is documentation validation, not a runtime Phase 6 test. The review-fix validation scans three scopes independently: added lines in `origin/master...HEAD` for this file, the complete `origin/master` copy, and the complete PR-head copy. The code-point predicate covers bidi controls (`U+061C`, `U+200E`-`U+200F`, `U+202A`-`U+202E`, `U+2066`-`U+2069`), zero-width characters (`U+200B`-`U+200D`, `U+2060`, `U+FEFF`), the Default_Ignorable_Code_Point ranges used by the repository check (including variation selectors and tag characters), non-breaking space `U+00A0`, and unexpected BOM `U+FEFF`.

The reproducible validation uses `git diff --unified=0 origin/master...HEAD -- docs/conversation-pipeline-design.md` plus a Python standard-library scanner (`unicodedata`, `subprocess`, and explicit code-point ranges). Each finding output is `(file line, column, U+code point, Unicode name, category)`. The same predicate scans `git show origin/master:docs/conversation-pipeline-design.md` and the working-tree file. No dependency or documentation toolchain is added.

The review-fix scan found `0` matching code points in all three scopes. Because neither the base file, PR-head file, nor added lines contain a matching code point, a GitHub UI warning for these classes cannot be reproduced from this document's code-point content; an exact UI-reported line would be required for a different diagnosis. A future nonzero result must name the character, code point, file, and line and must replace unintended characters before commit.

### Deferred and out of scope

Production, test, runtime schema-validator, provider, endpoint, and candidate-transport implementation are outside this docs-only design, including the runtime state machines, tombstone registry, flag plumbing, emergency-cancellation API/UI/CLI command, and the newly specified NPC delivery controller/adapters. C1 did not copy the player API or invent an NPC API; the C2 contract above now defines a separate NPC API and ownership boundary but implements none of it. Phase 6 also excludes persistence, reload/crash/offline recovery, durable queues, multi-tab/cross-tab ownership, account sync, server authority or transactions, distributed locking, remote observer guarantees, broad UI redesign, unrelated prompt tuning/game-rule redesign, controlled Renderer implementation, suspicion/memory migration, and physical legacy deletion. These require later phases or separate reviewed designs; none may be inferred from this section.

### Phase 6 invariants

1. Exactly one active `WerewolfGame` owns one active session; browser and CLI instances own separate process-local sessions and never co-own or replicate one session. Provider, server, sinks, history, and observers are not authorities.
2. Provider output is always untrusted and never supplies authoritative IDs, actor order, versions, or patches.
3. Player and reaction commits are separate: `N -> N+1`, then at most one `N+1 -> N+2` for initial Phase 6.
4. Failure, timeout, rejection, stale, duplicate, cancellation, and supersession preserve the player commit and increment zero.
5. One authoritative commit increments exactly once; one logical reaction commits at most once.
6. Logical and attempt state machines are distinct; a terminal attempt never reopens, retry preserves `reactionPlanId` and changes `reactionAttemptId`, exhaustion is a logical terminal status, and final CAS checks current live state.
7. The engine selects one eligible actor and creates the known-information projection before provider invocation.
8. Validation failure cannot invoke raw/legacy authoritative fallback or display the candidate as committed.
9. A committed NPC publication is separate from delivery; sink failure never rolls back `N+2`.
10. History/replay/diagnostic reads never acknowledge or consume live delivery and never create authority.
11. Phase 4 writer and Phase 5 player publication/delivery semantics are unchanged.
12. Identity conflicts, stale applicability, invalid responses, duplicates, and idempotent replay are distinct classifications; every repeated/conflicting input increments version by `0`.
13. One bounded session-local `NpcReactionCoordinatorControlRoot` owns logical reactions, attempts, reservations, tombstones, and terminal order: successful complete planned-logical creation alone advances the order, conversion preserves it, capacity eviction is atomic with successful creation, and reset destroys the whole domain without authority/history/persistence.
14. Retry count and deadline are finite invariants; `3` attempts, `1`/`2` second backoff, and `15` second deadline are initial tunable policy values only.
15. `NPC_STRUCTURED_REACTION_MODE` is default-off; its route is snapshotted at logical-reaction start and normal flag changes affect only later triggers.
16. Emergency cancellation is explicit and separate from flag changes; it aborts/cancels without NPC commit, version increment, player rollback, or legacy fallback.
17. Persistence, reload, multi-tab, and server authority remain out of scope; legacy physical deletion remains Phase 9.
18. If a future design permits multiple NPCs, commits are deterministically ordered, serialized, and individually versioned.
19. Candidate request and success envelopes are exact and fully correlated; every immutable binding echo matches request, pending attempt, and logical preparation state before candidate use.
20. Initial provider proposals are only role claim, result claim, vote declaration, and suspicion; they contain no authoritative ID, effect, patch, policy boolean, version, or prose.
21. Target permission is the exact intersection of proposal-kind allowlists, captured public identity, and matching current roster eligibility. Result claims additionally require one exact actor-owned target/result fact and never permit bluff.
22. Role and result disclosure uses only the closed `NpcRoleDisclosurePolicy`; unknown values and same-candidate permission escalation fail closed.
23. `candidateFingerprint` is engine-computed `sha256CanonicalJson()` over the detached strict candidate alone, preserving proposal order and excluding every envelope/diagnostic field.
24. Candidate validation success is runtime-only and nonauthoritative; it cannot allocate later artifact IDs, prepare or publish a delta, increment version, display, acknowledge commit, or invoke legacy fallback.
25. Validation returns only the closed `NpcReactionCandidateValidationResult`; a success owns one detached immutable `ValidatedNpcReactionCandidate`, and a rejection owns only the engine-expected binding plus bounded redacted non-retryable diagnostics. Neither result survives its session/turn/attempt applicability domain or authorizes later preparation.

## 26. Migration plan

The first implementation PR is Phase 1 only. It changes no production flow, provider calls, HTTP endpoints, browser integration, state mutation, or regex semantic parsing. Each later phase requires its own review and rollback boundary.

| Phase | Objective | Exact likely existing files | New files | Behavior unchanged | Tests | Rollback / risks / deployment boundary | Removal condition |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1. Pure schemas, validators, canonical renderers | Add side-effect-free schemas, validators, ID helpers, canonical claim/event renderers | `src/validator.mjs`, `src/utteranceGuard.mjs`, `tests/validator.test.mjs`, `tests/utteranceGuard.test.mjs` | likely `src/conversationSchemas.mjs`, `src/canonicalRenderer.mjs`, matching tests | all production paths | schema, Unicode, renderer, idempotency units | independently deployable unused modules behind no call site; revert files; risk is schema drift | none; no old path removed |
| 2. Interpreter transport in shadow mode | Call interpreter without consuming result; add runtime-only shadow binding, staged shadow input, and pending tracking without phase mutation | `src/webServer.mjs`, `src/responseProvider.mjs`, `src/openaiProvider.mjs`, `public/httpResponseProvider.mjs`, tests | interpreter transport tests | authoritative regex path, turn/state metadata, and mutations | HTTP, timeout, abort, privacy, stable shadow identity, duplicate pending submission, empty unavailable structured projections | `INTERPRETER_SHADOW_MODE`; disable flag; risk cost/latency | shadow parity/privacy gates pass; discard—not promote—the binding before Phase 3 |
| 3. Candidate validation without authoritative mutation | Implement section 6A engine-owned session/turn/version lifecycle; bind it to Interpreter request/pending; compare every stale dimension; validate/log candidates only, including section 11A result-claim structural authorization without hidden-truth adjudication; never commit, advance turn, or increment version from an Interpreter outcome | `src/gameEngine.mjs`, `src/validator.mjs`, `public/browserApp.mjs`, tests | candidate conversion tests | current player/NPC response behavior and all AI-independent game rules | candidate, result-claim policy, phase, alternative, lifecycle, stale/late/reset, privacy, no-mutation tests | independent validation-only flag; disable without data migration; risk diagnostic divergence | authoritative lifecycle, exact binding/stale rules, and section 11A authorization are implemented/tested; stable validation metrics; no shadow authority remains |
| 4. AcceptedSpeechAct, PublicEvent, and player structured claim write | Add atomic `PlayerConversationCommit` using section 6A CAS: one `N -> N+1` transition per multi-object/multi-act commit; include the legacy player-input display/history delta and exactly one strict compatibility mapping in that same transaction; create player-origin accepted acts, events, canonical claims and relations, display plans, publications, and stored result; then run the legacy NPC compatibility reaction as `N+1 -> N+2`; do not acknowledge the structured publication | `src/gameEngine.mjs`, `src/responseGenerator.mjs`, `public/browserApp.mjs`, tests | mapping validator/registry repair | NPC response provider and the explicit Phase 4 legacy visible-display exception | mapping equality/cardinality, provenance, rollback, duplicate/fingerprint, fixed-ledger, provider-failure, replay/no-provider tests | structured-write flag; disable new writes without deleting committed records; no mapping backfill | player commit owns mapping/publication/legacy entry in one `N -> N+1`; replay and failure append none |
| 5. Player claim consumer and history migration | Read mapping/canonical claims/display plans/publications; use explicit delivery and acknowledgement APIs; separate requested/effective mode; defer OFF -> ON behind an exact pre-cutover legacy drain; prove browser success only after DOM attachment and CLI success only after configured write completion | `src/gameEngine.mjs`, `public/browserApp.mjs`, `src/cli.mjs`, tests | session-local delivery controller if needed | NPC claims, provider, Phase 4 writer/schema, and legacy NPC display | exact identity, DOM/output sink evidence, drain/retry/partial/cancel/reset, command gating, no-backfill, stale cursor, feature transitions, no-mutation tests | default-off read-path flag; explicit transition; fixed watermark/set; rollback uses mapping-aware legacy sink | structured publication becomes sole new-player trigger only after completed cutover; no loss/double display |
| 6. Structured NPC reaction | Implement section 25A: engine-owned logical/attempt identity, one selected actor, strict known-information projection and candidate validation, final CAS, atomic canonical plan/effects/result/publication commit replacing the compatibility `N+1 -> N+2`, and separate delivery/history | `src/gameEngine.mjs`, `src/responseGenerator.mjs`, `src/responseProvider.mjs`, `src/webServer.mjs`, `public/httpResponseProvider.mjs`, `public/browserApp.mjs`, `src/cli.mjs`, tests | strict candidate/projection/pending/plan/commit/publication validators; session-local coordinator | Phase 4 player writer, all Phase 5 player delivery, stateless server, and disabled legacy NPC route | identity/lifecycle/projection/privacy/validation/CAS/version/idempotency/retry/abort/browser/CLI/history/flag tests in section 25A | default-off `NPC_STRUCTURED_REACTION_MODE`; pre-execution route selection; disable affects later triggers; no same-reaction fallback | one logical reaction commits at most once; player remains `N+1` on every NPC failure; success alone produces one `N+2` and one committed canonical publication |
| 7. Controlled Renderer integration | Add locale propagation, slot/append ordering, baseline Renderer FinalizationSource, pending completion order, fallback finalization, CAS/late rejection, and same-session guarantee | `src/openaiProvider.mjs`, `src/webServer.mjs`, `src/responseProvider.mjs`, `public/httpResponseProvider.mjs`, `public/browserApp.mjs`, tests | display log, variant registry, finalization result tests | canonical-only bypasses Renderer; game state independent; reload recovery deferred | locale triple, ordering, success/failure, races, pending cleanup tests | renderer flag; fallback; risk unresolved reservation on reload | same-session reservations finalize exactly once without game-state mutation |
| 8. Suspicion and memory migration | Move updates behind accepted events | `src/gameEngine.mjs`, `src/responseGenerator.mjs`, tests | none expected | voting/night/win logic | atomic update, rollback, regression tests | per-effect flag; revert to old effect path; risk scoring changes | parity criteria and audit logs pass |
| 9. Obsolete-path removal | Remove old single `displayOrder`, implicit-locale resolution, source-act-only claim key, durable references to runtime pending/audit records, mutable reservation, legacy provenance/phase/direct-text/duplicate-display paths | `src/gameEngine.mjs`, `src/responseGenerator.mjs`, `src/validator.mjs`, `src/utteranceGuard.mjs`, `src/webServer.mjs`, `src/responseProvider.mjs`, `src/openaiProvider.mjs`, `public/browserApp.mjs`, `public/httpResponseProvider.mjs`, `tests/` | none | game rules/public behavior | full suite plus locale/order/idempotency migration fixtures | deploy after flags stable; rollback release; high history risk | split orders and stored locale fully migrated; no runtime-pending persistent reference remains |

Phase 2 Interpreter output is observation-only. It creates no `AcceptedSpeechAct`, claim, event, commit result, publication, display change, phase mutation, authoritative state-version increment, suspicion/memory mutation, or replacement of the legacy classifier. Shadow transport identity and empty unavailable structured projections must not be carried forward as authoritative data in Phase 3.

Phase 3 readiness requires `WerewolfGame` to own and test the complete section 6A lifecycle before any authoritative request is sent. Phase 3 output remains validation-only and cannot advance the captured turn/version. Phase 4 reuses those bindings for atomic player commits; it does not redefine their meanings.

Phase 5 is complete on `master`; its requested/effective mode, pre-cutover drain, browser/CLI evidence, acknowledgement, retry, history, and no-backfill contracts remain unchanged. Phase 6 follows the staged sequence in section 25A, replaces only the provisional NPC compatibility transition when enabled, and never reopens the Phase 4 writer or Phase 5 player consumer. Phase 7 later integrates controlled Renderer finalization, Phase 8 migrates suspicion/memory effects without adding a version transition, and Phase 9 may remove legacy entries/mappings/paths only after separate approval.

The repository has `src/openaiProvider.mjs`; there is no `src/openAIResponseProvider.mjs` or `src/pseudoResponseProvider.mjs` today. Pseudo behavior currently lives in `src/responseProvider.mjs`, so migration plans use actual file names and may split files only in a separately reviewed phase.

## 27. Test strategy

- Schema validation unit tests cover every strict union member, unknown/forbidden fields, closed enums, bounds, nullability, duplicate IDs, and reference integrity.
- Candidate/Accepted/Event conversion tests cover every type and all-or-nothing rejection.
- SourceSpan/display-plan tests use Unicode code points, punctuation ownership, gaps, overlap rejection, compound claims/questions, and replay without reparsing.
- CanonicalClaim rendering tests prove deterministic claim, vote, and suspicion output.
- Duplicate/idempotency and event replay tests prove repeated requests are no-ops and ordering is stable.
- Stale-response tests cover request, correlation, turn, state version, reaction plan, and selected variant mismatches.
- Multiple-alternative tests prove clarification regardless of confidence and no partial mutation.
- Private-projection leak tests reject roles, hidden teams/results, private memory, suspicion scores, prompts, and provider diagnostics.
- Prompt-injection fixtures cover player instructions, roster display-name injection, public-event text injection, schema-ignore instructions, and rejection of generated unknown IDs.
- Controlled-variant tests cover ID/version/locale/intent match, disabled/retired replay, and unknown references.
- HTTP contract tests cover status mappings, 64 KiB, content type, malformed JSON, strict envelopes, and logging redaction.
- Provider timeout/abort tests cover each attempt, backoff, deadline exhaustion, disconnect, and non-retryable failures.
- Phase 2 shadow-binding tests prove request, pending, and staged-input IDs agree; retries reuse the binding; resubmission creates a new binding; session/version values are runtime-only and monotonic; and stale sessions are rejected.
- Phase 2 projection tests require the public roster, include only records with authoritative structured IDs, permit empty unavailable structured arrays, and reject every synthesized legacy ID or raw legacy text.
- Turn/version lifecycle tests prove setup `(turnOrder=0, stateVersion=0)`, opaque session-unique turn IDs, separate ID/order meanings, one turn allocation per accepted top-level command, reset isolation, safe-integer exhaustion rejection, and the mutation-classification table.
- Phase 3 binding tests prove one synchronous session/turn/version/phase/actor/input capture, exact pending equality, no shadow reuse, unchanged retry identity, each stale reason, terminal duplicate/conflict handling, clarification continuation, and no turn/version transition for every outcome.
- Migration compatibility tests cover feature flags, dual-read/write boundaries, rollback fixtures, and old history.
- Existing game-progression regression tests continue covering discussion, question, response, vote, execution, night, seer, attack, and win check.
- Atomic tests cover successful commit, prepare failure with unchanged state, exception rollback, multi-act all-or-nothing, renderer failure after commit, and clarification with no commit.
- Phase 4 version tests prove final CAS immediately precedes publication, player `N -> N+1`, reaction `N+1 -> N+2`, one increment regardless of object count, pre/post field-ledger equality, result/idempotency publication in the same transaction, no rollback gap, and stored-result replay without increment.
- Phase 4 compatibility-ledger tests prove flag OFF performs one combined `N -> N+1`, flag ON includes player-side legacy effects in the player `N -> N+1`, the provisional NPC reaction alone owns `N+1 -> N+2`, Phase 6 replaces rather than follows that transition, and Phase 8 changes effects without adding a transition.
- Phase 4 display tests prove one committed publication maps to one visible legacy entry under the explicit exception, exact replay emits neither, structured publication is not consumed before Phase 5, and the exception ends only when all browser/CLI consumers switch with no double display.
- Phase 4 repair tests prove mapping/publication/input/plan/request/correlation/turn/session/version equality, one mapping per publication and legacy location, canonical legacy fingerprint verification, same-transaction rollback, replay with no mapping append, Phase 4 OFF with no mapping, and one `N -> N+1` increment.
- Phase 5 delivery tests prove retrieval/render/history/action-result construction do not acknowledge; exact mapping replaces only its legacy entry under stale cursors, repeated text, multiple turns, and partial acknowledgement; wrong/missing/duplicate mappings fail closed; browser and CLI cannot acknowledge from `prepared`/`in_flight` or with a missing/foreign receipt; concrete sink success creates the exact `sink_succeeded` receipt; sink-success/ack-failure retry performs acknowledgement only and never a second DOM/CLI output; sink failure remains retryable and creates no receipt; first acknowledgement invokes `publication_acknowledged` exactly once; every duplicate acknowledgement invocation invokes `duplicate_ack_suppressed` exactly once while changing nothing; observer failure preserves stored receipt/result/state; reset invalidates receipts; generation acknowledgements are stale; and authoritative state is deeply equal before/after delivery bookkeeping.
- Phase 5 feature tests prove requested/effective separation; OFF -> ON freezes but does not commit a watermark while evidence is missing; the fixed required set drains by exact identity; generation stays unchanged while pending and increments once on completion; new commands allocate no turn, call no provider, and commit nothing while draining; one held command is dispatched once only after completion; cancellation/reset and stale callbacks are safe; ON -> OFF preserves acknowledged suppression; and no transition backfills or redisplays pre-cutover output.
- Phase 5 browser sink tests use the actual adapter/DOM path and prove array/view-model mutation alone creates no evidence; exact safe node attachment, parent and identity-bookkeeping verification precede receipt/evidence; missing container, append throw, wrong parent, bookkeeping failure, and completion failure remain retryable; post-receipt evidence retry does not reappend; later rendering does not remove or duplicate the delivered node; and history/replay/non-display queries append nothing.
- Phase 5 CLI sink tests prove configured synchronous return or awaited fulfillment is the success boundary, throw/rejection creates no evidence, prompt redraw is not proof, exact same-process evidence-only retry does not rewrite output, and terminal controls are sanitized before the write.
- Phase 5 drain tests cover initial-OFF success/failure, pending transition result, exact candidate retrieval independent of cursor, repeated text and multiple publications, partial evidence, terminal resolution failure, explicit completion, cancel with/without active sink, reset during sink, and deep equality of all authoritative state throughout transition/evidence bookkeeping.
- Display ownership tests cover one publication record for claim-only input, one for multi-act input, and no duplicate display on replay.
- Pending-state tests cover duplicate submission blocking, timeout/abort with unchanged authoritative phase, and stale response with unchanged state.
- Version tests prove Interpreter pending uses precondition version, Renderer pending uses committed resulting version, Renderer processing/delivery/acknowledgement increments zero, and player/NPC commits increment separately. Future Phase 7 tests must prove finalization append has an independent CAS and one successful increment, replay increments zero, and record `stateVersion` remains originating-reaction provenance rather than append-transaction version evidence.
- NPC reaction tests prove canonical claims are created only in reaction commit, canonical segments never reference uncommitted claims/events, renderer failure preserves committed state, and one reaction yields exactly one NPC publication.
- Phase 6 authority tests prove one active owner per session, separate browser and CLI-local sessions, no browser/CLI co-ownership or replica relationship, and no authority acquisition by server, sink, observer, or history read.
- Phase 6 lifecycle tests independently cover every logical and attempt edge, prohibit every omitted edge, prove terminal attempts never reopen, create a fresh attempt on retry, permit multiple attempts under one logical ID, produce logical `exhausted` at retry exhaustion, and produce logical `cancelled` plus attempt `aborted` on emergency cancellation.
- Phase 6 identity-matrix tests cover every row in section 25A, including conditional exact replay/duplicate and same-attempt candidate conflict, and assert the exact classification, terminal status behavior, commit count `0`, and version increment `0`.
- Phase 6 coordinator-root tests prove the exact seven-field root; strict logical/attempt/reservation/tombstone map shapes and references; no separately mutated live registry; atomic planned-logical plus reservation creation; separate atomic attempt creation; and coordinator cleanup as one detached root transaction after authoritative publish. Faults before cleanup and at every cleanup copy/staging/validation/replacement point preserve the old root byte-for-byte (`active`, validated winner, prior nonwinner statuses, reservation, no tombstone) while authoritative `N+2` remains. Tests prove cross-root cleanup-pending detection without a new enum, authoritative replay precedence, suppression of provider/attempt/preparation/commit retry, conflict mutation zero, cleanup retry fault then success, exact `cleaned`/`already_cleaned`, partial committed/accepted and tombstone-plus-active invariant failures, observer isolation, zero-based successful-complete-creation-only terminal order, orphan/identity/projection/root-validation failure with no gap or eviction, authoritative committed-plan collision after tombstone eviction, oldest-tombstone-only successful-creation eviction, all-reservation capacity and terminal-order rejection before projection/ID allocation, and destruction of the full root plus runtime handles on reset.
- Phase 6 retry-invariant tests prove stable logical/request/correlation/trigger binding, fresh attempt IDs, finite attempts/deadline, unchanged validation/privacy/projection, repeated final CAS, no player rollback, no legacy or hidden server retry, and terminal cleanup. Separate initial-policy tests assert `3` attempts, `1`/`2` second backoff, and `15` second deadline, then vary those finite values without changing authority invariants.
- Phase 6 flag tests prove route snapshot at logical-reaction start, normal mid-flight flag changes affect only later triggers, every structured failure avoids fallback, and explicit emergency cancellation causes zero increment, retains player `N+1`, records a redacted diagnostic/tombstone, and rejects late output.
- Phase 6 projection/validation tests prove deterministic strict allowlists, actor-private disclosure authorization, exclusion of every other private/legacy/internal field, provider ID/actor/version/patch rejection, final live CAS, exact `N+1 -> N+2`, zero increments for every non-commit outcome, and no legacy fallback after enabled-route rejection.
- Phase 6 delivery contract tests prove strict discovery/preparation/request/payload/current-record/retained-attempt/receipt/acknowledgement/retry-token schemas; detached frozen canonical rendering; caller payload override rejection; one active attempt; head-of-line slot order; distinct dense runtime orders; every permitted state edge; and every omitted edge rejection without authoritative mutation. They cover 1024/3072 capacity boundaries, no attempt eviction/reuse, attempt-number preservation across replacement, and exact `npc_delivery_capacity_exhausted` rollback.
- Phase 6 browser delivery tests exercise the actual DOM adapter from a controller-frozen canonical payload and prove exact safe-node attachment plus identity bookkeeping before receipt, cleanup-proved retry after pre-proof failure, terminal ambiguity when cleanup cannot be proved, acknowledgement-only retry after receipt, no second node, and reset/late callback isolation.
- Phase 6 CLI delivery tests exercise the actual configured writer and prove synchronous/awaited fulfillment evidence, no-effect failure retry, partial/unknown write terminalization, timeout/abort cleanup, acknowledgement-only retry without a second write, and exact parity with browser controller identity and ordering.
- Phase 6 delivery idempotency tests cover repeated discovery, fresh-attempt sink retry, exact receipt/token lookup, exact duplicate acknowledgement and one suppression observation, conflicting/foreign receipt, wrong sink/consumer/generation/session, stale acknowledgement observations, terminal rendering failure, controller reset, and authoritative deep equality throughout. Consumer-replacement tests retain an old-generation `abandoned` attempt while publishing a new-generation `pending` current record, invalidate old capabilities/receipts/tokens/callbacks, reject attempt-ID collision, preserve acknowledged/terminal records, emit exact post-replacement observations, and prove byte-equal rollback at every pre-replacement fault point.
- Phase 6 delivery failure reachability tests cover every transport code/disposition/state/token tuple. They prove `retry_sink` only for no-visible-effect evidence with budget remaining, `terminal_exhausted` on the third proved-no-effect failure, `terminal_ambiguous` for unknown effect at any attempt, absence of `retry_ack_only` from transport failures, and creation of `ack_only` only by exact sink completion. The normative JSON examples parse and match those transitions.
- Phase 6 history/replay tests prove reaction replay, history, `get_state`, diagnostics, snapshot, and observer subscription produce no live request, render, sink, receipt, acknowledgement, token, or redisplay; repeated history remains complete and deterministic in publication-slot order across pending/acknowledged/failed delivery states.
- Phase 6 delivery/compatibility tests additionally prove default-off and disable rollback, unchanged Phase 4/5 controllers and legacy route, stateless proxy operation, no raw/legacy fallback for a structured reaction, retained `N+2` after every sink outcome, and no controlled Renderer activation before Phase 7.
- Phase 6 documentation validation records the Unicode scan command, exact base/head/added-line scopes, inspected code-point classes, and file/line/code-point details for any finding; it is not a runtime test.
- Phase tests prove provider pending does not mutate phase, accepted acts record `acceptedPhase`, events record `occurredPhase`, and commit deltas record `resultingPhase`.
- Duplicate tests prove a committed retry returns the stored CommitResult without provider execution or mutation and rejects same request ID with a changed fingerprint.
- Publication tests prove every displayable input has exactly one player publication and replay duplicates neither player nor NPC publication.
- Malformed-JSON tests prove a server-generated correlation ID appears in response/logs while raw body and untrusted client correlation do not.
- Claim-provenance tests require `PlayerAcceptedActClaimSource` for player claims and `NpcReactionClaimSource` for NPC claims; NPC claims cannot borrow player accepted-act provenance.
- NPC event-provenance tests require matching reaction plan/descriptor, reject dangling/wrong-type descriptor IDs, and prove descriptor IDs are engine-generated, immutable, and unique per plan.
- Canonical coverage tests prove segment, claim, and semantic event share the same descriptor ID and preserve descriptor order.
- Causation tests reject uncommitted, display-log, plan-derived, and same-reaction events in `causationEventIds`, including explicit cycle fixtures.
- Display-log tests prove reservation is created in its owning reaction commit and remains immutable; Renderer success/fallback selection alone appends no finalization and increments zero; and a future Phase 7 authoritative finalization append reuses the slot, increments only the record counter, appends once by copy-on-write, and increments authoritative `stateVersion` once. Exact Phase 7 API/version-evidence tests wait for the Phase 7 docs prerequisite.
- Finalization-source tests require `RendererRequestFinalizationSource` for success and same-session timeout/abort/error/invalid-output fallback; baseline rejects `RecoveryFinalizationSource` and recovery-only reason values.
- Pending-order tests prove timeout/abort fallback finalizes and persists result before pending terminal/removal; retries return stored result and late success loses CAS.
- Locale propagation tests prove plan/input/reservation/RendererRequest/PendingRenderer/finalization/result equality and replay lookup by `(variantId, variantVersion, locale)` without UI-locale override.
- Canonical publication tests replay segments using stored locale and renderer version, without stored text.
- Information-only tests produce a valid plan with matching originating input and empty `causationEventIds`.
- Publication-order tests prove stable slot under delayed Renderer, different append orders for reservation/finalization, and that reservation is never rendered.
- Claim-key tests verify player and NPC derivations, descriptor replay reuse, and conflict on equal NPC key with changed payload.
- CAS tests prove identical duplicate finalization returns stored result, conflicting finalization is rejected, and late Renderer success after fallback is ignored.
- Commit-result tests prove NPC result references an existing reservation rather than an uncreated finalization.
- Locale tests accept supported language-only `ja` and `en`, accept supported regional tags, and distinguish syntax validity from the `SupportedLocale` allowlist.
- Renderer correlation tests prove exact equality across `NpcReactionPlan`, `RendererRequest`, `PendingRendererRequest`, `RendererProviderResult`, and `RendererHttpResponse`, and reject each mismatched link.
- Canonical rendering-context tests prove strict participant projections, duplicate and unknown participant rejection, input immutability, private-field rejection, and that the local-only context is absent from `RendererRequest`.
- A repository CI check must reject bidi controls, zero-width characters, and other unapproved default-ignorable Unicode in design/schema sources. Code-block identifiers and enum literals remain ASCII.

## 28. Design invariants

### Nesting depth calculation

Root object depth is 1; each nested object or array adds 1; primitives add none. Limits are request 8, model 5, and HTTP 10.

### Correlation and replay

In Phase 2, the browser runtime validates Interpreter responses against the complete `ShadowInterpreterBinding`; its request, input, client correlation, shadow turn, shadow snapshot version, session, schema, operation, and pending member must match. This does not validate or mutate authoritative game metadata. From Phase 3 onward, the engine performs every section 6A session/request/correlation/input/turn/version/phase/actor/pending comparison. Renderer responses use the committed reaction `resultingStateVersion` and additionally match `reactionPlanId`; they do not require equality with a later engine version. Duplicate committed requests return stored CommitResult; replay uses stored counters, events, display plans, publications, and exact variants without reinterpreting or redisplaying.

| Invariant | Status |
| :--- | :--- |
| **AI-generated display text** | PROHIBITED |
| **Authoritative turn/version owner and writer** | EXACTLY ONE ACTIVE `WerewolfGame` PER ACTIVE SESSION; BROWSER/CLI SESSIONS ARE DISTINCT |
| **Turn ID meaning** | OPAQUE logical-command identity; never ordering/version/request identity |
| **Turn ordering source** | ENGINE `turnOrder`, never ID text/timestamp/index/request count |
| **State version meaning** | SAFE-INTEGER CAS guard over complete authoritative protected state |
| **Pending provider work changes turn/version** | PROHIBITED |
| **Failed, rolled-back, stale, aborted, or clarification version transition** | NONE |
| **Successful authoritative transaction version transition** | EXACTLY `N -> N+1` |
| **Commit precondition immediately before publication** | SESSION + TURN + PHASE + VERSION + IDEMPOTENCY MUST MATCH |
| **Objects from one commit agree on field-ledger versions** | REQUIRED |
| **Failed transaction version gap** | PROHIBITED |
| **Duplicate commit replay** | STORED RESULT, NO TRANSITION |
| **Renderer processing changes authoritative version** | PROHIBITED |
| **Future authoritative finalization append** | SEPARATE PHASE 7 COW TRANSACTION; SUCCESS EXACTLY `+1`, REPLAY/FAILURE `0` |
| **Finalization record `stateVersion` meaning** | ORIGINATING REACTION RESULT PROVENANCE, NOT APPEND-TRANSACTION VERSION |
| **Shadow metadata promoted/continued as authority** | PROHIBITED |
| **Raw player display source** | `PlayerInputRecord.rawText` |
| **Claim display source** | CanonicalClaim renderer |
| **Controlled commentary source** | engine-owned variant registry |
| **Unknown fields** | REJECTED |
| **Private facts in provider projection** | PROHIBITED |
| **Player result-claim legality depends on hidden truth or actor knowledge** | PROHIBITED |
| **Legal player bluff/fabricated result claim** | RECORDED AS PLAYER ASSERTION, NEVER AS TRUTH |
| **Player structured claim artifact writer** | PHASE 4 ONLY |
| **Player claim render/history consumer migration** | PHASE 5; NO CLAIM RE-CREATION OR VERSION TRANSITION |
| **Player-origin canonical/legacy claim dual-write** | PROHIBITED; NO PLAYER LEGACY CLAIM REGISTRY EXISTS |
| **Duplicate event replay** | NO-OP |
| **State-changing content in commentary variant** | PROHIBITED |
| **Canonical descriptor coverage** | EXACTLY ONCE |
| **Alternative partial acceptance** | PROHIBITED |
| **Confidence-based acceptance** | PROHIBITED |
| **AbortSignal support** | REQUIRED |
| **Nesting depth limits** | ENFORCED (8/5/10) |
| **Unapproved hidden/default-ignorable Unicode** | PROHIBITED and future-CI rejected |
| **Player utterance publication count** | EXACTLY ONE per committed displayable input |
| **Player utterance display trigger** | STEADY STATE: ONLY `PlayerUtterancePublishedRecord`; PHASE 4 EXCEPTION: the explicitly mapped same-transaction legacy player-question entry is the one visible trigger while the structured record remains unacknowledged |
| **Legacy-to-player-publication matching** | EXACT MAPPING RECORD ONLY; TEXT, PHASE, DAY, CURSOR, FIFO, AND POSITIONAL INFERENCE PROHIBITED |
| **Render/retrieval/history implies acknowledgement** | PROHIBITED |
| **Sink-success proof** | CONTROLLER-ISSUED EXACT RECEIPT IN `sink_succeeded`; NEVER OBSERVER EVENT OR RENDERED TEXT |
| **Requested versus effective consumer mode** | DISTINCT; ONLY EFFECTIVE MODE OWNS LIVE DELIVERY |
| **Pending OFF -> ON cutover** | REQUESTED STRUCTURED + EFFECTIVE LEGACY + `draining_pre_cutover`; NO IMPLICIT ROLLBACK OR STRUCTURED CARRYOVER |
| **Pre-cutover command acceptance** | NEW AUTHORITATIVE COMMANDS PROHIBITED UNTIL EXPLICIT COMPLETION OR CANCELLATION |
| **Proposed cutover watermark** | FROZEN WITH A FIXED REQUIRED SET; COMMITTED ONLY AT SUCCESSFUL COMPLETION |
| **Pre-cutover delivery evidence** | EXACT CONTROLLER-ISSUED LEGACY SINK PROOF; RUNTIME-ONLY; NO STATE-VERSION EFFECT |
| **Browser pre-cutover sink success** | EXACT SAFE NODE ATTACHED TO AND VERIFIED IN THE INTENDED CONTAINER; ARRAY PUSH/RENDER SCHEDULING INSUFFICIENT |
| **CLI pre-cutover sink success** | CONFIGURED WRITE RETURNS OR FULFILLS; PROMPT REDRAW INSUFFICIENT |
| **Sink success then evidence failure** | EVIDENCE-ONLY RETRY; NEVER REPEAT DOM/CLI OUTPUT |
| **Cutover completion** | ALL REQUIRED EVIDENCE + NO ACTIVE ATTEMPT + NO TERMINAL BLOCKER; GENERATION +1, GAME VERSION +0 |
| **Pre-cutover publication after cutover** | HISTORY AVAILABLE; STRUCTURED LIVE BACKFILL AND REDISPLAY PROHIBITED |
| **Player display acknowledgement** | ONLY FROM EXACT `sink_succeeded` RECEIPT; DIRECT `in_flight -> acknowledged` FORBIDDEN; SESSION-LOCAL; NO STATE-VERSION EFFECT |
| **Sink failure** | REMAINS UNACKNOWLEDGED AND RETRIEVABLE; NO LEGACY FALLBACK IN SAME ATTEMPT |
| **Sink-success acknowledgement retry** | ACK-ONLY; NEVER REPEAT DOM/CLI OUTPUT |
| **Duplicate acknowledgement** | IDEMPOTENT STORED RESULT; EXACTLY ONE `duplicate_ack_suppressed` OBSERVER INVOCATION PER API INVOCATION; NO SECOND DISPLAY |
| **Old-session acknowledgement** | REJECTED; NEVER AFFECTS NEW SESSION |
| **Phase 4 publication/display cardinality** | EXACTLY ONE STORED PUBLICATION + EXACTLY ONE VISIBLE LEGACY DISPLAY; NEVER TWO VISIBLE DISPLAYS |
| **Phase 4 player compatibility version transition** | INCLUDED IN PLAYER `N -> N+1`; NO SEPARATE TRANSITION |
| **Pre-Phase 6 NPC compatibility reaction transition** | EXACTLY `N+1 -> N+2`; PHASE 6 REPLACES, NEVER ADDS TO IT |
| **Phase 6 reaction logical identity** | ENGINE-OWNED `reactionPlanId`; STABLE ACROSS RETRIES; COMMITS AT MOST ONCE |
| **Phase 6 reaction attempt identity** | ENGINE-OWNED `reactionAttemptId`; FRESH FOR EVERY ENGINE RETRY |
| **Phase 6 logical/attempt status domains** | DISTINCT; TERMINAL ATTEMPT NEVER REOPENS; RETRY EXHAUSTION IS LOGICAL `exhausted` |
| **Phase 6 identity classification** | REPLAY, CONFLICT, STALE, INVALID, AND DUPLICATE ARE DISTINCT; EVERY NON-COMMIT INCREMENT IS 0 |
| **Phase 6 terminal identity retention** | BOUNDED SESSION-LOCAL TOMBSTONE; FAIL CLOSED AT CAPACITY; DESTROY ON SESSION END |
| **Phase 6 retry policy layers** | FINITE ATTEMPTS/DEADLINE ARE INVARIANTS; 3 ATTEMPTS, 1/2 SECOND BACKOFF, 15 SECOND DEADLINE ARE TUNABLE INITIAL VALUES |
| **Phase 6 initial actor policy** | EXACTLY ONE ENGINE-SELECTED TARGET NPC PER COMMITTED `ask_npc`; NO PARALLEL COMMIT |
| **Phase 6 known-information projection** | PURE ENGINE ALLOWLIST; FULL STATE AND OTHER-ACTOR PRIVATE DATA PROHIBITED |
| **Phase 6 candidate transport** | EXACT REQUEST + COMPLETE NESTED BINDING ECHO + STRICT HTTP ENVELOPE; PENDING/REQUEST/RESPONSE EQUALITY REQUIRED |
| **Phase 6 provider proposal domain** | ONLY `role_claim`, `result_claim`, `vote_declaration`, `suspicion`; AUTHORITATIVE IDS/EFFECTS/PATCHES/VERSIONS/PROSE PROHIBITED |
| **Phase 6 target authorization** | KIND-SPECIFIC ALLOWLIST + CAPTURED PUBLIC IDENTITY + CURRENT ROSTER ELIGIBILITY; RESULT REQUIRES EXACT ACTOR-OWNED FACT |
| **Phase 6 role disclosure policy** | CLOSED ENUM; UNKNOWN VALUE, FALSE ROLE, WEREWOLF CONFESSION, CITIZEN CLAIM, AND SAME-CANDIDATE PERMISSION ESCALATION REJECTED |
| **Phase 6 candidate fingerprint** | ENGINE `sha256CanonicalJson(STRICT DETACHED CANDIDATE)`; PROPOSAL ORDER PRESERVED; ENVELOPES/ATTEMPT/DIAGNOSTICS EXCLUDED |
| **Phase 6 validation-only success** | SESSION-LOCAL IMMUTABLE RUNTIME VALUE; NO AUTHORITATIVE ID/DELTA/COMMIT/VERSION/PUBLICATION/DISPLAY/FALLBACK |
| **Phase 6 validation failure fallback** | RAW/LEGACY AUTHORITATIVE FALLBACK FOR SAME LOGICAL REACTION PROHIBITED |
| **Phase 6 flag** | `NPC_STRUCTURED_REACTION_MODE`; DEFAULT OFF; ROUTE SNAPSHOTTED AT REACTION START; PHASE 4 COMMIT MODE REQUIRED |
| **Phase 6 mid-flight flag change** | DOES NOT REROUTE OR CANCEL ACTIVE REACTION; APPLIES TO NEXT TRIGGER |
| **Phase 6 emergency cancellation** | EXPLICIT SEPARATE OPERATION; LOGICAL `cancelled`, ATTEMPT `aborted`, VERSION +0, NO FALLBACK |
| **Phase 6 NPC history read implies delivery** | PROHIBITED |
| **Phase 6 NPC delivery owner** | EXACTLY ONE SESSION-LOCAL `NpcPublicationDeliveryController`; DISTINCT FROM PLAYER CONTROLLER |
| **Phase 6 NPC delivery indexes** | ONE CURRENT RECORD PER PUBLICATION + BOUNDED IMMUTABLE ATTEMPTS BY ID; CONSUMER REPLACEMENT NEVER OVERWRITES OLD ATTEMPT EVIDENCE |
| **Phase 6 live delivery source** | COMMITTED `NpcCanonicalUtterancePublishedRecord` + COMPLETE VALID CANONICAL GRAPH ONLY |
| **Phase 6 delivery payload source** | ENGINE CANONICAL RENDERER; DETACHED, FROZEN, STORED LOCALE/VERSION; CALLER OVERRIDE PROHIBITED |
| **Phase 6 delivery order** | HEAD-OF-LINE ASCENDING `publicationSlotOrder`; APPEND/ATTEMPT/SINK/ACK/OBSERVER ORDERS ARE DISTINCT |
| **Phase 6 sink proof** | EXACT BROWSER DOM ATTACHMENT OR CONFIGURED CLI WRITE FULFILLMENT; OBSERVER/TEXT/VIEW MODEL INSUFFICIENT |
| **Phase 6 acknowledgement proof** | EXACT CONTROLLER-RETAINED `sink_succeeded` RECEIPT ONLY; ACK-ONLY RETRY AFTER SINK SUCCESS |
| **Phase 6 delivery replay** | EXACT RETAINED `repeat_sink` OR `ack_only` TOKEN; COMMIT/HISTORY REPLAY NEVER DELIVERS |
| **Phase 6 delivery terminal evidence** | PROVED NO-EFFECT EXHAUSTION IS `terminal_exhausted`; UNKNOWN VISIBLE EFFECT IS `terminal_ambiguous` |
| **Phase 6 delivery failure fallback** | LEGACY NPC TEXT, PROVIDER, REACTION, AND AI RENDERER FALLBACK PROHIBITED |
| **Phase 6 delivery reset** | ABANDON OLD ATTEMPTS, DESTROY COMPLETE RUNTIME ROOT, REJECT EVERY OLD-SESSION CALLBACK |
| **Phase 6 AI Renderer ownership** | NONE; PHASE 6 CANONICAL DELIVERY NEVER CREATES `RendererRequest` OR ACCEPTS RENDERER SINK PROOF |
| **Accepted-alternative domain mutations** | ATOMIC |
| **Provider wait changes authoritative phase** | PROHIBITED |
| **Candidate spans within an alternative** | PAIRWISE NON-OVERLAPPING |
| **Every intended reaction descriptor** | REPRESENTED EXACTLY ONCE in display output |
| **Renderer failure rolls back committed state** | PROHIBITED |
| **Clarification creates authoritative objects** | PROHIBITED |
| **Interpreter pending version** | PHASE 2 SHADOW SNAPSHOT VERSION; PHASE 3+ AUTHORITATIVE PRECONDITION VERSION |
| **Phase 2 shadow identity** | RUNTIME-ONLY, SESSION-SCOPED, NEVER AUTHORITATIVE |
| **Phase 2 synthesized structured IDs** | PROHIBITED |
| **Phase 2 Interpreter output consumption** | OBSERVATION ONLY |
| **Renderer pending version** | COMMITTED RESULTING state version |
| **Player and NPC commits** | SEPARATE ATOMIC COMMITS |
| **Canonical NPC segment references uncommitted object** | PROHIBITED |
| **NPC utterance publication identity** | EXACTLY ONE per committed reaction; canonical record or controlled lifecycle `publicationId` |
| **AcceptedSpeechAct phase** | STORED AS `acceptedPhase` |
| **PublicEvent phase** | STORED AS `occurredPhase` |
| **Duplicate committed request** | RETURNS ORIGINAL CommitResult, NO MUTATION |
| **Renderer failure rolls back committed NPC state** | PROHIBITED |
| **CanonicalClaim provenance source count** | EXACTLY ONE valid `ClaimSource` |
| **Player/NPC claim provenance** | Player uses accepted acts; NPC uses plan descriptor |
| **NPC semantic event provenance** | COMMITTED reaction plan plus compatible descriptor |
| **Descriptor IDs** | ENGINE-GENERATED, PLAN-UNIQUE, IMMUTABLE |
| **Reaction causation events** | COMMITTED BEFORE reaction preparation only |
| **Publication reservation/finalization** | APPEND-ONLY separate records |
| **Reservation replacement or mutation** | PROHIBITED |
| **Controlled publication finalization count** | EXACTLY ONE |
| **Renderer failure publication behavior** | FINALIZE reserved engine fallback |
| **Late Renderer changes finalized publication** | PROHIBITED |
| **CommitResult references uncreated object** | PROHIBITED |
| **Sink/delivery/acknowledgement lifecycle mutates authoritative state/version** | PROHIBITED |
| **Authoritative finalization-record append treated as display-only lifecycle** | PROHIBITED |
| **NpcReactionPlan originating input count** | EXACTLY ONE committed `PlayerInputRecord` |
| **Information-only reaction causation count** | ZERO permitted |
| **Controlled variant publication key** | ID + VERSION + STORED LOCALE |
| **Variant replay locale source** | STORED PUBLICATION LOCALE, never current UI locale |
| **Publication slot vs record append order** | DISTINCT SEMANTICS |
| **Reservation rendered as utterance** | PROHIBITED |
| **Timeout/abort pending removal** | AFTER finalization and result persistence |
| **CanonicalClaim idempotency derivation** | SELECTED BY PLAYER/NPC PROVENANCE |
| **Permanent publication dependency on runtime pending state** | PROHIBITED |
| **Reload recovery baseline** | EXPLICITLY UNSUPPORTED; future persistence phase required |
