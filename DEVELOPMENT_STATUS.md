# Development Status

Last updated: 2026-07-16

## Current State

- Conversation pipeline migration Phases 1-5 are merged on `master`: pure domain contracts/renderers, shadow transport, authoritative player-candidate validation, atomic player conversation commit, exact compatibility mapping, structured player history/delivery, explicit pre-cutover drain, and browser/CLI sink acknowledgement. Migration feature flags remain default-off with strict dependencies.
- Phase 4 writes exactly one strict `PlayerLegacyDisplayCompatibilityRecord` for each structured player publication and unchanged legacy entry in the same atomic `N -> N+1` transaction. Phase 5 resolves that identity without positional/text inference and keeps history, live delivery, and acknowledgement separate.
- Phase 6 architecture is defined in `docs/conversation-pipeline-design.md`. The merged foundation provides the default-off flag, engine-owned logical/attempt identity domains, pure known-information projection, and no-op route compatibility; it does not call a candidate provider or perform an NPC structured commit.
- The browser-safe engine identity/fingerprint implementation and SHA-256 boundary coverage are merged. No weak random fallback, Node-only browser import, dependency, polyfill, or bundler was added.
- The Phase 6 NPC candidate-validation contract is defined authoritatively, including exact raw success-response transport evidence, the pure validation input, observed-candidate fingerprint ownership, live applicability snapshot, all pending/logical status routes, terminal duplicate/conflict versus hard-stale precedence, total evaluation order, transport reason-code ownership, request/response envelopes, proposal authorization, immutable validated value, redacted rejection union, and validation-only lifecycle boundary. Header shape/semantic ownership, the exact active 18-code set and 25 step/stage/location tuples, reserved non-rejection identifiers, and exact `result_claim` first-failure precedence are closed.
- Phase 6 actor-ineligibility failure ownership is now explicitly layer-scoped. `actor_ineligible` remains reserved and unexported only in the candidate-validation rejection union, where current actor applicability changes are `stale_request`; it remains active in the distinct Preparation and Authoritative Commit rejection unions, where an engine-owned current actor that is absent, dead, or unable to speak fails before policy/reference/target/fact checks. `permission_denied` remains policy/disclosure-only. No runtime, test, schema, version, provider, coordinator, commit, delivery, or route behavior changed.
- The isolated validation-only implementation is merged on `master` and exposes one synchronous `validateNpcReactionCandidate(input)` entrypoint plus closed constants and `NpcReactionCandidateValidationInvariantError`. It implements exact stages 0 through 18, raw transport validation, the active 18-code set, strict detached candidate reconstruction, engine-owned fingerprints, authorization, stale/duplicate/conflict classification, stage-17 deterministic rechecks, and recursively frozen results. It is not imported by `WerewolfGame`, browser, CLI, server, provider, or HTTP adapters and performs no provider call, route change, state mutation, version increment, publication, or display.
- The authoritative Phase 6 preparation contract defines the canonical-only `NpcReactionPlan`, pure `prepareNpcReaction(input)` boundary, strict snapshot/allocation/order inputs, all closed logical/attempt/actor applicability states, the shared four-claim candidate/allocation/result cap, exact proposal-to-artifact mapping, zero-effect Phase 6/8 boundary, deterministic presentation policy, canonical `NpcReactionCommitDelta`, closed preparation result/rejection/invariant contracts, and uncommitted idempotency reservation.
- The authoritative Phase 6 commit contract is defined: replay/conflict precedes stale applicability and CAS, a separate reaction idempotency record plus shared session uniqueness constraints protect the complete graph, copy-on-write publishes one canonical plan/claim/event/segment/publication/result graph from the commit input's precondition `N` to result `N+1`, and coordinator cleanup remains a separate nonauthoritative root transaction without another increment. The isolated non-routing implementation now provides this commit primitive and exact replay result, but it is not imported by `WerewolfGame` or any provider, route, endpoint, browser, CLI, delivery, or Renderer path.
- Docs PR C1 closes runtime ownership and ledger semantics without adding runtime: the existing `state.conversation.publications`, `nextPublicationSlotOrder`, and `nextRecordAppendOrder` fields form one authoritative registry shared by player, NPC, and future Phase 7 publication records, with dense integrity, exhaustion, replay, rollback, and delivery separation. Renderer/provider/selection/fallback/delivery/acknowledgement processing is nonauthoritative. A future `NpcUtterancePublicationFinalized` append is instead a separate authoritative copy-on-write transaction that reuses the reserved slot, increments the record counter and `stateVersion` once on success, and increments neither on replay/failure. Its record `stateVersion` remains originating-reaction provenance; the exact Phase 7 append API/version evidence is still undefined.
- C1 defines one nonauthoritative session-local `NpcReactionCoordinatorControlRoot` containing logical reactions, attempts, terminal reservations, tombstones, and terminal order. Complete planned-logical creation atomically inserts its logical entry and reservation, consumes one terminal order only on root replacement, and checks an engine-built authoritative committed-plan collision projection. Authoritative reaction commit and coordinator cleanup are separate root transactions: after authoritative `N+2`, cleanup failure preserves the byte-identical pre-terminalization control root (`active`, validated winner, prior nonwinner statuses, reservation, no tombstone). Cleanup pending is a runtime-private cross-root condition, not a new logical/attempt enum or record, and only the coordinator may retry one detached cleanup transaction; replay remains separate and authoritative-first. Reset destroys the full root and runtime handles. Combined reservation/tombstone capacity is 1024, eviction of the unique oldest tombstone occurs only with successful complete creation, and capacity/order/identity/projection failures leave no orphan, eviction, or counter gap. The isolated coordinator module implements this foundation but remains production-unconnected. C2 closes the separate NPC browser/CLI delivery contract, while the legacy provisional NPC route remains the current runtime.
- The Phase 6 C2 canonical NPC delivery contract is now defined without runtime changes. One independent session-local `NpcPublicationDeliveryController` owns strict discovery, head-of-line slot ordering, canonical payload preparation, deadlines/abort, opaque sink receipts, acknowledgements, exact retry tokens, duplicate/stale suppression, reset invalidation, and redacted observations. Current publication state is separate from a bounded retained-attempt registry (1024 current records, 3072 attempts), so consumer replacement preserves old-generation abandoned identity while publishing a new pending current record and invalidating old callbacks/capabilities. `ack_only` originates only from sink success; no transport failure produces it. Proved no-effect retry exhaustion is `terminal_exhausted`, while unknown visible effect is `terminal_ambiguous`. Browser DOM attachment and CLI configured-write fulfillment are the only sink evidence; history and commit replay never deliver or acknowledge. Phase 6 canonical delivery does not activate the AI Renderer, provider, server, or endpoint, and every delivery outcome leaves the committed reaction at `N+2`.
- Phase 6 Runtime Contract Alignment implements the merged successful-attempt reference contract without extending the plan, preparation-binding, commit-delta, or commit-result schemas. `validateNpcReactionPlan(plan)` requires the engine-owned winning attempt and an exact safe-integer precondition `N` to result `N+1` pair while rejecting plan-owned fingerprint/order aliases. `validateReactionPlanReferences(plan, context)` separates strict pre-commit candidate/binding/delta ownership from strict committed plan/idempotency/result/publication ownership, and complete committed-graph validation enforces one idempotency record and session-wide attempt ownership without coordinator or tombstone state. Candidate structure enforces the shared maximum of four role/result proposals before fingerprinting or authorization. Pure preparation, the coordinator foundation, and the isolated authoritative commit primitive are implemented but production-unconnected; provider, delivery, and structured-route integration remain unimplemented.
- The production-unconnected Pure Preparation boundary implements synchronous `prepareNpcReaction(input)` with strict candidate/snapshot/allocation/order reconstruction, all closed current-state rejections and invariant failures, deterministic canonical-only descriptor/claim/event/segment/publication/result mapping, prior-committed claim relations, zero Phase 8 effects, browser-safe preparation fingerprinting, detached reconstruction, and recursive freezing. It generates no IDs, advances no counters, reads or writes no authoritative state, and imports neither `WerewolfGame`, coordinator, provider, Renderer, nor delivery code. Production snapshot/allocation/order builders, provider routing, delivery, and structured-route integration remain unimplemented and the feature stays default-off/inert.
- The Phase 6 NPC reaction retry-policy maximum and tombstone evidence contracts are implemented by the isolated coordinator foundation. `maxAttempts` is a safe integer in `1..8`, while `3` remains only the initial default. Each logical reaction captures an immutable engine-owned snapshot, and both committed and non-commit `ReactionTombstone` variants require its exact historical value. Terminalization validates the real logical IDs, attempt records, and ordered summaries before deleting source entries; afterward the tombstone alone validates its bound and terminal evidence. Cleanup retry, eviction, reset/destroy, privacy, the seven-field root, and schema version `1` need no external policy registry.
- The Phase 6 candidate-fingerprint ownership contract is implemented by the isolated coordinator foundation. Each strict `PendingNpcReactionAttempt` owns one required `candidateFingerprint: Sha256Fingerprint | null`; `null` is the sole unobserved representation, the first successful validation publishes the engine-computed fingerprint atomically with `candidate_received -> validated`, and the value is immutable. The closed eight-status matrix requires fingerprints for `validated`/`accepted`, forbids them for `attempting`/`candidate_received`/`failed`/`timed_out`, and preserves the source observation state for `rejected`/`aborted`. Cleanup copies root-contained attempt evidence exactly into tombstone observation variants, and tombstone-only/`already_cleaned` validation needs no external registry.
- The Phase 6 active identity-conflict terminalization contract is implemented by the isolated coordinator foundation. `attempting` and `candidate_received` become `aborted` with `null`; `validated` becomes `rejected` with its fingerprint; terminal `failed`, `timed_out`, `rejected`, and `aborted` attempts preserve their exact status and observation evidence while the active logical reaction becomes `rejected`. `accepted` is unreachable on this path because it exists only transiently inside committed cleanup; active/accepted is an invariant. The closed transition table, 7-by-8 applicability matrix, tombstone summaries, seven-field root, and schema version `1` remain aligned.
- The production-unconnected Phase 6 Coordinator Control-Root Foundation is now implemented in a browser-safe isolated module. It owns the exact seven-field schema-version-1 session root, published `planned | active` logical reactions, all eight attempt-status evidence shapes, terminal reservations, bounded tombstones, retry-policy limits, atomic candidate observation/fingerprint assignment, duplicate/conflict classification, the closed identity-conflict transition matrix, committed/non-commit cleanup, tombstone-only validation, strict evidence-matched `already_cleaned` retries, and reset/destroy invalidation. The other five logical terminal statuses are validated as terminal tombstone outcomes after atomic removal and are never published as logical entries in the active root. The combined reservation/tombstone capacity remains 1024 with whole oldest-tombstone eviction only on successful planned creation. The module is not imported by `WerewolfGame`, browser, CLI, server, provider, endpoint, authoritative commit, publication, delivery, or Renderer routes.
- The production-unconnected Phase 6 non-routing authoritative commit primitive is now implemented in a browser-safe isolated module. `commitNpcReactionAuthoritatively(input)` accepts one prepared reaction with strict pre-commit reference, coordinator-root, and live-applicability evidence; validates the current registry and preparation fingerprint; resolves exact replay and stored identity conflicts before stale checks; rechecks session, turn, phase, version, actor, target, reference, policy, result facts, artifact availability, and dense ordering; applies the complete canonical graph to a detached working copy; advances `stateVersion` and all three authoritative counters exactly once; validates the committed graph independently of cleanup; and returns a frozen committed result plus coordinator-cleanup handoff. Rejection, invariant, replay, and fault paths publish no partial graph and do not mutate either supplied root. The module is not imported by `WerewolfGame`, browser, CLI, server, provider, endpoint, delivery, Renderer, or structured routes.
- The original pre-contract Phase 6 implementation Goal remains BLOCKED as historical state and was not completed, cancelled, resumed, overwritten, or updated. Separately approved validation-only and docs-only tasks proceeded under explicit Goal-registration exceptions without changing that history.
- Validation-only success is explicitly nonauthoritative: no descriptor/claim/event/publication/commit ID, delta, `N+1 -> N+2`, display, acknowledgement, or legacy fallback is created by candidate validation.
- Exact replay performs no redisplay or provider call, and all migration feature flags remain default-off.
- `WerewolfGame` owns session/turn/order/version metadata for both browser and CLI and applies each compatibility command as one isolated authoritative transaction.
- 5-player werewolf prototype is implemented.
- Current roles are 1 werewolf, 1 seer, and 3 citizens.
- The game can run through player question, NPC response, vote, execution, night, seer action, werewolf attack, and win check.
- NPC response generation uses an injectable asynchronous provider interface.
- Added a secure server-side OpenAI response provider using the official Responses API raw HTTP shape.
- Support for `LLM_PROVIDER=openai` with strict environment variable configuration.
- Server-side API endpoints: `GET /api/runtime-config` and `POST /api/npc-response`.
- Implemented strict server-side request validation with a 64 KiB byte-limit and allowlisted fields.
- Redaction of private evidence (seer results) when public claim is not allowed.
- Browser-side `HttpResponseProvider` and `SessionManager` for robust stale response prevention and request cancellation.
- Configurable concurrency limit and RPM limit for OpenAI calls.
- Transient error fallback to `PseudoResponseProvider` for game continuity.
- Added a controlled one-call real OpenAI smoke-test workflow (`npm run smoke:openai`) for local verification.
- UI-independent asynchronous action API is available through `await dispatchPlayerAction(action)`.
- Public UI state can be read through `getPublicSnapshot()`.
- A first browser UI adapter is available through `npm.cmd run web`.
- **Developer Mode** is implemented in the browser UI, providing detailed diagnostics including raw Responses API status, error details, and fallback status.
- Player-facing logs and developer logs are separated.
- Core game, conversation contracts, Phase 2-5 migration boundaries, Phase 6 inert foundation/projection, browser-safe identity generation, response-provider invariants, diagnostics, configuration, request validation, and API endpoints have automated coverage. The current verified count is recorded below.

