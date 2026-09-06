//! Tile-rendering entry used by the deep-zoom viewer.
//!
//! The tile path runs `linearize` ONLY on a padded crop region (rather
//! than the whole sensor), then runs a stripped-down develop chain
//! against it (auto-exposure is never recomputed per-tile — a tile's
//! histogram isn't representative of the whole scene — but the caller
//! can thread in the gain a full-image develop already measured, see
//! [`render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_and_ae_gain_f32`],
//! #1167; dehaze, BM3D deep denoise and OpcodeList3 DNGs are rejected
//! loudly at the entry — see `guards.rs`), then trims the overlap,
//! downsamples to the requested output size, and packs the result as
//! oriented fp16 RGBA.
//! This makes a 23-tile view of a 100 MP RAW land in ~10 s rather than
//! ~10 minutes.
//!
//! The overlap pad is computed per render (#1157, tone-zoom design § 5.3):
//! the sum of the stencil reaches of the spatial stages the model engages,
//! on the [`TILE_OVERLAP_PX`] floor — see `overlap.rs`. Point ops whose
//! field spans the frame (vignette, local adjustments) get the tile's
//! window in the frame (`region::TileWindow`) instead of an overlap.
//!
//! Submodules (split for the file-size budget, #114):
//! * [`region`]  — pad/clamp/crop/trim geometry helpers + `TileWindow`.
//! * [`guards`]  — the rejection set.
//! * [`overlap`] — the per-render pad calculator.
//! * [`develop`] — the develop chain run on the padded crop.

mod develop;
mod guards;
mod overlap;
mod region;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_full_parity;
#[cfg(test)]
mod tests_live_parity;
#[cfg(test)]
mod tests_live_parity_gaps;
#[cfg(test)]
mod tests_render;
#[cfg(test)]
mod tests_render_anchors;

use crate::{error::Result, image::RawImage, linearize, xmp::AdjustmentModel};
use rayon::prelude::*;

use super::{
    downsample::downsample_image_area, finite_or_zero, fp16::f32_to_f16_bits,
    orient::apply_orientation_f32_rgba, stage, RenderQuality,
};

use develop::{develop_scene_linear_from_padded_mosaic, full_frame_long_edge};
use overlap::tile_overlap_px;
use region::{pad_and_clamp_mosaic_rect, trim_image_to_inner, TileWindow};

/// Tile-overlap pad in source pixels per edge. Picked to satisfy
/// clarity's stencil reach (40 px per side: a guided filter at
/// `CLARITY_GUIDED_RADIUS = 20` performs `mean_a` / `mean_b` box-blurs
/// on a buffer that was itself box-blurred at radius 20, so the
/// effective reach is `2 * 20 = 40 px`). Clarity is the binding
/// stencil among the tile-safe stages. Other stages (demosaic 2 px,
/// sharpen ≤ 9 px, nr_color ≤ 4 px, texture ≈ 4 px) sit comfortably
/// inside this pad. Dehaze (radius 67) is NOT tile-safe —
/// `render_scene_linear_tile_from_raw_with_quality` errors when
/// `model.dehaze != 0`.
///
/// 48 = 40 (clarity guided-filter reach) rounded up with headroom.
/// The const assertion below ties this value to
/// `clarity::CLARITY_GUIDED_REACH_PX` — if the clarity radius is ever
/// bumped, the build will refuse until this constant follows.
pub const TILE_OVERLAP_PX: u32 = 48;

// Build-time guard: TILE_OVERLAP_PX must cover the clarity guided-filter
// reach. If `CLARITY_GUIDED_RADIUS` is raised, the reach (= 2 * radius)
// grows and this assertion fails until `TILE_OVERLAP_PX` is bumped.
const _: () = assert!(
    (TILE_OVERLAP_PX as usize) >= crate::stages::clarity::CLARITY_GUIDED_REACH_PX,
    "TILE_OVERLAP_PX must cover the clarity guided-filter reach; bump it when CLARITY_GUIDED_RADIUS grows.",
);

/// Source-pixel rectangle + target output dimensions for a tile render.
///
/// Groups the six geometry parameters that used to be passed positionally
/// to `render_scene_linear_tile_from_raw_with_quality_and_wb_anchor` (which
/// pushed it past the project's 5-parameter / no-`too_many_arguments`
/// guideline).
#[derive(Debug, Clone, Copy)]
pub struct TileRect {
    /// Source-pixel rectangle origin/size in mosaic coordinates
    /// (pre-orientation). Rounded to even via `pad_and_clamp_mosaic_rect`
    /// for Bayer-phase preservation.
    pub src_x: u32,
    pub src_y: u32,
    pub src_w: u32,
    pub src_h: u32,
    /// Target output dimensions — never upscale; the render errors if
    /// `out_w > src_w || out_h > src_h`.
    pub out_w: u32,
    pub out_h: u32,
}

