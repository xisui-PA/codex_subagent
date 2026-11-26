# Parallel workflow benchmark

`benchmarks/parallel-workflow.cjs` is a reproducible, representative end-to-end
benchmark of this extension's parallel fan-out workflow. It drives the
production runtime - a real `WorkerBroker`, the durable task board, private
isolated views (snapshot, per-worker overlays, sealed submissions), the physical
runner pool with its immutable result store, the resource governor and one
coordinator integration attempt - against a generated many-file Node project in
an OS temporary directory. Only the model is scripted: an in-memory provider
returns the next queued tool call, so no inference, credential or network access
is involved.

It is **not** a model-inference or token-throughput benchmark, and it is not a
sample of any real repository. It measures the workflow machinery around
parallel workers: snapshot and overlay storage, per-lease materialization, real
dependency installation, queueing, and integration effort.

## Prerequisites

- Node.js and npm on `PATH` (the same runtime that runs the benchmark is used
  inside every runner lease).
- A compiled test build. The benchmark only reads it; it never writes build
  output and never touches the shared `.test-build` tree:

  ```sh
  npm run build:test
  ```

  Set `BENCH_TEST_BUILD` (or `CODEX_TEST_BUILD`) to use another existing compile
  directory instead of `.test-build`.
- No network access is required. The project's only dependency is a local
  package **archive** (`file:./bench-local-fixture-1.0.0.tgz`) packed inside the
  fixture, which every lease installs with npm.
- An npm with `npm pack` and `--ignore-scripts` support (npm 7 or newer).
- One npm behaviour decides the fixture design: **a folder `file:` dependency is
  installed as a `node_modules` junction, not a copy** (observed on npm 12.2.2 /
  Windows) even with `--install-links` and even with a lockfile. The benchmark
  therefore installs a real local package **archive** that is packed inside the
  fixture, which npm always installs as a plain copied directory.

## Invocation

```sh
# default: 4 units, pool capacity 2, 120 generated files, sequential baseline
node benchmarks/parallel-workflow.cjs > .artifacts/step7-benchmark.json

# smaller smoke run
node benchmarks/parallel-workflow.cjs --files 40 --workers 2 --capacity 2

# larger run without the serial baseline (faster, no speedup number)
node benchmarks/parallel-workflow.cjs --files 400 --workers 6 --capacity 3 --baseline none

# also write the JSON directly (stdout stays machine-readable either way)
node benchmarks/parallel-workflow.cjs --json-out .artifacts/step7-benchmark.json
```

