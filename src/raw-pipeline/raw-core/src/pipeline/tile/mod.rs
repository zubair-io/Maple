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
//! radius 40 (3-pass box = exactly 39 px effective tail) is the binding
//! stage. Dehaze (radius 67 px) doesn't fit and is errored at the entry.
//! See [`TILE_OVERLAP_PX`] and [`render_scene_linear_tile_from_raw_with_quality`].
//!
//! Submodules (split for the file-size budget, #114):
//! * [`region`]  — pad/clamp/crop/trim geometry helpers.
//! * [`develop`] — the stripped-down develop chain run on the padded crop.

mod develop;
mod region;

use crate::{error::Result, image::RawImage, linearize, xmp::AdjustmentModel};

use super::{
    downsample::downsample_image_area, fp16::f32_to_f16_bits, orient::apply_orientation_f32_rgba,
    stage, RenderQuality,
};

use develop::develop_scene_linear_from_padded_mosaic;
use region::{pad_and_clamp_mosaic_rect, trim_image_to_inner};

/// Tile-overlap pad in source pixels per edge. Picked to satisfy
/// clarity at radius 40 (3-pass box reach is exactly
/// `3 * (40 / 3) = 39 px` per axis) — the binding stencil among the
/// tile-safe stages. Other stages (demosaic 2 px, sharpen ≤ 9 px,
/// nr_color ≤ 4 px, texture 3 px) sit comfortably inside this pad.
/// Dehaze (radius 67) is NOT tile-safe — `render_scene_linear_tile_from_raw_with_quality`
/// errors when `model.dehaze != 0`.
///
/// 48 = 39 (clarity reach) rounded up with headroom. The const assertion
/// below ties this value to `clarity::CLARITY_RADIUS` — if the clarity
/// radius is ever bumped, the build will refuse until this constant
/// follows.
pub const TILE_OVERLAP_PX: u32 = 48;

// Build-time guard: TILE_OVERLAP_PX must cover the 3-pass clarity box
// reach. The 3-pass cascaded box blur with per-pass radius
// `(CLARITY_RADIUS / 3).max(1)` reaches `3 * r_box` pixels per side
// (every pass shifts the support by `r_box`). If `CLARITY_RADIUS` is
// raised in the future, this assertion fails until `TILE_OVERLAP_PX` is
// raised to match.
const CLARITY_BOX_R: usize = {
    let r = crate::stages::clarity::CLARITY_RADIUS / 3;
    if r < 1 { 1 } else { r }
};
const CLARITY_TAIL_PX: usize = 3 * CLARITY_BOX_R;
const _: () = assert!(
    (TILE_OVERLAP_PX as usize) >= CLARITY_TAIL_PX,
    "TILE_OVERLAP_PX must cover the 3-pass clarity box reach; bump it when CLARITY_RADIUS grows.",
);

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
///   are not safe with dehaze active (radius 67 px > overlap pad).
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
            "tile path is not supported when dehaze != 0 (radius 67 px > overlap pad)"
                .into()
        ));
    }
    if out_w > src_w || out_h > src_h {
        return Err(crate::error::Error::Pipeline(
            format!("tile path is downscale-only (no upscale): out {}×{} > src {}×{}",
                out_w, out_h, src_w, src_h)
        ));
    }
    // Aspect-mismatch guard: the trim → downsample path drives a single
    // long-edge scale (see `target_long_edge` below), so a request whose
    // aspect differs from the source's aspect would be silently fitted
    // to a square. Reject mismatched aspect with a clear error; callers
    // wanting a non-matching aspect should recrop the source rect to
    // match. Cross-product comparison avoids fp; tolerance is one row /
    // column of integer rounding (`max(src_w, src_h)`).
    let cross = (out_w as u64 * src_h as u64)
        .abs_diff(out_h as u64 * src_w as u64);
    let tol = src_w.max(src_h) as u64;
    if cross > tol {
        return Err(crate::error::Error::Pipeline(
            format!("tile path requires matching aspect: src {}×{}, out {}×{}",
                src_w, src_h, out_w, out_h)
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

    /// Tile entry rejects mismatched-aspect requests. The trim →
    /// downsample chain drives a single long-edge scale, so honouring
    /// `(out_w, out_h)` with a non-matching aspect would silently
    /// produce a fit-within square instead of the requested rect. We
    /// reject loudly with a "matching aspect" message; the FFI surface
    /// maps that to rc=12. Same fake-RawImage rationale as the dehaze
    /// test (rejection fires before any decode work).
    #[test]
    fn render_scene_linear_tile_rejects_mismatched_aspect() {
        let raw = fake_raw(2048, 2048);
        let model = AdjustmentModel::default();
        // src 512×512 (1:1), out 512×256 (2:1) — strict mismatch.
        let r = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 0, 0, 512, 512, 512, 256,
            RenderQuality::Full,
        );
        assert!(r.is_err(), "tile path must error on mismatched aspect");
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("matching aspect"),
            "error must mention matching aspect, got: {}", msg);

        // src 1024×512 (2:1), out 256×128 (2:1) — matches; should NOT
        // error on the aspect check. (May still error elsewhere because
        // `fake_raw` has no DCP profile, so just confirm the message is
        // not the aspect one.)
        let r_ok_aspect = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 0, 0, 1024, 512, 256, 128,
            RenderQuality::Full,
        );
        if let Err(e) = r_ok_aspect {
            let msg = format!("{}", e);
            assert!(!msg.contains("matching aspect"),
                "matching-aspect request must not trip the aspect guard: {}", msg);
        }

        // Equal cross-product within the integer-rounding tolerance
        // (one row/column of `src_w.max(src_h)`) — should pass.
        // src 513×512, out 257×256: cross diff = |513*256 - 512*257| = 256 <= 513.
        let r_tol = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 0, 0, 513, 512, 257, 256,
            RenderQuality::Full,
        );
        if let Err(e) = r_tol {
            let msg = format!("{}", e);
            assert!(!msg.contains("matching aspect"),
                "near-aspect within tolerance must not trip guard: {}", msg);
        }
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
