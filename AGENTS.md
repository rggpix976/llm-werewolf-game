# Agent Instructions

This repository is a prototype of an LLM-integrated Werewolf game. As an AI agent working on this codebase, you MUST follow these instructions.

## Essential Reading

1. README.md
2. DEVELOPMENT_STATUS.md
3. ROADMAP.md
4. DECISIONS.md
5. TODO.md
6. CHANGELOG.md

## Core Principles

- **LLMs Do Not Mutate Game State**: Role assignment, life/death status, voting results, seer results, werewolf attacks, and win conditions are handled strictly by code in `src/gameEngine.mjs`.
- **Separation of Concerns**: Keep player-facing logs and developer logs separate.
- **Privacy**: Never add secret information (roles, hidden info, etc.) to the public snapshot returned by `getPublicSnapshot()`.
- **API Boundary**: Use `getDeveloperDiagnostics()` for developer tools and `getPublicSnapshot()` for the public UI. Do not allow the UI to directly reference `game.state`.
- **Security**: Never pass external input, player input, or provider responses directly to `innerHTML`. Use `textContent` or DOM APIs.
- **No Secrets in Repo**: Do not commit real API keys or sensitive credentials.
- **No External Calls in Tests**: Automated tests must not call real external LLM APIs. Use mocks or the `PseudoResponseProvider`.
- **Minimalism**: Do not add unnecessary toolchains, refactors, or dependencies.

## Standard Verification Commands

- `npm test`: Runs the Node.js automated tests.
- `npm run sample`: Runs a sample game play and audits the results.
- `npm run smoke:openai`: Performs one controlled, billable real OpenAI request. (Local use only, Jules must not use real keys).
- `npm run web`: Starts the browser UI.
- `git diff --check`: Checks for whitespace errors.

## Project Memory and Recording

The files listed under Essential Reading are this project's memory. When
they conflict with issue or chat context, they take priority.

- Follow existing design decisions documented in `DECISIONS.md`.
- `DECISIONS.md` records what was decided, and why. When a task involves a
  design choice that `DECISIONS.md` does not cover, add a new entry (next
  `D-0xx` number, same format: the decision and its reason) in the same
  pull request. Never silently diverge from an existing decision; if one
  must change, add a new entry that explicitly supersedes it.
- Update `DEVELOPMENT_STATUS.md` and `CHANGELOG.md` upon completion of a
  task, in the same pull request as the change they describe.
- `docs/INDEX.md` is a compact index of slices and features: state, last
  update, and where the detail lives. When a slice starts, changes state,
  or is merged, update its one-line entry in the same pull request. Keep
  entries to one line; detail belongs in `DEVELOPMENT_STATUS.md` and
  `DECISIONS.md`.
