# NPC Authoritative State Integration Decision

Status: Accepted
Date: 2026-07-18

## Context

Phase 6 currently has two intentionally isolated representations that cannot yet be connected safely:

- `WerewolfGame.state` is the one live, in-memory authoritative game state. It owns session, turn, phase, version, players, gameplay state, and the Phase 4/5 conversation registries.
- `commitNpcReactionAuthoritatively()` accepts a detached commit-oriented state containing a strict participant projection and the complete canonical conversation graph required by an NPC reaction commit. Its returned `replacementState` has that commit-oriented shape.

The live state stores NPCs with `id`, role/private game fields, and no stored `participantClass` or `maySpeak`. The commit primitive requires participants with `participantId`, `participantClass`, `alive`, and `maySpeak`. The live conversation root also does not yet initialize `reactionPlans` or `npcReactionCommitIdempotencyRecords`, although the commit primitive requires both.

Passing the commit replacement directly to the route or replacing the live game root with it would discard unrelated game fields and private state. Giving the route a generic read/compare-and-swap interface would instead make the route an authority owner. Neither is permitted.

## Decision

`WerewolfGame.state` remains the sole canonical authoritative state. The commit-oriented state is a detached, nonauthoritative transaction projection created and consumed only inside one synchronous `WerewolfGame` transaction.

The structured route receives no live state, generic revision, generic replacement state, or partial-merge capability. It may call only an engine-owned narrow read operation and an engine-owned atomic NPC commit operation:

```text
readNpcStructuredReactionSnapshot(input)
commitPreparedNpcReactionAtomically(input)
```

The first operation returns a detached, recursively frozen, minimum structured-reaction snapshot. The second performs the complete working-copy/projection/commit/delta-validation/final-replacement transaction. A successful NPC commit advances the live version exactly once. Rejection, replay, conflict, and invariant failure publish nothing.

## Canonical ownership

| Domain | Canonical owner | Other representations |
| --- | --- | --- |
| Session, turn, phase, version | `WerewolfGame.state` | Read-only detached projections |
| NPC roster and private player state | `WerewolfGame.state.players` | Minimum participant and known-information projections |
| Human player identity | Engine-owned literal `"player"` used by existing conversation contracts | One derived public/commit participant entry; never a stored second player |
| Structured conversation artifacts | `WerewolfGame.state.conversation` | Commit transaction projection |
| Reaction control lifecycle | `NpcReactionCoordinatorControlRoot` | Nonauthoritative and session-local |
| Candidate/provider/preparation values | Owning runtime stage | Nonauthoritative and discarded at lifecycle end |
| Delivery, receipt, retry, acknowledgement | `NpcPublicationDeliveryController` | Nonauthoritative; version delta zero |

There is no second authoritative structured state, participant registry, NPC-only publication ledger, or alternate state-version owner.

## Observed state inventories

### Current `WerewolfGame.state`

The baseline initializes exactly these top-level concerns:

```text
gameSessionId, turnId, turnOrder, stateVersion, day, phase,
players, alivePlayers, deadPlayers, publicInfo, voteHistory, winner,
playerLog, developerLog, conversation, rng, config
```

Each stored NPC player currently owns:

```text
id, name, aliases, personality, speechStyle, role, team, alive,
knownInfo, hiddenInfo, suspicionScores, publicClaims, privateMemory,
voteHistory, conversationPolicy
```

The current conversation root initializes:

```text
inputRecords, acceptedSpeechActs, claims, events, displayPlans,
publications, playerLegacyDisplayCompatibilityRecords, commitResults,
idempotencyRecords, nextCreatedOrder, nextPublicationSlotOrder,
nextRecordAppendOrder
```

`_workingCopy()` clones this root, and `commitState(target, source)` is the existing final replacement primitive. It preserves current player object identities while replacing their contents and replaces the remaining state only after preparing all values.

Current authoritative publication sites are engine-owned: the compatibility command path sets `precondition + 1` before `commitState`; the Phase 4 player path validates its detached working graph and publishes `N + 1`; and the still-legacy provisional NPC response path publishes `N + 2`. No current production call site imports `commitNpcReactionAuthoritatively()`. The new architecture replaces none of those paths in this docs-only change.

### Current Authoritative Commit transaction state

The pure commit requires these top-level values:

```text
gameSessionId, turnId, turnOrder, stateVersion, phase, players, conversation
```

