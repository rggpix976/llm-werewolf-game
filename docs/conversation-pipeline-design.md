# Structured Conversation Pipeline Design

## 1. Executive decision summary

This document defines the replacement of the current natural-language-centered conversation pipeline with a structured-event pipeline. The goal is to eliminate inconsistencies between the displayed NPC utterances and the underlying game state, ensuring that every state-changing action (like a role claim) is explicitly validated and recorded before being rendered as natural language.

## 2. Current architecture analysis

### End-to-end player conversation flow
1. Player submits text via the UI.
2. `browserApp.mjs` calls `game.dispatchPlayerAction({ type: 'ask_npc', ... })`.
3. `WerewolfGame.handlePlayerQuestion` (`src/gameEngine.mjs`):
   - Sets phase to `player_question`.
   - Records the question in `playerLog`.
   - Applies "question pressure" (suspicion updates) based on keywords and mentions.
   - Calls `buildNpcResponseRequest` (`src/responseGenerator.mjs`).
4. `buildNpcResponseRequest`:
   - Classifies intent (`classifyIntent`) using simple keyword matching.
   - Selects relevant public and private evidence.
   - Creates a `responsePlan.baseText` (canonical Japanese text).
   - Potentially creates a `publicClaim` object *independently* of the text.
   - Packages this into a request for the AI provider.
5. AI Provider (`src/openaiProvider.mjs` or `src/responseProvider.mjs`):
   - Paraphrases `baseText` into natural-sounding Japanese.
   - The AI is instructed to follow the `baseText` but may deviate.
6. `handlePlayerQuestion` (completion):
   - Receives the AI text.
   - Records the response in `playerLog` and `publicInfo`.
   - If a `publicClaim` was pre-created in step 4, it is registered in the NPC's state and added to `publicInfo`.
   - **Problem:** The `publicClaim` is registered even if the AI failed to mention it or if the AI mentioned a different (unauthorized) claim.

### End-to-end NPC conversation flow
Currently, NPCs only speak in response to player questions. They do not initiate conversation during `day_discussion` without player prompts.

### Key Observation
- **State mutation** occurs in `gameEngine.mjs`.
- **Claims** are generated in `responseGenerator.mjs` before the AI speaks.
- **Validation** of the AI's natural language output is limited to structural checks (length, etc.) in `utteranceGuard.mjs` (though not fully integrated in the main flow yet).
- **Fallback behavior** exists in the provider layer (e.g., `OpenAIResponseProvider` falls back to `PseudoResponseProvider`).

## 3. Confirmed problems

1.  **Divergence:** A Claim can be registered in the game state even when the AI did not express it in the final text.
2.  **Shadow Claims:** The AI can express an unauthorized Claim that is not registered or validated by the game engine.
3.  **Lack of Atomicity:** The displayed utterance and the stored game state are not guaranteed to represent the same logical action.
4.  **Implicit Intent:** "Question pressure" and intent classification rely on fragile keyword matching.

## 4. Scope and non-scope

### Scope
- Replacement of the conversation pipeline with a structured-event model.
- Introduction of `SpeechAct`, `CanonicalClaim`, `PublicEvent`, and `NpcReactionPlan`.
- New AI contracts for "Input Interpreter" and "Utterance Renderer".
- Ensuring atomicity between state changes and display.

### Non-scope
- Rewriting the game rule engine (voting, night actions, etc.).
- Changing the role definitions or victory conditions.
- Permanent persistence (server-side database).

## 5. Terminology

- **SpeechAct:** A structured representation of a player's or NPC's intended communication.
- **Candidate SpeechAct:** An unvalidated SpeechAct produced by the AI interpreter from player input.
- **Accepted SpeechAct:** A SpeechAct that has passed engine validation.
- **CanonicalClaim:** The single source of truth for a role or result claim.
- **PublicEvent:** An authoritative, state-changing event produced by the engine.
- **NpcReactionPlan:** A structured set of instructions for the AI to render an NPC response.
- **Input Interpreter:** The AI role that converts natural language into a structured SpeechAct.
- **Utterance Renderer:** The AI role that converts an `NpcReactionPlan` into natural language.

