# Development Status

Last updated: 2026-07-19

## Current State

- The Phase 6 NPC authority-integration architecture decision and Slices 1–6 are merged on `master`; PR #58 was incorporated by the normal two-parent merge commit `6d10fc9e0d06723bcfd8c24b0fb7b32522664572`. Slice 6 wires the existing default-off `NPC_STRUCTURED_REACTION_MODE` to the production Player-question boundary: disabled sessions retain the unchanged legacy NPC provider/display path, while enabled sessions exclusively invoke the Structured Route, suppress legacy fallback for that logical reaction, and use eligible committed outcomes only as hints to the delivery orchestrator. Browser and CLI construct their existing safe sink wrappers; the server registers the strict candidate endpoint only while the flag is enabled. Delivery discovery remains controller-owned, authoritative writes remain `WerewolfGame.state`-owned, route/provider failures stay redacted, reset invalidates route/delivery callbacks, and no delivery failure reruns Provider, Validation, Preparation, or Commit. The original Structured Route Goal was not resumed. It was superseded by the rewritten replacement Goal. After the replacement implementation was merged, the obsolete BLOCKED Goal was manually removed from the goal-management system. Its historical context remains in Git history and project documents.

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
- C1 defines one nonauthoritative session-local `NpcReactionCoordinatorControlRoot` containing logical reactions, attempts, terminal reservations, tombstones, and terminal order. Complete planned-logical creation atomically inserts its logical entry and reservation, consumes one terminal order only on root replacement, and checks an engine-built authoritative committed-plan collision projection. Authoritative reaction commit and coordinator cleanup are separate root transactions: after authoritative commit, cleanup failure preserves the byte-identical pre-terminalization control root (`active`, validated winner, prior nonwinner statuses, reservation, no tombstone). Cleanup pending is a runtime-private cross-root condition, not a new logical/attempt enum or record, and only the coordinator may retry one detached cleanup transaction; replay remains separate and authoritative-first. Reset destroys the full root and runtime handles. Combined reservation/tombstone capacity is 1024. Slice 6 now reaches this coordinator only through the default-off Structured Route; the legacy provisional NPC route remains available only on the disabled cutover branch.
- The Phase 6 C2 canonical NPC delivery contract is now defined without runtime changes. One independent session-local `NpcPublicationDeliveryController` owns strict discovery, head-of-line slot ordering, canonical payload preparation, deadlines/abort, opaque sink receipts, acknowledgements, exact retry tokens, duplicate/stale suppression, reset invalidation, and redacted observations. Current publication state is separate from a bounded retained-attempt registry (1024 current records, 3072 attempts), so consumer replacement preserves old-generation abandoned identity while publishing a new pending current record and invalidating old callbacks/capabilities. `ack_only` originates only from sink success; no transport failure produces it. Proved no-effect retry exhaustion is `terminal_exhausted`, while unknown visible effect is `terminal_ambiguous`. Browser DOM attachment and CLI configured-write fulfillment are the only sink evidence; history and commit replay never deliver or acknowledge. Phase 6 canonical delivery does not activate the AI Renderer, provider, server, or endpoint, and every delivery outcome leaves the committed reaction at `N+2`.
- Canonical NPC renderer version `1` remains a synchronous pure module and is now reached by enabled production delivery through the controller. It accepts only one strict committed-graph reference context plus one strict local rendering projection, applies the exact locale tables in plan order, preserves display-name code points, and returns one detached frozen fingerprinted payload. It still performs no sink write, receipt, acknowledgement, retry, provider call, history write, authoritative mutation, or `stateVersion` change.
- NPC sink begin/settlement is now closed as a docs-only C2 sub-contract. The exact frozen delivery request is a one-shot begin capability; the controller alone issues the branded settlement capability and attempt `AbortSignal`; monotonic time owns the exact 15,000 ms deadline and 1,000 ms cleanup grace; strict browser/CLI failure evidence cannot choose disposition; and one private gate linearizes success, failure, timeout, reset, capability consumption, handle cleanup, and observer order. No runtime method, test, root/attempt/receipt/token schema, route, provider, Renderer, legacy fallback, authoritative mutation, or `stateVersion` change was added.
- The NPC delivery controller retains its exact eleven-method API and session-local nonauthoritative state. Slice 6 constructs it behind the default-off production integration and supplies only the engine's narrow committed-graph/rendering-context read port. One-head discovery, renderer resolution, one-shot settlement, acknowledgement, retry tokens, consumer generation, and reset remain controller-owned and never mutate `WerewolfGame.state` or `stateVersion`.
- Browser and CLI now construct the existing NPC publication sink wrappers only when the production flag is enabled. Browser delivery uses injected text nodes and exact attachment evidence without HTML interpretation; CLI delivery awaits its writer and preserves the terminal-control policy. Both retain full private delivery identity, expose no receipt capability or controller token, and perform no automatic retry or acknowledgement outside the orchestrator.
- Phase 6 Runtime Contract Alignment preserves strict successful-attempt ownership, exact precondition `N` to result `N+1`, committed-graph completeness, and the four-claim bound. Slice 6 connects the already-implemented Provider, Candidate Validation, pure Preparation, Coordinator, atomic Commit, renderer, delivery controller, and sink wrappers only through the feature-gated Structured Route/integration boundary; their schemas and authority ownership are unchanged.
- Pure Preparation remains synchronous and side-effect-free. The enabled Structured Route now supplies its strict snapshot/allocation/order inputs and consumes its frozen prepared result before the engine-owned atomic Commit; Preparation itself still generates no IDs, advances no counters, reads or writes no authoritative state, and imports neither `WerewolfGame` nor delivery code.
- The Phase 6 NPC reaction retry-policy maximum and tombstone evidence contracts are implemented by the isolated coordinator foundation. `maxAttempts` is a safe integer in `1..8`, while `3` remains only the initial default. Each logical reaction captures an immutable engine-owned snapshot, and both committed and non-commit `ReactionTombstone` variants require its exact historical value. Terminalization validates the real logical IDs, attempt records, and ordered summaries before deleting source entries; afterward the tombstone alone validates its bound and terminal evidence. Cleanup retry, eviction, reset/destroy, privacy, the seven-field root, and schema version `1` need no external policy registry.
- The Phase 6 candidate-fingerprint ownership contract is implemented by the isolated coordinator foundation. Each strict `PendingNpcReactionAttempt` owns one required `candidateFingerprint: Sha256Fingerprint | null`; `null` is the sole unobserved representation, the first successful validation publishes the engine-computed fingerprint atomically with `candidate_received -> validated`, and the value is immutable. The closed eight-status matrix requires fingerprints for `validated`/`accepted`, forbids them for `attempting`/`candidate_received`/`failed`/`timed_out`, and preserves the source observation state for `rejected`/`aborted`. Cleanup copies root-contained attempt evidence exactly into tombstone observation variants, and tombstone-only/`already_cleaned` validation needs no external registry.
- The Phase 6 active identity-conflict terminalization contract is implemented by the isolated coordinator foundation. `attempting` and `candidate_received` become `aborted` with `null`; `validated` becomes `rejected` with its fingerprint; terminal `failed`, `timed_out`, `rejected`, and `aborted` attempts preserve their exact status and observation evidence while the active logical reaction becomes `rejected`. `accepted` is unreachable on this path because it exists only transiently inside committed cleanup; active/accepted is an invariant. The closed transition table, 7-by-8 applicability matrix, tombstone summaries, seven-field root, and schema version `1` remain aligned.
- The Coordinator Control-Root Foundation remains an exact seven-field schema-version-1 nonauthoritative module. The enabled Structured Route now owns its session-local instance and uses its planned/active attempts, reservations, tombstones, fingerprint assignment, terminalization, cleanup, and reset rules; `WerewolfGame.state` does not absorb coordinator metadata.
- The authoritative commit primitive remains pure over a detached transaction projection and is now invoked only inside the engine-owned atomic authority port reached by the enabled Structured Route. Replay, rejection, invariant, and fault paths still publish no partial graph; the final live root replacement remains solely owned by `WerewolfGame`.
- The candidate Provider boundary is now registered in `webServer.mjs` only while `NPC_STRUCTURED_REACTION_MODE` is enabled and is used directly through an equivalent local transport in CLI pseudo/OpenAI operation. It still performs exactly one upstream invocation per engine attempt, validates/detaches every binding, preserves reserved-kind ownership for Candidate Validation, uses conditional retryability, enforces raw HTTP/media/UTF-8/64 KiB rules, and never mutates authority or performs hidden fallback. The OpenAI Responses request uses one strict root object with a nested supported `anyOf` proposal union and no `oneOf`; 429 retry evidence is accepted only from an explicit decimal delta-seconds header within the existing two-second bound, while missing or malformed evidence remains nonretryable.
- Validation-only success is explicitly nonauthoritative: no descriptor/claim/event/publication/commit ID, delta, `N+1 -> N+2`, display, acknowledgement, or legacy fallback is created by candidate validation.
- Exact replay performs no redisplay or provider call, and all migration feature flags remain default-off.
- `WerewolfGame` owns session/turn/order/version metadata for both browser and CLI and applies each compatibility command as one isolated authoritative transaction.
- 5-player werewolf prototype is implemented.
- Current roles are 1 werewolf, 1 seer, and 3 citizens.
- The game can run through player question, NPC response, vote, execution, night, seer action, werewolf attack, and win check.
- NPC response generation uses an injectable asynchronous provider interface.
- Added a secure server-side OpenAI response provider using the official Responses API raw HTTP shape.
- Support for `LLM_PROVIDER=openai` with strict environment variable configuration.
- Server-side API endpoints include:
  - `GET /api/runtime-config`
  - `POST /api/npc-response`
  - `POST /api/interpret-player-input` while the corresponding Interpreter flag is enabled
  - `POST /api/generate-npc-reaction-candidate` while `NPC_STRUCTURED_REACTION_MODE` is enabled; the endpoint is absent and returns `404` while the flag is disabled
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
- Core game, conversation contracts, Phase 2-5 migration boundaries, Phase 6 canonical foundation/projection, Structured Route, Delivery controller/orchestrator/sinks, production integration, browser-safe identity generation, response-provider invariants, diagnostics, configuration, request validation, and API endpoints have automated coverage. The current verified count is recorded below.

