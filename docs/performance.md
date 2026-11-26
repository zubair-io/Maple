# Performance

Committed, reproducible per-device measurements of the product's real
performance invariants (CLAUDE.md "Performance invariants"): slider-tick
latency, cold-open latency, and full-resolution export time, on the 100 MP
reference RAW where the fixture is present. **Generated** by
`tools/perf-table.py` from the committed rows under `test-fixtures/perf/`
— do not hand-edit the tables below; edit a row's JSON file and
regenerate. See [testing.md](testing.md) for the rest of the gate map and
[apple.md](apple.md) § "Measuring editor latency" for the Apple harness
internals.

## Method and what these numbers exclude

Every row comes from a named harness (`EditorWorkflowPerfTests` on Apple
today) driving the production `EditSession` → `RenderActor` →
`GpuLiveDriver` path on an isolated copy of the reference RAW — not a
synthetic microbenchmark. Per `docs/apple.md` § "Measuring editor
latency":

- Tick timings capture model-input to publish acknowledgement — **not**
  compositor scanout or SwiftUI gesture dispatch. They exclude device
  scanout and real touch/mouse gesture latency; pair with an Instruments
  trace for that end of the pipeline.
- A 1 ms polling task observes publication and can itself miss
  publications if delayed, adding observation latency on top of the
  real render time.
- "Cold open, cached reopen" opens a **second, brand-new** `EditSession`
  (with its own GPU-live session, Metal layer, and window) against the
  same staged asset after the first session's exit-readback has
  populated the on-disk `RenderedPreviewCache` and the in-process memory
  tier has been dropped (`handleMemoryPressure`). It is a real disk-cache
  hit, but it still pays full `EditSession`/GPU-session/window bring-up
  cost on every run — a warm in-app reopen (the ~35 ms CLAUDE.md target)
  has none of that bring-up cost, so this number is expected to run
  noticeably higher than 35 ms even on a hit.
- The correctness assertions inside the harness (e.g. "same-session
  revisit reuses the decode") do not certify a universal 16 ms display
  budget on every machine; they gate the one machine that ran them.
- Numbers here are single machine-local runs, not a fleet average or a
  percentile across hardware. Two back-to-back runs on the same machine
  can differ by 2–3× under concurrent CPU load from unrelated work (see
  "Recording methodology" below) — treat one row as a spot check, not a
  SLA.

## Recording methodology

Each committed row is the **better of two consecutive runs** on the same
machine, immediately back to back — not an average, not a best-of-many.
The two runs are logged (see the PR that added the row) so a reader can
see the spread the "better of two" was chosen from. This repo's own
recording session for the rows below ran alongside multiple other
concurrent `cargo`/`swift build` processes from unrelated sessions on the
same Mac, which inflated both runs — flagged per platform below where it
applies.

## Recording a new row

```bash
# Apple (macOS/iPadOS) — from repo root, after building the release xcframework:
cd src/apple/Packages/MapleCore
swift build -c release --build-tests -Xswiftc -enable-testing
MAPLE_PERF=1 MAPLE_PERF_RECORD="$PWD/../../../../test-fixtures/perf/apple-macos/<device-id>.json" \
  swift test -c release --skip-build -Xswiftc -enable-testing --filter EditorWorkflowPerfTests
```

`<device-id>` is the machine's `hw.model` with `,` replaced by `-` (e.g.
`Mac17-6`) — `PerfRecordWriter.deviceIdSlug` computes the same string, so
matching the filename to the row's own `deviceId` field is a good sanity
check. Run it twice, keep the better run's file, then regenerate this
document and reformat it (the generator does not match prettier's
markdown table column padding, so this second step is required — CI's
format-check gate will otherwise flag the regenerated file):

```bash
python3 tools/perf-table.py
cd src/web && bun run format && cd -
```

### Linux

