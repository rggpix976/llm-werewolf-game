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
- **Interpreter:** Natural language -> `InterpretationResult`.
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
      "alternativeId": "alt-0",
      "speechActs": [
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
- **Ambiguity Handling:** If `alternatives.length > 1`, it is treated as an ambiguity failure and triggers a `ClarificationOutcome`.
- **No Guessing:** confidence is diagnostic only. Automatic adoption of top alternatives is prohibited.
- **Uninterpretable Case:** `UninterpretableCandidate` is used when the AI successfully categorizes the input as incoherent or out-of-scope for the game rules. It must be the sole alternative and sole act.
  - **Outcome:** No `PublicEvent` or `AcceptedSpeechAct` is created. No state mutation occurs. Triggers deterministic clarification or guidance.

## 8. `SpeechActCandidate` Types (Strict Discriminated Union)

All candidate types follow a strict `additionalProperties: false` policy. Unknown fields are rejected. The AI must NOT include an authoritative `actorId`.

### Candidate to Event Mapping Table

| Candidate Type | Accepted Type | CanonicalClaim Type | PublicEvent Type | Record Created | Gameplay Effect |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `non_game_statement` | `AcceptedNonGameStatement` | `none` | `public_statement_recorded` | Yes | `none` |
| `question` | `AcceptedQuestion` | `none` | `public_question_recorded` | Yes | `none` |
| `suspicion` | `AcceptedSuspicion` | `none` | `suspicion_expressed` | Yes | `suspicion_update` |
| `vote_declaration` | `AcceptedVoteDeclaration` | `none` | `vote_declared` | Yes | `memory_update` |
| `role_claim` | `AcceptedRoleClaim` | `RoleCanonicalClaim` | `role_claim_recorded` | Yes | `claim_registration` |
| `result_claim` | `AcceptedResultClaim` | `ResultCanonicalClaim` | `result_claim_recorded` | Yes | `claim_registration` |
| `information_request` | `AcceptedInformationRequest` | `none` | `none` | Yes (Internal) | `none` |
| `uninterpretable` | `none` | `none` | `none` | No (Outcome) | `none` |

### Individual Type Definitions

#### 1. NonGameStatementCandidate
- `type`: "non_game_statement" (Discriminator)
- `text` (Required, String)
- Forbidden: `targetId`, `topic`, `claimedRole`, `result`

#### 2. QuestionCandidate
- `type`: "question"
- `targetId` (Required, String): Must be alive NPC
- `topic` (Required, Enum): "role", "vote", "opinion", "reason"
- Forbidden: `claimedRole`, `result`

#### 3. SuspicionCandidate
- `type`: "suspicion"
- `targetId` (Required, String): Must be alive NPC
- `reason` (Optional, String)
- Forbidden: `claimedRole`, `result`

#### 4. VoteDeclarationCandidate
- `type`: "vote_declaration"
- `targetId` (Required, String): Must be alive NPC
- Forbidden: `topic`, `claimedRole`, `result`

#### 5. RoleClaimCandidate
- `type`: "role_claim"
- `claimedRole` (Required, Enum): "seer", "werewolf", "citizen"
- Forbidden: `targetId`, `result`

#### 6. ResultClaimCandidate
- `type`: "result_claim"
- `targetId` (Required, String)
- `result` (Required, Enum): "werewolf", "not_werewolf"
- Forbidden: `claimedRole`

#### 7. InformationRequestCandidate
- `type`: "information_request"
- `topic` (Required, Enum): "rules", "commands", "history"
- Forbidden: `targetId`, `claimedRole`

#### 8. UninterpretableCandidate
- `type`: "uninterpretable"
- `reason` (Required, Enum): "gibberish", "missing_required_reference", "unsupported_intent", "off_topic"
- `explanation` (Optional, String): Natural language for diagnostics.
- Forbidden: All state-changing fields.
- **Note on "off_topic":** Used when input is coherent but pertains to a context outside of the werewolf game rules.

## 9. `AcceptedSpeechAct` Types (Strict Discriminated Union)

The engine-generated representation of a bound act. It follows a strict `additionalProperties: false` policy. Unknown fields are rejected.

### Common Metadata (All Accepted Types)
- `schemaVersion`: 1 (Integer, Required)
- `speechActId`: Engine-generated opaque ID (String, Required)
- `requestId`: Link to player request (String, Required)
- `acceptedTurnId`: Turn ID when accepted (String, Required)
- `acceptedStateVersion`: `stateVersion` used as validation precondition (Integer, Required)
- `actorId`: Authoritative ID bound by the engine (String, Required)
- `causationId`: `requestId` or `eventId` (String, Required)
- `correlationId`: Logical thread ID (String, Required)
- `idempotencyKey`: `requestId` + alternative index + act index (String, Required)

### Individual Type Definitions

#### 1. AcceptedNonGameStatement
- `type`: "accepted_non_game_statement"
- `text` (Required, String)
- Forbidden: `targetId`, `topic`, `claimedRole`, `result`, `validationMetadata`

#### 2. AcceptedQuestion
- `type`: "accepted_question"
- `targetId` (Required, String): Validated alive NPC
- `topic` (Required, Enum): "role", "vote", "opinion", "reason"
- Forbidden: `claimedRole`, `result`, `validationMetadata`

#### 3. AcceptedSuspicion
- `type`: "accepted_suspicion"
- `targetId` (Required, String): Validated alive NPC
- `reason` (Optional, String)
- Forbidden: `claimedRole`, `result`, `validationMetadata`

#### 4. AcceptedVoteDeclaration
- `type`: "accepted_vote_declaration"
- `targetId` (Required, String): Validated alive NPC
- Forbidden: `topic`, `claimedRole`, `result`, `validationMetadata`

#### 5. AcceptedRoleClaim
- `type`: "accepted_role_claim"
- `claimedRole` (Required, Enum): "seer", "werewolf", "citizen"
- Forbidden: `targetId`, `result`, `validationMetadata`

#### 6. AcceptedResultClaim
- `type`: "accepted_result_claim"
- `targetId` (Required, String)
- `result` (Required, Enum): "werewolf", "not_werewolf"
- Forbidden: `claimedRole`, `validationMetadata`

#### 7. AcceptedInformationRequest
- `type`: "accepted_information_request"
- `topic` (Required, Enum): "rules", "commands", "history"
- Forbidden: `targetId`, `claimedRole`, `validationMetadata`

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
  "result": "werewolf"
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
  "idempotencyKey": "req-456:alt-0:act-0",
  "claimedRole": "seer"
}
```

## 10. `PublicEvent` Types (Strict Discriminated Union)

Authoritative public records following an `additionalProperties: false` policy. Unknown fields are rejected.

### Common Event Metadata (All Event Types)
- `schemaVersion`: 1 (Integer, Required)
- `eventId`: Engine-generated opaque ID (String, Required)
- `requestId`: Link to player request (String, Required)
- `turnId`: Current logical turn (String, Required)
- `stateVersion`: Resulting `stateVersion` after this event is committed (Integer, Required)
- `actorId`: Authoritative performer ID (String, Required)
- `acceptedSpeechActId`: Link to source act (String, Required)
- `causationId`: `requestId` or `eventId` (String, Required)
- `correlationId`: Logical thread ID (String, Required)
- `idempotencyKey`: `source AcceptedSpeechAct key` + event kind (String, Required)
- `createdOrder`: Global incrementing counter (Integer, Unique, Required)

### Individual Event Type Definitions

#### 1. PublicStatementRecordedEvent
- `eventType`: "public_statement_recorded"
- `text` (Required, String)
- Forbidden: `targetId`, `topic`, `claimId`, `display`

#### 2. PublicQuestionRecordedEvent
- `eventType`: "public_question_recorded"
- `targetId` (Required, String)
- `topic` (Required, Enum)
- Forbidden: `claimId`, `display`

#### 3. SuspicionExpressedEvent
- `eventType`: "suspicion_expressed"
- `targetId` (Required, String)
- `reason` (Optional, String)
- Forbidden: `claimId`, `display`
- Gameplay Effect: `suspicion_update`

#### 4. VoteDeclaredEvent
- `eventType`: "vote_declared"
- `targetId` (Required, String)
- Forbidden: `claimId`, `display`
- Gameplay Effect: `memory_update`

#### 5. RoleClaimRecordedEvent
- `eventType`: "role_claim_recorded"
- `claimId` (Required, String)
- `display`: { "kind": "canonical_claim", "claimId": "claim-2001" } (Required)
- Forbidden: `targetId`, `topic`, `claimedRole`, `result`
- **Constraint:** `display.claimId` must exactly match the event's `claimId`.
- Gameplay Effect: `claim_registration`

#### 6. ResultClaimRecordedEvent
- `eventType`: "result_claim_recorded"
- `claimId` (Required, String)
- `display`: { "kind": "canonical_claim", "claimId": "claim-1001" } (Required)
- Forbidden: `targetId`, `result`, `claimedRole`, `topic`
- **Constraint:** `display.claimId` must exactly match the event's `claimId`.
- Gameplay Effect: `claim_registration`

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
  "idempotencyKey": "req-123:alt-0:act-0:result_claim_recorded",
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
  "idempotencyKey": "req-456:alt-0:act-0:role_claim_recorded",
  "createdOrder": 143,
  "claimId": "claim-2001",
  "display": {
    "kind": "canonical_claim",
    "claimId": "claim-2001"
  }
}
```

