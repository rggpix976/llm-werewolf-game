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

- **In Scope:** `SpeechActCandidate` schemas, AI Interpreter/Renderer contracts, browser-side validation and atomicity logic.
- **Out of Scope:** Moving the game engine to the server, adding server-side persistence, changing core game rules (roles, phases). Experimental free-form AI commentary (Natural language generation) is currently out of scope to ensure authoritative consistency.

## 5. Terminology

- **SpeechActCandidate:** An untrusted, structured interpretation of natural language produced by the AI.
- **AcceptedSpeechAct:** An engine-validated and bound communication event that represents an authoritative action.
- **NpcReactionPlan:** Structured instructions from the engine to the AI for selecting a response.
- **CanonicalClaim:** The single source of truth for a role or result claim.
- **Controlled Commentary:** Non-state-changing NPC reactive speech where the AI selects from engine-approved variants instead of generating raw text.

## 6. Responsibility boundaries

### Browser-side Game Engine (Authority)
- Holds authoritative game state, turn IDs, and state versions.
- Validates `SpeechActCandidate` against game rules, phase, and roster.
- Generates `AcceptedSpeechAct` and `PublicEvent` only after successful validation.
- Performs atomic state updates (claims, suspicion, history).
- Generates `NpcReactionPlan` (discriminating between `canonical_only` and `controlled_commentary`).
- Manages idempotency and stale response detection using `requestId` and `turnId`.
- Owns all displayable text variants (`ControlledCommentaryVariant`) and templates.

### Server (Proxy)
- Proxies requests to AI providers.
- Validates HTTP request/response envelopes.
- Normalizes errors (timeouts, provider failures).
- Does NOT validate game rules or maintain session state.

### AI (Interpreter & Renderer)
- **Interpreter:** Natural language -> `InterpreterModelOutput`.
- **Renderer:** `RendererRequest` -> `RendererModelOutput` (Selects `variantId`).
- Does NOT decide legality or mutate state.
- Strictly prohibited from generating natural-language text for in-world display.

## 7. `InterpreterModelOutput` Schema (AI Output)

The AI Interpreter model produces only the structured interpretation content.

### InterpreterModelOutput
- **schemaVersion**: 1 (Integer, Required)
- **alternatives**: Array of `SpeechActAlternative` (Required, Max 3)
- **additionalProperties**: false

### SpeechActAlternative
- **alternativeId**: String (Required)
- **speechActs**: Array of `SpeechActCandidate` (Required, Max 4)
- **confidence**: Number (Required, 0.0 to 1.0)
- **additionalProperties**: false

```json
{
  "schemaVersion": 1,
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
  ]
}
```

### Interpretation Outcomes
- **Uniqueness Requirement:** The engine only proceeds to state mutation if `alternatives.length === 1`.
- **Ambiguity Handling:** If `alternatives.length > 1`, it is treated as an ambiguity failure and triggers a `ClarificationOutcome`.
- **No Guessing:** confidence is diagnostic only. Automatic adoption of top alternatives is prohibited.
- **Uninterpretable Case:** `UninterpretableCandidate` is used when the AI model successfully categorizes the input as incoherent or out-of-scope for the game rules.

## 8. `SpeechActCandidate` Types (Strict Discriminated Union)

All candidate types follow a strict `additionalProperties: false` policy. Unknown fields are rejected. The AI must NOT include an authoritative `actorId`.

### Individual Type Definitions

#### 1. NonGameStatementCandidate
- **type**: "non_game_statement" (Discriminator)
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 2. QuestionCandidate
- **type**: "question"
- **targetId**: String (Required): Validated ID from `publicRoster`
- **topic**: Enum (Required): "role", "vote", "opinion", "reason"
- **additionalProperties**: false

#### 3. SuspicionCandidate
- **type**: "suspicion"
- **targetId**: String (Required): Validated ID from `publicRoster`
- **sourceSpan**: `SourceSpan` (Optional)
- **additionalProperties**: false

#### 4. VoteDeclarationCandidate
- **type**: "vote_declaration"
- **targetId**: String (Required): Validated ID from `publicRoster`
- **additionalProperties**: false

#### 5. RoleClaimCandidate
- **type**: "role_claim"
- **claimedRole**: Enum (Required): "seer", "werewolf", "citizen"
- **additionalProperties**: false