It requires participant entries containing:

```text
participantId, participantClass, alive, maySpeak
```

It requires these conversation arrays and counters:

```text
inputRecords, acceptedSpeechActs, claims, events, displayPlans,
reactionPlans, publications, commitResults,
npcReactionCommitIdempotencyRecords,
nextCreatedOrder, nextPublicationSlotOrder, nextRecordAppendOrder
```

The current isolated runtime entrypoint accepts exactly `schemaVersion`, `currentState`, `preparedReaction`, `preCommitReferenceContext`, `coordinatorRoot`, and `liveValidationContext`. Its prepared binding owns exactly `gameSessionId`, `reactionPlanId`, `successfulAttemptId`, `requestId`, `requestFingerprint`, `correlationId`, `causationId`, `originatingInputRecordId`, `turnId`, `turnOrder`, `preconditionPhase`, `preconditionStateVersion`, and `npcId`.

A successful new commit contains `schemaVersion`, `status: "committed"`, the detached replacement transaction projection, one canonical result, and one cleanup handoff. The result owns exactly:

```text
schemaVersion, requestId, correlationId, requestFingerprint, commitType,
preconditionStateVersion, resultingStateVersion, reactionPlanId,
npcPublicationId, createdEventIds, createdClaimIds, createdAtOrder,
resultMode
```

The cleanup handoff owns exactly:

```text
schemaVersion, gameSessionId, reactionPlanId, successfulAttemptId,
preparationFingerprint, npcPublicationId, commitResultRequestId
```

The replacement has the same transaction-projection shape as `currentState`, with only the closed commit delta applied. Replay depends on `npcReactionCommitIdempotencyRecords`, complete committed-graph validation, and the shared `commitResults` registry; it returns only the stored commit result. Rejection returns a closed redacted classification. This six-field pure-primitive input is internal to the future engine transaction and is distinct from the narrow engine authority-port input below.

## Schema gap and mapping

