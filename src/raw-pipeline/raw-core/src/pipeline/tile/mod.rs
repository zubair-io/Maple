//! Tile-rendering entry used by the deep-zoom viewer.
//!
//! The tile path runs `linearize` ONLY on a padded crop region (rather
//! than the whole sensor), then runs a stripped-down develop chain
//! against it (no auto-exposure — #1167; dehaze / vignette / deep
//! denoise / local adjustments / capture sharpening are rejected loudly
//! at the entry — see the per-function notes), then trims the overlap,
//! downsamples to the requested output size, and packs the result as
//! oriented fp16 RGBA.
//! This makes a 23-tile view of a 100 MP RAW land in ~10 s rather than
//! ~10 minutes.
//!
//! Stencil-sensitive stages constrain the overlap pad: clarity at
//! radius 40 (3-pass box = exactly 39 px effective tail) is the binding
//! stage. Dehaze (radius 67 px) doesn't fit and is errored at the entry.
//! See [`TILE_OVERLAP_PX`] and [`render_scene_linear_tile_from_raw_with_quality`].
//!
//! Submodules (split for the file-size budget, #114):
//! * [`region`]  — pad/clamp/crop/trim geometry helpers.
//! * [`develop`] — the stripped-down develop chain run on the padded crop.

mod develop;
mod region;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_render;

use crate::{error::Result, image::RawImage, linearize, xmp::AdjustmentModel};

use super::{
    downsample::downsample_image_area, finite_or_zero, fp16::f32_to_f16_bits,
    orient::apply_orientation_f32_rgba, stage, RenderQuality,
};

