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

The AI Interpreter converts raw natural language into structured `InterpretationResult`. It separates successful semantic mapping into alternatives from system-level failures.

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

### Mutual Exclusivity Rules
- **Successful interpretation:** `alternatives` has at least 1 item; `interpretationFailure` is `null`.
- **Interpreter failure:** `alternatives` is `[]`; `interpretationFailure` is an object.
- **Validation:** The engine rejects any response where both fields are populated or both are empty.

### Interpretation Outcomes
- **Uniqueness Requirement:** The engine only proceeds to state mutation if `alternatives.length === 1`.
- **Ambiguity:** If `alternatives.length > 1`, it is treated as an ambiguity failure and triggers a `ClarificationOutcome`.
- **Confidence:** Diagnostic only. Margin-based automatic adoption is strictly prohibited.
- **Uninterpretable Case:** `UninterpretableCandidate` is used ONLY when the AI successfully categorizes the input as "gibberish", "missing reference", or "unsupported intent". It must be the sole alternative and sole act.

## 8. `SpeechActCandidate` Types (Strict Discriminated Union)

All candidate types follow a `additionalProperties: false` policy. The AI must NOT include `actorId`.

### Common Schema Constraints
| Candidate Type | State Effect | Record Created | Phase | Target Validation |
| :--- | :--- | :--- | :--- | :--- |
| `NonGameStatement` | None | Yes (History) | Any | N/A |
| `Question` | None | Yes (History) | Day | Alive Required |
| `Suspicion` | `suspicion_update` | Yes (History) | Day | Alive Required |
| `VoteDeclaration` | `memory_update` | Yes (History) | Day | Alive Required |
| `RoleClaim` | `claim_registration` | Yes (History) | Day | N/A |
| `ResultClaim` | `claim_registration` | Yes (History) | Day | Any Roster ID |
| `InformationRequest`| None | No | Any | N/A |
| `Uninterpretable` | None | No | Any | N/A |

### Candidate to Event Mapping Table

| Candidate Type | Accepted Type | CanonicalClaim Type | PublicEvent Type | Record Created | Gameplay Effect |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `non_game_statement` | `AcceptedNonGameStatement` | `none` | `public_statement_recorded` | Yes | `none` |
| `question` | `AcceptedQuestion` | `none` | `public_question_recorded` | Yes | `none` |
| `suspicion` | `AcceptedSuspicion` | `none` | `suspicion_expressed` | Yes | `suspicion_update` |
| `vote_declaration` | `AcceptedVoteDeclaration` | `none` | `vote_declared` | Yes | `memory_update` |
| `role_claim` | `AcceptedRoleClaim` | `RoleCanonicalClaim` | `role_claim_recorded` | Yes | `claim_registration` |
| `result_claim` | `AcceptedResultClaim` | `ResultCanonicalClaim` | `result_claim_recorded` | Yes | `claim_registration` |
| `information_request` | `AcceptedInformationRequest` | `none` | `none` | No (Transient) | `none` |
| `uninterpretable` | `none` | `none` | `none` | No (Outcome) | `none` |

### Individual Type Definitions

#### 1. NonGameStatementCandidate
- `type`: "non_game_statement"
- `text` (Required): Natural language string.
- Forbidden: `targetId`, `topic`, `claimedRole`, `result`.

#### 2. QuestionCandidate
- `type`: "question"
- `targetId` (Required): Valid ID from roster. Must be alive.
- `topic` (Required): "role", "vote", "opinion", "reason".
- Forbidden: `claimedRole`, `result`.

#### 3. SuspicionCandidate
- `type`: "suspicion"
- `targetId` (Required): Valid ID from roster. Must be alive.
- `reason` (Optional): String describing why.
- Forbidden: `claimedRole`, `result`.

#### 4. VoteDeclarationCandidate
- `type`: "vote_declaration"
- `targetId` (Required): Valid ID from roster. Must be alive.
- Forbidden: `topic`, `claimedRole`, `result`.

#### 5. RoleClaimCandidate
- `type`: "role_claim"
- `claimedRole` (Required): "seer", "werewolf", "citizen".
- Forbidden: `targetId`, `result`.

#### 6. ResultClaimCandidate
- `type`: "result_claim"
- `targetId` (Required): Valid ID from roster.
- `result` (Required): "werewolf", "not_werewolf".
- Forbidden: `claimedRole`.

#### 7. InformationRequestCandidate
- `type`: "information_request"
- `topic` (Required): "rules", "commands", "history".
- Forbidden: `targetId`, `claimedRole`.

