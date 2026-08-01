#![cfg(test)]
//! **#1732 leg (c): the live/refine chain vs the tile develop path.**
//!
//! The 2026-07-02 WB band bug shipped because no gate rendered one image
//! through both the live chain and the tile path and diffed them. #1781
//! closed the gpu-live-vs-CPU half (`raw-ffi/src/gpu_live_wb_frame_tests.rs`);
//! this file closes the half the audit called leg (c): nothing renders the
//! same fixture + `AdjustmentModel` through `pipeline::tile::develop` and
//! diffs it against the chain the editor runs per slider tick.
//!
//! ## What "the same render" means across the two paths
//!
//! The two paths do not start from the same buffer, and that asymmetry IS
//! the contract under test:
//!
//! * **Live / refine** — `pipeline::apply_scene_linear_chain_f32` re-applies
//!   the user-tweakable stages on top of a buffer that a develop already
//!   produced at a fixed decode anchor. Its WB step is the Rec.2020
//!   `SliderFrameExport::apply_delta_rec2020` delta off that anchor.
//! * **Tile** — `tile::develop` starts from the mosaic, so it applies WB in
//!   CAMERA space (`wb_camera::apply_delta`) *before* DCP and retargets the
//!   DCP render profile at the model's own `(temperature, tint)`.
//!
//! So the same `(anchor, model)` pair is expressed through two different
//! algebras — a post-DCP Rec.2020 conjugation vs. a pre-DCP camera-space
//! multiply plus a retargeted profile. `SliderFrameExport` (#1904/#1967)
//! exists precisely to make the first reproduce the second; this gate is
//! what proves it, and what a future edit to either side has to keep true.
//!
//! ## Fixture-free by construction
//!
//! Built on `test_support::synth_chart` in `ChartEncoding::Camera` — a real
//! Bayer DNG whose raw values are synthesised through the Canon EOS 5D
//! Mark IV dual-illuminant DCP model, so `profile_for_with_source` resolves
//! a genuine dual-CM/dual-FM profile and the `wb_camera` + `SliderFrameExport`
//! code paths both engage (the `RawlerFallback` tier would bypass them).
//! No gitignored RAW is involved, so this gate runs on every CI machine via
//! the `rust-tests` job (`cargo test -p raw-core --features test-support`),
//! unlike the fixture-gated tile-vs-full siblings in `tests_render_anchors.rs`.

use super::*;

use crate::color::dcp;
use crate::image::{ExifOrientation, Image};
use crate::pipeline::{
    apply_scene_linear_chain_f32, develop_scene_linear_from_raw_with_quality, ChainOptions,
};
use crate::stages::wb_camera::SliderFrameExport;
use crate::test_support::synth_chart::{ChartEncoding, SyntheticColorChart};
use crate::xmp::AutoExposureMode;

/// Tile rectangle used by every case. Chosen so the padded crop
/// (`TILE_OVERLAP_PX` = 48 per edge) sits strictly INSIDE the chart —
/// 96 ≥ 48 on the near edges, 96 + 224 = 320 ≤ 520 − 48 and
/// 96 + 192 = 288 ≤ 344 − 48 on the far ones. A rect that touched a border
/// would have its pad clamped, giving the tile's guided filters a different
/// neighbourhood than the full-image develop the live buffer came from, and
/// the diff would measure that clamp instead of the chain contract.
const RECT: TileRect = TileRect {
    src_x: 96,
    src_y: 96,
    src_w: 224,
    src_h: 192,
    out_w: 224,
    out_h: 192,
};

