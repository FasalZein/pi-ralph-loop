Read `README.md`, `skills/ralph-plan-writer/SKILL.md`, and all the files in `skills/ralph-plan-writer/philosophy/` + explore the codebase (without using subagents) if necessary for fully understanding what ralph wiggum loop is and therefore what this Pi extension does.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Full suite. Run before handoff. `tests/commands.test.ts:327` is a known flake (#27); driver tests can time out on their 3 s startup wait under heavy machine load. |
| `npx tsc --noEmit -p .` | Type check. There is no typecheck script. |

- Push only to the `fork` remote. `origin` is upstream `edxeth/pi-ralph-loop`; never write there.
- When working a ticket in a worktree: add `../pi-ralph-loop-wt/<tN>` on branch `rw/<tN>` from `feat/ralph-watch`, and symlink `node_modules` to the main checkout's. Land by fast-forward. Delete the symlink before `git worktree remove`, because untracked files block removal.
- When a test or probe needs tmux: use an isolated server (`tmux -L <unique>`), never the default server.

## Agent skills

### Issue tracker

GitHub issues on the fork `FasalZein/pi-ralph-loop`; always pass `-R FasalZein/pi-ralph-loop`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` and `docs/adr/`, created lazily. See `docs/agents/domain.md`.
