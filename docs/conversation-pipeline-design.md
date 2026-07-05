# Structured Conversation Pipeline Design

## 1. Executive decision summary

- **Decision:** Replace the current natural-language-centered conversation pipeline with a browser-authoritative structured-event pipeline.
- **Rationale:** The current system allows divergence between displayed NPC utterances and the underlying game state. Moving the authority for state changes and claim generation into the browser-side game engine ensures that all game actions are explicitly validated and recorded before being rendered as natural language.
- **Rejected alternative:** Server-side authoritative state. This was rejected because it would require a complete rewrite of the `WerewolfGame` engine and the HTTP layer, violating the goal of preserving the existing browser-based engine and simple proxy server.
- **Consequences:** The browser remains the sole owner of the authoritative game state. The server remains a stateless proxy for AI providers. All game rule validations and state updates occur in the browser.

## 2. Current architecture analysis

### Execution Boundaries (Verified Repository Facts)

- **Authoritative State Holder:** The `WerewolfGame` class in `src/gameEngine.mjs`. In the browser application, the game instance is held in the `game` variable within `public/browserApp.mjs`.
- **Game Instance Creation:** `WerewolfGame.create()` is called in `public/browserApp.mjs` (for the UI) and `src/cli.mjs` (for the CLI).
- **Player Input Entry Point:** `WerewolfGame.dispatchPlayerAction()` receives actions from the UI or CLI.
- **Server Role:** `src/webServer.mjs` acts as a stateless proxy for AI requests via the `/api/npc-response` endpoint. It performs HTTP and JSON schema validation (`src/validator.mjs`) but holds no game state (no current turn, no roster, no claims).
- **Session Management:** `SessionManager` in `public/httpResponseProvider.mjs` manages browser-side request lifecycles. It uses `AbortController` to cancel pending requests when a new game starts and prevents stale responses from updating the current game UI (`isCurrentGame`). It does NOT represent a server-side game session.

### Current Conversation Flow (Verified Repository Facts)

1.  **Input:** `browserApp.mjs` calls `game.dispatchPlayerAction({ type: 'ask_npc', targetId, input })`.
2.  **Processing:** `WerewolfGame.handlePlayerQuestion` (`src/gameEngine.mjs`):
    - Sets phase to `player_question`. (**State Mutation**)
    - Appends to `playerLog`. (**State Mutation**)
    - Calls `applyQuestionPressure(questionText)`, which immediately updates `npc.suspicionScores` based on keyword matching. (**State Mutation**)
    - Calls `buildNpcResponseRequest(npc, gameState, playerInput)` in `src/responseGenerator.mjs`.
3.  **Plan Generation:** `buildNpcResponseRequest` classifies intent via `classifyIntent` (regex/keyword matching) and **pre-creates** a `publicClaim` object and a `responsePlan.baseText`.
4.  **Provider Call:** `public/httpResponseProvider.mjs` sends the request to `/api/npc-response`.
5.  **Server Validation:** `src/webServer.mjs` uses `validateNpcResponseRequest()` in `src/validator.mjs` to check the envelope.
6.  **AI Rendering:** The AI provider (e.g., `src/openaiProvider.mjs`) paraphrases the `baseText` into natural Japanese.
7.  **Completion:** `handlePlayerQuestion` receives the AI text.
    - Appends response to `playerLog` and `publicInfo`. (**State Mutation**)
    - **Registration:** If a `publicClaim` was generated in Step 3, it is registered in `npc.publicClaims` and `publicInfo`. (**State Mutation**)
8.  **Divergence:** The `publicClaim` is registered even if the AI output fails to express it. The `utteranceGuard.mjs` validator is **not currently used** in the production flow.

## 3. Confirmed problems

1.  **Inconsistency:** Claims are registered in the game state based on an engine-generated plan, not the actual text displayed to the user.
2.  **Shadow Claims:** The AI can express unauthorized claims that are not registered in the game state.
3.  **Fragile Intent Detection:** suspicion updates and intent classification rely on brittle keyword matching in raw natural language.
4.  **Premature Mutation:** State changes (suspicion, logs) occur before the AI response is validated or even successfully returned.

