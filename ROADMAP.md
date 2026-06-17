# Roadmap

## Phase 1: Stabilize Core Logic

- Formalize `GameState` and `PlayerState` shape.
- Add a UI-independent action interface. Done for the current prototype.
- Separate public snapshots from internal developer snapshots. Done for the current prototype.
- Make save/load possible with JSON-serializable state.

## Phase 2: Add Automated Tests

- Test death, voting, execution, seer action, werewolf attack, and win checks.
- Test that dead NPCs cannot speak.
- Test that seer results stay private until explicitly claimed.
- Test that werewolves cannot attack themselves.

## Phase 3: Prepare LLM Integration

- Define a response provider interface that can swap pseudo responses for real LLM calls.
- Build prompts from only the information each NPC is allowed to know.
- Validate LLM output before adding it to logs.
- Keep all state mutations in code, never in LLM output.

## Phase 4: Browser UI

- Keep the CLI as a temporary adapter.
- Add a browser adapter that sends player actions to the core game engine.
- Display public state, conversation history, alive/dead players, voting results, and win result.
- Add developer mode for roles, known info, hidden info, prompts, and evidence logs.

## Phase 5: Game Expansion

- Add 9-player village support.
- Add medium, knight, and madman roles.
- Improve suspicion updates and NPC memory.
- Add richer personalities, dialogue policies, and difficulty tuning.

## Current Priority

The next milestone is automated tests for the UI-independent core API.