/// Exact padded working area for a host's allocation budget (#1107).
pub(crate) fn tile_working_pixels(
    raw: &RawImage,
    model: &AdjustmentModel,
    rect: TileRect,
    quality: RenderQuality,
) -> Result<u64> {
    guards::reject_untileable(raw, model, rect)?;
    let (x, y, w, h) = raw.orientation.display_rect_to_sensor(
        rect.src_x, rect.src_y, rect.src_w, rect.src_h, raw.width, raw.height,
    );
    let divisor = crate::pipeline::develop::effective_quality_divisor(quality, raw.cfa);
    let overlap = tile_overlap_px(model, full_frame_long_edge(raw, quality), divisor);
    let ((_, _, pw, ph), _) = pad_and_clamp_mosaic_rect(x, y, w, h, overlap, raw.width, raw.height);
    Ok(u64::from(pw) * u64::from(ph))
}

/// Render a tile of the developed scene-linear Rec.2020 fp16 RGBA image.
///
/// Parameters:
/// - `rect`: source-pixel rectangle (`rect.src_x/src_y/src_w/src_h`, mosaic
///   coordinates, pre-orientation) and target output dimensions
///   (`rect.out_w/out_h`) — never upscale; this fn errors if
///   `rect.out_w > rect.src_w || rect.out_h > rect.src_h`. See [`TileRect`].
/// - `quality`: `Preview` (half-res quad demosaic) or `Full` (bilinear or
///   hamilton_adams per `cfg(feature)`).
///
/// Errors (the full set lives in `guards.rs`):
/// - `model.dehaze != 0` → returns `Err` with a "dehaze" message; dehaze
///   is global (frame statistics + a radius-60 transmission refine) and
///   needs a full-frame proxy plane the tile chain does not build.
/// - `model.deep_denoise != 0` → returns `Err` ("deep denoise"); the
///   BM3D reference-patch grid is frame-anchored, so per-tile grids
///   would seam (#1105). Same fallback contract as dehaze.
/// - a DNG carrying OpcodeList3 → returns `Err` ("OpcodeList3"); the
///   WarpRectilinear resample gathers from displaced source positions that
///   can exceed the overlap pad, and the tile chain does not apply opcodes,
///   so tiled output would disagree with (and seam against) the full render
///   (#1932). Same fallback contract as dehaze.
/// - `out_w > src_w || out_h > src_h` → returns `Err` ("upscale"); the
///   tile path caps at native resolution.
/// - `(out_w, out_h)` aspect does not match `(src_w, src_h)` aspect →
///   returns `Err` ("matching aspect"). The tile path's
///   `downsample_image_area` is single-axis (long-edge driven), so a
///   non-matching aspect would be silently snapped to a square fit. We
///   reject loudly instead; callers requesting non-square output should
///   recrop to the matching aspect first.
///
/// Output is fp16 RGBA, length `4 * out_w * out_h`, alpha = 0x3c00. The
/// orientation is applied by walking the trim+downsample output through
/// `apply_orientation_f32_rgba` (so the `(src_x, src_y)` handed in is in
/// pre-orientation space; the returned tile's orientation matches the
/// full-image's `apply_orientation` output).
pub fn render_scene_linear_tile_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    rect: TileRect,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u16>)> {
    render_scene_linear_tile_from_raw_with_quality_and_wb_anchor(raw, model, rect, quality, None)
}

