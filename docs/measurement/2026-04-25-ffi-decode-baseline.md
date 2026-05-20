# Spike 1.3 — FFI decode baseline (Plan 1)

Plan: `.archived-plans/plans/2026-04-24-ffi-split-plan-1.md` Task 1 → Spike 1.3.

This is the locked baseline + reproducible measurement procedure for the
half-res Preview cold-open hard-stop. Plan 1 Task 5 Step 5.7 fails the spike
(and the whole plan) if the post-change median exceeds the +10% threshold
recorded here.

## Locked baseline

| Metric                  | Value                          |
| ----------------------- | ------------------------------ |
| Reference fixture       | `test-fixtures/raws/dji-mavic3pro-100mp.dng` (100 MP Hasselblad L3D-100c, ~129 MB DNG) |
| Cold-open median        | **4740 ms** (5 cold opens, current `main` after `nr_color` hoist + rayon work — user-reported `[swift] rust FFI decode`) |
| Hard-stop threshold     | **5210 ms** (4740 + 10%)       |
| Allowed regression      | ≤ +474 ms net                  |

Source: user observation on personal hardware. Numbers above the +10% threshold
fail Spike 1.3 and stop Plan 1 before Task 5 wires the new path into `EditSession`.

## Procedure

### Pre-requisites

- Reference DNG present at `src/raw-pipeline/test-fixtures/raws/dji-mavic3pro-100mp.dng`
  (`test-fixtures/` is gitignored — fetch locally per `docs/raw-pipeline-architecture.md`).
- Rust toolchain + iOS/macOS targets installed; xcframework rebuilt against the
  current `raw-core` (`./src/apple/scripts/build-xcframework.sh`).
- macOS app built in **Debug** for app-side measurements, **Release** for the
  CLI sanity check (the user's 4740 ms baseline is from the Debug app — keep
  apples-to-apples).

### Per-stage Rust instrumentation (already on `main`, commit `ed96688`)

`raw-core/src/pipeline.rs` wraps every stage with `stage(<name>, ||  ...)`.
Setting `MAPLE_PROFILE=1` in the environment causes each call to print:

```
[raw-core] <stage>                    <elapsed>
```

The stages the new scene-linear path **skips** are:

- `agx`
- `rec2020_to_srgb`
- `quantize_u8`
- `apply_orientation`

These four are the savings floor (Plan 1 Task 5 calls out their sum). All
other stages (linearize, demosaic, baseline_exposure, highlight_recovery,
dcp::profile_for, dcp::apply, white_balance, scene_tone_controls, vibrance,
saturation, clarity, texture, dehaze, sharpen, nr_luminance, nr_color)
are shared.

### Per-stage Swift instrumentation (added by Plan 1 Task 7)

Task 7 adds a `swiftStage(...)` helper to `EditSession.swift` that mirrors
the Rust `stage()` helper. It splits the conflated `[swift] rust FFI decode`
single-number observation into discrete `[swift] <stage>` lines:

- `[swift] cached preview lookup`
- `[swift] decode FFI call (cold)`
- `[swift] decode result copy`
- `[swift] decode CIImage build`
- `[swift] filter chain (.fast)`

Read these via `log stream --process Maple --predicate 'composedMessage CONTAINS "[swift]"'`
or by launching the app from Terminal so stderr is visible. Until Task 7
lands, only the Rust `[raw-core]` lines are available — see "Pre-Task-7
fallback" below.

### Cold-open measurement (Apple, Debug build)

This is the canonical procedure. Run **5 times** per path (legacy and new
once Task 5 lands) and take the median.

Terminal A — build once:

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -3
# Expected: BUILD SUCCEEDED
```

Terminal B — repeat 5 times, quitting + relaunching between each open:

```bash
# Legacy path (today, default — MAPLE_SCENE_LINEAR unset):
MAPLE_PROFILE=1 \
  open -a /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app

# (Open the reference DNG in the running Maple app. Wait for the preview
# to fully render. Quit the app. Relaunch.)

