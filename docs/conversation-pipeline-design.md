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
- **PlayerInputRecord:** Immutable record of the player's original natural-language utterance.
- **PlayerUtteranceDisplayPlan:** Authoritative plan for rendering player input segments.

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
- **Renderer:** `RendererRequest` -> `RendererModelOutput` (Selects `variantId` and `version`).
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
- **claimedRole**: `ClaimableRole` (Required)
- **additionalProperties**: false

#### 6. ResultClaimCandidate
- **type**: "result_claim"
- **targetId**: String (Required): Validated ID from `publicRoster`
- **result**: `ClaimResult` (Required)
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
- **Constraint**: `0 <= start < end <= rawText code point length`

## 9. `AcceptedSpeechAct` Types (Strict Discriminated Union)

The engine-generated representation of a bound act.

### Common Required Fields (Metadata)
- **schemaVersion**: 1 (Integer, Required)
- **speechActId**: String (Required, Engine-generated)
- **requestId**: String (Required, Linked to request)
- **acceptedTurnId**: String (Required)
- **acceptedStateVersion**: Integer (Required, Pre-commit version)
- **actorId**: String (Required, Bound by engine)
- **causationId**: String (Required)
- **correlationId**: String (Required)
- **idempotencyKey**: String (Required, `requestId + altIndex + actIndex`)
- **additionalProperties**: false

### Individual Types

#### 1. AcceptedNonGameStatement
- **type**: "accepted_non_game_statement" (Discriminator)
- **sourceSpan**: `SourceSpan` (Required)
- **Forbidden**: `targetId`, `topic`, `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: `PublicStatementRecordedEvent`

#### 2. AcceptedQuestion
- **type**: "accepted_question" (Discriminator)
- **targetId**: String (Required, alive NPC)
- **topic**: Enum (Required): "role", "vote", "opinion", "reason"
- **Forbidden**: `sourceSpan`, `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: `PublicQuestionRecordedEvent`

#### 3. AcceptedSuspicion
- **type**: "accepted_suspicion" (Discriminator)
- **targetId**: String (Required, alive NPC)
- **sourceSpan**: `SourceSpan` (Optional)
- **Forbidden**: `topic`, `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: `SuspicionExpressedEvent`
- **Gameplay Effect**: `suspicion_update`

#### 4. AcceptedVoteDeclaration
- **type**: "accepted_vote_declaration" (Discriminator)
- **targetId**: String (Required, alive NPC)
- **Forbidden**: `sourceSpan`, `topic`, `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: `VoteDeclaredEvent`
- **Gameplay Effect**: `memory_update`

#### 5. AcceptedRoleClaim
- **type**: "accepted_role_claim" (Discriminator)
- **claimedRole**: `ClaimableRole` (Required)
- **Forbidden**: `sourceSpan`, `targetId`, `topic`, `result`
- **Generated CanonicalClaim**: `RoleCanonicalClaim`
- **Generated PublicEvent**: `RoleClaimRecordedEvent`
- **Gameplay Effect**: `claim_registration`

#### 6. AcceptedResultClaim
- **type**: "accepted_result_claim" (Discriminator)
- **targetId**: String (Required)
- **result**: `ClaimResult` (Required)
- **Forbidden**: `sourceSpan`, `topic`, `claimedRole`
- **Generated CanonicalClaim**: `ResultCanonicalClaim`
- **Generated PublicEvent**: `ResultClaimRecordedEvent`
- **Gameplay Effect**: `claim_registration`

