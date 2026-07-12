# Development Status

Last updated: 2026-07-13

## Current State

- Conversation pipeline migration Phases 1-4 are implemented from `master`: pure domain contracts/renderers, shadow transport, authoritative candidate validation, and atomic player conversation commit. Their feature flags remain default-off with strict dependencies.
- Phase 4 writes exactly one strict `PlayerLegacyDisplayCompatibilityRecord` for each structured player publication and unchanged legacy entry in the same atomic `N -> N+1` transaction. The session-scoped mapping registry, immutable strict lookup, and fail-closed replay validation are available on this branch.
- Migration Phase 5 implementation exists only on this Draft branch and is not complete or merged. Its current consumer still performs position-based legacy replacement and must be changed to exact compatibility-mapping resolution.
- Sink-success receipts, explicit acknowledgement, retry/stale-ack handling, and browser/CLI behavioral tests are not implemented. The mapping-writer prerequisite has been incorporated from master. Phase 5 remains Draft pending exact mapping consumption, sink-success receipts, explicit acknowledgement, retry/stale-ack handling, and browser/CLI behavioral tests.
- `PlayerUtterancePublishedRecord` becoming the sole active browser/CLI player display trigger is target behavior only when the Phase 5 flag is enabled after the remaining work is completed and reviewed. Until then, the Phase 4 legacy player display remains authoritative; the NPC display remains on the provisional legacy path.
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
- Core game, conversation contracts, Phase 2-5 migration boundaries, Phase 4 atomic mapping, response-provider invariants, diagnostics, configuration, request validation, and API endpoints are covered by 253 automated tests on this Draft branch.

## Last Verified

- Date: 2026-07-13
- Commands:
  - `npm test`
  - `npm run sample`
  - `git diff --check`
  - `find . -name "*.mjs" -exec node --check {} \;`
  - `npm run smoke:openai` (Controlled live smoke test)
- Result: 246/253 tests passed; 7 existing Phase 5 consumer tests currently fail with `history_projection_failure` after incorporating the Phase 4 mapping writer. `git diff --check` and the conflict-marker scan passed; later validation commands were not run because the required test gate failed.
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

1. Improve natural language intent parsing and NPC-response-driven suspicion updates.
2. Improve suspicion score updates from nuanced player questions and NPC responses.

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
- The Phase 5 branch is pushed to `origin` and tracked by an open Draft pull request; it is not merged or ready for review completion.
- Game state is intentionally kept in memory only; save/load is not planned.

## Working Rule

At the end of each development session:

- Run the relevant verification command.
- Update this file with the latest status.
- Update `CHANGELOG.md`.
- Commit the completed work.
