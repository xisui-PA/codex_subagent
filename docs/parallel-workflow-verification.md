# Parallel workflow verification record (2026-11-23)

Dated record for the opt-in parallel workflow. Report date is 2026-11-23 in
America/Los_Angeles; raw runs were captured on 2026-11-24 UTC, so raw log
timestamps are one day later. The record names inputs, artifacts and hashes, and
keeps executed results separate from the scope boundaries stated at the end.

Status: **experimental and opt-in.** Features stay behind their User settings,
all `false` by default. No package version and no capacity default changed in
this work. No Git commit was made. Release disposition is unchanged: no release
while the concurrent-pool failure below is open and while the missing platform
checks are outstanding.

## Inputs

| Input | Value |
| --- | --- |
| Node.js | 26.13.0 |
| npm | 12.2.2 |
| Git | 2.56 |
| VS Code | 1.146 (installed at `C:\Program Files\Microsoft VS Code\Code.exe`) |
| OS | Windows 10.0.26300.9974 |

Subjects reviewed and applied: guidance seal `parallel-workflow` version 65
(`codex-subagent://submission/b70ea870ac6351ac08d104f6841096ecc5b67bcdf788ece3db87cb86b5faa37d/156aa4b89a066920f28161ebf5cd24a0ed0b6a46723d18a7e657c55f9abde91b/65`)
and benchmark submission version 87, whose README revision is hash
`d48c720336fab152e486df885077d6af16c1330c3efe849a28b290a1cd4f6739`. The
benchmark script itself is identified by file SHA-256
`e731fed9d07478df4055cf42ec05875b441f463c0c858b30aceb4943001c5ef9`; that value
is a script hash, not a Git object and not a commit. Metrics and raw hashes live
in the benchmark README, which this record links instead of duplicating.

## Review corrections (2026-11-24 local; 2026-11-25 UTC)

Three accepted review findings were corrected after these runs. They change one
derived metric's calculation and instruction text only; no runtime behavior, cap
or historical number changed.

- `benchmarks/parallel-workflow.cjs` now reports
  `pool.effectiveConcurrentWorkRunners` as the smaller of the local and the
  aggregate work ceiling
  (`min(capacity - (capacity > 1 ? 1 : 0), runnerCapacity - serviceReserve)`),
  matching `src/resource-governor.ts`. The recorded benchmark tables were produced by
  script SHA-256 `e731fed9…` and remain **historical**; they were not re-run, and
  their observed effective work concurrency of 1 is unchanged.
- Blocker wording now states that blockers gate the board's start, submission and
  acceptance transitions in every board task, while automatic execution gating
  covers only governed create-bind-start workers. A worker bound with only the
  board and view flags can still perform a private edit while blocked, so the
  coordinator must withhold send, resume and dispatch itself.
- Line-ending wording now separates `patch_file` old/new-text normalization from
  the verbatim whole-file `write_file`, where the caller retains BOM and EOL
  responsibility.

New focused checks for these corrections are recorded in
`.artifacts/fix-step7-20261124/result.json`. No benchmark performance number,
historical artifact hash, cap or platform check was re-measured or relabelled.

## How to reproduce

Commands are the repository's own documented scripts.

```sh
npm ci
npx tsc -p tsconfig.json --noEmit
npm run lint -- --ignore-pattern .artifacts/**
npm run build          # production webpack build
npm test               # build + build:test + node --test "tests/*.test.cjs"
npm run test:host      # real installed VS Code; set VSCODE_EXECUTABLE if needed
```

The focused workflow case runs as
`node --check tests/parallel-workflow.test.cjs && node --test tests/parallel-workflow.test.cjs`.
Benchmark procedures and flags come from the benchmark README at the revision
above.

## Executed results

