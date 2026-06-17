# Development Status

Last updated: 2026-06-17

## Current State

- 5-player werewolf prototype is implemented.
- Current roles are 1 werewolf, 1 seer, and 3 citizens.
- The game can run through player question, NPC response, vote, execution, night, seer action, werewolf attack, and win check.
- NPC response generation is currently a pseudo-LLM function, not a real LLM call.
- Game logic is mostly separated from the temporary CLI UI.
- UI-independent action API is available through `dispatchPlayerAction(action)`.
- Public UI state can be read through `getPublicSnapshot()`.
- Player-facing logs and developer logs are separated.

## Last Verified

- Date: 2026-06-17
- Command: `npm.cmd run sample`
- Result: sample play completed and audit checks were all OK.

## Next Recommended Task

1. Add automated tests for core game invariants.
2. Define the LLM response provider interface.
3. Add save/load support for JSON-serializable game state.
4. Prepare a browser UI adapter after the core API is stable.

## Read This First Next Time

1. `README.md`
2. `DEVELOPMENT_STATUS.md`
3. `ROADMAP.md`
4. `DECISIONS.md`
5. `TODO.md`
6. `src/gameEngine.mjs`
7. `src/responseGenerator.mjs`

## Current Git/GitHub State

- Local Git repository exists.
- GitHub private repository exists: `https://github.com/rggpix976/llm-werewolf-game`
- `origin` is configured as `https://github.com/rggpix976/llm-werewolf-game.git`.
- Local `master` tracks `origin/master`.
- Initial prototype commit has been pushed.

## Working Rule

At the end of each development session:

- Run the relevant verification command.
- Update this file with the latest status.
- Update `CHANGELOG.md`.
- Commit the completed work.
