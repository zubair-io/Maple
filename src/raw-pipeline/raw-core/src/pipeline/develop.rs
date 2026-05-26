//! The canonical scene-linear develop chain.
//!
//! `develop_scene_linear_from_raw_with_quality` is the single funnel
//! every full-image entry point runs through. Stages, in order:
//!
//! 1. `linearize` (or `linearraw_to_camera_rgb` for `LinearRgb` DNGs),
//! 2. `demosaic` (half-res / bilinear / hamilton-adams / AMaZE per
//!    [`super::RenderQuality`]),
//! 3. DNG `BaselineExposure` gain,
//! 4. DNG WB pre-gain (skipped for 8-bit lossy LinearRaw),
//! 5. highlight recovery,
//! 6. DCP `profile_for` + `apply_colorimetry` (CM/FM + HSM in
//!    linear-ProPhoto-D50, then gamut conversion to Rec.2020 — #425
//!    dropped the Adobe aesthetic layers PLT/PTC),
//! 7. ProfileGainTableMap (when present),
//! 8. damped per-image auto-exposure,
//! 9. white-balance, scene-tone-controls, vibrance, saturation, clarity,
//!    texture, dehaze, sharpen, nr_luminance, nr_color.
//!
//! `develop_scene_linear_sized_from_raw_with_quality` is the
//! early-downsample variant (ticket 06 § Milestone 3): demosaic →
//! downsample-to-fit-viewport → rest-of-chain. Same stages in the same
//! order, with a `sized_*` profile-label prefix so `MAPLE_PROFILE` traces
//! don't collide with the full-res labels.

use crate::{
    color::dcp,
    demosaic,
    error::Result,
    image::{CropRect, Image, RawImage},
    linearize,
    stages::{
        auto_exposure, capture_sharpening, clarity, dehaze, highlight_recovery, local_adjustments,
        noise_reduction, saturation, scene_tone_controls, sharpen, texture, tone_curves, vibrance,
        white_balance,
    },
    xmp::AdjustmentModel,
};

use super::{
    capture_sharpening_helper::capture_sharpening_params_from_model, dump_after, stage,
    RenderQuality, AUTO_EXPOSURE_CLIP_PCT,
};

/// Crop the camera-RGB image to the DNG-recommended render rectangle.
///
/// `crop` is in raw-sensor pixel coordinates; for half-res Preview we scale
/// it by `quality_divisor` (2 for Preview, 1 for Full/Amaze) so the crop
/// lands at the right place in the half-res buffer. Out-of-range or
/// zero-sized rects fall through to a no-op (keep the buffer as-is) —
/// safety net for malformed sources that survive `CropRect::clamped`.
///
/// Cheap: one allocation of the cropped buffer plus one row-by-row copy.
/// Runs on a buffer that's still in `CameraNativeLinearRgb`, so the
/// downstream DCP / scene-linear chain operates on the smaller, post-crop
/// dimensions — saving allocator work for every later stage too.
/// Returns `Some(cropped)` when the crop actually shrinks the buffer,
/// `None` when it's a no-op (degenerate rect or full-coverage rect) so
/// the caller can keep its existing buffer without paying for an
/// `Image::clone()`. On a 100MP frame that clone is ~1.2 GB of f32 data,
/// so the no-op path matters even though it fires rarely.
pub(super) fn crop_to_default(
    image: &Image,
    crop: CropRect,
    quality_divisor: u32,
) -> Option<Image> {
    // Sensor-coords → buffer-coords. Preview's demosaic halves both axes;
    // round DOWN on the origin (lose no in-frame pixels to off-by-one)
    // and round DOWN on the size (drop the trailing half-pixel rather
    // than reaching into post-crop sensor territory).
    let qd = quality_divisor.max(1);
    let cx = crop.x / qd;
    let cy = crop.y / qd;
    let cw = crop.w / qd;
    let ch = crop.h / qd;
    // Clamp to the actual buffer extent. Defensive: a half-res Preview of
    // a sensor whose crop touches the bottom-right edge can lose a row
    // to integer rounding above; let the buffer's true (w, h) win.
    let cw = cw.min(image.width.saturating_sub(cx));
    let ch = ch.min(image.height.saturating_sub(cy));
    if cw == 0 || ch == 0 {
        // Defensive no-op — caller logged the malformed-crop case at
        // decode time and we kept Some(rect), but if it survived to here
        // with degenerate post-divisor dims (e.g. a 1×1 crop on a Preview
        // path), keep the original buffer.
        return None;
    }
    if cx == 0 && cy == 0 && cw == image.width && ch == image.height {
        // The crop covers the entire buffer; no-op.
        return None;
    }
    let mut out = Image::new(cw, ch, image.space);
    let in_w = image.width as usize;
    let cw_us = cw as usize;
    let cx_us = cx as usize;
    let cy_us = cy as usize;
    for y in 0..ch as usize {
        let src_row_start = (cy_us + y) * in_w + cx_us;
        let dst_row_start = y * cw_us;
        out.pixels[dst_row_start..dst_row_start + cw_us]
            .copy_from_slice(&image.pixels[src_row_start..src_row_start + cw_us]);
    }
    Some(out)
}

