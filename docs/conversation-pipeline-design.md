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
- **alternatives**: Array of `SpeechActAlternative` (Required, 1-3 items)
- **additionalProperties**: false

### SpeechActAlternative
- **alternativeId**: String (Required)
- **speechActs**: Array of `SpeechActCandidate` (Required, 1-4 items)
- **confidence**: Number (Required, 0.0 to 1.0)
- **additionalProperties**: false

Zero alternatives is schema-invalid. Semantic failure is represented only by one alternative containing one `UninterpretableCandidate`.

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

Indices count Unicode code points, not UTF-16 code units or bytes; `start` is inclusive and `end` is exclusive. Within one alternative, every candidate span is pairwise non-overlapping and candidates are ordered by ascending `sourceSpan.start`. Overlap, containment, and crossing are all rejected. Each act uses the smallest non-overlapping semantic span; multiple acts never reuse a whole-sentence span. Punctuation is assigned deterministically to the immediately preceding semantic span; leading punctuation and separators not consumed by a semantic span remain raw. Every unclassified range, including whitespace or punctuation outside accepted spans, becomes a `RawInputSegment`. Accepted acts preserve the candidate span unchanged, and the engine derives the display plan deterministically from accepted spans without asking the AI.

Complete test fixture (all indices are Unicode code points, punctuation included in the preceding semantic span):

```json
{
  "rawText": "私は占い師です。Beniは人狼でした。Aoiはどう思いますか？",
  "modelOutput": {
    "schemaVersion": 1,
    "alternatives": [
      {
        "alternativeId": "alt-1",
        "confidence": 0.91,
        "speechActs": [
          { "type": "role_claim", "claimedRole": "seer", "sourceSpan": { "start": 0, "end": 8 } },
          { "type": "result_claim", "targetId": "npc-beni", "result": "werewolf", "sourceSpan": { "start": 8, "end": 19 } },
          { "type": "question", "targetId": "npc-aoi", "topic": "opinion", "sourceSpan": { "start": 19, "end": 31 } }
        ]
      }
    ]
  },
  "displayPlan": {
    "schemaVersion": 1,
    "displayPlanId": "display-1",
    "inputRecordId": "input-1",
    "turnId": "turn-1",
    "stateVersion": 8,
    "segments": [
      { "segmentId": "segment-1", "type": "canonical_claim", "claimId": "claim-role-1" },
      { "segmentId": "segment-2", "type": "canonical_claim", "claimId": "claim-result-1" },
      { "segmentId": "segment-3", "type": "raw_input", "inputRecordId": "input-1", "sourceSpan": { "start": 19, "end": 31 } }
    ]
  }
}
```

Thus the role claim maps to a canonical claim segment, the result claim maps to a canonical claim segment, and only the question maps to raw input. Neither claim range appears in a raw segment.

## 9. `AcceptedSpeechAct` Types (Strict Discriminated Union)

The engine-generated representation of a bound act.

### Common Required Fields (Metadata)
- **schemaVersion**: 1 (Integer, Required)
- **speechActId**: String (Required, Engine-generated)
- **requestId**: String (Required, Linked to request)
- **acceptedTurnId**: String (Required)
- **acceptedStateVersion**: Integer (Required, Pre-commit version)
- **acceptedPhase**: `GamePhase` (Required, authoritative pre-commit phase in which validation succeeded)
- **inputRecordId**: ID (Required)
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

Authoritative game-rule public records. Every ID is a non-empty ASCII identifier of 1-64 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`. The union has six semantic event types; display publication records are a separate append-only log.

`PublicEvent = PublicStatementRecordedEvent | PublicQuestionRecordedEvent | SuspicionExpressedEvent | VoteDeclaredEvent | RoleClaimRecordedEvent | ResultClaimRecordedEvent`, discriminated by `eventType`.

### Common Required Fields (`EventMetadata`)

- **schemaVersion**: integer literal `1`
- **eventId**, **requestId**, **turnId**, **actorId**, **causationId**, **correlationId**, **idempotencyKey**: ID
- **source**: `SemanticEventSource`
- **stateVersion**: integer, minimum `0`
- **occurredPhase**: `GamePhase` (authoritative phase in which the event semantically occurred)
- **createdOrder**: integer, minimum `0`, unique across the event stream

Semantic events never carry direct provenance IDs, `displayPlanId`, or `sourceSpan`; all provenance is exclusively in `source`. Player events use only `PlayerSpeechEventSource`; NPC reaction events use only `NpcReactionEventSource`. Publication records use their own metadata and do not use this source union.

### SemanticEventSource (Strict Union)

`SemanticEventSource = PlayerSpeechEventSource | NpcReactionEventSource`, discriminated by `sourceType`.

- `PlayerSpeechEventSource` requires discriminator `sourceType: "player_accepted_act"`, `acceptedSpeechActId: ID`, `inputRecordId: ID`, and `requestId: ID`.
- `NpcReactionEventSource` requires discriminator `sourceType: "npc_reaction"`, `reactionPlanId: ID`, `descriptorId: ID`, `originatingInputRecordId: ID`, and `reactionCommitRequestId: ID`.

Both have no optional/null fields and `additionalProperties: false`; the fields of the other member are forbidden. Source actor must equal event actor. Player references resolve to one committed player transaction. NPC references resolve to a committed plan and compatible descriptor. One descriptor may create at most one semantic event of each explicitly compatible event type; its idempotency key is `(reactionPlanId, descriptorId, eventType)`. Player and NPC sources are mutually exclusive.

### Individual Event Types

| Type | Discriminator `eventType` | Additional required fields | Optional fields | Forbidden fields |
| :--- | :--- | :--- | :--- | :--- |
| `PublicStatementRecordedEvent` | `public_statement_recorded` | none | none | `displayPlanId`, `sourceSpan`, `targetId`, `topic`, `claimId`, `claimedRole`, `result` |
| `PublicQuestionRecordedEvent` | `public_question_recorded` | `targetId: ID`, `topic: QuestionTopic` | none | `displayPlanId`, `sourceSpan`, `claimId`, `claimedRole`, `result` |
| `SuspicionExpressedEvent` | `suspicion_expressed` | `targetId: ID` | none | `displayPlanId`, `sourceSpan`, `topic`, `claimId`, `claimedRole`, `result` |
| `VoteDeclaredEvent` | `vote_declared` | `targetId: ID` | none | `displayPlanId`, `sourceSpan`, `topic`, `claimId`, `claimedRole`, `result` |
| `RoleClaimRecordedEvent` | `role_claim_recorded` | `claimId: ID` | none | `displayPlanId`, `sourceSpan`, `targetId`, `topic`, `claimedRole`, `result` |
| `ResultClaimRecordedEvent` | `result_claim_recorded` | `claimId: ID` | none | `displayPlanId`, `sourceSpan`, `topic`, `claimedRole`, `result` |

### PlayerUtterancePublishedEvent

This existing schema is retained as the compatibility alias of `PlayerUtterancePublishedRecord` during migration. It requires `schemaVersion: 1`, `publicationId: ID`, discriminator `recordType: "player_utterance_published"`, `requestId: ID`, `correlationId: ID`, `turnId: ID`, `gameStateVersion: integer >= 0`, `occurredPhase: GamePhase`, `actorId: ID`, `inputRecordId: ID`, `displayPlanId: ID`, `idempotencyKey: ID`, `publicationSlotOrder: integer >= 0`, and `recordAppendOrder: integer >= 0`. It has no optional/null fields and `additionalProperties: false`.

Exactly one is created per committed displayable player input, including claim-only, multi-act, question-only, non-game statement, and accepted information-request input. All accepted player inputs in this baseline are displayable; `UninterpretableCandidate` uses clarification. The record is the sole display trigger. It lives in the display log, not `PublicEvent`, and never changes game-rule state/version. Its references resolve to the same player commit. A display plan belongs to exactly one publication. Duplicate replay returns stored results and never displays again.

| Candidate | Accepted act | Semantic event/domain object | Display-owner event |
| :--- | :--- | :--- | :--- |
| statement | `AcceptedNonGameStatement` | `PublicStatementRecordedEvent` | one `PlayerUtterancePublishedEvent` per input |
| question | `AcceptedQuestion` | `PublicQuestionRecordedEvent` | same single owner |
| suspicion | `AcceptedSuspicion` | `SuspicionExpressedEvent` | same single owner |
| vote | `AcceptedVoteDeclaration` | `VoteDeclaredEvent` | same single owner |
| role claim | `AcceptedRoleClaim` | `RoleCanonicalClaim` + `RoleClaimRecordedEvent` | same single owner |
| result claim | `AcceptedResultClaim` | `ResultCanonicalClaim` + `ResultClaimRecordedEvent` | same single owner |
| information request | `AcceptedInformationRequest` | no semantic public event | same single owner |

Semantic events never initiate display. The publication event resolves its `inputRecordId` and `displayPlanId`; the plan then resolves raw ranges from the immutable input and canonical ranges from referenced claims/events through engine-owned renderers.

## 11. `CanonicalClaim` Types (Strict Discriminated Union)

### Claim Metadata
- **schemaVersion**: 1 (Integer, Required)
- **claimId**: String (Required)
- **claimRevision**: Integer (Required, starts at 1)
- **actorId**: String (Required)
- **source**: `ClaimSource` (Required)
- **idempotencyKey**: Sha256Fingerprint (Required, provenance-specific derivation below)
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

## 12. `PlayerInputRecord` and `PlayerUtteranceDisplayPlan`

### PlayerInputRecord
- **schemaVersion**: 1 (Integer, Required)
- **inputRecordId**: ID (Required)
- **requestId**: ID (Required)
- **correlationId**: ID (Required)
- **turnId**: ID (Required)
- **capturedStateVersion**: Integer (Required, minimum 0)
- **actorId**: ID (Required, bound by browser engine)
- **rawText**: String (Required, 1-2000 Unicode scalar values, authoritative player text)
- **locale**: SupportedLocale (Required)
- **createdOrder**: Integer (Required, minimum 0 and unique within session)
- **additionalProperties**: false

### ClaimSource (Strict Union)

`ClaimSource = PlayerAcceptedActClaimSource | NpcReactionClaimSource`, discriminated by `sourceType`.

- `PlayerAcceptedActClaimSource` requires discriminator `sourceType: "player_accepted_act"`, `acceptedSpeechActIds: ID[1..4]`, `inputRecordId: ID`, and `requestId: ID`.
- `NpcReactionClaimSource` requires discriminator `sourceType: "npc_reaction"`, `reactionPlanId: ID`, `descriptorId: ID`, `originatingInputRecordId: ID`, and `reactionCommitRequestId: ID`.

Both members have no optional/null fields and `additionalProperties: false`; cross-member fields are forbidden. Player accepted acts are unique, belong to one player commit/input and actor, and match claim actor. NPC plan and descriptor are committed, descriptor type matches claim type, plan NPC equals claim actor, and originating input caused the reaction. NPC claims never borrow a player accepted-act ID. Both role and result claims use this union.

Claim idempotency uses deterministic canonical JSON with sorted object keys and no display text or locale. Player key is `SHA-256(playerCommitRequestId, sorted acceptedSpeechActIds, actorId, claimKind)`. NPC key is `SHA-256(reactionCommitRequestId, reactionPlanId, descriptorId, actorId, claimKind)`. Equal key and normalized payload returns the existing claim; equal key with different payload is `idempotency_conflict`; replay never creates a new claim ID.

The record is created as an immutable staged value when input is received, before provider work, and is persisted authoritatively only by the atomic commit. Pending state may reference the staged ID. It is separate from prompts and model output. AI never rewrites `rawText` or binds `actorId`. Request, correlation, turn, and captured version must match the pending request; replay reuses the committed record. The raw-text bound exactly matches `InterpreterRequest`.

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

`NpcReactionPlan = CanonicalOnlyReactionPlan | ControlledCommentaryReactionPlan`, discriminated by `renderMode`.

For both members, `originatingInputRecordId` is mandatory and references one committed `PlayerInputRecord`; `locale` is the originating record's `SupportedLocale` and is immutable on replay. The origin ID must equal every derived NPC claim source, event source, pending Renderer, and reservation. `causationEventIds` is auxiliary and contains 0-16 unique game-rule `PublicEvent` IDs committed before `NpcReactionPreparation` begins. Information-request-only input may use `[]`; when semantic events exist, their relevant IDs are normally included. Same-reaction, plan-derived, uncommitted, duplicate, cyclic, and display-log references are forbidden.

### CanonicalOnlyReactionPlan
- **Required**: `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `causationId: ID`, `originatingInputRecordId: ID`, `locale: SupportedLocale`, `causationEventIds: ID[0..16]`, `reactionPlanId: ID`, `turnId: ID`, `resultingStateVersion: integer >= 1`, `npcId: ID`, `renderMode: "canonical_only"`, `intendedSpeechActs: CanonicalSpeechActDescriptor[1..16]`, `policies: ReactionPolicies`, `canonicalSegments: CanonicalSegment[1..16]`, `maxChars: integer 1..1000`
- **Forbidden**: `commentaryPlan`, `allowedVariants`
- **additionalProperties**: false