`stdout` carries exactly one JSON document; progress and diagnostics go to
`stderr`, so a plain shell redirect is enough to capture the report. The process
exits `0` only when the whole workflow succeeded (every install was fresh, the
verification command passed on the composed seed, integration validated and,
unless `--skip-apply`, published). Exit code `1` means the run failed and its
JSON documents the error; exit code `2` means the invocation or the compiled
build was unusable.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--files <n>` | `120` | generated source files (10-2000), spread over `src/core`, `src/features`, `src/lib`, `src/util`, `src/runtime` |
| `--file-bytes <n>` | `900` | approximate size of each generated source file (64-65536) |
| `--workers <n>` | `4` | parallel units and producer workers (1-8) |
| `--capacity <n>` | `2` | runner pool slots (1-8, the production maximum) |
| `--max-queue <n>` | `32` | runner queue bound (0-256) |
| `--baseline <sequential\|none>` | `sequential` | measure a comparable serial baseline |
| `--timeout <ms>` | `120000` | per-command runner timeout (1000-120000), applied to every scripted `run_command` |
| `--wait-budget <ms>` | `600000` | benchmark-side cap for waiting on a worker round |
| `--npm <command>` | `npm` | npm executable used inside each lease |
| `--seed <n>` | `1` | deterministic content seed |
| `--skip-apply` | off | stop after `accept`; no live publication |
| `--keep` | off | keep the temporary fixture even on success |
| `--json-out <file>` | - | also write the JSON report to this path |

All bounds are validated. The benchmark never raises a production cap: pool
capacity stays within `1-8`, `maxQueue` within `0-256`, per-model
`numSessions` stays within its schema ceiling `1-8`, and the resource governor
runs with its own defaults (`resourceDefaults`, enabled).

### Effective concurrency is lower than `--capacity`

Two independent limits decide how much really runs at once, and both are
reported (`pool.model`, `pool.effectiveConcurrentWorkRunners`):

- **Model sessions.** `--workers 8` requests 8 producer workers, and the run
  reserves `min(8, max(4, workers + 2))` sessions on the single fixture model.
  The schema ceiling is 8, so `--workers 8` reserves exactly 8, not an
  out-of-schema 10. `pool.model.clamped` records whether the request was clamped.
- **Governed runner admission.** Two separate slot limits apply, and the smaller
  one wins:
  - this root's own pool reserves `serviceReserve` (default 1) of its
    `--capacity` slots, so `capacity 2` leaves **1** work runner at this root;
  - the aggregate governor reserves `serviceReserve` of `runnerCapacity`
    (default 4), which permits **3** work-runner slots across all roots.

  With the default configuration the effective work concurrency is therefore
  `min(1, 3) = **1**`: the remaining workers wait in the bounded queue.

`pool.effectiveConcurrentWorkRunners` is that **configured ceiling**, never an
observed concurrency: it is `min(capacity - (capacity > 1 ? 1 : 0),
runnerCapacity - serviceReserve)`, a single-slot pool keeps its one slot, and a
real run can still be lower because edits and seals are driven serially and
further work queues. Under the governor defaults (`runnerCapacity 4`,
`serviceReserve 1`) `--capacity 1..8` reports `1, 1, 2, 3, 3, 3, 3, 3`; a lower
configured aggregate `runnerCapacity` lowers those values, and `--workers` never
raises the ceiling.

So a default run measures a real queueing workflow, and `queue.samples` /
`workers[].timings.leaseWaitMs` are expected to be non-trivial.

Raising a limit is **not** presented here as a remedy. Concurrency is governed
by the configured service reserve, so measure what the reserve actually leaves at
this root and in the aggregate before changing anything. A higher `--capacity`
is also unproven: `--capacity 3` was attempted and failed - see
[Capacity 3 failure](#capacity-3-failure).

## What one run does

1. Generates a deterministic project in `os.tmpdir()`: `src/**` modules, one
   `shards/shard-NN.cjs` per unit, a dependency source folder (`local-fixture/`),
   and three generated tools (`tools/bench-lib.cjs`,
   `tools/install-and-build.cjs`, `tools/verify.cjs`).
1a. **Fixture preparation, once, before the snapshot:** packs that source folder
   into `bench-local-fixture-1.0.0.tgz` *inside the project*, and points the
   project's `package.json` at `file:./bench-local-fixture-1.0.0.tgz`. The
   archive is ordinary fixture content, so the snapshot captures its raw bytes
   and every lease materializes it; no path outside the fixture is referenced.
   Packing executes exactly once, before the snapshot is captured, so its cost
   is reported as `project.packMs` / `project.dependency.sourceArchive` outside
   the workflow timer (`endToEnd`). That exclusion is about the one-time
   preparation step only: every lease still materializes the captured archive
   and installs it afresh.
2. Creates a team and one immutable base snapshot through
   `subagent_snapshot_create`.
3. Creates one board task per unit plus a validation task and a baseline task.
4. For each unit in turn: `subagent_isolated_spawn` binds a private overlay to
   the base snapshot, the worker writes its own shard (`write_file`), the
   benchmark censuses the private view store, and the worker seals revision 1
   (`seal_submission`). Edit turns are driven one at a time so each worker's
   overlay growth is attributable.
5. Submits every sealed artifact to the board (`in_progress` -> `submitted`).
6. Queues one `run_command` turn on **all** units at once. Each command is
   `node tools/install-and-build.cjs`, which runs a real npm install of the
   local dependency and then rebuilds the whole project inside that lease.

   The exact install flags, in this order, are:

   ```
   npm install --no-audit --no-fund --no-package-lock --offline --ignore-scripts --loglevel=error
   ```

   and they install the in-fixture archive `file:./bench-local-fixture-1.0.0.tgz`.

   - The dependency is an **archive**, not a folder. Installing a `file:` tarball
     makes npm copy a plain directory into `node_modules` on Windows and POSIX,
     so the installed bytes are real and measurable. A folder `file:` specifier
     would instead be junctioned on Windows (observed on npm 12.2.2, even with
     `--install-links` and a lockfile), which is why it is not used.
   - `--ignore-scripts` refuses ambient lifecycle scripts in the install (the
     archive declares none); the same flag is used for `npm pack`.
   - `--offline` means no registry access and no package downloads.

   Every lease materializes a fresh copy of the view, so `node_modules` and
   `build/` are proven absent before the run, appear only inside that lease, and
   are never imported back into the overlay (the runtime treats `node_modules`,
   `build`, `dist`, `coverage` and `vendor` directories as ephemeral output).
   The driver fails the run if `node_modules/<name>` is a symlink or reports
   zero bytes, so "installed" always means really installed.
7. Runs a second command on unit 1 as a **freshness probe**: it must install the
   dependency from scratch again, proving installs are per lease and never
   reused across commands.
8. Runs one coordinator integration attempt over all submitted artifacts:
   `begin` (composing a derived seed and reporting conflicts), a validation-lane
   worker that seals the unchanged seed at revision 0 and runs
   `node tools/verify.cjs`, then `candidate`, `validate`, `accept` and (unless
   `--skip-apply`) `apply`. The verification command installs the dependency
   afresh, rebuilds the bundle, and proves every producer contribution is
   present with the exact expected SHA-256 and the installed dependency banner.
9. Optionally repeats the same units serially on one worker (edit, seal, install
   and build) as the comparable baseline.

## Scripted model routing

Every worker runs with the same single scripted provider, so one turn must be
routed to exactly one worker's queued tool call. Routing uses **only the last
coordinator plain-text turn** of the prompt:

- Only `text` parts of a `user` message are coordinator prose. Tool **call**
  inputs (`call` parts) and tool **result** text (`result` parts) are excluded,
  even when they share a message with coordinator text.
- The newest such turn must name **exactly one** registered token
  (`[bench #N]`, `[bench validation]`, `[bench baseline]`). A tag that matches no
  token, or more than one, fails the turn with an explicit routing error; there
  is no precedence rule that silently picks a winner.
- An empty queue for the routed worker ends the turn with a plain `done`. No
  other worker's queue is ever consulted, and an unroutable prompt fails the
  turn loudly instead of running somebody else's action.

This matters because history is real: the sequential baseline worker edits every
shard, so its transcript accumulates earlier `write_file` inputs whose content
contains producer tags such as `[bench #1]`. Scanning the whole serialized
transcript would select a stale producer queue; scanning the newest coordinator
turn cannot. `board.routing` in the report records the routed/finished counts and
the distinct tokens that were used.

## What is measured

Measured directly:

- `snapshot.createMs`, `snapshot.manifestJsonBytes` (the immutable manifest JSON
  blob addressed by the returned `manifestHash`), the private view index JSON
  size before/after, and the bytes/files the snapshot added to the view store.
- Per worker: overlay growth in bytes/files and entries added while that
  worker's edit applied, plus revision/seal timing.
- Per lease: `installMs` and `buildMs` measured inside the lease, installed
  `node_modules` bytes/files, the real copied dependency bytes/files
  (`fresh.dependencyInstalledBytes`, `fresh.dependencyInstalledFiles`) and
  whether the dependency was installed as a symlink (`fresh.dependencyLinked`
  must be `false`), materialized project bytes/files, and whether the build and
  dependency were really absent before the run.
  The exact install command, flags and archive identity are echoed in the report
  (`project.dependency`, `workers[].install.args`, `snapshot.dependencyArchive`).
- Per lease derived from durable event timestamps:
  - `leaseWaitMs` = lease `createdAt` - benchmark request timestamp. This is an
    upper bound and **not** pure queue wait: the scripted model turn that had to
    run before the command could be queued is included, so it over-reports
    queueing.
  - `setupToDriverMs` = `attempt.startedAt` -> driver process start. This is a
    combined lease-setup wall time, **not** isolated-view materialization alone:
    it also contains the command-approval round trip and the process spawn.
  - `postProcessMs` = driver finish -> `completedAt` (import decision, durable
    result write, lease release) and `runnerTotalMs`.
- Queue samples with timestamps taken every 100 ms during the parallel round
  (`subagent_runner_status`, kind `queue`): observed queue length and active
  slots.
- Integration: `beginMs`, conflict paths, candidate/validate/accept/apply
  timings, the verification command's outcome and payload, and the applied paths
  verified byte-for-byte on disk.
- Whole-run wall time (`endToEnd.brokerStartToBeforeCloseMs`, plus
  `processTotalMs`) and the parallel/sequential comparison.

Fixture preparation is measured, but reported as its own step rather than as
lease cost: `project.packMs` and `project.dependency.sourceArchive`
(`{ path, source, spec, bytes, sha256, gzipMagic, packCommand, packArgs,
packMs, capturedBySnapshot }`). The one-time pack is excluded from `endToEnd`;
every lease's install, storage and timing is measured per lease.

The `definitions` object in the report restates each derived metric. Anything
that could not be measured is `null` **and** listed in `unavailable` with a
reason - for example `network.downloadBytes` (a local archive downloads
nothing), `cpuTime` (the runner records wall times only) and
`snapshot.durationBreakdown`. No number in the report is estimated or invented.

## Reading the result

```
status                 ok | failed
runtime                node/platform/arch/npm/build directory provenance
project                generated file count/bytes/digest, capturedFiles/capturedBytes,
                       packMs, dependency provenance incl. sourceArchive
                       {path, bytes, sha256, gzipMagic, packMs, capturedBySnapshot}
pool                   workers, capacity, maxQueue, governor config, capsRaised:false,
                       model numSessions + clamp, effectiveConcurrentWorkRunners
board                  task counts, approvals, errors, scriptedModelRequests,
                       routing (tool calls routed, turns finished, tokens used)
snapshot               createMs, manifestJsonBytes, view index bytes, storage added
workers[]              per lease: import decision, timings, fresh-install proof,
                       real dependency bytes/symlink proof, build evidence,
                       result ref
queue                  sampled queue length/active slots (with timestamps)
parallel               units, edit phase, runner round, wall time, units/second,
                       install totals, node_modules and dependency bytes
freshnessProbe         second lease of unit 1, installed from scratch again
integration            begin/validate/accept/apply timing, conflicts, validation
sequential             serial baseline wall time, per-unit command/install times
comparison             speedup (wall time and command-round)
storage                final view store / runner store bytes, overlay growth total
endToEnd               broker-start wall time and total process time
cleanup                broker close time, whether the temp fixture was removed
```

A healthy run reports `status: "ok"`, `pool.capsRaised: false`, empty
`integration.conflicts`, `fresh.before: true` and `fresh.dependencyLinked:
false` with nonzero `fresh.dependencyInstalledBytes` for every lease,
`board.routing` incl. `[bench baseline]`, a non-null `sequential`/`comparison`,
and `integration.validation.verify.ok: true`.

## Limits and honest scope

- Scripted model only; no inference, throughput or quality claim.
- The project is synthetic and deterministic, not a real repository.
- The dependency is a local archive, so install cost includes npm's real unpack,
  placement and tree work but **no** package downloads. Only the manager
  download cache directory is shared between leases.
- Install cost is therefore a representative npm install of a small local
  package, not of a large registry dependency graph.
- The one-time `npm pack` is fixture preparation: it executes once before the
  snapshot and is measured and reported, but excluded from the workflow timer
  (`endToEnd`). Every lease still materializes the captured archive and installs
  it afresh; the exclusion covers only the one-time preparation.
- The archive is generated by the host npm, so its exact bytes (and
  `sha256`) can vary between npm versions; the report records the hash it
  actually captured instead of assuming one.
- Producers touch disjoint paths, so integration is measured conflict-free; the
  benchmark never injects merge conflicts.
- Nothing outside the OS temporary fixture is written. The benchmark only reads
  the compiled build it is pointed at.
- On success the temporary fixture is removed **after** `broker.close()` has
  drained every runner effect. On failure (or with `--keep`) it is retained and
  its path is reported in `cleanup.retainedTmpDir` so the materialized project,
  view store and runner records stay inspectable.
- A directory census never reports a partial tree as a measurement. Only an
  absent census root (`ENOENT`) counts as zero, because the private view store
  and the runner store are censused before a later step creates them; any other
  read failure - on the root, on a nested directory, or a `stat` of a listed
  file - propagates and fails the run (`status: "failed"` with that error)
  instead of reporting smaller storage, overlay-growth or install/build numbers.
- Every broker the benchmark constructs is closed on any exit, including one
  whose `start()` rejected after it had opened the private store and bridge. A
  close failure is reported in `cleanup.closeError` and the run is `failed`; the
  original error is still the one reported.
- The parallel round runs before the serial baseline, so the baseline can
  benefit from a warmer OS page cache; the baseline never benefits from a reused
  `node_modules` tree, because every lease proves the tree was absent.

## Measured results - 2026-11-23 (America/Los_Angeles; raw UTC 2026-11-24)

Source script: `benchmarks/parallel-workflow.cjs`, SHA-256
`e731fed9d07478df4055cf42ec05875b441f463c0c858b30aceb4943001c5ef9` (v73).
Environment: Windows, Node 26.13, npm 12.2.2. **POSIX was not measured.**

Raw JSON artifacts below were generated locally by these runs. They are named
result files, **not** files guaranteed to exist in a checkout:

| Artifact (local path) | SHA-256 |
| --- | --- |
| `.artifacts/step7/benchmark-smoke-r3.json` | `6dda78fa6730045e7bcd8371a954326b49bd1af0cfa441f06cd144607ca36001` |
| `.artifacts/step7/benchmark-default-pool.json` | `670b8cb1ec7d240e3b85f3e5bc01c522fe9883a7ef7b64c16b65b9cd7a6c3191` |
| `.artifacts/step7/benchmark-results-r4-v73.json` (summary) | `b6330568f47d839e4f4aa4f24c031bd7c59160c7179eb67765399d9e8da34b8d` |

| Metric | smoke (2 units, 40 files) | default (4 units, 600 files) |
| --- | --- | --- |
| captured files / bytes | 52 / 68,930 | 614 / 2,654,592 |
| snapshot create | 319 ms | 3,058 ms |
| view store (CAS + index) | 114,225 B | 2,876,945 B |
| view index JSON | 27,920 B | 45,636 B |
| snapshot manifest JSON | 7,837 B | 86,618 B |
| overlay growth per worker | 1,655-1,656 B | 1,655-1,656 B |
| runner store | 46,138 B / 18 files | 76,136 B / 26 files |
| leases / results recorded | 6 | 10 |
| setup-to-driver | 876-1,205 ms | 2,539-3,773 ms |
| npm install (per lease) | 769-804 ms | 780-938 ms |
| build (per lease) | 8-9 ms | 70-83 ms |
| queue wait (upper bound) | 1,430-6,136 ms | 4,808-29,745 ms, mean 17.786 s |
| parallel wall | 15,527 ms | 63,359 ms |
| parallel units/s | 0.129 | 0.063 |
| serial wall | 14,755 ms | 47,009 ms |
| serial units/s | 0.136 | 0.085 |
| observed speedup | 0.95 | 0.742 |
| runner-round speedup | 0.927 | 0.881 |
| workflow, excluding pack | 44,478 ms | 135,191 ms |
| total process / pack | 45,394 ms / 479 ms | 136,458 ms / 473 ms |
| installed dependency per lease | 5,375 B (5,690 B `node_modules`) | 5,375 B (5,690 B `node_modules`) |

Dependency provenance in both runs: one offline in-fixture archive
`bench-local-fixture-1.0.0.tgz`, 1,019 B, SHA-256
`487902e102fc9daeacbce0c3a6981a59f8dea4262514159f357242d6afc6b382`, gzip magic
present, `capturedBySnapshot: true`, `packArgs`
`["pack","./local-fixture","--offline","--ignore-scripts","--loglevel=error"]`.
Fresh-copy proof held in every lease: `fresh.before: true`,
`fresh.dependencyLinked: false`, nonzero `fresh.dependencyInstalledBytes`.

### Reading these numbers correctly

- **Lease counts.** The smoke run recorded **6** leases/results
  (`storage.runnerResultCount`) and the default run **10**, because both include
  the serial baseline. The producer + freshness probe + validation slice is
  **4** (smoke) and **6** (default); those smaller figures exclude the baseline.
- **Integration is not one wall time.** "Integration 1.255 s / 2.069 s" is the
  **sum of the five API decision times** (`begin`, `candidate`, `validate`,
  `accept`, `apply`), not the full integration wall time. Separately measured:
  the combined physical validation command took **4.092 s / 5.745 s**, and the
  validation-lane spawn-and-seal took **1.598 s / 2.731 s**.
- **Effective work concurrency was 1**, not 2 or 4: this root's pool reserves one
  of its two slots for service lanes, and the aggregate governor permits 3; the
  minimum applies. That is why queue wait dominates the parallel wall time.
- **Speedups 0.95 (smoke) and 0.742 (default) are the observed machinery case
  only** - one work runner, real per-lease installs, serial edit/seal turns and
  queueing. They are **not** a general claim that parallel execution is slow or
  fast, and no production cap was raised to change them.
- **Dependency cost is tiny by construction.** Only 5,375 B was installed per
  lease from one small offline archive, so these runs cannot bound the cost of
  dependency-heavy repositories, and they measure no OS disk quota.
- **`capacity 3` was attempted and failed; no throughput was measured.** It is
  an executed failing case, not a planned one - see
  [Attempted `--capacity 3` run](#capacity-3-failure)
  below. No units-per-second, speedup or comparison figure exists for it.
- These are workflow-machinery measurements only: **not** a model-inference or
  network benchmark, and **not** a claim that all workflow tests pass. All feature
  opt-ins remain `false` by default and no production limit was changed.

### Wrapper limitation on the default run

The default invocation (600 files, 4 units, capacity 2) exceeded the worker's
**120 s tool deadline**, and the tool reported `SIGTERM` on the wrapper. The
retained report subsequently showed a complete benchmark run: the report was
written completely with `status: "ok"`, the process recorded exit code 0, the
temporary fixture was self-cleaned (`tmpRemoved: true`), and no orphan process
was left.

That is a statement about the artifact, not about the tool call: the wrapper was
still terminated by its own deadline, so this invocation is **not** a green exit.

Do **not** read that wrapper invocation as a normal green exit. Artifact
completeness is a separate fact from the tool timeout: the JSON above is a
complete measurement of a run that finished, while the invoking tool call was
terminated by its own deadline. Larger cases need a terminal or a longer owned
command budget rather than a bigger worker timeout alone.

## Capacity 3 failure

Run attempt dated 2026-11-23 (America/Los_Angeles; raw UTC 2026-11-24). This run
really executed; it is recorded here as a failure, not as a result.

```
node benchmarks/parallel-workflow.cjs --files 600 --file-bytes 4096 --workers 4 \
  --capacity 3 --baseline none --json-out .artifacts/step7/benchmark-parallel-pool-no-baseline.json
```

- **Exit code 1 after 49.750 s** (inside the 120 s tool deadline, so no wrapper
  timeout this time).
- Same generated project as the default run: digest
  `63531c13178b52664a5d0b3dfdaafcfc1639da99120b1b45c7b4e3667edfecc5`, archive
  SHA-256 `487902e102fc9daeacbce0c3a6981a59f8dea4262514159f357242d6afc6b382`.
- **Two of four** producer commands succeeded, each drained with
  `import: "unchanged"`; both leases were released. No pending results, no
  quarantine and no surviving process were left behind.
- The next worker failed with `internal_error` / `EPERM` on a `scandir` of
  `.../runners/pool/slots/1/78035f76.../source/src/lib`.
- Remaining producer checks, the integration verification and `apply` were
  **not reached**. **No throughput metric and no speedup exist for this run.**
- `--baseline none` means `sequential` and `comparison` are `null` **by design**;
  that is not the failure.

### Release concern: cause narrowed, not proven

Mark this as an **observed Windows concurrent teardown/accounting failure** and a
**release concern**; live POSIX evidence is unavailable, and every affected
activation path remains experimental and opt-in.

The captured stack covers only `settle` -> `runBenchmark`, so it alone cannot
attribute the failure to one mechanism. A read-only review of the durable
records has since narrowed it (details and hash in the artifact table below):

- The failing turn was **worker 2**, whose own lease was `289b9b1c` and had
  already **completed successfully** and been released at `06:11:48.069Z`.
- The `EPERM` at `06:11:50.889Z` names **worker 3's** lease `78035f76`, which
  itself released cleanly at `06:11:50.959Z` with no diagnostics and no
  quarantine.
- A whole-store accounting census can therefore walk a *different* lease that is
  being deleted at the same moment. That is the **sole leading hypothesis**: the
  storage census racing cleanup.

Remaining uncertainty, stated plainly: the original filesystem stack was not
retained, and a later healthy ledger sample cleared the diagnostic, so the
origin is **not conclusively proved**. Do **not** assert `purgeTree` as the
thrower; the documented release concern stands exactly as filed.

Next minimal discriminator: capture the ledger/store diagnostic **immediately at
reproduction**, before it can be cleared. Do not blindly retry as a fix.

Local artifacts (generated locally, not guaranteed to exist in a checkout):

| Artifact (local path) | SHA-256 |
| --- | --- |
| `.artifacts/step7/benchmark-cap3-no-baseline-r6.json` (report) | `2d3d42b2d34eb48800d5c5ea5f75b79b2aa94e6401bb937f714cf88043833d6a` |
| `.artifacts/step7/benchmark-parallel-pool-no-baseline.json` (raw run JSON) | `2CE5798051C9551EA0AB0BD39A142584B024084BE035F524E42A1D6C5BBB34E7` |
| `.artifacts/step7/benchmark-parallel-pool-no-baseline.log` (full run log) | `997FDF0C31BD2AB2CDC6A647BCAFD2C9C2F33479387C7C02A590DFAC7A88C87B` |
| `.artifacts/step7/windows-eperm-origin-review.json` (read-only origin review) | `90A91BF1FB9CF6EC60A617AD4E3100EBFBF5093D7D0761AF16752D8D703C8F7D` |