| Concern | Current `WerewolfGame` owner/path | Current Commit owner/path | Mismatch | Adopted canonical owner | Projection/translation rule | Write permission | Version effect | Implementation slice |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `gameSessionId` | `state.gameSessionId` | transaction root and binding | None in meaning | `WerewolfGame.state` | Exact copy and equality check | Engine construction/reset only | No commit-specific delta | 2/3 |
| `stateVersion` | `state.stateVersion` | transaction root, binding, delta, result | Commit replacement is not a game root | `WerewolfGame.state` | Copy precondition into projection; accept only exact `N + 1` output | Atomic port only | Exactly `+1` on committed | 2/3 |
| `phase` | `state.phase` | transaction root and delta | Commit writes the same allowed resulting phase | `WerewolfGame.state` | Require replacement phase byte-equal to current phase; translator does not write it in initial Phase 6 | Existing commands only | Zero in NPC utterance commit | 2/3 |
| `turnId` | `state.turnId` | root/binding/plan | None in meaning | `WerewolfGame.state` | Exact copy and equality check | Existing engine turn lifecycle | Zero | 2/3 |
| `turnOrder` | `state.turnOrder` | root/binding/idempotency record | Plan does not own it | `WerewolfGame.state` | Exact copy into binding and idempotency evidence only | Existing engine turn lifecycle | Zero | 2/3 |
| Players/participants | `state.players` plus implicit human identity `"player"` | transaction `players` | Different representation and human storage model | `state.players`; implicit human remains engine-owned | Build a fresh minimum participant array; never persist it | Projection builder read-only | Zero | 2 |
| `participantId` | NPC `player.id`; human literal `"player"` | `participant.participantId` | Name differs | Existing NPC `id` and engine human identity | NPC `participantId = player.id`; human entry uses `"player"` | Projection only | Zero | 2 |
| `participantClass` | Membership rule: every `state.players` member is an NPC; human is implicit | `participant.participantClass` | Not stored | Engine classification rule | NPC members map to `"npc"`; implicit human maps to `"player"` | Projection only | Zero | 2 |
| `alive` | NPC `player.alive`; human session actor is present while the game exists | `participant.alive` | Human is not stored as a player object | Existing game lifecycle | Exact NPC boolean; human entry is alive for the current session conversation contract | Projection only | Zero | 2 |
| `maySpeak` | Derived by current game rules | `participant.maySpeak` | Not stored | `WerewolfGame` rules | For the baseline NPC path, derive `player.alive && state.winner === null`; phase is checked separately as commit applicability. No independent mute field exists, and no mirror boolean is persisted | Projection only | Zero | 2 |
| Public information | `state.publicInfo` and canonical public conversation graph | Preparation/live projections | Different purpose | Existing game and conversation fields | Project only contracted public facts | Existing engine commands | Zero for initial NPC commit | 2/3 |
| Actor-known information | NPC `knownInfo`, role/policy-owned private facts | Known-information/preparation authorization projections | Commit state intentionally omits private source data | `state.players` actor-owned fields | Build minimum local projections; never return them through public route results | Read-only projection | Zero | 2/3 |
| `reactionPlans` | Missing from current `state.conversation` | Required canonical registry | Canonical field absent | `state.conversation.reactionPlans` | Initialize empty; append exactly one plan on a new commit | Atomic port only | Included in the one increment | 1/3 |
| `npcReactionCommitIdempotencyRecords` | Missing from current `state.conversation` | Required canonical registry | Canonical field absent | `state.conversation.npcReactionCommitIdempotencyRecords` | Initialize empty; append exactly one record on a new commit | Atomic port only | Included in the one increment | 1/3 |
| Commit results | `state.conversation.commitResults` | Same shared registry | Existing registry is shared | Existing shared registry | Preserve prefix; append one NPC result | Atomic port and existing player commit | Included in the one increment | 2/3 |
| Claims | `state.conversation.claims` | Same canonical registry | None | Existing shared registry | Preserve prefix; append prepared `0..4` NPC claims | Atomic port and existing player commit | Included in the one increment | 2/3 |
| Semantic events | `state.conversation.events` | Same canonical registry | None | Existing shared registry | Preserve prefix; append one event per proposal | Atomic port and existing player commit | Included in the one increment | 2/3 |
| Canonical segments | Stored inside appended `NpcReactionPlan.canonicalSegments` | `delta.plan.canonicalSegments` | No separate registry exists or is needed | The canonical reaction plan | Validate as part of the one appended plan; do not create a segment registry | Atomic port only through plan append | Included in the one increment | 2/3 |
| Publications | `state.conversation.publications` | Same shared ledger | None | Existing shared registry | Preserve prefix; append one canonical NPC publication | Atomic port and existing player commit | Included in the one increment | 2/3 |
| `nextCreatedOrder` | `state.conversation.nextCreatedOrder` | order reservation | Existing shared counter | Existing counter | Apply exact prepared resulting value after dense-order validation | Atomic port and existing player commit | Included in the one increment | 2/3 |
| `nextPublicationSlotOrder` | Existing conversation counter | Same counter | None | Existing shared counter | Exact `+1` for the one new publication | Atomic port and existing player commit | Included in the one increment | 2/3 |
| `nextRecordAppendOrder` | Existing conversation counter | Same counter | None | Existing shared counter | Exact `+1` for the one appended publication record | Atomic port and existing player commit | Included in the one increment | 2/3 |
| Legacy conversation logs | `state.playerLog`, `state.publicInfo`, legacy compatibility registry | Not an NPC commit output | Commit projection does not own them | Existing live state | Exclude from commit projection and require byte-equivalent preservation | No NPC commit write | Zero | 2/3 |
| Coordinator root | Separate `NpcReactionCoordinatorControlRoot` | Commit input evidence | Nonauthoritative by design | Coordinator | Pass validated detached evidence; never store in game state | Coordinator only | Zero | 3/4 |
| Delivery state | Separate delivery controller | Not a commit input/output | Nonauthoritative by design | Delivery controller | Discover only after authoritative publication | Delivery controller only | Zero | 5 |

## Commit transaction projection

The projection is constructed from a detached `WerewolfGame` working copy after session/version validation. It is not retained, exposed to the provider, returned to the route, used as a second replay root, or written to the game state.

It contains the commit-required session/turn/version/phase fields, the derived minimum participant array, and the canonical conversation fields needed by the pure commit validator. Existing unrelated game fields remain only on the working game copy.

The initial integration preserves the existing pure Commit API. The engine adapter validates its replacement transaction projection and extracts an allowlisted delta. A later versioned pure Commit API may return that validated delta directly, but may never receive or return a live-state replacement capability.

## Narrow engine authority port

### `readNpcStructuredReactionSnapshot(input)`

The input is exact:

```text
schemaVersion: 1
gameSessionId: ID
triggerRequestId: ID
originatingInputRecordId: ID
```

The two trigger fields are lookup identity copied from the committed player transaction, not caller authority over current state. The caller cannot supply a target NPC, state version, turn, phase, eligibility, policy, or registry value.

The synchronous result is exact `NpcStructuredReactionAuthoritySnapshot` with these fields:

```text
schemaVersion: 1
snapshotType: "npc_structured_reaction_authority"
gameSessionId: ID
turnId: ID
turnOrder: non-negative safe integer
currentPhase: GamePhase
stateVersion: non-negative safe integer
triggeringCommitResult: PlayerConversationCommitResult
originatingInputRecord: ConversationInputRecord
triggeringEvents: PublicEvent[]
targetNpcId: ID
knownInformationProjection: NpcKnownInformationProjection
currentRoster: NpcPreparationRosterEntry[]
actorApplicability: NpcPreparationActorApplicability
currentAuthorization: NpcReactionPreparationAuthorization
currentTargetIds: unique ID[]
existingClaims: CanonicalClaim[]
existingEvents: PublicEvent[]
nextOrderEvidence: NpcReactionNextOrderEvidence
occupiedArtifactIds: unique ID[]
publicParticipantsById: exact CanonicalRenderingContext participant index
committedReplay: NpcStructuredReactionReplayLookupResult
```

`NpcStructuredReactionReplayLookupResult` is a strict union of `not_found`, `replayed`, and `conflict`. `replayed` contains only the detached stored NPC commit result and its strict logical identity after complete-graph validation; `conflict` contains only a closed redacted code. The other snapshot members are still validated so a `not_found` value is sufficient for a new route without another broad state read. A historical exact replay may be returned even when the current turn/phase differs; replay classification precedes current applicability.

The result is detached and recursively frozen and contains only the authoritative evidence required for one identified trigger, replay lookup, known-information projection, candidate live validation, preparation, and rendering context construction. It has no live object reference, mutable revision, replacement capability, delivery capability, or unrelated private player data.

The caller cannot supply or override state version, turn, phase, target identity, target eligibility, participant status, policy, result facts, registries, or counters. The engine resolves the target from the exact committed trigger graph and builds all current values from its state. A missing, duplicate, or contradictory trigger graph fails closed rather than falling back to text, display order, or current UI selection.

The audit found no authoritative mutation that deliberately preserves `stateVersion`: top-level command publication and structured player/NPC publication use versioned replacement, while Coordinator and delivery state are nonauthoritative. Therefore the structured route does not receive an opaque revision. The expected `stateVersion` is the atomic commit precondition.

### `commitPreparedNpcReactionAtomically(input)`

The input is exact and contains:

```text
schemaVersion: 1
gameSessionId: ID
expectedStateVersion: non-negative safe integer
preparedReaction: PreparedCanonicalNpcReaction
coordinatorRoot: detached strict Coordinator evidence
preCommitReferenceContext: strict pre-commit context
```

These are the exact six fields; there are no optional, nullable, accessor, symbol, or additional members. Current live-validation evidence is rebuilt inside the engine from the prepared reaction's binding and current working game state. The port never accepts caller-owned current participant, policy, registry, counter, or replacement values.

Closed outcomes are `committed`, `replayed`, `rejected`, and `conflict`; invariant failures throw a fixed redacted engine error. The route never receives a replacement transaction projection.

## Atomic transaction

`commitPreparedNpcReactionAtomically()` performs these steps synchronously without provider, timer, observer, delivery, or event-loop yield:

1. Validate exact input and live session identity.
2. Compare `expectedStateVersion` with live `state.stateVersion`; mismatch returns `conflict` before the pure Commit call.
3. Create a detached `_workingCopy()` using the existing clone path.
4. Validate complete current game invariants and the canonical conversation graph.
5. Build the strict Commit transaction projection from the working copy.
6. Rebuild and validate current actor, target, reference, policy, and result-fact evidence.
7. Call `commitNpcReactionAuthoritatively()` exactly once.
8. Strictly validate its rejected, replayed, or committed result.
9. Return rejection with live mutation zero.
10. Return replay with live mutation zero.
11. For committed output, validate the complete replacement transaction projection.
12. Compare input and replacement projections and extract only the authorized delta below.
13. Apply that delta to the detached working game state.
14. Prove all non-allowlisted game paths byte-equivalent to the live precondition state.
15. Validate canonical counters, complete committed graph, player Phase 4/5 graph, and complete working game invariants.
16. Require working `stateVersion === live stateVersion + 1`.
17. Invoke the existing final state replacement primitive exactly once.
18. Return a detached, recursively frozen commit result and cleanup handoff. No fallible work follows replacement.

