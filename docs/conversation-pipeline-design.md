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
- **alternatives**: Array of `SpeechActAlternative` (Required, 0-3 items)
- **additionalProperties**: false

### SpeechActAlternative
- **alternativeId**: String (Required)
- **speechActs**: Array of `SpeechActCandidate` (Required, 1-4 items)
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
          "result": "werewolf",
          "sourceSpan": { "start": 9, "end": 18 }
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
- **topic**: `QuestionTopic` (Required)
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 3. SuspicionCandidate
- **type**: "suspicion"
- **targetId**: String (Required): Validated ID from `publicRoster`
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 4. VoteDeclarationCandidate
- **type**: "vote_declaration"
- **targetId**: String (Required): Validated ID from `publicRoster`
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 5. RoleClaimCandidate
- **type**: "role_claim"
- **claimedRole**: `ClaimableRole` (Required)
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 6. ResultClaimCandidate
- **type**: "result_claim"
- **targetId**: String (Required): Validated ID from `publicRoster`
- **result**: `ClaimResult` (Required)
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 7. InformationRequestCandidate
- **type**: "information_request"
- **topic**: Enum (Required): "rules", "commands", "history"
- **sourceSpan**: `SourceSpan` (Required)
- **additionalProperties**: false

#### 8. UninterpretableCandidate
- **type**: "uninterpretable"
- **reason**: Enum (Required): "gibberish", "missing_required_reference", "unsupported_intent", "off_topic"
- **sourceSpan**: `SourceSpan` (Required; the entire input span when the whole input is uninterpretable)
- **additionalProperties**: false

### SourceSpan
- **start**: Integer (Required, Unicode code point index)
- **end**: Integer (Required, Unicode code point index)
- **additionalProperties**: false
- **Constraint**: `0 <= start < end <= rawText code point length`

Indices count Unicode code points, not UTF-16 code units or bytes; `start` is inclusive and `end` is exclusive. Within one alternative, candidates are ordered by ascending `sourceSpan.start`. State-changing candidate spans never overlap. Punctuation is assigned deterministically to the immediately preceding semantic span; leading punctuation and separators not consumed by a semantic span remain raw. Every unclassified range, including whitespace or punctuation outside accepted spans, becomes a `RawInputSegment`. Accepted acts preserve the candidate span unchanged, and the engine derives the display plan deterministically from accepted spans without asking the AI.

For `私は占い師です。Beniは人狼でした。Aoiはどう思いますか？`, the accepted spans produce, in order: a canonical role-claim segment, a canonical result-claim segment, and a raw segment containing the original question span. The two claim spans are not rendered again as raw text.

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
- **sourceSpan**: `SourceSpan` (Required, copied unchanged from the validated candidate)
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
- **topic**: `QuestionTopic` (Required)
- **Forbidden**: `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: `PublicQuestionRecordedEvent`

#### 3. AcceptedSuspicion
- **type**: "accepted_suspicion" (Discriminator)
- **targetId**: String (Required, alive NPC)
- **Forbidden**: `topic`, `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: `SuspicionExpressedEvent`
- **Gameplay Effect**: `suspicion_update`

#### 4. AcceptedVoteDeclaration
- **type**: "accepted_vote_declaration" (Discriminator)
- **targetId**: String (Required, alive NPC)
- **Forbidden**: `topic`, `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: `VoteDeclaredEvent`
- **Gameplay Effect**: `memory_update`

#### 5. AcceptedRoleClaim
- **type**: "accepted_role_claim" (Discriminator)
- **claimedRole**: `ClaimableRole` (Required)
- **Forbidden**: `targetId`, `topic`, `result`
- **Generated CanonicalClaim**: `RoleCanonicalClaim`
- **Generated PublicEvent**: `RoleClaimRecordedEvent`
- **Gameplay Effect**: `claim_registration`

#### 6. AcceptedResultClaim
- **type**: "accepted_result_claim" (Discriminator)
- **targetId**: String (Required)
- **result**: `ClaimResult` (Required)
- **Forbidden**: `topic`, `claimedRole`
- **Generated CanonicalClaim**: `ResultCanonicalClaim`
- **Generated PublicEvent**: `ResultClaimRecordedEvent`
- **Gameplay Effect**: `claim_registration`

#### 7. AcceptedInformationRequest
- **type**: "accepted_information_request" (Discriminator)
- **topic**: Enum (Required): "rules", "commands", "history"
- **Forbidden**: `targetId`, `claimedRole`, `result`, `claimId`
- **Generated PublicEvent**: none (Internal only)

## 10. `PublicEvent` Types (Strict Discriminated Union)

Authoritative public records. Every ID is a non-empty ASCII identifier of 1-64 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`. All six event types have `additionalProperties: false`.

