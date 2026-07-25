//! `maple-cli auto-tail-ramp` — Auto Profile tail banding instrument
//! (#1740 M1, companion to the #1627 synthetic-ramp gate).
//!
//! The synthetic-ramp sweep in `test_banding.sh` cannot exercise the Auto
//! Profile tail: the tail is fitted per-image against the RAW's own embedded
//! JPEG, and a synthetic ramp has no embedded JPEG, so the Auto stage no-ops
//! there. This command closes that gap: it fits the SHIPPING Auto Profile
//! tail from a real RAW (through the production entry point
//! `auto_profile::apply_pipeline::fit_auto_profile_artifacts`, so
//! `MAPLE_AUTO1` selects Auto 1.0 vs the default Auto 2.0 exactly as it
//! does in the app), applies that fitted tail to smooth display-space
//! ramps, and dumps
//! the results as `18_auto_tail.exr` stage dumps that
//! `src/scripts/banding_check.py` gates with the standard second-difference
//! spike metric.
//!
//! Ramps (all `DisplayEncodedSrgb`, the space the tail operates in):
//!   * `neutral` — r = g = b sweeping 0 → 1 (luma axis; catches the
//!     posterized-highlight failure the operator reproduced on `test_0000`
//!     under Auto 2.0 — a tonescale plateau maps a luminance RANGE onto one
//!     display value, and the plateau's elbow is a second-difference spike).
//!   * `foliage` / `blue` / `magenta` / `skin` — constant-L, constant-hue
//!     Oklab chroma ramps (same named hues as `synthetic_input::RampHue`),
//!     with the max chroma bisected per hue so the ramp stays strictly
//!     inside the sRGB hull — no input clamp, so any output kink is the
//!     tail's own.
//!
//! Exit codes: 0 = dumps written; 3 = skip (no embedded preview — mirrors
//! `extract-preview` / `fit-auto2`); 4 = the fit produced NO tail (a solve
//! failure — in the default mode this means Auto 2.0 silently degraded to
//! "no Auto Profile", which the banding gate must surface, not skip).
//!
//! Feature gate: `stage-dump` (the EXR writer lives behind it).

use std::path::Path;

#[cfg(not(feature = "stage-dump"))]
pub fn run(
    _raw: &Path,
    _out_dir: &Path,
    _width: u32,
    _height: u32,
) -> Result<i32, Box<dyn std::error::Error>> {
    Err("auto-tail-ramp requires the `stage-dump` cargo feature (cargo build --features stage-dump)"
        .into())
}

#[cfg(feature = "stage-dump")]
mod imp {
    use std::path::Path;

    use raw_core::color::oklab::oklab_to_rec2020;
    use raw_core::decode::decode_bytes;
    use raw_core::image::{ColorSpace, Image};
    use raw_core::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
    use raw_core::stages::{color_grade, grain};
    use raw_core::types::adjustment::AutoExposureMode;
    use raw_core::view::auto_profile::apply_curve;
    use raw_core::view::auto_profile::apply_pipeline::{
        auto1_enabled_by_env, fit_auto_profile_artifacts,
    };
    use raw_core::view::auto_profile::lut::lut_strength_from_env;
    use raw_core::view::auto_profile::preview;
    use raw_core::view::encode;
    use raw_core::xmp::AdjustmentModel;

    /// The four named ramp hues, matching `synthetic_input::RampHue`'s
    /// `(Oklab hue degrees, Oklab L)` table — reused verbatim so the tail
    /// gate sweeps the same perceptual axes as the synthetic-ramp gate.
    const HUE_RAMPS: [(&str, f32, f32); 4] = [
        ("foliage", 123.4, 0.768),
        ("blue", 264.1, 0.452),
        ("magenta", 328.4, 0.702),
        ("skin", 53.1, 0.773),
    ];