## 4. Scope and non-scope

- **In Scope:** `SpeechActCandidate` schemas, AI Interpreter/Renderer contracts, browser-side validation and atomicity logic, phased migration plan.
- **Out of Scope:** Moving the game engine to the server, adding server-side persistence, changing core game rules (roles, phases).

## 5. Terminology

- **SpeechActCandidate:** An untrusted, structured interpretation of natural language produced by the AI.
- **AcceptedSpeechAct:** An engine-validated and bound communication event that represents an authoritative action.
- **NpcReactionPlan:** Structured instructions from the engine to the AI for rendering an NPC's response.
- **CanonicalClaim:** The single source of truth for a role or result claim.

## 6. Responsibility boundaries

### Browser-side Game Engine (Authority)
- Holds authoritative game state, turn IDs, and state versions.
- Validates `SpeechActCandidate` against game rules, phase, and roster.
- Generates `AcceptedSpeechAct` and `PublicEvent` only after successful validation.
- Performs atomic state updates (claims, suspicion, history).
- Generates `NpcReactionPlan` containing engine-rendered canonical segments.
- Manages idempotency and stale response detection using `requestId` and `turnId`.

### Server (Proxy)
- Proxies requests to AI providers.
- Validates HTTP request/response envelopes.
- Normalizes errors (timeouts, provider failures).
- Does NOT validate game rules or maintain session state.

### AI (Interpreter & Renderer)
- **Interpreter:** Natural language -> `SpeechActCandidate` alternatives.
- **Renderer:** `NpcReactionPlan` -> Natural language commentary.
- Does NOT decide legality or mutate state.

## 7. `InterpretationResult` Schema (AI Output)

The AI Interpreter role converts raw player text into a structured `InterpretationResult`. It distinguishes between a single coherent interpretation (which may contain multiple acts) and exclusive interpretive alternatives.

```json
{
  "schemaVersion": 1,
  "requestId": "req-123",
  "alternatives": [
    {
      "alternativeId": "alt-1",
      "speechActs": [
        {
          "type": "role_claim",
          "claimedRole": "seer"
        },
        {
          "type": "result_claim",
          "targetId": "npc-beni",
          "result": "werewolf"
        }
      ],
      "confidence": 0.84
    }
  ],
  "interpretationFailure": null
}
```

### Interpretation Decisions
- **Exclusivity:** `alternatives` represents mutually exclusive interpretations of the same natural language input.
- **Sequence:** `speechActs` within an alternative represents a sequence of acts performed in a single utterance (e.g., "I am the Seer and Beni is a wolf").
- **Uniqueness Requirement:** The engine only proceeds to validation if there is exactly **one** alternative. If multiple alternatives are provided, it indicates ambiguity.
- **Confidence:** Used for diagnostics and developer logs only. It is NOT a threshold for acceptance.
- **No guessing:** If interpretations are ambiguous, the engine MUST NOT guessed. It triggers a deterministic clarification fallback.
- **All-or-Nothing:** State-changing acts within a single alternative are processed atomically. If one is invalid, the entire interpretation is rejected.

## 8. `SpeechActCandidate` Types (Strict Discriminated Union)

The AI returns candidates without `actorId`. Unknown fields are strictly prohibited and will result in rejection.

### Common Constraint Table

| Type | Required Fields | Allowed Fields | Target Req. | Phase Req. | State-Changing |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `non_game_statement` | `text` | - | No | None | No |
| `question` | `targetId`, `topic` | - | Yes (Alive) | Day | No |
| `suspicion` | `targetId` | `reason` | Yes (Alive) | Day | Yes |
| `vote_declaration` | `targetId` | - | Yes (Alive) | Day | Yes |
| `role_claim` | `claimedRole` | - | No | Day | Yes |
| `result_claim` | `targetId`, `result` | - | Yes | Day | Yes |
| `information_request` | `topic` | - | No | None | No |
| `uninterpretable` | `reason` | `explanation` | No | None | No |

### Candidate Schema Examples

