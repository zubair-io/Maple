# 100MP reference instrument pass — before/after numbers + proposed budget ratchets

Date: 2026-07-19
Refs: #1959 (slider-tick one-way ratchet), #2033 (Apple perf review epic), #2083 (FFI input-readback cache), #2095/#2092 (fused chain+encode)

Every number in this document comes from an actual run on the machine below.
Where a metric could not be measured, that is stated as a gap — nothing is
estimated and presented as measured.

## Machine

- Apple M5 Max (`machdep.cpu.brand_string`), 18 logical cores (6 performance + 12 efficiency)
- macOS 26.4.1
- Baseline (idle) load average before the pass: ~5.0–5.5. See the per-config load notes — some runs were taken under higher self-induced load and are flagged.

## Fixture

- `test-fixtures/raws/dji-mavic3pro-100mp.dng` → symlink to `test_0000.DNG`
- Hasselblad L3D-100c (DJI Mavic 3 Pro sensor), 12288×8192, 100.7 MP
- Local-only symlink (fixtures are gitignored); never committed.

## Build

- macOS-arm64-only fast xcframework built from the worktree source (`origin/main` @ `9fe12b36a`):
  `cargo build -p raw-ffi --release --features gpu,pano --target aarch64-apple-darwin`,
  cbindgen header regenerated, `.a` + header dropped into the worktree's
  `RawPipeline.xcframework/macos-arm64_x86_64/` slice. Fused FFI symbol
  `_maple_apply_chain_and_encode_display_f32` verified present (`nm`).
- Same binary for every A/B; the fixes are toggled at runtime via the env
  kill-switches (`MAPLE_DISABLE_FFI_INPUT_CACHE`, `MAPLE_DISABLE_FUSED_CHAIN_ENCODE`,
  `MAPLE_GPU_LIVE`) — all confirmed to exist in the current source before use.

---

## 1. Slider tick (primary — deterministic)

`swift test --filter SliderTick` with `MAPLE_PERF=1`, run 5× per config. The
filter matches all three benches. Each bench does 50 ticks on the 100MP
fixture and prints mean/p50/p95/max; the numbers below are the per-run **mean**
unless stated. Viewport 1920×1080 (fast phase).

Configs (same binary):

