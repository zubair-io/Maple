//! High-level render entry points.
//!
//! Each function here is a thin wrapper around
//! [`develop_scene_linear_from_raw_with_quality`] (or the sized variant)
//! that handles the post-develop packaging: AgX + sRGB encode + u8
//! quantise + EXIF orient for the legacy display-encoded path, or
//! fp16-RGBA packing + EXIF orient for the scene-linear FFI path that
//! hands the buffer off to a CoreImage / WebGL2 view transform.

use super::{
    develop::develop_scene_linear_from_raw_with_quality,
    develop_sized::develop_scene_linear_sized_from_raw_with_quality,
    dump_after,
    fp16::f32_to_f16_bits,
    orient::apply_orientation_f32_rgba,
    stage, RenderQuality,
};
use crate::{
    error::Result,
    image::{apply_orientation, ColorSpace, Image, RawImage},
    stages::{clarity, dehaze, noise_reduction, saturation, sharpen, texture, vibrance},
    view::{agx, encode, look},
    xmp::AdjustmentModel,
};

/// Per spec § 02 filter chain, slice-1 through slice-5 subset:
/// * Highlight reconstruction (§ 3.3a), SceneToneControls (§ 3.6 steps 1-5),
///   Vibrance + Saturation (§ 3.7, Oklab), Clarity + Texture (§ 3.8),
///   Dehaze (§ 3.9), Richardson-Lucy sharpen (§ 3.10, 3-iter, Gaussian PSF),
///   simplified NR (§ 3.11, L-blur + chroma-blur in Oklab).
/// * Crop (§ 3.12) skipped — no slice-5 fixture exercises it; lands with
///   canonical XMP in slice 7.
/// * Tone curves (§ 3.6 steps 6-7, § 3.6b DisplayReferredCurve) deferred to slice 7.
/// * AgX is the Sobotka power-curve approximation (slice-6 retightens).
pub fn render_from_raw(raw: &RawImage, model: &AdjustmentModel) -> Result<(u32, u32, Vec<u8>)> {
    render_from_raw_with_quality(raw, model, RenderQuality::Full)
}

