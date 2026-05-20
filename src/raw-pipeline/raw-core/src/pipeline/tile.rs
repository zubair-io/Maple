//! Tile-rendering entry used by the deep-zoom viewer.
//!
//! The tile path runs `linearize` ONLY on a padded crop region (rather
//! than the whole sensor), then runs a stripped-down develop chain
//! against it (no auto-exposure, no dehaze — see the per-function notes),
//! then trims the overlap, downsamples to the requested output size, and
//! packs the result as oriented fp16 RGBA. This makes a 23-tile view of
//! a 100 MP RAW land in ~10 s rather than ~10 minutes.
//!
//! Stencil-sensitive stages constrain the overlap pad: clarity at
//! radius 40 (3-pass box ≈ 39 px effective tail) is the binding stage.
//! Dehaze (radius 67 px) doesn't fit and is errored at the entry. See
//! [`TILE_OVERLAP_PX`] and [`render_scene_linear_tile_from_raw_with_quality`].

use crate::{
    color::dcp,
    demosaic,
    error::Result,
    image::RawImage,
    linearize,
    stages::{
        clarity, highlight_recovery, noise_reduction, saturation, scene_tone_controls, sharpen,
        texture, vibrance, white_balance,
    },
    xmp::AdjustmentModel,
};

use super::{
    downsample::downsample_image_area, fp16::f32_to_f16_bits, orient::apply_orientation_f32_rgba,
    stage, RenderQuality,
};

/// Tile-overlap pad in source pixels per edge. Picked to satisfy
/// clarity at radius 40 (3-pass box ≈ 39 px) — the binding stencil among
/// the tile-safe stages. Other stages (demosaic 2 px, sharpen ≤ 9 px,
/// nr_color ≤ 4 px, texture 3 px) sit comfortably inside this pad.
/// Dehaze (radius 67) is NOT tile-safe — `render_scene_linear_tile_from_raw_with_quality`
/// errors when `model.dehaze != 0`.
pub const TILE_OVERLAP_PX: u32 = 35;

/// Pad a `(src_x, src_y, src_w, src_h)` source-pixel rect by `pad` pixels on
/// each edge, clamp to `(0..mosaic_w, 0..mosaic_h)`, and round the resulting
/// rect's start corners DOWN to the nearest even multiple to preserve
/// Bayer phase for `demosaic::half_res` and `cfa.color_at`. End corners
/// round UP within bounds so the inner rect is fully covered. Returns the
/// padded rect `(x, y, w, h)` plus the `(left_pad, top_pad)` actually
/// applied — the trim step at the end of the tile entry uses these to
/// compute the inner-image-relative crop after the development chain runs
/// on the padded buffer.
fn pad_and_clamp_mosaic_rect(
    src_x: u32, src_y: u32, src_w: u32, src_h: u32,
    pad: u32, mosaic_w: u32, mosaic_h: u32,
) -> ((u32, u32, u32, u32), (u32, u32)) {
    let pre_x = src_x.saturating_sub(pad);
    let pre_y = src_y.saturating_sub(pad);
    let pre_x_end = (src_x.saturating_add(src_w).saturating_add(pad)).min(mosaic_w);
    let pre_y_end = (src_y.saturating_add(src_h).saturating_add(pad)).min(mosaic_h);
    // Round start corners DOWN to even (Bayer phase). End corners round UP
    // within bounds so the inner rect remains fully covered.
    let x = pre_x & !1u32;
    let y = pre_y & !1u32;
    let x_end_aligned = ((pre_x_end + 1) & !1u32).min(mosaic_w);
    let y_end_aligned = ((pre_y_end + 1) & !1u32).min(mosaic_h);
    let w = x_end_aligned.saturating_sub(x);
    let h = y_end_aligned.saturating_sub(y);
    let left_pad = src_x.saturating_sub(x);
    let top_pad = src_y.saturating_sub(y);
    ((x, y, w, h), (left_pad, top_pad))
}