## Last Verified

- Date: 2026-07-19
- Commands:
  - `npm.cmd test`
  - `npm.cmd run sample`
  - `git diff --check`
  - documentation JSON/schema/fingerprint, UTF-8, conflict-marker, privacy/secret, and forbidden-Unicode validation
- Result: 619/619 local tests passed. The Slice 6 production integration suite passes 10/10 and the focused upstream/Provider/production integration suites pass 39/39. Coverage includes exact transmitted Structured Outputs schema composition, all nine proposal variants, strict `oneOf` absence, valid OpenAI response parsing through injected transport, ten Retry-After vectors, one invocation with missing retry evidence, exact integration and authority surfaces from the canonical foundation through production integration, flag-off legacy preservation, flag-on CLI and Browser commit/delivery, legacy suppression, raw Browser transport bytes, feature-gated server registration, replay without delivery, Candidate rejection/provider failure without fallback, observer isolation, malformed/concurrent public actions, reset, privacy/redaction, and existing controller retry/acknowledgement/timer/consumer-generation matrices. `npm.cmd run sample`, changed-module syntax checks, browser-safe import scans, and `git diff --check` passed. PR #58's `PR Review Bundle` succeeded as a `pull_request` workflow for approved HEAD `544a1dd2fcc7421a2340ba56074251bbe9eaa80e`; no separate workflow run for merge commit `6d10fc9e0d06723bcfd8c24b0fb7b32522664572` is claimed. No dependency, package, lockfile, or workflow changed. No API key was created or used and no billable OpenAI smoke was run; the existing real OpenAI smoke below predates Slice 6 and is not evidence of the new candidate route.
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

