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
- **Interpreter:** Natural language -> `InterpreterModelOutput`.
- **Renderer:** `RendererRequest` -> `RendererModelOutput`.
- Does NOT decide legality or mutate state.

## 7. `InterpreterModelOutput` Schema (AI Output)

The AI Interpreter model produces only the structured interpretation content. Diagnostics and envelope metadata are handled by the provider wrapper.

### InterpretationModelOutput
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
- `text` (Required, String, 1-500 chars)
- Forbidden: `targetId`, `topic`, `claimedRole`, `result`
- `additionalProperties`: false

#### 2. QuestionCandidate
- `type`: "question"
- `targetId` (Required, String): Validated ID from `publicRoster`
- `topic` (Required, Enum): "role", "vote", "opinion", "reason"
- Forbidden: `claimedRole`, `result`
- `additionalProperties`: false

#### 3. SuspicionCandidate
- `type`: "suspicion"
- `targetId` (Required, String): Validated ID from `publicRoster`
- `reason` (Optional, String, 0-500 chars)
- Forbidden: `claimedRole`, `result`
- `additionalProperties`: false

#### 4. VoteDeclarationCandidate
- `type`: "vote_declaration"
- `targetId` (Required, String): Validated ID from `publicRoster`
- Forbidden: `topic`, `claimedRole`, `result`
- `additionalProperties`: false

#### 5. RoleClaimCandidate
- `type`: "role_claim"
- `claimedRole` (Required, Enum): "seer", "werewolf", "citizen"
- Forbidden: `targetId`, `result`
- `additionalProperties`: false

#### 6. ResultClaimCandidate
- `type`: "result_claim"
- `targetId` (Required, String): Validated ID from `publicRoster`
- `result` (Required, Enum): "werewolf", "not_werewolf"
- Forbidden: `claimedRole`
- `additionalProperties`: false

#### 7. InformationRequestCandidate
- `type`: "information_request"
- `topic` (Required, Enum): "rules", "commands", "history"
- Forbidden: `targetId`, `claimedRole`
- `additionalProperties`: false

#### 8. UninterpretableCandidate
- `type`: "uninterpretable"
- `reason` (Required, Enum): "gibberish", "missing_required_reference", "unsupported_intent", "off_topic"
- `explanation` (Optional, String, 0-500 chars)
- Forbidden: All state-changing fields
- `additionalProperties`: false

## 9. `AcceptedSpeechAct` Types (Strict Discriminated Union)

The engine-generated representation of a bound act.

### Common Metadata (All Accepted Types)
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

[Individual types follow the same schema as candidates but with engine-bound metadata]

## 10. `PublicEvent` Types (Strict Discriminated Union)

Authoritative public records.

### Common Event Metadata
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

[Individual types defined with `additionalProperties: false`]

## 11. `CanonicalClaim` Types (Strict Discriminated Union)

`CanonicalClaim` is the single source of truth for assertions.

### Common Metadata
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

[Individual types defined with `additionalProperties: false`]

## 12. `NpcReactionPlan` Schema

The engine generates the plan for an NPC's response. It enforces the boundary between canonical state-changing content and free-form commentary.

### NpcReactionPlan
- **schemaVersion**: 1 (Integer, Required)
- **npcId**: String (Required)
- **renderMode**: Enum "canonical_only" | "free_commentary" (Required)
- **intendedSpeechActs**: Array of `SpeechActDescriptor` (Required)
- **policies**: Array of String (Required)
- **canonicalSegments**: Array of `CanonicalSegment` (Allowed only if `renderMode` is `canonical_only`)
- **commentaryPlan**: `CommentaryPlan` (Allowed only if `renderMode` is `free_commentary`)
- **maxChars**: 240 (Integer, Required)
- **additionalProperties**: false

```json
{
  "schemaVersion": 1,
  "npcId": "npc-beni",
  "renderMode": "canonical_only",
  "intendedSpeechActs": [
    {
      "type": "role_claim",
      "claimedRole": "seer"
    }
  ],
  "policies": [
    "do_not_invent_additional_claims",
    "stay_in_character"
  ],
  "canonicalSegments": [
    {
      "segmentId": "segment-2001",
      "type": "canonical_claim",
      "claimId": "claim-2001"
    }
  ],
  "maxChars": 240
}
```

### Rendering Modes
- **canonical_only:** Used when the plan includes any state-changing acts (Claims, votes, etc.). The engine renders the text entirely from canonical segments. The Renderer is NOT called.
- **free_commentary:** Used for non-state-changing reactive speech. The Renderer is called to generate `commentaryText`. `canonicalSegments` must be empty.

