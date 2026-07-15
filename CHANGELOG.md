# Changelog

## Unreleased

- Defined the Phase 6 NPC reaction retry-policy protocol maximum as a new docs-only architecture decision: `maxAttempts` is a safe integer in `1..8`, with `3` retained as the independent initial default. Logical reactions capture the engine-owned value immutably at creation; AI/provider output and current global defaults are not historical authority. The bound limits provider exposure and coordinator metadata without changing runtime, schema version, tombstones, the seven-field control root, or the delivery controller's separate attempt policy. The next docs contract will add tombstone retry-policy evidence.
- Implemented the production-unconnected Phase 6 Pure Preparation boundary: one synchronous `prepareNpcReaction(input)` strictly reconstructs validated candidate, snapshot, allocation, and order evidence; rechecks live bindings and authorization; deterministically maps all four proposal kinds into canonical-only plans, claims, events, segments, one publication, zero-effect deltas, and the expected result; computes a browser-safe preparation fingerprint; and returns detached recursively frozen prepared or closed rejected values. It generates no identity, mutates no counter/state, and connects no coordinator, commit, provider, delivery, Renderer, or route. Canonical-claim contradiction validation now matches the authoritative committed-claim projection bound so all prior conflicting claims can be represented.
- Aligned the Phase 6 runtime contracts without connecting production routes: `NpcReactionPlan` now requires the engine-owned successful attempt and exact safe-integer version transition; strict pre-commit and committed-graph reference contexts compare only actual schema owners; canonical NPC committed graphs require one idempotency record and unique attempt ownership independently of coordinator cleanup; and candidate structure enforces the shared maximum of four role/result proposals before fingerprinting or authorization. Preparation, commit, provider, delivery, and route integration remain unimplemented.
- Defined the Phase 6 successful-attempt reference contract without runtime changes: existing plan, preparation-binding, commit-delta, and commit-result schemas remain unchanged; schema-only, pre-commit, and post-commit validation responsibilities are separate; pre-commit resulting version is compared through the commit delta; post-commit successful-attempt authority is the plan plus NPC idempotency record; post-commit `turnOrder` is idempotency-record-owned only; and committed validation remains independent of coordinator cleanup and tombstones. Runtime Contract Alignment remains stopped until this documentation is merged.
- Corrected the Phase 6 C2 delivery-controller contract without runtime changes: current publication state and bounded retained attempt history are separate indexes; consumer replacement preserves old-generation abandonment/collision evidence while publishing a new pending current record; old receipts, tokens, capabilities, and callbacks fail closed; `ack_only` is issued only by sink success; and proved no-effect retry exhaustion is distinguished from ambiguous visible effect as `terminal_exhausted` versus `terminal_ambiguous`.
- Defined the Phase 6 C2 canonical NPC delivery contract without runtime changes: one independent session-local controller owns strict committed-publication discovery, head-of-line ordering, detached canonical payloads, attempts, deadlines/abort, exact sink receipts, acknowledgements, retry tokens, failure classification, reset invalidation, and redacted observations. Browser DOM attachment and CLI configured-write fulfillment are the only sink evidence; history/replay never deliver; delivery never changes `N+2`; and Phase 6 never activates the AI Renderer, provider, server, endpoint, or legacy fallback.
- Corrected the Phase 6 C1 cleanup-pending docs contract without runtime changes: authoritative reaction commit and coordinator cleanup are separate root transactions; cleanup failure preserves the byte-identical pre-terminalization `active`/`validated` control root; cleanup pending is derived from the complete authoritative graph plus that old root rather than a new status; replay/conflict remains authoritative-first and mutation-free; and coordinator-only cleanup retry is one idempotent detached-root replacement. Runtime cleanup and Phase 7 APIs remain unimplemented; C2 now defines delivery without implementing it.
- Corrected the Phase 6 C1 docs contract without runtime changes: Renderer processing is nonauthoritative while a future finalization-record append is a separate authoritative one-version transaction; one exact `NpcReactionCoordinatorControlRoot` owns logical reactions, attempts, reservations, tombstones, and terminal order; planned logical creation and reservation publication are atomic; committed reaction-plan IDs remain collision-protected after tombstone eviction; and identity/projection/root failures cannot leak reservations, capacity, eviction, or terminal-order gaps. Exact Phase 7 append APIs remain deferred; C2 now closes the canonical delivery contract.
- Defined the Phase 6 C1 runtime ownership and ledger contract without runtime changes: the existing `state.conversation.publications`, `nextPublicationSlotOrder`, and `nextRecordAppendOrder` fields are the sole authoritative publication ledger shared by player, NPC, and future Phase 7 records; alternate canonical or per-producer counters are forbidden; dense integrity, exhaustion, replay, rollback, and delivery separation are exact. Defined the session-local nonauthoritative coordinator ledger with zero-based gapless terminal order, 1024 combined reservation/tombstone capacity, oldest-tombstone-only eviction, all-reservation and safe-integer failure before ID allocation, order-preserving terminalization, and reset destruction. Exact NPC delivery runtime remains unimplemented, while C2 now defines its contract; production, tests, routes, provider, commit, and display are unchanged.
- Defined and corrected the Phase 6 authoritative NPC reaction commit contract: exact pre-provider replay and stored conflicts precede reservation/CAS and remain available after cleanup; strict reaction idempotency and uniqueness indexes protect the complete graph; canonical publication counters are authoritative while delivery ordering is separate; terminal tombstones contain only terminal attempt summaries; terminal conflicts mutate no existing lifecycle; copy-on-write publishes one canonical graph at the replacement `N+1 -> N+2` position with no third transition. Runtime preparation/commit/replay/coordinator/provider/delivery behavior remains unchanged.
- Defined the Phase 6 authoritative NPC reaction preparation contract: the canonical-only plan fields remain mandatory, one synchronous pure preparation API consumes strict validated-candidate/snapshot/allocation/order evidence, closed logical/attempt/actor applicability remains distinguishable from malformed input, claim-producing proposals/allocations/results share the unchanged four-claim cap, fingerprint primitive failure is an invariant, all four proposals map deterministically to descriptors/claims/events/segments, and initial suspicion/memory/legacy-history/vote/phase deltas are exactly empty. Prepared values remain nonauthoritative until the separately defined commit contract is implemented; runtime preparation, provider routing, commit, and delivery are unchanged.
- Corrected the merged isolated Phase 6 candidate validator to the reachability contract: the active rejection set is exactly 18 codes, four unreachable identifiers remain reserved and unexported, empty/whitespace headers reject at stage 1, `result_claim` uses permission/reference/target/exact-fact precedence including dead-but-rostered targets, and all 25 active step/stage/location tuples have executable coverage. Provider routing, authoritative commit, publication, display, and production integration remain unchanged.
- Defined the Phase 6 candidate-validation rejection reachability contract: empty or whitespace-only transport headers are stage-1 `invalid_envelope` evidence, every active rejection code has a strict reachable vector, unreachable generic actor/knowledge/final-live/policy identifiers are reserved rather than active, and `result_claim` now has an exact reference/target/fact first-failure order. Runtime, tests, provider routing, and the then-separate implementation were unchanged by that documentation change.
- Implemented the isolated Phase 6 structured NPC candidate-validation pipeline with one synchronous raw-transport entrypoint, closed invariant errors and rejection results, exact stages 0 through 18, strict four-member candidate reconstruction, engine-owned request/candidate/projection fingerprints, semantic authorization, terminal duplicate/conflict handling, detached recursive freezing, and zero authoritative writes, provider calls, publication, display, or production routing.
- Defined the remaining Phase 6 validation-only input boundary: raw HTTP success-response evidence before UTF-8/JSON parsing, one strict pure validation input, an engine-owned observed-candidate union, an exact live applicability projection, complete pending/logical status routing, terminal duplicate/conflict versus hard-stale precedence, a nineteen-stage fail-closed evaluation order numbered 0 through 18, and explicit transport/runtime reason-code ownership. No runtime, provider, endpoint, routing, coordinator, or candidate-validation implementation changed.
- Defined the docs-only Phase 6 NPC candidate-validation contract: exact correlated request/success envelopes, a strict four-member proposal union, kind-specific target authorization, a closed role-disclosure policy, reproducible candidate fingerprints, an immutable detached `ValidatedNpcReactionCandidate`, a closed redacted validation-result union, and a nonauthoritative validation-only lifecycle boundary. Runtime/provider/commit behavior is unchanged.
- Added the Phase 4 `PlayerLegacyDisplayCompatibilityRecord` writer and session-scoped registry. Each Phase 4 player publication now atomically records one engine-owned mapping to its unchanged legacy player-log location using the canonical-entry SHA-256 fingerprint in the existing `N -> N+1` transaction.
- Added strict mapping schema and committed-graph validation, one-to-one identity/cardinality checks, final-CAS append-location protection, replay corruption rejection without backfill, complete working-copy rollback, and immutable read-only lookup by publication or mapping ID.
- Completed the default-off Migration Phase 5 implementation for browser/CLI structured display and history using exact `PlayerLegacyDisplayCompatibilityRecord` resolution; position-, phase-, FIFO-, and message-based legacy replacement were removed. The pull request remains Draft pending review.
- Added the session-local player publication delivery state machine, controller-issued sink-success receipts, explicit idempotent acknowledgement, retry and acknowledgement-only retry, stale session/generation rejection, and observer-failure isolation without authoritative state mutation.
- Added executable browser-like DOM and CLI output-sink coverage for successful writes, sink failure, retry, duplicate suppression, reset isolation, safe text handling, and exactly-once visible output. The Phase 5 flag now makes structured publication the sole active player display trigger while retaining legacy storage and the unchanged NPC legacy path.
- Separated deterministic structured history projection from the explicit live-delivery envelope. Replay, `get_state`, diagnostics, snapshots, and stale history cursors cannot trigger a sink or acknowledgement; pre-cutover publications remain available to history without live backfill.
- Bound every browser/CLI sink write to the controller-frozen prepared candidate and made acknowledgement-only retry require the exact session, publication, consumer, generation, attempt, sink type, and controller-issued receipt identity.
- Decoupled controller-owned pending delivery from the legacy log cursor and ordered pending player publications with the current NPC delta by absolute append order. Replay and retrieval do not trigger delivery or lose pending work.
- Added acknowledged rollback delivery modes: post-cutover unseen, retryable, and newly published player entries use the unchanged legacy shape through the same prepare/sink/receipt/acknowledgement protocol, while acknowledged entries are never redisplayed.
- Standardized stale acknowledgement observations as one redacted `stale_ack_rejected` event per invocation with a separate session or generation reason code.
- Made consumer mode switches atomic and retryable: engine mode bookkeeping changes only after controller acceptance, the first cutover watermark remains fixed across repeated ON/OFF cycles, and unacknowledged work survives generation changes.
- Recorded pre-cutover player identities only after a successful initial-OFF legacy sink, preventing rollback redisplay without treating failed writes as delivered.
- Classified valid old-session receipt identities presented to a replacement controller as observable stale acknowledgements while retaining fail-closed rejection for forged current-session receipts.
- Persisted terminal rendering failures by session and publication outside the active-attempt map, preventing mode or generation changes from rediscovering or bypassing the original fail-closed error through legacy fallback.
- Made first cutover conditional on successful legacy sink evidence for every earlier publication; undelivered entries remain in a cursor-independent OFF-mode retry queue and cutover rejection changes no mode bookkeeping.
- Added the explicit deferred quiescent cutover lifecycle: requested and effective modes are separate, the proposed watermark and required publication set are frozen, authoritative commands are gated while `draining_pre_cutover`, and completion/cancellation/reset use exact session-local transition identity.
- Added bounded exact pre-cutover drain retrieval and controller-owned legacy delivery evidence. Browser evidence now requires successful attachment to the intended DOM container, CLI evidence requires a fulfilled configured write, and sink-success/evidence failure retries evidence only without a second visible output.
- Added the default-off Migration Phase 4 atomic `PlayerConversationCommit`, including structured player artifacts, canonical result-claim assertions and relations, stored idempotency results, and the temporary legacy display compatibility delta.
- Split Phase 4-enabled conversation handling into player `N -> N+1` and provisional NPC reaction `N+1 -> N+2` transactions. Exact replay calls neither provider and provider failure preserves the player commit without publishing `N+2`.
- Added failure-injection, replay, version-ledger, claim, Unicode display-plan, feature-policy, and Phase 4-off regression coverage.