/// Per-quality divisor between raw-sensor coordinates and the post-demosaic
/// buffer. `half_res` (Preview) halves both axes; everything else preserves.
pub(super) fn quality_divisor(quality: RenderQuality) -> u32 {
    match quality {
        RenderQuality::Preview => 2,
        RenderQuality::Full | RenderQuality::Amaze => 1,
    }
}

/// Run the entire development chain through `nr_color` and return the
/// developed `Image` in `ColorSpace::SceneLinearRec2020`. Shared by both
/// the legacy display-encoded entry (`render_from_raw_with_quality`) and
/// the scene-linear FFI entry (`render_scene_linear_from_raw_with_quality`)
/// so the two paths can never drift.
///
/// Stages: linearize, demosaic, baseline_exposure, highlight_recovery,
/// dcp::profile_for + dcp::apply (camera RGB → SceneLinearRec2020),
/// white_balance, scene_tone_controls, tone_curves, vibrance, saturation,
/// clarity, texture, dehaze, sharpen, nr_luminance, nr_color.
pub fn develop_scene_linear_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<crate::image::Image> {
    let mut camera_rgb = match raw.cfa {
        crate::image::CfaPattern::LinearRgb => {
            // LinearRaw DNG: data is already 3-channel RGB. Skip the
            // mosaic path entirely. See ticket #07.
            stage("linearraw_decode", || linearize::linearraw_to_camera_rgb(raw))?
        }
        _ => {
            let mosaic = stage("linearize", || linearize::sensor_linearize(raw));
            stage("demosaic", || match quality {
                RenderQuality::Preview => demosaic::half_res(&mosaic, raw.cfa),
                #[cfg(feature = "high-quality-demosaic")]
                RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
                #[cfg(not(feature = "high-quality-demosaic"))]
                RenderQuality::Full => demosaic::bilinear(&mosaic, raw.cfa),
                RenderQuality::Amaze => demosaic::amaze(&mosaic, raw.cfa),
            })
        }
    };

    // DNG § 6.3 DefaultCrop — restrict the buffer to the camera-recommended
    // render rectangle BEFORE any color stage runs. The crop drops the
    // optical-black border (covered by ActiveArea) plus the few-px demosaic-
    // safe margin past it, eliminating the dark borders the harness was
    // tracking as a per-channel bias on test_0007 / test_0009 / test_0001
    // and shrinking Fuji X-Trans fixtures from the over-sized sensor area
    // (9216×6210) to the declared image (8256×6192). No-op for fixtures
    // without crop metadata (test_0002, test_0013) — those render the
    // full sensor, which is also what ACR does for them. See ticket #375.
    if let Some(crop) = raw.crop_rect {
        if let Some(cropped) = stage("crop_to_default", || {
            crop_to_default(&camera_rgb, crop, quality_divisor(quality))
        }) {
            camera_rgb = cropped;
        }
        // No-op (degenerate rect or full-coverage): keep camera_rgb as-is;
        // crop_to_default returns None instead of cloning the buffer.
    }
    dump_after("00b_crop_to_default", &camera_rgb);

    // DNG § C.1.2: BaselineExposure is applied as a gain in a scene-linear
    // color space prior to the color-space transform. Mathematically
    // commutative with the linear CM that follows, so we apply in the
    // camera-native space for clarity — one multiply per channel.
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }
    dump_after("01_baseline_exposure", &camera_rgb);

    // DNG WB pre-gain per spec § 1.4.4.5 step 4: divide camera RGB by
    // AsShotNeutral so a neutral scene patch reads as (1, 1, 1) going into
    // DCP. Enabled unconditionally now that the BaselineExposure compose
    // chain is sourced from DNG tags + bundled-DCP `BaselineExposureOffset`
    // only — the historical Phase-1.1 per-body BE lookup that previously
    // gated this step was removed in #370 (per-body aesthetic alignment
    // moves to a global `view::look` curve in #371). See
    // .archived-plans/specs/2026-04-30-color-convergence-design.md.
    //
    // Skipped for 8-bit lossy LinearRaw DNGs (DNG Converter's
    // perceptually-encoded output) where WB stays baked through the linearize
    // step and DCP must derive scene_white_xyz from `inv(CM) · AsShotNeutral`
    // as the empirical (legacy) path. See linearize::linearraw_to_camera_rgb
    // and dcp::profile_for for the matching wb_already_baked decision.
    let skip_pre_gain = matches!(raw.cfa, crate::image::CfaPattern::LinearRgb)
        && raw.white_level <= 255;
    if !skip_pre_gain {
        stage("white_balance::apply_pre_gain", || {
            white_balance::apply_pre_gain(&mut camera_rgb, raw.as_shot_neutral)
        });
    }
    // highlight_recovery (ticket #325) sees per-channel ceilings = 1/AsShotNeutral
    // post-pre-gain, identity (1,1,1) when pre-gain was skipped (8-bit lossy
    // LinearRaw) — without the identity branch the detector misses R/B clips
    // and trips incorrectly on G.
    let hr_neutral = if skip_pre_gain { [1.0; 3] } else { raw.as_shot_neutral };
    stage("highlight_recovery", || highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery, hr_neutral));
    dump_after("02_highlight_recovery", &camera_rgb);
    let (profile, _source) = stage("dcp::profile_for", || dcp::profile_for_with_source(raw))?;
    // dcp::apply_colorimetry runs CM/FM (chromatic adaptation) and HSM
    // (metameric correction) only. Under ticket #425 (part of #416),
    // the Adobe aesthetic layers — ProfileToneCurve (PTC) and
    // ProfileLookTable (PLT) — no longer run inside DCP regardless of
    // profile source. They were calibrated to sit under Adobe's tone
    // mapping; AgX has a different rendering intent, and stacking the
    // Adobe layers on AgX produced compound hue errors and per-format
    // inconsistency (PTC was suppressed for bundled profiles but PLT
    // still ran for bundle-miss bodies). HSM stays because the bundled
    // profile set uses it for metameric correction the linear CM cannot
    // express. `raw.plt` and `raw.profile_tone_curve` remain on RawImage
    // for now but are dead data in the develop chain; cleanup is a
    // separate follow-up.
    let mut scene = stage("dcp::apply", || dcp::apply_colorimetry(
        &camera_rgb, &profile,
    ))?;
    dump_after("03_dcp_apply", &scene);
    // ProfileGainTableMap (DNG 1.6 § 6.8) — spatially-varying RGB gain.
    // Applied AFTER the gamut conversion, in scene-linear Rec.2020. No-op
    // when raw.profile_gain_table_map is None (most fixtures).
    if let Some(pgtm) = raw.profile_gain_table_map.as_ref() {
        stage("profile_gain_table_map", || {
            crate::color::profile_gain_table_map::apply(&mut scene, pgtm)
        });
    }
    dump_after("04_profile_gain_table_map", &scene);
    // Capture sharpening — Richardson-Lucy deconvolution against a Gaussian
    // PSF, run first thing in scene-linear Rec.2020 so it sees the
    // calibrated sensor signal before any user-facing tone/WB transforms.
    // No-op when `capture_sharpening_amount` is 0 (the default), which keeps
    // the parity-harness baseline bit-identical to pre-#271 behaviour.
    // Commutative with the downstream scalar gains (auto_exposure,
    // white_balance) so placement here vs. post-AE has no algebraic effect.
    if let Some(params) = capture_sharpening_params_from_model(model) {
        stage("capture_sharpening", || {
            capture_sharpening::apply_capture_sharpening(&mut scene, &params)
        });
    }
    dump_after("04b_capture_sharpening", &scene);
    // Per-image histogram-shape auto-exposure. Operates on the
    // post-DCP/PTC/PGTM scene-linear Rec.2020 image; deterministic; pure
    // math. Production behavior is identity (`AE_DAMPING = 0.0` in
    // stages/auto_exposure.rs) — the stage computes a histogram internally
    // and returns an `AutoExposure` (with `expcomp`), but this call site
    // discards the return value and the damping is 0, so pixels are
    // untouched and nothing is surfaced today. Kept as infrastructure for
    // a future user-facing "Auto" toggle — that toggle will (a) capture
    // the returned `AutoExposure` and apply it, and (b) optionally expose
    // it as XMP/diagnostic output. The earlier
    // `MAPLE_AGX_BASELINE_COMPENSATION_EV = 0.65` band-aid + `damping = 0.2`
    // tuning were both removed in commit `ba8e0ecb` once the WB pre-gain
    // bundle (Phase 1.2) gave the chain a correct foundation. (The Phase-1.1
    // per-body BE table that originally accompanied it was itself removed
    // in #370; aesthetic alignment moves to `view::look` in #371.) Runs
    // BEFORE scene_tone_controls so the user's
    // exposure slider stacks additively (in EV) on top of any future
    // auto-tuned baseline.
    stage("auto_exposure", || auto_exposure::apply(&mut scene, AUTO_EXPOSURE_CLIP_PCT));
    dump_after("05_auto_exposure", &scene);
    stage("white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    dump_after("06_white_balance", &scene);
    stage("scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    dump_after("07_scene_tone_controls", &scene);
    // User-authored tone curves (parametric + per-channel) — see stages/tone_curves.rs.
    // Identity short-circuits on default model so this is a no-op for non-curve fixtures.
    stage("tone_curves", || tone_curves::apply(&mut scene, model));
    dump_after("07b_tone_curves", &scene);
    stage("vibrance", || vibrance::apply(&mut scene, model.vibrance));
    dump_after("08_vibrance", &scene);
    stage("saturation", || saturation::apply(&mut scene, model.saturation));
    dump_after("09_saturation", &scene);
    stage("clarity", || clarity::apply(&mut scene, model.clarity));
    dump_after("10_clarity", &scene);
    stage("texture", || texture::apply(&mut scene, model.texture));
    dump_after("11_texture", &scene);
    stage("dehaze", || dehaze::apply(&mut scene, model.dehaze));
    dump_after("12_dehaze", &scene);
    // Local adjustments (ticket #280). Empty Vec (the default) makes this a
    // bit-identical short-circuit — the parity-harness baseline is unchanged.
    stage("local_adjustments", || {
        local_adjustments::apply(&mut scene, &model.local_adjustments)
    });
    dump_after("12b_local_adjustments", &scene);
    stage("sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    dump_after("13_sharpen", &scene);
    stage("nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    dump_after("14_nr_luminance", &scene);
    stage("nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    dump_after("15_nr_color", &scene);
    Ok(scene)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::develop_sized::develop_scene_linear_sized_from_raw_with_quality;
    use super::super::downsample::downsample_image_area;

    /// Pin per-fixture full-quality output dimensions against the
    /// DNG-recommended render rectangle (`raw.crop_rect` or, when that's
    /// `None`, the full sensor). Regression test for ticket #375 — before
    /// the crop stage, every fixture rendered at sensor dimensions, which
    /// for Fuji X-Trans (test_0005 / test_0012) was 2× the declared image
    /// area and for Canon DNG (test_0007) included a visible ~80-px black
    /// border. After the fix, the full-image render path returns the
    /// camera-recommended dims (oriented). Skips when fixtures are
    /// absent (gitignored).
    ///
    /// Expected dims = `raw.crop_rect` (or width × height when None),
    /// with the orientation tag applied: portrait-shot Canon CR2
    /// (test_0003, orientation 8) produces a portrait output.
    #[test]
    fn render_dims_match_crop_rect_per_fixture() {
        let fixtures: &[(&str, u32, u32, &str)] = &[
            // (filename, expected w, expected h, note)
            // test_0001 RW2 (Panasonic LX2): rawler crop 4224×2376
            ("test_0001.RAW", 4224, 2376, "Panasonic crop"),
            // test_0003 CR2 (Canon 5DS R, portrait): crop 8688×5792
            //   -> orientation 8 (Rotate270) -> swap -> 5792×8688
            ("test_0003.CR2", 5792, 8688, "Canon portrait crop + orient"),
            // test_0005 RAF (Fuji X-Trans): crop 8256×6192 (NOT 9216×6210)
            ("test_0005.RAF", 8256, 6192, "Fuji X-Trans crop"),
            // test_0007 DNG (Canon DNG): crop 5760×3840 (NOT 5920×3950)
            ("test_0007.DNG", 5760, 3840, "Canon DNG crop"),
            // test_0009 CR2 (Canon 5DM4): crop 6720×4480 (NOT 6880×4544)
            ("test_0009.CR2", 6720, 4480, "Canon 5DM4 crop"),
            // test_0012 raf (Fuji): same as test_0005
            ("test_0012.raf", 8256, 6192, "Fuji X-Trans crop (2nd)"),
            // test_0013 iPhone DNG: no crop, full 4032×3024, orientation 6 -> swap -> 3024×4032
            ("test_0013.DNG", 3024, 4032, "iPhone portrait, no crop tags"),
            // test_0017 Leica: crop 5976×3984
            ("test_0017.dng", 5976, 3984, "Leica DNG crop"),
        ];
        let model = AdjustmentModel::default();
        for (name, ew, eh, note) in fixtures {
            let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../test-fixtures/raws")
                .join(name);
            if !path.exists() { continue; }
            let bytes = std::fs::read(&path).expect("read raw");
            // Lowercase: decode_bytes uses `ext` to build a rawler hint
            // path; rawler format detection matches lowercase suffixes
            // (e.g. `RAF` vs `raf` can disambiguate Fuji decoders).
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            let raw = crate::decode::decode_bytes(&bytes, &ext).expect("decode");
            let (w, h, _) = crate::pipeline::render_from_raw_with_quality(
                &raw, &model, RenderQuality::Full,
            ).expect("render");
            assert_eq!(
                (w, h),
                (*ew, *eh),
                "{} ({}): expected {}×{}, got {}×{}",
                name, note, ew, eh, w, h
            );
        }
    }


    /// M3 commutativity gate: render test_0017.dng via the original
    /// late-downsample path (full-res develop, then
    /// `downsample_image_area`) and the new early-downsample path
    /// (`develop_scene_linear_sized_from_raw_with_quality` runs
    /// downsample right after demosaic), then compare per-channel
    /// f32 mean delta in scene-linear Rec.2020.
    ///
    /// Budget: mean per-channel delta ≤ 0.005 in linear-light. The
    /// expected dominant source of difference is the
    /// non-commutativity of (downsample ∘ filter) vs
    /// (filter ∘ downsample); for natural scenes with sharpening
    /// disabled (sharpen_amount=0, nr_luminance=0, nr_color=25 with
    /// radius 1 px, clarity=0, dehaze=0) this is dominated by the
    /// nr_color blur and bounded by the downsample kernel's
    /// low-pass character. The test explicitly disables sharpening
    /// (the canonical default carries sharpen_amount=40 per #326)
    /// because USM sharpening near the downsample-filter cutoff is
    /// fundamentally non-commutative with downsampling and is not
    /// what this commutativity gate is measuring.
    ///
    /// Skips if test_0017.dng is absent (gitignored fixtures).
    #[test]
    fn early_vs_late_downsample_within_fp16_tolerance() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0017.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        // Disable sharpening for this commutativity gate: USM sharpening's
        // non-commutativity with downsampling is well-known and is not what
        // this test is measuring.
        let model = AdjustmentModel { sharpen_amount: 0.0, ..AdjustmentModel::default() };
        let max_long_edge: u32 = 1500;

        // Late-downsample: full-res develop, then downsample.
        let mut late = develop_scene_linear_from_raw_with_quality(
            &raw, &model, RenderQuality::Preview,
        ).expect("late develop");
        downsample_image_area(&mut late, max_long_edge);

        // Early-downsample: new helper runs downsample post-demosaic.
        let early = develop_scene_linear_sized_from_raw_with_quality(
            &raw, &model, RenderQuality::Preview, max_long_edge,
        ).expect("early develop");

        // Sizes must match — both end at <= max_long_edge on the long edge.
        assert_eq!(early.width, late.width, "width mismatch");
        assert_eq!(early.height, late.height, "height mismatch");
        assert_eq!(early.pixels.len(), late.pixels.len(), "pixel count mismatch");

        let n = early.pixels.len();
        let mut sum_dr = 0.0f64;
        let mut sum_dg = 0.0f64;
        let mut sum_db = 0.0f64;
        let mut max_dr = 0.0f32;
        let mut max_dg = 0.0f32;
        let mut max_db = 0.0f32;
        for (a, b) in early.pixels.iter().zip(late.pixels.iter()) {
            let dr = (a[0] - b[0]).abs();
            let dg = (a[1] - b[1]).abs();
            let db = (a[2] - b[2]).abs();
            sum_dr += dr as f64;
            sum_dg += dg as f64;
            sum_db += db as f64;
            if dr > max_dr { max_dr = dr; }
            if dg > max_dg { max_dg = dg; }
            if db > max_db { max_db = db; }
        }
        let mean_dr = (sum_dr / n as f64) as f32;
        let mean_dg = (sum_dg / n as f64) as f32;
        let mean_db = (sum_db / n as f64) as f32;
        eprintln!(
            "early-vs-late: mean dR={:.5} dG={:.5} dB={:.5}  max dR={:.5} dG={:.5} dB={:.5}",
            mean_dr, mean_dg, mean_db, max_dr, max_dg, max_db,
        );

        // Mean per-channel delta budget. 0.005 in [0, ~5] scene-linear
        // headroom is ~0.1% of typical scene values. Held tight since the
        // `MAPLE_AGX_BASELINE_COMPENSATION_EV = 0.65` band-aid was removed
        // (commit `ba8e0ecb`); the calibration foundation (DNG WB pre-gain
        // bundle, with the per-body BE table since removed in #370) doesn't
        // inflate scene values, so the early-vs-late commutativity budget
        // stays tight.
        assert!(mean_dr < 0.005, "mean R delta {} > 0.005", mean_dr);
        assert!(mean_dg < 0.005, "mean G delta {} > 0.005", mean_dg);
        assert!(mean_db < 0.005, "mean B delta {} > 0.005", mean_db);
    }

    /// AMaZE should resolve finer detail than Hamilton-Adams at full
    /// resolution. Renders the same Bayer DNG twice (once Full, once
    /// Amaze) through the entire scene-linear chain, then for each
    /// developed buffer:
    ///   * Computes the per-pixel green-channel gradient magnitude
    ///     (|dx| + |dy|) summed over the whole frame — the "high-frequency
    ///     energy". AMaZE's variance-driven H/V selection preserves edge
    ///     detail HA blurs over, so total HF energy should be
    ///     equal-or-greater under AMaZE.
    ///   * Confirms the global mean barely moves — AMaZE is a detail
    ///     refinement, not a tone change. The test budget allows at most
    ///     5% drift in mean luminance.
    /// Skips when test_0002.dng is absent (gitignored fixtures).
    #[test]
    fn amaze_resolves_finer_detail_than_hamilton_adams() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();

        let ha = develop_scene_linear_from_raw_with_quality(
            &raw, &model, RenderQuality::Full,
        ).expect("HA develop");
        let amz = develop_scene_linear_from_raw_with_quality(
            &raw, &model, RenderQuality::Amaze,
        ).expect("AMaZE develop");
        assert_eq!((ha.width, ha.height), (amz.width, amz.height));

        let w = ha.width as usize;
        let h = ha.height as usize;

        // Total green-channel mean — should hardly move between HA/AMaZE.
        let mean_g = |buf: &crate::image::Image| -> f64 {
            let s: f64 = buf.pixels.iter().map(|p| p[1] as f64).sum();
            s / buf.pixels.len() as f64
        };
        let m_ha = mean_g(&ha);
        let m_amz = mean_g(&amz);
        let mean_drift = ((m_amz - m_ha) / m_ha).abs();
        assert!(mean_drift < 0.05,
            "AMaZE shifted overall green mean by {:.3}% (HA mean = {:.4}, AMaZE = {:.4}); \
             expected ≤ 5%",
            mean_drift * 100.0, m_ha, m_amz);

        // High-frequency energy via the L1 gradient magnitude on the green
        // channel. We skip a 4-pixel border so AMaZE's edge-fallback
        // pixels (where it reverts to bilinear-difference) don't
        // dominate. Comparing a pure detail metric, not a per-pixel
        // ΔE — the goal is "AMaZE preserves more detail," not "AMaZE
        // shifts color."
        let hf_energy = |buf: &crate::image::Image| -> f64 {
            let mut sum = 0.0_f64;
            for y in 4..h - 4 {
                for x in 4..w - 4 {
                    let i = y * w + x;
                    let g = buf.pixels[i][1];
                    let dx = (buf.pixels[i + 1][1] - buf.pixels[i - 1][1]).abs();
                    let dy = (buf.pixels[i + w][1] - buf.pixels[i - w][1]).abs();
                    let _ = g;
                    sum += (dx + dy) as f64;
                }
            }
            sum
        };
        let hf_ha = hf_energy(&ha);
        let hf_amz = hf_energy(&amz);
        eprintln!("amaze vs hamilton-adams: mean_g HA={:.4} AMaZE={:.4} (drift={:.3}%); \
                   HF energy HA={:.0} AMaZE={:.0} (ratio={:.3}×)",
            m_ha, m_amz, mean_drift * 100.0, hf_ha, hf_amz, hf_amz / hf_ha);

        // AMaZE's HF energy must be at least as high as HA's. The 0.99
        // floor (1% slack) absorbs tiny per-pixel noise differences from
        // AMaZE's adaptive median bound on saturated edges, which can
        // very-slightly suppress one HA-only zipper. The expected
        // direction is hf_amz > hf_ha; in practice the ratio sits well
        // above 1.0 on natural fixtures.
        assert!(hf_amz / hf_ha >= 0.99,
            "AMaZE HF energy {:.0} below HA HF energy {:.0} (ratio {:.3} < 0.99) — \
             AMaZE should preserve at least as much green-channel detail as HA",
            hf_amz, hf_ha, hf_amz / hf_ha);
    }

}