## 13. `InterpretationOutcome` and `ClarificationOutcome`

Clarification requests do NOT generate `PublicEvent` or `AcceptedSpeechAct` objects.

## 14. Input Interpreter Detailed Contract

### 14.1 Provider Interface
```js
interpretPlayerInput(request, { signal })
```
- **Input:** `InterpreterRequest`
- **Context:** `signal` (AbortSignal, Optional)
- **Output:** `InterpreterProviderResult`
- **Exceptions:** Normalized provider-level errors (Timeout, Connection, etc.).

### 14.2 Interpreter Request Schema (`InterpreterRequest`)

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
    "playerRole": "citizen"
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

#### Detailed Schemas
- **playerContext:** `{ schemaVersion: 1, playerRole: Enum, additionalProperties: false }`
- **publicRoster entry:** `{ id: String, displayName: String, alive: Boolean, publiclyKnownStatus: Enum "normal"|"suspected"|"executed"|"attacked", additionalProperties: false }`
- **publicContext:** `{ recentEvents: Array, publicClaims: Array, publicVoteHistory: Array, publicExecutionHistory: Array, publicHistoryWindow: Integer, additionalProperties: false }`
- **limits:** `{ maximumAlternatives: Integer, maximumSpeechActsPerAlternative: Integer, additionalProperties: false }`

### 14.3 Interpreter Output Schemas

#### InterpreterModelOutput (AI-generated)
- **schemaVersion**: 1 (Required)
- **alternatives**: Array (Required)
- **additionalProperties**: false

#### InterpreterProviderResult (Provider-generated)
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

### 14.4 Input and Output Limits
| Limit | Default Value |
| :--- | :--- |
| `maximum rawText characters` | 1000 |
| `maximum request nesting depth` | 8 |
| `maximum model-output nesting depth` | 5 |
| `maximum HTTP response nesting depth` | 10 |
| `maximum HTTP body bytes` | 65536 (64 KiB) |
| `maximum provider response bytes` | 8192 (8 KiB) |
| `timeout` | 15000ms (Global deadline) |
| `maximumAttempts` | 3 (Including first call) |

### 14.5 Prompt Injection Boundaries
- **Untrusted Data:** `rawText` and strings in `publicContext` are untrusted.
- **Instruction Separation:** Use explicit delimiters in system prompts.
- **No ID Invention:** AI must only use IDs from `publicRoster`.
- **No actorId:** The AI must not generate `actorId`. The engine binds this from the request context.

### 14.6 Interpreter Failure Handling (Engine-side)

| Failure Case | Engine Action | Retryable | State Mutation |
| :--- | :--- | :--- | :--- |
| **Timeout** | Stop request, show error/retry UI. | Yes | None |
| **Abort** | Silently discard. | No | None |
| **Malformed Client JSON**| Discard, show system error. | No | None |
| **Invalid Request Schema**| Discard, show system error. | No | None |
| **Malformed Provider JSON**| Discard, show system error. | No | None |
| **Invalid Provider Schema**| Discard, show system error. | No | None |
| **Wrong requestId** | Discard (security rejection). | No | None |
| **Multiple Alternatives** | Trigger `ClarificationOutcome`. | No | None |
| **Stale turn/version** | Discard (Context mismatch). | No | None |

**Retry Policy:**
- **Retryable:** Connection failure, rate limit (429), provider 5xx, timeout.
- **Backoff:** Linear (1s, 2s).
- **Deadline:** All attempts must complete within the 15s global timeout.

## 15. NPC Utterance Renderer Detailed Contract

### 15.1 Provider Interface
```js
renderNpcUtterance(request, { signal })
```
- **Input:** `RendererRequest`
- **Output:** `RendererProviderResult`
- **Exceptions:** Same as Interpreter.

### 15.2 Renderer Request Schema (`RendererRequest`)
Used only when `renderMode` is `free_commentary`.

