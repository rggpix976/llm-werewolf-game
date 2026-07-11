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

Authoritative public records. Every ID is a non-empty ASCII identifier of 1-64 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`. All six event types have `additionalProperties: false`.

### Common Required Fields (`EventMetadata`)

- **schemaVersion**: integer literal `1`
- **eventId**, **requestId**, **turnId**, **actorId**, **acceptedSpeechActId**, **causationId**, **correlationId**, **idempotencyKey**: ID
- **stateVersion**: integer, minimum `0`
- **createdOrder**: integer, minimum `0`, unique across the event stream

`PublicStatementRecordedEvent`, `PublicQuestionRecordedEvent`, `SuspicionExpressedEvent`, and `VoteDeclaredEvent` additionally require **inputRecordId** and **displayPlanId** (ID). They never carry `sourceSpan`; segmentation is owned exclusively by the referenced `PlayerUtteranceDisplayPlan`. The plan's `inputRecordId` must equal the event's `inputRecordId`.

### Individual Event Types

| Type | Discriminator `eventType` | Additional required fields | Optional fields | Forbidden fields |
| :--- | :--- | :--- | :--- | :--- |
| `PublicStatementRecordedEvent` | `public_statement_recorded` | `inputRecordId: ID`, `displayPlanId: ID` | none | `sourceSpan`, `targetId`, `topic`, `claimId`, `claimedRole`, `result` |
| `PublicQuestionRecordedEvent` | `public_question_recorded` | `inputRecordId: ID`, `displayPlanId: ID`, `targetId: ID`, `topic: PublicQuestionTopic` | none | `sourceSpan`, `claimId`, `claimedRole`, `result` |
| `SuspicionExpressedEvent` | `suspicion_expressed` | `inputRecordId: ID`, `displayPlanId: ID`, `targetId: ID` | none | `sourceSpan`, `topic`, `claimId`, `claimedRole`, `result` |
| `VoteDeclaredEvent` | `vote_declared` | `inputRecordId: ID`, `displayPlanId: ID`, `targetId: ID` | none | `sourceSpan`, `topic`, `claimId`, `claimedRole`, `result` |
| `RoleClaimRecordedEvent` | `role_claim_recorded` | `claimId: ID` | none | `inputRecordId`, `displayPlanId`, `sourceSpan`, `targetId`, `topic`, `claimedRole`, `result` |
| `ResultClaimRecordedEvent` | `result_claim_recorded` | `claimId: ID` | none | `inputRecordId`, `displayPlanId`, `sourceSpan`, `topic`, `claimedRole`, `result` |

Event display never copies player text. Raw display resolves through `inputRecordId` and `displayPlanId`; claim display resolves through the referenced canonical claim and the engine-owned canonical renderer.

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
- **Repeat**: `rev=1`, `repeats=originalId`. Actor, claim type, subject, and normalized payload match exactly. A role claim payload matches only when `claimedRole` matches; a result claim payload matches only when both `targetId` and `result` match.
- **Amendment**: `rev=previous+1`, `supersedes=amendedId`. Actor and claim type match, and subject is identical, while the payload changes. A role claim's subject is the claiming actor; a result claim's subject is `targetId`.
- **Contradiction**: `rev=1`, `contradicts=[ids]`. Actor, claim type, and subject match, while normalized payloads logically conflict. Result claims about different targets are not contradictions.
- **Rules**: `repeatsClaimId`, `supersedesClaimId`, and non-empty `contradictsClaimIds` are mutually exclusive. Every referenced claim exists and precedes the new claim.

Examples: `Beni is werewolf` followed by `Beni is not_werewolf` is a contradiction when the same actor made both result claims about Beni. `Beni is werewolf` followed by `Aoi is not_werewolf` is not a contradiction because the subjects differ.

## 12. `PlayerInputRecord` and `DisplayPlan`

### PlayerInputRecord
- **schemaVersion**: 1 (Integer, Required)
- **inputRecordId**: ID (Required)
- **rawText**: String (Required, 1-2000 Unicode scalar values, authoritative player text)
- **locale**: LocaleTag (Required)
- **additionalProperties**: false

### PlayerUtteranceDisplayPlan
- **schemaVersion**: 1 (Integer, Required)
- **displayPlanId**: ID (Required)
- **inputRecordId**: ID (Required, must reference an existing `PlayerInputRecord`)
- **segments**: Array of `PlayerDisplaySegment` (Required, 1-64 items, ordered)
- **additionalProperties**: false

### PlayerDisplaySegment (Strict Union)
1. **RawInputSegment** requires `segmentId: ID`, discriminator `type: "raw_input"`, `inputRecordId: ID`, and `sourceSpan: SourceSpan`; it forbids `claimId` and `voteEventId` and has `additionalProperties: false`.
2. **CanonicalClaimSegment** requires `segmentId: ID`, discriminator `type: "canonical_claim"`, and `claimId: ID`; it forbids `inputRecordId`, `sourceSpan`, and `voteEventId` and has `additionalProperties: false`.
3. **CanonicalVoteSegment** requires `segmentId: ID`, discriminator `type: "canonical_vote"`, and `voteEventId: ID`; it forbids `inputRecordId`, `sourceSpan`, and `claimId` and has `additionalProperties: false`.

Segments follow source order. Segment IDs are unique. Raw spans belong to the plan's input record, are in bounds, and do not overlap. A span canonicalized as a claim or vote is omitted from raw segments, so raw and canonical segments never render the same semantic content twice. Multiple claims from one input produce multiple canonical segments in source order. Replay uses the stored plan unchanged and never uses AI-generated display text.

## 13. `NpcReactionPlan` Schema (Strict Union)

### CanonicalOnlyReactionPlan
- **Required**: `schemaVersion: 1`, `reactionPlanId: ID`, `turnId: ID`, `stateVersion: integer >= 0`, `npcId: ID`, `renderMode: "canonical_only"`, `intendedSpeechActs: SpeechActDescriptor[1..16]`, `policies: ReactionPolicies`, `canonicalSegments: CanonicalSegment[1..16]`, `maxChars: integer 1..1000`
- **Forbidden**: `commentaryPlan`, `allowedVariants`
- **additionalProperties**: false

Every plan containing a state-changing descriptor uses this type. It may contain role claims, result claims, vote declarations, and suspicion updates. Its ordered canonical segments completely represent every state-changing descriptor. It never invokes the Renderer; only the engine-owned canonical renderer displays it.

### ControlledCommentaryReactionPlan
- **Required**: `schemaVersion: 1`, `reactionPlanId: ID`, `turnId: ID`, `stateVersion: integer >= 0`, `npcId: ID`, `renderMode: "controlled_commentary"`, `intendedSpeechActs: CommentarySpeechActDescriptor[1..16]`, `policies: ReactionPolicies`, `commentaryPlan: ControlledCommentaryPlan`, `maxChars: integer 1..1000`
- **Forbidden**: `canonicalSegments`
- **additionalProperties**: false

This type prohibits every state-changing descriptor, including `RoleClaimDescriptor`, `ResultClaimDescriptor`, `VoteDeclarationDescriptor`, `SuspicionDescriptor`, and any descriptor that updates suspicion score or memory. It permits only non-authoritative answers, acknowledgements, pondering, declines, and clarification requests. The AI selects only an engine-owned variant ID and version; it does not generate display prose.

### SpeechActDescriptor (Strict Union)
1. **RoleClaimDescriptor**: `{ type: "role_claim", claimedRole: ClaimableRole, additionalProperties: false }`
2. **ResultClaimDescriptor**: `{ type: "result_claim", targetId: String, result: ClaimResult, additionalProperties: false }`
3. **VoteDeclarationDescriptor**: `{ type: "vote_declaration", targetId: String, additionalProperties: false }`
4. **SuspicionDescriptor**: `{ type: "suspicion", targetId: String, additionalProperties: false }`
5. **AnswerDescriptor**: `{ type: "answer", topic: PublicQuestionTopic, additionalProperties: false }`

`CommentarySpeechActDescriptor` is the strict subset `AnswerDescriptor | AcknowledgementDescriptor | PonderingDescriptor | DeclineDescriptor | ClarificationRequestDescriptor`; each member is closed with `additionalProperties: false` and contains no state mutation field. `ReactionPolicies` and `ControlledCommentaryPlan` are also closed objects. `ControlledCommentaryPlan` requires `intent: CommentaryIntent`; its only other permitted field is `allowedPublicReferenceIds: ID[0..32]` with unique items.

### CanonicalSegment (Strict Union)
1. **CanonicalClaimSegment**: `{ segmentId: String, type: "canonical_claim", claimId: String, additionalProperties: false }`
2. **CanonicalVoteSegment**: `{ segmentId: String, type: "canonical_vote", voteEventId: String, additionalProperties: false }`

## 14. `ControlledCommentaryVariant` Registry

### ControlledCommentaryVariant
- **schemaVersion**: 1 (Integer, Required)
- **variantId**: ID (Required, Max 64 chars)
- **variantVersion**: Integer (Required, Min 1)
- **locale**: LocaleTag (Required)
- **renderMode**: Literal `controlled_commentary` (Required)
- **intent**: CommentaryIntent (Required)
- **text**: String (Required, 1-240 chars, NO placeholders)
- **enabled**: Boolean (Required)
- **maximumRenderedChars**: Integer (Required, 1-240 and not less than the actual text length)
- **toneTags**: Array of ToneTag (Required, 0-4 unique items)
- **lifecycle**: VariantLifecycle (Required)
- **additionalProperties**: false

The registry key is `(variantId, variantVersion, locale)`. Entries are immutable. An entry is never deleted; it moves to `retired` when no longer offered. Retired or disabled entries remain readable for replay.

### AllowedCommentaryVariantProjection (AI-facing)
- **schemaVersion**: 1 (Required)
- **variantId**: ID (Required, Max 64 chars)
- **variantVersion**: Integer (Required, Min 1)
- **locale**: LocaleTag (Required)
- **intent**: CommentaryIntent (Required)
- **toneTags**: Array of ToneTag (Required, 0-4 unique items)
- **additionalProperties**: false

### RendererRequest and RendererModelOutput

`RendererRequest` requires `schemaVersion: 1`, `requestId: ID`, `reactionPlanId: ID`, `turnId: ID`, `stateVersion: integer >= 0`, `npcId: ID`, `locale: LocaleTag`, `renderMode: "controlled_commentary"`, `commentaryPlan: ControlledCommentaryPlan`, `publicEvents: PublicEventProjection[0..64]`, `publicClaims: ClaimProjection[0..64]`, `publicVotes: PublicVoteProjection[0..32]`, `executions: ExecutionProjection[0..16]`, `attackDeaths: AttackDeathProjection[0..16]`, `allowedPublicReferenceIds: ID[0..32]`, and `allowedVariants: AllowedCommentaryVariantProjection[1..8]`; it has no optional fields and `additionalProperties: false`.

Every allowed public reference ID is unique and exists in one of the same request's public projection arrays; private and unknown IDs are prohibited. Projection IDs are globally unambiguous within the request. Allowed variants have unique `(variantId, variantVersion)` pairs, and a request must not contain multiple versions of one `variantId`.

`RendererModelOutput` requires exactly `schemaVersion: 1`, `selectedVariantId: ID`, and `selectedVariantVersion: integer >= 1`, with `additionalProperties: false`. The selected pair must exactly match one allowed variant and an existing enabled registry entry whose locale equals the request locale, render mode is `controlled_commentary`, and intent equals `commentaryPlan.intent`.

Schema-valid example:

```json
{
  "schemaVersion": 1,
  "requestId": "request-1001",
  "reactionPlanId": "reaction-1001",
  "turnId": "turn-7",
  "stateVersion": 12,
  "npcId": "npc-aoi",
  "locale": "ja-JP",
  "renderMode": "controlled_commentary",
  "commentaryPlan": { "intent": "acknowledge", "allowedPublicReferenceIds": ["event-1001"] },
  "publicEvents": [{ "schemaVersion": 1, "projectionType": "public_statement_event", "eventId": "event-1001", "actorId": "player", "turnId": "turn-7" }],
  "publicClaims": [],
  "publicVotes": [],
  "executions": [],
  "attackDeaths": [],
  "allowedPublicReferenceIds": ["event-1001"],
  "allowedVariants": [{ "schemaVersion": 1, "variantId": "ack-brief", "variantVersion": 2, "locale": "ja-JP", "intent": "acknowledge", "toneTags": ["brief"] }]
}
```

### SelectedCommentaryVariant

The persisted selection requires exactly `variantId: ID`, `variantVersion: integer >= 1`, and `locale: LocaleTag`, with `additionalProperties: false`. Replay resolves this exact registry key and never substitutes the latest version. Disabled or retired variants remain available for historical reconstruction.

## 15. Public Projections (Strict Schemas)

All projection objects require `schemaVersion: 1`, use the closed `projectionType` discriminator below, have no optional or nullable fields, and set `additionalProperties: false`. Every String typed as ID uses the section 10 ID constraint. No projection may contain raw text, private memory, hidden role data, internal suspicion scores, provider diagnostics, or fields not listed in its row. String values other than IDs are limited by their referenced closed enum; no free-form projection text exists.

| Projection | `projectionType` | Other required fields | Forbidden fields (in addition to every unlisted field) |
| :--- | :--- | :--- | :--- |
| `PublicStatementEventProjection` | `public_statement_event` | `eventId: ID`, `actorId: ID`, `turnId: ID` | `targetId`, `claimId`, `role`, `result`, `phase`, `publicStatus` |
| `PublicQuestionEventProjection` | `public_question_event` | `eventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `topic: PublicQuestionTopic` | `claimId`, `role`, `result`, `phase`, `publicStatus` |
| `SuspicionEventProjection` | `suspicion_event` | `eventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID` | `claimId`, `role`, `result`, `phase`, `publicStatus`, `score` |
| `VoteEventProjection` | `vote_event` | `eventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID` | `claimId`, `role`, `result`, `phase`, `publicStatus` |
| `RoleClaimEventProjection` | `role_claim_event` | `eventId: ID`, `actorId: ID`, `claimId: ID`, `turnId: ID` | `targetId`, `role`, `result`, `phase`, `publicStatus` |
| `ResultClaimEventProjection` | `result_claim_event` | `eventId: ID`, `actorId: ID`, `claimId: ID`, `turnId: ID` | `targetId`, `role`, `result`, `phase`, `publicStatus` |
| `RoleClaimProjection` | `role_claim` | `claimId: ID`, `actorId: ID`, `claimedRole: ClaimableRole` | `targetId`, `result`, `phase`, `publicStatus` |
| `ResultClaimProjection` | `result_claim` | `claimId: ID`, `actorId: ID`, `targetId: ID`, `result: ClaimResult` | `claimedRole`, `phase`, `publicStatus` |
| `PublicVoteProjection` | `public_vote` | `voteEventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `phase: GamePhase` | `claimId`, `role`, `result`, `publicStatus` |
| `ExecutionProjection` | `execution` | `executionEventId: ID`, `executedPlayerId: ID`, `turnId: ID`, `phase: GamePhase` | `actorId`, `targetId`, `claimId`, `role`, `result`, `publicStatus` |
| `AttackDeathProjection` | `attack_death` | `attackEventId: ID`, `attackedPlayerId: ID`, `turnId: ID`, `phase: GamePhase` | `actorId`, `targetId`, `claimId`, `role`, `result`, `publicStatus` |

`PublicRosterEntry` does not contain `publiclyKnownStatus`; public suspicion is represented only by `SuspicionEventProjection`, preserving both the actor and target. It is derived solely from public events and never from internal suspicion scores or private memory.

Each request array has the maximum shown in `RendererRequest`, rejects duplicate primary IDs, preserves authoritative `createdOrder` (or source order for non-event projections), and rejects references to unknown IDs. Claim-event projections reference an existing same-request claim projection with matching actor and claim type. Public votes reference an existing vote event. Execution and attack-death player IDs reference public roster entries. Stable ordering is retained on replay.

## 16. Enums

### GameRole
Closed enum: `seer`, `werewolf`, `citizen`. This is the authoritative role model currently implemented by the engine.

### ClaimableRole
Explicit closed subset of `GameRole`: `seer`, `werewolf`, `citizen`. `RoleClaimCandidate`, `AcceptedRoleClaim`, `RoleCanonicalClaim`, descriptors, and projections all reference this single definition. Future engine roles must first be added to `GameRole`; public claim support is then an explicit `ClaimableRole` decision.

### ClaimResult
Closed enum: `werewolf`, `not_werewolf`. Every candidate, accepted act, canonical claim, descriptor, event-derived view, and projection references this single definition.

### Other Closed Enums

- **PublicEventType**: `public_statement_recorded`, `public_question_recorded`, `suspicion_expressed`, `vote_declared`, `role_claim_recorded`, `result_claim_recorded`
- **PublicQuestionTopic**: `role`, `result`, `vote`, `suspicion`, `reasoning`, `rules`, `other`
- **GamePhase**: `day_discussion`, `voting`, `execution`, `night`, `ended`
- **PublicStatus**: `alive`, `dead`; suspicion is deliberately not a roster status
- **CommentaryIntent**: `acknowledge`, `ponder`, `decline`, `ask_for_clarification`, `neutral_reaction`
- **ToneTag**: `formal`, `casual`, `brief`, `detailed`
- **VariantLifecycle**: `active`, `retired`
- **LocaleTag**: String, 2-35 ASCII characters matching `^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})+$`

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