## 6. Responsibility boundaries

### AI responsibilities
- **Interpret:** Convert player text into a structured `SpeechAct` candidate.
- **Render:** Convert `NpcReactionPlan` into a natural-sounding Japanese utterance.
- **Identify Ambiguity:** Report if player input is unclear or multiple interpretations exist.

### Game engine responsibilities
- **Validate:** Ensure SpeechActs are legal given the current phase, role, and known info.
- **Update State:** Mutate NPC memory, suspicion, and claims based on accepted events.
- **Control Information:** Ensure the NPC Reaction Plan only contains authorized information.
- **Authority:** Remains the sole source of truth for the game state and transitions.

## 7. `SpeechAct` schema

The `SpeechAct` represents a candidate action (from player) or a planned action (for NPC).

```json
{
  "schemaVersion": 1,
  "type": "statement | question | accusation | vote_declaration | public_claim | public_result | request_info | response_to_event | no_op | ambiguous",
  "actorId": "player | npc-id",
  "targetId": "npc-id | null",
  "payload": {
    "role": "seer | werewolf | citizen | null",
    "results": [
      { "targetId": "npc-id", "result": "werewolf | not_werewolf" }
    ],
    "topic": "string | null",
    "referencedEventId": "string | null"
  },
  "confidence": 0.0 to 1.0,
  "ambiguity": {
    "isAmbiguous": false,
    "reason": "string | null",
    "alternatives": []
  }
}
```

### Supported Types
- `statement`: General comment without specific game impact.
- `question`: Asking for information.
- `accusation`: Expressing suspicion towards a target.
- `vote_declaration`: Publicly stating who they intend to vote for.
- `public_claim`: Claiming a role.
- `public_result`: Claiming a specific seer/medium result.
- `no_op`: Greeting, filler, or non-game-related talk.
- `ambiguous`: Interpreter cannot determine a single clear intent.

## 8. `CanonicalClaim` schema

The single source of truth for any role/result claim.

```json
{
  "claimId": "string (uuid or unique hash)",
  "sourceEventId": "string (PublicEvent ID)",
  "turnId": 12,
  "actorId": "npc-beni",
  "claimedRole": "seer",
  "claimedResults": [
    { "targetId": "npc-aoi", "result": "not_werewolf", "day": 1 }
  ],
  "isAmendment": false,
  "supersedesClaimId": "string | null"
}
```

- **Duplicate handling:** If an actor makes the exact same claim, it is ignored or logged as a repeat.
- **Contradiction:** If an actor claims a different role, the new claim supersedes the old one (amendment), but the contradiction is recorded for suspicion.

## 9. `PublicEvent` schema

The authoritative record of what happened in the game.

```json
{
  "eventId": "evt_123",
  "sessionId": "sess_abc",
  "turnId": 15,
  "timestamp": "ISO-8601",
  "type": "npc_speech | player_speech | vote_result | execution | death | game_start | game_over",
  "actorId": "npc-beni",
  "causationId": "evt_122 (the player question that triggered this)",
  "correlationId": "corr_456",
  "acceptedSpeechAct": { ... },
  "canonicalPayload": { ... },
  "canonicalText": "紅: 私は占い師です。青井さんは人間でした。",
  "isStateChanging": true
}
```

## 10. `NpcReactionPlan` schema

The engine's instructions to the AI for rendering.

```json
{
  "npcId": "npc-beni",
  "purpose": "answer_question | defend_self | accuse_other",
  "referencedEventId": "evt_122",
  "authorizedFacts": [
    "I am the seer",
    "Aoi is not a werewolf (Day 1 result)"
  ],
  "prohibitedFacts": [
    "Chika is the werewolf (I know this because I am the seer, but I shouldn't say it yet)"
  ],
  "intendedSpeechActs": [
    { "type": "public_claim", "role": "seer" },
    { "type": "public_result", "targetId": "npc-aoi", "result": "not_werewolf" }
  ],
  "tone": "soft",
  "maxChars": 240,
  "canonicalText": "私は占い師です。青井さんは人狼ではありませんでした。"
}
```

## 11. Input Interpreter contract

The Input Interpreter converts player natural language into one or more candidate `SpeechAct` objects.

