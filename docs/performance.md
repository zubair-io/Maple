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

## GPU live chain, engine only (macOS)

### Mac17,6 — dji-mavic3pro-100mp.dng — resume cut (#6021)

Chip **Apple M5 Max** · Metal. Harness `raw-gpu/examples/detail-live-timing.rs` (`cargo run --release -p raw-gpu --example detail-live-timing -- <RAW> [edge] [ticks]`); the files beside this row's `run.json` are its unedited stdout. Each tick is timed from `render_chain_to_f32` to GPU completion, with no readback and no host or display latency, so these numbers are engine-level and not comparable with the editor rows above. "Default" is `AdjustmentModel::default` over a Neutral scene-linear upload; "engaged" adds luminance NR 40, colour NR 50, clarity 30, texture 25, dehaze 20 and sharpening 60; "engaged + creative stage" is the engaged model over the capture decode with the creative stage in place of white balance, which is the chain the shipping hosts run. 120 warm ticks per drag. Before is the same example built against commit `81b4a3fc60` (no resume cut), after is this branch; the two binaries ran interleaved, two rounds, on 2026-11-26.

| Viewport  | Model                    | Drag                        | Round 1 before p50 / p95 / max (ms) | Round 1 after p50 / p95 / max (ms) | Round 2 before p50 / p95 / max (ms) | Round 2 after p50 / p95 / max (ms) |
| --------- | ------------------------ | --------------------------- | ----------------------------------- | ---------------------------------- | ----------------------------------- | ---------------------------------- |
| 1920×1280 | default                  | exposure (moves the prefix) | 4.7 / 4.8 / 4.8                     | 7.8 / 9.4 / 10.9                   | 8.2 / 14.8 / 21.7                   | 4.8 / 4.9 / 5.0                    |
| 1920×1280 | default                  | contrast                    | 6.3 / 7.4 / 7.8                     | 1.6 / 1.6 / 1.6                    | 6.6 / 11.5 / 18.2                   | 1.6 / 1.8 / 22.7                   |
| 1920×1280 | default                  | whites                      | 6.3 / 7.8 / 8.1                     | 1.6 / 1.6 / 1.6                    | 6.3 / 16.3 / 27.8                   | 1.6 / 1.7 / 1.8                    |
| 1920×1280 | default                  | colour grade saturation     | 6.4 / 9.6 / 17.3                    | 1.6 / 1.6 / 1.6                    | 6.5 / 15.8 / 21.6                   | 1.6 / 6.3 / 9.0                    |
| 1920×1280 | default                  | grain amount                | 6.4 / 9.4 / 17.6                    | 1.6 / 1.6 / 1.7                    | 6.8 / 14.0 / 24.3                   | 1.6 / 1.7 / 2.7                    |
| 1920×1280 | engaged                  | exposure (moves the prefix) | 20.6 / 21.2 / 37.2                  | 20.3 / 22.5 / 26.6                 | 21.7 / 23.6 / 39.7                  | 20.5 / 22.4 / 29.2                 |
| 1920×1280 | engaged                  | contrast                    | 9.9 / 14.5 / 19.5                   | 1.6 / 1.6 / 1.7                    | 9.9 / 10.2 / 11.8                   | 1.8 / 3.6 / 4.2                    |
| 1920×1280 | engaged                  | whites                      | 10.0 / 12.0 / 14.2                  | 1.6 / 2.4 / 5.5                    | 9.7 / 10.0 / 10.7                   | 2.1 / 5.5 / 6.9                    |
| 1920×1280 | engaged                  | colour grade saturation     | 9.9 / 10.2 / 11.4                   | 1.6 / 1.6 / 1.7                    | 9.7 / 10.6 / 19.7                   | 2.2 / 10.6 / 24.1                  |
| 1920×1280 | engaged                  | grain amount                | 9.8 / 10.1 / 16.5                   | 1.6 / 2.4 / 17.2                   | 10.0 / 10.9 / 11.9                  | 1.8 / 12.6 / 21.7                  |
| 1920×1280 | engaged + creative stage | exposure (moves the prefix) | 23.6 / 34.6 / 45.8                  | 20.3 / 20.4 / 25.9                 | 21.9 / 23.4 / 29.7                  | 24.1 / 33.3 / 45.1                 |
| 1920×1280 | engaged + creative stage | contrast                    | 10.3 / 12.4 / 14.7                  | 1.6 / 1.7 / 16.3                   | 9.6 / 9.7 / 18.3                    | 1.7 / 1.9 / 2.4                    |
| 1920×1280 | engaged + creative stage | whites                      | 10.1 / 11.5 / 23.8                  | 1.6 / 1.6 / 1.6                    | 9.6 / 10.4 / 10.7                   | 1.9 / 8.0 / 14.6                   |
| 1920×1280 | engaged + creative stage | colour grade saturation     | 10.0 / 11.5 / 13.4                  | 1.6 / 1.6 / 1.6                    | 10.2 / 11.7 / 28.8                  | 3.4 / 8.1 / 10.4                   |
| 1920×1280 | engaged + creative stage | grain amount                | 9.9 / 13.5 / 23.4                   | 1.6 / 1.6 / 1.6                    | 10.1 / 11.3 / 12.1                  | 3.5 / 7.4 / 8.5                    |
| 3456×2304 | default                  | exposure (moves the prefix) | 16.9 / 17.9 / 29.5                  | 16.9 / 17.1 / 22.6                 | 18.3 / 19.8 / 26.5                  | 17.4 / 19.6 / 30.1                 |
| 3456×2304 | default                  | contrast                    | 16.1 / 17.1 / 23.6                  | 3.1 / 3.2 / 3.2                    | 18.6 / 19.6 / 20.1                  | 3.6 / 5.8 / 7.4                    |
| 3456×2304 | default                  | whites                      | 16.8 / 17.7 / 22.0                  | 3.1 / 3.5 / 8.8                    | 18.9 / 24.1 / 29.4                  | 3.6 / 5.5 / 32.6                   |
| 3456×2304 | default                  | colour grade saturation     | 17.9 / 30.6 / 36.1                  | 3.1 / 4.4 / 16.3                   | 18.6 / 20.2 / 29.0                  | 4.8 / 15.5 / 26.6                  |
| 3456×2304 | default                  | grain amount                | 17.3 / 29.2 / 33.9                  | 3.1 / 4.2 / 4.7                    | 20.7 / 33.3 / 54.8                  | 4.9 / 7.3 / 19.5                   |
| 3456×2304 | engaged                  | exposure (moves the prefix) | 45.6 / 53.6 / 69.5                  | 46.0 / 47.7 / 49.3                 | 51.7 / 67.1 / 77.8                  | 47.6 / 64.4 / 88.3                 |
| 3456×2304 | engaged                  | contrast                    | 32.1 / 34.0 / 40.3                  | 3.1 / 3.2 / 3.2                    | 35.5 / 49.2 / 54.9                  | 3.4 / 6.0 / 16.7                   |
| 3456×2304 | engaged                  | whites                      | 33.8 / 47.9 / 59.4                  | 3.1 / 3.2 / 3.2                    | 34.3 / 35.2 / 37.9                  | 3.3 / 4.9 / 10.1                   |
| 3456×2304 | engaged                  | colour grade saturation     | 34.1 / 47.0 / 57.0                  | 3.2 / 4.4 / 5.3                    | 33.9 / 34.8 / 35.9                  | 4.9 / 6.2 / 43.0                   |
| 3456×2304 | engaged                  | grain amount                | 33.5 / 36.2 / 50.3                  | 3.1 / 4.4 / 4.9                    | 33.9 / 34.5 / 38.9                  | 4.8 / 6.3 / 12.4                   |
| 3456×2304 | engaged + creative stage | exposure (moves the prefix) | 44.7 / 46.7 / 61.8                  | 48.8 / 65.4 / 78.2                 | 56.5 / 78.7 / 116.0                 | 47.6 / 52.2 / 52.3                 |
| 3456×2304 | engaged + creative stage | contrast                    | 33.2 / 37.9 / 44.4                  | 3.5 / 13.5 / 30.7                  | 35.3 / 45.4 / 51.4                  | 3.1 / 3.2 / 9.0                    |
| 3456×2304 | engaged + creative stage | whites                      | 33.1 / 37.9 / 46.8                  | 4.7 / 17.9 / 55.9                  | 36.1 / 58.5 / 80.6                  | 3.2 / 3.4 / 3.4                    |
| 3456×2304 | engaged + creative stage | colour grade saturation     | 33.8 / 36.9 / 41.7                  | 4.9 / 12.8 / 16.9                  | 37.5 / 64.6 / 74.1                  | 3.1 / 4.2 / 10.4                   |
| 3456×2304 | engaged + creative stage | grain amount                | 35.0 / 40.9 / 48.6                  | 4.9 / 6.0 / 10.5                   | 37.4 / 55.9 / 78.3                  | 3.1 / 3.1 / 4.2                    |

