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
- Owns all displayable text variants and templates.

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

## 8. `SpeechActCandidate` Types (Strict Discriminated Union)

All candidate types follow a strict `additionalProperties: false` policy. Unknown fields are rejected. The AI must NOT include an authoritative `actorId`.

### Candidate Type Definitions

#### 1. NonGameStatementCandidate
- `type`: "non_game_statement" (Discriminator)
- `text` (Required, String, 1-500 chars)
- `additionalProperties`: false

#### 2. QuestionCandidate
- `type`: "question"
- `targetId` (Required, String): Validated ID from `publicRoster`
- `topic` (Required, Enum): "role", "vote", "opinion", "reason"
- `additionalProperties`: false

#### 3. SuspicionCandidate
- `type`: "suspicion"
- `targetId` (Required, String): Validated ID from `publicRoster`
- `reason` (Optional, String, 0-500 chars)
- `additionalProperties`: false

#### 4. VoteDeclarationCandidate
- `type`: "vote_declaration"
- `targetId` (Required, String): Validated ID from `publicRoster`
- `additionalProperties`: false

#### 5. RoleClaimCandidate
- `type`: "role_claim"
- `claimedRole` (Required, Enum): "seer", "werewolf", "citizen"
- `additionalProperties`: false

#### 6. ResultClaimCandidate
- `type`: "result_claim"
- `targetId` (Required, String): Validated ID from `publicRoster`
- `result` (Required, Enum): "werewolf", "not_werewolf"
- `additionalProperties`: false

#### 7. InformationRequestCandidate
- `type`: "information_request"
- `topic` (Required, Enum): "rules", "commands", "history"
- `additionalProperties`: false

#### 8. UninterpretableCandidate
- `type`: "uninterpretable"
- `reason` (Required, Enum): "gibberish", "missing_required_reference", "unsupported_intent", "off_topic"
- `explanation` (Optional, String, 0-500 chars)
- `additionalProperties`: false

## 9. `AcceptedSpeechAct` Types (Strict Discriminated Union)

The engine-generated representation of a bound act.

### Metadata
- `schemaVersion`: 1 (Integer, Required)
- `speechActId`: String (Required)
- `requestId`: String (Required)
- `acceptedTurnId`: String (Required)
- `acceptedStateVersion`: Integer (Required)
- `actorId`: String (Required, Bound by engine)
- `causationId`: String (Required)
- `correlationId`: String (Required)
- `idempotencyKey`: String (Required)
- `additionalProperties`: false

## 10. `PublicEvent` Types (Strict Discriminated Union)

Authoritative public records.

### Event Metadata
- `schemaVersion`: 1 (Integer, Required)
- `eventId`: String (Required)
- `requestId`: String (Required)
- `turnId`: String (Required)
- `stateVersion`: Integer (Required)
- `actorId`: String (Required)
- `acceptedSpeechActId`: String (Required)
- `causationId`: String (Required)
- `correlationId`: String (Required)
- `idempotencyKey`: String (Required)
- `createdOrder`: Integer (Unique, Required)
- `additionalProperties`: false

## 11. `CanonicalClaim` Types (Strict Discriminated Union)

`CanonicalClaim` is the single source of truth for assertions.

### Claim Metadata
- `schemaVersion`: 1 (Integer, Required)
- `claimId`: String (Required)
- `claimRevision`: Integer (Required)
- `actorId`: String (Required)
- `sourceSpeechActIds`: Array of String (Required)
- `idempotencyKey`: String (Required)
- `createdTurnId`: String (Required)
- `createdStateVersion`: Integer (Required)
- `repeatsClaimId`: String | null (Required)
- `supersedesClaimId`: String | null (Required)
- `contradictsClaimIds`: Array of String (Required)
- `status`: Enum "asserted" (Required)
- `additionalProperties`: false

## 12. `NpcReactionPlan` Schema

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

### Render Modes
- **canonical_only:** Used for state-changing acts (Claims, votes, suspicion). The engine renders the text entirely from structured data. The Renderer is NOT called.
- **controlled_commentary:** Used for non-state-changing reactive speech. The AI selects an engine-approved `variantId`. No natural language is generated by the AI.

## 13. Input Interpreter Detailed Contract

### 13.1 Provider Interface
```js
interpretPlayerInput(request, { signal })
```
- **Input:** `InterpreterRequest`
- **Context:** `signal` (AbortSignal, Optional)
- **Output:** `InterpreterProviderResult`

### 13.2 Interpreter Request Schema (`InterpreterRequest`)

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
- **PlayerContext:** `{ schemaVersion: 1, actorId: "player", additionalProperties: false }`
- **PublicRosterEntry:** `{ id: String, displayName: String, alive: Boolean, publiclyKnownStatus: Enum "normal"|"suspected"|"executed"|"attacked", additionalProperties: false }`
- **PublicContext:** `{ recentEvents: Array<PublicEventProjection>, publicClaims: Array<PublicClaimProjection>, publicVoteHistory: Array<PublicVoteProjection>, publicExecutionHistory: Array<PublicExecutionProjection>, publicHistoryWindow: Integer, additionalProperties: false }`
- **InterpreterLimits:** `{ maximumAlternatives: Integer, maximumSpeechActsPerAlternative: Integer, additionalProperties: false }`