### Common Required Fields (`EventMetadata`)

- **schemaVersion**: integer literal `1`
- **eventId**, **requestId**, **turnId**, **actorId**, **acceptedSpeechActId**, **causationId**, **correlationId**, **idempotencyKey**: ID
- **stateVersion**: integer, minimum `0`
- **phase**: `GamePhase`
- **createdOrder**: integer, minimum `0`, unique across the event stream

`PublicStatementRecordedEvent`, `PublicQuestionRecordedEvent`, `SuspicionExpressedEvent`, and `VoteDeclaredEvent` additionally require **inputRecordId** and **displayPlanId** (ID). They never carry `sourceSpan`; segmentation is owned exclusively by the referenced `PlayerUtteranceDisplayPlan`. The plan's `inputRecordId` must equal the event's `inputRecordId`.

### Individual Event Types

| Type | Discriminator `eventType` | Additional required fields | Optional fields | Forbidden fields |
| :--- | :--- | :--- | :--- | :--- |
| `PublicStatementRecordedEvent` | `public_statement_recorded` | `inputRecordId: ID`, `displayPlanId: ID` | none | `sourceSpan`, `targetId`, `topic`, `claimId`, `claimedRole`, `result` |
| `PublicQuestionRecordedEvent` | `public_question_recorded` | `inputRecordId: ID`, `displayPlanId: ID`, `targetId: ID`, `topic: QuestionTopic` | none | `sourceSpan`, `claimId`, `claimedRole`, `result` |
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
- **contradictsClaimIds**: Array of String (Required, unique)
- **status**: Enum "asserted" (Required)
- **additionalProperties**: false

### Individual Claim Types
1. **RoleCanonicalClaim**: `{ type: "role_claim", claimedRole: ClaimableRole, ...ClaimMetadata }`
   - Forbidden: `targetId`, `result`
2. **ResultCanonicalClaim**: `{ type: "result_claim", targetId: String, result: ClaimResult, ...ClaimMetadata }`
   - Forbidden: `claimedRole`

### Claim Management Rules
- **New Assertion**: `rev=1`, `repeats=null`, `contradicts=[]`.
- **Repeat**: `rev=1`, `repeats=originalId`. Actor, claim type, subject, and normalized payload match exactly. A role claim payload matches only when `claimedRole` matches; a result claim payload matches only when both `targetId` and `result` match.
- **Amendment**: unsupported in this baseline. There is no amendment candidate, accepted act, or `supersedesClaimId` field. No payload change implies correction. Explicit amendment acts are reserved for a later schema version.
- **Contradiction**: `rev=1`, `contradicts=[ids]`. Actor, claim type, and subject match, while normalized payloads logically conflict. Result claims about different targets are not contradictions.
- **Rules**: `repeatsClaimId` and non-empty `contradictsClaimIds` are mutually exclusive. Every referenced claim exists and precedes the new claim. A normal role or result claim that conflicts with a prior same-actor, same-type, same-subject claim is a contradiction, never an amendment.

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
- **turnId**: ID (Required)
- **stateVersion**: Integer (Required, minimum 0; pre-display authoritative version)
- **segments**: Array of `PlayerDisplaySegment` (Required, 1-64 items, ordered)
- **additionalProperties**: false

### PlayerDisplaySegment (Strict Union)
1. **RawInputSegment** requires `segmentId: ID`, discriminator `type: "raw_input"`, `inputRecordId: ID`, and `sourceSpan: SourceSpan`; it forbids `claimId` and `voteEventId` and has `additionalProperties: false`.
2. **CanonicalClaimSegment** requires `segmentId: ID`, discriminator `type: "canonical_claim"`, and `claimId: ID`; it forbids `inputRecordId`, `sourceSpan`, and `voteEventId` and has `additionalProperties: false`.
3. **CanonicalVoteSegment** requires `segmentId: ID`, discriminator `type: "canonical_vote"`, and `voteEventId: ID`; it forbids `inputRecordId`, `sourceSpan`, `claimId`, and `suspicionEventId` and has `additionalProperties: false`.
4. **CanonicalSuspicionSegment** requires `segmentId: ID`, discriminator `type: "canonical_suspicion"`, and `suspicionEventId: ID`; it forbids `inputRecordId`, `sourceSpan`, `claimId`, and `voteEventId` and has `additionalProperties: false`.