Every plan containing a state-changing descriptor uses this type. `CanonicalSpeechActDescriptor` is exactly `RoleClaimDescriptor | ResultClaimDescriptor | VoteDeclarationDescriptor | SuspicionDescriptor`; answers, acknowledgements, pondering, declines, clarification, and every other non-state-changing descriptor are forbidden. Its ordered canonical segments completely represent every intended descriptor. It never invokes the Renderer; only the engine-owned canonical renderer displays it.

### ControlledCommentaryReactionPlan
- **Required**: `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `causationId: ID`, `originatingInputRecordId: ID`, `locale: SupportedLocale`, `causationEventIds: ID[0..16]`, `reactionPlanId: ID`, `turnId: ID`, `resultingStateVersion: integer >= 1`, `npcId: ID`, `renderMode: "controlled_commentary"`, `intendedSpeechActs: CommentarySpeechActDescriptor[1..16]`, `policies: ReactionPolicies`, `commentaryPlan: ControlledCommentaryPlan`, `maxChars: integer 1..1000`
- **Forbidden**: `canonicalSegments`
- **additionalProperties**: false

This type prohibits every state-changing descriptor, including `RoleClaimDescriptor`, `ResultClaimDescriptor`, `VoteDeclarationDescriptor`, `SuspicionDescriptor`, and any descriptor that updates suspicion score or memory. It permits only non-authoritative answers, acknowledgements, pondering, declines, and clarification requests. The AI selects only an engine-owned variant ID and version; it does not generate display prose.

### SpeechActDescriptor (Strict Union)
1. **RoleClaimDescriptor**: `{ descriptorId: ID, descriptorType: "role_claim", claimedRole: ClaimableRole, additionalProperties: false }`
2. **ResultClaimDescriptor**: `{ descriptorId: ID, descriptorType: "result_claim", targetId: ID, result: ClaimResult, additionalProperties: false }`
3. **VoteDeclarationDescriptor**: `{ descriptorId: ID, descriptorType: "vote_declaration", targetId: ID, additionalProperties: false }`
4. **SuspicionDescriptor**: `{ descriptorId: ID, descriptorType: "suspicion", targetId: ID, additionalProperties: false }`
5. **AnswerDescriptor**: `{ descriptorId: ID, descriptorType: "answer", topic: QuestionTopic, additionalProperties: false }`

`CommentarySpeechActDescriptor` is the strict union below. Every member is non-nullable and has `additionalProperties: false`.

| Member | Discriminator `descriptorType` | Required fields | Optional fields | Forbidden fields |
| :--- | :--- | :--- | :--- | :--- |
| `AnswerDescriptor` | `answer` | `descriptorId: ID`, `topic: QuestionTopic` | none | `targetId`, `claimedRole`, `result`, mutation fields |
| `AcknowledgementDescriptor` | `acknowledgement` | `descriptorId: ID`, `referenceId: ID` | none | `topic`, `targetId`, `claimedRole`, `result`, mutation fields |
| `PonderingDescriptor` | `pondering` | `descriptorId: ID`, `topic: QuestionTopic` | none | `targetId`, `claimedRole`, `result`, mutation fields |
| `DeclineDescriptor` | `decline` | `descriptorId: ID`, `reason: DeclineReason` | none | `topic`, `targetId`, `claimedRole`, `result`, mutation fields |
| `ClarificationRequestDescriptor` | `clarification_request` | `descriptorId: ID`, `reason: ClarificationReason` | `allowedTargetIds: ID[0..16]` | `topic`, `targetId`, `claimedRole`, `result`, mutation fields |

`referenceId` must exist in the controlled plan's allowed public references. `allowedTargetIds` contains unique IDs present in the public roster. All descriptor strings are IDs or closed enums, so no descriptor contains free-form text.

`ReactionPolicies` is a closed, non-nullable object requiring discriminator `policyType: "reaction_policies"`, `allowStateChanges: boolean`, `allowClaims: boolean`, `allowVoteDeclaration: boolean`, `allowSuspicionUpdate: boolean`, and `allowMemoryUpdate: boolean`. It has no optional fields, forbids every unlisted field, contains no references or length-bearing strings, and sets `additionalProperties: false`. Canonical-only policy booleans must exactly reflect its descriptors. Controlled commentary requires all five values to be `false`.

`ControlledCommentaryPlan` is a closed, non-nullable object requiring `intent: CommentaryIntent` and `allowedPublicReferenceIds: ID[0..32]`; it has no optional fields and `additionalProperties: false`. IDs are unique and must resolve to public projections in the eventual renderer request. This plan is the authoritative owner of the list.

### CanonicalSegment (Strict Union)
1. **NpcCanonicalClaimSegment**: `{ segmentId: ID, descriptorId: ID, type: "canonical_claim", claimId: ID, additionalProperties: false }`
2. **NpcCanonicalVoteSegment**: `{ segmentId: ID, descriptorId: ID, type: "canonical_vote", voteEventId: ID, additionalProperties: false }`
3. **NpcCanonicalSuspicionSegment**: `{ segmentId: ID, descriptorId: ID, type: "canonical_suspicion", suspicionEventId: ID, additionalProperties: false }`

Descriptor IDs are engine-generated, unique within the plan, immutable on replay, and never AI-generated. For every canonical-only plan, descriptors and segments have a one-to-one, order-preserving correspondence by `descriptorId`; referenced claim/event provenance carries that same ID. Dangling IDs are rejected. Controlled commentary uses the same unique-ID rule even though it has no canonical segments.

| Descriptor | Allowed plan | Canonical segment | Display source |
| :--- | :--- | :--- | :--- |
| `RoleClaimDescriptor` | canonical-only | `NpcCanonicalClaimSegment` referencing role claim | engine canonical claim renderer |
| `ResultClaimDescriptor` | canonical-only | `NpcCanonicalClaimSegment` referencing result claim | engine canonical claim renderer |
| `VoteDeclarationDescriptor` | canonical-only | `NpcCanonicalVoteSegment` | engine canonical vote renderer |
| `SuspicionDescriptor` | canonical-only | `NpcCanonicalSuspicionSegment` | engine canonical suspicion renderer |
| answer / acknowledgement / pondering / decline / clarification | controlled-commentary only | none | selected engine-owned registry variant |

## 14. `ControlledCommentaryVariant` Registry

### ControlledCommentaryVariant
- **schemaVersion**: 1 (Integer, Required)
- **variantId**: ID (Required, Max 64 chars)
- **variantVersion**: Integer (Required, Min 1)
- **locale**: SupportedLocale (Required)
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
- **locale**: SupportedLocale (Required)
- **intent**: CommentaryIntent (Required)
- **toneTags**: Array of ToneTag (Required, 0-4 unique items)
- **additionalProperties**: false

### RendererRequest and RendererModelOutput

`RendererRequest` requires `schemaVersion: 1`, `requestId: ID`, `reactionPlanId: ID`, `turnId: ID`, `resultingStateVersion: integer >= 1`, `npcId: ID`, `locale: SupportedLocale`, `renderMode: "controlled_commentary"`, `commentaryPlan: ControlledCommentaryPlan`, `publicEvents: PublicEventProjection[0..64]`, `publicClaims: ClaimProjection[0..64]`, `publicVotes: PublicVoteProjection[0..32]`, `executions: ExecutionProjection[0..16]`, `attackDeaths: AttackDeathProjection[0..16]`, `allowedPublicReferenceIds: ID[0..32]`, and `allowedVariants: AllowedCommentaryVariantProjection[1..8]`; it has no optional fields and `additionalProperties: false`.

Every allowed public reference ID is unique and exists in one of the same request's public projection arrays; private and unknown IDs are prohibited. Projection IDs are globally unambiguous within the request. Allowed variants have unique `(variantId, variantVersion)` pairs, and a request must not contain multiple versions of one `variantId`.

`RendererModelOutput` requires exactly `schemaVersion: 1`, `selectedVariantId: ID`, and `selectedVariantVersion: integer >= 1`, with `additionalProperties: false`. The selected pair must exactly match one allowed variant and an existing enabled registry entry whose locale equals the request locale, render mode is `controlled_commentary`, and intent equals `commentaryPlan.intent`.

Schema-valid example:

```json
{
  "schemaVersion": 1,
  "requestId": "request-1001",
  "reactionPlanId": "reaction-1001",
  "turnId": "turn-7",
  "resultingStateVersion": 12,
  "npcId": "npc-aoi",
  "locale": "ja-JP",
  "renderMode": "controlled_commentary",
  "commentaryPlan": { "intent": "acknowledge", "allowedPublicReferenceIds": ["event-1001"] },
  "publicEvents": [{ "schemaVersion": 1, "projectionType": "public_statement_event", "eventId": "event-1001", "actorId": "player", "turnId": "turn-7", "occurredPhase": "day_discussion" }],
  "publicClaims": [],
  "publicVotes": [],
  "executions": [],
  "attackDeaths": [],
  "allowedPublicReferenceIds": ["event-1001"],
  "allowedVariants": [{ "schemaVersion": 1, "variantId": "ack-brief", "variantVersion": 2, "locale": "ja-JP", "intent": "acknowledge", "toneTags": ["brief"] }]
}
```

### SelectedCommentaryVariant

The persisted selection requires exactly `variantId: ID`, `variantVersion: integer >= 1`, and `locale: SupportedLocale`, with `additionalProperties: false`. Replay resolves this exact registry key and never substitutes the latest version or current UI locale. Disabled or retired variants remain available for historical reconstruction.

## 15. Public Projections (Strict Schemas)

All projection objects require `schemaVersion: 1`, use the closed `projectionType` discriminator below, have no optional or nullable fields, and set `additionalProperties: false`. Every String typed as ID uses the section 10 ID constraint. No projection may contain raw text, private memory, hidden role data, internal suspicion scores, provider diagnostics, or fields not listed in its row. String values other than IDs are limited by their referenced closed enum; no free-form projection text exists.

| Projection | `projectionType` | Other required fields | Forbidden fields (in addition to every unlisted field) |
| :--- | :--- | :--- | :--- |
| `PublicStatementEventProjection` | `public_statement_event` | `eventId: ID`, `actorId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `targetId`, `claimId`, `role`, `result`, `publicStatus` |
| `PublicQuestionEventProjection` | `public_question_event` | `eventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `occurredPhase: GamePhase`, `topic: QuestionTopic` | `claimId`, `role`, `result`, `publicStatus` |
| `SuspicionEventProjection` | `suspicion_event` | `eventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `claimId`, `role`, `result`, `publicStatus`, `score` |
| `VoteEventProjection` | `vote_event` | `eventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `claimId`, `role`, `result`, `publicStatus` |
| `RoleClaimEventProjection` | `role_claim_event` | `eventId: ID`, `actorId: ID`, `claimId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `targetId`, `role`, `result`, `publicStatus` |
| `ResultClaimEventProjection` | `result_claim_event` | `eventId: ID`, `actorId: ID`, `claimId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `targetId`, `role`, `result`, `publicStatus` |
| `RoleClaimProjection` | `role_claim` | `claimId: ID`, `actorId: ID`, `claimedRole: ClaimableRole` | `targetId`, `result`, `occurredPhase`, `publicStatus` |
| `ResultClaimProjection` | `result_claim` | `claimId: ID`, `actorId: ID`, `targetId: ID`, `result: ClaimResult` | `claimedRole`, `occurredPhase`, `publicStatus` |
| `PublicVoteProjection` | `public_vote` | `voteEventId: ID`, `actorId: ID`, `targetId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `claimId`, `role`, `result`, `publicStatus` |
| `ExecutionProjection` | `execution` | `executionEventId: ID`, `executedPlayerId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `actorId`, `targetId`, `claimId`, `role`, `result`, `publicStatus` |
| `AttackDeathProjection` | `attack_death` | `attackEventId: ID`, `attackedPlayerId: ID`, `turnId: ID`, `occurredPhase: GamePhase` | `actorId`, `targetId`, `claimId`, `role`, `result`, `publicStatus` |

`PublicRosterEntry` does not contain `publiclyKnownStatus`; public suspicion is represented only by `SuspicionEventProjection`, preserving both the actor and target. It is derived solely from public events and never from internal suspicion scores or private memory.

Each request array has the maximum shown in `RendererRequest`, rejects duplicate primary IDs, preserves authoritative `createdOrder` (or source order for non-event projections), and rejects references to unknown IDs. Claim-event projections reference an existing same-request claim projection with matching actor and claim type. Public votes reference an existing vote event. Execution and attack-death player IDs reference public roster entries. Stable ordering is retained on replay.

### Projection unions

`PublicEventProjection` is the strict discriminated union `PublicStatementEventProjection | PublicQuestionEventProjection | SuspicionEventProjection | VoteEventProjection | RoleClaimEventProjection | ResultClaimEventProjection`. Its discriminator is `projectionType`; members, required fields, forbidden fields, ID limits, closed enums, nullability, and `additionalProperties: false` are exactly those in the table above. Event and claim references must resolve inside the same request projection graph. Display records are not model-facing public-event projections.

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
- **RenderMode**: `canonical_only`, `controlled_commentary`
- **CommitType**: `player_conversation`, `npc_reaction`
- **PendingStatus**: `pending`, `aborting`, `completed`, `failed`
- **Sha256Fingerprint**: 64 lowercase ASCII hexadecimal characters matching `^[0-9a-f]{64}$`
- **RFC3339Utc**: 20-35 ASCII characters, UTC timestamp ending in `Z`
- **ClientCorrelationId**: ID supplied for browser-domain causality and validated as untrusted input
- **ServerCorrelationId**: ID generated by the server immediately on HTTP receipt, before body parsing
- **LocaleTag**: syntactically valid String, 2-35 ASCII characters matching `^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$`; this accepts language-only tags such as `ja` and `en`
- **SupportedLocale**: closed deployment policy `ja`, `ja-JP`, `en`, `en-US`; requests/registry entries must be both a valid `LocaleTag` and a member of this allowlist

### Phase permission table

All candidate, accepted-act, interpreter-request, public-event, and stale-response checks use `GamePhase` without aliases.

| Phase | Player speech acts accepted | Notes |
| :--- | :--- | :--- |
| `day_discussion` | statements, questions, suspicions, role/result claims, information requests | vote declarations are rejected until `vote` |
| `player_question` | none in the structured pipeline | compatibility-only phase; never represents pending interpretation |
| `npc_response` | none in the structured pipeline | compatibility-only phase; never represents pending rendering |
| `vote` | vote declarations and information requests | claims/questions are rejected |
| `execution` | none | engine transition only |
| `night` | none | engine transition only |
| `seer_action` | none | engine-owned action only |
| `werewolf_attack` | none | engine-owned action only |
| `win_check` | none | engine-owned check only |

## 17. Atomic conversation commits

The structured order is `PlayerConversationCommit -> NpcReactionPreparation -> NpcReactionCommit -> optional Renderer call -> NPC utterance display`. Player and NPC commits are separate atomic transactions with distinct state-version increments.

### PlayerConversationCommit

One player commit contains one immutable `PlayerInputRecord`, `AcceptedSpeechAct[]`, `CanonicalClaim[]`, semantic `PublicEvent[]`, one `PlayerUtteranceDisplayPlan`, exactly one `PlayerUtterancePublishedRecord` (compatibility alias `PlayerUtterancePublishedEvent`), suspicion/memory/history deltas, one idempotency record, and any turn/phase transition. For precondition version N, success produces N+1.

Prepare order is: capture staged immutable input; validate interpretation; bind actor; validate all acts; prepare accepted acts, claims, semantic events, display plan, publication event, and deltas; verify idempotency and state/phase preconditions; then commit. Preparation mutates no authoritative state.

### ConversationCommitDelta

The strict runtime delta requires `schemaVersion: 1`, `commitType: CommitType`, `requestId: ID`, `correlationId: ID`, `turnId: ID`, `preconditionPhase: GamePhase`, `resultingPhase: GamePhase`, `preconditionStateVersion: integer >= 0`, `resultingStateVersion: integer >= 1`, the complete prepared object/delta sets, and `requestFingerprint: Sha256Fingerprint`. It has no optional or nullable fields and `additionalProperties: false`. `resultingStateVersion` must equal precondition plus one.

Immediately before application, the engine rechecks turn, precondition phase/version, request idempotency, referenced IDs, alive/dead conditions, and phase permissions. Failure persists nothing and changes no counter, phase, turn, history, suspicion, memory, or version. Application uses copy-on-write or a reversible delta; exceptions restore the exact snapshot. All acts commit together. `AcceptedSpeechAct.acceptedStateVersion` and `acceptedPhase` store preconditions; claims, events, display plan, and publication store the common resulting version, while events store their semantic `occurredPhase`.

### NpcReactionPreparation

After player success at N+1, the engine prepares without side effects: one `NpcReactionPlan`, any canonical claims and semantic public events, NPC suspicion/memory/public-history deltas, one canonical publication record or controlled-publication reservation, and one reaction idempotency record. The preparation stores turn, `preconditionPhase`, `resultingPhase`, and precondition version N+1.

### NpcReactionCommit

Immediately before commit, the engine requires matching current turn, phase, and N+1 version; an uncommitted reaction request; existing participants and referenced claims/events; valid phase permission; and a living actor when speech requires it. Failure discards preparation. Success atomically applies all reaction objects/deltas and increments N+1 to N+2. The reaction plan, claims, semantic events, and display reservation/immediate canonical record all reference N+2. Partial commit is prohibited and exceptions roll back exactly.

Canonical-only plans display immediately after commit, never call Renderer, and reference only claims/events committed in that same or an earlier transaction. Controlled commentary contains no state-changing claim/event, calls Renderer only after commit, and accepts only an engine-owned variant ID/version. Timeout, abort, or Renderer failure displays a deterministic engine-owned fallback and never rolls back committed NPC state.

### DisplayPublicationRecord (Separate Append-only Display Log)

`DisplayPublicationRecord = PlayerUtterancePublishedRecord | NpcCanonicalUtterancePublishedRecord | NpcUtterancePublicationReserved | NpcUtterancePublicationFinalized`, discriminated by `recordType`. This log is session-authoritative for replay/UI only, is excluded from game-rule `PublicEvent`, and never affects phase, permissions, victory, or game `stateVersion`. `publicationSlotOrder` is allocated once per publication ID and determines conversation position; `recordAppendOrder` is unique/monotonic per appended record and determines audit processing only. A reservation is never rendered as speech. Finalization resolves content into its existing slot, so delay never reorders later utterances; an unresolved slot shows an engine-owned loading indicator until same-session fallback policy finalizes it.

Phase 4 moves player publication into this log while retaining `PlayerUtterancePublishedEvent` as a read-compatibility alias; Phase 9 removes consumers that treat the alias as a game-rule event after replay fixtures are migrated.

`NpcCanonicalUtterancePublishedRecord` requires `schemaVersion: 1`, discriminator `recordType: "npc_canonical_published"`, `publicationId: ID`, `reactionPlanId: ID`, `reactionCommitRequestId: ID`, `originatingInputRecordId: ID`, `correlationId: ID`, `turnId: ID`, `reactionResultingStateVersion: integer >= 1`, `actorId: ID`, `locale: SupportedLocale`, `canonicalRendererVersion: integer >= 1`, `canonicalSegmentIds: ID[1..16]`, `publicationSlotOrder: integer >= 0`, and `recordAppendOrder: integer >= 0`, with no optional/null fields and `additionalProperties: false`. Canonical-only creates this exactly once inside `NpcReactionCommit`. Origin and locale match the plan/input. Replay uses stored locale/renderer version plus segments, never current UI locale; canonical text is not stored.

### NpcUtterancePublicationReserved

Controlled commentary creates exactly one reservation inside `NpcReactionCommit`, after its plan is prepared but in the same atomic commit. The strict record requires `schemaVersion: 1`, discriminator `recordType: "npc_publication_reserved"`, `publicationId: ID`, `reservationId: ID`, `reactionPlanId: ID`, `reactionCommitRequestId: ID`, `originatingInputRecordId: ID`, `correlationId: ID`, `turnId: ID`, `reactionResultingStateVersion: integer >= 1`, `actorId: ID`, `locale: SupportedLocale`, `renderMode: "controlled_commentary"`, `fallbackVariantId: ID`, `fallbackVariantVersion: integer >= 1`, `status: "reserved"`, `publicationSlotOrder: integer >= 0`, and `recordAppendOrder: integer >= 0`; it has no optional/null fields and `additionalProperties: false`.

`publicationId` and slot order are stable for the lifecycle; `reservationId` identifies this append-only record. The fallback registry key is exactly `(fallbackVariantId, fallbackVariantVersion, locale)`. Locale matches plan and originating input. Neither record nor fields are updated, replaced, or deleted.

### NpcUtterancePublicationFinalized

This append-only controlled-commentary record requires `schemaVersion: 1`, discriminator `recordType: "npc_publication_finalized"`, `finalizationId: ID`, `publicationId: ID`, `reservationId: ID`, `reactionPlanId: ID`, `source: FinalizationSource`, `correlationId: ID`, `turnId: ID`, `stateVersion: integer >= 1` (the reaction's already committed resulting version), `actorId: ID`, `locale: SupportedLocale`, `selectedVariantId: ID`, `selectedVariantVersion: integer >= 1`, `finalizationReason: FinalizationReason`, `fallbackUsed: boolean`, `publicationSlotOrder: integer >= 0`, `recordAppendOrder: integer >= 0`, and `createdAt: RFC3339Utc`; it has no optional/null fields and `additionalProperties: false`.

`FinalizationSource` is a versioned strict discriminated-union type. Its baseline member set is exactly `RendererRequestFinalizationSource`, which requires discriminator `sourceType: "renderer_request"` and `rendererRequestId: ID`, forbids recovery fields, and has `additionalProperties: false`. It is used for success, timeout, abort, provider error, and invalid output; at append time the ID resolves to the still-active `PendingRendererRequest` and matches plan, publication, and locale. The embedded source is a self-contained provenance snapshot after validation; replay does not dereference runtime pending state. A future schema version may expand the union to `RendererRequestFinalizationSource | RecoveryFinalizationSource`; the reserved future member would require `sourceType: "session_recovery"`, `recoveryId`, and `recoveredSessionId`, and forbid `rendererRequestId`, but baseline validators reject it.

`FinalizationReason` is the baseline closed enum `renderer_selected | renderer_timeout_fallback | renderer_abort_fallback | renderer_error_fallback | renderer_invalid_output_fallback`. Selected registry key is exactly `(selectedVariantId, selectedVariantVersion, locale)` and matches the reservation. Timeout, abort, provider failure, or invalid output selects the reserved fallback key. Missing exact selected and fallback keys is a design error. Renderer failure never rolls back reaction state.

Finalization is compare-and-set on unfinalized `publicationId`: reservation exists, plan and pending renderer request match, locale matches, and selected triple is allowed. First successful finalizer wins and appends exactly one record. An identical duplicate returns stored result; a different result is conflict. Timeout fallback wins races against late success when it finalizes first; later output is discarded and never changes display.

Required same-session order is: detect success/failure/timeout/abort; validate reservation; append finalization; persist finalization result; mark pending renderer terminal; remove it from active map. Pending is never removed before durable in-session finalization; failed finalization is safely retryable, and its audit-ring copy is never the authoritative source reference.

`NpcPublicationFinalizationResult` requires `schemaVersion: 1`, `publicationId: ID`, `reservationId: ID`, `finalizationId: ID`, `reactionPlanId: ID`, `source: FinalizationSource`, `locale: SupportedLocale`, `selectedVariantId: ID`, `selectedVariantVersion: integer >= 1`, `fallbackUsed: boolean`, `finalizationReason: FinalizationReason`, `publicationSlotOrder: integer >= 0`, `recordAppendOrder: integer >= 0`, and `createdAt: RFC3339Utc`, with no optional fields and `additionalProperties: false`. It exactly mirrors the stored finalization and never references an uncreated record; duplicate finalization returns it.

### Baseline Recovery Scope

Reload/session rehydration recovery is explicitly unsupported in this baseline because no durable game session, display log, reservation, registry-version, or commit-result store exists. Same-session timeout/abort/error paths always finalize fallback before pending removal; page reload/session destruction may discard an unresolved runtime reservation. A future persistence phase is owned by the browser-session/storage subsystem and must persist `gameSessionId`, game-rule state, display log, unresolved reservations, registry version, locale, publication slot allocation, and commit results. Acceptance requires versioned serialization/migration, ordered rehydration, exact registry restoration, corruption/quota handling, multi-tab locking/CAS, fallback finalization, and rollback tests. Until then `RecoveryFinalizationSource` and all recovery-only finalization reasons are rejected by baseline schemas.

### ConversationCommitResult

`ConversationCommitResult = PlayerConversationCommitResult | NpcReactionCommitResult`, discriminated by `commitType`. This persisted strict union is keyed by request ID and fingerprint:

- `PlayerConversationCommitResult` requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `requestFingerprint: Sha256Fingerprint`, discriminator `commitType: "player_conversation"`, `preconditionStateVersion: integer >= 0`, `resultingStateVersion: integer >= 1`, `inputRecordId: ID`, `displayPlanId: ID`, `playerPublicationId: ID`, `createdEventIds: ID[0..64]`, `createdClaimIds: ID[0..4]`, and `createdAtOrder: integer >= 0`.
- `NpcReactionCommitResult = CanonicalNpcReactionCommitResult | ControlledNpcReactionCommitResult`, discriminated by `resultMode`. Both require `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `requestFingerprint: Sha256Fingerprint`, `commitType: "npc_reaction"`, `preconditionStateVersion: integer >= 0`, `resultingStateVersion: integer >= 1`, `reactionPlanId: ID`, `npcPublicationId: ID`, `createdEventIds: ID[0..64]`, `createdClaimIds: ID[0..4]`, and `createdAtOrder: integer >= 0`.
  - `CanonicalNpcReactionCommitResult` requires `resultMode: "canonical_only"` and forbids `reservationId`; `npcPublicationId` targets the immediate canonical record.
  - `ControlledNpcReactionCommitResult` requires `resultMode: "controlled_commentary"` and `reservationId: ID`; `npcPublicationId` targets the same-commit reservation's stable publication ID.