**ResultClaimCandidate**
```json
{
  "type": "result_claim",
  "targetId": "npc-beni",
  "result": "werewolf"
}
```

**QuestionCandidate**
```json
{
  "type": "question",
  "targetId": "npc1",
  "topic": "role"
}
```

**UninterpretableCandidate**
```json
{
  "type": "uninterpretable",
  "reason": "ambiguous",
  "explanation": "Player referred to 'him' but two male NPCs are alive."
}
```

## 9. `AcceptedSpeechAct` Schema

The engine-generated, validated, and bound representation of a speech act.

```json
{
  "schemaVersion": 1,
  "speechActId": "act-1001",
  "requestId": "req-123",
  "acceptedTurnId": "day-1-turn-4",
  "acceptedStateVersion": 17,
  "actorId": "player",
  "causationId": "req-123",
  "correlationId": "conversation-44",
  "idempotencyKey": "req-123:act-0",
  "type": "accepted_result_claim",
  "payload": {
    "targetId": "npc-beni",
    "result": "werewolf"
  },
  "validationMetadata": {
    "alternativeId": "alt-1",
    "confidence": 0.84
  }
}
```

### Accepted Types
- `AcceptedNonGameStatement`, `AcceptedQuestion`, `AcceptedSuspicion`, `AcceptedVoteDeclaration`, `AcceptedRoleClaim`, `AcceptedResultClaim`, `AcceptedInformationRequest`.
- The AI-generated `actorId` (if any) is ignored. The engine binds `actorId` from the game context.

## 10. `PublicEvent` Schema

The authoritative record of an event in the game. All state changes that are public knowledge are represented as `PublicEvent`.

```json
{
  "schemaVersion": 1,
  "eventId": "evt-123",
  "eventType": "result_claim_recorded",
  "requestId": "req-123",
  "turnId": "day-1-turn-4",
  "stateVersion": 18,
  "actorId": "player",
  "acceptedSpeechActId": "act-1001",
  "causationId": "req-123",
  "correlationId": "conversation-44",
  "idempotencyKey": "req-123:evt-0",
  "createdOrder": 142,
  "payload": {
    "claimId": "clm-456"
  },
  "publicDisplayModel": {
    "text": "プレイヤーが占い結果を公開：npc-beniは人狼。"
  }
}
```

### Event Types and Sources

| Event Type | Source Accepted Act | Public History | Suspicion Impact | CanonicalClaim Ref |
| :--- | :--- | :--- | :--- | :--- |
| `public_statement_recorded` | `AcceptedNonGameStatement` | Yes | No | No |
| `public_question_recorded` | `AcceptedQuestion` | Yes | No | No |
| `suspicion_expressed` | `AcceptedSuspicion` | Yes | Yes | No |
| `vote_declared` | `AcceptedVoteDeclaration` | Yes | Yes | No |
| `role_claim_recorded` | `AcceptedRoleClaim` | Yes | Yes | `claimId` |
| `result_claim_recorded` | `AcceptedResultClaim` | Yes | Yes | `claimId` |
| `clarification_requested` | - (Ambiguity Fallback) | No | No | No |

### Processing Rules
- **Logical Commit:** All events related to a single Interpretation alternative are prepared and then committed atomically.
- **Ordering:** `createdOrder` and `turnId` ensure a stable sequence for replays and UI rendering.
- **Duplicate handling:** If a duplicate `idempotencyKey` is processed, the engine returns the existing event without re-mutation.

## 11. `CanonicalClaim` Schema

`CanonicalClaim` is the single source of truth for all assertions. It is decoupled from actual truth.

```json
{
  "schemaVersion": 1,
  "claimId": "clm-456",
  "claimRevision": 1,
  "actorId": "npc2",
  "claimedRole": "seer",
  "claimedResults": [
    { "targetId": "npc-aoi", "result": "not_werewolf", "day": 1 }
  ],
  "sourceSpeechActIds": ["act-1001"],
  "idempotencyKey": "req-123:clm-0",
  "createdTurnId": "day-1-turn-4",
  "createdStateVersion": 17,
  "repeatsClaimId": null,
  "supersedesClaimId": null,
  "contradictsClaimIds": [],
  "status": "asserted"
}
```