Segments follow source order. Segment IDs are unique. Raw spans belong to the plan's input record, are in bounds, and do not overlap. A span canonicalized as a claim, vote, or suspicion event is omitted from raw segments, so raw and canonical segments never render the same semantic content twice. Canonical segments store only domain-object or public-event IDs, never canonical text. Multiple claims from one input produce multiple canonical segments in source order. Replay uses the stored plan unchanged, never reparses `rawText` after plan creation, and never uses AI-generated display text.

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
5. **AnswerDescriptor**: `{ type: "answer", topic: QuestionTopic, additionalProperties: false }`

`CommentarySpeechActDescriptor` is the strict union below. Every member is non-nullable and has `additionalProperties: false`.

| Member | Discriminator `type` | Required fields | Optional fields | Forbidden fields |
| :--- | :--- | :--- | :--- | :--- |
| `AnswerDescriptor` | `answer` | `topic: QuestionTopic` | none | `targetId`, `claimedRole`, `result`, mutation fields |
| `AcknowledgementDescriptor` | `acknowledgement` | `referenceId: ID` | none | `topic`, `targetId`, `claimedRole`, `result`, mutation fields |
| `PonderingDescriptor` | `pondering` | `topic: QuestionTopic` | none | `targetId`, `claimedRole`, `result`, mutation fields |
| `DeclineDescriptor` | `decline` | `reason: DeclineReason` | none | `topic`, `targetId`, `claimedRole`, `result`, mutation fields |
| `ClarificationRequestDescriptor` | `clarification_request` | `reason: ClarificationReason` | `allowedTargetIds: ID[0..16]` | `topic`, `targetId`, `claimedRole`, `result`, mutation fields |

`referenceId` must exist in the controlled plan's allowed public references. `allowedTargetIds` contains unique IDs present in the public roster. All descriptor strings are IDs or closed enums, so no descriptor contains free-form text.

`ReactionPolicies` is a closed, non-nullable object requiring discriminator `policyType: "reaction_policies"`, `allowStateChanges: boolean`, `allowClaims: boolean`, `allowVoteDeclaration: boolean`, `allowSuspicionUpdate: boolean`, and `allowMemoryUpdate: boolean`. It has no optional fields, forbids every unlisted field, contains no references or length-bearing strings, and sets `additionalProperties: false`. Canonical-only policy booleans must exactly reflect its descriptors. Controlled commentary requires all five values to be `false`.

`ControlledCommentaryPlan` is a closed, non-nullable object requiring `intent: CommentaryIntent` and `allowedPublicReferenceIds: ID[0..32]`; it has no optional fields and `additionalProperties: false`. IDs are unique and must resolve to public projections in the eventual renderer request. This plan is the authoritative owner of the list.

### CanonicalSegment (Strict Union)
1. **CanonicalClaimSegment**: `{ segmentId: String, type: "canonical_claim", claimId: String, additionalProperties: false }`
2. **CanonicalVoteSegment**: `{ segmentId: String, type: "canonical_vote", voteEventId: String, additionalProperties: false }`
3. **CanonicalSuspicionSegment**: `{ segmentId: String, type: "canonical_suspicion", suspicionEventId: String, additionalProperties: false }`