Both have no optional fields and `additionalProperties: false`. NPC result references the canonical record or same-commit reservation, never an uncreated finalization. Finalization result is stored separately. A committed duplicate does not invoke providers, create objects, advance version, or redisplay; it returns original IDs, including the same reservation. Fingerprint mismatch is `idempotency_conflict`.

## 18. Pending conversation request

Provider waiting is runtime control state, not authoritative phase. `PendingConversationRequest = PendingInterpreterRequest | PendingRendererRequest`, discriminated by `pendingType`; both members have no optional/null fields and `additionalProperties: false`.

- `PendingInterpreterRequest` requires `schemaVersion: 1`, `pendingType: "interpreter"`, `requestId: ID`, `correlationId: ID`, `turnId: ID`, `preconditionStateVersion: integer >= 0`, `inputRecordId: ID`, `targetNpcId: ID`, `operation: "interpret_player_input"`, `status: PendingStatus`, and `startedAt: RFC3339Utc`.
- `PendingRendererRequest` requires `schemaVersion: 1`, `pendingType: "renderer"`, a distinct `requestId: ID`, `correlationId: ID`, `causationId: ID`, `turnId: ID`, `resultingStateVersion: integer >= 1`, `reactionPlanId: ID`, `originatingInputRecordId: ID`, `locale: SupportedLocale`, `targetNpcId: ID`, `operation: "render_npc_utterance"`, `status: PendingStatus`, and `startedAt: RFC3339Utc`.