#### 8. UninterpretableCandidate
- `type`: "uninterpretable"
- `reason` (Required): "ambiguous", "gibberish", "off_topic".
- `explanation` (Optional): Natural language for diagnostics.
- Forbidden: All state-changing fields.

## 9. `AcceptedSpeechAct` Types (Strict Discriminated Union)

The engine-generated, validated, and bound representation of a speech act. It abolishes the generic `payload` in favor of a strict schema for each type with `additionalProperties: false`.

### Common Metadata (All Accepted Types)
- `schemaVersion`: 1 (Integer, Required)
- `speechActId`: Engine-generated opaque ID (String, Required)
- `requestId`: Link to player request (String, Required)
- `acceptedTurnId`: Turn ID when accepted (String, Required)
- `acceptedStateVersion`: `stateVersion` used as precondition (Integer, Required)
- `actorId`: Authoritative ID bound by the engine (String, Required)
- `causationId`: `requestId` or `eventId` (String, Required)
- `correlationId`: Logical thread ID (String, Required)
- `idempotencyKey`: `requestId` + alternative index + act index (String, Required)

### Accepted Type Definitions

#### 1. AcceptedNonGameStatement
- `type`: "accepted_non_game_statement"
- `text` (Required): String.
- Forbidden: `targetId`, `topic`, `claimedRole`, `result`.
- Source Candidate: `NonGameStatementCandidate`
- PublicEvent: `public_statement_recorded`

#### 2. AcceptedQuestion
- `type`: "accepted_question"
- `targetId` (Required): String (Alive).
- `topic` (Required): "role", "vote", "opinion", "reason".
- Forbidden: `claimedRole`, `result`.
- Source Candidate: `QuestionCandidate`
- PublicEvent: `public_question_recorded`

#### 3. AcceptedSuspicion
- `type`: "accepted_suspicion"
- `targetId` (Required): String (Alive).
- `reason` (Optional): String.
- Forbidden: `claimedRole`, `result`.
- Source Candidate: `SuspicionCandidate`
- PublicEvent: `suspicion_expressed`
- Gameplay Effect: `suspicion_update`

#### 4. AcceptedVoteDeclaration
- `type`: "accepted_vote_declaration"
- `targetId` (Required): String (Alive).
- Forbidden: `topic`, `claimedRole`, `result`.
- Source Candidate: `VoteDeclarationCandidate`
- PublicEvent: `vote_declared`
- Gameplay Effect: `memory_update`

#### 5. AcceptedRoleClaim
- `type`: "accepted_role_claim"
- `claimedRole` (Required): "seer", "werewolf", "citizen".
- Forbidden: `targetId`, `result`.
- Source Candidate: `RoleClaimCandidate`
- PublicEvent: `role_claim_recorded`
- Gameplay Effect: `claim_registration`

#### 6. AcceptedResultClaim
- `type`: "accepted_result_claim"
- `targetId` (Required): String.
- `result` (Required): "werewolf", "not_werewolf".
- Forbidden: `claimedRole`.
- Source Candidate: `ResultClaimCandidate`
- PublicEvent: `result_claim_recorded`
- Gameplay Effect: `claim_registration`

#### 7. AcceptedInformationRequest
- `type`: "accepted_information_request"
- `topic` (Required): "rules", "commands", "history".
- Forbidden: `targetId`, `claimedRole`.
- Source Candidate: `InformationRequestCandidate`
- PublicEvent: `none` (Transient Outcome)

### Accepted Schema Examples

**AcceptedResultClaim**
```json
{
  "schemaVersion": 1,
  "type": "accepted_result_claim",
  "speechActId": "act-1001",
  "requestId": "req-123",
  "acceptedTurnId": "day-1-turn-4",
  "acceptedStateVersion": 17,
  "actorId": "player",
  "causationId": "req-123",
  "correlationId": "conversation-44",
  "idempotencyKey": "req-123:alt-0:act-0",
  "targetId": "npc-beni",
  "result": "werewolf",
  "validationMetadata": {
    "alternativeId": "alt-1",
    "confidence": 0.84
  }
}
```

**AcceptedRoleClaim**
```json
{
  "schemaVersion": 1,
  "type": "accepted_role_claim",
  "speechActId": "act-2001",
  "requestId": "req-456",
  "acceptedTurnId": "day-1-turn-4",
  "acceptedStateVersion": 17,
  "actorId": "npc-beni",
  "causationId": "event-1001",
  "correlationId": "conversation-44",
  "idempotencyKey": "event-1001:alt-0:act-0",
  "claimedRole": "seer"
}
```

