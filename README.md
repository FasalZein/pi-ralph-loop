# pi-ralph-loop

`pi-ralph-loop` turns Geoffrey Huntley's Ralph Wiggum loop technique into a Pi extension on steroids.

Ralph, in its purest form, is a bash loop: run a coding agent, let it read the plan, make one useful change, commit, and repeat. That simplicity is the point. Raw bash still leaves you to build the boring parts yourself: resume, stop, status, promise parsing, fresh-session handoff, progress tracking, bundle validation, and safety gates.

This extension gives Ralph a native Pi runtime. It also ships `ralph-plan-writer`, an opinionated skill that turns a goal, PRD, SPEC, or messy implementation idea into a ready-to-run Ralph plan, aka `.ralph/` bundle.

Use the bundled agent skill when you want a Ralph planner out of the box. Use plain `/ralph-loop` when you want to bring your own prompt.

## Acknowledgements

Special thanks to [@FasalZein](https://github.com/FasalZein) and [@isthatyousaf](https://github.com/isthatyousaf) — for their contributions, ideas, and for providing access to frontier models like GPT and Claude, which made it possible to experiment and build this extension. Good guys, I owe them a lot!

## 🌐 **Join the Community**

> [!NOTE]
> **Building with AI doesn’t have to be a solo grind.**  
> Join our Discord community to meet other people exploring the latest models, tools, workflows, and ideas: **https://discord.gg/whhrDtCrSS**
>
> We talk about what’s new, what’s useful, and what’s actually worth paying attention to in AI.  
> *And if you want more than conversation,* members also get access to **heavily discounted AI products and services** — including deals on tools like **ChatGPT Plus** and more for just a few dollars.

## Install

```bash
pi install git:github.com/edxeth/pi-ralph-loop
```

## Why Ralph Wiggum loop works

A coding agent starts each session sharp. It has a local job, a clean prompt, and enough context to move.

Then the transcript fills with tool output, failed attempts, old reasoning, stale plans, and half-true assumptions. The model keeps seeing all of it. Past a point, more context makes the next decision worse.

Ralph exits before that decay dominates. Each iteration does one verified unit of work, writes durable state, commits, and leaves. The next iteration starts fresh and reloads only the facts that survived into files and git history.

That is the trick: throw away live context, keep durable evidence.

## Why this extension exists

A raw Ralph loop can be one shell script. That works until you want to run it overnight.

`pi-ralph-loop` adds the parts AFK runs need:

- fresh Pi sessions per iteration
- `/ralph-stop`, `/ralph-status`, `/ralph-resume`, and `/ralph-restart` commands
- persisted loop state in `.ralph/loop.md`
- promise nudges when the agent forgets the final control tag
- runtime checks for item mutation, progress append, commits, and protected source docs
- the bundled `ralph-plan-writer` skill

## Start with the plan writer

```text
/skill:ralph-plan-writer Build the execution bundle for this goal: <goal>
```

The skill asks where the Ralph plan should be created. The selected path becomes the Ralph workspace root: `.ralph/` lives there, work happens there, verification commands run there, and commits are counted there.

It writes:

```text
.ralph/plan.md
.ralph/items.json
.ralph/prompt.md
.ralph/progress.md
```

Then run this from the Ralph workspace root:

```text
/ralph-loop "@.ralph/prompt.md" --max-iterations=20
```

If the skill was invoked from a different directory, start Pi in the selected Ralph workspace root before running the command.

The plan writer reads the goal, optional PRD/SPEC files, repo state, git history, verification commands, and system constraints. Then it writes the facts Ralph needs into `.ralph/`.

The repo stays the source of truth. PRDs and SPECs help create the bundle; they do not become another document the runtime agent must keep rereading. If you want a custom loop where the agent reads those files every iteration, write that into your own prompt.

### System preflight

The plan writer blocks unsafe system-level loops before they start.

For plans that depend on `sudo`, admin, services, installers, GUI permissions, devices, packaging, Windows/WSL boundaries, or unattended verification, it gathers safe facts first. It may inspect the host, shell, package manager, path translation, tool availability, and non-interactive privilege state.

It must not install packages, mutate services, start privileged workflows, or trigger permission dialogs unless you approve that planning action.

If the loop would spin on an unresolved host, permission, or verification blocker, the skill should not write a `.ralph/` bundle.

## Bring your own Ralph prompt

You can skip the plan writer and run your own loop prompt:

```text
/ralph-loop "@PLAN.md @progress.md Pick one unfinished task, implement it, verify it, update progress, commit, then end with <promise>NEXT</promise>. End with <promise>COMPLETE</promise> when everything is done." --max-iterations=10
```

Your prompt should tell the agent to:

- read the plan and progress file
- choose one item
- make one coherent change
- run the checks
- update progress
- commit
- end with a promise tag on the last non-empty line

That is enough to Ralph. Bundle mode adds stronger runtime checks.

## Promise tags

Ralph reads the last non-empty line of the assistant response.

| Tag | Meaning |
| --- | --- |
| `<promise>WAIT</promise>` | This iteration is intentionally waiting for an async helper, background command, review, process alert, or future tool result. Stay in the same session. |
| `<promise>NEXT</promise>` | This iteration finished one unit of work. Start the next fresh session. |
| `<promise>COMPLETE</promise>` | The whole loop is done. Stop successfully. |
| `<promise>STOP</promise>` | Stop the loop without calling it complete. |

If the agent omits a tag, Ralph sends a control-tag prompt. After repeated misses, Ralph stops with an error instead of looping forever. `WAIT` has its own timeout. If no async result arrives before that timeout, Ralph asks the agent to re-check the iteration and choose `WAIT`, `NEXT`, or `COMPLETE`. Runtime support for `STOP` remains available, but Ralph does not include it in default correction prompts.

## Bundle mode, if you write it yourself

Skip this section if you use `ralph-plan-writer` or a plain `/ralph-loop` prompt.

Bundle mode starts when the task points at `.ralph/prompt.md`, including `@.ralph/prompt.md` and `@./.ralph/prompt.md`. In that mode Ralph validates `.ralph/items.json` instead of trusting the agent's final message alone.

Minimum `.ralph/items.json`:

```json
{
  "version": 1,
  "items": [
    {
      "category": "functional",
      "description": "User-visible behavior to complete.",
      "steps": ["Run the end-to-end verification."],
      "passes": false,
      "regression_notes": ""
    }
  ]
}
```

Add `runtime_contract` when you want stricter gates:

```json
{
  "runtime_contract": {
    "verification_gates": [
      { "name": "tests", "command": "npm test" }
    ],
    "require_progress_append": true,
    "require_one_item_per_iteration": true,
    "require_commit": true,
    "external_gate": {
      "entrypoint": "tools/ralph-gate.mjs",
      "timeout_ms": 30000
    }
  }
}
```

Useful `runtime_contract` fields:

| Field | Effect |
| --- | --- |
| `verification_gates` | Commands the agent must run during its iteration before emitting a promise. Listed here so the agent knows what to verify; Ralph does not re-run them at promise emission (that froze the loop on heavy suites). Advisory, not harness-enforced. |
| `require_progress_append` | `NEXT` requires `.ralph/progress.md` to grow. |
| `require_one_item_per_iteration` | `NEXT` requires exactly one item to move from `passes:false` to `passes:true`. |
| `require_commit` | When `true`, `NEXT` and `COMPLETE` require git HEAD to change during the iteration. Omit or set `false` when commits are not required. |
| `source_docs` + `require_clean_source_docs` | Optional file-protection gate. Omit unless you want Ralph to reject edits to listed files. |
| `external_gate` | Optional repository-owned lifecycle gate. Set one workspace-relative `.mjs` `entrypoint`. `timeout_ms` defaults to 30000. |

Ralph runs an external gate directly as `[process.execPath, resolvedEntrypoint]`. Ralph does not use a shell or search `PATH`. The gate reads one JSON document from stdin and writes one JSON document to stdout:

```json
{
  "version": 1,
  "phase": "launch",
  "mode": "linear-live",
  "selected_issue": null,
  "selected_title": null,
  "start_head": "0123456789abcdef",
  "current_head": "0123456789abcdef",
  "accepted_head": null,
  "checks": [
    { "name": "bundle", "status": "pass", "detail": "valid" }
  ],
  "journal_phase": null,
  "linear_action": null,
  "exit_code": 0,
  "ok": true
}
```

The response phase must match the requested hook. `selected_issue`, `selected_title`, HEAD fields, `journal_phase`, and `linear_action` accept explicit nulls. Check status is `pass`, `fail`, or `skip`. Stable exit codes are `0`, `2`, `3`, `4`, `5`, `6`, and `7`; `ok` is true only for exit code `0`. The output may include a string `message`. Any other output field is invalid. Ralph fails closed on timeout, signal, malformed output, non-zero process exit, protocol mismatch, or `ok: false`.

The input includes `version: 1`, the lifecycle `hook`, `workspace_root`, immutable digests, and trusted loop metadata. Hooks are `dry-run`, `launch`, `iteration-start`, `promise`, `transition`, `stop`, and `cleanup`. Promise events include `NEXT` or `COMPLETE`. Resume events include same-token and same-session metadata.

External-gate bundles require `--max-iterations` to equal `2 × item count + 4`. Ralph validates this budget before creating loop state. Ralph hashes the gate entrypoint and canonical immutable bundle. The immutable digest covers plan, prompt, runtime contract, and every immutable item field. It excludes only `passes`, `regression_notes`, append-only progress, and generated loop state. Ralph pins both digests at launch and never replaces them during iteration snapshots.

Ralph runs `launch` with an in-memory token and digests before writing `.ralph/loop.md`. Ralph rejects launch changes to protected Git, `.ralph/`, loop, or session state. A rejected or failed launch dispatches one bounded stop attempt with the in-memory token, leaves no loop state, and never runs cleanup. Ralph runs `cleanup` only after COMPLETE is durable. Other terminal paths run the retryable stop hook and preserve repository claim state. The first pending stop reason remains fixed until the stop succeeds. A cleanup-pending run must reconcile before a new loop or restart can replace its token.

Use dry-run to validate the bundle and invoke only the read-only hook. It creates no loop state or Pi session. Ralph rejects changes to local Git HEAD/status, untracked files, the complete `.ralph/` tree, or current loop/session identity:

```text
/ralph-loop "@.ralph/prompt.md" --max-iterations=6 --dry-run
```

`WAIT` means the selected item is still in progress because the agent expects an async result to arrive later. `NEXT` means one item passed and the required checks passed, so Ralph can move to the next loop iteration. `COMPLETE` means every item passed and all required checks passed. Rejected promises stay in the same session with a corrective prompt.

## Commands

### `/ralph-loop <task> [--max-iterations=N]`

Start a loop. Default max iterations: `100`.

### `/ralph-resume [--force]`

Resume the saved loop from `.ralph/loop.md`. Use `--force` to resume a completed run.

Resume adapts to where it runs. From the same Pi session that owns the saved iteration, it does not re-send the prompt. Instead it reads the last assistant turn: `COMPLETE` and `STOP` end the loop, `NEXT` advances to the next fresh iteration, and `WAIT` keeps the same iteration parked. If no promise was emitted yet, Ralph sends the same control-tag prompt it uses for missing promises. From any other session, it restarts the saved iteration in a fresh session.

### `/ralph-restart`

Restart the saved loop from iteration 1 with the same prompt and max-iteration limit.

### `/ralph-stop`

Stop after the current iteration finishes.

### `/ralph-status`

Show iteration, elapsed time, and error state.

## Delay between iterations

Use `RALPH_NEXT_ITERATION_DELAY_SECONDS` when Ralph must wait before the next iteration. The delay can support rate limits, cooling periods, and scheduled workflows.

For example, Claude and Codex subscriptions can have five-hour usage limits. The delay can spread a Ralph loop across more than one limit period.

Set a five-minute delay:

```bash
export RALPH_NEXT_ITERATION_DELAY_SECONDS=300
pi
```

After Ralph accepts `<promise>NEXT</promise>`, it shows a seconds countdown and waits before opening the next fresh session. The first iteration, same-iteration recovery, `WAIT`, `COMPLETE`, and `STOP` are not delayed.

Ralph interprets the value as seconds. Ralph rounds decimal values down, so `60.9` gives a 60-second delay. Unset, empty, negative, alphanumeric, and other invalid values apply no delay. A stop or cancellation request during the countdown prevents the next session from opening.

## Loop state

Ralph writes `.ralph/loop.md`. The YAML frontmatter is runtime state, not a user-authored config file, but these fields help when you inspect or recover a run.

| Field | Meaning |
| --- | --- |
| `running` | Whether Ralph considers the loop active. |
| `iteration` | Current iteration number. |
| `max_iterations` | Iteration cap from `/ralph-loop`. |
| `started_at` / `completed_at` | Run timestamps. |
| `stop_reason` | `complete`, `max_iterations`, `user_cancelled`, `manual_stop`, `error`, or `null`. |
| `session_id` | Pi session that owns the current iteration. |
| `last_session_file` | Last known Pi session file. |
| `error_count` | Provider/session error count. |
| `transitioning` | Ralph is between sessions. |
| `cancel_requested` / `stop_requested` | User stop flags. |
| `bundle_mode` | Whether `.ralph/prompt.md` bundle checks apply. |
| `loop_token` | Run identity used to avoid stale transitions. |
| `model_provider`, `model_id`, `thinking_level` | Model and thinking level Ralph replays for the next fresh iteration. |
| `bundle_*`, `items_*`, `progress_*`, `source_doc_hashes`, `git_head` | Bundle snapshots used to validate promises. |
| `bundle_rejection_count` | Rejected bundle promises in the current iteration. |
| `limit_reminders` | Context-limit reminder thresholds already sent in the current iteration. |
| `external_gate_entrypoint_digest`, `immutable_bundle_digest` | Saved guard identities checked at every hook and resume. |
| `external_gate_stop_dispatched`, `external_gate_stop_pending`, `external_gate_stop_reason`, `external_gate_error` | Retryable stop intent, result, and recovery state. Successful same-token resume resets the terminal event before later work. |
| `external_gate_cleanup_pending` | Failed COMPLETE-only cleanup. New loop and restart admission reconcile it before replacing the token. |

The prompt body lives below the frontmatter. `/ralph-resume` and `/ralph-restart` reuse it.

## Safety

While a loop runs, the extension blocks `/resume`, `/new`, `/fork`, and `/tree` in that Pi instance. Open another Pi instance to inspect old iterations while Ralph keeps running.

Some third-party tools open custom human-input UIs and then wait forever until a person answers. Ralph cannot reliably recover after such a tool has already started, because Pi does not expose a generic "this tool is waiting for a human" signal and some custom UIs ignore abort. Prevent known blockers with a user-owned tool-name list:

```bash
export RALPH_BLOCKED_TOOLS=tool_name_1,tool_name_2
pi
```

For example, if an installed tool is useful in normal Pi sessions but unsafe for unattended Ralph runs, put that tool's exact name in `RALPH_BLOCKED_TOOLS`. Ralph only blocks the configured tool while `.ralph/loop.md` says a loop is running in the current workspace. Normal Pi usage outside a running Ralph loop is unaffected.

Ralph waits through Pi's provider retry handling and malformed terminal stops before it acts. If Pi still cannot produce a normal turn, Ralph sends up to five same-iteration recovery nudges, then starts one fresh fallback session for that iteration. If the fallback also exhausts recovery, Ralph stops as a resumable error. Missing-promise turns receive a control-tag prompt instead of a bare `continue`. User input cancels pending recovery countdowns. User aborts stop the loop before the next iteration starts. Stale state resets on startup.

If you launch Pi through RPC, an API wrapper, or a subprocess, keep that Pi process and its stdin open for the whole Ralph run. A one-shot wrapper that sends `/ralph-loop` and then closes stdin tells Pi to quit; Ralph may accept `<promise>NEXT</promise>` but the host can exit before the fresh-session handoff runs. If this happens, run `/ralph-resume` from a long-lived Pi session.

When a running iteration reaches 75%, 80%, and 85% of the active model context window, Ralph sends a hidden `ralph_limit` Pi custom message reminding the agent to preserve the original instructions and use the existing `WAIT`, `NEXT`, or `COMPLETE` promise contract when appropriate. Set `RALPH_LIMIT_REMINDERS_DISABLED=1` to opt out.

## Development

```bash
npm test
npm run test:live
```

`npm test` covers parser, state persistence, command/event wiring, bundle gates, and loop orchestration.

`npm run test:live` runs live RPC integration tests against Pi. See [tests/live-e2e-testing.md](tests/live-e2e-testing.md) for the live-test workflow.

## Credits

- [Geoffrey Huntley](https://github.com/ghuntley), creator of the Ralph Wiggum loop technique
- [Matt Pocock](https://github.com/mattpocock), author of Ralph workflow guidance
- [Anthropic](https://github.com/anthropics), long-running-agent harness research

## License

MIT