Step 12 is a strict schema translation, not object spreading, patch application, generic merge, or caller-selected path update.

## Authoritative delta allowlist

For one new initial Phase 6 canonical NPC reaction, only these paths may differ:

```text
state.stateVersion                                      exact +1
state.conversation.reactionPlans                        append exactly 1
state.conversation.claims                               append prepared 0..4
state.conversation.events                               append exactly proposal count
state.conversation.publications                         append exactly 1
state.conversation.npcReactionCommitIdempotencyRecords append exactly 1
state.conversation.commitResults                        append exactly 1
state.conversation.nextCreatedOrder                     exact prepared result
state.conversation.nextPublicationSlotOrder             exact +1
state.conversation.nextRecordAppendOrder                exact +1
```

Canonical segments change only as members of the one appended reaction plan. There is no independent segment registry.

Every existing registry prefix must be byte-equivalent. The following paths are forbidden from changing:

```text
gameSessionId, turnId, turnOrder, day, phase,
players and every identity/role/team/alive/private/public gameplay field,
alivePlayers, deadPlayers, votes, seer results, night actions, winner,
publicInfo, voteHistory, playerLog, developerLog, rng, config,
conversation.inputRecords,
conversation.acceptedSpeechActs,
conversation.displayPlans,
conversation.playerLegacyDisplayCompatibilityRecords,
conversation.idempotencyRecords,
all existing claims, events, publications, commit results, plans, and NPC idempotency records,
provider diagnostics, Coordinator state, and delivery state
```

Initial Phase 6 prepared zero-effects also prohibit suspicion, memory, legacy history, vote, phase, and other gameplay-effect changes.

## Operation authority boundary

| Operation | Owner | Reads live authority | Writes live authority | Version delta | Provider | Commit | Delivery | Replay behavior |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Read structured reaction snapshot | `WerewolfGame` narrow port | Yes | No | 0 | No | No | No | May expose detached complete-graph replay evidence |
| Provider attempt | Structured route/provider adapter | No live reference | No | 0 | Once per explicit attempt | No | No | Not run for pre-provider replay |
| Candidate validation | Pure validator | Detached evidence | No | 0 | No | No | No | Not run for replay |
| Preparation | Pure preparation module | Detached evidence | No | 0 | No | No | No | Not run for replay |
| Atomic NPC commit | `WerewolfGame` narrow port | Yes | On committed only | `+1` or `0` | No | Exactly once on new path | No | Complete replay returns mutation-free |
| Coordinator cleanup | Coordinator/route | No authoritative write | No | 0 | No | No | No | Exact replay does not implicitly clean |
| Cleanup retry | Coordinator | Reads committed-graph evidence only | No | 0 | No | No | No | Idempotent control-root cleanup |
| Delivery discovery | Delivery controller | Detached committed publications | No | 0 | No | No | Yes | History/commit replay does not deliver |
| Sink delivery | Browser/CLI sink wrapper | No | No | 0 | No | No | Yes | Explicit controller retry only |
| Receipt lookup | Delivery controller | No | No | 0 | No | No | Yes | Exact retained receipt only |
| Acknowledgement | Delivery controller | No | No | 0 | No | No | Yes | Duplicate/stale handling is nonauthoritative |
| History projection | History reader | Detached canonical graph | No | 0 | No | No | No | Read-only and never triggers delivery |
| Reset | `WerewolfGame` plus separate controller invalidation | Replaces whole session | New session construction | Not an in-session commit delta | No hidden retry | No | Invalidates old delivery | Old callbacks/replay bindings fail closed |

## Version, conflict, and failure semantics

- **Committed:** one final live replacement, exact `N -> N+1`, the complete prior player graph retained, one NPC graph published, cleanup and delivery still pending outside the transaction.
- **Replayed:** a complete stored NPC graph is validated and its detached result returned; live mutation and version delta are zero. The pre-provider replay path performs no provider, validation, preparation, new commit, cleanup, or delivery.
- **Rejected:** live mutation and version delta are zero.
- **Conflict:** `expectedStateVersion !== live stateVersion`; the pure Commit call count is zero, automatic retry is zero, and live mutation/version delta are zero.
- **Invariant failure:** malformed engine input or corrupt working/projection/delta/graph evidence throws one fixed redacted error before publication. No raw state, private fact, provider value, candidate, fingerprint, path, cause, or stack is retained in a public result.

