# Development Status

Last updated: 2026-07-12

## Current State

- Conversation pipeline migration Phase 1 pure domain definitions, strict validators, deterministic ID helpers, canonical renderers, and unit tests are implemented but intentionally not integrated into production game flow.
- Migration Phase 2 shadow transport, Phase 3 authoritative candidate validation, and Phase 4 atomic player conversation commit are implemented behind separate default-off flags. Phase 4 requires Phase 3 and writes structured player artifacts at `N+1`; the existing NPC response effects publish provisionally at `N+2`.
- Phase 4 keeps the legacy player-question entry as the only visible browser/CLI trigger. Structured publications are stored but remain unconsumed until Phase 5, and exact replay performs no redisplay or provider call.
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
- Core game, conversation contracts, Phase 2/3 Interpreter boundaries, response-provider invariants, diagnostics, configuration, request validation, and API endpoints are covered by 219 automated tests.

## Last Verified

- Date: 2026-07-12
- Commands:
  - `npm test`
  - `npm run sample`
  - `git diff --check`
  - `find . -name "*.mjs" -exec node --check {} \;`
  - `npm run smoke:openai` (Controlled live smoke test)
- Result: 219/219 tests passed. `npm run sample` and `git diff --check` passed; all changed `.mjs` files pass syntax checks.
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
- Local `master` contains local implementation commits that have not been pushed yet.
- Game state is intentionally kept in memory only; save/load is not planned.

## Working Rule

At the end of each development session:

- Run the relevant verification command.
- Update this file with the latest status.
- Update `CHANGELOG.md`.
- Commit the completed work.