1. Keep `NPC_STRUCTURED_REACTION_MODE` default-off and define a separate post-merge release-readiness/acceptance-audit Goal before any operational enablement.
2. That future audit may cover the end-to-end flag-on pseudo/mock path, failure injection, timeout/cancel/reset/late callbacks, duplicate suppression, privacy/security, observability, rollback, and final documentation. This docs-only reconciliation implements none of those items, performs no billable OpenAI smoke, and does not start Phase 7/8. Persistence/cross-process recovery, authentication, and distributed rate limiting remain out of scope.

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
- GitHub public repository exists: `https://github.com/rggpix976/llm-werewolf-game`
- `origin` is configured as `https://github.com/rggpix976/llm-werewolf-game.git`.
- Local `master` tracks `origin/master`.
- The authoritative Phase 6 docs define candidate validation, preparation, commit, coordinator, renderer, delivery, and sole-authority integration. Slices 1–6 are merged on `master`; the authoritative baseline is merge commit `6d10fc9e0d06723bcfd8c24b0fb7b32522664572`, whose approved PR #58 second parent is `544a1dd2fcc7421a2340ba56074251bbe9eaa80e`. PR #58 is MERGED by a normal two-parent merge commit. `NPC_STRUCTURED_REACTION_MODE` remains default-off: disabled sessions preserve the legacy NPC Provider/display path, while enabled sessions select the Structured Route, engine-owned atomic Commit, and canonical Delivery path without a legacy fallback for the same logical reaction. The original Structured Route Goal was superseded and its obsolete BLOCKED goal-management record was manually removed.
- Game state is intentionally kept in memory only; save/load is not planned.

## Working Rule

At the end of each development session:

- Run the relevant verification command.
- Update this file with the latest status.
- Update `CHANGELOG.md`.
- Commit the completed work.