| Check | Artifact | Observation |
| --- | --- | --- |
| Host integration, real installed VS Code extension host, all three profiles (workspace, empty, locked) | `.artifacts/step7/host-strict-final.log`, SHA-256 `a3f095a94f8ac437e36bba80bfb2d9e63ad809d5e3a289c359c7abb714e018bc`, written UTC 2026-11-24T07:15:41.819Z | PASS, exit 0, no timeout, no SIGTERM, cleanup success. This is a new run whose source differs from the earlier one; the hash matches the old log only because the launcher emits the same fixed three pass lines |
| Host test sources actually tested | `tests/host/parallel-workflow.cjs` `0aa022854b893ddf059af413fdd48b19e4713cc8db5c4109b52cc5645d8ef37e` (LF), `tests/run-host-tests.cjs` `3ef322b0e50ff954436a4e1f0c8a7798608ab81588dc093c9d84b5efd46a260e` (CRLF), `tests/host/index.cjs` `78518c3b61a22d4f6e56cb4120b93b3237090da4db50a72b43f0f827389e656a` (CRLF) | Hash-verified content of the strict run. The index and launcher edits are comment-only corrections: only the model and approval policy are scripted, and only unset scenarios select all while an explicit empty value rejects; `onError` is now collected everywhere and the host asserts an unfiltered empty error list |
| Targeted host lint and syntax | `.artifacts/step7/lint-targeted-host-r5.log`, SHA-256 `1980b3707136dbb1fb1eeb31e785527098ed7229dbb77d764ecb24475330d1f7` | `npx eslint` on the three host files and `node --check` each exited 0 |
| Superseded host log | `.artifacts/step7/host-all-r5.log` | Earlier host run, kept only as history; every host statement in this record now refers to the strict run above |
| Final focused gate | `.artifacts/step7/flow-v53-gated-r3-strict-errors.log`; test file SHA-256 `9d0b6724a5db9993db500bde62776a5551a956c4f0f9e6c0e7536e9e91fd6113` | `node --check` plus `node --test` exited 0 with no timeout: 1 pass, 0 fail, 0 skip; test 47726.1314 ms, total 47880.0533 ms |
| Focused case, earlier pre-gate variant | `flow-v53-focused-r7-final.log`, SHA-256 `cf1436bfad3259a4db504c36a91d43b9bf58f706aaca3a3c6315fc3516cd1310` | Passed 1/1 in 47.158 s on the pre-gate variant; superseded by the gate above |
| Typecheck | `.artifacts/step7/typecheck-r2.log` | `npx tsc -p tsconfig.json --noEmit` exited 0 |
| Repository lint | full lint log | `npm run lint -- --ignore-pattern .artifacts/**` exited **1** with 19 errors: 2 in generated `.test-build` output, 17 on pre-existing tracked lines. Full lint is **not** green. No step-7 benchmark or new-fixture lint error appears in the full log; the one affected tracked edit is the `src/engine.ts` instruction header, and its offending `prefer-const` line 1349 is unchanged |
| Targeted fixture lint | `.artifacts/step7/lint-targeted-r2.log` | `npx eslint` exited 0; the log was written at 07:07:02.722Z and covers the strict test file `9d0b6724…`, so it applies to the final fixture |
| Portable suite | `.artifacts/step7/npm-test-r1.log` | Summary COMPLETE: 1261 tests, 1246 passed, 15 skipped, 0 failed, 0 cancelled, 203331.987 ms. The artifact predates only the stronger Node diagnostics assertion and the strict host file change, and the host helper is not part of the `node --test` glob, so the passing focused gate above covers the remaining difference and no source changed after the comprehensive build |
| Suite groups g1–g4 | `.artifacts/step7/suite-g1.log` … `suite-g4.log` | Each group passed with a normal exit 0 |
| Suite groups g5, g5a | `.artifacts/step7/suite-g5.log`, `.artifacts/step7/suite-g5a.log` | Completed with 0 failures, but the invoking tool also hit its timeout |
| Production webpack build | `.artifacts/step7/build-dist-r1.log`, SHA-256 `4f69d27fe66e9d429770bd626943fc2f1eee903aca2ba15577e6818adad50dc4` | Exit 0 |

The full-suite invoking command hit its 120 s deadline and was terminated with
SIGTERM; the run then completed, and its COMPLETE 203331.987 ms summary is the
recorded outcome. Completion of the artifact is recorded, while a green tool exit
is not claimed for that invocation. The same applies to g5/g5a.

The final focused gate asserts the unfiltered `state.errors` array is empty, so
no keyword filter can hide a diagnostic. The gate holds physically before the
second command is queued, waits for the started marker, and releases only inside
the owned runner; cancellation never releases the gate.

What the host suite exercises: real extension API wiring for User settings,
snapshots and editor content, the broker, physical Windows runners, and
publication with its journal. Model responses and the approval policy are
scripted, so this record claims no provider answer quality and no
approval-dialog behaviour. The launcher writes only the three emitted pass lines
on success and prints verbose host internals only on failure, so no full verbose
host log is claimed.

## Coverage of the focused fixture

One workflow drives: two governed workers isolated before their first model call,
a structured contract plus its board agreement, private edits, an exact composed
dependent seed, retained producer version results, a bounded pool, combined
integration evidence with accept and apply preserving intervening notes and
replay edits, a gated queue with cancellation, a reloaded uncertain attempt that
is never replayed, and legacy compatibility. Node process behaviour and the
physical Windows runner are real; the reload and cancellation orchestration is
driven by deterministic fixtures rather than a live crash.

The new focused case does **not** exercise quarantine or
`subagent_runner_cleanup`; its gate cleanup is test scaffolding, not runner
recovery. Quarantine retention, drain proof and cleanup reclamation are covered by
the existing runner and resource suites inside the full portable test run above,
and that coverage is mostly unit-level rather than a live end-to-end crash. The
operating guide's recovery instructions describe the implemented behaviour and
are unchanged by this record.

POSIX execution is unavailable here: no WSL, no live Linux and no macOS. Existing
POSIX branches are skips or fixtures, never a live pass. The 15 skips of the
portable suite break down as 12 POSIX-only cases, 1 file-symlink privilege case,
and 2 shell or process-group platform skips.

The host run removed its own temporary directories. One earlier pre-retry
profile is deliberately retained at
`C:\Users\suixi\AppData\Local\Temp\cw-host-KOLBDF` with 8 files after an `EBUSY`
on `exthost.log`, and the owner report records it. That retained cleanup artifact
is separate from the three-scenario PASS: the pass result does not imply every
temporary directory was removable.

