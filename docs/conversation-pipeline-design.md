# Structured Conversation Pipeline Design

## 1. Executive decision summary

- **Decision:** Replace the current natural-language-centered conversation pipeline with a browser-authoritative structured-event pipeline.
- **Rationale:** The current system allows divergence between displayed text and game state. Moving authority to the browser-side game engine ensures that all state mutations (Claims, suspicion, etc.) are derived from validated structured events.
- **Rejected alternative:** Server-side authoritative state. This was rejected because it would require a massive rewrite of the existing rule engine and session management, violating the constraint to preserve the current engine and proxy-only server architecture.
- **Consequences:** The browser remains the sole owner of the authoritative game state. All validations of game legality occur in the browser. The server remains a stateless proxy for AI providers.

## 2. Current architecture analysis

### End-to-End Execution Boundaries

1.  **Authoritative State Holder:** The `WerewolfGame` class in `src/gameEngine.mjs`. In the browser, the instance is held in the `game` variable in `public/browserApp.mjs`.
2.  **Game Creation:** `WerewolfGame.create()` is called in `public/browserApp.mjs` (init) and `src/cli.mjs`.
3.  **Player Input Flow:** `browserApp.mjs` listens for `askForm` submit -> calls `dispatch()` -> calls `game.dispatchPlayerAction()`.
4.  **State Mutation (Pre-AI):** `handlePlayerQuestion` in `src/gameEngine.mjs` immediately updates `phase`, `playerLog`, and calls `applyQuestionPressure()` (updating `npc.suspicionScores`) *before* calling the provider.
5.  **Plan Generation:** `buildNpcResponseRequest()` in `src/responseGenerator.mjs` is called. It uses `classifyIntent()` (regex/keyword matching) to decide if a claim should be made.
6.  **Claim Creation:** `maybeCreateRoleClaim()` in `src/responseGenerator.mjs` pre-creates a `publicClaim` object.
7.  **Response Plan:** A `responsePlan.baseText` is generated as the "canonical" Japanese content.
8.  **Communication:** `public/httpResponseProvider.mjs` calls `/api/npc-response` (POST).
9.  **Server Validation:** `src/webServer.mjs` calls `validateNpcResponseRequest()` in `src/validator.mjs` for schema validation.
10. **Provider:** `src/openaiProvider.mjs` (or `PseudoResponseProvider`) is called. It paraphrases `baseText` into natural language.
11. **Server-side Response Validation:** `validateProviderResponse()` in `src/responseProvider.mjs` checks the envelope.
12. **Fallback:** `OpenAIResponseProvider` falls back to `PseudoResponseProvider` on transient errors if `fallbackToPseudo` is true.
13. **Claim Registration:** Upon response return, `handlePlayerQuestion` registers the pre-created `publicClaim` into `npc.publicClaims` and `publicInfo`.
14. **UI Display:** `browserApp.mjs` calls `render()` using `game.getPublicSnapshot()`.

### Key Observations
1.  **State Location:** Authoritative state is exclusively in the browser. The server holds NO game state (no current turn, no alive/dead status, no claim history).
2.  **Session Management:** `SessionManager` in `public/httpResponseProvider.mjs` manages the lifecycle of browser-side fetch requests using `AbortController`. It ensures responses from old game instances are ignored (`isCurrentGame`). It does NOT represent a server-side session.
3.  **Divergence:** `publicClaim` registration is separated from AI text rendering.
4.  **Utterance Guard:** `src/utteranceGuard.mjs` exists but is not used in the production flow.
5.  **Divergence point:** The `publicClaim` is registered even if the AI output fails to express it.

## 3. Confirmed problems

- **Inconsistency:** State mutation and display content are not synchronized.
- **Brittle Parsing:** Keywords-based suspicion update is unreliable.
- **Pre-AI Mutation:** Suspicion and phase change happen even if the interpretation fails.
- **Lack of Atomicity:** No single "commit" point for a conversation-driven state change.

## 4. Scope and non-scope

- **Scope:** Redesigning the conversation flow between browser and AI providers using structured events.
- **Non-scope:** Moving the game engine to the server, adding a database, changing game rules (voting, execution, roles).

## 5. Terminology

- **SpeechActCandidate:** Untrusted interpretation of natural language by AI.
- **AcceptedSpeechAct:** Engine-validated structured communication event.
- **NpcReactionPlan:** Structured instructions for the NPC utterance.
- **CanonicalClaim:** The single source of truth for a claim.

## 6. Responsibility boundaries

### Browser-side Game Engine (Authority)
- **Validation:** Final authority on whether a SpeechAct is legal.
- **Commit:** Atomic update of game history, claims, and NPC memory.
- **Planning:** Generates the `NpcReactionPlan` and canonical segments.
- **Idempotency:** Tracks `requestId` and `stateVersion` to prevent duplicate or stale updates.