/// Border margin excluded from every comparison, in output pixels per side.
///
/// The two paths CANNOT agree at the tile border and it is not a defect that
/// they don't: the tile chain runs its spatial stages on a crop padded by
/// [`TILE_OVERLAP_PX`], so a pixel one row inside the tile edge still sees
/// real neighbours, whereas the live chain runs the same stages on exactly
/// the buffer it was handed — a viewport, whose edge pixels have no
/// neighbours to gather from and fall back to clamped sampling. Comparing
/// those columns would measure the boundary condition, which is a property of
/// the live chain's input, not of the chain contract this gate exists to pin.
///
/// `TILE_OVERLAP_PX` is the right margin because it is already the repo's
/// bound on "how far a tile-safe stage reaches" — the constant every stage
/// admitted to the tile path is required to fit inside (see its const
/// assertion against `clarity::CLARITY_GUIDED_REACH_PX`).
const COMPARE_MARGIN_PX: usize = TILE_OVERLAP_PX as usize;

/// The synthetic camera-encoded chart, sized so [`RECT`] plus its overlap
/// pad fits comfortably inside: 6 × (80 + 8) − 8 = 520 wide, 4 × (80 + 8) − 8
/// = 344 tall.
fn camera_chart_raw() -> crate::image::RawImage {
    let chart = SyntheticColorChart {
        patch_size: 80,
        guard: 8,
        encoding: ChartEncoding::Camera,
        ..SyntheticColorChart::default()
    };
    let bytes = chart.write_to_bytes();
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode synthetic camera chart");
    // The tile entry maps display coords → sensor coords through the EXIF
    // orientation and rejects crop rects it cannot reproduce; the crop
    // arithmetic below assumes the identity mapping. Assert rather than
    // silently compare misaligned pixels if the generator ever changes.
    assert_eq!(raw.orientation, ExifOrientation::Normal);
    assert!(raw.crop_rect.is_none());
    assert!(raw.opcode_list3.is_none());
    raw
}

/// The decode-exported WB slider frame for `raw` — the same
/// `SliderFrameExport::resolve` the FFI's `wb_frame_export` hands the host
/// (`raw-ffi/src/scene_linear_f32.rs`), reproduced here so raw-core can gate
/// the contract without the FFI crate.
fn slider_frame(raw: &crate::image::RawImage) -> SliderFrameExport {
    let (profile, source) = dcp::profile_for_with_source(raw).expect("dcp profile");
    assert!(
        !matches!(source, dcp::ProfileSource::RawlerFallback),
        "synthetic camera chart must resolve a real DCP profile — the \
         RawlerFallback tier bypasses wb_camera and SliderFrameExport, which \
         are the two sides this gate exists to compare"
    );
    SliderFrameExport::resolve(raw, &profile)
}

/// The model the cached scene-linear buffer is decoded at: every stage the
/// live chain re-applies is neutral (including `sharpen_amount` = 40 and
/// `nr_color` = 25, which are NOT zero in `AdjustmentModel::default()` —
/// leaving them would bake the stage into the buffer AND re-apply it per
/// tick), auto-exposure off, WB parked at the anchor.
pub(super) fn decode_model(anchor: (f32, f32)) -> AdjustmentModel {
    AdjustmentModel {
        temperature: anchor.0,
        tint: anchor.1,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    }
}

/// Crop `img` to [`RECT`] and pack it as f32 RGBA — the buffer slice the
/// live chain would be handed for this tile.
fn crop_rect_rgba(img: &Image) -> Vec<f32> {
    let w = img.width as usize;
    let mut out = Vec::with_capacity((RECT.src_w * RECT.src_h * 4) as usize);
    for y in 0..RECT.src_h as usize {
        for x in 0..RECT.src_w as usize {
            let p = img.pixels[(RECT.src_y as usize + y) * w + RECT.src_x as usize + x];
            out.extend_from_slice(&[p[0], p[1], p[2], 1.0]);
        }
    }
    out
}

/// Both renders of one `(fixture, model)` pair, plus the decode buffer they
/// are measured against. Built once per fixture by [`Harness::new`] so the
/// develop cost is paid once for a whole case set.
pub(super) struct Harness {
    raw: crate::image::RawImage,
    frame: SliderFrameExport,
    /// The decode WB anchor — the frame's own as-shot pair, which is what an
    /// untouched editor open parks the sliders at (#1976).
    pub(super) anchor: (f32, f32),
    /// The develop-produced buffer, cropped to [`RECT`] — path (b)'s input
    /// and the identity reference.
    pub(super) decoded_tile: Vec<f32>,
}