## 10. `PublicEvent` Types (Strict Discriminated Union)

An authoritative record of a public game event. It abolishes the generic `payload` and hand-written display text.

### Common Event Metadata (All Event Types)
- `schemaVersion`: 1 (Integer, Required)
- `eventId`: Engine-generated opaque ID (String, Required)
- `requestId`: Link to player request (String, Required)
- `turnId`: Current logical turn (String, Required)
- `stateVersion`: The `stateVersion` resulting *after* this event is committed (Integer, Required)
- `actorId`: The actor performing the event (String, Required)
- `acceptedSpeechActId`: Link to source `AcceptedSpeechAct` (String, Required)
- `causationId`: `requestId` or `eventId` (String, Required)
- `correlationId`: Logical thread ID (String, Required)
- `idempotencyKey`: `source AcceptedSpeechAct key` + event kind (String, Required)
- `createdOrder`: Global incrementing counter (Integer, Unique, Required)

### Event Type Definitions

#### 1. PublicStatementRecordedEvent
- `eventType`: "public_statement_recorded"
- `sourceAct`: `AcceptedNonGameStatement`
- `display`: { "kind": "speech_text", "text": "..." }
- Replay: Idempotent re-render.

#### 2. PublicQuestionRecordedEvent
- `eventType`: "public_question_recorded"
- `sourceAct`: `AcceptedQuestion`
- `targetId`: String.
- `topic`: String.
- Replay: Idempotent re-render.

#### 3. SuspicionExpressedEvent
- `eventType`: "suspicion_expressed"
- `sourceAct`: `AcceptedSuspicion`
- `targetId`: String.
- `reason`: Optional String.
- Gameplay Effect: `suspicion_update`
- Replay: No-op if already applied to current session state.

#### 4. VoteDeclaredEvent
- `eventType`: "vote_declared"
- `sourceAct`: `AcceptedVoteDeclaration`
- `targetId`: String.
- Gameplay Effect: `memory_update`
- Replay: No-op if already applied.

#### 5. RoleClaimRecordedEvent
- `eventType`: "role_claim_recorded"
- `sourceAct`: `AcceptedRoleClaim`
- `claimId` (Required): String.
- `display`: { "kind": "canonical_claim", "claimId": "..." }
- Gameplay Effect: `claim_registration`
- Replay: Re-register `claimId` (overwrite is fine as claims are idempotent).

#### 6. ResultClaimRecordedEvent
- `eventType`: "result_claim_recorded"
- `sourceAct`: `AcceptedResultClaim`
- `claimId` (Required): String.
- `display`: { "kind": "canonical_claim", "claimId": "..." }
- Gameplay Effect: `claim_registration`
- Replay: Re-register `claimId`.

### Event Schema Examples

**ResultClaimRecordedEvent**
```json
{
  "schemaVersion": 1,
  "eventId": "event-1001",
  "eventType": "result_claim_recorded",
  "requestId": "req-123",
  "turnId": "day-1-turn-4",
  "stateVersion": 18,
  "actorId": "player",
  "acceptedSpeechActId": "act-1001",
  "causationId": "req-123",
  "correlationId": "conversation-44",
  "idempotencyKey": "req-123:alt-0:act-0:result_claim",
  "createdOrder": 142,
  "claimId": "claim-1001",
  "display": {
    "kind": "canonical_claim",
    "claimId": "claim-1001"
  }
}
```

**RoleClaimRecordedEvent**
```json
{
  "schemaVersion": 1,
  "eventId": "event-2001",
  "eventType": "role_claim_recorded",
  "requestId": "req-456",
  "turnId": "day-1-turn-4",
  "stateVersion": 19,
  "actorId": "npc-beni",
  "acceptedSpeechActId": "act-2001",
  "causationId": "event-1001",
  "correlationId": "conversation-44",
  "idempotencyKey": "event-1001:alt-0:act-0:role_claim",
  "createdOrder": 143,
  "claimId": "claim-2001",
  "display": {
    "kind": "canonical_claim",
    "claimId": "claim-2001"
  }
}
```

- **Replay Policy:** Event replay uses `eventId` for deduplication. Applying a previously processed event is a NO-OP. Ordering is strictly enforced by `createdOrder`.

## 11. `CanonicalClaim` Types (Strict Discriminated Union)

`CanonicalClaim` is the single source of truth for all public assertions. It is decoupled from actual game truth.

