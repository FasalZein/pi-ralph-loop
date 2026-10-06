Read `README.md`, `skills/ralph-plan-writer/SKILL.md`, and all the files in `skills/ralph-plan-writer/philosophy/` + explore the codebase (without using subagents) if necessary for fully understanding what ralph wiggum loop is and therefore what this Pi extension does.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Full suite. Run before handoff. `tests/commands.test.ts:327` is a known flake (#27); driver (3 s startup wait), events and tmux timing tests fail under heavy machine load. On such a failure, check `uptime`, then rerun those files serially (`node --import tsx --test --test-concurrency=1 <files>`) and the full suite at low load. |
| `npx tsc --noEmit -p .` | Type check. There is no typecheck script. |

- Push only to the `fork` remote. `origin` is upstream `edxeth/pi-ralph-loop`; never write there.
- When working a ticket in a worktree: add `../pi-ralph-loop-wt/<tN>` on branch `rw/<tN>` from `feat/ralph-watch`, and symlink `node_modules` to the main checkout's. Land by fast-forward. Delete the symlink before `git worktree remove`, because untracked files block removal.
- When changing viewer code (`src/watch/viewer*`): tests load pi-tui from `node_modules` (dev dep `^0.84.2`), but the `ralph` bin loads the installed pi's pi-tui (1.0.4 on 2026-10-06; owner kept the dev deps, #1). Use only pi-tui APIs present in both.
- When adding git calls to observation code: run them through the `ObservationRuntime.git` boundary in `src/watch/loop-state.ts`. It sets `diff.autoRefreshIndex=false`, because a plain `git diff` rewrites the index during a read and causes torn-read retries.
- When a test or probe needs tmux: use an isolated server (`tmux -L <unique>`), never the default server.

## Agent skills

### Issue tracker

GitHub issues on the fork `FasalZein/pi-ralph-loop`; always pass `-R FasalZein/pi-ralph-loop`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` and `docs/adr/`, created lazily. See `docs/agents/domain.md`.