The Interpreter member forbids `resultingStateVersion`, `reactionPlanId`, `originatingInputRecordId`, and `causationId`. The Renderer member forbids `preconditionStateVersion` and `inputRecordId`. This exclusion prevents one version field from acquiring two meanings.

Interpreter pending stores the player precondition version. Renderer pending is created only after `NpcReactionCommit`, stores that committed resulting version, and starts only when it equals current authoritative version. Its originating input and locale exactly equal the reaction plan and RendererRequest. Renderer response validation never compares against the old player precondition. Interpreter and Renderer request IDs are different/session-unique. Renderer `causationId` resolves to the NPC reaction commit result or reaction plan.

The runtime map is keyed by request ID. Active records reject duplicate submission. Interpreter terminal records may be removed after their result/failure is durably handled in session. A controlled Renderer record remains active through reservation validation, finalization append, and finalization-result persistence; only then is it marked terminal, its controller released, and it moved to a bounded developer-only audit ring. Aborted requests use `aborting`, then terminal status after fallback finalization. The audit ring is not an authoritative finalization reference and is discarded on reload/session destruction.

No provider operation changes authoritative phase. Timeout, abort, disconnect, schema/provider failure, or stale discard leaves phase/turn/version unchanged. Responses match the member-specific correlation, turn, operation, status, and version field. Pending-map state, not phase, blocks duplicate input. `player_question` and `npc_response` remain compatibility-only legacy phases and are not accepted-input phases in the structured pipeline; Phase 9 removes their premature-mutation call sites and legacy pending control.

