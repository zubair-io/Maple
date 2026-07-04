//! ACR-match solver — Phase 2 of epic #1710.
//!
//! The module is split into two tiers:
//!
//! **Always compiled** (`model.rs`): `AcrModel`, `Tonescale`, `HueChromaField`,
//! `FitStats`, `apply_model`, and the JSON round-trip.  The future bake path
//! and `apply_model` in the shipping core need these unconditionally.
//!
//! **Test-support only** (this file, `tonescale.rs`, `field.rs`,
//! `from_pairs.rs`): the solver itself — spec JSON parsing, patch extraction,
//! `solve_acr_model`, `solve_acr_model_multi`, and (Auto 2.0 M0, #1740) the
//! JPEG-pair front-end `solve_acr_model_from_display_pairs` that runs the same
//! tonescale + field fit against a real photo's scattered
//! `auto_profile::pairs::DisplayPair` correspondences instead of a synthetic
//! chart.  Compiled only when `feature = "test-support"` is active so the
//! solver (and its DNG-synthesis helpers) never ship in the xcframework or
//! the WASM binary.

pub mod model;

pub use model::{apply_model, AcrModel, FitStats, HueChromaField, Tonescale};

// Solver sub-modules and the public solver API are test-support-only.
#[cfg(feature = "test-support")]
pub mod field;
#[cfg(feature = "test-support")]
pub mod from_pairs;
#[cfg(feature = "test-support")]
pub mod tonescale;

#[cfg(feature = "test-support")]
pub use from_pairs::{
    neutral_samples_from_pairs, solve_acr_model_from_display_pairs, sweep_samples_from_pairs,
};
#[cfg(feature = "test-support")]
pub use tonescale::{KnotRange, NeutralSample};

#[cfg(feature = "test-support")]
use field::{fit_field, SweepSample};
#[cfg(feature = "test-support")]
use model::{ciede2000, srgb_linear_to_lab};
#[cfg(feature = "test-support")]
use tonescale::fit_tonescale;

#[cfg(feature = "test-support")]
use crate::color::matrices::M_REC2020_TO_SRGB;
#[cfg(feature = "test-support")]
use crate::view::agx_inverse::srgb_gamma_inv;

// ── Patch geometry ─────────────────────────────────────────────────────────────

/// Default inner crop: 24×24 core of each 48px patch (skip 12 on each side).
pub const INNER_CROP: u32 = 24;
pub const PATCH_SIZE: u32 = 48;
pub const GUARD: u32 = 8;
pub const COLS: u32 = 64;
pub const ROWS: u32 = 48;

// ── Spec JSON parser ───────────────────────────────────────────────────────────

/// Minimal parsed patch record from the spec JSON.
#[cfg(feature = "test-support")]
#[derive(Clone, Debug)]
pub struct SpecPatch {
    pub index: usize,
    pub col: u32,
    pub row: u32,
    pub target_rec2020: [f32; 3],
    pub group: SpecGroup,
    pub clamped: bool,
}

#[cfg(feature = "test-support")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpecGroup {
    Neutral,
    Sweep,
    Exposure2x,
    Exposure4x,
}

/// Parse the spec JSON produced by `SyntheticSweepChart::spec_to_json()`.
/// Hand-parsed — no serde dep here. Returns an error string on failure.
#[cfg(feature = "test-support")]
pub fn parse_spec_json(json: &str) -> Result<Vec<SpecPatch>, String> {
    let mut patches = Vec::new();
    // Each patch is one JSON object on its own line.
    for line in json.lines() {
        let line = line.trim().trim_end_matches(',');
        if !line.starts_with('{') {
            continue;
        }
        let patch =
            parse_spec_line(line).ok_or_else(|| format!("failed to parse spec line: {line}"))?;
        patches.push(patch);
    }
    Ok(patches)
}

#[cfg(feature = "test-support")]
fn parse_spec_line(line: &str) -> Option<SpecPatch> {
    let index = parse_u64(line, "\"index\":")?;
    let col = parse_u64(line, "\"col\":")?;
    let row = parse_u64(line, "\"row\":")?;
    let rgb = parse_floats3(line, "\"target_rec2020\":[")?;
    let group_str = parse_str_field(line, "\"group\":")?;
    let group = match group_str.as_str() {
        "neutral" => SpecGroup::Neutral,
        "sweep" => SpecGroup::Sweep,
        "exposure2x" => SpecGroup::Exposure2x,
        "exposure4x" => SpecGroup::Exposure4x,
        _ => return None,
    };
    let clamped_str = parse_str_field(line, "\"clamped\":")?;
    let clamped = clamped_str == "true";
    Some(SpecPatch {
        index: index as usize,
        col: col as u32,
        row: row as u32,
        target_rec2020: rgb,
        group,
        clamped,
    })
}