- **Replay Policy:** Event replay uses `eventId` and `idempotencyKey` for deduplication. Applying a previously processed event is a NO-OP. Ordering is strictly enforced by `createdOrder`. State changes (suspicion, claims, NPC memory, history) are never re-applied during replay.

## 11. `CanonicalClaim` Types (Strict Discriminated Union)

`CanonicalClaim` is the single source of truth for assertions. It follows an `additionalProperties: false` policy. Unknown fields are rejected.

### Common Metadata (All Claims)
- `schemaVersion`: 1 (Integer, Required)
- `claimId`: Engine-generated opaque ID (String, Required)
- `claimRevision`: 1 for new claims; `prev + 1` for amendments (Integer, Required)
- `actorId`: Authoritative ID of the claimant (String, Required)
- `sourceSpeechActIds`: List of unique `AcceptedSpeechAct` IDs (Array of String, Required, No Duplicates)
- `idempotencyKey`: `source AcceptedSpeechAct key` + claim kind (String, Required)
- `createdTurnId`: Turn ID when first created (String, Required)
- `createdStateVersion`: Resulting `stateVersion` after atomic commit (Integer, Required)
- `repeatsClaimId`: Original claim ID or `null` (String | null, Required)
- `supersedesClaimId`: Amended claim ID or `null` (String | null, Required)
- `contradictsClaimIds`: List of unique conflicting claim IDs (Array of String, Required, No Duplicates)
- `status`: "asserted" (Enum, Required)