#### 6. ResultClaimCandidate
- **type**: "result_claim"
- **targetId**: String (Required): Validated ID from `publicRoster`
- **result**: Enum (Required): "werewolf", "not_werewolf"
- **additionalProperties**: false

#### 7. InformationRequestCandidate
- **type**: "information_request"
- **topic**: Enum (Required): "rules", "commands", "history"
- **additionalProperties**: false

#### 8. UninterpretableCandidate
- **type**: "uninterpretable"
- **reason**: Enum (Required): "gibberish", "missing_required_reference", "unsupported_intent", "off_topic"
- **additionalProperties**: false

### SourceSpan
- **start**: Integer (Required, Unicode code point index)
- **end**: Integer (Required, Unicode code point index)
- **additionalProperties**: false

## 9. `AcceptedSpeechAct` Types (Strict Discriminated Union)

The engine-generated representation of a bound act.

### Metadata
- **schemaVersion**: 1 (Integer, Required)
- **speechActId**: String (Required)
- **requestId**: String (Required)
- **acceptedTurnId**: String (Required)
- **acceptedStateVersion**: Integer (Required)
- **actorId**: String (Required, Bound by engine)
- **causationId**: String (Required)
- **correlationId**: String (Required)
- **idempotencyKey**: String (Required)
- **additionalProperties**: false

### Individual Types
1. **AcceptedNonGameStatement**: `{ type: "accepted_non_game_statement", sourceSpan: SourceSpan, ...Metadata }`
2. **AcceptedQuestion**: `{ type: "accepted_question", targetId: String, topic: Enum, ...Metadata }`
3. **AcceptedSuspicion**: `{ type: "accepted_suspicion", targetId: String, sourceSpan: SourceSpan | null, ...Metadata }`
4. **AcceptedVoteDeclaration**: `{ type: "accepted_vote_declaration", targetId: String, ...Metadata }`
5. **AcceptedRoleClaim**: `{ type: "accepted_role_claim", claimedRole: Enum, ...Metadata }`
6. **AcceptedResultClaim**: `{ type: "accepted_result_claim", targetId: String, result: Enum, ...Metadata }`
7. **AcceptedInformationRequest**: `{ type: "accepted_information_request", topic: Enum, ...Metadata }`

## 10. `PublicEvent` Types (Strict Discriminated Union)

Authoritative public records.

### Event Metadata
- **schemaVersion**: 1 (Integer, Required)
- **eventId**: String (Required)
- **requestId**: String (Required)
- **turnId**: String (Required)
- **stateVersion**: Integer (Required)
- **actorId**: String (Required)
- **acceptedSpeechActId**: String (Required)
- **causationId**: String (Required)
- **correlationId**: String (Required)
- **idempotencyKey**: String (Required)
- **createdOrder**: Integer (Unique, Required)
- **additionalProperties**: false

### Individual Event Types
1. **PublicStatementRecordedEvent**: `{ eventType: "public_statement_recorded", sourceSpan: SourceSpan, ...EventMetadata }`
2. **PublicQuestionRecordedEvent**: `{ eventType: "public_question_recorded", targetId: String, topic: Enum, ...EventMetadata }`
3. **SuspicionExpressedEvent**: `{ eventType: "suspicion_expressed", targetId: String, sourceSpan: SourceSpan | null, ...EventMetadata }`
4. **VoteDeclaredEvent**: `{ eventType: "vote_declared", targetId: String, ...EventMetadata }`
5. **RoleClaimRecordedEvent**: `{ eventType: "role_claim_recorded", claimId: String, ...EventMetadata }`
6. **ResultClaimRecordedEvent**: `{ eventType: "result_claim_recorded", claimId: String, ...EventMetadata }`

## 11. `CanonicalClaim` Types (Strict Discriminated Union)

`CanonicalClaim` is the single source of truth for assertions.

### Claim Metadata
- **schemaVersion**: 1 (Integer, Required)
- **claimId**: String (Required)
- **claimRevision**: Integer (Required)
- **actorId**: String (Required)
- **sourceSpeechActIds**: Array of String (Required)
- **idempotencyKey**: String (Required)
- **createdTurnId**: String (Required)
- **createdStateVersion**: Integer (Required)
- **repeatsClaimId**: String | null (Required)
- **supersedesClaimId**: String | null (Required)
- **contradictsClaimIds**: Array of String (Required)
- **status**: Enum "asserted" (Required)
- **additionalProperties**: false

