# Slice / Feature Index

A compact index of what exists, what state it is in, and where the detail
lives. One line per slice or feature. Detail belongs in
`DEVELOPMENT_STATUS.md` (current state) and `DECISIONS.md` (decisions and
reasons); this file only points.

States: `planned` / `in progress` / `in review` / `merged` / `on hold`

| Slice / feature | State | Last update | Detail |
| --- | --- | --- | --- |
| 9-player village (medium, knight, madman) | merged | 2026-11-09 | PR #75; DEVELOPMENT_STATUS.md |
| Madman counter-CO against a seer claim | merged | 2026-11-09 | PR #77; DEVELOPMENT_STATUS.md |
| Rescue claim before execution, with re-vote | merged | 2026-11-11 | PR #79; DEVELOPMENT_STATUS.md |
| Player vote (one equal vote, simultaneous) | merged | 2026-11-13 | PR #84; DECISIONS.md D-018 |
| Evidence-text fix for mid-game "no response" failures | merged | 2026-11-13 | PR #85; DEVELOPMENT_STATUS.md |
| Werewolf fake CO | merged | 2026-11-14 | PR #88; DECISIONS.md D-019 |
| Knight guard-history and fake knight CO | merged | 2026-11-15 | PR #90; DECISIONS.md D-020 |
| Recording protocol (this index + AGENTS.md rules) | merged | 2026-11-14 | PR #86; AGENTS.md "Project Memory and Recording" |
| Fake seer claim shape choice when self-blacked | merged | 2026-11-15 | PR #91; DECISIONS.md D-021 |
| Werewolf attack decision against a claimed knight | merged | 2026-11-15 | PR #92; DECISIONS.md D-022 |
| Medium proactive claim in decisive situations | merged | 2026-11-15 | PR #93; DECISIONS.md D-023 |
| Claimed-player result disclosure and disproven-claim reversal | merged | 2026-11-15 | PR #94; DECISIONS.md D-024, D-025 |
| Vote intention named in target answers | merged | 2026-11-15 | PR #95; DECISIONS.md D-026 |
| Disproven-claim liar penalty | merged | 2026-11-15 | PR #97; DECISIONS.md D-027 |
| Fake medium claims and claim contradictions | merged | 2026-11-16 | PR #99; DECISIONS.md D-028 |
| Ask-path claim maintenance | merged | 2026-11-16 | PR #100; DECISIONS.md D-029; DEVELOPMENT_STATUS.md |
| Personality strategy lean | merged | 2026-11-17 | PR #101 (Phase A), PR #102 (Phase B); DECISIONS.md D-030; DEVELOPMENT_STATUS.md |
| Fabricated claim night cap | merged | 2026-11-22 | PR #103; DECISIONS.md D-031; DEVELOPMENT_STATUS.md |
| Persuasion: player assertions and NPC declarations | merged | 2026-11-22 | PR #104; DECISIONS.md D-032; DEVELOPMENT_STATUS.md |
| Board assessment for contested claim groups | merged | 2026-11-24 | PR #105; DECISIONS.md D-033; DEVELOPMENT_STATUS.md |
| Yakuza cast selection and voice/address materials (Slice 1) | merged | 2026-11-25 | PR #106; DECISIONS.md D-034; DEVELOPMENT_STATUS.md |
| Claim announcements in per-character set phrases | merged | 2026-11-25 | DECISIONS.md D-035; DEVELOPMENT_STATUS.md |
| Ask-path claim announcements delivered verbatim (D-036) | merged | 2026-11-25 | DECISIONS.md D-036; DEVELOPMENT_STATUS.md |
| Per-observer seer-result trust (claim trust) | in review | 2026-11-25 | DECISIONS.md D-037; DEVELOPMENT_STATUS.md |

Maintenance: update a row in the same pull request that starts, changes, or
merges the slice (see AGENTS.md, "Project Memory and Recording").
