# Local FFI contention measurement

Instrumentation slice #3721 supported the #3527 decision, which has since
landed: bitmap renders + AVIF validations ride a pinned single-child bitmap
lane, while RAW decodes ride the operator-sized RAW lane (default 1). Each
lane is FIFO; there is no shared queue anymore. This harness is unchanged and
still valid — `workers` now means RAW-lane width, and the bitmap requests
measure the bitmap lane's own (short) queue. There are no committed benchmark
results; the #3527 decision numbers live in that issue/PR, not here.

## Prerequisites

Use a quiet macOS/Linux host: no builds, other benchmarks, production indexing,
or concurrent copies of this harness. Record the deployment's memory budget
separately before deciding whether increasing workers is acceptable.

Build current native/API package artifacts with the existing tooling:

```sh
# From repository root; this is compilation, not a benchmark.
bash src/api/scripts/build-raw-ffi.sh
cd src/maple
bun install --frozen-lockfile
bun run build
cd ../api
bun install --frozen-lockfile
```

Use the actual RAW fixture and a representative JPEG, both outside temporary
output directories. The RAW path can be the reference fixture under
`test-fixtures/raws/`; its hash and size, rather than its name, identify the input.
The JPEG signature is checked. Input files are only read, and their hashes are
checked again after all trials. Native request errors fail the run.

API and Maple library resolvers must select binaries with identical SHA-256
hashes. If this fails, rebuild/sync the selected artifacts; do not bypass the
check. Existing `MAPLE_NATIVE_LIB` overrides can influence Maple's resolver.
No new environment setting or production configuration is introduced here.
The report records both library paths/hashes, the resolved built package entry
hash, checkout SHA/dirty status, host CPU/memory/OS and Bun version. Binary hashes
identify artifacts; they do not prove that a binary was built from the recorded
checkout. The operator must establish that provenance with a fresh build.

## Run only during the reserved measurement window

```sh
cd src/api
bun scripts/ffi-contention.ts --run \
  /absolute/path/reference.dng \
  /absolute/path/representative.jpg \
  /absolute/path/new-contention-report.json
```

The report path must be new (exclusive creation); an existing report or symlink
is rejected. Native images are written only into a fresh temporary directory,
which is removed afterwards. No DB or running server is required, and the
harness uses an isolated pool rather than the application's singleton.

Nine trials use RAW-lane worker-count orders `1,2,4`, `2,4,1`, `4,1,2`
(the bitmap lane stays pinned at 1 throughout), with fresh child processes for
each trial. Each trial submits one 1280px RAW develop, then four 512px
JPEG-to-AVIF thumbnail renders. Each bitmap's successful render submits its
AVIF validation to the bitmap lane behind it. This exercises the existing pool
through its real child factory and typed request methods; it does not emulate
the worker-stage scheduler. All nine requests must succeed per trial.

Each trial has a 120-second deadline. Failures, missing observations, missing
child RSS, sampling errors or interruption stop the comparison, set a failed
report and exit nonzero. An interrupted/crashed process may leave an
`incomplete` report, which is not successful evidence. Children are shut down
and checked for exit before the next trial. A failed run must be investigated,
not omitted from a summary.

## Reading the report

- `queueMs`: parent submission to actual `postMessage`, including synchronous
  API overhead and lazy child spawn. It excludes dispatch-to-reply work.
- `dispatchToReplyMs`: parent post to parent IPC reply, including child startup,
  transport and native work. It is **not native decode-only time**.
- `totalMs`: submission to settled caller promise. Failed or undispatched
  requests keep their status/error and null timing fields where appropriate.
- RSS samples use `ps` every 100ms plus boundary samples. Parent and direct FFI
  children are reported separately and summed at each sample. This is a
  **sampled maximum**, not true peak, private memory, or a memory limit. Shared
  library pages can be counted in more than one process. Sampling adds overhead;
  apply the same harness to each configuration.

OS file caches are not flushed; later trials can benefit from warm data. The
rotating order reduces ordering bias but does not establish cold-storage
performance. The single RAW request measures contention, not worst-case memory
with several simultaneous 100MP RAW decodes — size the `ffi_workers` knob
against the deployment's RAM budget (a full demosaic peaks at ~11.5GB RSS for
a 100MP DNG, ~7.2GB for a 30MP CR2, measured for #3527), not from this report
alone.

Deterministic tests exercise lane routing, per-lane FIFO, progress while RAW
is busy, crash isolation, cancellation, failed replies, exact observation
timing and RSS process selection using controlled workers. They do not execute
native codecs or count as performance evidence:

```sh
bun test tests/ffi-contention.test.ts src/ffi/ffi-pool.test.ts
bun run typecheck
```