### Individual Claim Types
1. **RoleCanonicalClaim**: `{ type: "role_claim", claimedRole: Enum, ...ClaimMetadata }`
   - Forbidden: `targetId`, `result`
2. **ResultCanonicalClaim**: `{ type: "result_claim", targetId: String, result: Enum, ...ClaimMetadata }`
   - Forbidden: `claimedRole`

### Claim Management Rules
- **Amendment**: A new `CanonicalClaim` with `supersedesClaimId` pointing to a previous claim by the same actor.
- **Repeat**: A new `CanonicalClaim` with `repeatsClaimId` pointing to a previous identical claim.
- **Contradiction**: A new `CanonicalClaim` with `contradictsClaimIds` containing IDs of conflicting claims by the same actor.
- **Exclusivity**: A claim cannot have both `repeatsClaimId` and `supersedesClaimId` populated.

## 12. Candidate to Event Mapping Table

| Candidate Type | Accepted Type | CanonicalClaim Type | PublicEvent Type | Record Created | Gameplay Effect | Display Source |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `non_game_statement` | `AcceptedNonGameStatement` | `none` | `public_statement_recorded` | Yes | `none` | Player `rawText` |
| `question` | `AcceptedQuestion` | `none` | `public_question_recorded` | Yes | `none` | Player `rawText` |
| `suspicion` | `AcceptedSuspicion` | `none` | `suspicion_expressed` | Yes | `suspicion_update` | Player `rawText` |
| `vote_declaration` | `AcceptedVoteDeclaration` | `none` | `vote_declared` | Yes | `memory_update` | Player `rawText` |
| `role_claim` | `AcceptedRoleClaim` | `RoleCanonicalClaim` | `role_claim_recorded` | Yes | `claim_registration` | Canonical Renderer |
| `result_claim` | `AcceptedResultClaim` | `ResultCanonicalClaim` | `result_claim_recorded` | Yes | `claim_registration` | Canonical Renderer |
| `information_request` | `AcceptedInformationRequest` | `none` | `none` | Yes (Internal) | `none` | `none` |

## 13. `NpcReactionPlan` Schema

The engine generates the plan for an NPC's response. It enforces a strict safety boundary by separating state-changing canonical segments from controlled reactive speech.

### NpcReactionPlan
- **schemaVersion**: 1 (Integer, Required)
- **npcId**: String (Required)
- **renderMode**: Enum "canonical_only" | "controlled_commentary" (Required)
- **intendedSpeechActs**: Array of `SpeechActDescriptor` (Required)
- **policies**: Array of `RendererPolicy` (Required)
- **canonicalSegments**: Array of `CanonicalSegment` (Required if `renderMode` is `canonical_only`; Forbidden if `controlled_commentary`)
- **commentaryPlan**: `ControlledCommentaryPlan` (Required if `renderMode` is `controlled_commentary`; Forbidden if `canonical_only`)
- **maxChars**: 240 (Integer, Required)
- **additionalProperties**: false

#### SpeechActDescriptor
- **type**: Enum "role_claim" | "result_claim" | "vote_declaration" | "suspicion" | "answer"
- **targetId**: String | null
- **claimedRole**: String | null
- **result**: String | null
- **additionalProperties**: false

#### CanonicalSegment
- **segmentId**: String (Required)
- **type**: Enum "canonical_claim" | "canonical_vote"
- **claimId**: String | null
- **targetId**: String | null
- **additionalProperties**: false

#### RendererPolicy
- **Enum**: "stay_in_character", "be_polite", "avoid_redundancy"

#### ControlledCommentaryPlan
- **intent**: String (Required)
- **allowedVariantIds**: Array of String (Required)
- **allowedPublicReferenceIds**: Array of String (Required)
- **additionalProperties**: false

## 14. `ControlledCommentaryVariant` Registry

The registry is engine-owned and resides in the browser application. AI models select only the `variantId`.