    /// Largest Oklab chroma at `(l, hue_deg)` whose linear-sRGB image stays
    /// strictly inside `[0, 1]³` (with a small margin), found by bisection.
    /// Building the ramp up to this ceiling — instead of clamping out-of-hull
    /// samples — keeps the INPUT C¹-smooth, so any second-difference spike in
    /// the output is the fitted tail's own.
    fn max_in_gamut_chroma(l: f32, hue_deg: f32) -> f32 {
        let hue_rad = hue_deg.to_radians();
        let in_gamut = |c: f32| -> bool {
            let lab = [l, c * hue_rad.cos(), c * hue_rad.sin()];
            let rec2020 = oklab_to_rec2020(lab);
            let srgb = raw_core::color::matrices::M_REC2020_TO_SRGB.mul_vec(rec2020);
            srgb.iter().all(|&v| (0.0..=1.0).contains(&v))
        };
        let (mut lo, mut hi) = (0.0f32, 0.4f32);
        for _ in 0..40 {
            let mid = 0.5 * (lo + hi);
            if in_gamut(mid) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        lo * 0.98 // stay strictly inside the hull
    }

    /// Build one `width × height` `DisplayEncodedSrgb` ramp. `None` hue →
    /// neutral (r = g = b = x/(w-1)); `Some((hue_deg, l))` → constant-L
    /// constant-hue Oklab chroma ramp, gamma-encoded.
    ///
    /// Errors (instead of clamping) when a hue-ramp sample lands outside
    /// `[0, 1]³`: the bisected chroma ceiling's 2% margin guarantees every
    /// sample sits strictly inside the sRGB hull, so an out-of-hull value
    /// here is a ramp-generation bug — a silent hard clamp would mask it
    /// with a C¹ kink of its own and blunt the gate's whole premise (any
    /// output kink must be the fitted tail's).
    fn build_ramp(width: u32, height: u32, hue: Option<(f32, f32)>) -> Result<Image, String> {
        let mut img = Image::new(width, height, ColorSpace::DisplayEncodedSrgb);
        let m_rec2020_to_srgb = raw_core::color::matrices::M_REC2020_TO_SRGB;
        let c_max = hue.map(|(h, l)| max_in_gamut_chroma(l, h));
        for y in 0..height as usize {
            for x in 0..width as usize {
                let t = x as f32 / (width - 1) as f32;
                let rgb = match hue {
                    None => {
                        let v = encode::srgb_gamma(t);
                        [v, v, v]
                    }
                    Some((hue_deg, l)) => {
                        let c = t * c_max.unwrap();
                        let hue_rad = hue_deg.to_radians();
                        let lab = [l, c * hue_rad.cos(), c * hue_rad.sin()];
                        let srgb_lin = m_rec2020_to_srgb.mul_vec(oklab_to_rec2020(lab));
                        if srgb_lin.iter().any(|v| !(0.0..=1.0).contains(v)) {
                            return Err(format!(
                                "ramp sample out of sRGB hull at t={t} (hue={hue_deg}, l={l}, \
                                 c={c}): {srgb_lin:?} — the bisected chroma ceiling should make \
                                 this impossible; refusing to clamp a generation bug away"
                            ));
                        }
                        [
                            encode::srgb_gamma(srgb_lin[0]),
                            encode::srgb_gamma(srgb_lin[1]),
                            encode::srgb_gamma(srgb_lin[2]),
                        ]
                    }
                };
                img.pixels[y * width as usize + x] = rgb;
            }
        }
        Ok(img)
    }

    pub fn run(
        raw_path: &Path,
        out_dir: &Path,
        width: u32,
        height: u32,
    ) -> Result<i32, Box<dyn std::error::Error>> {
        if width < 3 || height < 1 {
            return Err(
                format!("--width must be >= 3 and --height >= 1 (got {width}x{height})").into(),
            );
        }
        let bytes = std::fs::read(raw_path)
            .map_err(|e| format!("cannot read RAW {}: {e}", raw_path.display()))?;
        let ext = raw_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let raw = decode_bytes(&bytes, &ext).map_err(|e| format!("decode error: {e}"))?;

        let Some(extracted) = preview::extract_for_fit(raw_path) else {
            eprintln!(
                "[auto-tail-ramp] {} has no extractable embedded JPEG preview — skipping",
                raw_path.display()
            );
            return Ok(3);
        };

        // Develop the PINNED Auto Profile fit prefix — same stage-for-stage
        // replication of `auto_fit::develop_display_for_auto_fit` as
        // `maple-cli fit-auto2` (that fn is private to raw-core), so the fit
        // input is the exact buffer the shipping fit runs against.
        let fit_model = AdjustmentModel {
            auto_exposure: AutoExposureMode::Off,
            ..AdjustmentModel::default()
        };
        let mut scene =
            develop_scene_linear_from_raw_with_quality(&raw, &fit_model, RenderQuality::Full)
                .map_err(|e| format!("develop error: {e}"))?;
        raw_core::view::agx::apply(&mut scene, fit_model.contrast);
        color_grade::apply_model(&mut scene, fit_model);
        grain::apply(
            &mut scene,
            fit_model.grain_amount,
            fit_model.grain_size,
            fit_model.grain_roughness,
        );
        encode::rec2020_to_srgb(&mut scene);
        encode::srgb_gamma_encode(&mut scene);
        scene.assert_space(ColorSpace::DisplayEncodedSrgb);

        let (w, h) = (scene.width as usize, scene.height as usize);
        let mut flat: Vec<f32> = scene
            .pixels
            .iter()
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect();

        // The PRODUCTION fit entry — `MAPLE_AUTO1` selects the Auto 1.0
        // curve+LUT fit; the default is the Auto 2.0 structured fit,
        // exactly as in the app (#1740 M2).
        let mode = if auto1_enabled_by_env() {
            "auto1"
        } else {
            "auto2"
        };
        eprintln!("[auto-tail-ramp] fitting Auto Profile tail (mode={mode}) ...");
        let (curve, residual) = fit_auto_profile_artifacts(
            &mut flat,
            w,
            h,
            raw.orientation,
            Some(&extracted),
            None,
            None,
            None,
        );
        if curve.is_none() && residual.is_none() {
            eprintln!(
                "[auto-tail-ramp] fit produced NO Auto Profile tail for {} (mode={mode}) — \
                 the gate must surface this, not skip it",
                raw_path.display()
            );
            return Ok(4);
        }

        // Apply the fitted tail to each ramp the way the CPU render path
        // does: curve in place, then residual at the production strength.
        let strength = lut_strength_from_env();
        let ramps: [(&str, Option<(f32, f32)>); 5] = [
            ("neutral", None),
            (HUE_RAMPS[0].0, Some((HUE_RAMPS[0].1, HUE_RAMPS[0].2))),
            (HUE_RAMPS[1].0, Some((HUE_RAMPS[1].1, HUE_RAMPS[1].2))),
            (HUE_RAMPS[2].0, Some((HUE_RAMPS[2].1, HUE_RAMPS[2].2))),
            (HUE_RAMPS[3].0, Some((HUE_RAMPS[3].1, HUE_RAMPS[3].2))),
        ];
        for (name, hue) in ramps {
            let mut ramp = build_ramp(width, height, hue)?;
            let mut ramp_flat: Vec<f32> = ramp
                .pixels
                .iter()
                .flat_map(|p| [p[0], p[1], p[2]])
                .collect();
            if let Some(c) = &curve {
                apply_curve(&mut ramp_flat, c);
            }
            if let Some(l) = &residual {
                l.apply_with_strength(&mut ramp_flat, strength);
            }
            for (i, px) in ramp.pixels.iter_mut().enumerate() {
                *px = [ramp_flat[i * 3], ramp_flat[i * 3 + 1], ramp_flat[i * 3 + 2]];
            }
            let dir = out_dir.join(name);
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
            raw_core::stage_dump::dump_image("18_auto_tail", &ramp, &dir);
            let exr = dir.join("18_auto_tail.exr");
            if !exr.exists() {
                return Err(format!("EXR dump failed for ramp {name} at {}", exr.display()).into());
            }
        }
        eprintln!(
            "[auto-tail-ramp] wrote 5 ramp dumps (mode={mode}, strength={strength}) under {}",
            out_dir.display()
        );
        Ok(0)
    }
}

#[cfg(feature = "stage-dump")]
pub fn run(
    raw: &Path,
    out_dir: &Path,
    width: u32,
    height: u32,
) -> Result<i32, Box<dyn std::error::Error>> {
    imp::run(raw, out_dir, width, height)
}
