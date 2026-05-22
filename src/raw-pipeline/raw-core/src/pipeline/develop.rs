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
//! 6. DCP `profile_for` + `apply_with_plt_and_ptc` (HSM → PTC → PLT in
//!    linear-ProPhoto-D50, then gamut conversion to Rec.2020),
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
    image::RawImage,
    linearize,
    stages::{
        auto_exposure, capture_sharpening, clarity, dehaze, highlight_recovery, noise_reduction,
        saturation, scene_tone_controls, sharpen, texture, vibrance, white_balance,
    },
    xmp::AdjustmentModel,
};

use super::{
    capture_sharpening_helper::capture_sharpening_params_from_model,
    downsample::downsample_image_area, dump_after, stage, RenderQuality, AUTO_EXPOSURE_CLIP_PCT,
};

/// Run the entire development chain through `nr_color` and return the
/// developed `Image` in `ColorSpace::SceneLinearRec2020`. Shared by both
/// the legacy display-encoded entry (`render_from_raw_with_quality`) and
/// the scene-linear FFI entry (`render_scene_linear_from_raw_with_quality`)
/// so the two paths can never drift.
///
/// Stages: linearize, demosaic, baseline_exposure, highlight_recovery,
/// dcp::profile_for + dcp::apply (camera RGB → SceneLinearRec2020),
/// white_balance, scene_tone_controls, vibrance, saturation, clarity,
/// texture, dehaze, sharpen, nr_luminance, nr_color.
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
    // DCP. Re-enabled in Phase 1.2 of the color-convergence work after the
    // per-body BaselineExposure table was populated in Phase 1.1 (which
    // satisfied the prerequisite that originally deferred this step). See
    // .archived-plans/specs/2026-04-30-color-convergence-design.md.
    //
    // Skipped for 8-bit lossy LinearRaw DNGs (Adobe DNG Converter's
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
    let (profile, source) = stage("dcp::profile_for", || dcp::profile_for_with_source(raw))?;
    // dcp::apply_with_plt_and_ptc runs HSM (from `profile.hsm`),
    // ProfileToneCurve (from `raw.profile_tone_curve`), and PLT (from
    // `raw.plt`) ALL in linear-ProPhoto-D50 space, between the chromatic
    // adaptation and the gamut conversion to Rec.2020. Order per Adobe
    // DNG SDK reference: HSM → PTC → PLT (DNG 1.4 § 6.4.4 + DNG 1.6
    // § 6.6/§ 6.7). When all three are absent, falls through to the
    // fast single-matmul path.
    //
    // When a bundled Maple profile is in use, suppress the source DNG's
    // ProfileToneCurve — that tag was calibrated against the vendor's own
    // matrices (iPhone DNGs ship a 257-pair PTC tuned for Apple's
    // matrices, not Adobe Standard's), so applying it after a matrix swap
    // is a tone double-up that AgX would have to undo. PLT stays: on
    // Adobe-DNG-Converter outputs it's actually Adobe Standard's look
    // table and removing it regresses ΔE on Canon DNG fixtures. The
    // universal DisplayLookCurve (separate ticket) replaces PLT entirely.
    //
    // `source` comes from the same lookup `profile_for_with_source`
    // already did — no second HashMap probe or env-var read in this hot
    // path. See `dcp::ProfileSource` for the rationale.
    let use_bundled = matches!(source, dcp::ProfileSource::Bundled);
    let ptc_for_apply = if use_bundled { None } else { raw.profile_tone_curve.as_ref() };
    let mut scene = stage("dcp::apply", || dcp::apply_with_plt_and_ptc(
        &camera_rgb, &profile, raw.plt.as_ref(), ptc_for_apply,
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
    // bundle (Phase 1.2) + per-body BE table (Phase 1.1) gave the chain a
    // correct foundation. Runs BEFORE scene_tone_controls so the user's
    // exposure slider stacks additively (in EV) on top of any future
    // auto-tuned baseline.
    stage("auto_exposure", || auto_exposure::apply(&mut scene, AUTO_EXPOSURE_CLIP_PCT));
    dump_after("05_auto_exposure", &scene);
    stage("white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    dump_after("06_white_balance", &scene);
    stage("scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    dump_after("07_scene_tone_controls", &scene);
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
    stage("sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    dump_after("13_sharpen", &scene);
    stage("nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    dump_after("14_nr_luminance", &scene);
    stage("nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    dump_after("15_nr_color", &scene);
    Ok(scene)
}

/// Sized variant of `develop_scene_linear_from_raw_with_quality` that
/// runs `linearize` + `demosaic` (or `linearraw_to_camera_rgb` for
/// LinearRaw fixtures), then immediately downsamples the camera-RGB
/// buffer to fit within `max_long_edge`, then runs the rest of the
/// development chain on the smaller buffer. Saves ~8× on every
/// post-demosaic stage when the source is 100 MP and the viewport is
/// ~3 MP. See ticket 06 § Recommended Milestones / Milestone 3 and
/// .archived-plans/specs/2026-04-25-ticket-06-m3-earlier-downsample-brief.md.
///
/// Per-stage profile labels are prefixed `sized_` so MAPLE_PROFILE=1
/// traces don't collide with the full-res `develop_…` labels — same
/// convention the tile path uses (`tile_*`).
///
/// Never upscales: `downsample_image_area` early-returns when the
/// source long edge is already <= `max_long_edge`. In that case this
/// helper is functionally identical to
/// `develop_scene_linear_from_raw_with_quality`, only with `sized_*`
/// stage labels.
pub fn develop_scene_linear_sized_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<crate::image::Image> {
    let mut camera_rgb = match raw.cfa {
        crate::image::CfaPattern::LinearRgb => {
            stage("sized_linearraw_decode", || linearize::linearraw_to_camera_rgb(raw))?
        }
        _ => {
            let mosaic = stage("sized_linearize", || linearize::sensor_linearize(raw));
            stage("sized_demosaic", || match quality {
                RenderQuality::Preview => demosaic::half_res(&mosaic, raw.cfa),
                #[cfg(feature = "high-quality-demosaic")]
                RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
                #[cfg(not(feature = "high-quality-demosaic"))]
                RenderQuality::Full => demosaic::bilinear(&mosaic, raw.cfa),
                RenderQuality::Amaze => demosaic::amaze(&mosaic, raw.cfa),
            })
        }
    };

    // Early downsample — the heart of this milestone. After this call
    // every later stage runs on the viewport-sized buffer instead of
    // the half-res sensor buffer. `downsample_image_area` is a no-op
    // when the source long edge is already <= `max_long_edge`.
    stage("sized_downsample_area_f32", || {
        downsample_image_area(&mut camera_rgb, max_long_edge)
    });

    if raw.baseline_exposure.abs() > 1e-4 {
        stage("sized_baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }
    dump_after("01_baseline_exposure", &camera_rgb);

    // WB pre-gain (mirrors the unsized variant — see comment there).
    let skip_pre_gain = matches!(raw.cfa, crate::image::CfaPattern::LinearRgb)
        && raw.white_level <= 255;
    if !skip_pre_gain {
        stage("sized_white_balance::apply_pre_gain", || {
            white_balance::apply_pre_gain(&mut camera_rgb, raw.as_shot_neutral)
        });
    }
    // See unsized variant (ticket #325, skip_pre_gain identity branch).
    let hr_neutral = if skip_pre_gain { [1.0; 3] } else { raw.as_shot_neutral };
    stage("sized_highlight_recovery", || highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery, hr_neutral));
    dump_after("02_highlight_recovery", &camera_rgb);
    let (profile, source) = stage("sized_dcp_profile_for", || dcp::profile_for_with_source(raw))?;
    // PTC suppression when bundled — see the comment in the full-res
    // variant. PLT stays for Adobe-DNG-Converter inputs. `source` is the
    // same lookup result `profile_for_with_source` already produced — no
    // redundant HashMap probe in the sized path either.
    let use_bundled = matches!(source, dcp::ProfileSource::Bundled);
    let ptc_for_apply = if use_bundled { None } else { raw.profile_tone_curve.as_ref() };
    let mut scene = stage("sized_dcp_apply", || dcp::apply_with_plt_and_ptc(
        &camera_rgb, &profile, raw.plt.as_ref(), ptc_for_apply,
    ))?;
    dump_after("03_dcp_apply", &scene);
    if let Some(pgtm) = raw.profile_gain_table_map.as_ref() {
        stage("sized_profile_gain_table_map", || {
            crate::color::profile_gain_table_map::apply(&mut scene, pgtm)
        });
    }
    dump_after("04_profile_gain_table_map", &scene);
    if let Some(params) = capture_sharpening_params_from_model(model) {
        stage("sized_capture_sharpening", || {
            capture_sharpening::apply_capture_sharpening(&mut scene, &params)
        });
    }
    dump_after("04b_capture_sharpening", &scene);
    stage("sized_auto_exposure", || auto_exposure::apply(&mut scene, AUTO_EXPOSURE_CLIP_PCT));
    dump_after("05_auto_exposure", &scene);
    stage("sized_white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    dump_after("06_white_balance", &scene);
    stage("sized_scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    dump_after("07_scene_tone_controls", &scene);
    stage("sized_vibrance", || vibrance::apply(&mut scene, model.vibrance));
    dump_after("08_vibrance", &scene);
    stage("sized_saturation", || saturation::apply(&mut scene, model.saturation));
    dump_after("09_saturation", &scene);
    stage("sized_clarity", || clarity::apply(&mut scene, model.clarity));
    dump_after("10_clarity", &scene);
    stage("sized_texture", || texture::apply(&mut scene, model.texture));
    dump_after("11_texture", &scene);
    stage("sized_dehaze", || dehaze::apply(&mut scene, model.dehaze));
    dump_after("12_dehaze", &scene);
    stage("sized_sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    dump_after("13_sharpen", &scene);
    stage("sized_nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    dump_after("14_nr_luminance", &scene);
    stage("sized_nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    dump_after("15_nr_color", &scene);
    Ok(scene)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // (commit `ba8e0ecb`); the calibration foundation (WB pre-gain
        // bundle + per-body BE table) doesn't inflate scene values, so the
        // early-vs-late commutativity budget stays tight.
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