### Server (Proxy)
- **Transport:** Proxies calls to AI providers.
- **Schema Check:** Validates JSON envelopes and HTTP protocol.
- **Safety:** Isolates API keys and performs rate limiting.
- **No-Go:** Does NOT validate game rules or maintain session state.

### AI (Interpreter/Renderer)
- **Interpreter:** Natural language -> `SpeechActCandidate`.
- **Renderer:** `NpcReactionPlan` -> Commentary text.

## 7. `SpeechActCandidate` Schema

Decision: The AI Interpreter returns a `SpeechActCandidate` object containing alternatives. AI does NOT decide the `actorId`.
Rationale: Separation of concerns; interpretation is untrusted, validation is authoritative.

```json
{
  "schemaVersion": 1,
  "alternatives": [
    {
      "speechActs": [
        {
          "type": "role_claim",
          "role": "seer"
        },
        {
          "type": "result_claim",
          "targetId": "npc1",
          "result": "werewolf"
        }
      ],
      "confidence": 0.9
    }
  ],
  "interpretationFailure": null
}
```

### Discriminated Union Types for `speechActs`

| Type | Required Fields | State Impact | Phase Constraints |
| :--- | :--- | :--- | :--- |
| `non_game_statement` | `text` | None (Chatter) | None |
| `question` | `targetId`, `topic` | None (Triggers response) | `day_discussion` |
| `suspicion` | `targetId` | Updates `suspicionScores` | `day_discussion` |
| `vote_declaration` | `targetId` | Updates suspicion/NPC memory | `day_discussion` |
| `role_claim` | `role` | Registers `CanonicalClaim` | `day_discussion` |
| `result_claim` | `targetId`, `result` | Registers `CanonicalClaim` | `day_discussion` |
| `information_request` | `topic` | None (Triggers help) | None |

### `interpretationFailure` Type
Used when AI cannot form candidates.
- `reason`: "ambiguous", "unsupported_language", "gibberish".
- `explanation`: Natural language explanation for diagnostics.

### Engine Validation Rules
- **All-or-Nothing:** An alternative is rejected if ANY `speechAct` within it is invalid.
- **Order:** The order of `speechActs` within an alternative is preserved as the sequence of intended acts.
- **Partial Acceptance:** Rejected. Partial acceptance leads to confusing game states where only half of a player's sentence "happened".

## 8. `AcceptedSpeechAct` Schema

The authoritative object created by the browser-side engine after validation.

```json
{
  "schemaVersion": 1,
  "speechActId": "sa_789",
  "requestId": "req_123",
  "acceptedTurnId": 5,
  "acceptedStateVersion": 10,
  "actorId": "player",
  "type": "role_claim",
  "payload": {
    "role": "seer"
  },
  "validationMetadata": {
    "confidence": 0.9,
    "alternativeIndex": 0
  },
  "causationId": null
}
```

## 9. `CanonicalClaim` Schema

Decision: `CanonicalClaim` is the single source of truth for registration, history, memory, and display.
Rationale: Guarantees that what is recorded in the state is exactly what is displayed and remembered.

```json
{
  "schemaVersion": 1,
  "claimId": "clm_456",
  "actorId": "npc2",
  "claimedRole": "seer",
  "claimedResults": [
    { "targetId": "npc1", "result": "werewolf", "day": 1 }
  ],
  "turnId": 5,
  "sourceEventId": "evt_001",
  "isContradiction": false,
  "isAmendment": false
}
```

### Derived Rendering (Pure Functions)

- **UI Display:** `renderClaimForUI(claim)` -> "Claim: seer (npc1: werewolf)"
- **Logs:** `renderClaimForLog(claim)` -> "npc2が占い師COをした。"
- **Reaction Segments:** `renderClaimForSegment(claim)` -> "私は占い師です。npc1は人狼でした。"

### Claim vs. Truth (Validation Rules)
1.  **Assertion Independence:** The engine registers any validated claim even if it contradicts the NPC's secret `role`.
2.  **Permission Check:** NPCs can only claim if authorized by the `NpcReactionPlan`.
3.  **Contradiction Detection:** New claims with different roles from previous ones are marked `isContradiction: true` and increase suspicion.
4.  **Repeat Detection:** Identical claims are recorded but marked as repeats.

## 10. `NpcReactionPlan` Schema

The `NpcReactionPlan` contains NO private facts.