pub fn render_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u8>)> {
    let mut scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
    stage("agx", || agx::apply(&mut scene, model.contrast));
    dump_after("16_agx", &scene);
    stage("rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    // Buffer is in display-linear sRGB primaries here. Gamma encoding
    // happens later in `quantize_u8`. Name reflects that — "srgb_linear",
    // not "post_srgb_encode" which would have implied a full sRGB encode
    // (per PR #281 review feedback).
    dump_after("17_srgb_linear", &scene);
    let mut bytes = stage("quantize_u8", || encode::quantize_u8(&mut scene));
    // DisplayLookCurve (#371) — empirical per-channel u8->u8 LUT that
    // closes ~65% of the bias-to-ACR gap. `Look::Neutral` short-circuits
    // and the buffer is bit-identical to the pre-#371 output.
    stage("look", || look::apply(&mut bytes, model.look));
    // Apply EXIF orientation last — rotating/flipping sRGB u8 is cheap and
    // keeps every upstream stage indifferent to sensor-vs-display framing.
    let (w, h, bytes) = stage("apply_orientation", || apply_orientation(&bytes, scene.width, scene.height, raw.orientation));
    // Both branches return the buffer at its actual rendered dimensions —
    // `Full` matches the sensor, `Preview` is half-res in both axes
    // (because of `demosaic::half_res`), and Apple/Web consumers handle
    // the resolution gap via their lazy display transform (CIImage scale
    // on Apple; texture upload on Web). Pixel-doubling here added ~300 MB
    // of FFI traffic and 4× the allocator pressure on a 100 MP RAW for no
    // extra information.
    Ok((w, h, bytes))
}

/// Scene-linear render entry. Runs the same development chain as
/// `render_from_raw_with_quality` (via the shared
/// `develop_scene_linear_from_raw_with_quality` helper — Step 2.4a)
/// but stops after `nr_color` and packs to fp16 RGBA without the view
/// transform tail. Output is packed Rec.2020 fp16 RGBA (8 bytes/pixel),
/// straight alpha = 1.0, row-major. Returned `Vec<u16>` is the fp16 bit
/// pattern; the FFI hands the underlying bytes to the caller via
/// `bytemuck::cast_slice`.
///
/// Plan 1 (FFI split) — the Apple side imports this buffer as a CIImage
/// tagged extendedLinearITUR_2020 and runs Lanczos prescale + AgX kernel
/// + sRGB encode in CoreImage. See
/// .archived-plans/plans/2026-04-24-ffi-split-plan-1.md.
pub fn render_scene_linear_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u16>)> {
    let scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
    // STOP: no agx::apply, no rec2020_to_srgb, no quantize_u8.
    // Pack [f32;3] + alpha=1.0 to packed [f32;4] RGBA, then orient, then
    // convert to fp16 lanes for the FFI handoff.
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("pack_fp16", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
}

/// f32 variant of [`render_scene_linear_from_raw_with_quality`].
///
/// Same develop chain and orientation handling, but returns the oriented
/// Rec.2020 RGBA buffer as packed `f32` lanes (16 bytes per pixel) instead
/// of fp16. This is the canonical end-to-end shape per #416 — fp16 is
/// kept as a parallel surface until every consumer has migrated.
///
/// `Vec<f32>` length is `4 * width * height`, row-major, straight alpha
/// = 1.0 in every alpha lane. See #482 for the FFI surface that exposes
/// this to the Web consumer (Apple still consumes the fp16 entries today;
/// follow-up ticket tracks the per-tick chain migration that blocks the
/// Apple swap).
pub fn render_scene_linear_from_raw_with_quality_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<f32>)> {
    let scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    Ok((w, h, oriented_f32))
}