```json
{
  "schemaVersion": 1,
  "requestId": "render-123",
  "turnId": "day-1-turn-4",
  "stateVersion": 19,
  "reactionPlanId": "reaction-1001",
  "renderMode": "free_commentary",
  "npcActor": {
    "id": "npc-beni",
    "name": "Beni",
    "personality": "Quiet and analytical",
    "speechStyle": "Formal Japanese"
  },
  "commentaryIntent": {
    "intent": "ponder",
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

#### Prohibited Information (Denylist)
- **Planned Claims:** renderer call is skipped if claims are planned.
- **Claim Content:** No role, result, or target of planned claims is sent.
- **Private Facts:** Hidden roles, wolf identities, inspection results, private memory.
- **Canonical segments:** No placeholders or本文 are sent.

### 15.3 Renderer Output Schemas

#### RendererModelOutput
- **commentaryText**: String (Required, 1-240 chars)
- **additionalProperties**: false

```json
{
  "commentaryText": "少し考えさせてください。"
}
```

#### RendererProviderResult
- **requestId**: String (Required)
- **reactionPlanId**: String (Required)
- **result**: `RendererModelOutput` (Required)
- **diagnostics**: `Diagnostics` (Required)
- **additionalProperties**: false

#### RendererHttpResponse
- **schemaVersion**: 1 (Required)
- **requestId**: String (Required)
- **reactionPlanId**: String (Required)
- **providerResult**: `RendererProviderResult` (Required)
- **additionalProperties**: false

### 15.4 Structural Validation and Fallback
The engine performs structural validation on `commentaryText`.

**Failure Handling (Engine-side):**
- **Mode: canonical_only:** Renderer not called. Display canonical text only.
- **Mode: free_commentary:**
  - On failure (timeout, schema, validation rejection), use deterministic fallback: `（沈黙している）` or empty string.
  - Turn/State are NOT rolled back.

## 16. Claim and Game Truth

- **Asserted vs Actual:** Separate `assertedClaim` from `actualGameTruth`.
- **Lies:** Allowed and recorded as `CanonicalClaim`.

## 17. Operational Logic

### Authoritative Transaction Boundary (Atomicity)
1. **Atomic Commit (Phase 4):** Register all state changes in browser memory.
2. **Phase 6 (UI Composition):**
   - If `canonical_only`: Render canonical segments.
   - If `free_commentary`: Render `validated commentaryText`.
   - Engine combines segments/commentary.

## 18. HTTP & Error Contracts

### 18.1 Endpoint Definitions

| Aspect | `/api/interpret-player-input` | `/api/render-npc-utterance` |
| :--- | :--- | :--- |
| **Method** | POST | POST |
| **Success Status** | 200 OK | 200 OK |
| **JSON Error (400)** | `malformed_json`, `invalid_schema` | `malformed_json`, `invalid_schema` |
| **Size Limit (413)** | `body_too_large` (64 KiB) | `body_too_large` (64 KiB) |
| **Media Type (415)** | `unsupported_media_type` | `unsupported_media_type` |
| **Rate Limit (429)** | `server_rate_limited` | `server_rate_limited` |
| **Provider Error (502)**| `invalid_provider_response`, `provider_auth_failure` | `invalid_provider_response`, `provider_auth_failure` |
| **Provider Down (503)**| `provider_unavailable` | `provider_unavailable` |
| **Timeout (504)** | `provider_timeout` | `provider_timeout` |

### 18.2 Error Envelope (ErrorEnvelope)
- **schemaVersion**: 1 (Required)
- **requestId**: String | null (Required)
- **correlationId**: String (Required, Server-generated)
- **error**: `{ code: Enum, retryable: Boolean }` (Required)
- **additionalProperties**: false

```json
{
  "schemaVersion": 1,
  "requestId": "req-123",
  "correlationId": "corr-abc-999",
  "error": {
    "code": "provider_timeout",
    "retryable": true
  }
}
```

## 19. Migration Plan
*Migration phases 1–9 will be detailed in a future task.*

## 20. Finalized Design Decisions

- **Renderer Restriction:** AI commentary is prohibited if the plan contains any state-changing canonical segments.
- **Strict Separation:** Model output, Provider result, and HTTP response are decoupled.
- **Diagnostics Ownership:** Server/Provider wrapper owns diagnostics; AI model generates only semantic content.
- **AbortSignal:** Supported for end-to-end cancellation.
- **Error Mapping:** Provider auth failure is mapped to 502, not 401.

## 21. Diagnostics Schema

### Diagnostics
- **providerName**: String (Required)
- **modelId**: String | null (Required)
- **latencyMs**: Integer (Required)
- **responseBytes**: Integer (Required)
- **attemptCount**: Integer (Required)
- **schemaValidation**: Enum "passed"|"failed" (Required)
- **errorCode**: String | null (Required)
- **additionalProperties**: false