```bash
# Linux — from the repo root on the physical machine, inside the desktop session
# being qualified (Wayland or X11), with nothing else running:
cargo run --locked --release --manifest-path src/linux/Cargo.toml --example perf-harness -- \
  test-fixtures/raws/dji-mavic3pro-100mp.dng /tmp/maple-linux-perf.json
```

`perf-harness` (`src/linux/examples/perf-harness/`, #6043) opens a private
copy of the RAW on the application's own preview worker, without a window,
twice: once with the GPU (the resident preview the editor shows) and once
without it (the CPU renderer the application falls back to). For each it
records:

- **Cold open** — from the open request to the first published frame
  (`coldOpenDecodeMs` is the decode share). The harness has just hashed and
  copied the file, so its bytes are in the OS page cache; nothing of the
  application is warm.
- **Slider ticks** — an Exposure drag and a Contrast drag, one tick every
  1/60 s whether or not the previous frame has arrived, as a real drag
  does. Latency runs from sending a tick to its frame being published. Every
  tick supersedes the render in flight, so a path slower than 16.7 ms per
  frame answers only some ticks: the row records how many were published
  (`published`, `publishedRatio`) and the longest stretch with no frame at
  all (`worstGapMs`, the delay a user feels). The first published frame of
  each drag is reported apart as `firstTickMs` and kept out of the
  percentiles; the Apple harness reports every tick, so this is stricter.
- **Profile-switch cancellation** — a profile switch, which re-uploads the
  preview, is superseded part-way through by a render for a closed session;
  the latency is the time until the worker has dropped the switch and
  answered. A slider tick superseded by the next tick publishes no event, so
  its cancellation is not timed.
- **Peak resident memory** — the process high-water mark after each path.
  The GPU path runs first, so the CPU fallback's figure includes it. It
  counts host memory only, not GPU memory.
- **Image size** — the decoded RAW's width, height and megapixels as the
  worker reports them (`sensorWidth`, `sensorHeight`, `sensorMegapixels`).

The row lists what it measures (`coverage`) and what it does not
(`excludes`): the debounced quiet-refine and detail pass, frame
presentation after the worker event, saves on the worker thread, input
dispatch and the egui frame loop, GPU memory, and cancellation of a tick
superseded by the next tick.

The harness prints whether the row qualifies as a timing measurement. It
qualifies only from a release build with a clean working tree, on a
discrete or integrated hardware Vulkan adapter under Linux, on the
reference RAW (SHA-256 `f4b60b36…a1045aa5`, the hash
`test-fixtures/qualification/browser-100mp-3669.json` records for
`dji-mavic3pro-100mp.dng`), with the GPU path staying resident and each
drag publishing at least 20 frames and half of its ticks. A software
adapter (a CPU rasterizer, as in Linux CI) or any other failed condition
still writes the row, marked `timingQualifies: false` with the reasons,
and `tools/perf-table.py` refuses to render it. The CPU fallback is
recorded for comparison and does not decide qualification.

Run the harness three times on an idle machine and commit the median run,
ranked by its resident GPU tick p95, to
`test-fixtures/perf/linux/<deviceId>.json` (the harness prints the
`deviceId`); keep the other two logs with the PR's evidence. The Apple
rows keep the better of two runs; Linux commits the median so a lucky run
cannot set the number. Then regenerate and reformat as above.

No Linux row is committed yet. Linux CI runs the same harness code on a
software adapter, which checks the harness and is not timing evidence; a
row needs a physical Linux machine with a hardware GPU and the reference
RAW, and that measurement is #5970.

## Regression gate (local only)

```bash
python3 tools/check-perf-ratchet.py <fresh-row.json> <committed-row.json>
```

Fails when a fresh run's tick p95/max, cold-open, or export time
regresses past the committed row by more than a jitter margin — see
`tools/check-perf-ratchet.py`'s header for the exact margins and why
they're that wide. **This absolute-time ratchet never runs in cloud CI.**
Apple CI does execute selected MapleCore regressions against a real release
Rust archive (see [Testing and CI](testing.md#what-ci-actually-builds-for-apple)).
Those runs do not establish per-device performance: this ratchet needs the
same reference device, fixture, viewport, thermal state and controlled load.
It remains a local pre-PR check. `SliderTickPerfTests`' in-run ON/OFF ratio
(#2113) is a separate relative check; its execution depends on the selected
test classes, not on this report being generated.
That in-run ratio gate is unrelated to this file and is untouched by it.

## macOS

### Mac17,6 — dji-mavic3pro-100mp.dng — auto

Chip **Apple M5 Max** · GPU **Apple M5 Max** · Version 26.6.2 (Build 25G83) · 60 Hz display · thermal state at record time: **fair**. Viewport 1920×1280 px. Cache methodology: `uncachedOpen+cachedReopen`. Harness `EditorWorkflowPerfTests.testRAWOpenAndContinuousDevelopAt60Hz` at commit `10181c865a84`, recorded 2026-09-07T14:47:25Z. Source row: [`test-fixtures/perf/apple-macos/Mac17-6.json`](../test-fixtures/perf/apple-macos/Mac17-6.json).

| Measurement                        | This device                | Spec target                              |
| ---------------------------------- | -------------------------- | ---------------------------------------- |
| Cold open, uncached                | 2,992.4 ms                 | 250–1000 ms                              |
| Cold open, cached reopen           | 967.5 ms                   | ~35 ms                                   |
| Exposure tick p50 / p95 / max      | 5.3 ms / 18.9 ms / 21.5 ms | 16 ms / 50 ms (hard)                     |
| Exposure ticks over 16 ms          | 3 of 51 published          | 0                                        |
| Contrast tick p50 / p95 / max      | 4.1 ms / 10.4 ms / 16.4 ms | 16 ms / 50 ms (hard)                     |
| Contrast ticks over 16 ms          | 1 of 58 published          | 0                                        |
| Full-resolution export (jpeg_srgb) | 64,589.3 ms                | no fixed target — tracked for regression |

> **Recording conditions:** Recorded 2026-09-07 while three sibling agent sessions were compiling Rust and a fourth was compiling MapleCore concurrently on this Mac (#3421). This is the better of two consecutive runs; the discarded second run (cold open uncached 9475 ms, contrast tick p95 31.7 ms) is quoted in the tools/check-perf-ratchet.py header as the contention upper bound. Re-record on a quiet machine when convenient.

## Platforms without a committed row yet

- **iPad.** No physical iPad was available on the machine that recorded the
  rows above. `EditorWorkflowPerfTests` runs unmodified against an iOS
  Simulator or device destination the same way it runs on macOS — see
  `docs/apple.md` § "Build and test" for the `-destination 'platform=iOS
Simulator,name=...'` invocation — recording a row is a matter of running it
  there and committing the resulting `test-fixtures/perf/apple-ios/<device-id>.json`.
- **Windows.** No WinUI tick-qualification harness (#2587) writes this JSON
  row shape yet. `docs/windows.md` documents the existing Windows test setup;
  wiring its output into this format is separate follow-up work.
- **Web (Chrome), on the 100 MP reference specifically.** The bounded folder-picker
  bridge and `src/web/e2e/production/raw-100mp.spec.ts` now exercise the exact
  `dji-mavic3pro-100mp.dng` through the production editor (#3669), validating its
  complete byte count and SHA-256 before opening. The smaller DNG slider and
  Canon CPU-fallback tests remain intact. The test attaches intake, host/browser/GPU,
  editor-open and worker-render evidence, including the failure stage if it fails;
  a missing canonical fixture is an explicit skip, never a smaller-file substitution.
  See [the recorded qualification](../test-fixtures/qualification/browser-100mp-3669.md).
  This is not a committed quiet-machine performance row: the initial recording had
  background sync activity, and worker `maple:session-render` intervals on a viewport
  are distinct from input-to-display latency or a full-resolution 100 MP frame.