impl Harness {
    pub(super) fn new() -> Harness {
        let raw = camera_chart_raw();
        let frame = slider_frame(&raw);
        let anchor = (frame.scene_cct, frame.as_shot_tint);
        assert!(
            anchor.0 > 0.0,
            "slider frame carries no as-shot CCT — the anchor would be meaningless"
        );
        let decoded = develop_scene_linear_from_raw_with_quality(
            &raw,
            &decode_model(anchor),
            RenderQuality::Full,
        )
        .expect("decode develop");
        let decoded_tile = crop_rect_rgba(&decoded);
        Harness {
            raw,
            frame,
            anchor,
            decoded_tile,
        }
    }

    /// Path (b): the CPU live/refine chain over the decode buffer.
    ///
    /// `skip_agx: true` is what makes the comparison like-for-like: the tile
    /// path returns SCENE-linear pixels (the view transform runs in the
    /// caller's render tail, not in `tile::develop`), so the chain must stop
    /// at the same boundary. This is the ONE place the two paths are directly
    /// comparable — past the view transform the tile path has no output at
    /// all to compare against.
    pub(super) fn live(&self, model: &AdjustmentModel) -> Vec<f32> {
        apply_scene_linear_chain_f32(
            &self.decoded_tile,
            RECT.src_w,
            RECT.src_h,
            model,
            &ChainOptions {
                decoded_temp: self.anchor.0,
                decoded_tint: self.anchor.1,
                wb_frame: Some(&self.frame),
                skip_agx: true,
                ..ChainOptions::default()
            },
        )
        .expect("live chain")
    }

    /// Path (c): the deep-zoom tile chain, from the mosaic, at the same rect
    /// and the same decode anchor.
    pub(super) fn tile(&self, model: &AdjustmentModel) -> Vec<f32> {
        let (w, h, out) = render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_f32(
            &self.raw,
            model,
            RECT,
            RenderQuality::Full,
            Some(self.anchor),
        )
        .expect("tile render");
        assert_eq!((w, h), (RECT.out_w, RECT.out_h), "tile output dims");
        out
    }
}

/// Per-case agreement metrics between two scene-linear f32 RGBA buffers.
pub(super) struct Agreement {
    /// Largest absolute per-lane difference.
    pub(super) max_abs: f32,
    /// Largest |a/b − 1| over lanes whose reference magnitude clears
    /// `RATIO_FLOOR` — the ticket's "channel-ratio agreement" metric. A pure
    /// absolute bound would be dominated by the bright chart patches and say
    /// nothing about the dark ones, where a WB algebra mismatch shows up as a
    /// hue shift at small magnitude.
    pub(super) max_ratio_dev: f32,
    /// How far the CASE moved the image away from the decode buffer, in the
    /// same absolute units — the non-vacuity denominator.
    pub(super) moved: f32,
}

/// Lanes below this scene-linear magnitude are excluded from the ratio
/// metric: at 1e-3 a single f32 ulp of the surrounding arithmetic is already
/// a percent-level ratio, so including them would measure rounding noise, not
/// chain agreement. They stay covered by `max_abs`.
const RATIO_FLOOR: f32 = 1e-3;

/// Every case must move the developed buffer by at least this much, in the
/// same absolute scene-linear units the ceilings are expressed in. Two-plus
/// orders of magnitude above the ceilings below, so a case can never be
/// "passing" merely because its model turned out to be a near-no-op — which
/// is exactly how a parity gate silently stops gating.
pub(super) const MIN_CASE_EFFECT: f32 = 1e-2;