All fallible validation, translation, and comparison precedes final replacement. The final replacement primitive must either publish the fully validated working state once or throw before publication. No operation capable of throwing is placed after successful replacement. Observer, cleanup, and delivery run afterward as separate nonauthoritative operations and cannot roll back the committed graph.

## Failure atomicity

| Injection point | Live publications added | Version delta | Outcome | Cleanup needed | Retry |
| --- | ---: | ---: | --- | --- | --- |
| Before working copy | 0 | 0 | Redacted invariant | No | Only a new explicit valid invocation |
| Working-copy clone failure | 0 | 0 | Redacted invariant | No | Same |
| Projection build failure | 0 | 0 | Redacted invariant | No | Same |
| Applicability failure | 0 | 0 | Closed rejection | Coordinator terminalization only | No automatic commit retry |
| Pure Commit rejection | 0 | 0 | Closed rejection | Coordinator terminalization only | No automatic commit retry |
| Pure Commit invariant | 0 | 0 | Redacted invariant | No authoritative cleanup | No automatic retry |
| Replacement projection validation failure | 0 | 0 | Redacted invariant | No | No automatic retry |
| Delta extraction failure | 0 | 0 | Redacted invariant | No | No automatic retry |
| Delta allowlist violation | 0 | 0 | Redacted invariant | No | No automatic retry |
| Counter mismatch | 0 | 0 | Redacted invariant | No | No automatic retry |
| Working game validation failure | 0 | 0 | Redacted invariant | No | No automatic retry |
| Final state replacement failure | 0 | 0 | Redacted invariant | No | Only after explicit caller recovery |
| After final replacement | 1 | `+1` | Committed result | Coordinator cleanup may remain pending | Commit retry forbidden; exact replay allowed |

“After final replacement” is not a failure injection point: no fallible transaction work exists there.

## Replay, cleanup, and delivery

The complete authoritative committed graph, not a Coordinator tombstone, is replay authority. Replay remains valid before cleanup, while cleanup is pending, after cleanup, and after tombstone eviction.

Coordinator cleanup is a separate nonauthoritative root transaction. Cleanup failure never rolls back the authoritative graph. The cleanup handoff is runtime-private and is not persisted in `WerewolfGame.state`; pending cleanup is derived from the committed graph and the unchanged old Coordinator root under the existing contract.

Delivery Controller state, browser/CLI sink state, receipt, retry token, and acknowledgement remain nonauthoritative. The authority port has no delivery method, and delivery never changes `stateVersion`.

## Initialization and lifecycle

Slice 1 adds these exact empty arrays to every new session:

```text
state.conversation.reactionPlans
state.conversation.npcReactionCommitIdempotencyRecords
```

The same slice updates constructor/new-session initialization, working-copy cloning expectations, complete state validation, test fixture builders, deep-equality assertions, and samples. The fields remain excluded from `getPublicSnapshot()`. Developer snapshot policy remains explicit: current developer snapshots do not expose the conversation root, so the new registries are not added merely because they exist.

Reset/new game constructs a fresh session with empty registries. `destroy()` invalidates runtime controllers but does not migrate or reuse state. Sessions are memory-only; disk migration is out of scope. An old-shape in-memory state is not lazily upgraded: strict validation fails closed, and fixtures are explicitly migrated in the implementation PR.

## Privacy

The structured-reaction snapshot is not a provider request. It contains only the authority evidence needed by the route. The provider receives the existing narrower known-information projection.

Neither authority operation returns a live state reference, working copy, generic revision mutator, replacement projection, private knowledge of another NPC, server secret, delivery capability, DOM/CLI handle, or unrestricted registry. Public results, observations, and errors contain no raw snapshot, projection, prepared delta, fingerprint, or cause.

## Alternatives rejected

### Route-owned generic CAS adapter

Rejected because it leaks private engine authority, grants an overly broad replacement capability, pushes schema translation into the route, permits authority bypass by future callers, and makes post-publication failure harder to prove impossible.

### Second authoritative structured state