## Benchmark observations

Numbers, per-scenario tables and raw hashes are in the benchmark README at the
revision above. What that run established:

- **Smoke, 40 sources, 2 workers, capacity 2:** workflow 44.478 s, normal exit 0.
- **Default, 600 sources, 4 workers, capacity 2:** workflow 135.191 s, process
  136.458 s, complete with status ok in the artifact, while the wrapper hit its
  120 s SIGTERM. Again an artifact completion, not a normal green exit.
- Speedups 0.95 and 0.742, effective work concurrency 1 at a root capacity of 2
  with a service reserve of 1.
- Lease totals are 6 for smoke and 10 for default, and each total includes the
  serial baseline. Per lease, the fresh non-linked installed dependency measured
  5375 B with a tiny dependency `node_modules` of 5690 B and a tarball of 1019 B
  captured with no outside path. Pack runs once before the snapshot and is
  excluded from the timer; the archive is materialized per lease and installed
  afresh.
- Storage for the default scenario: 614 files and 2,654,592 B captured, snapshot
  built in 3.058 s, view store 2,876,945 B, overlay 1655–1656 B per worker.

Scope: a synthetic non-Git fixture with an offline tiny npm archive, no
inference, no network and no large dependency tree. No cap was raised and no disk
quota was applied.

## Open failure: concurrent pool

A capacity-3 attempt on the same 600-source/4-worker scenario failed with exit 1
after 49.750 s. Two of four producer commands succeeded, drained and left the
view unchanged; the remaining producer commands and the integration stage were
not reached, so **no throughput result exists for that scenario**
(`benchmark-parallel-pool-no-baseline.json`, SHA-256
`2ce5798051c9551ea0ab0bd39a142584b024084be035f524e42a1d6c5bbb34e7`).

The origin review recorded an `EPERM` on a directory scan of another lease during
cleanup (`windows-eperm-origin-review.json`, SHA-256
`90a91bf1fb9cf6ec60a617ad4e3100ebfbf5093d7d0761af16752d8d703c8f7d`). The
leading hypothesis is a whole-store storage census racing cleanup. The original
filesystem stack is unavailable, so the cause is **unproven** and no specific
throwing call is asserted. Both admitted leases were released with no quarantine
and no orphans, so the release path held; the cause stays a release concern until
proven.

## Owner report and process observation

The final owner report `.artifacts/step7/flow-executable-owner-r5.json` is
COMPLETE, written at actual UTC 2026-11-24T07:15:56.711Z. It records the strict
host run, all four final identities with their commands and log hashes, and the 15
skip entries. Its predecessor `flow-executable-owner-r2.json` (UTC
2026-11-24T07:07:34.718Z, hash prefix `d08e68a4`) covers the earlier state, and
`flow-executable-owner-r4.json` (SHA-256
`b791a359a34402d88bd8bd6c8d7d8d09aea5adb2798d2c2fe807918d06b5f45e`) carries the
owner-side process-identity review. Full hashes for the r5 report belong to the
final review manifest, so no complete value is stated here.

The final Node fixture remains `9d0b6724…` with its 47.8800533 s focused pass.
Targeted lint of that fixture was captured at 07:07:02.722Z, after the strict
patch, so the final fixture has a passing targeted lint and no test-lint item
remains open.

A separate parent read-only, unsandboxed Win32_Process inspection at
2026-11-24T07:09:39.7219727Z found 0 matching `node --test`, host-launcher or
benchmark commands, and mutated no process; it is retained as
`coordinator-process-observation.json`. A first attempt through restricted CIM was
denied, and that empty result was discarded; the second read succeeded with
`ErrorActionPreferenceStop`. That supports only what it observed: no matching
top-level verification command was running at that instant. It is not an
all-descendants OS proof, and the source-worker process count of 10 before and
after is likewise not full OS identity proof. Owned isolated commands prove
Job-Object drain separately, through their stored results. All queues were drained
when the primary stopped.

## Scope boundaries

Executed results above stand as recorded, with no pending report, process proof or
targeted-lint item. What remains are known release concerns, not missing evidence:

- the capacity-3 concurrent-pool `EPERM` failure and its unproven cause;
- unavailable live POSIX execution;
- repository lint at 19 pre-existing errors, and the non-green wrapper exits on
  the long suite and benchmark invocations;
- scripted model and approval policy in the host suite, which says nothing about
  provider answer quality or approval-dialog behaviour.

Release disposition: experimental and opt-in until the concurrent failure is
resolved and the missing platform checks are done.

## Evidence retention

`.artifacts/step7/*`, the origin review and the benchmark JSON are retained local
session evidence. They are not guaranteed to exist in a checkout, so a reader who
needs them must obtain them from the session that produced them; they are
referenced by name and hash only.

## What this record does not claim

No claim of live POSIX execution, provider answer quality, approval-dialog
behaviour, a raised capacity default, a raised disk quota, or a verified release
of the parallel workflow. The workflow stays experimental and opt-in.