#### Projection Schemas (Public-only)
- **PublicEventProjection:** `{ eventId: String, eventType: String, actorId: String, turnId: String, additionalProperties: false }`
- **PublicClaimProjection:** `{ claimId: String, type: String, actorId: String, targetId: String | null, claimedRole: String | null, result: String | null, additionalProperties: false }`

### 13.3 Interpreter Output Schemas

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

### 13.4 Input and Output Limits
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
| `timeout` | 15000ms (Global deadline) |
| `maximumAttempts` | 3 (Including first call) |

**Nesting Depth Calculation:**
- Root object depth = 1.
- Each nested object or array increments depth by 1.
- Primitives do not increment depth.

## 14. NPC Utterance Renderer Detailed Contract

### 14.1 Provider Interface
```js
renderNpcUtterance(request, { signal })
```

### 14.2 Renderer Request Schema (`RendererRequest`)
Used only when `renderMode` is `controlled_commentary`.

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
      "ponder_suspicious",
      "ponder_confused"
    ],
    "authorizedPublicFacts": [
      "I was asked about the rules",
      "It is currently Day 1"
    ]
  },
  "allowedPublicReferences": {
    "roster": ["player", "npc-beni"],
    "events": ["event-1001"]
  },
  "styleHints": ["calm", "polite"],
  "limits": {
    "maxChars": 240
  },
  "policies": ["stay_in_character"],
  "locale": "ja-JP"
}
```

#### Detailed Schemas
- **NpcActorProjection:** `{ id: String, name: String, personality: String, speechStyle: String, additionalProperties: false }`
- **ControlledCommentaryPlan:** `{ intent: String, allowedVariantIds: Array<String>, authorizedPublicFacts: Array<String>, additionalProperties: false }`
- **RendererPolicies:** Enum Array ["stay_in_character", "be_polite"]

### 14.3 Renderer Output Schemas

#### RendererModelOutput
- **schemaVersion**: 1 (Required)
- **selectedVariantId**: String (Required, Must be from `allowedVariantIds`)
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

### 14.4 Renderer Correlation Rules
The browser engine MUST discard the response and perform no state mutation if any of the following do not match the pending request context:
- `requestId`
- `reactionPlanId`
- `turnId`
- `stateVersion`
- `schemaVersion`

## 15. Operational Logic: Retry and Deadline

### 15.1 Unified Policy
- **Global Deadline:** 15 seconds (Total time for all attempts).
- **Maximum Attempts:** 3 (Including first attempt).
- **Per-Attempt Timeout:** Remaining global deadline, capped at 5 seconds.
- **Backoff:** 1 second then 2 seconds (Linear).
- **AbortSignal:** Must interrupt the current request, provider call, and any pending backoff sleep immediately.

### 15.2 Retry Eligibility
- **Retryable Errors:** 429 (Rate Limit), Transient connection failure, Provider 5xx, Timeout.
- **Non-Retryable Errors:** 400 (Invalid Client Schema/JSON), 413 (Payload Too Large), 502 (Provider Auth/Schema Failure), Abort, Stale Context (Turn/Version mismatch).

## 16. HTTP & Error Contracts

### 16.1 Endpoint Definitions
- **POST /api/interpret-player-input**
- **POST /api/render-npc-utterance**

| Status | Error Code | Description |
| :--- | :--- | :--- |
| **400** | `malformed_json`, `invalid_schema` | Malformed request or schema violation. |
| **413** | `body_too_large` | Body exceeds 64 KiB. |
| **415** | `unsupported_media_type` | Not `application/json`. |
| **429** | `server_rate_limited` | Rate limit exceeded. |
| **502** | `invalid_provider_response` | Provider returned malformed/invalid JSON. |
| **502** | `provider_auth_failure` | Internal server error (Credentials). |
| **503** | `provider_unavailable` | Upstream provider down. |
| **504** | `provider_timeout` | Upstream provider timed out. |

### 16.2 Error Envelope (ErrorEnvelope)
- **schemaVersion**: 1 (Required)
- **requestId**: String | null (Required, null if unparseable)
- **correlationId**: String (Required, Server-generated)
- **error**: `ErrorDetail` (Required)
- **additionalProperties**: false

#### ErrorDetail
- **code**: Enum (Required, See Table 16.1)
- **retryable**: Boolean (Required)
- **additionalProperties**: false

## 17. Diagnostics Schema

### Diagnostics
- **schemaVersion**: 1 (Required)
- **providerName**: String (Required)
- **modelId**: String | null (Required)
- **latencyMs**: Integer (Required, Non-negative)
- **responseBytes**: Integer (Required, Non-negative)
- **attemptCount**: Integer (Required, 1-3)
- **schemaValidation**: Enum "passed"|"failed" (Required)
- **errorCode**: String | null (Required)
- **additionalProperties**: false
