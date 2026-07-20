# NPC Structured Reaction Phase Lifecycle and Fallback Decision

Status: Accepted by this correction Goal, pending independent review

Baseline: `1b2db28fad116d3262409e606ba2227de6496f80`

## Problem statement

The baseline leaves the live phase at `player_question` after a successful
structured NPC commit. A following question is therefore rejected by the
Interpreter as `candidate_not_allowed` and, despite structured mode being
enabled, falls through to the legacy response Provider. This document amends
the live lifecycle and route-selection boundary without changing the frozen
historical phase captured by the Player and NPC conversation artifacts.

## Reproduction matrix

The defect is present at the Engine, Browser, and CLI entrypoints with the
Player structured consumer both disabled and enabled. The first structured
question commits; the next question observes `player_question`, receives
`candidate_not_allowed`, and invokes the legacy Provider.

## Authority owners

`WerewolfGame.state` remains the only live authoritative state. Structured
Route keeps exactly its existing narrow read and atomic commit operations.
The success transition is derived inside the engine-owned commit transaction;
terminal-failure settlement is an engine-private operation. No third authority
operation, generic setter, or caller-selected phase field is introduced.

## Phase state machine and success version trace

```text
stable:                  day_discussion, N
Player commit:           player_question, N + 1
Provider/validation:     player_question, N + 1
successful NPC commit:   day_discussion, N + 2
```

The NPC graph append, exact version increment, and
`player_question -> day_discussion` live phase close are one final atomic root
replacement. The phase close does not append a `developerLog` entry.

## Historical phase versus live phase

Frozen trigger, binding, plan, event, publication, and commit-result fields
continue to record `player_question`. Only the post-commit live gameplay phase
is `day_discussion`; committed artifacts are not rewritten.

## Terminal failure settlement

After the Player commit, a terminal route result or throw without an NPC commit
retains the Player graph and uses an engine-private compare-and-swap settlement:

```text
player_question, N + 1 -> day_discussion, N + 2
```

The settlement requires the same session, turn identity and order, trigger
request and input record, Player graph fingerprint, target, exact version and
phase, no newer owner, and no committed NPC reaction for the trigger. A stale,
conflicting, reset, or destroyed owner causes zero settlement mutation. The
original route result or error remains the public outcome.

The private settlement result is a closed three-member taxonomy:

```text
settled:
  exact owner retained and the lifecycle replacement completed

owner_lost:
  the exact CAS owner was lost before replacement

settlement_failed:
  the exact owner remained but working-copy construction, validation,
  fault injection, or final replacement failed
```

Both the terminal-result and route-throw callers consume this result
exhaustively. `settled` and `owner_lost` preserve the original route result or
error contract. `settlement_failed` and any unknown member fail-stop with
`NpcStructuredLifecycleSettlementError` and the fixed redacted reason
`npc_structured_lifecycle_settlement_failed`; no raw route/fault error or cause
is attached. Settlement is attempted once, with no retry or legacy recovery.
If an exception follows a completed replacement, the engine verifies the exact
postcondition before classifying it as `settled`; a partial replacement cannot
be disguised as owner loss.

## Delivery nonauthority and lifecycle gate

Delivery never changes phase, version, or the authoritative conversation
graph. After successful commit the live phase is already `day_discussion`, but
the existing `pending_player_display`, `pending_delivery_retry`, and
`in_progress` handoff gate still rejects a second mutation until the handoff is
terminal.

## Closed structured selection

For an accepted `ask_npc` command with structured mode enabled, selection of
the structured path precedes Interpreter outcome branching. Only `validated`
continues to Player commit and the NPC route. Clarification, rejection,
failure, stale, conflict, missing, malformed, and unknown outcomes return a
minimal redacted closed structured result or an existing typed error. They do
not invoke compatibility handling, the legacy Provider or display, Player/NPC
commit, or Delivery.

The public closed result retains the existing action envelope and owns only
`responded: false` plus this exact `structuredNpc` projection:

```text
schemaVersion: 1
resultType: "npc_structured_interpreter_outcome"
enabled: true
outcomeCategory: clarification | rejected | failure | stale | conflict
reasonCode: closed redacted code
legacyUsed: false
legacySuppressed: true
```

Missing, malformed, unknown, and unexpected Interpreter outcomes normalize to
the redacted `failure` category; raw exception and input data are never copied.

## Flag-off compatibility

With structured mode disabled, the existing compatibility fallback, phase
sequence, Provider behavior, and display behavior remain unchanged. Existing
logical-turn allocation and clarification continuation identity also remain
unchanged.

## Turn allocation compatibility

For structured-mode `ask_npc`, two-version capacity is checked after command
validation and the existing in-progress gates but before turn/order mutation,
turn-ID allocation, ID-allocator invocation, Interpreter invocation, or any
Player/NPC/legacy effect. A starting version greater than
`Number.MAX_SAFE_INTEGER - 2` fails with the existing
`state_version_exhausted` code and changes no authoritative identity or graph.
The exact boundary `Number.MAX_SAFE_INTEGER - 2` remains valid and ends at the
last safe integer after the two commits.

Closed nonvalidated structured outcomes preserve the existing Phase 3 turn
contract: a new noncontinuation command retains its newly allocated turn ID and
order, while a valid clarification continuation reuses its logical turn. They
do not commit Player or NPC conversation state and do not increment the state
version merely because the structured outcome is closed.

The preflight is not applied to flag-off or non-`ask_npc` compatibility paths;
their existing one-version and Interpreter/fallback behavior is unchanged.

## Replay and conflict boundaries

Exact replay does not rerun Interpreter, Player commit, NPC Provider,
validation, preparation, NPC commit, lifecycle settlement, Delivery, or legacy
fallback. It changes no live phase, version, or turn order. Settlement loses
its compare-and-swap race without changing newer state.

## Authorized delta allowlists

For a new successful structured NPC commit, the existing canonical NPC append
and counter allowlist is amended only by the engine-derived live transition
`player_question -> day_discussion`; the existing exact `stateVersion + 1`
transition remains. For terminal failure settlement, only `state.phase` and
`state.stateVersion` may differ. All other live paths are byte-equivalent.

## Privacy

Closed outcomes, errors, diagnostics, fixtures, and PR evidence must not expose
raw input, selected alternatives, prompts, roles, teams, hidden information,
private memory, API credentials, or unredacted exception details.

## Rejected alternatives

- Expanding Interpreter phase candidates or treating `candidate_not_allowed`
  as validated.
- Closing the phase in Delivery, Browser, CLI, Provider, or a route-supplied
  patch.
- Calling the legacy question handler to recover structured lifecycle.
- A second phase-only commit after successful NPC commit.
- Rolling back the accepted Player commit after an NPC failure.
- Adding a generic or third authority operation.

## Test matrix

Focused coverage fixes the successful in-flight phase trace, two consecutive
questions, consumer-off/on Engine and Browser/CLI entrypoints, closed
Interpreter outcomes, flag-off compatibility, Provider exhaustion and malformed
candidate settlement, settlement races, authority-port atomicity, Delivery
nonauthority, replay, handoff gating, winner/vote/night regressions, privacy,
and two-version capacity.

## Rollback

Rollback is the normal revert of this isolated correction before enabling the
default-off feature. It must revert the decision, engine-owned phase close,
engine-private failure settlement, closed selection boundary, and matching
tests together. It must not rewrite already committed production state.