First late tick after an upstream change: each of 120 iterations renders an exposure tick (a new prefix, so nothing is stored) and then a contrast tick on that prefix. With the resume cut that contrast tick runs the whole chain and also stores the image before the view transform; the tick after it resumes. It is cheaper than the exposure tick in both builds because the resident haze map is reused once the prefix stops moving, so the store's own cost is the difference between the before and after columns. An exposure, white-balance or HSL drag, whose prefix moves every tick, never stores, so it pays no copy at all.

| Viewport  | Model                    | Round | Build  | Exposure tick p50 (ms) | First late tick p50 / p95 (ms) |
| --------- | ------------------------ | ----- | ------ | ---------------------- | ------------------------------ |
| 1920×1280 | default                  | 1     | before | 4.8                    | 4.8 / 6.3                      |
| 1920×1280 | default                  | 1     | after  | 4.7                    | 4.8 / 4.9                      |
| 1920×1280 | default                  | 2     | before | 6.7                    | 6.8 / 14.1                     |
| 1920×1280 | default                  | 2     | after  | 4.8                    | 4.8 / 6.3                      |
| 1920×1280 | engaged                  | 1     | before | 21.0                   | 9.7 / 13.8                     |
| 1920×1280 | engaged                  | 1     | after  | 20.3                   | 9.6 / 9.7                      |
| 1920×1280 | engaged                  | 2     | before | 22.0                   | 9.7 / 10.1                     |
| 1920×1280 | engaged                  | 2     | after  | 23.0                   | 10.6 / 23.8                    |
| 1920×1280 | engaged + creative stage | 1     | before | 22.0                   | 9.8 / 12.9                     |
| 1920×1280 | engaged + creative stage | 1     | after  | 20.4                   | 9.7 / 9.9                      |
| 1920×1280 | engaged + creative stage | 2     | before | 22.6                   | 10.1 / 11.1                    |
| 1920×1280 | engaged + creative stage | 2     | after  | 22.9                   | 10.2 / 13.0                    |
| 3456×2304 | default                  | 1     | before | 17.3                   | 17.2 / 23.7                    |
| 3456×2304 | default                  | 1     | after  | 16.9                   | 16.9 / 18.4                    |
| 3456×2304 | default                  | 2     | before | 21.6                   | 22.1 / 35.1                    |
| 3456×2304 | default                  | 2     | after  | 18.8                   | 19.3 / 29.6                    |
| 3456×2304 | engaged                  | 1     | before | 46.2                   | 33.9 / 41.4                    |
| 3456×2304 | engaged                  | 1     | after  | 46.1                   | 33.8 / 35.3                    |
| 3456×2304 | engaged                  | 2     | before | 47.7                   | 34.5 / 36.9                    |
| 3456×2304 | engaged                  | 2     | after  | 48.2                   | 35.7 / 38.2                    |
| 3456×2304 | engaged + creative stage | 1     | before | 47.0                   | 34.6 / 43.5                    |
| 3456×2304 | engaged + creative stage | 1     | after  | 47.7                   | 35.5 / 38.3                    |
| 3456×2304 | engaged + creative stage | 2     | before | 47.9                   | 35.0 / 39.6                    |
| 3456×2304 | engaged + creative stage | 2     | after  | 46.0                   | 33.8 / 35.7                    |