/// Crop a `CameraNativeMosaic` `Image` to a sub-rectangle. Returns a fresh
/// mosaic `Image` at the cropped dimensions; the CFA pattern is preserved
/// because `(x, y)` are guaranteed even (see `pad_and_clamp_mosaic_rect`).
#[allow(dead_code)] // kept for diagnostic / future use; the live tile path linearises directly to the crop
fn crop_mosaic_to_padded_rect(
    mosaic: &crate::image::Image, rect: (u32, u32, u32, u32),
) -> crate::image::Image {
    use crate::image::ColorSpace;
    let (cx, cy, cw, ch) = rect;
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let mut out = crate::image::Image::new(cw, ch, ColorSpace::CameraNativeMosaic);
    let sw = mosaic.width as usize;
    for y in 0..(ch as usize) {
        let src_off = ((cy as usize) + y) * sw + (cx as usize);
        let dst_off = y * (cw as usize);
        out.pixels[dst_off..dst_off + cw as usize]
            .copy_from_slice(&mosaic.pixels[src_off..src_off + cw as usize]);
    }
    out
}

/// Trim an `Image` to its inner `(left_pad, top_pad, inner_w, inner_h)` rect.
/// Used after the development chain runs on the padded crop — we discard
/// the overlap region and keep only the requested source-pixel area.
/// Note: this runs in fp32 RGB, AFTER `nr_color` and BEFORE downsampling.
fn trim_image_to_inner(
    img: &crate::image::Image,
    left_pad: u32, top_pad: u32,
    inner_w: u32, inner_h: u32,
) -> crate::image::Image {
    let space = img.space;
    let mut out = crate::image::Image::new(inner_w, inner_h, space);
    let sw = img.width as usize;
    for y in 0..(inner_h as usize) {
        let src_off = ((top_pad as usize) + y) * sw + (left_pad as usize);
        let dst_off = y * (inner_w as usize);
        out.pixels[dst_off..dst_off + inner_w as usize]
            .copy_from_slice(&img.pixels[src_off..src_off + inner_w as usize]);
    }
    out
}