use develop::develop_scene_linear_from_padded_mosaic;
use region::{pad_and_clamp_mosaic_rect, trim_image_to_inner};

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
/// Errors:
/// - `model.dehaze != 0` → returns `Err` with a "dehaze" message; tiles
///   are not safe with dehaze active (radius 67 px > overlap pad).
/// - `model.vignette_amount != 0` → returns `Err` ("vignette"); the
///   stage is full-frame-anchored and this entry does not thread the
///   tile window yet (#11). Same fallback contract as dehaze.
/// - `model.deep_denoise != 0` → returns `Err` ("deep denoise"); the
///   BM3D reference-patch grid is frame-anchored, so per-tile grids
///   would seam (#1105). Same fallback contract as dehaze.
/// - a non-identity local adjustment → returns `Err` ("local
///   adjustments"); mask weights evaluate in full-image-normalized
///   coordinates, which a padded crop cannot reproduce without offset
///   plumbing (#1084). Same fallback contract as dehaze.
/// - an active capture-sharpening amount → returns `Err` ("capture
///   sharpening"); the iterated Richardson–Lucy stencil reaches past the
///   overlap pad at the σ = 8 helper clamp (#1084). Same fallback
///   contract as dehaze.
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
pub fn render_scene_linear_tile_from_raw_with_quality_and_wb_anchor(
    raw: &RawImage,
    model: &AdjustmentModel,
    rect: TileRect,
    quality: RenderQuality,
    decoded_wb_anchor: Option<(f32, f32)>,
) -> Result<(u32, u32, Vec<u16>)> {
    let TileRect {
        src_x,
        src_y,
        src_w,
        src_h,
        out_w,
        out_h,
    } = rect;
    if raw.cfa == crate::image::CfaPattern::LinearRgb {
        return Err(crate::error::Error::Pipeline(
            "tile path does not support LinearRaw DNGs; use the full-image render entry instead. See ticket #07."
                .into()
        ));
    }
    if matches!(raw.cfa, crate::image::CfaPattern::XTrans(_)) {
        return Err(crate::error::Error::Pipeline(
            "tile path does not support Fuji X-Trans RAFs; use the \
             full-image render entry instead (#420)."
                .into(),
        ));
    }
    if model.dehaze.abs() > 1e-3 {
        return Err(crate::error::Error::Pipeline(
            "tile path is not supported when dehaze != 0 (radius 67 px > overlap pad)".into(),
        ));
    }
    if model.vignette_amount.abs() > 1e-3 {
        // Vignette (#1109) is a pure point op GIVEN the full-frame window
        // (`stages::vignette::apply_windowed`), but this entry does not
        // thread the tile's origin / full dims through its develop chain
        // yet — wiring that belongs to the stage-class overlap work that
        // un-gates deep zoom (#11, tone/zoom design § 5.3, crop dep #1113).
        // Refuse loudly rather than render a wrong (tile-local) ellipse.
        return Err(crate::error::Error::Pipeline(
            "tile path is not supported when vignette != 0 (full-frame anchor not threaded; #11)"
                .into(),
        ));
    }
    // Active BM3D deep denoise → reject loudly, same contract as dehaze
    // (#1105). The reference-patch grid is anchored at the buffer origin,
    // so a tile-relative grid would aggregate different groups than the
    // full-frame render and seam at tile borders. The FFI file/bytes tile
    // entries pre-check this themselves; gating here as well covers every
    // core caller (the handle-based FFI entry, maple-cli `tile`). The
    // threshold matches `bm3d::apply`'s own early-exit (1e-3).
    if model.deep_denoise.abs() > 1e-3 {
        return Err(crate::error::Error::Pipeline(
            "tile path is not supported when deep denoise != 0 \
             (the BM3D reference-patch grid is frame-anchored; use the \
             full-image render entry instead). See #1105."
                .into(),
        ));
    }
    // Non-identity local adjustment → reject loudly, same contract as
    // dehaze (#1084). Mask weights evaluate in coordinates normalized to
    // the FULL image; a padded crop would place every mask tile-relative.
    // The predicate mirrors the stage's own work-skip logic
    // (`local_adjustments::apply` ignores layers whose `adjustments` carry
    // no `Some` field), so a model the full chain would no-op on stays
    // tile-renderable.
    if model
        .local_adjustments
        .iter()
        .any(|layer| !layer.adjustments.is_empty())
    {
        return Err(crate::error::Error::Pipeline(
            "tile path is not supported when local adjustments are active \
             (mask coordinates are normalized to the full image; use the \
             full-image render entry instead). See #1084."
                .into(),
        ));
    }
    // Active capture sharpening → reject loudly, same contract as dehaze
    // (#1084). The iterated Richardson–Lucy stencil reaches up to
    // ~2·iterations·3σ ≈ 96 px at the σ = 8 helper clamp — past
    // TILE_OVERLAP_PX (48). The predicate reuses the full chain's own
    // engage condition (`capture_sharpening_params_from_model`), so a
    // model the full chain would skip the stage for stays tile-renderable.
    if super::capture_sharpening_helper::capture_sharpening_params_from_model(model).is_some() {
        return Err(crate::error::Error::Pipeline(
            "tile path is not supported when capture sharpening is active \
             (Richardson–Lucy stencil exceeds the overlap pad; use the \
             full-image render entry instead). See #1084."
                .into(),
        ));
    }
    if out_w > src_w || out_h > src_h {
        return Err(crate::error::Error::Pipeline(format!(
            "tile path is downscale-only (no upscale): out {}×{} > src {}×{}",
            out_w, out_h, src_w, src_h
        )));
    }
    // Aspect-mismatch guard: the trim → downsample path drives a single
    // long-edge scale (see `target_long_edge` below), so a request whose
    // aspect differs from the source's aspect would be silently fitted
    // to a square. Reject mismatched aspect with a clear error; callers
    // wanting a non-matching aspect should recrop the source rect to
    // match. Cross-product comparison avoids fp; tolerance is one row /
    // column of integer rounding (`max(src_w, src_h)`).
    let cross = (out_w as u64 * src_h as u64).abs_diff(out_h as u64 * src_w as u64);
    let tol = src_w.max(src_h) as u64;
    if cross > tol {
        return Err(crate::error::Error::Pipeline(format!(
            "tile path requires matching aspect: src {}×{}, out {}×{}",
            src_w, src_h, out_w, out_h
        )));
    }
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
    let (rect, (left_pad, top_pad)) =
        pad_and_clamp_mosaic_rect(s_x, s_y, s_w, s_h, TILE_OVERLAP_PX, raw.width, raw.height);
    // Linearize ONLY the padded crop region — not the full sensor.
    // For a 100 MP RAW (~12288×8192) the per-tile cost was ~480 ms;
    // a 512+overlap region is ~582×582 px, ~10 ms. ~50× speedup with
    // 23 visible tiles → ~10 s total. Bayer phase is preserved because
    // `pad_and_clamp_mosaic_rect` aligns start corners to even.
    let (rx, ry, rw, rh) = rect;
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
    let scene =
        develop_scene_linear_from_padded_mosaic(&mosaic, raw, model, quality, decoded_wb_anchor)?;

    // Trim the overlap, leaving the inner s_w × s_h block in SENSOR coords
    // (rotation applied below). For half-res Preview the trim coords
    // halve too — the cropped mosaic was half-resed by `demosaic::half_res`,
    // so the inner region is at `(left_pad / 2, top_pad / 2)` with size
    // `(s_w / 2, s_h / 2)`. For `Full` quality the chain preserves
    // dimensions, so it's `(left_pad, top_pad)` with `(s_w, s_h)`.
    let (inner_lp, inner_tp, inner_w, inner_h) = match quality {
        RenderQuality::Preview => (left_pad / 2, top_pad / 2, s_w / 2, s_h / 2),
        // `Amaze` preserves dimensions like `Full` — same trim coords.
        RenderQuality::Full | RenderQuality::Amaze => (left_pad, top_pad, s_w, s_h),
    };
    let mut sized = stage("tile_trim_inner", || {
        trim_image_to_inner(&scene, inner_lp, inner_tp, inner_w, inner_h)
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
    let fp16: Vec<u16> = stage("tile_pack_fp16", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
}
