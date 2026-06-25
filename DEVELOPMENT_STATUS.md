# Development Status

Last updated: 2026-06-25

## Current State

- 5-player werewolf prototype is implemented.
- Current roles are 1 werewolf, 1 seer, and 3 citizens.
- The game can run through player question, NPC response, vote, execution, night, seer action, werewolf attack, and win check.
- NPC response generation uses an injectable asynchronous provider interface.
- The default provider is still a pseudo-LLM implementation, not a real LLM call.
- Game logic is mostly separated from the temporary CLI UI.
- UI-independent asynchronous action API is available through `await dispatchPlayerAction(action)`.
- Public UI state can be read through `getPublicSnapshot()`.
- Player-facing logs and developer logs are separated.
- Minimal suspicion updates from accusatory player questions are implemented.
- Core game and response-provider invariants are covered by 16 automated tests using Node.js `node:test`.

## Last Verified

- Date: 2026-06-25
- Commands:
  - `npm.cmd test`
  - `npm.cmd run sample`
  - `git diff --check`
- Result: all 16 automated tests passed, sample play audit checks were all OK, and no whitespace errors were found.

## Next Recommended Task

1. Start implementing the browser UI adapter using the asynchronous action API and public snapshots.
2. Add a real LLM provider after provider-level validation and configuration are designed.
3. Improve natural language intent parsing and NPC-response-driven suspicion updates.

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
- Local `master` is synchronized with `origin/master` before this session's new changes.
- Game state is intentionally kept in memory only; save/load is not planned.

## Working Rule

At the end of each development session:

- Run the relevant verification command.
- Update this file with the latest status.
- Update `CHANGELOG.md`.
- Commit the completed work.