## 2026-07-12

- Implemented Migration Phase 3 authoritative Interpreter validation behind the default-off `INTERPRETER_VALIDATION_MODE` flag.
- Added engine-owned game session, logical turn/order, and state-version lifecycle with atomic compatibility transactions and rollback without version gaps.
- Added immutable authoritative request bindings, staged inputs, strict candidate/alternative/source-span validation, exact stale classification, bounded redacted diagnostics, and reset/late-response isolation.
- Phase 3 remains observation-only: no AcceptedSpeechAct, semantic event, canonical claim, structured commit, display plan, Renderer request, or player-facing behavior is produced from Interpreter output.
- When Phase 2 and Phase 3 flags are both enabled, Phase 3 owns the single Interpreter send and shadow sending is suppressed. Disable the Phase 3 flag for immediate rollback without migration.

## 2026-07-11

- Added unused, side-effect-free conversation pipeline Phase 1 domain definitions and strict runtime validators.
- Added deterministic claim idempotency helpers, canonical claim/vote/suspicion renderers, exact commentary-variant replay lookup, and unit tests.
- Hardened Phase 1 after review with strict Interpreter alternatives, engine-owned participant rendering, descriptor/segment and policy compatibility, full reference validators, registry eligibility checks, deep-frozen definitions, and unambiguous canonical JSON.
- Production game flow, providers, HTTP endpoints, browser behavior, and game-state mutation remain unchanged.