Rejected because it creates split-brain versions, replay disagreement, participant divergence, reset/migration complexity, and ambiguous delivery authority.

### Whole replacement with Commit `replacementState`

Rejected because the transaction projection is not the game root and would lose unrelated gameplay, private player, RNG, configuration, and legacy graph fields.

### Route-side partial merge

Rejected because it makes the route an authority owner, creates TOCTOU and rollback ambiguity, and allows merge-policy or allowlist bypass.

### Persisted duplicate participant registry

Rejected because it permits identity, alive/speech, role/privacy, and lifecycle drift and adds unnecessary migration burden.

### Direct mutation by the pure Commit module

Rejected because it would destroy the pure browser-safe primitive, couple it to `WerewolfGame`, reduce testability, and risk module dependency cycles.

## Consequences

The chosen design requires an engine adapter, bidirectional validation between game and transaction representations, two new canonical conversation arrays, and extensive atomicity tests. It is larger than exposing a generic CAS. In return, it preserves one authority owner, keeps the pure Commit primitive reusable, prevents route-owned mutation, makes the delta allowlist auditable, and gives replay, cleanup, and delivery one unambiguous source of truth.

## Implementation slices

### Slice 1 — Canonical state foundation

Baseline: this decision after merge. Add the two canonical conversation registries, strict initialization and state validation, and update clone/reset/fixtures. Do not add route, provider work, projection, or NPC commit publication. State-version behavior remains unchanged.

### Slice 2 — Projection and delta translator

Baseline: Slice 1 merge. Add pure game-state-to-Commit projection and replacement-projection-to-authorized-delta translation, participant mapping, complete allowlist validation, privacy tests, and mismatch failure tests. It performs no live mutation.

### Slice 3 — Engine-owned authority port

Baseline: Slice 2 merge. Add the narrow read and atomic commit operations, existing working-copy transaction integration, expected-version conflict handling, pure Commit invocation, complete validation, and one final replacement. The route remains unconnected. Tests prove exact `N -> N+1`, zero-delta failure/replay/conflict, and no throw after publication.

### Slice 4 — Structured Route orchestration

Baseline: Slice 3 merge. Recreate the Structured Route Goal using the narrow port; implement Coordinator, provider attempts/deadline, validation, preparation, commit invocation, and cleanup. Generic CAS and production UI wiring remain out of scope.

The accepted runtime correction is a strict read result union: authoritative `replayed` and `conflict` outcomes terminate before any current projection, ID allocation, Coordinator mutation, Provider call, or timer; only the current-applicable authority snapshot enters new planning. The original pre-Slice-3 Structured Route Goal remains a historical BLOCKED record and is superseded, not resumed, by the rewritten Slice 4 Goal.

### Slice 5 — Delivery orchestration

Baseline: Slice 4 merge. Add explicit delivery pump, retry, receipt, and acknowledgement orchestration without authoritative writes.

### Slice 6 — Replay and production integration

Baseline: Slice 5 merge. Complete history/replay separation, feature cutover, legacy suppression, and browser/CLI integration under a separately approved Goal.

Slices merge in order. Structured Route implementation remains blocked until Slices 1, 2, and 3 are merged.

## Test obligations

Slice tests must collectively prove:

- exact new-session and reset registry initialization;
- no lazy migration of old-shape state;
- actual NPC and implicit human participant mapping, duplicate/unknown identity rejection, and current `maySpeak` derivation;
- projection detachment, recursive freezing, strict fields, and privacy minimization;
- exact existing graph preservation and complete NPC graph translation;
- every allowed append/count/counter boundary and every forbidden-path mutation;
- shared publication and created-order counter density/exhaustion;
- replay before/after cleanup and tombstone eviction;
- conflict before pure Commit invocation;
- fault injection at every row in the atomicity table;
- final replacement exactly once with no fallible operation afterward;
- state/version delta zero for rejection, replay, conflict, and invariant failure;
- cleanup and delivery do not mutate authoritative state;
- public/developer snapshots do not gain unintended private or registry data;
- full existing Phase 4/5 and Phase 6 regression compatibility.

## Unblocking criteria

This Accepted decision removes the design ambiguity only after merge. It does not implement the runtime blocker. The prior Structured Route implementation Goal remains blocked until Slice 1, Slice 2, and Slice 3 are separately reviewed and merged. A new Structured Route Goal must then use the new `origin/master` baseline and the narrow engine-owned authority port.