The store copy alone: one plane the size of the session's image, copied buffer to buffer and submitted, against an empty submit, 120 of each interleaved.

| Viewport  | Plane    | Round | Build  | Copy + submit p50 (ms) | Empty submit p50 (ms) | Copy alone (ms) |
| --------- | -------- | ----- | ------ | ---------------------- | --------------------- | --------------- |
| 1920×1280 | 39.3 MB  | 1     | before | 1.531                  | 1.517                 | 0.015           |
| 1920×1280 | 39.3 MB  | 1     | after  | 1.563                  | 1.531                 | 0.032           |
| 1920×1280 | 39.3 MB  | 2     | before | 1.573                  | 1.533                 | 0.040           |
| 1920×1280 | 39.3 MB  | 2     | after  | 1.526                  | 1.513                 | 0.013           |
| 3456×2304 | 127.4 MB | 1     | before | 1.547                  | 1.523                 | 0.024           |
| 3456×2304 | 127.4 MB | 1     | after  | 1.642                  | 1.567                 | 0.075           |
| 3456×2304 | 127.4 MB | 2     | before | 1.605                  | 1.546                 | 0.059           |
| 3456×2304 | 127.4 MB | 2     | after  | 1.586                  | 1.542                 | 0.045           |

Recording load (1-minute load average at the start and end of each run):

| Round | Viewport  | Build  | Load at start | Load at end | Ticks per drag |
| ----- | --------- | ------ | ------------- | ----------- | -------------- |
| 1     | 1920×1280 | before | 19.8          | 18.8        | 120            |
| 1     | 1920×1280 | after  | 18.8          | 14.8        | 120            |
| 1     | 3456×2304 | before | 14.8          | 32.5        | 120            |
| 1     | 3456×2304 | after  | 32.5          | 32.9        | 120            |
| 2     | 1920×1280 | before | 32.9          | 35.1        | 120            |
| 2     | 1920×1280 | after  | 35.1          | 34.3        | 120            |
| 2     | 3456×2304 | before | 34.3          | 47.1        | 120            |
| 2     | 3456×2304 | after  | 47.1          | 42.5        | 120            |

> **Recording conditions:** other agents were compiling on the same Mac throughout, at the load averages above, so absolute times are inflated and noisy; compare before and after within a row and round.

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
