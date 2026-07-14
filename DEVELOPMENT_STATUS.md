# Development Status

Last updated: 2026-07-14

## Current State

- Conversation pipeline migration Phases 1-5 are merged on `master`: pure domain contracts/renderers, shadow transport, authoritative player-candidate validation, atomic player conversation commit, exact compatibility mapping, structured player history/delivery, explicit pre-cutover drain, and browser/CLI sink acknowledgement. Migration feature flags remain default-off with strict dependencies.
- Phase 4 writes exactly one strict `PlayerLegacyDisplayCompatibilityRecord` for each structured player publication and unchanged legacy entry in the same atomic `N -> N+1` transaction. Phase 5 resolves that identity without positional/text inference and keeps history, live delivery, and acknowledgement separate.
- Phase 6 architecture is defined in `docs/conversation-pipeline-design.md`. The merged foundation provides the default-off flag, engine-owned logical/attempt identity domains, pure known-information projection, and no-op route compatibility; it does not call a candidate provider or perform an NPC structured commit.
- The browser-safe engine identity/fingerprint implementation and SHA-256 boundary coverage are merged. No weak random fallback, Node-only browser import, dependency, polyfill, or bundler was added.
- The Phase 6 NPC candidate-validation contract is defined authoritatively, including exact raw success-response transport evidence, the pure validation input, observed-candidate fingerprint ownership, live applicability snapshot, all pending/logical status routes, terminal duplicate/conflict versus hard-stale precedence, total evaluation order, transport reason-code ownership, request/response envelopes, proposal authorization, immutable validated value, redacted rejection union, and validation-only lifecycle boundary. Header shape/semantic ownership, the exact active 18-code set and 25 step/stage/location tuples, reserved non-rejection identifiers, and exact `result_claim` first-failure precedence are closed.
- The isolated validation-only implementation is merged on `master` and exposes one synchronous `validateNpcReactionCandidate(input)` entrypoint plus closed constants and `NpcReactionCandidateValidationInvariantError`. It implements exact stages 0 through 18, raw transport validation, the active 18-code set, strict detached candidate reconstruction, engine-owned fingerprints, authorization, stale/duplicate/conflict classification, stage-17 deterministic rechecks, and recursively frozen results. It is not imported by `WerewolfGame`, browser, CLI, server, provider, or HTTP adapters and performs no provider call, route change, state mutation, version increment, publication, or display.
- The authoritative Phase 6 preparation contract now defines the canonical-only `NpcReactionPlan`, pure `prepareNpcReaction(input)` boundary, strict snapshot/allocation/order inputs, all closed logical/attempt/actor applicability states, the shared four-claim candidate/allocation/result cap, exact proposal-to-artifact mapping, zero-effect Phase 6/8 boundary, deterministic presentation policy, canonical `NpcReactionCommitDelta`, closed preparation result/rejection/invariant contracts, and uncommitted idempotency reservation. Runtime preparation and final commit are not implemented. The merged candidate validator does not yet enforce the new combined role/result count sub-bound; plan/candidate validator alignment belongs to the preparation implementation. Replay lookup, CAS order, atomic application/rollback, status/tombstone transitions, and commit-owned idempotency/publication insertion remain the next Authoritative Commit Contract.
- The original pre-contract Phase 6 implementation Goal remains BLOCKED as historical state and was not completed, cancelled, resumed, overwritten, or updated. This separately approved validation-only task proceeded under the explicit Goal-registration exception.
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

- Date: 2026-07-14
- Commands:
  - `npm.cmd test`
  - `npm.cmd run sample`
  - `git diff --check`
  - documentation JSON/schema/fingerprint, UTF-8, conflict-marker, privacy/secret, and forbidden-Unicode validation
- Result: 321/321 tests passed. The focused Phase 6 candidate-validation suite passed 21/21 and the Phase 6 foundation suite passed 9/9. `npm.cmd run sample`, changed `.mjs` syntax checks, `git diff --check`, browser import-boundary, no-routing, privacy/secret, conflict-marker, and forbidden-Unicode scans passed. No dependency, package, lockfile, game-engine, browser, CLI, server, provider, endpoint, or authoritative-state route changed.
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

1. Define the Phase 6 Authoritative Commit Contract after this preparation contract: exact idempotency record/index, replay/CAS order, closed commit result, atomic apply/rollback order, logical/attempt/tombstone transitions, canonical publication ownership, legacy replacement boundary, and exactly one `N+1 -> N+2` transition.
2. Keep authoritative preparation/commit, `N+1 -> N+2`, publication, retry/timeout coordination, provider routing, and Renderer migration in their later separately reviewed stages.

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
- The authoritative Phase 6 docs define candidate validation and canonical-only reaction preparation without changing Phase 4/5 runtime behavior. Validation-only implementation is merged but remains production-unconnected; preparation runtime, production routing, provider/coordinator integration, authoritative commit, and delivery remain unimplemented.
- Game state is intentionally kept in memory only; save/load is not planned.

## Working Rule

At the end of each development session:

- Run the relevant verification command.
- Update this file with the latest status.
- Update `CHANGELOG.md`.
- Commit the completed work.