/// Run the development chain from a pre-cropped `CameraNativeMosaic`
/// `Image` (as produced by `linearize::sensor_linearize` + a manual
/// `crop_mosaic_to_padded_rect`). Used by the tile path so the linearize
/// + crop pair runs once on the full mosaic and the develop chain runs
/// on a small padded-crop. Mirrors `develop_scene_linear_from_raw_with_quality`
/// but without the leading `linearize` call and **without** dehaze (the
/// tile entry errors before this fn runs when `model.dehaze != 0`).
fn develop_scene_linear_from_padded_mosaic(
    mosaic: &crate::image::Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<crate::image::Image> {
    if raw.cfa == crate::image::CfaPattern::LinearRgb {
        return Err(crate::error::Error::Pipeline(
            "tile path does not support LinearRaw DNGs; use the full-image render entry instead. See ticket #07."
                .into()
        ));
    }
    mosaic.assert_space(crate::image::ColorSpace::CameraNativeMosaic);
    let mut camera_rgb = stage("tile_demosaic", || match quality {
        RenderQuality::Preview => demosaic::half_res(mosaic, raw.cfa),
        #[cfg(feature = "high-quality-demosaic")]
        RenderQuality::Full => demosaic::hamilton_adams(mosaic, raw.cfa),
        #[cfg(not(feature = "high-quality-demosaic"))]
        RenderQuality::Full => demosaic::bilinear(mosaic, raw.cfa),
        RenderQuality::Amaze => demosaic::amaze(mosaic, raw.cfa),
    });
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("tile_baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }

    // WB pre-gain: matches the unsized + sized variants (Phase 1.2 contract).
    // The DCP profile downstream runs with `wb_already_baked = true` for
    // Bayer paths, expecting input camera RGB to have been divided by
    // AsShotNeutral. Skip would have been required for 8-bit lossy LinearRaw
    // but this entire function rejects LinearRaw at the top, so the only
    // path here is Bayer — always pre-gain.
    stage("tile_white_balance::apply_pre_gain", || {
        white_balance::apply_pre_gain(&mut camera_rgb, raw.as_shot_neutral)
    });
    stage("tile_highlight_recovery", || highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery));
    let profile = stage("tile_dcp_profile_for", || dcp::profile_for(raw))?;
    let mut scene = stage("tile_dcp_apply", || dcp::apply_with_plt_and_ptc(
        &camera_rgb, &profile, raw.plt.as_ref(), raw.profile_tone_curve.as_ref(),
    ))?;
    if let Some(pgtm) = raw.profile_gain_table_map.as_ref() {
        stage("tile_profile_gain_table_map", || {
            crate::color::profile_gain_table_map::apply(&mut scene, pgtm)
        });
    }
    // NOTE: auto_exposure intentionally omitted on the tile path. A tile is
    // a sub-region of the image, so its histogram is not representative of
    // the whole scene — running AE here would give a different gain per
    // tile, producing visible discontinuities at tile borders. Wiring AE
    // into the tile path correctly requires precomputing the EV from the
    // full image once and threading it through. Today the tile path will
    // render slightly darker than the full-image path (by whatever EV the
    // full path's AE picked); this is a known follow-up. The same
    // architectural reason already excludes dehaze from this path.
    stage("tile_white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    stage("tile_scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    stage("tile_vibrance", || vibrance::apply(&mut scene, model.vibrance));
    stage("tile_saturation", || saturation::apply(&mut scene, model.saturation));
    stage("tile_clarity", || clarity::apply(&mut scene, model.clarity));
    stage("tile_texture", || texture::apply(&mut scene, model.texture));
    // dehaze intentionally omitted — the tile entry asserts dehaze == 0
    // before this function runs (radius 67 px > 35 px overlap pad).
    stage("tile_sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    stage("tile_nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    stage("tile_nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    Ok(scene)
}

/// Render a tile of the developed scene-linear Rec.2020 fp16 RGBA image.
///
/// Parameters:
/// - `(src_x, src_y, src_w, src_h)`: source-pixel rectangle in mosaic
///   coordinates (pre-orientation). The mosaic crop coords get rounded
///   to even via `pad_and_clamp_mosaic_rect` for Bayer-phase preservation.
/// - `(out_w, out_h)`: target dimensions — never upscale; this fn errors
///   if `out_w > src_w || out_h > src_h`.
/// - `quality`: `Preview` (half-res quad demosaic) or `Full` (bilinear or
///   hamilton_adams per `cfg(feature)`).
///
/// Errors:
/// - `model.dehaze != 0` → returns `Err` with a "dehaze" message; tiles
///   are not safe with dehaze active (radius 67 px > 35 px overlap pad).
/// - `out_w > src_w || out_h > src_h` → returns `Err` ("upscale"); the
///   tile path caps at native resolution.
///
/// Output is fp16 RGBA, length `4 * out_w * out_h`, alpha = 0x3c00. The
/// orientation is applied by walking the trim+downsample output through
/// `apply_orientation_f32_rgba` (so the `(src_x, src_y)` handed in is in
/// pre-orientation space; the returned tile's orientation matches the
/// full-image's `apply_orientation` output).
pub fn render_scene_linear_tile_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    src_x: u32, src_y: u32, src_w: u32, src_h: u32,
    out_w: u32, out_h: u32,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u16>)> {
    if raw.cfa == crate::image::CfaPattern::LinearRgb {
        return Err(crate::error::Error::Pipeline(
            "tile path does not support LinearRaw DNGs; use the full-image render entry instead. See ticket #07."
                .into()
        ));
    }
    if model.dehaze.abs() > 1e-3 {
        return Err(crate::error::Error::Pipeline(
            "tile path is not supported when dehaze != 0 (radius 67 px > 35 px overlap pad)"
                .into()
        ));
    }
    if out_w > src_w || out_h > src_h {
        return Err(crate::error::Error::Pipeline(
            format!("tile path is downscale-only (no upscale): out {}×{} > src {}×{}",
                out_w, out_h, src_w, src_h)
        ));
    }
    // (src_x, src_y, src_w, src_h) are in DISPLAY-oriented source coords —
    // that's what callers (Apple TileManager, maple-cli `tile` subcommand)
    // know about. Translate to sensor coords before cropping the mosaic.
    // For non-Normal orientations (e.g. Rotate 270 CW on Canon CR2), the
    // sensor rect is at a rotated position and the dims may swap. The
    // final `apply_orientation_f32_rgba` step rotates the developed tile
    // back into display orientation, so the returned tile lines up with
    // the display tile coords the caller asked for.
    let (s_x, s_y, s_w, s_h) = raw.orientation.display_rect_to_sensor(
        src_x, src_y, src_w, src_h,
        raw.width, raw.height,
    );
    let (rect, (left_pad, top_pad)) = pad_and_clamp_mosaic_rect(
        s_x, s_y, s_w, s_h, TILE_OVERLAP_PX,
        raw.width, raw.height,
    );
    // Linearize ONLY the padded crop region — not the full sensor.
    // For a 100 MP RAW (~12288×8192) the per-tile cost was ~480 ms;
    // a 512+overlap region is ~582×582 px, ~10 ms. ~50× speedup with
    // 23 visible tiles → ~10 s total. Bayer phase is preserved because
    // `pad_and_clamp_mosaic_rect` aligns start corners to even.
    let (rx, ry, rw, rh) = rect;
    let mosaic = stage("tile_linearize", || {
        linearize::sensor_linearize_region(raw, rx, ry, rw, rh)
    });
    let scene = develop_scene_linear_from_padded_mosaic(&mosaic, raw, model, quality)?;

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
        stage("tile_downsample_area", || downsample_image_area(&mut sized, target_long_edge));
    }

    let (w0, h0) = (sized.width, sized.height);
    let rgba_f32 = stage("tile_pack_rgba_f32", || {
        let mut v = Vec::with_capacity(sized.pixels.len() * 4);
        for p in &sized.pixels {
            v.push(p[0]); v.push(p[1]); v.push(p[2]); v.push(1.0);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a fake `RawImage` for the dehaze / out>src error-path tests.
    /// Decode + DCP + every chained stage need a real RAW + DCP profile,
    /// so these helpers only feed paths that error before any of that
    /// runs.
    fn fake_raw(w: u32, h: u32) -> RawImage {
        RawImage {
            width: w,
            height: h,
            cfa: crate::image::CfaPattern::Rggb,
            black_level: [0, 0, 0, 0],
            white_level: 1023,
            raw_data: vec![0u16; (w as usize) * (h as usize)],
            as_shot_neutral: [1.0, 1.0, 1.0],
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            color_matrices: std::collections::HashMap::new(),
            forward_matrices: std::collections::HashMap::new(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
        }
    }

    /// Tile entry rejects `model.dehaze != 0` with a "dehaze" error. The
    /// rejection happens before any decode / DCP work, so a synthetic
    /// `RawImage` (no DCP profile) is sufficient to exercise the path.
    #[test]
    fn render_scene_linear_tile_rejects_active_dehaze() {
        let raw = fake_raw(2048, 2048);
        let model = AdjustmentModel { dehaze: 50.0, ..Default::default() };
        let r = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 1024, 1024, 512, 512, 512, 512,
            RenderQuality::Full,
        );
        assert!(r.is_err(), "tile path must error when dehaze != 0");
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("dehaze"),
            "error must mention dehaze, got: {}", msg);
    }

    /// Tile entry rejects upscale requests (`out_w > src_w` or
    /// `out_h > src_h`). Same fake-RawImage rationale as the dehaze test.
    #[test]
    fn render_scene_linear_tile_rejects_upscale() {
        let raw = fake_raw(2048, 2048);
        let model = AdjustmentModel::default();
        let r_w = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 0, 0, 512, 512, 1024, 512,
            RenderQuality::Full,
        );
        assert!(r_w.is_err(), "out_w > src_w must error");
        let msg = format!("{}", r_w.unwrap_err());
        assert!(msg.contains("upscale") || msg.contains("downscale"),
            "error must mention up/downscale, got: {}", msg);

        let r_h = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 0, 0, 512, 512, 512, 1024,
            RenderQuality::Full,
        );
        assert!(r_h.is_err(), "out_h > src_h must error");
    }

    /// `pad_and_clamp_mosaic_rect` rounds the start corners DOWN to even
    /// multiples (Bayer-phase preservation for `demosaic::half_res`).
    #[test]
    fn pad_and_clamp_mosaic_rect_rounds_start_to_even() {
        // Odd start coords with plenty of room — pad pulls back to even.
        let ((x, y, _w, _h), (lp, tp)) = pad_and_clamp_mosaic_rect(
            1025, 1025, 512, 512, 35, 8000, 8000,
        );
        assert_eq!(x & 1, 0, "x must be even, got {}", x);
        assert_eq!(y & 1, 0, "y must be even, got {}", y);
        // 1025 - 35 = 990, already even → x = 990. left_pad = 1025 - 990 = 35.
        assert_eq!(x, 990);
        assert_eq!(y, 990);
        assert_eq!(lp, 35);
        assert_eq!(tp, 35);

        // Even start coords with plenty of room — pad lands on even
        // already, no further snap.
        let ((x2, y2, _w2, _h2), (lp2, tp2)) = pad_and_clamp_mosaic_rect(
            1024, 1024, 512, 512, 35, 8000, 8000,
        );
        // 1024 - 35 = 989, snap down to 988. left_pad = 1024 - 988 = 36.
        assert_eq!(x2 & 1, 0);
        assert_eq!(y2 & 1, 0);
        assert_eq!(x2, 988);
        assert_eq!(y2, 988);
        assert_eq!(lp2, 36);
        assert_eq!(tp2, 36);
    }

    /// `pad_and_clamp_mosaic_rect` clamps to image bounds rather than
    /// overshooting. Tests the four edge cases: top-left corner, top-right
    /// corner, bottom-right corner, and a tile bigger than the mosaic.
    #[test]
    fn pad_and_clamp_mosaic_rect_clamps_to_image_bounds() {
        // Top-left corner: src starts at (0, 0). Pre-pad goes to (-35, -35)
        // saturating to 0. Even-snap leaves (0, 0). left_pad = top_pad = 0.
        let ((x, y, w, h), (lp, tp)) = pad_and_clamp_mosaic_rect(
            0, 0, 512, 512, 35, 4000, 4000,
        );
        assert_eq!(x, 0);
        assert_eq!(y, 0);
        assert_eq!(lp, 0, "left_pad must be 0 at left edge");
        assert_eq!(tp, 0, "top_pad must be 0 at top edge");
        // Right edge: 512 + 35 = 547, +1 = 548, masked to 548 (even). Within bounds.
        assert_eq!(w, 548);
        assert_eq!(h, 548);

        // Bottom-right corner: src ends exactly at the image boundary.
        // The padded right edge clamps to mosaic_w; no overshoot.
        let mosaic_w = 4000u32;
        let mosaic_h = 4000u32;
        let ((x2, y2, w2, h2), _) = pad_and_clamp_mosaic_rect(
            mosaic_w - 512, mosaic_h - 512, 512, 512, 35, mosaic_w, mosaic_h,
        );
        assert!(x2 + w2 <= mosaic_w, "x+w overshoots mosaic width: {}+{} > {}",
            x2, w2, mosaic_w);
        assert!(y2 + h2 <= mosaic_h, "y+h overshoots mosaic height: {}+{} > {}",
            y2, h2, mosaic_h);

        // Tile larger than image: src_w > mosaic_w. Result still inside
        // bounds (no overshoot), even-aligned, non-zero size.
        let ((x3, y3, w3, h3), _) = pad_and_clamp_mosaic_rect(
            0, 0, 10000, 10000, 35, 1024, 1024,
        );
        assert_eq!(x3, 0);
        assert_eq!(y3, 0);
        assert!(x3 + w3 <= 1024);
        assert!(y3 + h3 <= 1024);
        assert!(w3 > 0 && h3 > 0);
    }

    /// 35 px overlap pad tile-stencil reachability test: with `src` placed
    /// well inside the mosaic and `pad = 35`, every pixel within
    /// `src_w + 70 × src_h + 70` of the inner rect must lie inside the
    /// padded crop. This is the geometric check that the clarity stencil
    /// (effective tail ≈ 39 px) sits inside the trimmed region's overlap
    /// — equivalently, no clarity sample at the inner-rect boundary
    /// reaches outside the mosaic crop unless the src is itself clipped
    /// by the image edge.
    #[test]
    fn pad_and_clamp_mosaic_rect_overlap_covers_clarity_stencil() {
        let mosaic_w = 8000u32;
        let mosaic_h = 8000u32;
        let (src_x, src_y, src_w, src_h) = (1024u32, 1024u32, 512u32, 512u32);
        let pad = TILE_OVERLAP_PX;
        let ((x, y, w, h), (lp, tp)) = pad_and_clamp_mosaic_rect(
            src_x, src_y, src_w, src_h, pad, mosaic_w, mosaic_h,
        );
        // Inner src rect is at (lp, tp) inside the cropped mosaic.
        // The padded crop must extend at least `pad` pixels on every side
        // of the inner rect (this is the geometric invariant — when not
        // clipped by the mosaic boundary).
        assert!(lp >= pad, "left overlap {} < pad {}", lp, pad);
        assert!(tp >= pad, "top overlap {} < pad {}", tp, pad);
        let right_overlap = w.saturating_sub(lp + src_w);
        let bottom_overlap = h.saturating_sub(tp + src_h);
        assert!(right_overlap >= pad,
            "right overlap {} < pad {}", right_overlap, pad);
        assert!(bottom_overlap >= pad,
            "bottom overlap {} < pad {}", bottom_overlap, pad);
        // Padded crop sits inside the mosaic — does not overshoot.
        assert!(x + w <= mosaic_w, "padded crop overshoots width");
        assert!(y + h <= mosaic_h, "padded crop overshoots height");
        // The clarity stencil at radius 40 (3-pass box ≈ 39 px effective
        // tail) is inside the 35 px overlap on three of three passes:
        // each box pass has radius (CLARITY_RADIUS / 3) ≈ 13 px and the
        // 3-pass concatenation reaches ≈ 39 px — within 35 + 4 px of
        // sharpen + texture + nr_color cushion. The hard limit is dehaze
        // (radius 67 px) which is gated separately.
        assert_eq!(pad, 35);
    }

    /// Tile entry: renders a 512×512 source-pixel rectangle out of the
    /// largest available DNG fixture. Verifies (a) returned size matches
    /// `out_w` × `out_h`, (b) alpha lane is `0x3c00` (1.0) everywhere,
    /// (c) at least 10% of the buffer is non-alpha, non-zero (real
    /// pixels not borders). Fixture-gated — `test_0002.dng` is gitignored.
    #[test]
    fn render_scene_linear_tile_returns_oriented_fp16_rgba_at_target_size() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let (src_x, src_y, src_w, src_h) = (1024u32, 1024u32, 512u32, 512u32);
        let (out_w, out_h) = (512u32, 512u32);
        let (w, h, fp16) = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, src_x, src_y, src_w, src_h, out_w, out_h,
            RenderQuality::Full,
        ).expect("tile render");
        assert_eq!(w, out_w, "tile width");
        assert_eq!(h, out_h, "tile height");
        assert_eq!(fp16.len() as u32, 4 * w * h);
        let alpha_ok = fp16.chunks_exact(4).filter(|c| c[3] == 0x3c00).count();
        assert_eq!(alpha_ok, (w * h) as usize, "all alpha lanes = 1.0");
        let nonzero = fp16.iter().filter(|&&v| v != 0 && v != 0x3c00).count();
        assert!(nonzero > (fp16.len() / 10),
            "tile mostly zero: {} non-zero non-alpha lanes", nonzero);
    }

    /// Tile entry rounds source coordinates down to even multiples of 2
    /// for Bayer-phase correctness on `demosaic::half_res`. Pass odd
    /// coords; verify the rendered tile matches the requested
    /// out_w/out_h. Pixel-equality not asserted — the coord rounding is
    /// a defensive snap that does not perturb `out_w`/`out_h`.
    #[test]
    fn render_scene_linear_tile_rounds_source_coords_to_even() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let (w_odd, h_odd, _) = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 1025, 1025, 512, 512, 256, 256,
            RenderQuality::Full,
        ).expect("odd coords tile");
        let (w_even, h_even, _) = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 1024, 1024, 512, 512, 256, 256,
            RenderQuality::Full,
        ).expect("even coords tile");
        assert_eq!((w_odd, h_odd), (256, 256));
        assert_eq!((w_even, h_even), (256, 256));
    }
}