## Last Verified

- Date: 2026-07-16
- Commands:
  - `npm.cmd test`
  - `npm.cmd run sample`
  - `git diff --check`
  - documentation JSON/schema/fingerprint, UTF-8, conflict-marker, privacy/secret, and forbidden-Unicode validation
- Result: 368/368 tests passed. The dedicated non-routing authoritative commit suite passed 13/13, including absent/dead/unable-to-speak actor precedence, policy/disclosure-only `permission_denied`, exact layer-scoped rejection constants, atomic complete-graph publication, detached deterministic replacement, exact replay, conflicting retry, strict input/fingerprint invariants, version and order boundaries, successful-attempt ownership, final live validation, artifact collision/registry rollback, cleanup-independent committed validation, and browser-safe production isolation. Candidate validation passed 23/23 with actor applicability fixed to `stale_request`, and Pure Preparation passed 12/12 with active `actor_ineligible`. The Coordinator Control-Root Foundation suite remains covered. `npm.cmd run sample`, changed-module syntax checks, and `git diff --check` passed. No dependency, package, lockfile, game-engine, browser, CLI, server, provider, endpoint, delivery, Renderer, or production route changed.
- **Real OpenAI Smoke Test**:
  - Result: PASS
  - Date: 2026-07-01
  - Model: `gpt-5.4-mini`
  - Provider: `openai`
  - Outbound requests: Exactly 1 billable request
  - Status: Completed (HTTP 200)
  - Fallback used: False
  - Retries: Disabled
  - Usage: 571 input tokens, 27 output tokens (598 total)
  - Elapsed time: 2378 ms
  - Security: API key was not committed or stored. Key was removed from the local shell environment immediately after verification (Test-Path Env:OPENAI_API_KEY returned False).
  - Scope: Validates controlled local integration using the production server and provider paths. This does not make the project production-ready; authentication and distributed rate limiting remain unimplemented.