For every `CanonicalOnlyReactionPlan`, state-changing descriptors and canonical segments have a one-to-one, onto correspondence: each descriptor is represented exactly once, no segment lacks a descriptor, and referenced claim/event type matches the descriptor. Controlled commentary continues to prohibit all state-changing descriptors.

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
  "publicEvents": [{ "schemaVersion": 1, "projectionType": "public_statement_event", "eventId": "event-1001", "actorId": "player", "turnId": "turn-7", "phase": "day_discussion" }],
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
| `PublicStatementEventProjection` | `public_statement_event` | `eventId: ID`, `actorId: ID`, `turnId: ID`, `phase: GamePhase` | `targetId`, `claimId`, `role`, `result`, `publicStatus` |
| `PublicQuestionEventProjection` | `public_question_event` | `eventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `phase: GamePhase`, `topic: QuestionTopic` | `claimId`, `role`, `result`, `publicStatus` |
| `SuspicionEventProjection` | `suspicion_event` | `eventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `phase: GamePhase` | `claimId`, `role`, `result`, `publicStatus`, `score` |
| `VoteEventProjection` | `vote_event` | `eventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `phase: GamePhase` | `claimId`, `role`, `result`, `publicStatus` |
| `RoleClaimEventProjection` | `role_claim_event` | `eventId: ID`, `actorId: ID`, `claimId: ID`, `turnId: ID`, `phase: GamePhase` | `targetId`, `role`, `result`, `publicStatus` |
| `ResultClaimEventProjection` | `result_claim_event` | `eventId: ID`, `actorId: ID`, `claimId: ID`, `turnId: ID`, `phase: GamePhase` | `targetId`, `role`, `result`, `publicStatus` |
| `RoleClaimProjection` | `role_claim` | `claimId: ID`, `actorId: ID`, `claimedRole: ClaimableRole` | `targetId`, `result`, `phase`, `publicStatus` |
| `ResultClaimProjection` | `result_claim` | `claimId: ID`, `actorId: ID`, `targetId: ID`, `result: ClaimResult` | `claimedRole`, `phase`, `publicStatus` |
| `PublicVoteProjection` | `public_vote` | `voteEventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `phase: GamePhase` | `claimId`, `role`, `result`, `publicStatus` |
| `ExecutionProjection` | `execution` | `executionEventId: ID`, `executedPlayerId: ID`, `turnId: ID`, `phase: GamePhase` | `actorId`, `targetId`, `claimId`, `role`, `result`, `publicStatus` |
| `AttackDeathProjection` | `attack_death` | `attackEventId: ID`, `attackedPlayerId: ID`, `turnId: ID`, `phase: GamePhase` | `actorId`, `targetId`, `claimId`, `role`, `result`, `publicStatus` |

`PublicRosterEntry` does not contain `publiclyKnownStatus`; public suspicion is represented only by `SuspicionEventProjection`, preserving both the actor and target. It is derived solely from public events and never from internal suspicion scores or private memory.

Each request array has the maximum shown in `RendererRequest`, rejects duplicate primary IDs, preserves authoritative `createdOrder` (or source order for non-event projections), and rejects references to unknown IDs. Claim-event projections reference an existing same-request claim projection with matching actor and claim type. Public votes reference an existing vote event. Execution and attack-death player IDs reference public roster entries. Stable ordering is retained on replay.

### Projection unions

`PublicEventProjection` is the strict discriminated union `PublicStatementEventProjection | PublicQuestionEventProjection | SuspicionEventProjection | VoteEventProjection | RoleClaimEventProjection | ResultClaimEventProjection`. Its discriminator is `projectionType`; members, required fields, forbidden fields, ID limits, closed enums, nullability, and `additionalProperties: false` are exactly those in the table above. Event and claim references must resolve inside the same request projection graph.

`ClaimProjection` is the strict discriminated union `RoleClaimProjection | ResultClaimProjection`. Its discriminator is `projectionType`; both members require `schemaVersion`, `claimId`, and `actorId`, accept no nulls or optional fields, and obey the member-specific fields and prohibitions above. Referenced actors and result targets must exist in `publicRoster`.

## 16. Enums

### GameRole
Closed enum: `seer`, `werewolf`, `citizen`. This is the authoritative role model currently implemented by the engine.

### ClaimableRole
Explicit closed subset of `GameRole`: `seer`, `werewolf`, `citizen`. `RoleClaimCandidate`, `AcceptedRoleClaim`, `RoleCanonicalClaim`, descriptors, and projections all reference this single definition. Future engine roles must first be added to `GameRole`; public claim support is then an explicit `ClaimableRole` decision.

### ClaimResult
Closed enum: `werewolf`, `not_werewolf`. Every candidate, accepted act, canonical claim, descriptor, event-derived view, and projection references this single definition.

### Other Closed Enums

