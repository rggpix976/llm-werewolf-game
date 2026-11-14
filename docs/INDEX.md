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
| Werewolf fake CO | implemented | 2026-11-14 | D-019; DEVELOPMENT_STATUS.md |
| Recording protocol (this index + AGENTS.md rules) | in review | 2026-11-14 | This file; AGENTS.md "Project Memory and Recording" |

Maintenance: update a row in the same pull request that starts, changes, or
merges the slice (see AGENTS.md, "Project Memory and Recording").