## 19. Alternative acceptance and clarification

`confidence` is diagnostics-only. No threshold, margin, sort order, or "highest confidence" rule may affect acceptance.

- Zero alternatives is an invalid provider response and maps through `ErrorEnvelope`; it is never semantic success.
- Semantic uninterpretable is exactly one alternative containing exactly one `UninterpretableCandidate`. It means provider call and schema validation succeeded and produces clarification.
- Malformed JSON, wrong request/correlation ID, unsupported schema version, timeout, and transport/provider failure never become `UninterpretableCandidate`; they map to `ErrorEnvelope` or stale-response discard.
- Exactly one alternative proceeds to engine validation.
- More than one alternative always produces `ClarificationOutcome`; no state-changing or non-state-changing alternative is auto-selected.
- Every act in the sole alternative is validated as one transaction. Multiple state-changing acts are all-or-nothing, partial acceptance is prohibited, and one invalid act rejects the entire alternative.
- A sole alternative containing only valid non-state-changing acts may be accepted atomically and may create display/public statement events but no state mutation.
- `UninterpretableCandidate` never becomes an `AcceptedSpeechAct`; it produces clarification.

### ClarificationOutcome

This strict schema requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `turnId: ID`, `preconditionStateVersion: integer >= 0`, `reason: ClarificationReason`, `templateId: ClarificationTemplateId`, and `allowedTargetIds: ID[0..16]` with unique items. It has no optional or nullable fields and `additionalProperties: false`. Target IDs must exist in the request's public roster.

The engine discards an outcome whose request/correlation does not match the pending request or whose turn/state version is not current. A clarification creates no accepted act, public event, canonical claim, turn advance, or state-version advance. Display uses only the engine-owned template identified by `templateId`; AI-generated explanation text is prohibited.

## 20. Input Interpreter contract

### Provider interface

```js
interpretPlayerInput(request, { signal })
```

### InterpreterRequest