- **PublicEventType**: `public_statement_recorded`, `public_question_recorded`, `suspicion_expressed`, `vote_declared`, `role_claim_recorded`, `result_claim_recorded`
- **QuestionTopic**: `role`, `result`, `vote`, `suspicion`, `opinion`, `reasoning`, `rules`, `other`. Candidate, accepted act, interpreter request/output validation, public event, and public projection all reference this one enum; no implicit topic conversion is permitted.
- **GamePhase**: `day_discussion`, `player_question`, `npc_response`, `vote`, `execution`, `night`, `seer_action`, `werewolf_attack`, `win_check`. These exact values come from the authoritative `PHASES` in `src/constants.mjs` and are enforced by `src/gameEngine.mjs`; any rename requires a future migration and schema-version change.
- **PublicStatus**: `alive`, `dead`; suspicion is deliberately not a roster status
- **CommentaryIntent**: `acknowledge`, `ponder`, `decline`, `ask_for_clarification`, `neutral_reaction`
- **ToneTag**: `formal`, `casual`, `brief`, `detailed`
- **VariantLifecycle**: `active`, `retired`
- **DeclineReason**: `not_allowed`, `insufficient_public_information`, `unsupported_topic`
- **ClarificationReason**: `ambiguous_target`, `ambiguous_intent`, `multiple_alternatives`, `uninterpretable`
- **ClarificationTemplateId**: `ask_for_target`, `ask_for_clarification`, `report_gibberish`
- **CandidateType**: `non_game_statement`, `question`, `suspicion`, `vote_declaration`, `role_claim`, `result_claim`, `information_request`, `uninterpretable`
- **LocaleTag**: String, 2-35 ASCII characters matching `^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})+$`

### Phase permission table

All candidate, accepted-act, interpreter-request, public-event, and stale-response checks use `GamePhase` without aliases.

| Phase | Player speech acts accepted | Notes |
| :--- | :--- | :--- |
| `day_discussion` | statements, questions, suspicions, role/result claims, information requests | vote declarations are rejected until `vote` |
| `player_question` | same alternative already being interpreted | new requests are rejected while pending |
| `npc_response` | none | renderer correlation only |
| `vote` | vote declarations and information requests | claims/questions are rejected |
| `execution` | none | engine transition only |
| `night` | none | engine transition only |
| `seer_action` | none | engine-owned action only |
| `werewolf_attack` | none | engine-owned action only |
| `win_check` | none | engine-owned check only |

## 17. Alternative acceptance and clarification

`confidence` is diagnostics-only. No threshold, margin, sort order, or "highest confidence" rule may affect acceptance.

- Zero alternatives is a provider failure unless the sole semantic result is an `UninterpretableCandidate`, which produces clarification.
- Exactly one alternative proceeds to engine validation.
- More than one alternative always produces `ClarificationOutcome`; no state-changing or non-state-changing alternative is auto-selected.
- Every act in the sole alternative is validated as one transaction. Multiple state-changing acts are all-or-nothing, partial acceptance is prohibited, and one invalid act rejects the entire alternative.
- A sole alternative containing only valid non-state-changing acts may be accepted atomically and may create display/public statement events but no state mutation.
- `UninterpretableCandidate` never becomes an `AcceptedSpeechAct`; it produces clarification.

### ClarificationOutcome

This strict schema requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `turnId: ID`, `stateVersion: integer >= 0`, `reason: ClarificationReason`, `templateId: ClarificationTemplateId`, and `allowedTargetIds: ID[0..16]` with unique items. It has no optional or nullable fields and `additionalProperties: false`. Target IDs must exist in the request's public roster.

The engine discards an outcome whose request/correlation does not match the pending request or whose turn/state version is not current. A clarification creates no accepted act, public event, canonical claim, turn advance, or state-version advance. Display uses only the engine-owned template identified by `templateId`; AI-generated explanation text is prohibited.

## 18. Input Interpreter contract

### Provider interface

```js
interpretPlayerInput(request, { signal })
```

### InterpreterRequest