#[cfg(feature = "test-support")]
fn parse_u64(s: &str, key: &str) -> Option<u64> {
    let pos = s.find(key)? + key.len();
    let rest = s[pos..].trim_start();
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

#[cfg(feature = "test-support")]
fn parse_floats3(s: &str, key: &str) -> Option<[f32; 3]> {
    let pos = s.find(key)? + key.len();
    let end = s[pos..].find(']')? + pos;
    let inner = &s[pos..end];
    let parts: Vec<f32> = inner
        .split(',')
        .filter_map(|x| x.trim().parse().ok())
        .collect();
    if parts.len() == 3 {
        Some([parts[0], parts[1], parts[2]])
    } else {
        None
    }
}

#[cfg(feature = "test-support")]
fn parse_str_field(s: &str, key: &str) -> Option<String> {
    let pos = s.find(key)? + key.len();
    let rest = s[pos..].trim_start();
    // Value is either a quoted string or a bare bool/number.
    if rest.starts_with('"') {
        let inner = &rest[1..];
        let end = inner.find('"')?;
        Some(inner[..end].to_string())
    } else {
        // bare token: true, false, or number.
        let end = rest
            .find(|c: char| c == ',' || c == '}')
            .unwrap_or(rest.len());
        Some(rest[..end].trim().to_string())
    }
}

// ── Patch mean extraction ──────────────────────────────────────────────────────

/// Extract the mean of the inner `INNER_CROP × INNER_CROP` core of a patch
/// from an 8-bit sRGB PNG. The PNG is row-major RGB packed bytes.
#[cfg(feature = "test-support")]
pub fn extract_patch_mean_srgb(png_rgb: &[u8], png_w: usize, col: u32, row: u32) -> [f32; 3] {
    let stride = (PATCH_SIZE + GUARD) as usize;
    let skip = ((PATCH_SIZE - INNER_CROP) / 2) as usize;
    let x0 = col as usize * stride + skip;
    let y0 = row as usize * stride + skip;
    let inner = INNER_CROP as usize;
    let mut sums = [0.0f64; 3];
    let mut n = 0u64;
    for dy in 0..inner {
        for dx in 0..inner {
            let base = ((y0 + dy) * png_w + (x0 + dx)) * 3;
            if base + 2 >= png_rgb.len() {
                continue;
            }
            sums[0] += png_rgb[base] as f64;
            sums[1] += png_rgb[base + 1] as f64;
            sums[2] += png_rgb[base + 2] as f64;
            n += 1;
        }
    }
    let nn = n.max(1) as f64;
    [
        (sums[0] / nn / 255.0) as f32,
        (sums[1] / nn / 255.0) as f32,
        (sums[2] / nn / 255.0) as f32,
    ]
}

// ── Main solver ────────────────────────────────────────────────────────────────

/// Clip mask for the ev=0 baseline render.
/// Excludes: spec.clamped=true, any 8-bit channel ≥ 250/255, or any spec
/// target channel > 1.0 (DNG can't represent it).
#[cfg(feature = "test-support")]
fn is_clipped(spec: &SpecPatch, mean_8bit_srgb: [f32; 3]) -> bool {
    is_clipped_for_ev(spec, mean_8bit_srgb, 0.0)
}

/// Clip mask for an arbitrary-EV render.
///
/// For ev=0, the spec's `target_rec2020 > 1.0` check applies (DNG limit).
/// For non-zero EV renders, that check is skipped: the DNG limit applies to
/// the unshifted scene; at offset EV, the patch's scene-linear signal is
/// scaled by `2^ev`, so patches that were above DNG range at ev=0 may be
/// well within the display range in the darkened render.  The only reliable
/// clip signal is the 8-bit near-white test on the actual render output.
#[cfg(feature = "test-support")]
fn is_clipped_for_ev(spec: &SpecPatch, mean_8bit_srgb: [f32; 3], ev: f32) -> bool {
    if spec.clamped {
        return true;
    }
    // At ev=0, patches whose scene-linear targets exceed the DNG white level
    // (>1.0) are always clipped — the DNG encoder cannot represent them.
    // At non-zero EV, the ACR renders them darkened and they may be
    // unclipped in the display output, so skip the DNG-range check.
    if ev == 0.0 && spec.target_rec2020.iter().any(|&v| v > 1.0) {
        return true;
    }
    // 8-bit near-white: reliably detects saturation at any EV.
    mean_8bit_srgb.iter().any(|&v| v >= 250.0 / 255.0)
}

/// A single render provided to the multi-render pooled solver.
///
/// `ev` is the ACR exposure offset in EV.  Exactly one render must have
/// `ev == 0.0` — that render's unclipped sweep patches drive the hue/chroma
/// field fit.  All renders contribute neutral samples to the pooled tonescale
/// solve via `x = L · 2^ev`.
#[cfg(feature = "test-support")]
pub struct AcrRender<'a> {
    /// Flat row-major packed-RGB byte array (8-bit per channel).
    pub png_rgb: &'a [u8],
    /// Width of the PNG in pixels.
    pub png_w: usize,
    /// ACR exposure offset in EV (e.g. `0.0` for the baseline render,
    /// `-2.0` for a 2-stop underexposure).
    pub ev: f32,
}