Required fields are `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `turnId: ID`, `preconditionStateVersion: integer >= 0`, `preconditionPhase: GamePhase`, `locale: SupportedLocale`, `rawText: string[1..2000 code points]`, `playerContext: InterpreterPlayerContext`, `publicRoster: PublicRosterEntry[1..16]`, `allowedCandidateTypes: CandidateType[1..8]`, `publicContext: InterpreterPublicContext`, and `limits: InterpreterLimits`. There are no optional or nullable fields and `additionalProperties: false`.

`InterpreterPlayerContext` requires only `playerId: ID` and `publicStatus: PublicStatus`. `PublicRosterEntry` requires `playerId: ID`, `displayName: string[1..80]`, and `publicStatus: PublicStatus`. `InterpreterPublicContext` requires `publicEvents: PublicEventProjection[0..64]` and `publicClaims: ClaimProjection[0..64]`. `InterpreterLimits` requires `maxAlternatives: integer 1..3`, `maxActsPerAlternative: integer 1..4`, and `maxNestingDepth: integer 1..8`. Each nested type has no optional fields, rejects null, and has `additionalProperties: false`; IDs are unique and references resolve within the request.

`CandidateType` is the closed enum matching the eight candidate discriminators. `allowedCandidateTypes` is derived from the phase permission table. The request never includes private roles, hidden teams, private results, NPC private memory, internal suspicion scores, API credentials, or provider diagnostics.

### Prompt-injection boundary

`rawText`, roster `displayName`, and every public projection value are untrusted data, never instructions. Fixed system/developer instructions and serialized data payloads use separate provider fields or message parts; player/public text is never concatenated into an instruction string. Text such as "ignore the schema" has no authority. The model may select only allowlisted IDs supplied in data and may emit only schema fields. Schema-valid output still requires browser-engine phase, roster, reference, authorization, and atomic-commit validation. Confidence, explanations, and diagnostics never authorize behavior. Injection detection is not implemented with Japanese regexes or other semantic keyword blocks. Public projections are constructed by an explicit allowlist, and private facts never enter the prompt.

### InterpreterModelOutput

The model output is exactly the schema in section 7: structured semantic alternatives only. It contains no correlation envelope, diagnostics, provider metadata, accepted acts, public events, state updates, or display text.

### InterpreterProviderResult

This strict provider-layer schema requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `modelOutput: InterpreterModelOutput`, and `diagnostics: ProviderDiagnostics`; it has no optional or nullable fields and `additionalProperties: false`. `ProviderDiagnostics` is developer-only and requires `providerName: string[1..64]`, `model: string[1..128]`, `attemptCount: integer 1..3`, and `elapsedMs: integer >= 0`, with `additionalProperties: false`. Diagnostics never enter public projections.

### InterpreterHttpResponse

The HTTP success envelope requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ClientCorrelationId`, `serverCorrelationId: ServerCorrelationId`, and `result: InterpreterProviderResult`, with no optional fields, no nulls, and `additionalProperties: false`. Client IDs must equal the validated request and nested provider result; server correlation is transport-owned.

## 21. Renderer contract

### Provider interface

```js
renderNpcUtterance(request, { signal })
```

Canonical-only plans never call this interface. Controlled commentary supplies the `RendererRequest` in section 14, and the model returns only `selectedVariantId` plus `selectedVariantVersion`; raw in-world text is prohibited.

`ControlledCommentaryPlan.allowedPublicReferenceIds` is the authoritative source. `RendererRequest.allowedPublicReferenceIds` is an engine-produced projection copy that must be byte-for-byte equal in order and content; neither server nor provider may independently add, remove, or reorder IDs. Duplicate, private, and unknown IDs are rejected.

### RendererProviderResult