- **a** — all fixes ON (default). The "after".
- **b** — `MAPLE_DISABLE_FFI_INPUT_CACHE=1` (isolates #2083).
- **c** — `MAPLE_DISABLE_FUSED_CHAIN_ENCODE=1` (isolates #2095).
- **d** — both b+c. The pre-ratchet-wave "before".

Load note: config **a** was captured at load ~8; configs **b/c/d** at load
~13–19 (back-to-back `swift test` runs raise the 1-min average). The higher
load makes the b/c/d absolute numbers conservative-high, so the per-fix deltas
below are upper bounds, not lower bounds — the direction and rough magnitude
hold regardless.

### 1a. `SliderTickPerfTests` — exposure drag (interim ceiling **65 ms**)

Uses `AdjustmentModel.default` (sharpen 40 / nrColor 25), so the #2095 fusion
gate never engages here — only #2083 (the exposure-drag readback cache) matters.

| Config              | run means (ms)                        | mean     | p50 (typ) | p95 (typ)      | max (worst)  |
| ------------------- | ------------------------------------- | -------- | --------- | -------------- | ------------ |
| a — all ON          | 43.85 / 41.44 / 41.03 / 40.95 / 41.39 | **41.7** | ~40.9     | ~44 (one 53.3) | 58.6         |
| b — input-cache OFF | 75.61 / 73.21 / 83.25 / 72.57 / 73.77 | 75.7     | ~73       | ~90            | 226 (1 tick) |
| c — fused OFF       | 41.99 / 44.11 / 45.80 / 47.39 / 47.44 | 45.3     | ~43       | ~55            | 60.8         |
| d — both OFF        | 75.83 / 78.22 / 77.06 / 77.63 / 79.75 | 77.7     | ~75       | ~95            | 106.8        |

Per-fix delta:

- **#2083 (input-readback cache): −34 ms/tick.** a=41.7 vs b=75.7. Turning the
  cache off nearly doubles the exposure-drag tick.
- **#2095 (fusion): no effect here** (a=41.7 vs c=45.3, within the load gap) —
  expected, the fusion gate can't engage with default sharpen/nrColor.
- Combined "before" (d) ≈ 77.7 ms; "after" (a) ≈ 41.7 ms.

### 1b. `FusedChainEncodeSliderTickPerfTests` — exposure drag, sharpen 0 / nrColor 0, fusion engaged (ceiling **38 ms**)

| Config              | run means (ms)                        | mean     | worst run   | spread              |
| ------------------- | ------------------------------------- | -------- | ----------- | ------------------- |
| a — all ON          | 25.42 / 25.04 / 25.42 / 25.47 / 25.23 | **25.3** | 25.47       | 0.4 ms (very tight) |
| b — input-cache OFF | 55.02 / 54.88 / 57.42 / 55.18 / 56.59 | 55.8     | 57.42       | —                   |
| c — fused OFF       | 33.38 / 33.23 / 34.53 / 42.33 / 37.65 | 36.2     | 42.33 (hot) | —                   |
| d — both OFF        | 65.90 / 66.16 / 69.75 / 66.67 / 65.48 | 66.8     | 69.75       | —                   |

Per-fix delta (both flags matter here — the fused call still consumes the
cached scene-linear readback):

- **#2095 (fusion): −11 ms/tick.** a=25.3 vs c=36.2.
- **#2083 (input-readback cache): −30 ms/tick** even on the fused path. a=25.3 vs b=55.8.
- Combined "before" (d) ≈ 66.8 ms; "after" (a) ≈ 25.3 ms (≈ additive: 11 + 30).

### 1c. `SharpenSliderTickPerfTests` — sharpen drag, #661 chain-cache hit (ceiling **80 ms**)

| Config              | run means (ms)                        | mean |
| ------------------- | ------------------------------------- | ---- |
| a — all ON          | 28.38 / 26.43 / 27.06 / 26.52 / 26.20 | 26.9 |
| b — input-cache OFF | 25.76 / 28.04 / 32.07 / 28.58 / 27.15 | 28.3 |
| c — fused OFF       | 26.43 / 27.53 / 30.75 / 29.63 / 30.63 | 29.0 |
| d — both OFF        | 27.03 / 28.69 / 30.03 / 31.16 / 29.68 | 29.3 |

Insensitive to both flags (as designed — this path rides the #661
`SceneLinearChainCache`, not the per-tick FFI). Steady ~27–29 ms across all
configs; worst single-run mean 32.07. Big margin under the 80 ms ceiling.

### Proposed slider-tick ratchets (one-way DOWN only; PROPOSAL — not changed in this PR)

Rule of thumb: measured worst-clean mean × ~1.3, never below what run-to-run
variance safely clears.

| Bench                                 | constant                   | current | measured worst-clean mean        | proposed | rationale                                                                                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------- | ------- | -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SliderTickPerfTests`                 | `interimHardLimitMs`       | 65      | 43.85 (a)                        | **55**   | 43.85 × 1.25 = 54.8. Clears worst all-ON mean by ~25%. Kept at 55 (not lower) because this bench is variance-prone (p95 to 53, max ticks to 58) and config-a was measured at low load; 55 absorbs load jitter while still ratcheting a real 10 ms off 65.                                |
| `FusedChainEncodeSliderTickPerfTests` | `fusedCacheHitCeilingMs`   | 38      | 25.47 (a)                        | **34**   | 25.47 × 1.33 = 33.9. Must stay ABOVE the fused-on mean but BELOW the fusion-OFF clean band (config c: 33–38, mean 36) so a fusion regression still trips — 34 sits cleanly between 25.5 and 36. 33 is the aggressive alternative; 34 is the safe pick given config-a's low-load capture. |
| `SharpenSliderTickPerfTests`          | `sharpenCacheHitCeilingMs` | 80      | 32.07 (worst across all configs) | **45**   | 32.07 × 1.4 = 44.9. Large ratchet from 80; the ×1.4 margin (vs ×1.3) absorbs the occasional single-tick spike (one run showed a 61 ms max tick, though the gate is on the mean).                                                                                                         |

---

## 2. Cold open → first pixel + peak memory (best-effort)

Method: a headless MapleCore perf harness (temporary, NOT committed) that runs
the load-bearing cold-open **compute** path on the 100MP fixture —
`ImageEditPipeline.decodeSceneLinear(quality: .preview)` (cold, uncached) then
the first `processSceneLinear` at viewport + a Metal-backed force-render —
sampling macOS `phys_footprint` (Mach `task_vm_info`) at baseline, after
decode, and after first render. A/B on `MAPLE_GPU_LIVE`. 5 runs.

| Metric                                              | value (n=5)                                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| decode dims (`quality: .preview`)                   | 6144×4096 (**half-res** preview decode, not full 12288×8192)                                                     |
| cold decode                                         | 1731 / 1769 / 1729 / 1856 / 1815 ms → **mean ~1.78 s**                                                           |
| first full render (viewport 1920×1080) + GPU eval   | 129–156 ms → **mean ~0.14 s**                                                                                    |
| total (cold decode → first full-res pixel, compute) | 1962–2084 ms → **mean ~2.02 s**                                                                                  |
| peak macOS `phys_footprint`                         | 5105 / 5160 / 5133 / 5106 / 5106 MB → **~5.1 GB** (baseline 7 MB → after decode ~4681 MB → after render ~5.1 GB) |

GPU-live A/B: `gpu_live=on` (1995 ms / 5133 MB) vs `gpu_live=off` (1999 ms /
5160 MB) — **identical within noise**. This confirms (rather than measures) the
caveat below: the `processSceneLinear` compute path is unaffected by
`MAPLE_GPU_LIVE`, because GPU-live lives in `EditSession+GpuLive`'s present
path, not in the pipeline call this harness exercises.

Honest caveats:

- This is the **CPU/pipeline compute** cold-open, NOT the full `@Observable`
  `EditSession` session-open. It does not include the embedded-JPEG fast-paint
  that publishes to `renderedPreview` first (~50 ms per the existing
  `testColdOpenPaintsEmbeddedPreviewBeforeRustDecode`) — so the user's true
  _first pixel on screen_ is ~50 ms; the ~2.0 s here is _first full-quality
  pixel_ (compute).
- `quality: .preview` decodes at **half resolution** (6144×4096). A full-res
  (`quality: .full`) decode would be larger in both time and memory — not
  measured.
- macOS `phys_footprint` is a **proxy** for the iOS jetsam ceiling, not the
  device number. True on-device headroom needs an iOS device run (project
  memory references ~4.8 GB "Artemis" device traces on a single GPU open).
- The **GPU-live cold-open peak** — the production iOS large-RAW path that the
  #2033 epic cares about — is NOT captured here (the compute path is GPU-live
  invariant). Measuring it needs the full `EditSession` GPU present path driven
  under Instruments Allocations, or an on-device `MAPLE_MEM_PROBE=1` run.

---

## 3. 100% zoom / native-detail patch (honest scope — GAP on this fixture)

Attempted: call `NativeDetailRenderer.render(...)` directly (the load-bearing
call inside the `native-detail` os_signpost interval) on a centered
viewport-sized 1:1 patch of the 100MP fixture.

**Result: the tile path throws on the reference RAW.**

```
renderFailed(code: 10, message: "pipeline assertion failed: tile path is not
supported when the DNG carries OpcodeList3 (GainMap / WarpRectilinear
gain/warp/CA correction ...). See #1932.")
```

The 100MP DJI Mavic 3 Pro DNG carries **OpcodeList3** (GainMap /
WarpRectilinear), and `NativeDetailRenderer`'s tile path is disabled for such
DNGs (#1932) — a 1:1 zoom on this RAW falls back to the **full-image render
entry** instead of the tile chain. So the 1:1 patch develop **cannot be
measured via the tile path on the reference fixture**.

What it would take to close this gap:

- Measure the full-image-render fallback that a 1:1 zoom on an OpcodeList3 RAW
  actually uses (bounded refine), rather than the tile path; and/or
- Measure the tile path on a non-OpcodeList3 RAW (e.g. `test_0017.dng`) — but
  that is not the 100MP reference; and/or
- Interactive pan profiling under Instruments (Time Profiler + the
  `native-detail` signpost) driving the real GUI — no reliable deterministic
  headless equivalent.

---

## Summary of proposed budget changes (PROPOSAL ONLY)

| Bench                                 | constant                   | current → proposed |
| ------------------------------------- | -------------------------- | ------------------ |
| `SliderTickPerfTests`                 | `interimHardLimitMs`       | 65 → **55**        |
| `FusedChainEncodeSliderTickPerfTests` | `fusedCacheHitCeilingMs`   | 38 → **34**        |
| `SharpenSliderTickPerfTests`          | `sharpenCacheHitCeilingMs` | 80 → **45**        |

## Metrics not measured (and what they need)

- GPU-live cold-open peak memory on the production large-RAW path — needs
  full `EditSession` GPU present under Instruments Allocations, or on-device
  `MAPLE_MEM_PROBE=1`.
- True iOS jetsam peak — needs an on-device run (macOS `phys_footprint` here is
  a proxy).
- Full-res (`quality: .full`) cold-open time/memory — this pass measured only
  the half-res `.preview` decode.
- 1:1 native-detail patch develop on the 100MP reference — blocked by
  OpcodeList3 on the tile path (#1932); needs the full-image fallback measured,
  a non-OpcodeList3 fixture, or interactive Instruments pan profiling.
