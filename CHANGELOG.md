# Changelog

## Unreleased

- Added the Phase 4 `PlayerLegacyDisplayCompatibilityRecord` writer and session-scoped registry. Each Phase 4 player publication now atomically records one engine-owned mapping to its unchanged legacy player-log location using the canonical-entry SHA-256 fingerprint in the existing `N -> N+1` transaction.
- Added strict mapping schema and committed-graph validation, one-to-one identity/cardinality checks, final-CAS append-location protection, replay corruption rejection without backfill, complete working-copy rollback, and immutable read-only lookup by publication or mapping ID.
- Phase 5 remains blocked until this repair is merged to `master`; publication delivery, browser/CLI sinks, acknowledgement, and PR #18 consumer changes remain deferred to Phase 5.
- Added the default-off Migration Phase 4 atomic `PlayerConversationCommit`, including structured player artifacts, canonical result-claim assertions and relations, stored idempotency results, and the temporary legacy display compatibility delta.
- Split Phase 4-enabled conversation handling into player `N -> N+1` and provisional NPC reaction `N+1 -> N+2` transactions. Exact replay calls neither provider and provider failure preserves the player commit without publishing `N+2`.
- Added failure-injection, replay, version-ledger, claim, Unicode display-plan, feature-policy, and Phase 4-off regression coverage.

## 2026-07-12

- Implemented Migration Phase 3 authoritative Interpreter validation behind the default-off `INTERPRETER_VALIDATION_MODE` flag.
- Added engine-owned game session, logical turn/order, and state-version lifecycle with atomic compatibility transactions and rollback without version gaps.
- Added immutable authoritative request bindings, staged inputs, strict candidate/alternative/source-span validation, exact stale classification, bounded redacted diagnostics, and reset/late-response isolation.
- Phase 3 remains observation-only: no AcceptedSpeechAct, semantic event, canonical claim, structured commit, display plan, Renderer request, or player-facing behavior is produced from Interpreter output.
- When Phase 2 and Phase 3 flags are both enabled, Phase 3 owns the single Interpreter send and shadow sending is suppressed. Disable the Phase 3 flag for immediate rollback without migration.

## 2026-07-11

- Added unused, side-effect-free conversation pipeline Phase 1 domain definitions and strict runtime validators.
- Added deterministic claim idempotency helpers, canonical claim/vote/suspicion renderers, exact commentary-variant replay lookup, and unit tests.
- Hardened Phase 1 after review with strict Interpreter alternatives, engine-owned participant rendering, descriptor/segment and policy compatibility, full reference validators, registry eligibility checks, deep-frozen definitions, and unambiguous canonical JSON.
- Production game flow, providers, HTTP endpoints, browser behavior, and game-state mutation remain unchanged.

## 2026-07-01

- Recorded successful real OpenAI smoke-test result (`npm run smoke:openai`).
- Verified local integration using the production server and `OpenAIResponseProvider` path.
- Confirmed exactly 1 billable request (gpt-5.4-mini) with no retries and no fallbacks.
- Validated secure API key handling (not stored, removed from environment afterward).

## 2026-06-28

- Added a controlled one-call real OpenAI smoke-test workflow (`npm run smoke:openai`).
- Implemented explicit safety gates and opt-in (`I_ACCEPT_API_CHARGES`) for real API verification.
- Added automated tests (95 total) including coverage for the smoke-test logic using mocked HTTP responses.
- Added a secure server-side OpenAI response provider using the official Responses API.
- Implemented `OpenAIResponseProvider` with support for `input_text` and `reasoning: { effort: "none" }`.
- Added environment variable configuration with strict validation and sane defaults.
- Refactored `src/webServer.mjs` to separate core logic from listening for better testability.
- Added `/api/npc-response` proxy with allowlist-based validation and request size limits (64 KiB).
- Implemented `SessionManager` in the browser to prevent stale responses after "New Game".
- Enhanced security: Redacted private evidence when public claim is not allowed.
- Enhanced robustness: Strictly validated OpenAI response statuses, sanitized 400 error messages, and correctly classified body-reading timeouts.
- Fixed concurrency handling: Removed reset() to prevent unstable state and ensured activeRequests never becomes negative.
- Added automated tests (74 total) covering security invariants and edge cases.
- Updated Developer Mode to display structured diagnostics for both successful and failed responses.

## 2026-06-26

- Added Developer Mode to the browser UI.
- Implemented read-only `getDeveloperDiagnostics()` API in `WerewolfGame` using `structuredClone`.
- Added granular diagnostics for NPC internal states, developer logs, and LLM provider metadata (prompts, evidence, usage).
- Added Developer Mode UI with log filtering by NPC and kind.
- Expanded automated test suite from 16 to 24 tests to cover developer diagnostics.
- Added `AGENTS.md` with persistent repository instructions.
- Updated documentation for Developer Mode usage and security.

## 2026-06-25

- Added a first browser UI adapter using the public action API and public snapshots.
- Added a local static server and `npm.cmd run web` startup script.
- Added browser controls for NPC questions, voting, night progression, and new in-memory games.
- Updated documentation for browser UI startup and the next developer-mode milestone.
- Added minimal suspicion updates from accusatory player questions.
- Added automated coverage for question-driven suspicion updates.
- Updated development status, TODOs, and roadmap for browser UI adapter implementation.
- Corrected the recorded Git state now that local `master` is synchronized with `origin/master`.

## 2026-06-19

- Decided that game sessions are memory-only and will not support save/load persistence.
- Updated the next milestone to browser UI adapter preparation.
- Added an injectable asynchronous NPC response provider interface.
- Added `PseudoResponseProvider` as the default implementation.
- Separated response-request construction and code-controlled claim decisions from utterance generation.
- Added provider response validation and question-level failure recovery.
- Converted the UI-independent action API, CLI, sample play, and tests to async usage.
- Expanded automated coverage from 10 to 15 tests.
- Added 10 automated core game tests using Node.js `node:test`.
- Covered role setup, action API responses, public snapshot privacy, NPC speech rules, voting, execution, seer privacy and claims, attacks, and win checks.
- Added `npm.cmd test` as the standard automated test command.
- Updated development status and roadmap; the next milestone is the LLM response provider interface.

## 2026-06-17

- Added `dispatchPlayerAction(action)` as a UI-independent game action API.
- Added `getPublicSnapshot()` for browser/CLI-safe state reads.
- Updated CLI and sample play to use the action API.
- Updated development status to reflect GitHub private repository setup and initial push.
- Added development continuity documents:
  - `DEVELOPMENT_STATUS.md`
  - `ROADMAP.md`
  - `DECISIONS.md`
  - `TODO.md`
  - `CHANGELOG.md`
- Prepared the project for Git-based development tracking.

## 2026-06-13

- Added the initial 5-player werewolf prototype.
- Added CLI play flow.
- Added pseudo-LLM NPC response generation.
- Added vote, execution, night, seer, werewolf attack, and win-check flow.
- Added sample play and audit script.