### Common Metadata (All Claims)
- `schemaVersion`: 1
- `claimId`: Engine-generated opaque ID.
- `claimRevision`: 1 for new claims; `previous + 1` for amendments.
- `actorId`: The actor making the claim.
- `sourceSpeechActIds`: List of `AcceptedSpeechAct` IDs that established or repeated this claim.
- `idempotencyKey`: `source AcceptedSpeechAct key` + claim kind.
- `createdTurnId`: Turn ID when first created.
- `createdStateVersion`: Resulting `stateVersion` after commit.
- `status`: "asserted" (default).

### Union Type Examples

**RoleCanonicalClaim**
```json
{
  "type": "role_claim",
  "claimId": "claim-1002",
  "claimRevision": 1,
  "actorId": "player",
  "claimedRole": "seer",
  "sourceSpeechActIds": ["act-1002"],
  "idempotencyKey": "req-123:alt-0:act-1:role_claim",
  "createdTurnId": "day-1-turn-4",
  "createdStateVersion": 18,
  "repeatsClaimId": null,
  "supersedesClaimId": null,
  "contradictsClaimIds": [],
  "status": "asserted"
}
```

**ResultCanonicalClaim**
```json
{
  "type": "result_claim",
  "claimId": "claim-1001",
  "claimRevision": 1,
  "actorId": "player",
  "targetId": "npc-beni",
  "result": "werewolf",
  "sourceSpeechActIds": ["act-1001"],
  "idempotencyKey": "req-123:alt-0:act-0:result_claim",
  "createdTurnId": "day-1-turn-4",
  "createdStateVersion": 18,
  "repeatsClaimId": null,
  "supersedesClaimId": null,
  "contradictsClaimIds": [],
  "status": "asserted"
}
```

### Claim Management Rules

- **Assertion vs. Truth:** Validation checks if the NPC is *permitted* by policy to make the claim, NOT if it matches internal knownInfo. Strategic deception is engine-controlled.
- **Atomic Creation:** If an utterance contains both role and result claims, two `CanonicalClaim` and two `PublicEvent` objects are created in the same logical commit.
- **No Circularity:** Reference order: `AcceptedSpeechAct` -> `CanonicalClaim` -> `PublicEvent`.

### Claim Revision and Relation Rules
All related claims must belong to the same `actorId` and exist within the current session.

| Type | claimRevision | Relationship Fields | Rule |
| :--- | :---: | :--- | :--- |
| **New Assertion** | 1 | All null/empty | First time making this specific claim. |
| **Repeat** | 1 | `repeatsClaimId` | `supersedesClaimId` must be null. |
| **Amendment** | `prev + 1` | `supersedesClaimId`| `repeatsClaimId` must be null. |
| **Contradiction** | 1 | `contradictsClaimIds` | `repeatsClaimId` and `supersedesClaimId` must be null. |

- **Exclusivity:** A single claim cannot be both a `Repeat` and an `Amendment`.
- **Amendment/Contradiction Mixing:** Prohibited. A claim that corrects a previous statement is an `Amendment`. A claim that logically conflicts without superseding is a `Contradiction`.
- **Persistence:** Previous claims are never deleted; they are preserved for history and suspicion auditing.

## 12. `NpcReactionPlan` Schema

The engine generates the plan for an NPC's response. It contains NO private game facts. All planned claims are explicitly listed in `intendedSpeechActs` and `canonicalSegments`.