This strict schema requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ID`, `reactionPlanId: ID`, `modelOutput: RendererModelOutput`, and `diagnostics: ProviderDiagnostics`; it has no optional or nullable fields and `additionalProperties: false`. The selected variant pair is validated against the request before return.

### RendererHttpResponse

The HTTP success envelope requires `schemaVersion: 1`, `requestId: ID`, `correlationId: ClientCorrelationId`, `serverCorrelationId: ServerCorrelationId`, `reactionPlanId: ID`, and `result: RendererProviderResult`, with no optional fields, no nulls, and `additionalProperties: false`. Client/domain IDs must match the request and nested result. A stale or mismatched response is discarded without retry or state mutation.

## 22. HTTP endpoint contract

Both endpoints accept only `Content-Type: application/json; charset=utf-8`, reject content encoding, and limit the decoded request body to 64 KiB. Before reading or parsing the body, the server generates a unique `ServerCorrelationId`; it is returned in every success/error response and used in logs. Body `correlationId` is an untrusted `ClientCorrelationId` and never replaces the server ID. The server validates transport schemas and correlation only; it never decides authoritative game state, phase legality, claim permission, or roster membership.

| Endpoint | Request | 200 response |
| :--- | :--- | :--- |
| `POST /api/interpret-player-input` | `InterpreterRequest` | `InterpreterHttpResponse` |
| `POST /api/render-npc-utterance` | `RendererRequest` | `RendererHttpResponse` |

For both endpoints: malformed JSON returns 400 `malformed_json`; schema violations return 400 `invalid_schema`; unsupported `schemaVersion` returns 400 `unsupported_schema_version`; idempotency fingerprint conflict returns 409 `idempotency_conflict`; unsupported media type returns 415; oversized body returns 413; server rate limit returns 429; invalid provider output or provider authentication failure returns 502; unavailable provider returns 503; provider timeout returns 504. Client disconnect aborts body read, provider call, and backoff and sends no new response. The request `AbortSignal` is propagated through the entire chain.

Logs always include `serverCorrelationId` and may include a validated client correlation/request ID, endpoint, status, duration, attempt count, and normalized error code. They must not include raw bodies, raw provider responses, stack traces in client responses, API keys, prompts, private data, variant registry text, or raw player text.

## 23. ErrorEnvelope

`ErrorEnvelope` requires `schemaVersion: 1`, `requestId: ID | null`, `correlationId: ServerCorrelationId`, and `error: ErrorDetail`; it has no optional fields and `additionalProperties: false`. Here `correlationId` is always the server-generated transport ID, including malformed JSON; `requestId` is null when safe extraction is impossible. A parsed client correlation is never trusted as this field. `ErrorDetail` requires `code: ErrorCode` and `retryable: boolean`, has no optional or nullable fields, and sets `additionalProperties: false`. `retryable` means `clientRequestRetryable`, not internal attempt state.

| HTTP | ErrorCode | Retryable |
| :--- | :--- | :--- |
| 400 | `malformed_json`, `invalid_schema`, `unsupported_schema_version` | false |
| 409 | `idempotency_conflict` | false |
| 413 | `body_too_large` | false |
| 415 | `unsupported_media_type` | false |
| 429 | `server_rate_limited` | true only when a usable `Retry-After` fits the deadline |
| 502 | `invalid_provider_response`, `provider_auth_failure` | false |
| 503 | `provider_unavailable` | conditionally true |
| 504 | `provider_timeout` | conditionally true |

The error response contains no message field and never exposes provider bodies, stack traces, credentials, prompts, private data, or raw player text.

## 24. Timeout, retry, and AbortSignal

- Global deadline: 15 seconds from server receipt.
- Maximum attempts: 3 including the first.
- Maximum per-attempt timeout: 5 seconds; actual timeout is `min(5 seconds, remaining deadline)`.
- Backoff before attempts two and three: 1 second, then 2 seconds.
- `minimumAttemptBudget`: 1 second.
- `responseValidationBudget`: 500 milliseconds.
- `maximumRetryAfter`: 2 seconds.
- `requestId`, `correlationId`, `turnId`, and the operation-specific precondition/resulting version remain unchanged across attempts.
- One AbortSignal chain covers HTTP body/request lifecycle, provider call, per-attempt timeout, and backoff; client disconnect aborts the same chain.
- A next attempt starts only when `remaining deadline >= backoff + minimumAttemptBudget + responseValidationBudget`. Its attempt timeout is capped by the remaining deadline after reserved validation budget.
- Provider authentication failure, invalid request/output schema, wrong correlation ID, and stale response are never retried. Stale responses are discarded.
- Only explicitly classified transient network failures, timeouts, and selected provider-unavailable responses may retry; provider 5xx is not automatically transient.
- `Retry-After` is honored only when valid, at most `maximumRetryAfter`, and the wait plus minimum attempt and validation budgets fits the remaining deadline.

`providerInternalRetryable` controls hidden attempts inside one HTTP request; the request ID and idempotency key remain unchanged. `clientRequestRetryable` is the public `ErrorEnvelope.error.retryable`. An exact browser retry of the same logical input reuses `requestId`, `correlationId`, `inputRecordId`, and the stable idempotency key; it is a transport re-attempt, not a new logical request. A user-edited or newly submitted input gets new IDs. Server-internal retry details are never exposed as authorization or state.

## 25. Referential integrity

Targets must exist before the source or be created in the same atomic commit. Dangling references are rejected. Replay never substitutes IDs. Committed history objects are append-only and never physically deleted; cleanup is limited to derived caches and bounded runtime pending-audit records.

| Source object | Reference field | Target object | Cardinality | Creation ordering | Replay rule | Deletion rule |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `PlayerInputRecord` | `requestId` | `ConversationRequestIdentity` / idempotency record | exactly 1 | identity staged before provider; committed together | reuse same request/fingerprint | append-only |
| `AcceptedSpeechAct` | `inputRecordId` | `PlayerInputRecord` | exactly 1 | same player commit | preserve ID | append-only |
| `CanonicalClaim.source` (player) | `acceptedSpeechActIds` | `AcceptedSpeechAct[]` | 1-4 unique | same player commit; same actor/input | preserve ordered IDs; exact duplicate reuses claim | append-only |
| `CanonicalClaim.source` (NPC) | `reactionPlanId` | committed `NpcReactionPlan` | exactly 1 | same NPC commit plan created before claim | preserve ID; duplicate reaction reuses claim | append-only |
| `CanonicalClaim.source` (NPC) | `descriptorId` | plan `intendedSpeechActs[].descriptorId` | exactly 1 | same commit; descriptor prepared first | preserve ID; dangling/conflict rejected | append-only |
| semantic `PublicEvent.source` (player) | `acceptedSpeechActId` | `AcceptedSpeechAct` | exactly 1 | same player commit | preserve ID; exact duplicate reuses event | append-only |
| semantic `PublicEvent.source` (NPC) | `reactionPlanId` | committed `NpcReactionPlan` | exactly 1 | same NPC commit plan prepared first | preserve ID; duplicate reuses event | append-only |
| semantic `PublicEvent.source` (NPC) | `descriptorId` | plan `intendedSpeechActs[].descriptorId` | exactly 1 | same NPC commit | preserve ID; dangling/conflict rejected | append-only |
| reaction `CanonicalSegment` | `descriptorId` | plan `intendedSpeechActs[].descriptorId` | exactly 1 | same NPC commit; order-preserving | preserve ID; dangling/conflict rejected | append-only |
| `PlayerUtterancePublishedRecord` | `inputRecordId` | `PlayerInputRecord` | exactly 1 | same player commit | reuse record | append-only |
| `PlayerUtterancePublishedRecord` | `displayPlanId` | `PlayerUtteranceDisplayPlan` | exactly 1 and target unique | same player commit | never redisplay | append-only |
| `NpcReactionPlan` | `originatingInputRecordId` | committed `PlayerInputRecord` | exactly 1 | before reaction preparation | preserve ID; derived sources must match | append-only |
| `NpcReactionPlan` | `locale` | originating `PlayerInputRecord.locale` | exactly 1 equal | copied during preparation | preserve stored locale | append-only |
| `NpcReactionPlan` | `causationEventIds` | previously committed `PublicEvent` | 0-16 unique | strictly before reaction preparation; same-commit forbidden | preserve IDs; cycles rejected | append-only |
| `PendingRendererRequest` | `originatingInputRecordId` | plan `originatingInputRecordId` | exactly 1 equal | after reaction commit | preserve ID | runtime source removable only after finalization |
| `PendingRendererRequest` | `locale` | `RendererRequest.locale` and reservation locale | exactly 1 equal | after reservation | preserve locale | runtime source removable only after finalization |
| `NpcUtterancePublicationReserved` | `reactionPlanId` | `ControlledCommentaryReactionPlan` | exactly 1 | same NPC commit, plan prepared first | reuse reservation | append-only |
| `NpcUtterancePublicationReserved` | `locale` | plan `locale` | exactly 1 equal | same NPC commit | preserve locale; no UI substitution | append-only |
| `NpcUtterancePublicationFinalized` | `publicationId` | reservation `publicationId` | exactly 1 | later display-log CAS | return stored finalization on duplicate | append-only |
| `NpcUtterancePublicationFinalized` | `reservationId` | reservation `reservationId` | exactly 1 | reservation must preexist | preserve ID; conflict rejected | append-only |
| `NpcUtterancePublicationFinalized` | `locale` | reservation `locale` | exactly 1 equal | reservation preexists | replay exact registry triple | append-only |
| `NpcUtterancePublicationFinalized` | `source.rendererRequestId` | active `PendingRendererRequest` | exactly 1 in baseline | before pending terminal/removal | duplicate returns stored result | runtime target removed only after result persistence |
| `NpcPublicationFinalizationResult` | `finalizationId` | `NpcUtterancePublicationFinalized` | exactly 1 | finalization appended first | exact mirror returned | append-only |
| `PendingRendererRequest` | `reactionPlanId` | committed `ControlledCommentaryReactionPlan` | exactly 1 | after reaction commit | validate same plan/version | runtime record removable; target append-only |
| `PlayerConversationCommitResult` | `playerPublicationId` | `PlayerUtterancePublishedRecord.publicationId` | exactly 1 | same player commit | return original ID | append-only |
| `ControlledNpcReactionCommitResult` | `reservationId` | `NpcUtterancePublicationReserved.reservationId` | exactly 1 | same NPC commit; never finalization | return original ID | append-only |
| `CanonicalClaim` | `idempotencyKey` | provenance-specific canonical derivation | exactly 1 | computed before claim creation | same payload returns existing claim; mismatch conflicts | immutable |

`ConversationRequestIdentity` is the pair `(requestId, requestFingerprint)` stored in the idempotency index; request ID is unique, and a mismatched fingerprint is rejected.

## 26. Migration plan

The first implementation PR is Phase 1 only. It changes no production flow, provider calls, HTTP endpoints, browser integration, state mutation, or regex semantic parsing. Each later phase requires its own review and rollback boundary.

| Phase | Objective | Exact likely existing files | New files | Behavior unchanged | Tests | Rollback / risks / deployment boundary | Removal condition |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1. Pure schemas, validators, canonical renderers | Add side-effect-free schemas, validators, ID helpers, canonical claim/event renderers | `src/validator.mjs`, `src/utteranceGuard.mjs`, `tests/validator.test.mjs`, `tests/utteranceGuard.test.mjs` | likely `src/conversationSchemas.mjs`, `src/canonicalRenderer.mjs`, matching tests | all production paths | schema, Unicode, renderer, idempotency units | independently deployable unused modules behind no call site; revert files; risk is schema drift | none; no old path removed |
| 2. Interpreter transport in shadow mode | Call interpreter without consuming result; add pending runtime request tracking without phase mutation | `src/webServer.mjs`, `src/responseProvider.mjs`, `src/openaiProvider.mjs`, `public/httpResponseProvider.mjs`, tests | interpreter transport tests | authoritative regex path and mutations | HTTP, timeout, abort, privacy, duplicate pending submission | `INTERPRETER_SHADOW_MODE`; disable flag; risk cost/latency | shadow parity and privacy gates pass |
| 3. Candidate validation without authoritative mutation | Validate/log candidates only | `src/gameEngine.mjs`, `src/validator.mjs`, `public/browserApp.mjs`, tests | candidate conversion tests | current response and mutation behavior | candidate, phase, alternative tests | validation-only flag; disable; risk diagnostic divergence | stable shadow metrics |
| 4. AcceptedSpeechAct and PublicEvent | Add `PlayerConversationCommit`, `ClaimSource`/`SemanticEventSource` strict unions, player provenance validation, rollback, CommitResult, and exact player display ownership | `src/gameEngine.mjs`, `src/responseGenerator.mjs`, `public/browserApp.mjs`, tests | event-store/commit-result helper if needed | NPC response provider path | provenance, conversion, rollback, duplicate/fingerprint, phase/version tests | dual-write flag; discard/rollback; provenance compatibility risk | all player claims/events validate one player source and replay atomically |
| 5. Player Claim migration | Move player claims to canonical claim model/rendering | `src/gameEngine.mjs`, `public/browserApp.mjs`, tests | claim registry helper if needed | NPC claims and response generation | relation, display, replay tests | player-claim flag; rollback old rendering; compatibility risk in history | old/new claim parity and replay migration pass |
| 6. NpcReactionPlan | Add originating input, stored locale, empty causation support for information-only reactions, descriptor provenance, past-only causation, atomic commit, and provenance-specific idempotency | `src/responseGenerator.mjs`, `src/gameEngine.mjs`, `src/responseProvider.mjs`, tests | reaction-plan/commit validator if not Phase 1 | existing provider remains selected | origin/locale consistency, empty causation, information-only, cycle, rollback tests | reaction-commit flag; discard/rollback; provenance compatibility risk | every plan traces to one input and works with zero or more prior semantic events |
| 7. Controlled Renderer integration | Add locale propagation, slot/append ordering, baseline Renderer FinalizationSource, pending completion order, fallback finalization, CAS/late rejection, and same-session guarantee | `src/openaiProvider.mjs`, `src/webServer.mjs`, `src/responseProvider.mjs`, `public/httpResponseProvider.mjs`, `public/browserApp.mjs`, tests | display log, variant registry, finalization result tests | canonical-only bypasses Renderer; game state independent; reload recovery deferred | locale triple, ordering, success/failure, races, pending cleanup tests | renderer flag; fallback; risk unresolved reservation on reload | same-session reservations finalize exactly once without game-state mutation |
| 8. Suspicion and memory migration | Move updates behind accepted events | `src/gameEngine.mjs`, `src/responseGenerator.mjs`, tests | none expected | voting/night/win logic | atomic update, rollback, regression tests | per-effect flag; revert to old effect path; risk scoring changes | parity criteria and audit logs pass |
| 9. Obsolete-path removal | Remove old single `displayOrder`, implicit-locale resolution, source-act-only claim key, durable references to runtime pending/audit records, mutable reservation, legacy provenance/phase/direct-text/duplicate-display paths | `src/gameEngine.mjs`, `src/responseGenerator.mjs`, `src/validator.mjs`, `src/utteranceGuard.mjs`, `src/webServer.mjs`, `src/responseProvider.mjs`, `src/openaiProvider.mjs`, `public/browserApp.mjs`, `public/httpResponseProvider.mjs`, `tests/` | none | game rules/public behavior | full suite plus locale/order/idempotency migration fixtures | deploy after flags stable; rollback release; high history risk | split orders and stored locale fully migrated; no runtime-pending persistent reference remains |

The repository has `src/openaiProvider.mjs`; there is no `src/openAIResponseProvider.mjs` or `src/pseudoResponseProvider.mjs` today. Pseudo behavior currently lives in `src/responseProvider.mjs`, so migration plans use actual file names and may split files only in a separately reviewed phase.

## 27. Test strategy

- Schema validation unit tests cover every strict union member, unknown/forbidden fields, closed enums, bounds, nullability, duplicate IDs, and reference integrity.
- Candidate/Accepted/Event conversion tests cover every type and all-or-nothing rejection.
- SourceSpan/display-plan tests use Unicode code points, punctuation ownership, gaps, overlap rejection, compound claims/questions, and replay without reparsing.
- CanonicalClaim rendering tests prove deterministic claim, vote, and suspicion output.
- Duplicate/idempotency and event replay tests prove repeated requests are no-ops and ordering is stable.
- Stale-response tests cover request, correlation, turn, state version, reaction plan, and selected variant mismatches.
- Multiple-alternative tests prove clarification regardless of confidence and no partial mutation.
- Private-projection leak tests reject roles, hidden teams/results, private memory, suspicion scores, prompts, and provider diagnostics.
- Prompt-injection fixtures cover player instructions, roster display-name injection, public-event text injection, schema-ignore instructions, and rejection of generated unknown IDs.
- Controlled-variant tests cover ID/version/locale/intent match, disabled/retired replay, and unknown references.
- HTTP contract tests cover status mappings, 64 KiB, content type, malformed JSON, strict envelopes, and logging redaction.
- Provider timeout/abort tests cover each attempt, backoff, deadline exhaustion, disconnect, and non-retryable failures.
- Migration compatibility tests cover feature flags, dual-read/write boundaries, rollback fixtures, and old history.
- Existing game-progression regression tests continue covering discussion, question, response, vote, execution, night, seer, attack, and win check.
- Atomic tests cover successful commit, prepare failure with unchanged state, exception rollback, multi-act all-or-nothing, renderer failure after commit, and clarification with no commit.
- Display ownership tests cover one publication record for claim-only input, one for multi-act input, and no duplicate display on replay.
- Pending-state tests cover duplicate submission blocking, timeout/abort with unchanged authoritative phase, and stale response with unchanged state.
- Version tests prove Interpreter pending uses precondition version, Renderer pending uses committed resulting version, Renderer is not compared with the old player version, and player/NPC commits increment separately.
- NPC reaction tests prove canonical claims are created only in reaction commit, canonical segments never reference uncommitted claims/events, renderer failure preserves committed state, and one reaction yields exactly one NPC publication.
- Phase tests prove provider pending does not mutate phase, accepted acts record `acceptedPhase`, events record `occurredPhase`, and commit deltas record `resultingPhase`.
- Duplicate tests prove a committed retry returns the stored CommitResult without provider execution or mutation and rejects same request ID with a changed fingerprint.
- Publication tests prove every displayable input has exactly one player publication and replay duplicates neither player nor NPC publication.
- Malformed-JSON tests prove a server-generated correlation ID appears in response/logs while raw body and untrusted client correlation do not.
- Claim-provenance tests require `PlayerAcceptedActClaimSource` for player claims and `NpcReactionClaimSource` for NPC claims; NPC claims cannot borrow player accepted-act provenance.
- NPC event-provenance tests require matching reaction plan/descriptor, reject dangling/wrong-type descriptor IDs, and prove descriptor IDs are engine-generated, immutable, and unique per plan.
- Canonical coverage tests prove segment, claim, and semantic event share the same descriptor ID and preserve descriptor order.
- Causation tests reject uncommitted, display-log, plan-derived, and same-reaction events in `causationEventIds`, including explicit cycle fixtures.
- Display-log tests prove reservation is created in reaction commit and remains immutable, Renderer success appends one finalization, and game-rule `stateVersion` never changes for reservation/finalization.
- Finalization-source tests require `RendererRequestFinalizationSource` for success and same-session timeout/abort/error/invalid-output fallback; baseline rejects `RecoveryFinalizationSource` and recovery-only reason values.
- Pending-order tests prove timeout/abort fallback finalizes and persists result before pending terminal/removal; retries return stored result and late success loses CAS.
- Locale propagation tests prove plan/input/reservation/RendererRequest/PendingRenderer/finalization/result equality and replay lookup by `(variantId, variantVersion, locale)` without UI-locale override.
- Canonical publication tests replay segments using stored locale and renderer version, without stored text.
- Information-only tests produce a valid plan with matching originating input and empty `causationEventIds`.
- Publication-order tests prove stable slot under delayed Renderer, different append orders for reservation/finalization, and that reservation is never rendered.
- Claim-key tests verify player and NPC derivations, descriptor replay reuse, and conflict on equal NPC key with changed payload.
- CAS tests prove identical duplicate finalization returns stored result, conflicting finalization is rejected, and late Renderer success after fallback is ignored.
- Commit-result tests prove NPC result references an existing reservation rather than an uncreated finalization.
- Locale tests accept supported language-only `ja` and `en`, accept supported regional tags, and distinguish syntax validity from the `SupportedLocale` allowlist.
- A repository CI check must reject bidi controls, zero-width characters, and other unapproved default-ignorable Unicode in design/schema sources. Code-block identifiers and enum literals remain ASCII.

## 28. Design invariants

### Nesting depth calculation

Root object depth is 1; each nested object or array adds 1; primitives add none. Limits are request 8, model 5, and HTTP 10.

### Correlation and replay

The engine validates Interpreter responses against `preconditionStateVersion` and Renderer responses against the committed `resultingStateVersion`; both also match request, client correlation, turn, schema, operation, and pending member. Renderer additionally matches `reactionPlanId`. Duplicate committed requests return stored CommitResult; replay uses stored events, display plans, publications, and exact variants without reinterpreting or redisplaying.

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
| **Player utterance publication count** | EXACTLY ONE per committed displayable input |
| **Player utterance display trigger** | ONLY `PlayerUtterancePublishedRecord` (`PlayerUtterancePublishedEvent` compatibility alias) |
| **Accepted-alternative domain mutations** | ATOMIC |
| **Provider wait changes authoritative phase** | PROHIBITED |
| **Candidate spans within an alternative** | PAIRWISE NON-OVERLAPPING |
| **Every intended reaction descriptor** | REPRESENTED EXACTLY ONCE in display output |
| **Renderer failure rolls back committed state** | PROHIBITED |
| **Clarification creates authoritative objects** | PROHIBITED |
| **Interpreter pending version** | PRECONDITION state version |
| **Renderer pending version** | COMMITTED RESULTING state version |
| **Player and NPC commits** | SEPARATE ATOMIC COMMITS |
| **Canonical NPC segment references uncommitted object** | PROHIBITED |
| **NPC utterance publication identity** | EXACTLY ONE per committed reaction; canonical record or controlled lifecycle `publicationId` |
| **AcceptedSpeechAct phase** | STORED AS `acceptedPhase` |
| **PublicEvent phase** | STORED AS `occurredPhase` |
| **Duplicate committed request** | RETURNS ORIGINAL CommitResult, NO MUTATION |
| **Renderer failure rolls back committed NPC state** | PROHIBITED |
| **CanonicalClaim provenance source count** | EXACTLY ONE valid `ClaimSource` |
| **Player/NPC claim provenance** | Player uses accepted acts; NPC uses plan descriptor |
| **NPC semantic event provenance** | COMMITTED reaction plan plus compatible descriptor |
| **Descriptor IDs** | ENGINE-GENERATED, PLAN-UNIQUE, IMMUTABLE |
| **Reaction causation events** | COMMITTED BEFORE reaction preparation only |
| **Publication reservation/finalization** | APPEND-ONLY separate records |
| **Reservation replacement or mutation** | PROHIBITED |
| **Controlled publication finalization count** | EXACTLY ONE |
| **Renderer failure publication behavior** | FINALIZE reserved engine fallback |
| **Late Renderer changes finalized publication** | PROHIBITED |
| **CommitResult references uncreated object** | PROHIBITED |
| **Display lifecycle mutates game-rule state/version** | PROHIBITED |
| **NpcReactionPlan originating input count** | EXACTLY ONE committed `PlayerInputRecord` |
| **Information-only reaction causation count** | ZERO permitted |
| **Controlled variant publication key** | ID + VERSION + STORED LOCALE |
| **Variant replay locale source** | STORED PUBLICATION LOCALE, never current UI locale |
| **Publication slot vs record append order** | DISTINCT SEMANTICS |
| **Reservation rendered as utterance** | PROHIBITED |
| **Timeout/abort pending removal** | AFTER finalization and result persistence |
| **CanonicalClaim idempotency derivation** | SELECTED BY PLAYER/NPC PROVENANCE |
| **Permanent publication dependency on runtime pending state** | PROHIBITED |
| **Reload recovery baseline** | EXPLICITLY UNSUPPORTED; future persistence phase required |