```json
{
  "schemaVersion": 1,
  "npcId": "npc2",
  "intendedSpeechActs": [
    { "type": "role_claim", "role": "seer" }
  ],
  "policies": [
    "do_not_reveal_private_role",
    "do_not_reveal_private_results",
    "do_not_add_claims",
    "stay_in_character"
  ],
  "canonicalSegments": [
    {
      "segmentId": "seg_1",
      "type": "claim",
      "text": "私は占い師です。"
    }
  ],
  "commentaryPlan": {
    "intent": "defend_self",
    "authorizedPublicFacts": [
      "I was asked about my role",
      "Aoi is dead"
    ],
    "styleHint": "calm"
  },
  "maxChars": 240,
  "compositionStrategy": {
    "order": ["commentary", "canonical_segments"],
    "joiner": " "
  }
}
```

## 11. Input Interpreter Contract

- **Endpoint:** `POST /api/interpret-player-input`
- **Decision:** AI produces `SpeechActCandidate`. Engine validates and binds.
- **Ambiguity:** Difference in confidence < 0.2 triggers clarification.
- **Unchanged:** Server remains a stateless proxy.

## 12. NPC Utterance Renderer Contract

- **Endpoint:** `POST /api/render-npc-utterance`
- **Decision:** AI renders commentary; engine assembles final text.
- **Rationale:** Prevents AI from modifying the authoritative "canonical" part of the message.

## 13. Operational Logic

### Authoritative Transaction Boundary (Atomicity)
Decision: The browser-side `WerewolfGame` is the sole authority.
Rationale: Prevents "ghost" state mutations if AI interpretation fails.
Rejected alternative: Partial mutation before AI response.
Consequences:
1.  **Commit Phase:** `AcceptedSpeechAct` + `PublicEvent` + `CanonicalClaim` + state increment happen in a single browser-side atomic block.
2.  **Failure:** If Interpreter or validation fails, no authoritative state changes occur.

### Idempotency and Stale Response Management
Decision: Managed by the browser engine using `requestId` and `turnId`.
Rationale: Server cannot track state across refreshes.
Consequences:
1.  **Processed Requests:** Engine tracks `processedRequestIds` to return cached results for duplicates.
2.  **Turn Tracking:** Response is discarded if `turnId` has already progressed.

### Fallback & Ambiguity Handling
1.  **Uniqueness:** Engine triggers clarification if confidence is tied.
2.  **All-or-Nothing:** Partial acceptance is rejected.
3.  **Renderer Fallback:** If AI commentary rendering fails, engine displays `canonicalSegments` only.

## 14. Provider & HTTP Contracts

Decision: Separate interfaces and endpoints for Interpreter and Renderer.
Rationale: Different input/output shapes and safety requirements.

- `POST /api/interpret-player-input` (SpeechAct interpretation)
- `POST /api/render-npc-utterance` (Commentary rendering)

## 15. Migration Plan

### Phase 1: Pure schemas and validators (Recommended First PR)
- **Objective:** Establish data types and rendering logic without affecting production flow.
- **Files:** `src/schemas.mjs` (new), `src/validator.mjs`.
- **Action:** Implement validators and `renderClaimForSegment` pure functions.
- **Unchanged:** Production flow, provider logic, HTTP endpoints.
- **Tests:** Unit tests for schemas.
- **Rollback:** Zero risk (new code only).

### Phase 2: Interpreter transport
- **Action:** Implement `POST /api/interpret-player-input`.

### Phase 3-4: Candidate validation & Atomic Commit
- **Action:** Wire up Interpreter (Shadow Mode) then move mutation authority.

### Phase 5-9: Migration and Cleanup
- Replace keyword logic and `baseText`. Remove obsolete paths.

## 16. Finalized Design Decisions

### ID Management
Decision: Use deterministic hash-based IDs for `claimId` and `speechActId` where possible, or engine-generated sequence IDs.
Rationale: Aids in consistency and debugging.

### Multiple Roles
Decision: Allow an NPC to claim multiple roles as a valid game action (amendment).
Rationale: Permits strategic lying and deception.

### Clarification UX
Decision: Clarification does not progress the game turn.
Rationale: Prevents "skipping" turns due to AI misunderstanding.

## 17. Open Design Questions

1.  **Contradictory Claims in one turn:** Should the engine automatically reject "I am the Seer and the Werewolf"?
    - **Recommendation:** Yes, reject the alternative as "Invalid Logic".
2.  **UI Highlights:** How to visually distinguish canonical text from AI commentary?
    - **Recommendation:** Use a specific CSS class for canonical segments (e.g., bold or different background).

## 18. Observability and Diagnostics

- **causationId:** Trace NPC response to player input.
- **correlationId:** Track all API calls in a turn.
- **Diagnostic Log:** Engine `developerLog` records all rejected candidates and AI failures.
