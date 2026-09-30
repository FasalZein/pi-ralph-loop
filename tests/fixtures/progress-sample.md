# P0 blocked: preview coverage
- Selected preview coverage because it determines the next gate.
- Failing check: `npm run preview` exit 1. Exact blocker: `preview unavailable`.
- Diagnosis: The runner has no preview display.
- Repair attempts: Tried the headless preview.
- Parent must provide a preview runner.
- Remaining steps not run: preview and publish.

# G01 passed: baseline (2026-09-20)
- Selected the baseline to preserve existing behavior.
- Checks: `npm test` exit 0: 24 tests passed; `npm run types` exit 0.
- Before/after: warnings 4 -> 0.
- git diff --stat: 2 files, 8 insertions and 1 deletion.
```text
IDENTICAL config
IDENTICAL schema
```
- Evidence: /tmp/example/baseline.log

# G02 blocked: fixture (2026-09-21)
- Failing command: `npm run verify` exit 2.
- Exact error: `missing fixture`.
- Diagnosis: The local input is absent.
- Repair attempts: Checked the fixture directory.
- Question for parent: Approve a generated fixture?
- Assumption: The fixture can be generic.

# G02 passed: fixture (2026-09-22)
- Checks: `npm run verify` exit 1; rerun exit 0: 28 tests passed.
- Evidence: /tmp/example/fixture.log

# G03 passed: input validation (2026-09-23)
- Checks: npm test exit 0.
- Before/after: errors 3 → 0.

# G04 passed: paths (2026-09-24)
- Checks: `npm run types` exited 0.
- Evidence: paths.diff

# G05 passed: handoff (2026-09-25)
- Selected the handoff because later work depends on it. This long single-line bullet describes the input boundary, the append-only file contract, the retained evidence, the absence of a fixed schema, and the decision to keep unrelated work unchanged while making one verified update.
- Assumption: Appends preserve file order.
- Checks: `npm test` exit 0.

# G06 blocked: display (2026-09-26)
- Failing check: `npm run display` exit 1.
- Exact blocker: No terminal fixture.
- Diagnosis: The display needs a terminal fixture.
- Repair attempts: Tried a plain output capture.
- Decision for parent: Supply a terminal fixture.

# G06 passed: display (2026-09-27)
- Checks: `npm run display` exit 0.
```text
IDENTICAL frame
CHANGED footer
```

# G07 passed: empty input (2026-09-28)
- Checks: `npm test` exit 0.
- Before/after: failures 1 -> 0.

# G08 passed: partial input (2026-09-28)
- Checks: `npm run types` exit 0.
- Evidence: partial.status

# G09 passed: controls (2026-09-29)
- Checks: `npm test` exit 0.
- Assumption: Raw evidence is sanitized by the viewer.

# G10 passed: proof (2026-09-29)
IDENTICAL input
IDENTICAL output
- Evidence: proof.diff

# G11 passed: audit (2026-09-30)
- Checks: `npm run audit` exit code 0: 12 checks passed.
- git diff --stat: 1 file, 4 insertions and 0 deletions.

## G12 BLOCKED (2026-09-30)
- Failing command: `npm run release` exit 1.
- Exact blocker: Signing key unavailable.
- Diagnosis: Release needs signing credentials.
- Repair attempts: Checked the local environment.
- Parent must supply signing credentials.
- Remaining steps NOT RUN because release needs credentials.
Exact executed gate/action command exits and seconds:
```text
types exit=0 seconds=2 command=npx tsc --noEmit
tests exit=0 seconds=1 command=npm test
release exit=1 seconds=1 command=npm run release
```
- Evidence: /tmp/example/release.log