## Next Recommended Task

1. Review the production-unconnected non-routing authoritative NPC reaction commit against the layer-scoped actor-ineligibility contract without connecting it to `WerewolfGame` or any production route.
2. After merge, define and approve the next separately scoped Phase 6 implementation stage against the new authoritative `master`.
3. Keep provider/delivery and structured-route integration as later reviewed stages, and retain the legacy provisional NPC transaction as the active runtime route. The old Phase 6 implementation Goal remains BLOCKED history.

## Read This First Next Time

1. `README.md`
2. `DEVELOPMENT_STATUS.md`
3. `ROADMAP.md`
4. `DECISIONS.md`
5. `TODO.md`
6. `src/gameEngine.mjs`
7. `src/responseGenerator.mjs`
8. `src/responseProvider.mjs`
9. `tests/gameEngine.test.mjs`

## Current Git/GitHub State

- Local Git repository exists.
- GitHub private repository exists: `https://github.com/rggpix976/llm-werewolf-game`
- `origin` is configured as `https://github.com/rggpix976/llm-werewolf-game.git`.
- Local `master` tracks `origin/master`.
- The authoritative Phase 6 docs define candidate validation, attempt-owned immutable candidate-fingerprint retention and tombstone transfer, canonical-only reaction preparation, authoritative commit, shared publication-ledger ownership, the complete session-local coordinator control root, and the independent canonical NPC delivery lifecycle without changing Phase 4/5 runtime behavior. Validation-only, Runtime Contract Alignment, Pure Preparation, Coordinator Control-Root Foundation, and the non-routing authoritative commit primitive are present but remain production-unconnected; production builders, structured route replacement, provider integration, and delivery remain unimplemented. The exact Phase 7 finalization append API and controlled Renderer implementation remain pending separate work.
- Game state is intentionally kept in memory only; save/load is not planned.

## Working Rule

At the end of each development session:

- Run the relevant verification command.
- Update this file with the latest status.
- Update `CHANGELOG.md`.
- Commit the completed work.