/// Flatten `buf` (f32 RGBA over [`RECT`]) to RGB lanes, keeping only the
/// interior — see [`COMPARE_MARGIN_PX`].
fn interior_lanes(buf: &[f32]) -> Vec<f32> {
    let (w, h) = (RECT.src_w as usize, RECT.src_h as usize);
    assert_eq!(buf.len(), w * h * 4, "buffer is not RECT-shaped");
    assert!(
        w > 2 * COMPARE_MARGIN_PX && h > 2 * COMPARE_MARGIN_PX,
        "RECT is too small to leave an interior after the compare margin"
    );
    let mut out = Vec::with_capacity((w - 2 * COMPARE_MARGIN_PX) * (h - 2 * COMPARE_MARGIN_PX) * 3);
    for y in COMPARE_MARGIN_PX..h - COMPARE_MARGIN_PX {
        for x in COMPARE_MARGIN_PX..w - COMPARE_MARGIN_PX {
            let i = (y * w + x) * 4;
            out.extend_from_slice(&buf[i..i + 3]);
        }
    }
    out
}

pub(super) fn agreement(live: &[f32], tile: &[f32], decoded: &[f32]) -> Agreement {
    assert_eq!(live.len(), tile.len(), "buffer length mismatch");
    let (l, t, d) = (
        interior_lanes(live),
        interior_lanes(tile),
        interior_lanes(decoded),
    );
    let max_abs = l
        .iter()
        .zip(&t)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f32, f32::max);
    let max_ratio_dev = l
        .iter()
        .zip(&t)
        .filter(|(_, b)| b.abs() > RATIO_FLOOR)
        .map(|(a, b)| (a / b - 1.0).abs())
        .fold(0.0f32, f32::max);
    let moved = l
        .iter()
        .zip(&d)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f32, f32::max);
    Agreement {
        max_abs,
        max_ratio_dev,
        moved,
    }
}

/// One parameterised case: a name, the model to drive both paths with, and
/// the ceilings that model's output must stay under.
struct Case {
    name: &'static str,
    model: AdjustmentModel,
    /// Ceiling for [`Agreement::max_abs`].
    max_abs: f32,
    /// Ceiling for [`Agreement::max_ratio_dev`].
    max_ratio_dev: f32,
}