### Input to AI
- **Roster:** List of all players (ID, Name, Aliases, alive/dead status).
- **Context:** Current Day, Phase, and the last 3-5 PublicEvents.
- **Player Input:** The raw text from the player.
- **Constraints:** Allowed SpeechAct types for the current phase.

### Output from AI
- **Candidates:** An array of `SpeechAct` objects.
- **Ambiguity Report:** If the input is unclear, explains why.
- **Confidence:** A score for each candidate.

### Safety
- The interpreter must not have access to any private NPC information (roles, hidden info).
- It must not be able to "confirm" its own interpretation as a state change.

## 12. NPC Utterance Renderer contract

The Renderer converts an `NpcReactionPlan` into a natural-language Japanese utterance.

### Input to AI
- **NPC Profile:** Name, personality, speech style.
- **Reaction Plan:** Structured `NpcReactionPlan` including `intendedSpeechActs` and `authorizedFacts`.
- **Canonical Text:** The baseline text that *must* be communicated clearly.
- **Constraints:** Max length, prohibited facts.

### Output from AI
- **Rendered Text:** A single Japanese string.
- **Refusal/Failure:** If the plan contains contradictions or cannot be rendered.

### Safety
- The Renderer must not invent new claims, targets, or actions.
- It must strictly adhere to `authorizedFacts`.

## 13. Validation rules

1.  **Schema Validation:** Every JSON object (SpeechAct, Plan, Event) must strictly match its schema. Unknown fields are rejected.
2.  **Actor Validation:** The `actorId` must exist and be alive.
3.  **Phase Validation:** Certain acts (like `public_result`) are only valid in specific phases (like `day_discussion`).
4.  **Information Validation:** An NPC can only claim a result that exists in its `knownInfo`.
5.  **Renderer Validation:** The rendered text must be checked by the `utteranceGuard` for structural issues and by a basic check to ensure it doesn't contain `prohibitedFacts`.

## 14. Security and private-information boundaries