/// Sized scene-linear render entry. Same shared development chain as
/// `render_scene_linear_from_raw_with_quality`, then downsample to fit
/// within `max_long_edge` (single scalar — see Plan 1 v2 Task 8 API
/// decision: long-edge simplifies WASM parity and aspect math is local
/// to the renderer; per ticket 06 § Open Questions). Never upscales.
///
/// Plan 1 v2 (FFI split + viewport-sized) — the Apple side imports this
/// buffer at the target dimensions and runs Lanczos prescale + AgX kernel
/// + sRGB encode in CoreImage.
pub fn render_scene_linear_sized_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<(u32, u32, Vec<u16>)> {
    // M3: develop with the early-downsample helper. The downsample
    // happens immediately after demosaic so post-demosaic stages run
    // on the viewport-sized buffer. The post-pipeline
    // `downsample_image_area` call this function used to make is now
    // inside the helper.
    let scene = develop_scene_linear_sized_from_raw_with_quality(
        raw, model, quality, max_long_edge,
    )?;
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32_sized", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba_sized", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("pack_fp16_sized", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
}

/// f32 variant of [`render_scene_linear_sized_from_raw_with_quality`].
///
/// Same `max_long_edge` cap, no-upscale guarantee, and oriented output.
/// Returns the oriented buffer as packed `f32` lanes. See the f32 variant
/// of the full-size entry for the rationale (#482).
pub fn render_scene_linear_sized_from_raw_with_quality_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<(u32, u32, Vec<f32>)> {
    let scene = develop_scene_linear_sized_from_raw_with_quality(
        raw, model, quality, max_long_edge,
    )?;
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32_sized", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba_sized", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    Ok((w, h, oriented_f32))
}

/// Synthetic-input render: takes an already-scene-linear `Image` (the kind
/// `synthetic_input::*` produces) and runs ONLY the view transform on it —
/// AgX + Rec.2020→sRGB + u8 quantize. The develop chain (linearize,
/// demosaic, DCP, scene-tone, …) is skipped because the input is already
/// in the working colorspace by construction.
///
/// `MAPLE_STAGE_DUMP` is honoured: stages 16 (`16_agx`) and 17
/// (`17_srgb_linear`) get written exactly like the RAW path, so the
/// detectors in `src/scripts/{banding,hue_stability,halo}_check.py` can
/// load and analyse them without caring whether the input was a real DNG
/// or a synthetic ramp.
///
/// Used by `maple-cli synthetic --kind {neutral-ramp,hue-patch,halo-disk}`.
pub fn render_from_scene_linear(
    image: Image,
    model: &AdjustmentModel,
) -> Result<(u32, u32, Vec<u8>)> {
    let mut scene = image;
    scene.assert_space(ColorSpace::SceneLinearRec2020);
    // Dump the pre-view-transform buffer too — gives the detectors a
    // way to see exactly what entered AgX. Numbered `00` so it sorts
    // before stages 16/17 in the dump dir.
    dump_after("00_synthetic_input", &scene);
    stage("synth_agx", || agx::apply(&mut scene, model.contrast));
    dump_after("16_agx", &scene);
    stage("synth_rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    dump_after("17_srgb_linear", &scene);
    let (w, h) = (scene.width, scene.height);
    let mut bytes = stage("synth_quantize_u8", || encode::quantize_u8(&mut scene));
    stage("synth_look", || look::apply(&mut bytes, model.look));
    Ok((w, h, bytes))
}

/// Synthetic-input render with the slider chain applied first. The detectors
/// that probe slider artefacts (halo overshoot from clarity / dehaze /
/// sharpen) need a path that runs those stages on a synthetic input. Mirrors
/// the scene-linear stages that `develop_scene_linear_from_raw_with_quality`
/// runs over real raws, but on a fresh `Image` rather than going through
/// decode / demosaic / DCP / auto-exposure.
///
/// White-balance and scene-tone-controls are skipped — the synthetic input
/// is generated directly in the Rec.2020 working space at a known
/// brightness, so running WB delta or tone-mapping over it would only
/// muddy the artefact under test. Vibrance and saturation are kept (they
/// scale around the achromatic axis, so they're no-ops on neutrals but DO
/// affect saturated primaries the way a real pixel would see). Stage
/// numbering matches the real RAW develop chain in `develop.rs`, with no
/// dumps for the skipped stages (so `05_auto_exposure` / `06_white_balance`
/// / `07_scene_tone_controls` are absent from this trace by design).
pub fn render_from_scene_linear_with_chain(
    image: Image,
    model: &AdjustmentModel,
) -> Result<(u32, u32, Vec<u8>)> {
    let mut scene = image;
    scene.assert_space(ColorSpace::SceneLinearRec2020);
    dump_after("00_synthetic_input", &scene);
    // White-balance + scene-tone-controls deliberately skipped — see
    // doc-comment. The detectors that consume this trace target slider
    // artefacts (clarity / dehaze / sharpen halos, NR banding); the WB
    // and tone-control stages are tested elsewhere on real RAWs.
    stage("synth_vibrance", || vibrance::apply(&mut scene, model.vibrance));
    dump_after("08_vibrance", &scene);
    stage("synth_saturation", || saturation::apply(&mut scene, model.saturation));
    dump_after("09_saturation", &scene);
    stage("synth_clarity", || clarity::apply(&mut scene, model.clarity));
    dump_after("10_clarity", &scene);
    stage("synth_texture", || texture::apply(&mut scene, model.texture));
    dump_after("11_texture", &scene);
    stage("synth_dehaze", || dehaze::apply(&mut scene, model.dehaze));
    dump_after("12_dehaze", &scene);
    stage("synth_sharpen", || {
        sharpen::apply(
            &mut scene,
            model.sharpen_amount,
            model.sharpen_radius,
            model.sharpen_detail,
            model.sharpen_masking,
        )
    });
    dump_after("13_sharpen", &scene);
    stage("synth_nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    dump_after("14_nr_luminance", &scene);
    stage("synth_nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    dump_after("15_nr_color", &scene);
    stage("synth_agx", || agx::apply(&mut scene, model.contrast));
    dump_after("16_agx", &scene);
    stage("synth_rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    dump_after("17_srgb_linear", &scene);
    let (w, h) = (scene.width, scene.height);
    let mut bytes = stage("synth_quantize_u8", || encode::quantize_u8(&mut scene));
    stage("synth_look", || look::apply(&mut bytes, model.look));
    Ok((w, h, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synthetic_input::{halo_disk, hue_patch, neutral_ramp, Primary};

    /// Shell helper for tests only — reads from disk then runs the pure
    /// pipeline. The core no longer exposes a path-based entrypoint.
    fn render_path(path: &std::path::Path, model: &AdjustmentModel) -> Result<(u32, u32, Vec<u8>)> {
        let bytes = std::fs::read(path).map_err(|e| crate::error::Error::Io {
            path: path.to_path_buf(), source: e,
        })?;
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw = crate::decode::decode_bytes(&bytes, ext)?;
        render_from_raw(&raw, model)
    }

    #[test]
    fn render_test_0002_baseline_produces_plausible_png_bytes() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let model = AdjustmentModel::default();
        let (w, h, bytes) = render_path(&path, &model).expect("render baseline");
        assert_eq!(bytes.len() as u32, w * h * 3);
        // Image is not all zeros and not all 255.
        let zero_ratio = bytes.iter().filter(|b| **b == 0).count() as f32 / bytes.len() as f32;
        let max_ratio  = bytes.iter().filter(|b| **b == 255).count() as f32 / bytes.len() as f32;
        assert!(zero_ratio < 0.5, "too many zeros ({:.1}%)", zero_ratio * 100.0);
        assert!(max_ratio < 0.5, "too many saturated pixels ({:.1}%)", max_ratio * 100.0);
        eprintln!("render: {}x{}, zero={:.1}%, max={:.1}%, mean={}",
            w, h, zero_ratio*100.0, max_ratio*100.0,
            bytes.iter().map(|&b| b as u64).sum::<u64>() / bytes.len() as u64);
    }

    /// Cross-format invariance for ProfileToneCurve on test_0013 (Apple
    /// iPhone 12 Pro DNG). Under ticket #425 (colorimetry-only DCP), the
    /// source DNG's PTC must be a no-op in the develop chain on EVERY
    /// `ProfileSource` — Bundled, EmbeddedDng, and Generic. Pre-#425
    /// the bundled path suppressed PTC and the non-bundled paths kept it,
    /// producing per-format inconsistency; that branch is gone.
    ///
    /// Verifies:
    /// 1. RawImage carries the parsed PTC (decode-side wiring; unchanged).
    /// 2. The pipeline renders cleanly with PTC present in the raw — no
    ///    panics, no NaN, plausible output statistics.
    /// 3. Render WITH PTC == Render WITHOUT PTC, byte-for-byte, regardless
    ///    of which profile source is in play. The PTC field is dead data
    ///    in the develop chain.
    #[test]
    fn render_test_0013_ptc_is_noop_under_colorimetry_only() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0013.DNG");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).unwrap();
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode iPhone");
        assert!(raw.profile_tone_curve.is_some(),
            "test_0013 must surface a ProfileToneCurve (decode-side wiring)");
        let model = AdjustmentModel::default();
        let (w, h, with_ptc) = render_from_raw(&raw, &model).expect("render with PTC");
        assert_eq!(with_ptc.len() as u32, w * h * 3);
        // Plausibility: not all zero, not all saturated.
        let zero_ratio = with_ptc.iter().filter(|b| **b == 0).count() as f32 / with_ptc.len() as f32;
        let sat_ratio = with_ptc.iter().filter(|b| **b == 255).count() as f32 / with_ptc.len() as f32;
        assert!(zero_ratio < 0.5, "render too dark: {:.1}% zeros", zero_ratio * 100.0);
        assert!(sat_ratio < 0.5, "render too bright: {:.1}% saturated", sat_ratio * 100.0);
        // Render WITHOUT PTC by stripping the field. Under #425 the two
        // renders must be bit-identical because the DCP path no longer
        // consumes `raw.profile_tone_curve` on any source.
        let mut raw_no_ptc = raw.clone();
        raw_no_ptc.profile_tone_curve = None;
        let (_, _, without_ptc) = render_from_raw(&raw_no_ptc, &model).unwrap();
        assert_eq!(with_ptc.len(), without_ptc.len());
        let diffs: usize = with_ptc.iter().zip(without_ptc.iter())
            .filter(|(a, b)| a != b).count();
        assert_eq!(diffs, 0,
            "under colorimetry-only DCP (#425), PTC must be suppressed on \
             every profile source — got {} differing bytes between \
             with-PTC and without-PTC renders",
            diffs);
    }

    #[test]
    fn render_test_0002_exposure_max_is_brighter_than_baseline() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let model_baseline = AdjustmentModel::default();
        let model_bright = AdjustmentModel { exposure: 4.0, ..Default::default() };
        let (_, _, baseline) = render_path(&path, &model_baseline).unwrap();
        let (_, _, bright) = render_path(&path, &model_bright).unwrap();
        let mean_baseline: u64 = baseline.iter().map(|&b| b as u64).sum::<u64>() / baseline.len() as u64;
        let mean_bright: u64 = bright.iter().map(|&b| b as u64).sum::<u64>() / bright.len() as u64;
        assert!(mean_bright > mean_baseline,
            "+4EV ({}) should exceed baseline ({})", mean_bright, mean_baseline);
    }

    /// New scene-linear FFI entry. Returns Rec.2020 fp16 RGBA, half-res for
    /// Preview, full for Full. Verify: the buffer is 8 bytes/pixel (4 ×
    /// fp16), alpha is 1.0 everywhere, and the buffer is non-zero.
    #[test]
    fn render_scene_linear_test_0002_preview_returns_rec2020_fp16_rgba() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let (w, h, fp16_rgba) = render_scene_linear_from_raw_with_quality(
            &raw, &model, RenderQuality::Preview
        ).expect("scene-linear preview render");
        // Each pixel = 4 channels × 2 bytes = 8 bytes; the Vec is u16 (fp16
        // bit pattern), so length = 4 × w × h.
        assert_eq!(fp16_rgba.len() as u32, 4 * w * h,
            "expected 4 × w × h fp16 lanes, got {} for {}×{}",
            fp16_rgba.len(), w, h);
        // Alpha (every 4th lane) must be the fp16 pattern of 1.0 (0x3c00).
        let mut alpha_ok = 0usize;
        for chunk in fp16_rgba.chunks_exact(4) {
            if chunk[3] == 0x3c00 { alpha_ok += 1; }
        }
        assert_eq!(alpha_ok, (w * h) as usize,
            "expected {} alpha=1.0 lanes, got {}", w * h, alpha_ok);
        // Buffer is not all zeros.
        let nonzero = fp16_rgba.iter().filter(|&&v| v != 0 && v != 0x3c00).count();
        assert!(nonzero > (fp16_rgba.len() / 10),
            "buffer mostly zero: {} non-zero/non-alpha lanes", nonzero);
    }

    /// Sized scene-linear FFI entry: caps the long edge at a viewport
    /// budget. Verify: the returned buffer's long edge equals the cap
    /// (or stays at the source dimension if the source is smaller — no
    /// upscale per ticket 06 § Product Requirements 1), and the alpha
    /// lane is 1.0 everywhere.
    /// f32 scene-linear entry (#482). Mirrors the fp16 test: 4×w×h lanes,
    /// alpha=1.0 everywhere, non-zero values present. The packed f32
    /// buffer is the precision-preserving alternative to the fp16 surface
    /// — fp16 loses ~3 bits of mantissa in highlights/shadows, which
    /// shows up as banding on smooth gradients.
    #[test]
    fn render_scene_linear_f32_test_0002_preview_returns_rec2020_f32_rgba() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let (w, h, f32_rgba) = render_scene_linear_from_raw_with_quality_f32(
            &raw, &model, RenderQuality::Preview
        ).expect("scene-linear f32 preview render");
        assert_eq!(f32_rgba.len() as u32, 4 * w * h,
            "expected 4 × w × h f32 lanes, got {} for {}×{}",
            f32_rgba.len(), w, h);
        // Alpha (every 4th lane) must be exactly 1.0.
        for chunk in f32_rgba.chunks_exact(4) {
            assert_eq!(chunk[3], 1.0_f32, "alpha != 1.0 in f32 buffer");
        }
        // Buffer is not all zeros.
        let nonzero = f32_rgba.chunks_exact(4)
            .filter(|c| c[0] != 0.0 || c[1] != 0.0 || c[2] != 0.0)
            .count();
        assert!(nonzero > (f32_rgba.len() / 40),
            "buffer mostly zero: {} non-zero RGB pixels", nonzero);
        // Every value is finite (no NaN / Inf leaked from the develop chain).
        assert!(f32_rgba.iter().all(|v| v.is_finite()),
            "non-finite values in f32 scene-linear buffer");
    }

    /// f32 sized variant: caps the long edge and produces packed f32
    /// alpha=1.0 lanes.
    #[test]
    fn render_scene_linear_sized_f32_test_0002_caps_long_edge_at_1500() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let max_long_edge: u32 = 1500;
        let (w, h, f32_rgba) = render_scene_linear_sized_from_raw_with_quality_f32(
            &raw, &model, RenderQuality::Preview, max_long_edge,
        ).expect("scene-linear sized f32 preview render");
        assert!(w.max(h) <= max_long_edge,
            "long edge exceeded cap: {}x{} > {}", w, h, max_long_edge);
        assert_eq!(f32_rgba.len() as u32, 4 * w * h);
        for chunk in f32_rgba.chunks_exact(4) {
            assert_eq!(chunk[3], 1.0_f32, "alpha != 1.0 in sized f32 buffer");
        }
    }

    #[test]
    fn render_scene_linear_sized_test_0002_caps_long_edge_at_1500() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let max_long_edge: u32 = 1500;
        let (w, h, fp16_rgba) = render_scene_linear_sized_from_raw_with_quality(
            &raw, &model, RenderQuality::Preview, max_long_edge,
        ).expect("scene-linear sized preview render");
        // Cap respected on the long edge.
        assert!(w.max(h) <= max_long_edge,
            "long edge exceeded cap: {}x{} > {}", w, h, max_long_edge);
        // Buffer length matches.
        assert_eq!(fp16_rgba.len() as u32, 4 * w * h);
        // Alpha = 1.0 everywhere.
        for chunk in fp16_rgba.chunks_exact(4) {
            assert_eq!(chunk[3], 0x3c00, "alpha != 1.0 in sized buffer");
        }
    }

    #[test]
    fn render_from_scene_linear_neutral_ramp_is_monotone() {
        let ramp = neutral_ramp(64, 4);
        // Force `Look::Neutral` here — this test validates a structural
        // pipeline invariant (achromatic input yields achromatic output,
        // monotone ramp stays monotone) and the empirical Look LUT has
        // intentionally different per-channel curves (R/G floor at ~7, B
        // floor at ~19), which makes neutral-axis preservation
        // colorimetric, not byte-exact. Pipeline aesthetics are tested
        // separately by the parity harness; this is the invariant gate.
        let model = AdjustmentModel { look: crate::view::look::Look::Neutral, ..AdjustmentModel::default() };
        let (w, h, bytes) = render_from_scene_linear(ramp, &model)
            .expect("synthetic ramp render");
        assert_eq!(w, 64);
        assert_eq!(h, 4);
        assert_eq!(bytes.len(), (w * h * 3) as usize);
        // First row, channel R: must be monotone non-decreasing.
        for x in 1..w as usize {
            let prev = bytes[(x - 1) * 3] as i32;
            let cur = bytes[x * 3] as i32;
            assert!(cur >= prev,
                "non-monotone at x={}: {} -> {}", x, prev, cur);
        }
        // Achromatic: R == G == B at every pixel (tolerance for view-
        // transform / quantize rounding).
        for x in 0..w as usize {
            let r = bytes[x * 3];
            let g = bytes[x * 3 + 1];
            let b = bytes[x * 3 + 2];
            assert!((r as i32 - g as i32).abs() <= 2,
                "R-G drift at x={}: {} vs {}", x, r, g);
            assert!((g as i32 - b as i32).abs() <= 2,
                "G-B drift at x={}: {} vs {}", x, g, b);
        }
    }

    /// Banding-sanity gate (#482). A high-resolution (4096-wide) neutral
    /// 0→1 ramp run through the view transform (AgX + sRGB encode + 8-bit
    /// quantise) must produce a smooth, monotone 8-bit gradient with no
    /// wide plateaus.
    ///
    /// fp16 banding fingerprint on a smooth gradient: ~3 bits of mantissa
    /// drop out near the AgX shoulder, producing a "jump-then-plateau"
    /// pattern — adjacent scene-linear values get collapsed onto the same
    /// fp16 bucket, then the next bucket jumps by several codes. A clean
    /// f32 scene buffer produces every adjacent step ≤ 1 code at this
    /// resolution.
    ///
    /// We use 4096 pixels so each scene-linear step is 1/4096 ≈ 0.000244,
    /// well below the smallest derivative of AgX × sRGB encode × u8 quantize
    /// on the ramp. At that resolution every code transition takes ≥ 1
    /// pixel; the f32 pipeline never skips. fp16 storage in the scene
    /// buffer would produce visible +2 / +3 steps around the AgX shoulder
    /// transitions.
    ///
    /// The Rust path is f32 today; this test guards against an accidental
    /// round-trip through fp16 (e.g. routing the scene buffer through the
    /// legacy fp16 FFI surface). The Web equivalent lives in
    /// `pipeline.spec.ts` (#482) — skip-passes under jsdom.
    #[test]
    fn neutral_ramp_view_transform_produces_no_banding_at_high_resolution() {
        use crate::synthetic_input::neutral_ramp;
        let width: u32 = 4096;
        let ramp = neutral_ramp(width, 1);
        // Force Look::Neutral — the empirical LUT introduces per-channel
        // floors that violate strict-monotonicity by design. Banding gate
        // is on the upstream pipeline, not the LUT.
        let model = AdjustmentModel {
            look: crate::view::look::Look::Neutral,
            ..AdjustmentModel::default()
        };
        let (w, _h, bytes) = render_from_scene_linear(ramp, &model)
            .expect("ramp render");
        assert_eq!(w, width);
        // Green channel at byte offset 1 (Rec.2020 luma weight is highest
        // on green, so banding shows up there first).
        let row: Vec<u8> = (0..w as usize).map(|x| bytes[x * 3 + 1]).collect();
        // Every adjacent step must be 0 or +1. A +2 step at this
        // resolution would indicate fp16-precision banding.
        let mut max_step: i32 = 0;
        let mut max_step_x: usize = 0;
        for x in 1..row.len() {
            let step = row[x] as i32 - row[x - 1] as i32;
            if step > max_step {
                max_step = step;
                max_step_x = x;
            }
        }
        assert!(max_step <= 1,
            "banding: max step in 4096-px ramp = +{} at x={} ({} → {}) — \
             must be <= +1 for a clean f32 scene buffer (fp16 storage in \
             the scene buffer would produce +2 / +3 jumps near the AgX \
             shoulder)",
            max_step, max_step_x, row[max_step_x - 1], row[max_step_x]);
    }

    // Note: a paired "negative control" that round-trips the input ramp
    // through fp16 once does NOT produce visible banding at 4096-px
    // resolution — a single fp16 truncation has 11-bit mantissa precision
    // in [0, 1], which is below the 8-bit quantize threshold. The
    // banding artefact emerges when MULTIPLE stages compound their
    // fp16 truncations (the WebGL ping-pong chain runs ~5 sequential
    // passes, each storing back into RGBA16F). The Rust-side gate above
    // is a positive smoke test that proves the f32 pipeline doesn't
    // self-produce wide jumps; the meaningful fp16-vs-f32 regression
    // surface lives on the WebGL side (#482) where the chain depth
    // exposes accumulated truncation.

    #[test]
    fn render_from_scene_linear_uniform_hue_patch_is_uniform_output() {
        let patch = hue_patch(Primary::Red, 0.0, 8, 8);
        let model = AdjustmentModel::default();
        let (w, h, bytes) = render_from_scene_linear(patch, &model)
            .expect("synthetic hue patch render");
        // Every pixel should map to the same triple — no spatial noise.
        let r0 = bytes[0];
        let g0 = bytes[1];
        let b0 = bytes[2];
        for i in 0..(w * h) as usize {
            assert_eq!(bytes[i * 3], r0, "pixel {} R differs", i);
            assert_eq!(bytes[i * 3 + 1], g0, "pixel {} G differs", i);
            assert_eq!(bytes[i * 3 + 2], b0, "pixel {} B differs", i);
        }
    }

    #[test]
    fn render_from_scene_linear_halo_disk_dark_center_bright_corners() {
        let disk = halo_disk(64, 64);
        let model = AdjustmentModel::default();
        let (w, h, bytes) = render_from_scene_linear(disk, &model)
            .expect("synthetic halo render");
        assert_eq!(w, 64);
        assert_eq!(h, 64);
        let center_r = bytes[(32 * 64 + 32) * 3] as i32;
        let corner_r = bytes[0] as i32;
        assert!(center_r < corner_r - 30,
            "halo center / corner contrast collapsed: center={} corner={}", center_r, corner_r);
    }

    #[test]
    fn render_from_scene_linear_with_chain_dehaze_zero_is_passthrough() {
        // With every slider at default (0), the chain should produce the
        // same bytes as the view-transform-only path (modulo a couple
        // levels of u8 rounding from the extra Oklab round-trips).
        //
        // Force `Look::Neutral` here — sub-1-unit float drift in the chain
        // path can index either side of a step in the Look LUT, producing
        // up to a few u8 of post-LUT divergence even though the underlying
        // pipelines match within float tolerance. This test gates pipeline
        // equivalence, not the Look layer.
        let ramp_a = neutral_ramp(32, 2);
        let ramp_b = neutral_ramp(32, 2);
        let model = AdjustmentModel { look: crate::view::look::Look::Neutral, ..AdjustmentModel::default() };
        let (_, _, plain) = render_from_scene_linear(ramp_a, &model).unwrap();
        let (_, _, chained) = render_from_scene_linear_with_chain(ramp_b, &model).unwrap();
        assert_eq!(plain.len(), chained.len());
        let max_diff = plain.iter().zip(chained.iter())
            .map(|(a, b)| (*a as i32 - *b as i32).abs())
            .max()
            .unwrap();
        assert!(max_diff <= 3,
            "default model with-chain vs no-chain should match (max diff {})", max_diff);
    }
}
