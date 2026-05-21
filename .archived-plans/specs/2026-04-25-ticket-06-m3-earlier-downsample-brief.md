# Ticket 06 Milestone 3 — Earlier Downsample (brainstorm brief)

> Source ticket: [`docs/tickets/06-viewport-sized-rust-ffi-preview.md`](../../tickets/06-viewport-sized-rust-ffi-preview.md) § Recommended Milestones / Milestone 3.
> Plan 1 v2 Task 8 added the post-pipeline downsample we are moving earlier: [`.archived-plans/plans/2026-04-24-ffi-split-plan-1.md`](../plans/2026-04-24-ffi-split-plan-1.md) Task 8.

`MAPLE_PROFILE=1` on the 100 MP Mavic 3 Pro fixture: `ffi_rawler_decode`
2.34 s, `linearize` 104 ms, `demosaic` 110 ms, `baseline_exposure` 78 ms,
`dcp::apply` 21 ms, `nr_color` 1.93 s, `downsample_area_f32` 447 ms,
`pack_fp16_sized` 134 ms — total ~5.25 s. ~2.2 s post-demosaic burns on a
~25 Mpx buffer that gets thrown away. Move the downsample earlier and
every later stage shrinks ~8× on a 1500-px viewport — ~1.9 s saved with
no algorithm change.

## 1. Insertion point

Right after `demosaic` (or `linearraw_to_camera_rgb`) inside
[`pipeline.rs::develop_scene_linear_from_raw_with_quality`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:77)
— between [`pipeline.rs:96`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:96)
(end of demosaic match) and the `baseline_exposure` block at
[`pipeline.rs:119`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:119).
Post-demosaic `camera_rgb` is the smallest representation that has all
three channels. Earlier (mosaic) is destructive (drops Bayer phase);
later is the status quo. Shape: a sized-aware variant
`develop_scene_linear_sized_from_raw_with_quality(raw, model, quality, max_long_edge)`
that runs linearize + demosaic, then `downsample_image_area` on the
camera-RGB buffer (already f32), then the existing tail. The full-res
helper stays in place for export and the tile path.

## 2. Halo budget for tile rendering

Tile rendering (M4) locks 35 px overlap on clarity (radius 40, 3-pass
box → 39 px tail per [`stages/clarity.rs:8`](../../../src/raw-pipeline/raw-core/src/stages/clarity.rs:8)).
M3's early-downsample lives only in the `_sized` (non-tile) FFI path;
the tile path keeps full-resolution development inside its padded crop
and is unaffected. Recommendation: leave the 35 px tile-overlap
invariant alone — it's measured against full-res mosaic and remains
correct. The two FFI variants (`_sized` and `_tile`) stay distinct.

## 3. Order-of-operations care

Stages with neighborhood output are clarity (40), sharpen (3-iter RL),
dehaze (67), NR luminance/color. After early downsample they run on
fewer pixels but the *spatial frequency content* of their input matches
the output canvas size — exactly what the display will show. Perceptual
radius (fraction-of-image-width) is preserved. The risk is the
non-commutativity of (downsample ∘ filter) vs (filter ∘ downsample);
for natural scenes the delta is dominated by the downsample kernel and
is bounded by § 6's parity gate.

## 4. Quality vs speed tradeoff

`downsample_image_area` ([`pipeline.rs:322`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:322))
is integer area-average — bias-free, low-pass, deterministic. Parity
fixtures all run with `sharpen_amount = 0` and `nr_luminance = 0`
([`xmp.rs:35`](../../../src/raw-pipeline/raw-core/src/xmp.rs:35) defaults);
the only non-zero default is `nr_color = 25` (radius 1 px), which is
insensitive to downsample-frequency shift. M3 ships with existing
defaults; the harness is the gate.

## 5. API shape

[`render_scene_linear_sized_from_raw_with_quality`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:368)
already takes `max_long_edge` and currently calls
`develop_scene_linear_from_raw_with_quality` then post-pipeline
downsample. M3 keeps the FFI signature unchanged and rewires the
helper: new `develop_scene_linear_sized_from_raw_with_quality` runs
linearize + demosaic + early downsample + the rest. Full-res
`develop_…` stays for export and tile. No FFI / Apple / Web change.

## 6. Test strategy

Two gates. (a) Rust unit test renders test_0017.dng via the old path
(full → end-downsample) and the new (early downsample) and asserts
mean fp16 channel delta ≤ ~0.005 in linear-light. (b)
`BUDGET=15 src/scripts/test_color_pipeline.sh` runs against the new
path; mean ΔE delta vs the committed baseline must be < 1.0 on each
Bayer fixture (no budget ratchet up — CLAUDE.md § "Objective color
testing"). (c) `SceneLinearVisualRegressionTests.swift`
([`SceneLinearVisualRegressionTests.swift:104`](../../../src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearVisualRegressionTests.swift:104))
golden re-records once (a) + (b) pass; user signs off visually.

## 7. Performance gates

Re-measure on the 100 MP Mavic 3 Pro fixture via `MAPLE_PROFILE=1`,
same procedure as Plan 1 v2 Task 7
([`docs/measurement/2026-04-25-ffi-decode-baseline.md`](../../measurement/2026-04-25-ffi-decode-baseline.md)).
Target total ≤ 3.0 s (down from 5.25 s). Hard limit ≤ 3.5 s.
Expected per-stage: `nr_color` 1.93 s → ~250 ms; `baseline_exposure`
78 ms → ~10 ms; `dcp::apply` 21 ms → ~3 ms; `pack_fp16_sized` 134 ms
→ ~17 ms. Floor: `ffi_rawler_decode` 2.34 s (untouched, separate
ticket).

## 8. Deep zoom interaction

Tile rendering (M4) at 1:1 zoom wants full resolution by definition
— the user is pixel-peeping. M3's early-downsample lives only on
`_sized`; the tile FFI keeps calling
`develop_scene_linear_from_padded_mosaic`
([`pipeline.rs:485`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:485))
unchanged. M4's halo math is not affected.

## 9. Recommended cut

Smallest viable first plan: **add
`develop_scene_linear_sized_from_raw_with_quality` and rewire only
`render_scene_linear_sized_from_raw_with_quality` to call it; keep
the full-res `develop_…` helper, the tile path, and every per-stage
function untouched.** No FFI signature change, no Apple change, no
Web change. One new Rust function, one rewire, one unit test, one
harness re-run, one golden re-record. Plan 3 (Web FFI) inherits the
helper for free if it wants the same speedup later.

Plan: [`2026-04-25-ticket-06-m3-earlier-downsample.md`](../plans/2026-04-25-ticket-06-m3-earlier-downsample.md).
