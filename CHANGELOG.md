# Changelog

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
