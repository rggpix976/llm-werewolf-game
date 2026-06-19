# Decisions

## D-001: LLM Does Not Mutate Game State

The LLM or pseudo-LLM response generator must only produce utterance text and response metadata.

Game state changes such as roles, life/death, votes, seer results, attacks, and win checks are handled only by code.

## D-002: CLI Is Temporary UI

PowerShell/CLI is only an input and log display adapter.

Core game behavior must remain usable from browser UI, desktop UI, tests, or scripts without depending on `readline`, `console.log`, or process stdin/stdout.

## D-003: Player-Facing Logs and Developer Logs Stay Separate

Player-facing logs contain only information that a player may see.

Developer logs may contain roles, hidden info, known info, suspicion scores, vote reasons, seer targets/results, attack targets, evidence used, and prompt previews.

## D-004: Seer Results Are Private Until Claimed

Night seer results are added to the seer's `knownInfo`.

They are not added to `publicInfo` automatically. A public claim may expose them later through controlled code paths.

## D-005: NPCs Speak From Limited Information

NPC responses must be grounded in `publicInfo` and that NPC's own `knownInfo`.

`hiddenInfo` may guide behavior only when explicitly allowed by conversation policy, such as a seer intentionally making a role claim. A werewolf must not confess by accident.

## D-006: GitHub Repository Is Private

The remote GitHub repository should be private during early development.

This allows internal design notes, prompt previews, and developer logs to be committed safely while the design is still changing.

## D-007: NPC Response Providers Are Asynchronous and Text-Only

Response providers implement `async generateResponse(request)`.

They receive a frozen, cloned request instead of the live game state. Their accepted output is limited to utterance text and diagnostic metadata. Claims, memory updates, public information, roles, life/death, votes, and win state remain controlled by the game engine.

## D-008: Provider Failure Cancels Only the Current Response

Provider exceptions, empty text, and invalid return values do not end the game and do not trigger a pseudo-response fallback.

The current NPC response is skipped, the failure is recorded in the developer log, the phase returns to `day_discussion`, and the player may ask another question or proceed to voting.
