# Roadmap

## Phase 1: Stabilize Core Logic

- Formalize `GameState` and `PlayerState` shape.
- Add a UI-independent action interface. Done for the current prototype.
- Separate public snapshots from internal developer snapshots. Done for the current prototype.

## Phase 2: Add Automated Tests

- Test death, voting, execution, seer action, werewolf attack, and win checks. Done.
- Test that dead NPCs cannot speak. Done.
- Test that seer results stay private until explicitly claimed. Done.
- Test that werewolves cannot attack themselves. Done.
- Test minimal suspicion updates from accusatory player questions. Done.

## Phase 3: Real LLM Integration

- Define a response provider interface that can swap pseudo responses for real LLM calls. Done.
- Add a secure server-side OpenAI response provider using the official Responses API. Done.
- Build prompts from only the information each NPC is allowed to know. Done.
- Redact private evidence and enforce factual grounding in server-side instructions. Done.
- Validate provider output and handle transient failures with fallback. Done.
- Keep all state mutations in code, never in LLM output. Done.

## Phase 4: Browser UI & Developer Experience

- Add a browser adapter that sends player actions to the core game engine. Done.
- Display public state, conversation history, and voting results. Done.
- Add developer mode for roles, hidden info, and LLM diagnostics. Done.
- Implement stale response prevention for rapid session resets. Done.

## Phase 5: Game Expansion

- Add 9-player village support.
- Add medium, knight, and madman roles.
- Improve suspicion updates and NPC memory.
- Add richer personalities, dialogue policies, and difficulty tuning.

## Current Priority

The next milestone is adding a real LLM provider.
