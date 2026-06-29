# Changelog

## 2026-06-28

- Added a secure server-side OpenAI response provider using the official Responses API.
- Implemented `OpenAIResponseProvider` with support for `input_text` and `reasoning: { effort: "none" }`.
- Added environment variable configuration with strict validation and sane defaults.
- Refactored `src/webServer.mjs` to separate core logic from listening for better testability.
- Added `/api/npc-response` proxy with allowlist-based validation and request size limits (64 KiB).
- Implemented `SessionManager` in the browser to prevent stale responses after "New Game".
- Enhanced security: Redacted private evidence when public claim is not allowed.
- Enhanced robustness: Strictly validated OpenAI response statuses and sanitized 400 error messages.
- Fixed concurrency handling: Ensured waiters settle on reset/abort.
- Added automated tests (68 total) covering security invariants and edge cases.
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
