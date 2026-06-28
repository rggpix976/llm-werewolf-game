# Development Status

Last updated: 2026-06-26

## Current State

- 5-player werewolf prototype is implemented.
- Current roles are 1 werewolf, 1 seer, and 3 citizens.
- The game can run through player question, NPC response, vote, execution, night, seer action, werewolf attack, and win check.
- NPC response generation uses an injectable asynchronous provider interface.
- The default provider is still a pseudo-LLM implementation, not a real LLM call.
- Game logic is mostly separated from the temporary CLI UI.
- UI-independent asynchronous action API is available through `await dispatchPlayerAction(action)`.
- Public UI state can be read through `getPublicSnapshot()`.
- A first browser UI adapter is available through `npm.cmd run web`.
- **Developer Mode** is implemented in the browser UI, allowing inspection of roles, hidden info, prompts, and provider diagnostics.
- `getDeveloperDiagnostics()` provides a read-only, structured view of the internal game state.
- Player-facing logs and developer logs are separated.
- Minimal suspicion updates from accusatory player questions are implemented.
- Core game, response-provider invariants, and developer diagnostics are covered by 24 automated tests using Node.js `node:test`.

## Last Verified

- Date: 2026-06-26
- Commands:
  - `npm test`
  - `npm run sample`
  - `npm run web`
  - `git diff --check`
- Result: all 24 automated tests passed, sample play audit checks were all OK, browser UI Developer Mode manual checks passed, and no whitespace errors were found.

## Next Recommended Task

1. Add a real LLM provider (Gemini, OpenAI, or Anthropic) after provider-level validation and configuration are designed.
2. Improve natural language intent parsing and NPC-response-driven suspicion updates.
3. Improve suspicion score updates from nuanced player questions and NPC responses.

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