/// The parameterised model set (#1732's "coverage beyond WB").
///
/// Deliberately small and stage-CLASS-shaped rather than combinatorial: one
/// case per class of stage that could plausibly desynchronise the two paths —
/// WB (different algebras, the #1725/#1781 seam), the scene tone block
/// (nonlinear in pixel value, so it does not commute with a WB mismatch and
/// AMPLIFIES one), the colour block (Oklab chroma ops, where a hue-rotated WB
/// mismatch shows up as a saturation difference), and one combined case that
/// engages all three at once at a non-default WB.
///
/// Every case pins `sharpen_amount` / `nr_color` / `nr_luminance` to zero for
/// the reason the sibling `tests_render_anchors.rs` cases do: their separable
/// row-sum accumulation is buffer-position dependent, so a tile and a
/// full-image develop legitimately differ there by float-ordering noise that
/// has nothing to do with the contract under test. `clarity` / `texture` DO
/// run — their guided-filter reach (≤ 40 px) fits inside `TILE_OVERLAP_PX`, so
/// they are genuinely expected to agree, and the combined case exercises that.
///
/// `highlights` / `shadows` are deliberately ABSENT here and covered by the
/// separate known-gap test below: their detail mask is anchored to the buffer
/// it is handed rather than to the full image, so the two paths compute
/// different mask radii and diverge by two orders of magnitude more than
/// everything else. That is a stage defect, not a chain-contract defect —
/// tracked as #2476. Folding it into this set would have forced a ceiling
/// loose enough to stop gating the other four.
///
/// Budgets are per-case measured ceilings with roughly 2× headroom, not a
/// single global slop number. The headroom covers cross-architecture float
/// differences (this gate runs on x86_64 in CI and arm64 locally, and
/// raw-core dispatches SIMD via `multiversion`); 2× still leaves every
/// ceiling ~100× below the divergence class the gate exists to catch.
fn cases(anchor: (f32, f32)) -> Vec<Case> {
    let base = AdjustmentModel {
        temperature: anchor.0,
        tint: anchor.1,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    vec![
        Case {
            name: "wb-only (non-default temp/tint)",
            model: AdjustmentModel {
                temperature: anchor.0 + 1400.0,
                tint: anchor.1 - 25.0,
                ..base.clone()
            },
            max_abs: 2.6e-4,
            max_ratio_dev: 5.7e-4,
        },
        Case {
            name: "scene tone block (exposure/brightness/whites/blacks)",
            model: AdjustmentModel {
                exposure: 0.6,
                brightness: 25.0,
                whites: 20.0,
                blacks: -15.0,
                ..base.clone()
            },
            max_abs: 4.7e-4,
            max_ratio_dev: 5.8e-4,
        },
        Case {
            name: "colour block (vibrance/saturation/HSL)",
            model: AdjustmentModel {
                vibrance: 40.0,
                saturation: -25.0,
                hue_adjustment_orange: 20.0,
                saturation_adjustment_blue: -30.0,
                luminance_adjustment_green: 25.0,
                ..base.clone()
            },
            max_abs: 2.3e-4,
            max_ratio_dev: 5.2e-4,
        },
        Case {
            name: "combined at non-default WB (+ clarity/texture)",
            model: AdjustmentModel {
                temperature: anchor.0 - 900.0,
                tint: anchor.1 + 18.0,
                exposure: -0.4,
                brightness: -20.0,
                vibrance: 30.0,
                saturation: 15.0,
                clarity: 20.0,
                texture: 25.0,
                ..base.clone()
            },
            max_abs: 2.9e-4,
            max_ratio_dev: 7.9e-4,
        },
    ]
}

/// **THE LEG-(c) GATE.** For each case, render the SAME synthetic fixture
/// and the SAME `AdjustmentModel` through
///
///   (b) `apply_scene_linear_chain_f32` over the develop-produced buffer,
///       anchored at the decode WB and carrying the decode-exported slider
///       frame — the CPU refine chain, and the oracle the gpu-live chain is
///       held to by `raw-ffi/src/gpu_live_wb_frame_tests.rs`; and
///   (c) `render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_f32`
///       over the same rect with the same anchor — the deep-zoom tile chain,
///
/// and require channel-ratio agreement within the per-case ceiling. See
/// [`Harness::live`] for why the chain runs with `skip_agx`.
#[test]
fn live_chain_matches_tile_develop_across_models() {
    let h = Harness::new();

    for case in cases(h.anchor) {
        let live = h.live(&case.model);
        let tile = h.tile(&case.model);
        let a = agreement(&live, &tile, &h.decoded_tile);
        eprintln!(
            "[{}] live-vs-tile: max_abs {:.3e}, max_ratio_dev {:.3e} (case moved the image by {:.3e})",
            case.name, a.max_abs, a.max_ratio_dev, a.moved
        );

        // Non-vacuity FIRST: a case that barely moves the image would make
        // the ceilings below pass for the wrong reason.
        assert!(
            a.moved > MIN_CASE_EFFECT,
            "[{}] case moved the image by only {:.3e} (< {:.3e}) — the model \
             is too close to a no-op for the agreement ceilings to mean \
             anything",
            case.name,
            a.moved,
            MIN_CASE_EFFECT
        );
        assert!(
            a.max_abs <= case.max_abs,
            "[{}] live chain and tile develop disagree: max abs diff {:.4e} > {:.4e}",
            case.name,
            a.max_abs,
            case.max_abs
        );
        assert!(
            a.max_ratio_dev <= case.max_ratio_dev,
            "[{}] live chain and tile develop disagree: max channel-ratio \
             deviation {:.4e} > {:.4e}",
            case.name,
            a.max_ratio_dev,
            case.max_ratio_dev
        );
    }
}

// The identity half of the contract (both paths must be a no-op at the
// decode anchor) and the #2476 known-gap ceiling live in the sibling
// `tests_live_parity_gaps.rs`, split out for the file-size budget; they
// reuse the `pub(super)` `Harness` above.