#### 7. AcceptedInformationRequest
- **type**: "accepted_information_request" (Discriminator)
- **topic**: Enum (Required): "rules", "commands", "history"
- **Forbidden**: `sourceSpan`, `targetId`, `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: none (Internal only)

## 10. `PublicEvent` Types (Strict Discriminated Union)

Authoritative public records.

### Common Required Fields (EventMetadata)
- **schemaVersion**: 1 (Integer, Required)
- **eventId**: String (Required, Engine-generated)
- **requestId**: String (Required)
- **turnId**: String (Required)
- **stateVersion**: Integer (Required, Resulting version)
- **actorId**: String (Required)
- **acceptedSpeechActId**: String (Required)
- **causationId**: String (Required)
- **correlationId**: String (Required)
- **idempotencyKey**: String (Required, `source act key + eventKind`)
- **inputRecordId**: String (Required, Reference to `PlayerInputRecord`)
- **displayPlanId**: String (Required, Reference to `PlayerUtteranceDisplayPlan`)
- **createdOrder**: Integer (Unique, Required)
- **additionalProperties**: false

### Individual Event Types

#### 1. PublicStatementRecordedEvent
- **eventType**: "public_statement_recorded" (Discriminator)
- **sourceSpan**: `SourceSpan` (Required)
- **Forbidden**: `targetId`, `topic`, `claimId`
- **Display Source**: Player `rawText` (via display plan)

#### 2. PublicQuestionRecordedEvent
- **eventType**: "public_question_recorded" (Discriminator)
- **targetId**: String (Required)
- **topic**: Enum (Required)
- **Forbidden**: `sourceSpan`, `claimId`
- **Display Source**: Player `rawText`

#### 3. SuspicionExpressedEvent
- **eventType**: "suspicion_expressed" (Discriminator)
- **targetId**: String (Required)
- **sourceSpan**: `SourceSpan` (Optional)
- **Forbidden**: `topic`, `claimId`
- **Gameplay Effect**: `suspicion_update`
- **Display Source**: Player `rawText`

#### 4. VoteDeclaredEvent
- **eventType**: "vote_declared" (Discriminator)
- **targetId**: String (Required)
- **Forbidden**: `topic`, `claimId`, `sourceSpan`
- **Gameplay Effect**: `memory_update`
- **Display Source**: Player `rawText`

#### 5. RoleClaimRecordedEvent
- **eventType**: "role_claim_recorded" (Discriminator)
- **claimId**: String (Required, Reference to `CanonicalClaim`)
- **Forbidden**: `targetId`, `topic`, `sourceSpan`
- **Gameplay Effect**: `claim_registration`
- **Display Source**: Canonical Renderer

#### 6. ResultClaimRecordedEvent
- **eventType**: "result_claim_recorded" (Discriminator)
- **claimId**: String (Required, Reference to `CanonicalClaim`)
- **Forbidden**: `claimedRole`, `topic`, `sourceSpan`
- **Gameplay Effect**: `claim_registration`
- **Display Source**: Canonical Renderer

## 11. `CanonicalClaim` Types (Strict Discriminated Union)

### Claim Metadata
- **schemaVersion**: 1 (Integer, Required)
- **claimId**: String (Required)
- **claimRevision**: Integer (Required, starts at 1)
- **actorId**: String (Required)
- **sourceSpeechActIds**: Array of String (Required, unique)
- **idempotencyKey**: String (Required, `source act key + claimKind`)
- **createdTurnId**: String (Required)
- **createdStateVersion**: Integer (Required)
- **repeatsClaimId**: String | null (Required)
- **supersedesClaimId**: String | null (Required)
- **contradictsClaimIds**: Array of String (Required, unique)
- **status**: Enum "asserted" (Required)
- **additionalProperties**: false

### Individual Claim Types
1. **RoleCanonicalClaim**: `{ type: "role_claim", claimedRole: ClaimableRole, ...ClaimMetadata }`
   - Forbidden: `targetId`, `result`
2. **ResultCanonicalClaim**: `{ type: "result_claim", targetId: String, result: ClaimResult, ...ClaimMetadata }`
   - Forbidden: `claimedRole`

### Claim Management Rules
- **New Assertion**: `rev=1`, `repeats=null`, `supersedes=null`, `contradicts=[]`.
- **Repeat**: `rev=1`, `repeats=originalId`. Subject and payload must match exactly.
- **Amendment**: `rev=prev+1`, `supersedes=amendedId`. Subject must match; payload changes.
- **Contradiction**: `rev=1`, `contradicts=[ids]`. Subject must match; payload logically conflicts.
- **Rules**: Mutually exclusive relations. Same actor. compatible types. Same subject (self for roles, `targetId` for results).

## 12. `PlayerInputRecord` and `DisplayPlan`

### PlayerInputRecord
- **schemaVersion**: 1 (Integer, Required)
- **inputRecordId**: String (Required)
- **rawText**: String (Required, Authoritative player text)
- **locale**: String (Required)
- **additionalProperties**: false

### PlayerUtteranceDisplayPlan
- **schemaVersion**: 1 (Integer, Required)
- **displayPlanId**: String (Required)
- **inputRecordId**: String (Required)
- **segments**: Array of `PlayerDisplaySegment` (Required, ordered)
- **additionalProperties**: false

### PlayerDisplaySegment (Strict Union)
1. **RawInputSegment**: `{ segmentId: String, type: "raw_input", inputRecordId: String, sourceSpan: SourceSpan, additionalProperties: false }`
2. **CanonicalClaimSegment**: `{ segmentId: String, type: "canonical_claim", claimId: String, additionalProperties: false }`
3. **CanonicalVoteSegment**: `{ segmentId: String, type: "canonical_vote", voteEventId: String, additionalProperties: false }`

## 13. `NpcReactionPlan` Schema (Strict Union)

### CanonicalOnlyReactionPlan
- **renderMode**: "canonical_only"
- **intendedSpeechActs**: Array of `SpeechActDescriptor` (state-changing allowed)
- **canonicalSegments**: Array of `CanonicalSegment` (Min 1)
- **Forbidden**: `commentaryPlan`
- **additionalProperties**: false

### ControlledCommentaryReactionPlan
- **renderMode**: "controlled_commentary"
- **intendedSpeechActs**: Array of `SpeechActDescriptor` (NO state-changing)
- **commentaryPlan**: `ControlledCommentaryPlan`
- **Forbidden**: `canonicalSegments`, `RoleClaimDescriptor`, `ResultClaimDescriptor`, `VoteDeclarationDescriptor`, `SuspicionDescriptor`
- **additionalProperties**: false

### SpeechActDescriptor (Strict Union)
1. **RoleClaimDescriptor**: `{ type: "role_claim", claimedRole: ClaimableRole, additionalProperties: false }`
2. **ResultClaimDescriptor**: `{ type: "result_claim", targetId: String, result: ClaimResult, additionalProperties: false }`
3. **VoteDeclarationDescriptor**: `{ type: "vote_declaration", targetId: String, additionalProperties: false }`
4. **SuspicionDescriptor**: `{ type: "suspicion", targetId: String, additionalProperties: false }`
5. **AnswerDescriptor**: `{ type: "answer", topic: Enum, additionalProperties: false }`

### CanonicalSegment (Strict Union)
1. **CanonicalClaimSegment**: `{ segmentId: String, type: "canonical_claim", claimId: String, additionalProperties: false }`
2. **CanonicalVoteSegment**: `{ segmentId: String, type: "canonical_vote", voteEventId: String, additionalProperties: false }`

## 14. `ControlledCommentaryVariant` Registry

### ControlledCommentaryVariant
- **schemaVersion**: 1 (Integer, Required)
- **variantId**: String (Required, Max 64 chars)
- **variantVersion**: Integer (Required, Min 1)
- **locale**: String (Required, e.g., "ja-JP")
- **intent**: Enum (Required): "acknowledge", "ponder", "decline", "ask_for_clarification", "neutral_reaction"
- **text**: String (Required, 1-240 chars, NO placeholders)
- **enabled**: Boolean (Required)
- **maximumRenderedChars**: Integer (Required, 1-240)
- **additionalProperties**: false

### AllowedCommentaryVariantProjection (AI-facing)
- **schemaVersion**: 1 (Required)
- **variantId**: String (Required)
- **variantVersion**: Integer (Required)
- **intent**: Enum (Required)
- **toneTags**: Array of Enum (Required, Max 4): ["formal", "casual", "brief", "detailed"]
- **additionalProperties**: false

## 15. Public Projections (Strict Unions)

### Public Event Projections
1. **PublicStatementEventProjection**: `{ eventId: String, type: "public_statement_recorded", actorId: String, turnId: String, additionalProperties: false }`
2. **PublicQuestionEventProjection**: `{ eventId: String, type: "public_question_recorded", actorId: String, targetId: String, turnId: String, additionalProperties: false }`
3. **SuspicionEventProjection**: `{ eventId: String, type: "suspicion_expressed", actorId: String, targetId: String, turnId: String, additionalProperties: false }`
4. **VoteEventProjection**: `{ eventId: String, type: "vote_declared", actorId: String, targetId: String, turnId: String, additionalProperties: false }`
5. **RoleClaimEventProjection**: `{ eventId: String, type: "role_claim_recorded", actorId: String, claimId: String, turnId: String, additionalProperties: false }`
6. **ResultClaimEventProjection**: `{ eventId: String, type: "result_claim_recorded", actorId: String, claimId: String, turnId: String, additionalProperties: false }`

### Claim Projections
1. **RoleClaimProjection**: `{ claimId: String, type: "role_claim", actorId: String, claimedRole: ClaimableRole, additionalProperties: false }`
2. **ResultClaimProjection**: `{ claimId: String, type: "result_claim", actorId: String, targetId: String, result: ClaimResult, additionalProperties: false }`

### Other Projections
1. **PublicVoteProjection**: `{ actorId: String, targetId: String, turnId: String, additionalProperties: false }`
2. **ExecutionProjection**: `{ executedPlayerId: String, turnId: String, additionalProperties: false }`
3. **AttackDeathProjection**: `{ attackedPlayerId: String, turnId: String, additionalProperties: false }`

## 16. Enums

### GameRole
Enum: `seer`, `werewolf`, `citizen`

### ClaimableRole
Subset of `GameRole`: `seer`, `werewolf`, `citizen` (Current game setup)

### ClaimResult
Enum: `werewolf`, `not_werewolf`

## 17. Operational Logic

### Provider Interface
- `interpretPlayerInput(request, { signal })`
- `renderNpcUtterance(request, { signal })`
- **AbortSignal**: Must interrupt request, provider call, and backoff immediately.

### Nesting Depth Calculation
- Root object depth = 1.
- Each nested object or array increments depth by 1.
- Primitives (String, Number, Boolean, null) do not increment depth.
- Limits: Request=8, Model=5, HTTP=10.

### Correlation Rules
The engine MUST discard responses if `requestId`, `turnId`, `stateVersion`, `schemaVersion` (and `reactionPlanId` for Renderer) do not match current context.

## 18. `ClarificationOutcome` Schema

- **schemaVersion**: 1 (Required)
- **reason**: Enum (Required): "ambiguous_target", "ambiguous_intent", "multiple_alternatives", "uninterpretable"
- **templateId**: Enum (Required): "ask_for_target", "ask_for_clarification", "report_gibberish"
- **additionalProperties**: false

## 19. Design Invariants

| Invariant | Status |
| :--- | :--- |
| **AI-generated display text** | PROHIBITED |
| **Raw player display source** | `PlayerInputRecord.rawText` |
| **Claim display source** | CanonicalClaim renderer |
| **Controlled commentary source** | engine-owned variant registry |
| **Unknown fields** | REJECTED |
| **Private facts in provider projection** | PROHIBITED |
| **Duplicate event replay** | NO-OP |
| **State-changing content in commentary variant**| PROHIBITED |
| **AbortSignal support** | REQUIRED |
| **Nesting depth limits** | ENFORCED (8/5/10) |