### Union Type Definitions

#### 1. RoleCanonicalClaim
- `type`: "role_claim" (Discriminator)
- `claimedRole` (Required, Enum): "seer", "werewolf", "citizen"
- Forbidden: `targetId`, `result`

#### 2. ResultCanonicalClaim
- `type`: "result_claim" (Discriminator)
- `targetId` (Required, String): Validated ID from roster.
- `result` (Required, Enum): "werewolf", "not_werewolf"
- Forbidden: `claimedRole`

### Union Type Examples

**RoleCanonicalClaim**
```json
{
  "schemaVersion": 1,
  "type": "role_claim",
  "claimId": "claim-2001",
  "claimRevision": 1,
  "actorId": "npc-beni",
  "claimedRole": "seer",
  "sourceSpeechActIds": [
    "act-2001"
  ],
  "idempotencyKey": "req-456:alt-0:act-0:role_claim",
  "createdTurnId": "day-1-turn-4",
  "createdStateVersion": 19,
  "repeatsClaimId": null,
  "supersedesClaimId": null,
  "contradictsClaimIds": [],
  "status": "asserted"
}
```

**ResultCanonicalClaim**
```json
{
  "schemaVersion": 1,
  "type": "result_claim",
  "claimId": "claim-1001",
  "claimRevision": 1,
  "actorId": "player",
  "targetId": "npc-beni",
  "result": "werewolf",
  "sourceSpeechActIds": [
    "act-1001"
  ],
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

- **Revision and Relations:**
  - **New Assertion:** `claimRevision = 1`, all relation fields empty/null.
  - **Repeat:** New `claimId`, `claimRevision = 1`, `repeatsClaimId` set. `supersedesClaimId` must be `null`.
  - **Amendment:** New `claimId`, `claimRevision = prev + 1`, `supersedesClaimId` set. `repeatsClaimId` must be `null`.
  - **Contradiction:** New `claimId`, `claimRevision = 1`, `contradictsClaimIds` set. `repeatsClaimId` and `supersedesClaimId` must be `null`.
- **Exclusivity:** A single claim record cannot be both a Repeat and an Amendment. A single record cannot be both a Repeat and a Contradiction. Amendment and Contradiction mixing is prohibited.
- **Constraints:** Relations must point to existing Claims by the same `actorId` within the current session.
- **Assertion vs. Truth:** Validation checks if the NPC is *permitted* by policy to make the claim, NOT if it matches internal knownInfo. Strategic deception is engine-controlled.
- **Atomic Creation:** If an utterance contains both role and result claims, two `CanonicalClaim` and two `PublicEvent` objects are created in the same logical commit.
- **No Circularity:** Reference order: `AcceptedSpeechAct` -> `CanonicalClaim` -> `PublicEvent`.

## 12. `NpcReactionPlan` Schema

The engine generates the plan for an NPC's response. It contains NO private game facts. All planned claims are explicitly listed in `intendedSpeechActs` and `canonicalSegments`.

```json
{
  "schemaVersion": 1,
  "npcId": "npc-beni",
  "intendedSpeechActs": [
    {
      "type": "role_claim",
      "claimedRole": "seer"
    }
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
    "order": [
      "commentary",
      "canonical_segments"
    ],
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
- **Ambiguity Handling:** `alternatives.length > 1`. Proceed to `ClarificationOutcome`.
- **System Failure:** `interpretationFailure` is present. Triggers a system error message.

### ClarificationOutcome
A deterministic engine response when player input is ambiguous.
- **State Impact:** None. `turnId` and `stateVersion` do not progress.
- **UI Behavior:** Displays a button or text asking the user to choose or rephrase.
- **Deterministic:** The response is generated by the engine, not an AI Renderer.

## 14. Input Interpreter Detailed Contract

### 14.1 Provider Interface
```js
interpretPlayerInput(request)
```
- **Input:** `InterpreterRequest`
- **Output:** `InterpreterResponse`
- **Exceptions:**
  - `ProviderTimeoutError`: The AI did not respond within 15 seconds.
  - `ProviderConnectionError`: Network or protocol failure.
  - `ProviderRateLimitError`: Upstream rate limit exceeded.
  - `ProviderAuthError`: Credentials invalid or expired.
  - `ProviderException`: Unexpected upstream error.

### 14.2 Interpreter Request Schema (`InterpreterRequest`)
The browser engine prepares this structured request. It contains no private information.

```json
{
  "schemaVersion": 1,
  "requestId": "req-123",
  "turnId": "day-1-turn-4",
  "stateVersion": 17,
  "locale": "ja-JP",
  "rawText": "私は占い師です。Beniは人狼でした。",
  "playerContext": {
    "actorId": "player"
  },
  "phase": "day_discussion",
  "publicRoster": [
    {
      "id": "npc-beni",
      "displayName": "Beni",
      "alive": true,
      "publiclyKnownStatus": "suspected"
    }
  ],
  "allowedCandidateTypes": [
    "non_game_statement",
    "question",
    "suspicion",
    "vote_declaration",
    "role_claim",
    "result_claim",
    "information_request",
    "uninterpretable"
  ],
  "publicContext": {
    "recentEvents": [],
    "publicClaims": [],
    "publicHistoryWindow": 10
  },
  "limits": {
    "maximumAlternatives": 3,
    "maximumSpeechActsPerAlternative": 4
  }
}
```

### 14.3 Interpreter Response Schema (`InterpreterResponse`)
The provider must return this strict envelope.

```json
{
  "schemaVersion": 1,
  "requestId": "req-123",
  "result": {
    "schemaVersion": 1,
    "requestId": "req-123",
    "alternatives": [
      {
        "alternativeId": "alt-0",
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
        "confidence": 0.95
      }
    ],
    "interpretationFailure": null
  },
  "diagnostics": {
    "providerName": "openai",
    "model": "gpt-4o",
    "latencyMs": 1200
  }
}
```

### 14.4 Input and Output Limits
| Limit | Default Value |
| :--- | :--- |
| `maximum rawText characters` | 1000 |
| `maximum HTTP body bytes` | 65536 (64 KiB) |
| `maximum public roster entries` | 20 |
| `maximum recent events` | 30 |
| `maximum alternatives` | 3 |
| `maximum speech acts per alternative` | 4 |
| `maximum nesting depth` | 3 |
| `maximum provider response bytes` | 8192 (8 KiB) |
| `timeout` | 15000ms |
| `retry count` | 2 |

### 14.5 Prompt Injection Boundaries
- **Untrusted Data:** `rawText` and all strings within `publicContext` are treated as untrusted data.
- **Instruction Separation:** System prompts must explicitly separate instructions from data fields using delimiters.
- **Strict Adherence:** The AI must ignore any "ignore previous instructions" or "system override" commands within `rawText`.
- **ID Safety:** The AI is strictly prohibited from inventing new `id` or `actorId` fields. It must only use IDs provided in the `publicRoster`.
- **Validation Authority:** The browser engine remains the sole validator for game rules, regardless of AI confidence or explanations.

### 14.6 Interpreter Failure Handling (Engine-side)
The browser engine performs the following deterministic actions upon Interpreter failure:

| Failure Case | Engine Action | State Mutation |
| :--- | :--- | :--- |
| **Timeout** | Stop request, show retry/error message. | None |
| **Abort** | Silently discard response. | None |
| **Malformed JSON** | Treat as system error, no automatic retry. | None |
| **Schema Failure** | Treat as system error, no automatic retry. | None |
| **Multiple Alternatives** | Trigger `ClarificationOutcome` UI. | None |
| **Unknown Actor/Target** | Reject during rule validation, show error. | None |
| **Stale turn/version** | Discard response (Turn ID or StateVersion mismatch). | None |

## 15. NPC Utterance Renderer Detailed Contract

### 15.1 Provider Interface
```js
renderNpcUtterance(request)
```
- **Input:** `RendererRequest`
- **Output:** `RendererResponse`
- **Exceptions:** Same as Interpreter.

### 15.2 Renderer Request Schema (`RendererRequest`)
The engine projects the `NpcReactionPlan` into this public request.

```json
{
  "schemaVersion": 1,
  "requestId": "render-123",
  "turnId": "day-1-turn-4",
  "stateVersion": 19,
  "reactionPlanId": "reaction-1001",
  "npcActor": {
    "id": "npc-beni",
    "name": "Beni",
    "personality": "Quiet and analytical",
    "speechStyle": "Formal Japanese"
  },
  "commentaryPlan": {
    "intent": "defend_self",
    "authorizedPublicFacts": [
      "I was asked about my role",
      "I am claiming to be the Seer"
    ],
    "styleHint": "calm"
  },
  "allowedPublicReferences": {
    "roster": ["player", "npc-beni"],
    "events": ["event-1001"]
  },
  "styleHints": ["calm", "polite"],
  "limits": {
    "maxChars": 240
  },
  "policies": ["do_not_invent_claims", "stay_in_character"],
  "locale": "ja-JP"
}
```

### 15.3 Renderer Allowlist (Information Boundary)
**Authorized Information (Allowlist):**
- NPC's own public `id`, `name`, `personality`, and `speechStyle`.
- Current public `phase`, `turnId`, and `stateVersion`.
- Content of `authorizedPublicFacts`.
- `id` and `displayName` of participants from `publicRoster`.
- Publicly recorded `PublicEvent` and `CanonicalClaim` objects.

**Prohibited Information (Denylist):**
- NPC's actual `role` or `team` (unless publicly revealed).
- Secret werewolf identities.
- Private Seer/Medium inspection results.
- Internal `suspicionScores` or rationale.
- NPC private memory.
- Unplanned or unrevealed claim plans.
- Original raw player inputs from other turns.
- API keys or system authorization tokens.

### 15.4 Renderer Response Schema (`RendererResponse`)
The provider must return a strict JSON object with `additionalProperties: false`.

```json
{
  "schemaVersion": 1,
  "requestId": "render-123",
  "reactionPlanId": "reaction-1001",
  "commentaryText": "私は占い師です。嘘はついていません。",
  "diagnostics": {
    "providerName": "openai",
    "model": "gpt-4o",
    "latencyMs": 800
  }
}
```

### 15.5 Structural Validation and Fallback
The engine performs structural validation on `commentaryText` using `validateNpcUtteranceStructure` (from `src/utteranceGuard.mjs`).

**Structural Checks:**
- Must be a string.
- Length <= 240 code points.
- No control characters, newlines, or tabs.
- No HTML, Markdown, or JSON-like fragments.
- No illegal Unicode or NUL characters.

**Failure Handling (Engine-side):**
- **Validation Rejection:** The commentary is discarded. The engine uses a fallback string (e.g., "（沈黙している）").
- **Provider Failure (Timeout/Error):** Same as validation rejection.
- **Preservation:** Canonical segments are **never** discarded due to renderer failure. They are always displayed.
- **Idempotency:** The engine ensures only one commentary is displayed per `reactionPlanId`.

## 16. Claim and Game Truth

- **Asserted vs Actual:** Separate `assertedClaim` from `actualGameTruth`.
- **Lies:** Allowed and recorded as `CanonicalClaim`.
- **Validation:** Verification check if the NPC is *allowed* by policy to make such a claim, NOT if it's true.

## 17. Operational Logic

### Authoritative Transaction Boundary (Atomicity)
The browser-side `WerewolfGame` is the sole transaction authority.
1.  **Input Phase:** Capture player input.
2.  **AI Phase:** Interpreter request (stateless proxy).
3.  **Phase 3:** Engine validation of Candidate.
4.  **Phase 4:** **Atomic Commit** in the browser:
    - Register `AcceptedSpeechAct`, `PublicEvent`, `CanonicalClaim`.
    - Update history, suspicion, and memory.
    - Increment `turnId` and `stateVersion`.
5.  **Phase 5:** Reaction Planning and Renderer request.
6.  **Phase 6:** **Final UI Composition** in the browser:
    - The engine renders each canonical segment using `renderCanonicalClaim(claim, roster, locale)`.
    - The engine assembles the `validated commentary` and the `engine-rendered canonical segments`.
    - `FinalText = compositionStrategy(commentary, segments)`.
    - **Guarantees:**
        - The AI cannot generate, delete, or modify canonical segments.
        - Composition order and joiners (e.g., " ") are determined by the engine.
        - Internal IDs (like `claim-1001`) are never displayed in the final UI text.
        - Even if the Renderer fails, the canonical segments remain displayable.

### Idempotency Key Generation Rules
The browser engine generates deterministic keys to ensure idempotency across retries.
- **SpeechAct:** `requestId` + alternative index + act index.
- **CanonicalClaim:** `source AcceptedSpeechAct key` + claim kind (`role_claim` or `result_claim`).
- **PublicEvent:** `source AcceptedSpeechAct key` + event kind.

Retries with the same `requestId` and indices must result in the exact same `idempotencyKey`, preventing duplicate domain objects or events.

## 18. HTTP & Error Contracts

### 18.1 Endpoint Definitions

| Aspect | `/api/interpret-player-input` | `/api/render-npc-utterance` |
| :--- | :--- | :--- |
| **Method** | POST | POST |
| **Content Type** | `application/json` | `application/json` |
| **Request Schema** | `InterpreterRequest` | `RendererRequest` |
| **Success Status** | 200 OK | 200 OK |
| **Success Response** | `InterpreterResponse` | `RendererResponse` |
| **Client Error (400)** | `invalid_schema`, `malformed_json` | `invalid_schema`, `malformed_json` |
| **Body Size Limit** | 64 KiB (`body_too_large`) | 64 KiB (`body_too_large`) |
| **Provider Error (503)**| `provider_exception` | `provider_exception` |
| **Timeout Status (503)**| `provider_timeout` | `provider_timeout` |
| **Rate Limit (429)** | `rate_limit_exceeded` | `rate_limit_exceeded` |
| **Abort Behavior** | Server finishes/terminates, Client discards | Server finishes/terminates, Client discards |
| **Error Envelope** | `ErrorEnvelope` | `ErrorEnvelope` |
| **Diagnostics** | Populated in response | Populated in response |

### 18.2 Error Envelope
Both endpoints use a strict, shared error envelope. It must not leak internal data or API keys.

```json
{
  "schemaVersion": 1,
  "requestId": "req-123",
  "error": {
    "code": "provider_timeout",
    "message": "The AI provider timed out.",
    "retryable": true
  }
}
```

**Common Error Codes:**
- `400 Bad Request`: `invalid_schema`, `body_too_large`, `malformed_json`.
- `401 Unauthorized`: `provider_auth_failure`.
- `429 Too Many Requests`: `rate_limit_exceeded`.
- `503 Service Unavailable`: `provider_exception`, `provider_timeout`.

## 19. Migration Plan

*Migration phases 1–9 will be detailed in a future task.*

## 20. Finalized Design Decisions

- **Authoritative State:** Held in Browser.
- **Server:** Stateless Proxy.
- **Legacy NPC Path:** `generateResponse()` remains only for compatibility during transition.
- **Ambiguity Handling:** Multiple interpretation alternatives trigger deterministic clarification fallback.
- **Renderer Failure:** Preservation of canonical segments is guaranteed.
- **Prompt Injection:** Managed via delimiter-based instruction/data separation and engine-side validation.

## 21. Open Design Questions

- **UI Highlights:** How to visually distinguish canonical segments from AI commentary?
- **Contradictory Input:** Rejection of "I am the Seer and the Werewolf" acts.

## 22. Test Strategy
- Unit tests for all JSON schemas using `additionalProperties: false`.
- Mock AI providers to verify `interpretPlayerInput` and `renderNpcUtterance` separately.
- End-to-end integration tests for fallback behavior (e.g., simulating provider timeout).

## 23. Diagnostics and Logging
- **Allowed:** `requestId`, `providerName`, `latencyMs`, `error.code`, `turnId`, `stateVersion`.
- **Prohibited:** API keys, raw provider prompts, secret roles, private memory.
- **Redaction:** `rawText` is redacted in logs by default unless development-mode is explicitly enabled with a security warning.