### ControlledCommentaryVariant
- **schemaVersion**: 1 (Integer, Required)
- **variantId**: String (Required)
- **variantVersion**: Integer (Required)
- **locale**: String (Required, e.g., "ja-JP")
- **intent**: String (Required)
- **text**: String (Required, may contain placeholders like `{actorId}`)
- **allowedRenderMode**: "controlled_commentary" (Required)
- **placeholderDefinitions**: `Object` (Required)
- **maximumRenderedChars**: Integer (Required)
- **additionalProperties**: false

## 15. Input Interpreter Detailed Contract

### 15.1 Interpreter Request Schema (`InterpreterRequest`)

```json
{
  "schemaVersion": 1,
  "requestId": "req-123",
  "turnId": "day-1-turn-4",
  "stateVersion": 17,
  "locale": "ja-JP",
  "rawText": "私は占い師です。Beniは人狼でした。",
  "playerContext": {
    "schemaVersion": 1,
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
    "publicVoteHistory": [],
    "publicExecutionHistory": [],
    "publicHistoryWindow": 10
  },
  "limits": {
    "maximumAlternatives": 3,
    "maximumSpeechActsPerAlternative": 4
  }
}
```

#### Nested Schemas
- **PlayerContext**: `{ schemaVersion: 1, actorId: "player", additionalProperties: false }`
- **PublicRosterEntry**: `{ id: String, displayName: String, alive: Boolean, publiclyKnownStatus: Enum "normal"|"suspected"|"executed"|"attacked", additionalProperties: false }`
  - `suspected`: Derived deterministically from public suspicion events, not internal scores.
- **PublicContext**: `{ recentEvents: Array<PublicEventProjection>, publicClaims: Array<PublicClaimProjection>, publicVoteHistory: Array<PublicVoteProjection>, publicExecutionHistory: Array<PublicExecutionProjection>, publicHistoryWindow: Integer, additionalProperties: false }`

#### Projection Schemas (Public-only)
- **PublicEventProjection**: `{ schemaVersion: 1, eventId: String, eventType: String, actorId: String, turnId: String, additionalProperties: false }`
- **RoleClaimProjection**: `{ schemaVersion: 1, claimId: String, type: "role_claim", actorId: String, claimedRole: String, additionalProperties: false }`
- **ResultClaimProjection**: `{ schemaVersion: 1, claimId: String, type: "result_claim", actorId: String, targetId: String, result: String, additionalProperties: false }`
- **PublicVoteProjection**: `{ schemaVersion: 1, actorId: String, targetId: String, turnId: String, additionalProperties: false }`
- **PublicExecutionProjection**: `{ schemaVersion: 1, actorId: String, turnId: String, additionalProperties: false }`

### 15.2 Interpreter Output Schemas

#### InterpreterProviderResult
- **schemaVersion**: 1 (Required)
- **requestId**: String (Required)
- **result**: `InterpreterModelOutput` (Required)
- **diagnostics**: `Diagnostics` (Required)
- **additionalProperties**: false

#### InterpreterHttpResponse (HTTP 200)
- **schemaVersion**: 1 (Required)
- **requestId**: String (Required)
- **turnId**: String (Required)
- **stateVersion**: Integer (Required)
- **providerResult**: `InterpreterProviderResult` (Required)
- **additionalProperties**: false

### 15.3 Input and Output Limits
| Limit | Default Value |
| :--- | :--- |
| `maximum rawText characters` | 1000 |
| `maximum roster entries` | 20 |
| `maximum recent events` | 30 |
| `maximum public claims` | 20 |
| `maximum vote records` | 30 |
| `maximum execution records` | 10 |
| `maximum alternatives` | 3 |
| `maximum speech acts per alternative` | 4 |
| `maximum request nesting depth` | 8 |
| `maximum model-output nesting depth` | 5 |
| `maximum HTTP response nesting depth` | 10 |
| `maximum request bytes` | 65536 (64 KiB) |
| `maximum model-output bytes` | 4096 (4 KiB) |
| `maximum HTTP response bytes` | 8192 (8 KiB) |

## 16. NPC Utterance Renderer Detailed Contract

### 16.1 Renderer Request Schema (`RendererRequest`)