- **Input Isolation:** The Input Interpreter never sees private roles.
- **Output Validation:** All AI output is treated as untrusted.
- **Hard Rejection:** If the AI includes sensitive data (e.g., another NPC's secret role) in its rendering, the utterance is discarded and a fallback is used.

## 15. Failure and fallback behavior

- **Interpreter Failure:** If the AI fails to produce a valid SpeechAct, the engine falls back to a "question not understood" event.
- **Renderer Failure:** If the AI produces an unsafe or invalid rendering, the engine displays the `canonicalText` from the `NpcReactionPlan` as a safe fallback.
- **Timeout:** Standard timeouts result in deterministic "NPC is thinking" or "Request failed" messages without state mutation.

## 16. Atomicity, idempotency, and concurrency

- **Atomic Transactions:** A state change (like registering a claim) only commits if the `PublicEvent` is successfully created and the `NpcReactionPlan` is generated.
- **Idempotency:** Every request from the browser includes a `requestId`. The server ignores duplicate requests for the same action.
- **Stale Request Check:** If the `turnId` in the request doesn't match the current server state, the request is rejected (409 Conflict).
- **Rollback:** If the Renderer fails, the state change is *not* rolled back; instead, the canonical text is shown. The logical action (the claim) has already happened and is valid.

### State-transition example (Player Question -> NPC Claim)

1.  **Player Input:** "Beni, tell me your role."
2.  **Input Interpreter:** Produces a Candidate SpeechAct:
    ```json
    { "type": "question", "actorId": "player", "targetId": "npc-beni", "payload": { "topic": "role" } }
    ```
3.  **Engine Validation:** Validates `npc-beni` is alive and it's a valid question.
4.  **Engine Processing:** Engine determines `npc-beni` (Seer) should reveal.
    - Creates `PublicEvent` for the player's question.
    - Creates `PublicEvent` for the NPC's claim.
    - Registers `CanonicalClaim` in the state.
5.  **NpcReactionPlan Generation:**
    ```json
    {
      "npcId": "npc-beni",
      "intendedSpeechActs": [{ "type": "public_claim", "role": "seer" }],
      "canonicalText": "私は占い師です。"
    }
    ```
6.  **Utterance Renderer:** Returns "私は占い師です。信じてください！"
7.  **UI Display:** Shows the rendered text. The game state already shows Beni as a claimed Seer.

## 17. Observability and diagnostics

- **Causation Tracking:** Every event must include a `causationId` to allow tracing an NPC response back to the player's question.
- **Developer Log:** All rejected `SpeechAct` candidates and validation failures must be logged in the `developerLog` with detailed reasons.
- **Schema Versions:** All structured objects must include a `schemaVersion` for future compatibility tracking.

## 18. Migration plan

### Phase 1: Introduce schemas and pure validators
- **Files:** Create `src/schemas.mjs`, update `src/validator.mjs`.
- **Action:** Define JSON schemas for `SpeechAct`, `PublicEvent`, etc. Add validation functions.
- **Risk:** None, new code only.

### Phase 2: Introduce candidate SpeechAct interpretation
- **Files:** Update `src/responseGenerator.mjs` and `src/responseProvider.mjs`.
- **Action:** Add a mode where the provider calls the AI as an "Interpreter" to produce a candidate SpeechAct. Log this candidate in `developerLog` but do not use it yet.
- **Risk:** Increased latency due to extra AI call.

### Phase 3: Introduce accepted SpeechAct and PublicEvent conversion
- **Files:** `src/gameEngine.mjs`.
- **Action:** Define logic to convert player input (via Interpreter) into an "accepted" SpeechAct. Generate a `PublicEvent` for the player's speech.

### Phase 4: Migrate player Claim handling
- **Files:** `src/gameEngine.mjs`.
- **Action:** Instead of keyword matching on raw text, use the `SpeechAct` (e.g., `type: "public_claim"`) to trigger claim registration.

### Phase 5: Introduce NpcReactionPlan
- **Files:** `src/responseGenerator.mjs`.
- **Action:** Instead of `baseText`, start generating `NpcReactionPlan` objects. Include the `canonicalText` as the baseline.

### Phase 6: Introduce Renderer contract
- **Files:** `src/openaiProvider.mjs`, `src/responseProvider.mjs`.
- **Action:** Update provider logic to send the `NpcReactionPlan` to the AI for rendering. AI is now an "Utterance Renderer".

### Phase 7: Synchronize Claim state and canonical display
- **Files:** `src/gameEngine.mjs`.
- **Action:** Ensure that NPC role claims only happen if a `public_claim` SpeechAct is present in the plan. Use the same `CanonicalClaim` data for both the game state and the Renderer's plan.

### Phase 8: Remove obsolete string classification
- **Files:** `src/responseGenerator.mjs`, `src/textUtils.mjs`.
- **Action:** Delete `classifyIntent` and `ACCUSATORY_QUESTION_KEYWORDS`.

### Phase 9: Remove dead compatibility code
- **Files:** `src/gameEngine.mjs`.
- **Action:** Remove the old `baseText` paths and pre-creation of `publicClaim`.

## 19. Test strategy

- **Unit Tests:** Validate all schemas with valid/invalid data. Test the "Engine Validator" logic with mocked SpeechActs.
- **Integration Tests:** Use `PseudoResponseProvider` to simulate the full pipeline (Interpreter -> Engine -> Renderer).
- **Regression Tests:** Ensure existing `apiIntegration.test.mjs` and `gameEngine.test.mjs` pass by keeping the internal game rules identical.

## 20. Open design questions

1.  **Multiple Candidates:** Should the engine automatically pick the highest-confidence candidate, or should the UI ask for clarification if confidence is low?
2.  **Performance:** Can the Interpreter and Renderer be combined into a single AI call for NPC responses to save time/cost?
3.  **Ambiguity UI:** How should "I didn't understand your question" be presented to the player?

## 21. Recommended first implementation PR

**Scope:** Phase 1 & Phase 2.
- Introduce `src/schemas.mjs` with the `SpeechAct` schema.
- Update `src/validator.mjs` to include SpeechAct validation.
- Add a "dry-run" interpreter call in `responseGenerator.mjs` that logs the interpreted `SpeechAct` to the developer log but doesn't change game behavior.