# Capture stderr in another window:
log stream --process Maple --predicate 'composedMessage CONTAINS "[swift]" OR composedMessage CONTAINS "[raw-core]"'
```

Once Task 5 lands the new path, repeat 5 cold opens with
`MAPLE_SCENE_LINEAR=1` set in the environment (Task 5's env-gate). Median
each set of 5; subtract; the net change is what Spike 1.3 evaluates against
the +474 ms hard stop.

### Pre-Task-7 fallback (Rust-only, CLI)

If the Swift `[swift] <stage>` instrumentation is not yet in place (Task 7
hasn't landed) and only a Rust-only sanity check is wanted, the CLI emits
the per-stage `[raw-core]` breakdown for `Full` quality:

```bash
cd src/raw-pipeline
MAPLE_PROFILE=1 ./target/release/maple-cli \
  render <REF_DNG_PATH> \
  --out /tmp/spike-1-3-procedure.png 2>&1 \
  | tee /tmp/spike-1-3-procedure.log
```

**Caveat — the CLI is not a Preview-path proxy.** `maple-cli` always runs
`render_from_raw` → `RenderQuality::Full`; there is no `--quality preview`
flag today (see `maple-cli/src/main.rs`). The user's 4740 ms cold-open is
the half-res Preview path through the Apple xcframework, not the CLI's
Full path. The CLI is useful only to confirm `MAPLE_PROFILE` plumbing
emits the expected `[raw-core]` lines; the Apple measurement above is the
canonical Spike 1.3 number.

The earlier draft of Plan 1 Step 1.3.1 wrote a `batch <(printf ...)`
command with a `quality:"preview"` JSON field. That command does not run
today — the CLI's batch manifest schema (`{"cases": [{"raw","xmp","name","outputs"}]}`)
has no `quality` field, and uses `--manifest <path>`, not a positional
argument. Disregard that command; use the Apple build above.

## Reproducibility verification (this worktree, 2026-04-25)

The 100 MP Hasselblad fixture is gitignored and not present in this
worktree. To verify the per-stage instrumentation is wired correctly,
ran the CLI procedure on two locally-available smaller DNGs:

- `test_0006.DNG` (~6 MB — small / smartphone-class). All 20 stages emit;
  the four skip-on-new-path stages totaled `agx 89.10 + rec2020_to_srgb 4.89 + quantize_u8 52.87 + apply_orientation 1.26 = 148.12 ms`.
- `test_0017.dng` (~34 MB — mid-size). Same 20 stages emit;
  skip-stage sum: `31.59 + 2.81 + 69.01 + 1.86 = 105.27 ms`.

Procedure verified end-to-end. Absolute numbers do not match the user's
4740 ms — that's the 100 MP Preview path through the Apple build, not
the CLI's Full-quality path on a smaller fixture. Per-stage breakdown
shape is correct; the four "skipped on new path" stages (`agx`,
`rec2020_to_srgb`, `quantize_u8`, `apply_orientation`) are present and
discrete on every run.

## Verdict

**Spike 1.3 procedure: PASS** — measurement procedure reproducibly emits
the expected per-stage instrumentation; baseline (4740 ms) and hard-stop
(5210 ms) locked.

**End-to-end verification of the +10% gate is BLOCKED** until:

1. Plan 1 Task 5 lands the new scene-linear FFI path.
2. Plan 1 Task 7 splits the `[swift] rust FFI decode` single-number observation.
3. The 100 MP reference fixture is present locally (user-provided —
   we do not have it).

The user (or whoever runs the post-Task-5 measurement) executes the
"Cold-open measurement (Apple, Debug build)" procedure above on the
100 MP fixture, records the median, and writes the comparison into the
`SceneLinearPipelineTests.swift` test-file header per Plan 1 Step 5.6 /
Step 1.3.2 / Step 7.5.

## Hard-stop quick reference

| Net change vs 4740 ms | Verdict                        |
| --------------------- | ------------------------------ |
| ≤ +474 ms             | Pass (regression accepted)     |
| > +474 ms (> 5210 ms) | **Stop. Plan 1 needs revision.** |