```json
{
  "schemaVersion": 1,
  "requestId": "render-123",
  "turnId": "day-1-turn-4",
  "stateVersion": 19,
  "reactionPlanId": "reaction-1001",
  "renderMode": "controlled_commentary",
  "npcActor": {
    "id": "npc-beni",
    "name": "Beni",
    "personality": "Quiet and analytical",
    "speechStyle": "Formal Japanese"
  },
  "commentaryPlan": {
    "intent": "ponder",
    "allowedVariantIds": [
      "ponder_neutral",
      "ponder_suspicious"
    ],
    "allowedPublicReferenceIds": ["event-1001"]
  },
  "publicRoster": [],
  "publicEvents": [],
  "publicClaims": [],
  "limits": { "maxChars": 240 },
  "locale": "ja-JP"
}
```

### 16.2 Renderer Output Schemas

#### RendererModelOutput
- **schemaVersion**: 1 (Required)
- **selectedVariantId**: String (Required, must be in `allowedVariantIds`)
- **additionalProperties**: false

```json
{
  "schemaVersion": 1,
  "selectedVariantId": "ponder_neutral"
}
```

#### RendererProviderResult
- **schemaVersion**: 1 (Required)
- **requestId**: String (Required)
- **reactionPlanId**: String (Required)
- **result**: `RendererModelOutput` (Required)
- **diagnostics**: `Diagnostics` (Required)
- **additionalProperties**: false

#### RendererHttpResponse (HTTP 200)
- **schemaVersion**: 1 (Required)
- **requestId**: String (Required)
- **reactionPlanId**: String (Required)
- **turnId**: String (Required)
- **stateVersion**: Integer (Required)
- **providerResult**: `RendererProviderResult` (Required)
- **additionalProperties**: false

## 17. Operational Logic: Retry and Deadline

### 17.1 Unified Policy
- **Global Deadline**: 15 seconds (Total time for all attempts).
- **Maximum Attempts**: 3 (Including first attempt).
- **Per-Attempt Timeout**: Remaining global deadline, capped at 5 seconds.
- **Backoff**: 1 second then 2 seconds (Linear).
- **AbortSignal**: Must interrupt the current request, provider call, and any pending backoff sleep immediately.

### 17.2 Correlation Rules
The browser engine MUST discard the response if any of the following do not match the pending request context:
- `requestId`, `turnId`, `stateVersion`, `schemaVersion`.
- For Renderer: `reactionPlanId`.

## 18. HTTP & Error Contracts

### 18.1 Endpoint Definitions
- **POST /api/interpret-player-input**
- **POST /api/render-npc-utterance**

| Status | Error Code | Description |
| :--- | :--- | :--- |
| **400** | `malformed_json`, `invalid_schema` | Malformed request or schema violation. |
| **413** | `body_too_large` | Body exceeds 64 KiB. |
| **415** | `unsupported_media_type` | Not `application/json`. |
| **429** | `server_rate_limited` | Rate limit exceeded. |
| **502** | `invalid_provider_response` | Provider returned malformed/invalid JSON or schema mismatch. |
| **502** | `provider_auth_failure` | Internal server error (Credentials). |
| **503** | `provider_unavailable` | Upstream provider down. |
| **504** | `provider_timeout` | Upstream provider timed out. |

### 18.2 Error Envelope (ErrorEnvelope)
- **schemaVersion**: 1 (Integer, Required)
- **requestId**: String | null (Required)
- **correlationId**: String (Required, Server-generated)
- **error**: `ErrorDetail` (Required)
- **additionalProperties**: false

#### ErrorDetail
- **code**: Enum (Required)
- **retryable**: Boolean (Required)
- **additionalProperties**: false

## 19. Diagnostics Schema

### Diagnostics
- **schemaVersion**: 1 (Integer, Required)
- **providerName**: String (Required)
- **modelId**: String | null (Required)
- **latencyMs**: Integer (Required, Non-negative)
- **responseBytes**: Integer (Required, Non-negative)
- **attemptCount**: Integer (Required, 1-3)
- **schemaValidation**: Enum "passed"|"failed" (Required)
- **errorCode**: String | null (Required)
- **additionalProperties**: false

## 20. Operational Safety

### Event Replay Idempotency
- **eventId** and **idempotencyKey** are used for deduplication.
- Replaying a previously processed event is a NO-OP and must not re-apply gameplay effects.

### stateVersion Semantics
- **acceptedStateVersion**: The version used for validation.
- **createdStateVersion**: The resulting version after atomic commit.
- State mutation only occurs if the current engine version matches the `acceptedStateVersion` at the time of commit.