/// Shared tile pipeline: guard set + coordinate translation + develop + trim
/// + downsample + EXIF-orient, producing oriented **f32** RGBA at the target
/// size. The fp16 and f32 public tile entries both wrap this so the whole
/// guard set and geometry stay single-sourced (#1945). See the public
/// wrappers below for the WB-anchor contract.
///
/// `ae_gain` (#1167) is the auto-exposure anchor gain to thread into
/// [`develop_scene_linear_from_padded_mosaic`] — `1.0` (every wrapper below
/// except the explicit `_and_ae_gain_` one) is a bit-identical no-op, exactly
/// reproducing this chain's pre-#1167 output.
fn develop_tile_oriented_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    rect: TileRect,
    quality: RenderQuality,
    decoded_wb_anchor: Option<(f32, f32)>,
    ae_gain: f32,
) -> Result<(u32, u32, Vec<f32>)> {
    let TileRect {
        src_x,
        src_y,
        src_w,
        src_h,
        out_w,
        out_h,
    } = rect;
    guards::reject_untileable(raw, model, rect)?;
    // (src_x, src_y, src_w, src_h) are in DISPLAY-oriented source coords —
    // that's what callers (Apple TileManager, maple-cli `tile` subcommand)
    // know about. Translate to sensor coords before cropping the mosaic.
    // For non-Normal orientations (e.g. Rotate 270 CW on Canon CR2), the
    // sensor rect is at a rotated position and the dims may swap. The
    // final `apply_orientation_f32_rgba` step rotates the developed tile
    // back into display orientation, so the returned tile lines up with
    // the display tile coords the caller asked for.
    let (s_x, s_y, s_w, s_h) = raw
        .orientation
        .display_rect_to_sensor(src_x, src_y, src_w, src_h, raw.width, raw.height);
    // The pad is per render (#1157): the sum of the stencil reaches of every
    // spatial stage this model engages, on the fixed floor — see `overlap.rs`.
    let divisor = crate::pipeline::develop::effective_quality_divisor(quality, raw.cfa);
    let overlap_px = tile_overlap_px(model, full_frame_long_edge(raw, quality), divisor);
    let (rect, (left_pad, top_pad)) =
        pad_and_clamp_mosaic_rect(s_x, s_y, s_w, s_h, overlap_px, raw.width, raw.height);
    // Linearize ONLY the padded crop region — not the full sensor.
    // For a 100 MP RAW (~12288×8192) the per-tile cost was ~480 ms;
    // a 512+overlap region is ~582×582 px, ~10 ms. ~50× speedup with
    // 23 visible tiles → ~10 s total. Bayer phase is preserved because
    // `pad_and_clamp_mosaic_rect` aligns start corners to even.
    let (rx, ry, rw, rh) = rect;
    // Where this padded crop sits in the developed frame — what vignette and
    // local adjustments anchor their fields to (#1157).
    let window = TileWindow::for_padded_crop(raw, rx, ry, divisor);
    let mut mosaic = stage("tile_linearize", || {
        linearize::sensor_linearize_region(raw, rx, ry, rw, rh)
    });
    // Hot/dead-pixel suppression (#1106) — pre-demosaic, ≤3 px stencil
    // (≪ TILE_OVERLAP_PX), translation-invariant. Bayer-only here: the
    // even-aligned padded origin preserves the 2×2 phase, so the local
    // `color_at` indexing matches the full-frame path; X-Trans tiles are
    // rejected by the develop below before any pixel work (#420).
    if raw.cfa.is_bayer_2x2() {
        stage("tile_hot_pixel", || {
            crate::stages::hot_pixel::apply(&mut mosaic, raw.cfa, model.hot_pixel_suppression)
        });
    }
    let inner = (
        left_pad / divisor,
        top_pad / divisor,
        s_w / divisor,
        s_h / divisor,
    );
    let developed = develop_scene_linear_from_padded_mosaic(
        &mosaic,
        raw,
        model,
        quality,
        develop::TileAnchors {
            decoded_wb_anchor,
            ae_gain,
            window,
            inner,
        },
    )?;

    // Trim the overlap, leaving the inner s_w × s_h block in SENSOR coords
    // (rotation applied below). For half-res Preview the trim coords
    // halve too — the cropped mosaic was half-resed by `demosaic::half_res`,
    // so the inner region is at `(left_pad / 2, top_pad / 2)` with size
    // `(s_w / 2, s_h / 2)`. For `Full` quality the chain preserves
    // dimensions, so it's `(left_pad, top_pad)` with `(s_w, s_h)`.
    let (inner_lp, inner_tp, inner_w, inner_h) = developed.inner;
    let mut sized = stage("tile_trim_inner", || {
        trim_image_to_inner(&developed.image, inner_lp, inner_tp, inner_w, inner_h)
    });

    let target_long_edge = out_w.max(out_h);
    if target_long_edge < sized.width.max(sized.height) {
        stage("tile_downsample_area", || {
            downsample_image_area(&mut sized, target_long_edge)
        });
    }

    let (w0, h0) = (sized.width, sized.height);
    // NaN/Inf scrub at the pack endcap (#1088) — same contract as the
    // scene-linear packs in `pipeline::render`.
    let rgba_f32 = stage("tile_pack_rgba_f32", || {
        let mut v = Vec::with_capacity(sized.pixels.len() * 4);
        for p in &sized.pixels {
            v.push(finite_or_zero(p[0]));
            v.push(finite_or_zero(p[1]));
            v.push(finite_or_zero(p[2]));
            v.push(1.0);
        }
        v
    });

    // Orient the tile in fp32 RGBA. Per the conversion at the top of
    // this function, the cropped sensor data corresponds to the caller's
    // display rect; rotating it now produces a tile in display
    // orientation that lines up with the display tile coords the caller
    // asked for.
    let (w, h, oriented_f32) = stage("tile_apply_orientation_rgba", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    Ok((w, h, oriented_f32))
}

/// Same as [`render_scene_linear_tile_from_raw_with_quality`], with an
/// explicit WB delta anchor (#1725 band fix).
///
/// `decoded_wb_anchor = Some((decoded_temp, decoded_tint))` makes this tile
/// render use the SAME delta contract as the app's live-chain
/// (`pipeline::apply_scene_linear_chain`): `model.temperature`/`model.tint`
/// are applied relative to the buffer's decode-time WB, so a tile rendered
/// with `model.temperature == decoded_temp` (the common "unedited open"
/// case, where both are the image's as-shot CCT) is IDENTITY — matching the
/// GPU-live frame exactly instead of shifting away from it. `None` keeps the
/// legacy ABSOLUTE `resolve_wb` + `apply` contract, correct for the
/// maple-cli / XMP-render family where `crs:Temperature` is an absolute
/// value. See `tile::develop::develop_scene_linear_from_padded_mosaic`'s
/// doc-comment for the full rationale.
///
/// Output is **fp16** RGBA (8 B/px). The f32 counterpart
/// [`render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_f32`] shares
/// the identical develop/geometry via [`develop_tile_oriented_f32`] and only
/// differs in the final pack precision.
pub fn render_scene_linear_tile_from_raw_with_quality_and_wb_anchor(
    raw: &RawImage,
    model: &AdjustmentModel,
    rect: TileRect,
    quality: RenderQuality,
    decoded_wb_anchor: Option<(f32, f32)>,
) -> Result<(u32, u32, Vec<u16>)> {
    let (w, h, oriented_f32) =
        develop_tile_oriented_f32(raw, model, rect, quality, decoded_wb_anchor, 1.0)?;
    // Parallel (#1089 item 8), same rationale as the full-frame packs in
    // `render::scene_linear`: scalar software convert, order-preserving
    // indexed collect, bit-identical output.
    let fp16: Vec<u16> = stage("tile_pack_fp16", || {
        oriented_f32
            .par_iter()
            .map(|&v| f32_to_f16_bits(v))
            .collect()
    });
    Ok((w, h, fp16))
}

/// f32 (16 B/px) counterpart to
/// [`render_scene_linear_tile_from_raw_with_quality`]. The native-detail
/// tile-refinement path (Apple `NativeDetailRenderer`) uses this so its
/// working precision matches the whole-image scene-linear path's f32
/// (`ImageEditPipeline`, #487) instead of the fp16 the tile path shipped
/// before — a precision-tier divergence that could bias shadows / band the
/// AgX shoulder specifically in the zoomed-in tile vs the full image (#1945).
pub fn render_scene_linear_tile_from_raw_with_quality_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    rect: TileRect,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<f32>)> {
    develop_tile_oriented_f32(raw, model, rect, quality, None, 1.0)
}