## 2026-07-01

- Recorded successful real OpenAI smoke-test result (`npm run smoke:openai`).
- Verified local integration using the production server and `OpenAIResponseProvider` path.
- Confirmed exactly 1 billable request (gpt-5.4-mini) with no retries and no fallbacks.
- Validated secure API key handling (not stored, removed from environment afterward).

## 2026-06-28

- Added a controlled one-call real OpenAI smoke-test workflow (`npm run smoke:openai`).
- Implemented explicit safety gates and opt-in (`I_ACCEPT_API_CHARGES`) for real API verification.
- Added automated tests (95 total) including coverage for the smoke-test logic using mocked HTTP responses.
- Added a secure server-side OpenAI response provider using the official Responses API.
- Implemented `OpenAIResponseProvider` with support for `input_text` and `reasoning: { effort: "none" }`.
- Added environment variable configuration with strict validation and sane defaults.
- Refactored `src/webServer.mjs` to separate core logic from listening for better testability.
- Added `/api/npc-response` proxy with allowlist-based validation and request size limits (64 KiB).
- Implemented `SessionManager` in the browser to prevent stale responses after "New Game".
- Enhanced security: Redacted private evidence when public claim is not allowed.
- Enhanced robustness: Strictly validated OpenAI response statuses, sanitized 400 error messages, and correctly classified body-reading timeouts.
- Fixed concurrency handling: Removed reset() to prevent unstable state and ensured activeRequests never becomes negative.
- Added automated tests (74 total) covering security invariants and edge cases.
- Updated Developer Mode to display structured diagnostics for both successful and failed responses.