/// Multi-render pooled solver.
///
/// Accepts one or more renders of the same chart at different ACR exposure
/// offsets.  For each render the neutral patches produce `(x, y)` samples
/// with `x = L · 2^ev` and `y = measured display luminance`.  The clipping
/// threshold is applied in the shifted x-space.  All unclipped samples from
/// all renders are pooled into one tonescale fit, giving the solver
/// observation range beyond the highlight clip of the baseline render.
///
/// The hue/chroma field fit uses only the ev=0 render's sweep patches
/// (colour patches are in the SDR range and do not benefit from the shift).
///
/// **Exactly one render must have `ev == 0.0`**; the function returns an
/// error otherwise.
///
/// When more than one render is provided, an **overlap consistency** metric
/// is computed: the x-range where two adjacent renders both contribute
/// unclipped samples is identified, the tonescale is evaluated on each
/// render's samples separately over that range, and the RMS relative
/// difference of the two per-render curves is stored as `overlap_rms_rel` in
/// `model.stats`.  If overlap disagreement exceeds 5% a warning is printed to
/// stderr (Exposure2012-linearity assumption may be breaking down), but the
/// model is still emitted.  When only one render is supplied `overlap_rms_rel`
/// is `None` / absent from the JSON.
#[cfg(feature = "test-support")]
pub fn solve_acr_model_multi(
    specs: &[SpecPatch],
    renders: &[AcrRender<'_>],
) -> Result<AcrModel, String> {
    // Validate: exactly one ev=0 render.
    let ev0_count = renders.iter().filter(|r| r.ev == 0.0).count();
    if ev0_count != 1 {
        return Err(format!(
            "exactly one render must have ev=0.0, found {ev0_count}"
        ));
    }
    if renders.is_empty() {
        return Err("at least one render is required".into());
    }

    // ── Stage 1: collect neutral samples from all renders ──────────────────
    // Each render contributes (x = L * 2^ev, y = display luminance) samples.
    // Per-render sample lists are kept for the overlap consistency check.
    let mut all_neutral: Vec<NeutralSample> = Vec::new();
    // Per-render neutral sample buckets for overlap consistency.
    let mut per_render_neutrals: Vec<Vec<NeutralSample>> = Vec::with_capacity(renders.len());

    let mut sweep_samples: Vec<SweepSample> = Vec::new();
    let mut total_clipped = 0usize;

    for render in renders.iter() {
        let ev_scale = (render.ev as f32).exp2();
        let mut render_neutrals: Vec<NeutralSample> = Vec::new();

        for spec in specs {
            let mean_8bit =
                extract_patch_mean_srgb(render.png_rgb, render.png_w, spec.col, spec.row);
            if is_clipped_for_ev(spec, mean_8bit, render.ev) {
                if render.ev == 0.0 {
                    total_clipped += 1;
                }
                continue;
            }
            let display_lin = [
                srgb_gamma_inv(mean_8bit[0]),
                srgb_gamma_inv(mean_8bit[1]),
                srgb_gamma_inv(mean_8bit[2]),
            ];

            match spec.group {
                SpecGroup::Neutral => {
                    // Scene luminance shifted by the EV offset.
                    let scene_lum = spec.target_rec2020[0] * ev_scale;
                    let display_lum =
                        0.2126 * display_lin[0] + 0.7152 * display_lin[1] + 0.0722 * display_lin[2];
                    let sample = NeutralSample {
                        scene_lum,
                        display_lum,
                    };
                    all_neutral.push(sample);
                    render_neutrals.push(sample);
                }
                SpecGroup::Sweep => {
                    // Sweep patches: baseline render only.
                    if render.ev == 0.0 {
                        sweep_samples.push(SweepSample {
                            scene_rec2020: spec.target_rec2020,
                            display_srgb: display_lin,
                        });
                    }
                }
                _ => {} // exposure planes: not used in stage 1/2 fits
            }
        }
        per_render_neutrals.push(render_neutrals);
    }

    let ts = fit_tonescale(&all_neutral).ok_or("tonescale fit failed: too few neutral samples")?;

    // ── Stage 2: field fit (baseline render only) ──────────────────────────
    let (field, patches_used, patches_clipped_stage2) = fit_field(&sweep_samples, &ts);
    let patches_clipped = total_clipped + patches_clipped_stage2;

    // ── Stage 3: overlap consistency metric ───────────────────────────────
    let overlap_rms_rel = if renders.len() >= 2 {
        compute_overlap_rms_rel(&per_render_neutrals, &ts)
    } else {
        None
    };

    if let Some(rms) = overlap_rms_rel {
        if rms > 0.05 {
            eprintln!(
                "[fit-acr] WARNING: overlap_rms_rel={:.4} > 5% — \
                 Exposure2012 scene-linear assumption may be breaking down; \
                 tonescale fit is still emitted",
                rms
            );
        }
    }

    // ── Stage 4: RMS DE00 over unclipped sweep patches ────────────────────
    // Use the baseline render for the RMS DE00 computation.
    let ev0_render = renders.iter().find(|r| r.ev == 0.0).unwrap();
    let fit_rms_de = compute_fit_rms_de(specs, ev0_render.png_rgb, ev0_render.png_w, &ts, &field);

    Ok(AcrModel {
        tonescale: ts,
        field,
        stats: FitStats {
            patches_used,
            patches_clipped,
            fit_rms_de,
            overlap_rms_rel,
        },
    })
}

/// Single-render convenience wrapper.  Equivalent to calling
/// `solve_acr_model_multi` with one render at ev=0.
#[cfg(feature = "test-support")]
pub fn solve_acr_model(
    specs: &[SpecPatch],
    png_rgb: &[u8],
    png_w: usize,
) -> Result<AcrModel, String> {
    solve_acr_model_multi(
        specs,
        &[AcrRender {
            png_rgb,
            png_w,
            ev: 0.0,
        }],
    )
}

/// Compute the overlap consistency metric across adjacent render pairs.
///
/// For each pair of renders (sorted by ev) that overlap in x-space (i.e. the
/// higher-ev render has samples below the clip point of the lower-ev render),
/// fit the tonescale on each render's samples separately and measure the RMS
/// relative difference of `T(x)` over the shared x range.  Returns the
/// maximum such metric across all pairs; `None` if no overlap region exists.
#[cfg(feature = "test-support")]
fn compute_overlap_rms_rel(
    per_render_neutrals: &[Vec<NeutralSample>],
    _full_ts: &model::Tonescale,
) -> Option<f32> {
    // For the overlap metric we need at least two renders with samples.
    let mut non_empty: Vec<&Vec<NeutralSample>> = per_render_neutrals
        .iter()
        .filter(|v| v.len() >= 2)
        .collect();
    if non_empty.len() < 2 {
        return None;
    }

    // Sort ALL non-empty render sample sets by their median x — ascending, so
    // index i and i+1 are the "adjacent" pair sharing the narrowest x-gap
    // (lowest-exposure/widest-range render first, highest-exposure/shifted-
    // left-by-2^ev render last).
    let median_x = |samples: &[NeutralSample]| -> f32 {
        let mut xs: Vec<f32> = samples.iter().map(|s| s.scene_lum).collect();
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        xs[xs.len() / 2]
    };
    non_empty.sort_by(|a, b| median_x(a).partial_cmp(&median_x(b)).unwrap());

    // Evaluate the metric on every adjacent pair and keep the maximum — a
    // single badly-disagreeing seam should surface the warning even if the
    // other seams are clean.
    let mut max_rms: Option<f32> = None;
    for pair in non_empty.windows(2) {
        let (lo, hi) = (pair[0], pair[1]);

        // The overlap is the intersection of the two renders' x ranges.
        let x_min_lo = lo.iter().map(|s| s.scene_lum).fold(f32::INFINITY, f32::min);
        let x_max_lo = lo
            .iter()
            .map(|s| s.scene_lum)
            .fold(f32::NEG_INFINITY, f32::max);
        let x_min_hi = hi.iter().map(|s| s.scene_lum).fold(f32::INFINITY, f32::min);
        let x_max_hi = hi
            .iter()
            .map(|s| s.scene_lum)
            .fold(f32::NEG_INFINITY, f32::max);

        let overlap_lo = x_min_lo.max(x_min_hi);
        let overlap_hi = x_max_lo.min(x_max_hi);
        if overlap_lo >= overlap_hi {
            continue;
        }

        // Fit tonescale separately on each render's samples.
        let Some(ts_lo) = fit_tonescale(lo) else {
            continue;
        };
        let Some(ts_hi) = fit_tonescale(hi) else {
            continue;
        };

        // Sample 20 points in the overlap range and compute RMS relative diff.
        let n_eval = 20usize;
        let mut sum_sq = 0.0f64;
        let mut count = 0usize;
        for i in 0..n_eval {
            let t = i as f32 / (n_eval - 1) as f32;
            let x = overlap_lo + t * (overlap_hi - overlap_lo);
            if x <= 0.0 {
                continue;
            }
            let y0 = model::tonescale_apply(&ts_lo, x);
            let y1 = model::tonescale_apply(&ts_hi, x);
            let avg = (y0 + y1) / 2.0;
            if avg < 1e-4 {
                continue;
            }
            let rel = ((y0 - y1) / avg) as f64;
            sum_sq += rel * rel;
            count += 1;
        }

        if count == 0 {
            continue;
        }
        let rms = (sum_sq / count as f64).sqrt() as f32;
        max_rms = Some(max_rms.map_or(rms, |m: f32| m.max(rms)));
    }

    max_rms
}

/// Compute the root-mean-square CIEDE2000 of `apply_model` prediction vs
/// measured display sRGB, over unclipped sweep patches.
#[cfg(feature = "test-support")]
fn compute_fit_rms_de(
    specs: &[SpecPatch],
    png_rgb: &[u8],
    png_w: usize,
    ts: &model::Tonescale,
    field: &HueChromaField,
) -> f32 {
    let m = AcrModel {
        tonescale: ts.clone(),
        field: field.clone(),
        stats: FitStats {
            patches_used: 0,
            patches_clipped: 0,
            fit_rms_de: 0.0,
            overlap_rms_rel: None,
        },
    };
    let mut total_de = 0.0f64;
    let mut n = 0usize;

    for spec in specs {
        if spec.group != SpecGroup::Sweep || spec.clamped {
            continue;
        }
        let mean_8bit = extract_patch_mean_srgb(png_rgb, png_w, spec.col, spec.row);
        if is_clipped(spec, mean_8bit) {
            continue;
        }
        // Measured display.
        let meas_lin = [
            srgb_gamma_inv(mean_8bit[0]),
            srgb_gamma_inv(mean_8bit[1]),
            srgb_gamma_inv(mean_8bit[2]),
        ];
        let lab_meas = srgb_linear_to_lab(meas_lin);

        // Model prediction.
        let pred_rec2020 = apply_model(&m, spec.target_rec2020);
        let pred_srgb = M_REC2020_TO_SRGB.mul_vec(pred_rec2020);
        let pred_srgb_clamped = [
            pred_srgb[0].clamp(0.0, 1.0),
            pred_srgb[1].clamp(0.0, 1.0),
            pred_srgb[2].clamp(0.0, 1.0),
        ];
        let lab_pred = srgb_linear_to_lab(pred_srgb_clamped);

        let de = ciede2000(lab_meas, lab_pred);
        total_de += (de as f64) * (de as f64);
        n += 1;
    }

    if n == 0 {
        0.0
    } else {
        (total_de / n as f64).sqrt() as f32
    }
}

// Tests live in the sibling `mod_tests.rs` so this file stays closer to the
// 600-LOC hard budget (same `#[path]` split pattern as `auto_profile/lut.rs`).
#[cfg(all(test, feature = "test-support"))]
#[path = "mod_tests.rs"]
mod tests;