```json
{
  "schemaVersion": 1,
  "npcId": "npc-beni",
  "intendedSpeechActs": [
    { "type": "role_claim", "claimedRole": "seer" }
  ],
  "policies": [
    "do_not_invent_additional_claims",
    "do_not_modify_canonical_segments",
    "do_not_reference_private_facts",
    "do_not_add_unplanned_vote_declarations",
    "stay_in_character"
  ],
  "canonicalSegments": [
    {
      "segmentId": "segment-2001",
      "type": "canonical_claim",
      "claimId": "claim-2001"
    }
  ],
  "commentaryPlan": {
    "intent": "defend_self",
    "authorizedPublicFacts": [
      "I was asked about my role",
      "Beni is suspected of being a werewolf"
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

- **Note on AI Role:** The AI Renderer must not add, change, or remove `canonicalSegments`. All NPC "lies" or "truth" claims must be planned by the engine.

## 13. `InterpretationOutcome` and `ClarificationOutcome`

Clarification requests do NOT generate `PublicEvent` or `AcceptedSpeechAct` objects and are not recorded in the public history.

### InterpretationOutcome
A non-persistent transient object describing the engine's initial triage of an `InterpretationResult`.
- **Match:** `alternatives.length === 1`. Proceed to validation.
- **Ambiguity:** `alternatives.length > 1`. Proceed to `ClarificationOutcome`.
- **System Failure:** `interpretationFailure` is present. Triggers a system error message.

### ClarificationOutcome
A deterministic engine response when player input is ambiguous.
- **State Impact:** None. `turnId` and `stateVersion` do not progress.
- **UI Behavior:** Displays a button or text asking the user to choose or rephrase.
- **Deterministic:** The response is generated by the engine, not an AI Renderer.

## 14. Input Interpreter Contract

- **Endpoint:** `POST /api/interpret-player-input`
- **Validation:** If interpretations are ambiguous (multiple alternatives) or invalid, the engine triggers a clarification response without updating state.

## 15. NPC Utterance Renderer Contract

- **Endpoint:** `POST /api/render-npc-utterance`
- **Text Composition:** The browser engine assembles the final UI text by concatenating the AI's `commentary` with its own `canonicalSegments` based on the `compositionStrategy`.

## 16. Claim and Game Truth

- **Asserted vs Actual:** Separate `assertedClaim` from `actualGameTruth`.
- **Lies:** Allowed and recorded as `CanonicalClaim`.
- **Validation:** Verification check if the NPC is *allowed* by policy to make such a claim, NOT if it's true.

## 17. Operational Logic

### Authoritative Transaction Boundary (Atomicity)
The browser-side `WerewolfGame` is the sole transaction authority.
1.  **Input Phase:** Capture player input.
2.  **AI Phase:** Interpreter request (stateless proxy).
3.  **Commit Phase:** Single atomic update in browser (AcceptedSpeechAct, PublicEvent, CanonicalClaim, State increment).
4.  **Reaction Phase:** Planning and Renderer request.

### Idempotency Key Generation Rules
The browser engine generates deterministic keys to ensure idempotency across retries.
- **SpeechAct:** `requestId` + alternative index + act index.
- **CanonicalClaim:** `source AcceptedSpeechAct key` + claim kind (`role_claim` or `result_claim`).
- **PublicEvent:** `source AcceptedSpeechAct key` + event kind.

Retries with the same `requestId` and indices must result in the exact same `idempotencyKey`, preventing duplicate domain objects or events.

### State Versioning Semantics
- **AcceptedSpeechAct.acceptedStateVersion:** The `stateVersion` of the engine when validation was performed (Precondition version).
- **CanonicalClaim.createdStateVersion:** The `stateVersion` resulting *after* the atomic commit (Resulting version).
- **PublicEvent.stateVersion:** Same as the resulting version of its commit.
- **Rule:** Objects created in the same logical commit must share the same resulting `stateVersion`.

## 18. Provider & HTTP Contracts

- **Endpoints:** Separate `POST /api/interpret-player-input` and `POST /api/render-npc-utterance`.
- **Responsibility:** Server remains a stateless proxy.

## 19. Migration Plan

### Phase 1: Pure schemas, validators, and canonical renderers (Recommended First PR)
- **Objective:** Establish the data foundation.
- **Files:** `src/schemas.mjs` (new), `src/validator.mjs`.
- **Action:** Implement validators and `renderClaimForSegment` functions.
- **Tests:** Unit tests for schemas.
- **Risk:** Zero. Independent deployment possible.

### Phase 2-9: Incremental Integration
- Progress through shadow mode, atomic commit, and gradual replacement of legacy logic.

## 20. Finalized Design Decisions

- **Authoritative State:** Held in Browser.
- **Server:** Stateless Proxy.
- **Ambiguity Handling:** Multiple interpretation alternatives trigger deterministic clarification fallback.
- **Lies:** Allowed and recorded as `CanonicalClaim`.
- **Renderer Data:** Private facts strictly prohibited; use policies.

## 21. Open Design Questions

- **UI Highlights:** How to visually distinguish canonical segments from AI commentary?
- **Contradictory Input:** Rejection of "I am the Seer and the Werewolf" acts.

## 22. Test Strategy
- Unit tests for all JSON schemas.
- Mock AI providers for deterministic pipeline testing.

## 23. Security Boundary
- AI Interpreter never sees private role data.
- AI Renderer never sees private game truth.

## 24. First Implementation PR
- **Scope:** Phase 1 (Schemas and Validators).
