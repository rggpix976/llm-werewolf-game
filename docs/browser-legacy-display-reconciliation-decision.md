# Browser Legacy Display Reconciliation Decision

## Status

Accepted for the isolated runtime correction that starts from
`a5295e2606b55917cae20d937024aebb0d64a4ae`. Independent review and merge of
the correction remain pending. This decision does not complete E4, approve a
flag-on rollout, or start E5.

## Baseline

PR #66 was incorporated by normal two-parent merge commit
`a5295e2606b55917cae20d937024aebb0d64a4ae`. Its approved second parent is
`ed613c7aeb5ce420a73ce045547259129dea9049`, and the merge tree equals that
approved HEAD tree.

## E4 finding

The E4 manual real-browser audit started from this baseline and stopped with a
HIGH, E4-blocking Browser defect. In a fresh disabled Browser session,
`POST /api/npc-response` completed once with a successful response and the
legacy NPC entry existed in the Engine Player-facing log, but the final Browser
DOM omitted that NPC answer. E4 therefore remains unfinished with the recorded
outcome `E4_MANUAL_REAL_BROWSER_STOPPED_HARDENING_REQUIRED`.

## Root cause

`reconcileBrowserPublicationNodes()` already returns one visible node for every
entry in `playerFacingLog`, including entries that have no `publicationId`.
`renderLogs()` discarded that complete result, queried the temporary DOM again
for `[data-publication-id]`, and passed only those publication-backed nodes to
its final `replaceChildren()`. That made delivery identity an unintended
visibility predicate and removed successful legacy display-only NPC nodes.

## Visible model authority

`playerFacingLog` is the Browser's visible Player-facing log model. Every entry
in that model participates in reconciliation:

- an entry with `publicationId` is a publication-backed Player entry;
- an entry without `publicationId` is still a visible legacy display-only
  entry.

Endpoint success alone does not prove visible success. The final reconciled DOM
must contain the corresponding model entry exactly once.

## Publication identity versus visibility

`data-publication-id` identifies Player publication delivery.
`data-npc-publication-id` identifies a canonical structured NPC publication.
Neither attribute is a general-purpose UI membership marker.

A legacy NPC node receives neither a fabricated Player publication ID nor a
fabricated canonical NPC publication ID. It remains visible because its entry
belongs to `playerFacingLog`, not because an ID was invented for it.

## Legacy display-only entries

The ordered node list returned by `reconcileBrowserPublicationNodes()` is the
complete visible node list corresponding to `playerFacingLog`. `renderLogs()`
retains all of those nodes, including ID-less legacy entries, in source order.
It must not reconstruct that list using a publication-ID selector.

ID-less nodes may be safely recreated during a later reconciliation. Node
object identity is not authoritative; exact visible content, order, and count
are.

## Canonical NPC insertion anchor

Existing canonical structured NPC nodes retain their `afterPlayerCount`
contract. The count includes only publication-backed Player nodes. An ID-less
legacy display node is visible in source order but does not advance this
anchor.

Consequently, anchor zero is emitted before the first publication-backed Player
node, and anchor `n` is emitted immediately after the `n`th publication-backed
Player node even when ID-less legacy entries occur between those Player nodes.

## Minimal merge algorithm

```text
playerFacingNodes = reconcileBrowserPublicationNodes(...)
merged = []
publicationBackedPlayerCount = 0

append canonical NPC nodes anchored at 0

for each node in playerFacingNodes:
  append node

  if node owns data-publication-id:
    publicationBackedPlayerCount += 1
    append canonical NPC nodes anchored at that count

replaceChildren(...merged)
```

Player delivery bookkeeping continues to rebind only publication-backed nodes.
Legacy nodes are not inserted into the publication bookkeeping map.

## Repeated render contract

After initial dispatch completion, later public renders, a second legacy
question, snapshot rendering, and DOM reconciliation:

- each existing legacy Player/NPC entry remains visible exactly once;
- source order is preserved;
- no duplicate node is introduced;
- canonical structured NPC anchors remain publication-count based.

## New Game isolation

New Game clears the old `playerFacingLog` and both Browser bookkeeping maps.
Old-session legacy nodes are not preserved. A fresh session may render its own
legacy Player/NPC pair exactly once, with no old content or retained
`Retry Display`.

## Structured ON compatibility

Structured mode behavior is unchanged for Player consumer OFF and ON. Two
questions retain this order:

```text
Player-A -> canonical NPC-A -> Player-B -> canonical NPC-B
```

The Player nodes keep `data-publication-id`, canonical NPC nodes keep
`data-npc-publication-id`, candidate invocation occurs once per question, and
legacy Provider/display fallback remains zero.

## Security and textContent

Message text remains assigned through `textContent`. The correction does not
render message data through `innerHTML`, expose raw Provider diagnostics,
create fake identities, or mutate `WerewolfGame.state`, `stateVersion`,
`turnOrder`, `turnId`, or the conversation graph.

## Rejected alternatives

- Fabricating a canonical publication ID for a legacy display node.
- Treating an endpoint 2xx response as sufficient visible-success evidence.
- Removing every ID-less node from the visible DOM.
- Creating a hot-toggle-only fixture to manufacture a mixed sequence.
- Changing Engine state, conversation graphs, Provider, Route, Commit, or
  Delivery contracts.
- Copying a structured NPC publication into the legacy log.

## Automated regression matrix

| ID | Evidence |
|---|---|
| BLR-001 | Flag OFF／consumer OFF: one Player entry and one legacy NPC entry remain visible in order; legacy endpoint 1, candidate 0. |
| BLR-002 | Flag OFF／consumer ON with full dependency closure preserves the same visible legacy result without a structured NPC publication. |
| BLR-003 | Two legacy questions preserve both Player/NPC pairs exactly once across repeated reconciliation. |
| BLR-004 | A later public action/render preserves the existing legacy pair without duplication. |
| BLR-005 | New Game removes old legacy content; a fresh legacy pair renders once. |
| BLR-006 | A fresh disabled Browser shows the legacy answer, structured observations unavailable, and no retained retry control. |
| BLR-007 | Structured ON／consumer OFF retains two-question Player-before-NPC order and exact identities. |
| BLR-008 | Structured ON／consumer ON retains the same structured contract. |
| BLR-009 | Reconciliation retains ID-less nodes, while canonical NPC anchoring counts only publication-backed Player nodes. |
| BLR-010 | Legacy text stays literal and identity-free; private diagnostics and authority mutation remain absent. |

The deterministic fake-DOM suite is E3 automated evidence. It is not manual
real-browser evidence.

## Replacement E4 boundary

Replacement E4 starts only after this correction is independently reviewed,
normally merged, and a new authoritative baseline is fixed.

Human checkpoints are limited to visible behavior: the legacy answer remains
visible after a later render, two-question ordering, duplicate suppression, New
Game isolation, fresh disabled Browser behavior after graceful and emergency
rollback, and absence of visible retry/error/private text.

Codex owns deterministic transport evidence: runtime-config status, Interpreter
and candidate counts, legacy endpoint count/status, absence of authorization,
loopback/external-target classification, and Server/proxy/port cleanup. The
human operator is not required to inspect DevTools, headers, raw IDs, or
console output.

## Rollback

The rollback runbook semantics remain unchanged: a fresh Server process,
Browser full reload/new tab, and fresh game are required. The postcondition is
now explicit that a successful legacy request is insufficient by itself; the
legacy NPC answer must still be visible exactly once after final DOM
reconciliation and a subsequent public render.