## 2026-06-26

- Added Developer Mode to the browser UI.
- Implemented read-only `getDeveloperDiagnostics()` API in `WerewolfGame` using `structuredClone`.
- Added granular diagnostics for NPC internal states, developer logs, and LLM provider metadata (prompts, evidence, usage).
- Added Developer Mode UI with log filtering by NPC and kind.
- Expanded automated test suite from 16 to 24 tests to cover developer diagnostics.
- Added `AGENTS.md` with persistent repository instructions.
- Updated documentation for Developer Mode usage and security.

## 2026-06-25

- Added a first browser UI adapter using the public action API and public snapshots.
- Added a local static server and `npm.cmd run web` startup script.
- Added browser controls for NPC questions, voting, night progression, and new in-memory games.
- Updated documentation for browser UI startup and the next developer-mode milestone.
- Added minimal suspicion updates from accusatory player questions.
- Added automated coverage for question-driven suspicion updates.
- Updated development status, TODOs, and roadmap for browser UI adapter implementation.
- Corrected the recorded Git state now that local `master` is synchronized with `origin/master`.

## 2026-06-19

- Decided that game sessions are memory-only and will not support save/load persistence.
- Updated the next milestone to browser UI adapter preparation.
- Added an injectable asynchronous NPC response provider interface.
- Added `PseudoResponseProvider` as the default implementation.
- Separated response-request construction and code-controlled claim decisions from utterance generation.
- Added provider response validation and question-level failure recovery.
- Converted the UI-independent action API, CLI, sample play, and tests to async usage.
- Expanded automated coverage from 10 to 15 tests.
- Added 10 automated core game tests using Node.js `node:test`.
- Covered role setup, action API responses, public snapshot privacy, NPC speech rules, voting, execution, seer privacy and claims, attacks, and win checks.
- Added `npm.cmd test` as the standard automated test command.
- Updated development status and roadmap; the next milestone is the LLM response provider interface.

## 2026-06-17

- Added `dispatchPlayerAction(action)` as a UI-independent game action API.
- Added `getPublicSnapshot()` for browser/CLI-safe state reads.
- Updated CLI and sample play to use the action API.
- Updated development status to reflect GitHub private repository setup and initial push.
- Added development continuity documents:
  - `DEVELOPMENT_STATUS.md`
  - `ROADMAP.md`
  - `DECISIONS.md`
  - `TODO.md`
  - `CHANGELOG.md`
- Prepared the project for Git-based development tracking.

## 2026-06-13

- Added the initial 5-player werewolf prototype.
- Added CLI play flow.
- Added pseudo-LLM NPC response generation.
- Added vote, execution, night, seer, werewolf attack, and win-check flow.
- Added sample play and audit script.