### Claim Management Rules

- **Assertion vs. Truth:** The engine validates whether a claim is *permitted* (based on role policy), NOT if it is true. Lying is a valid game action.
- **No Circular References:**
  1. Engine validates `AcceptedSpeechAct`.
  2. Engine prepares `CanonicalClaim` (references `sourceSpeechActIds`).
  3. Engine prepares `PublicEvent` (references `claimId`).
  4. Engine commits all objects in a single logical step.
- **Repeats:** If an identical claim is made, a new record is created with `repeatsClaimId` pointing to the original.
- **Amendments:** Use `supersedesClaimId` to correct a previous claim. The old claim remains in history.
- **Contradictions:** Use `contradictsClaimIds` for assertions that logically conflict with previous ones. Both claims persist.
- **Derived Rendering:** UI, logs, and NPC memory derive text from the structured data via pure functions. Internal IDs are never shown in the UI.

## 12. `NpcReactionPlan` Schema

The engine generates the plan for an NPC's response. It contains NO private game facts.

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
- **Validation:** If interpretations are ambiguous (low confidence margin) or invalid, the engine triggers a clarification response without updating state.

## 12. NPC Utterance Renderer Contract

- **Endpoint:** `POST /api/render-npc-utterance`
- **Text Composition:** The browser engine assembles the final UI text by concatenating the AI's `commentary` with its own `canonicalSegments` based on the `compositionStrategy`.

## 13. Claim and Game Truth

- **Asserted vs Actual:** Separate `assertedClaim` from `actualGameTruth`.
- **Lies:** Allowed and recorded as `CanonicalClaim`.
- **Validation:** Verification check if the NPC is *allowed* by policy to make such a claim, NOT if it's true.

## 14. Operational Logic

### Authoritative Transaction Boundary (Atomicity)
The browser-side `WerewolfGame` is the sole transaction authority.
1.  **Input Phase:** Capture player input.
2.  **AI Phase:** Interpreter request (stateless proxy).
3.  **Commit Phase:** Single atomic update in browser (AcceptedSpeechAct, PublicEvent, CanonicalClaim, State increment).
4.  **Reaction Phase:** Planning and Renderer request.

### Idempotency & Stale Responses
- **Owner:** Browser engine.
- **Mechanism:** Track `processedRequestIds` and discard responses if `turnId` has already progressed.

## 15. Provider & HTTP Contracts

- **Endpoints:** Separate `POST /api/interpret-player-input` and `POST /api/render-npc-utterance`.
- **Responsibility:** Server remains a stateless proxy.

## 16. Migration Plan

### Phase 1: Pure schemas, validators, and canonical renderers (Recommended First PR)
- **Objective:** Establish the data foundation.
- **Files:** `src/schemas.mjs` (new), `src/validator.mjs`.
- **Action:** Implement validators and `renderClaimForSegment` functions.
- **Tests:** Unit tests for schemas.
- **Risk:** Zero. Independent deployment possible.

### Phase 2-9: Incremental Integration
- Progress through shadow mode, atomic commit, and gradual replacement of legacy logic.

## 17. Finalized Design Decisions

- **Authoritative State:** Held in Browser.
- **Server:** Stateless Proxy.
- **Ambiguity Handling:** Multiple interpretation alternatives trigger deterministic clarification fallback.
- **Lies:** Allowed and recorded as `CanonicalClaim`.
- **Renderer Data:** Private facts strictly prohibited; use policies.

## 18. Open Design Questions

- **UI Highlights:** How to visually distinguish canonical segments from AI commentary?
- **Contradictory Input:** Rejection of "I am the Seer and the Werewolf" acts.

## 19. Test Strategy
- Unit tests for all JSON schemas.
- Mock AI providers for deterministic pipeline testing.

## 20. Security Boundary
- AI Interpreter never sees private role data.
- AI Renderer never sees private game truth.

## 21. First Implementation PR
- **Scope:** Phase 1 (Schemas and Validators).
