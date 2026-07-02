//! ACR-match solver — Phase 2 of epic #1710.
//!
//! Reads an ACR-rendered PNG of the dense sweep chart plus the corresponding
//! spec JSON, and fits a structured model: a neutral-derived tonescale curve
//! plus a hue-twist and chroma-taper field. The public entry point is
//! `solve_acr_model`.

pub mod field;
pub mod model;
pub mod tonescale;

pub use model::{apply_model, AcrModel, FitStats, HueChromaField, Tonescale};

use field::{fit_field, SweepSample};
use model::{ciede2000, srgb_linear_to_lab};
use tonescale::{fit_tonescale, NeutralSample};

use crate::color::matrices::M_REC2020_TO_SRGB;
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
#[derive(Clone, Debug)]
pub struct SpecPatch {
    pub index: usize,
    pub col: u32,
    pub row: u32,
    pub target_rec2020: [f32; 3],
    pub group: SpecGroup,
    pub clamped: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpecGroup {
    Neutral,
    Sweep,
    Exposure2x,
    Exposure4x,
}

/// Parse the spec JSON produced by `SyntheticSweepChart::spec_to_json()`.
/// Hand-parsed — no serde dep here. Returns an error string on failure.
pub fn parse_spec_json(json: &str) -> Result<Vec<SpecPatch>, String> {
    let mut patches = Vec::new();
    // Each patch is one JSON object on its own line.
    for line in json.lines() {
        let line = line.trim().trim_end_matches(',');
        if !line.starts_with('{') {
            continue;
        }
        let patch = parse_spec_line(line)
            .ok_or_else(|| format!("failed to parse spec line: {line}"))?;
        patches.push(patch);
    }
    Ok(patches)
}

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

fn parse_u64(s: &str, key: &str) -> Option<u64> {
    let pos = s.find(key)? + key.len();
    let rest = s[pos..].trim_start();
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

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
        let end = rest.find(|c: char| c == ',' || c == '}').unwrap_or(rest.len());
        Some(rest[..end].trim().to_string())
    }
}

// ── Patch mean extraction ──────────────────────────────────────────────────────

/// Extract the mean of the inner `INNER_CROP × INNER_CROP` core of a patch
/// from an 8-bit sRGB PNG. The PNG is row-major RGB packed bytes.
pub fn extract_patch_mean_srgb(
    png_rgb: &[u8],
    png_w: usize,
    col: u32,
    row: u32,
) -> [f32; 3] {
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

/// Clip mask: true if the patch should be excluded from fitting.
/// Excludes: spec.clamped=true, any 8-bit channel ≥ 250/255, or any spec
/// target channel > 1.0 (DNG can't represent it).
fn is_clipped(spec: &SpecPatch, mean_8bit_srgb: [f32; 3]) -> bool {
    if spec.clamped {
        return true;
    }
    if spec.target_rec2020.iter().any(|&v| v > 1.0) {
        return true;
    }
    // 8-bit near-white.
    mean_8bit_srgb.iter().any(|&v| v >= 250.0 / 255.0)
}

/// Full solver: given spec patches and the ACR PNG bytes (decoded to packed
/// 8-bit RGB), return the fitted `AcrModel`.
///
/// `png_rgb` must be a flat row-major `[r,g,b,r,g,b,...]` byte array for the
/// 3584×2688 render (or whatever the chart geometry is). `png_w` is the width.
pub fn solve_acr_model(
    specs: &[SpecPatch],
    png_rgb: &[u8],
    png_w: usize,
) -> Result<AcrModel, String> {
    // (m_srgb_to_rec2020 used inside compute_fit_rms_de via M_REC2020_TO_SRGB)

    // Stage 1: collect neutral samples for tonescale.
    let mut neutral_samples = Vec::new();
    let mut sweep_samples = Vec::new();
    let mut total_clipped = 0usize;

    for spec in specs {
        let mean_8bit = extract_patch_mean_srgb(png_rgb, png_w, spec.col, spec.row);
        if is_clipped(spec, mean_8bit) {
            total_clipped += 1;
            continue;
        }
        // Decode sRGB → linear display.
        let display_lin = [
            srgb_gamma_inv(mean_8bit[0]),
            srgb_gamma_inv(mean_8bit[1]),
            srgb_gamma_inv(mean_8bit[2]),
        ];

        match spec.group {
            SpecGroup::Neutral => {
                let scene_lum = spec.target_rec2020[0]; // R=G=B for neutrals.
                let display_lum = 0.2126 * display_lin[0]
                    + 0.7152 * display_lin[1]
                    + 0.0722 * display_lin[2];
                neutral_samples.push(NeutralSample {
                    scene_lum,
                    display_lum,
                });
            }
            SpecGroup::Sweep => {
                sweep_samples.push(SweepSample {
                    scene_rec2020: spec.target_rec2020,
                    display_srgb: display_lin,
                });
            }
            _ => {} // exposure planes: not used in stage 1/2 fits
        }
    }

    let ts = fit_tonescale(&neutral_samples)
        .ok_or("tonescale fit failed: too few neutral samples")?;

    // Stage 2: field fit.
    let (field, patches_used, patches_clipped_stage2) =
        fit_field(&sweep_samples, &ts);

    let patches_clipped = total_clipped + patches_clipped_stage2;

    // Compute fit_rms_de over unclipped sweep patches.
    let fit_rms_de = compute_fit_rms_de(specs, png_rgb, png_w, &ts, &field);

    Ok(AcrModel {
        tonescale: ts,
        field,
        stats: FitStats {
            patches_used,
            patches_clipped,
            fit_rms_de,
        },
    })
}

/// Compute mean CIEDE2000 of `apply_model` prediction vs measured display sRGB,
/// over unclipped sweep patches.
fn compute_fit_rms_de(
    specs: &[SpecPatch],
    png_rgb: &[u8],
    png_w: usize,
    ts: &Tonescale,
    field: &HueChromaField,
) -> f32 {
    let model = AcrModel {
        tonescale: ts.clone(),
        field: field.clone(),
        stats: FitStats {
            patches_used: 0,
            patches_clipped: 0,
            fit_rms_de: 0.0,
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
        let pred_rec2020 = apply_model(&model, spec.target_rec2020);
        let pred_srgb = M_REC2020_TO_SRGB.mul_vec(pred_rec2020);
        let pred_srgb_clamped = [pred_srgb[0].clamp(0.0, 1.0), pred_srgb[1].clamp(0.0, 1.0), pred_srgb[2].clamp(0.0, 1.0)];
        let lab_pred = srgb_linear_to_lab(pred_srgb_clamped);

        let de = ciede2000(lab_meas, lab_pred);
        total_de += de as f64;
        n += 1;
    }

    if n == 0 { 0.0 } else { (total_de / n as f64) as f32 }
}