/// f32 (16 B/px) counterpart to
/// [`render_scene_linear_tile_from_raw_with_quality_and_wb_anchor`] — same
/// WB-anchor contract, f32 output. See
/// [`render_scene_linear_tile_from_raw_with_quality_f32`] for why the tile
/// refinement path uses f32 (#1945).
pub fn render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    rect: TileRect,
    quality: RenderQuality,
    decoded_wb_anchor: Option<(f32, f32)>,
) -> Result<(u32, u32, Vec<f32>)> {
    develop_tile_oriented_f32(raw, model, rect, quality, decoded_wb_anchor, 1.0)
}

/// f32 (16 B/px) counterpart to
/// [`render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_f32`],
/// additionally accepting the auto-exposure anchor gain (#1167) a full-image
/// (or sized) develop of the same model already measured — see
/// `pipeline::develop::develop_scene_linear_from_raw_with_quality_with_gain`
/// (or the sized sibling) for how to obtain it. `ae_gain = 1.0` is a
/// bit-identical no-op, so this entry is a strict superset of
/// [`render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_f32`], kept
/// as a separate function (rather than widening that one's arity) so
/// existing callers — including the Apple FFI entry point that predates this
/// ticket — are untouched.
pub fn render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_and_ae_gain_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    rect: TileRect,
    quality: RenderQuality,
    decoded_wb_anchor: Option<(f32, f32)>,
    ae_gain: f32,
) -> Result<(u32, u32, Vec<f32>)> {
    develop_tile_oriented_f32(raw, model, rect, quality, decoded_wb_anchor, ae_gain)
}
