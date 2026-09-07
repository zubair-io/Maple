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
they're that wide. **This never runs in cloud CI.** Apple tests are not
cloud-gated at all (`docs/apple.md` § "Build and test" — cloud CI compiles
MapleCore only, no test target runs there), so a machine-dependent
absolute-time gate has no CI machine to be stable on; it is a local,
pre-PR sanity check the way `SliderTickPerfTests`' in-run ON/OFF ratio
(#2113) is the machine-independent one that actually can run anywhere.
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
- **Web (Chrome), on the 100 MP reference specifically.** The production
  Chrome audit harness (`src/web/e2e/production/raw-performance.spec.ts`,
  from #2457) measures real slider-tick and cold-open numbers, but not
  against `dji-mavic3pro-100mp.dng`: its own comment on `OVER_BUDGET_RAW`
  records why — "The 100 MP reference fixture reproduces the same abort but
  its 129 MB payload crashes the renderer inside the folder-picker shim's
  base64 CDP bridge, so the e2e uses the largest canonical fixture the
  bridge can carry" (`test_0003.CR2`, 52.7 MP). The harness's own slider-tick
  budget test (`raw-gpu-performance`) runs against the smaller `test_0006.DNG`
  fixture instead. A web row on the 100 MP reference needs either a bridge
  fix for the picker shim's base64 payload size or a non-picker file-intake
  path for the e2e harness — tracked as follow-up, not fabricated here.