Required fields are `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `turnId: ID`, `stateVersion: integer >= 0`, `locale: LocaleTag`, `rawText: string[1..2000 code points]`, `playerContext: InterpreterPlayerContext`, `phase: GamePhase`, `publicRoster: PublicRosterEntry[1..16]`, `allowedCandidateTypes: CandidateType[1..8]`, `publicContext: InterpreterPublicContext`, and `limits: InterpreterLimits`. There are no optional or nullable fields and `additionalProperties: false`.

`InterpreterPlayerContext` requires only `playerId: ID` and `publicStatus: PublicStatus`. `PublicRosterEntry` requires `playerId: ID`, `displayName: string[1..80]`, and `publicStatus: PublicStatus`. `InterpreterPublicContext` requires `publicEvents: PublicEventProjection[0..64]` and `publicClaims: ClaimProjection[0..64]`. `InterpreterLimits` requires `maxAlternatives: integer 1..3`, `maxActsPerAlternative: integer 1..4`, and `maxNestingDepth: integer 1..8`. Each nested type has no optional fields, rejects null, and has `additionalProperties: false`; IDs are unique and references resolve within the request.

`CandidateType` is the closed enum matching the eight candidate discriminators. `allowedCandidateTypes` is derived from the phase permission table. The request never includes private roles, hidden teams, private results, NPC private memory, internal suspicion scores, API credentials, or provider diagnostics.

### InterpreterModelOutput

The model output is exactly the schema in section 7: structured semantic alternatives only. It contains no correlation envelope, diagnostics, provider metadata, accepted acts, public events, state updates, or display text.

### InterpreterProviderResult

This strict provider-layer schema requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `modelOutput: InterpreterModelOutput`, and `diagnostics: ProviderDiagnostics`; it has no optional or nullable fields and `additionalProperties: false`. `ProviderDiagnostics` is developer-only and requires `providerName: string[1..64]`, `model: string[1..128]`, `attemptCount: integer 1..3`, and `elapsedMs: integer >= 0`, with `additionalProperties: false`. Diagnostics never enter public projections.

### InterpreterHttpResponse

The HTTP success envelope requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, and `result: InterpreterProviderResult`, with no optional fields, no nulls, and `additionalProperties: false`. Envelope IDs must equal the request and nested provider result.

## 19. Renderer contract

### Provider interface

```js
renderNpcUtterance(request, { signal })
```

Canonical-only plans never call this interface. Controlled commentary supplies the `RendererRequest` in section 14, and the model returns only `selectedVariantId` plus `selectedVariantVersion`; raw in-world text is prohibited.

`ControlledCommentaryPlan.allowedPublicReferenceIds` is the authoritative source. `RendererRequest.allowedPublicReferenceIds` is an engine-produced projection copy that must be byte-for-byte equal in order and content; neither server nor provider may independently add, remove, or reorder IDs. Duplicate, private, and unknown IDs are rejected.

### RendererProviderResult

This strict schema requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `reactionPlanId: ID`, `modelOutput: RendererModelOutput`, and `diagnostics: ProviderDiagnostics`; it has no optional or nullable fields and `additionalProperties: false`. The selected variant pair is validated against the request before return.

### RendererHttpResponse

The HTTP success envelope requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `reactionPlanId: ID`, and `result: RendererProviderResult`, with no optional fields, no nulls, and `additionalProperties: false`. All IDs must match the request and nested result. A stale or mismatched response is discarded without retry or state mutation.

## 20. HTTP endpoint contract

Both endpoints accept only `Content-Type: application/json; charset=utf-8`, reject content encoding, and limit the decoded request body to 64 KiB. The server validates transport schemas and correlation only; it never decides authoritative game state, phase legality, claim permission, or roster membership.

| Endpoint | Request | 200 response |
| :--- | :--- | :--- |
| `POST /api/interpret-player-input` | `InterpreterRequest` | `InterpreterHttpResponse` |
| `POST /api/render-npc-utterance` | `RendererRequest` | `RendererHttpResponse` |

For both endpoints: malformed JSON returns 400 `malformed_json`; schema violations return 400 `invalid_schema`; unsupported `schemaVersion` returns 400 `unsupported_schema_version`; unsupported media type returns 415; oversized body returns 413; server rate limit returns 429; invalid provider output or provider authentication failure returns 502; unavailable provider returns 503; provider timeout returns 504. Client disconnect aborts body read, provider call, and backoff and sends no new response. The request `AbortSignal` is propagated through the entire chain.

Logs may include request/correlation IDs, endpoint, status, duration, attempt count, and normalized error code. They must not include raw provider responses, stack traces in client responses, API keys, prompts, private data, variant registry text, or raw player text.

## 21. ErrorEnvelope

`ErrorEnvelope` requires `schemaVersion: 1`, `requestId: ID | null`, `correlationId: ID`, and `error: ErrorDetail`; it has no optional fields and `additionalProperties: false`. `requestId` is null only when malformed transport prevents safe extraction. `ErrorDetail` requires `code: ErrorCode` and `retryable: boolean`, has no optional or nullable fields, and sets `additionalProperties: false`.

| HTTP | ErrorCode | Retryable |
| :--- | :--- | :--- |
| 400 | `malformed_json`, `invalid_schema`, `unsupported_schema_version` | false |
| 413 | `body_too_large` | false |
| 415 | `unsupported_media_type` | false |
| 429 | `server_rate_limited` | true only when a usable `Retry-After` fits the deadline |
| 502 | `invalid_provider_response`, `provider_auth_failure` | false |
| 503 | `provider_unavailable` | conditionally true |
| 504 | `provider_timeout` | conditionally true |

The error response contains no message field and never exposes provider bodies, stack traces, credentials, prompts, private data, or raw player text.

## 22. Timeout, retry, and AbortSignal

- Global deadline: 15 seconds from server receipt.
- Maximum attempts: 3 including the first.
- Per-attempt timeout: `min(5 seconds, remaining deadline)`.
- Backoff before attempts two and three: 1 second, then 2 seconds.
- `requestId`, `correlationId`, `turnId`, and `stateVersion` remain unchanged across attempts.
- One AbortSignal chain covers HTTP body/request lifecycle, provider call, per-attempt timeout, and backoff; client disconnect aborts the same chain.
- An attempt is not started unless its timeout plus required processing allowance fits the remaining deadline.
- Provider authentication failure, invalid request/output schema, wrong correlation ID, and stale response are never retried. Stale responses are discarded.
- Only explicitly classified transient network failures, timeouts, and selected provider-unavailable responses may retry; provider 5xx is not automatically transient.
- `Retry-After` is honored only when it is valid and the wait plus another attempt fits the remaining deadline.

## 23. Migration plan

The first implementation PR is Phase 1 only. It changes no production flow, provider calls, HTTP endpoints, browser integration, state mutation, or regex semantic parsing. Each later phase requires its own review and rollback boundary.

| Phase | Objective | Exact likely existing files | New files | Behavior unchanged | Tests | Rollback / risks / deployment boundary | Removal condition |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1. Pure schemas, validators, canonical renderers | Add side-effect-free schemas, validators, ID helpers, canonical claim/event renderers | `src/validator.mjs`, `src/utteranceGuard.mjs`, `tests/validator.test.mjs`, `tests/utteranceGuard.test.mjs` | likely `src/conversationSchemas.mjs`, `src/canonicalRenderer.mjs`, matching tests | all production paths | schema, Unicode, renderer, idempotency units | independently deployable unused modules behind no call site; revert files; risk is schema drift | none; no old path removed |
| 2. Interpreter transport in shadow mode | Call interpreter without consuming result | `src/webServer.mjs`, `src/responseProvider.mjs`, `src/openaiProvider.mjs`, `public/httpResponseProvider.mjs`, tests | interpreter transport tests | authoritative regex path and mutations | HTTP, timeout, abort, privacy | `INTERPRETER_SHADOW_MODE`; disable flag; risk cost/latency | shadow parity and privacy gates pass |
| 3. Candidate validation without authoritative mutation | Validate/log candidates only | `src/gameEngine.mjs`, `src/validator.mjs`, `public/browserApp.mjs`, tests | candidate conversion tests | current response and mutation behavior | candidate, phase, alternative tests | validation-only flag; disable; risk diagnostic divergence | stable shadow metrics |
| 4. AcceptedSpeechAct and PublicEvent | Create authoritative accepted acts/events atomically | `src/gameEngine.mjs`, `src/responseGenerator.mjs`, tests | event-store helper if needed | NPC response provider path | conversion, replay, stale, atomic tests | dual-write flag with read-old; rollback reads old state; risk duplicate events | replay/idempotency proven |
| 5. Player Claim migration | Move player claims to canonical claim model/rendering | `src/gameEngine.mjs`, `public/browserApp.mjs`, tests | claim registry helper if needed | NPC claims and response generation | relation, display, replay tests | player-claim flag; rollback old rendering; compatibility risk in history | old/new claim parity and replay migration pass |
| 6. NpcReactionPlan | Produce strict reaction plans | `src/responseGenerator.mjs`, `src/gameEngine.mjs`, `src/responseProvider.mjs`, tests | reaction-plan validator if not Phase 1 | existing provider remains selected | strict-union, canonical coverage tests | plan-generation flag; fall back before mutation; risk descriptor mismatch | all state-changing plans canonically render |
| 7. Controlled Renderer integration | Select registered variants for non-state speech | `src/openaiProvider.mjs`, `src/webServer.mjs`, `src/responseProvider.mjs`, `public/httpResponseProvider.mjs`, `public/browserApp.mjs`, tests | variant registry module and renderer contract tests | canonical-only plans bypass renderer | selection, registry replay, HTTP tests | renderer flag; engine-owned deterministic fallback; risk retired version availability | stable selection and replay coverage |
| 8. Suspicion and memory migration | Move updates behind accepted events | `src/gameEngine.mjs`, `src/responseGenerator.mjs`, tests | none expected | voting/night/win logic | atomic update, rollback, regression tests | per-effect flag; revert to old effect path; risk scoring changes | parity criteria and audit logs pass |
| 9. Obsolete-path removal | Remove regex/baseText/shadow compatibility paths | `src/gameEngine.mjs`, `src/responseGenerator.mjs`, `src/validator.mjs`, `src/utteranceGuard.mjs`, `src/webServer.mjs`, `src/responseProvider.mjs`, `src/openaiProvider.mjs`, `public/browserApp.mjs`, `public/httpResponseProvider.mjs`, `tests/` | none | game rules and public behavior | full suite and migration fixtures | deploy only after flags stable; rollback previous release; high compatibility risk | all flags fully enabled, telemetry clean, replay compatibility proven |

The repository has `src/openaiProvider.mjs`; there is no `src/openAIResponseProvider.mjs` or `src/pseudoResponseProvider.mjs` today. Pseudo behavior currently lives in `src/responseProvider.mjs`, so migration plans use actual file names and may split files only in a separately reviewed phase.

## 24. Test strategy

- Schema validation unit tests cover every strict union member, unknown/forbidden fields, closed enums, bounds, nullability, duplicate IDs, and reference integrity.
- Candidate/Accepted/Event conversion tests cover every type and all-or-nothing rejection.
- SourceSpan/display-plan tests use Unicode code points, punctuation ownership, gaps, overlap rejection, compound claims/questions, and replay without reparsing.
- CanonicalClaim rendering tests prove deterministic claim, vote, and suspicion output.
- Duplicate/idempotency and event replay tests prove repeated requests are no-ops and ordering is stable.
- Stale-response tests cover request, correlation, turn, state version, reaction plan, and selected variant mismatches.
- Multiple-alternative tests prove clarification regardless of confidence and no partial mutation.
- Private-projection leak tests reject roles, hidden teams/results, private memory, suspicion scores, prompts, and provider diagnostics.
- Controlled-variant tests cover ID/version/locale/intent match, disabled/retired replay, and unknown references.
- HTTP contract tests cover status mappings, 64 KiB, content type, malformed JSON, strict envelopes, and logging redaction.
- Provider timeout/abort tests cover each attempt, backoff, deadline exhaustion, disconnect, and non-retryable failures.
- Migration compatibility tests cover feature flags, dual-read/write boundaries, rollback fixtures, and old history.
- Existing game-progression regression tests continue covering discussion, question, response, vote, execution, night, seer, attack, and win check.
- A repository CI check must reject bidi controls, zero-width characters, and other unapproved default-ignorable Unicode in design/schema sources. Code-block identifiers and enum literals remain ASCII.

## 25. Design invariants

### Nesting depth calculation

Root object depth is 1; each nested object or array adds 1; primitives add none. Limits are request 8, model 5, and HTTP 10.

### Correlation and replay

The engine discards responses when `requestId`, `correlationId`, `turnId`, `stateVersion`, or `schemaVersion` differs from pending context; Renderer responses also require matching `reactionPlanId`. Duplicate event idempotency keys are no-ops. Replay uses stored events, display plans, and exact variant versions without reinterpreting text.

| Invariant | Status |
| :--- | :--- |
| **AI-generated display text** | PROHIBITED |
| **Raw player display source** | `PlayerInputRecord.rawText` |
| **Claim display source** | CanonicalClaim renderer |
| **Controlled commentary source** | engine-owned variant registry |
| **Unknown fields** | REJECTED |
| **Private facts in provider projection** | PROHIBITED |
| **Duplicate event replay** | NO-OP |
| **State-changing content in commentary variant** | PROHIBITED |
| **Canonical descriptor coverage** | EXACTLY ONCE |
| **Alternative partial acceptance** | PROHIBITED |
| **Confidence-based acceptance** | PROHIBITED |
| **AbortSignal support** | REQUIRED |
| **Nesting depth limits** | ENFORCED (8/5/10) |
| **Unapproved hidden/default-ignorable Unicode** | PROHIBITED and future-CI rejected |
