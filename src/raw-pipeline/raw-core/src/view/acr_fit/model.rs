//! AcrModel: the fitted ACR-match view transform model.
//!
//! Contains the tonescale knot table, the hue/chroma field lattice, and
//! solver statistics. Provides `apply_model` (pure, allocation-free) and
//! JSON serialisation.

use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};

/// Number of tonescale knots (log2-spaced from the neutral ramp).
pub const TONESCALE_KNOTS: usize = 9;

/// Hue lattice bins (same as HUE_STEPS in the sweep chart).
pub const HUE_BINS: usize = 24;
/// Chroma lattice bins (6 is the field resolution; spec says 6 for output).
pub const CHROMA_BINS: usize = 6;
/// Luma lattice bins (8 for the field).
pub const LUMA_BINS: usize = 8;
/// Total field entries per channel (hue × chroma × luma).
pub const FIELD_N: usize = HUE_BINS * CHROMA_BINS * LUMA_BINS;

/// The fitted ACR-match model.
///
/// Apply via `apply_model(model, scene_linear_rec2020)` → display-linear
/// Rec.2020 (before gamma encode / quantise).
#[derive(Clone, Debug)]
pub struct AcrModel {
    /// Tonescale: `knots_log2[i]` = log2(scene-linear luminance),
    /// `values[i]` = display-linear luminance. Monotone, PCHIP-derived.
    pub tonescale: Tonescale,
    /// Hue/chroma field.
    pub field: HueChromaField,
    /// Fit diagnostics.
    pub stats: FitStats,
}

/// Piecewise-cubic (PCHIP-style) tonescale.
#[derive(Clone, Debug)]
pub struct Tonescale {
    /// Log2(scene-linear L) knot positions, monotone increasing.
    pub knots_log2: Vec<f32>,
    /// Display-linear L values at each knot.
    pub values: Vec<f32>,
}

/// Hue/chroma residual field on a [HUE_BINS × CHROMA_BINS × LUMA_BINS] lattice.
#[derive(Clone, Debug)]
pub struct HueChromaField {
    pub hue_bins: usize,
    pub chroma_bins: usize,
    pub luma_bins: usize,
    /// Hue twist in degrees per lattice cell, flat row-major
    /// [luma][chroma][hue] → len = FIELD_N.
    pub delta_h_deg: Vec<f32>,
    /// Chroma scale factor per lattice cell.
    pub sat_scale: Vec<f32>,
}

/// Solver statistics.
#[derive(Clone, Debug)]
pub struct FitStats {
    pub patches_used: usize,
    pub patches_clipped: usize,
    /// RMS CIEDE2000 of model prediction vs measured over unclipped sweep patches.
    pub fit_rms_de: f32,
    /// RMS relative difference between per-render tonescale fits over the
    /// overlap x-range (only present when ≥ 2 renders were supplied).
    /// Values > 0.05 indicate that the Exposure2012-linearity assumption
    /// is breaking down.
    pub overlap_rms_rel: Option<f32>,
}

// ── JSON round-trip ───────────────────────────────────────────────────────────

impl AcrModel {
    /// Serialise to a compact JSON string.
    pub fn to_json(&self) -> String {
        let knots = self
            .tonescale
            .knots_log2
            .iter()
            .map(|x| format!("{x:.6}"))
            .collect::<Vec<_>>()
            .join(",");
        let vals = self
            .tonescale
            .values
            .iter()
            .map(|x| format!("{x:.6}"))
            .collect::<Vec<_>>()
            .join(",");
        let dh = self
            .field
            .delta_h_deg
            .iter()
            .map(|x| format!("{x:.4}"))
            .collect::<Vec<_>>()
            .join(",");
        let ss = self
            .field
            .sat_scale
            .iter()
            .map(|x| format!("{x:.4}"))
            .collect::<Vec<_>>()
            .join(",");
        let overlap_field = match self.stats.overlap_rms_rel {
            Some(v) => format!(",\"overlap_rms_rel\":{v:.6}"),
            None => String::new(),
        };
        format!(
            "{{\
             \"tonescale\":{{\"knots_log2\":[{knots}],\"values\":[{vals}]}},\
             \"field\":{{\"hue_bins\":{hb},\"chroma_bins\":{cb},\"luma_bins\":{lb},\
             \"delta_h_deg\":[{dh}],\"sat_scale\":[{ss}]}},\
             \"stats\":{{\"patches_used\":{pu},\"patches_clipped\":{pc},\
             \"fit_rms_de\":{rms:.4}{overlap_field}}}\
             }}",
            hb = self.field.hue_bins,
            cb = self.field.chroma_bins,
            lb = self.field.luma_bins,
            pu = self.stats.patches_used,
            pc = self.stats.patches_clipped,
            rms = self.stats.fit_rms_de,
        )
    }

    /// Deserialise from a JSON string produced by `to_json()` or the
    /// `maple-cli fit-acr` command. Unknown top-level keys (e.g. `_meta`) are
    /// silently ignored. Returns an error string on parse failure.
    ///
    /// Hand-parsed — no serde dep (keeps the always-compiled crate serde-free).
    pub fn from_json(json: &str) -> Result<Self, String> {
        // The needle-based extraction below assumes compact `"key":value`
        // JSON. Normalise first: strip whitespace outside string literals so
        // any formatting (compact, prettier, hand-edited) parses identically.
        let json: String = {
            let mut out = String::with_capacity(json.len());
            let mut in_str = false;
            let mut escaped = false;
            for c in json.chars() {
                if in_str {
                    out.push(c);
                    if escaped {
                        escaped = false;
                    } else if c == '\\' {
                        escaped = true;
                    } else if c == '"' {
                        in_str = false;
                    }
                } else if c == '"' {
                    in_str = true;
                    out.push(c);
                } else if !c.is_whitespace() {
                    out.push(c);
                }
            }
            out
        };
        let json = json.as_str();
        // Extract floats from a `[f1,f2,...]` array literal.
        fn parse_float_array(json: &str, key: &str) -> Result<Vec<f32>, String> {
            let needle = format!("\"{key}\":[");
            let pos = json
                .find(&needle)
                .ok_or_else(|| format!("key {key} not found"))?;
            let start = pos + needle.len();
            let end = json[start..]
                .find(']')
                .ok_or_else(|| format!("closing ] for {key}"))?;
            json[start..start + end]
                .split(',')
                .filter(|s| !s.trim().is_empty())
                .map(|s| {
                    s.trim()
                        .parse::<f32>()
                        .map_err(|e| format!("float parse error in {key}: {e}"))
                })
                .collect()
        }
        fn parse_usize(json: &str, key: &str) -> Result<usize, String> {
            let needle = format!("\"{key}\":");
            let pos = json
                .find(&needle)
                .ok_or_else(|| format!("key {key} not found"))?;
            let rest = json[pos + needle.len()..].trim_start();
            let end = rest
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(rest.len());
            rest[..end]
                .parse()
                .map_err(|e| format!("usize parse {key}: {e}"))
        }
        fn parse_f32(json: &str, key: &str) -> Result<f32, String> {
            let needle = format!("\"{key}\":");
            let pos = json
                .find(&needle)
                .ok_or_else(|| format!("key {key} not found"))?;
            let rest = json[pos + needle.len()..].trim_start();
            let end = rest
                .find(|c: char| c == ',' || c == '}')
                .unwrap_or(rest.len());
            rest[..end]
                .parse()
                .map_err(|e| format!("f32 parse {key}: {e}"))
        }

        let knots_log2 = parse_float_array(json, "knots_log2")?;
        let values = parse_float_array(json, "values")?;
        let hue_bins = parse_usize(json, "hue_bins")?;
        let chroma_bins = parse_usize(json, "chroma_bins")?;
        let luma_bins = parse_usize(json, "luma_bins")?;
        let delta_h_deg = parse_float_array(json, "delta_h_deg")?;
        let sat_scale = parse_float_array(json, "sat_scale")?;
        let patches_used = parse_usize(json, "patches_used")?;
        let patches_clipped = parse_usize(json, "patches_clipped")?;
        let fit_rms_de = parse_f32(json, "fit_rms_de")?;

        // Optional field: absent entirely → None. Present but malformed → a
        // parse error propagates (matches this function's "Returns an error
        // string on parse failure" contract; silently coercing a malformed
        // value to `None` would mask real corruption).
        let overlap_rms_rel = if json.contains("\"overlap_rms_rel\":") {
            Some(parse_f32(json, "overlap_rms_rel")?)
        } else {
            None
        };

        let expected_field = hue_bins * chroma_bins * luma_bins;
        if delta_h_deg.len() != expected_field {
            return Err(format!(
                "delta_h_deg length {} ≠ expected {}",
                delta_h_deg.len(),
                expected_field
            ));
        }
        if sat_scale.len() != expected_field {
            return Err(format!(
                "sat_scale length {} ≠ expected {}",
                sat_scale.len(),
                expected_field
            ));
        }

        Ok(AcrModel {
            tonescale: Tonescale { knots_log2, values },
            field: HueChromaField {
                hue_bins,
                chroma_bins,
                luma_bins,
                delta_h_deg,
                sat_scale,
            },
            stats: FitStats {
                patches_used,
                patches_clipped,
                fit_rms_de,
                overlap_rms_rel,
            },
        })
    }
}

// ── apply_model ───────────────────────────────────────────────────────────────

/// Apply the fitted ACR-match model to a scene-linear Rec.2020 pixel.
/// Returns display-linear Rec.2020. Pure and allocation-free per call.
pub fn apply_model(model: &AcrModel, scene: [f32; 3]) -> [f32; 3] {
    // Scene luminance (Rec.2020 luma coefficients from ITU-R BT.2020).
    let l_scene = 0.2627 * scene[0] + 0.6780 * scene[1] + 0.0593 * scene[2];
    if l_scene <= 0.0 {
        return [0.0, 0.0, 0.0];
    }

    // Stage 1: apply tonescale to luminance.
    let l_display = tonescale_apply(&model.tonescale, l_scene);

    // Scale RGB by T(L)/L (luminance-preserving).
    let scale = l_display / l_scene;
    let rgb_ts = [scene[0] * scale, scene[1] * scale, scene[2] * scale];

    // Stage 2: apply hue/chroma field residuals in Oklab.
    let lab = rec2020_to_oklab(rgb_ts);
    let okl = lab[0];
    let a = lab[1];
    let b = lab[2];
    let chroma = (a * a + b * b).sqrt();

    if chroma < 1e-6 {
        return rgb_ts; // neutral: field has no effect
    }

    // Hue in [0, 2π).
    let hue = b.atan2(a).rem_euclid(std::f32::consts::TAU);

    // Field lattice coordinates.
    let hue_frac = hue / std::f32::consts::TAU * (model.field.hue_bins as f32);
    let chroma_frac = (chroma / 0.30).clamp(0.0, 1.0) * (model.field.chroma_bins as f32 - 1.0);
    let luma_frac = okl.clamp(0.0, 1.0) * (model.field.luma_bins as f32 - 1.0);

    let dh = trilinear_sample(
        &model.field.delta_h_deg,
        &model.field,
        hue_frac,
        chroma_frac,
        luma_frac,
    );
    let ss = trilinear_sample(
        &model.field.sat_scale,
        &model.field,
        hue_frac,
        chroma_frac,
        luma_frac,
    );

    // Apply hue twist and chroma scale.
    let hue_new = hue + dh.to_radians();
    let chroma_new = (chroma * ss).max(0.0);
    let a_new = chroma_new * hue_new.cos();
    let b_new = chroma_new * hue_new.sin();

    oklab_to_rec2020([okl, a_new, b_new])
}

/// Trilinear interpolation into the [hue × chroma × luma] field lattice.
/// `hue_frac` wraps circularly; chroma and luma are clamped.
fn trilinear_sample(
    data: &[f32],
    field: &HueChromaField,
    hue_frac: f32,
    chroma_frac: f32,
    luma_frac: f32,
) -> f32 {
    let hb = field.hue_bins;
    let cb = field.chroma_bins;
    let lb = field.luma_bins;

    // Circular hue indices.
    let hi = hue_frac.floor() as usize % hb;
    let hi1 = (hi + 1) % hb;
    let ht = hue_frac - hue_frac.floor();

    let ci = (chroma_frac.floor() as usize).min(cb - 1);
    let ci1 = (ci + 1).min(cb - 1);
    let ct = (chroma_frac - chroma_frac.floor()).clamp(0.0, 1.0);

    let li = (luma_frac.floor() as usize).min(lb - 1);
    let li1 = (li + 1).min(lb - 1);
    let lt = (luma_frac - luma_frac.floor()).clamp(0.0, 1.0);

    let idx = |h: usize, c: usize, l: usize| l * cb * hb + c * hb + h;
    let v000 = data[idx(hi, ci, li)];
    let v100 = data[idx(hi1, ci, li)];
    let v010 = data[idx(hi, ci1, li)];
    let v110 = data[idx(hi1, ci1, li)];
    let v001 = data[idx(hi, ci, li1)];
    let v101 = data[idx(hi1, ci, li1)];
    let v011 = data[idx(hi, ci1, li1)];
    let v111 = data[idx(hi1, ci1, li1)];

    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let c00 = lerp(v000, v100, ht);
    let c10 = lerp(v010, v110, ht);
    let c01 = lerp(v001, v101, ht);
    let c11 = lerp(v011, v111, ht);
    let c0 = lerp(c00, c10, ct);
    let c1 = lerp(c01, c11, ct);
    lerp(c0, c1, lt)
}

/// Evaluate the PCHIP tonescale at scene-linear luminance `l`.
/// Extrapolates flat above the last knot (returns last value).
pub fn tonescale_apply(ts: &Tonescale, l: f32) -> f32 {
    let log2_l = l.max(1e-10).log2();
    let knots = &ts.knots_log2;
    let vals = &ts.values;
    let n = knots.len();
    if log2_l <= knots[0] {
        return vals[0] * (l / knots[0].exp2()).clamp(0.0, 1.0); // scale linearly below first knot
    }
    if log2_l >= knots[n - 1] {
        return vals[n - 1]; // flat extrapolation above last knot
    }
    // Binary search for bracketing interval.
    let mut lo = 0usize;
    let mut hi = n - 1;
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if knots[mid] <= log2_l {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let t = (log2_l - knots[lo]) / (knots[hi] - knots[lo]);
    // Linear interpolation (PCHIP slopes are set in the solver; here we just lerp).
    vals[lo] + t * (vals[hi] - vals[lo])
}

// ── CIEDE2000 (minimal, for test assertions) ──────────────────────────────────

/// Convert linear sRGB to CIE L*a*b* (D65 reference white).
pub fn srgb_linear_to_lab(rgb: [f32; 3]) -> [f32; 3] {
    // sRGB → XYZ D65. ITU-R BT.709 / IEC 61966-2-1 primaries.
    let x = 0.4124564 * rgb[0] + 0.3575761 * rgb[1] + 0.1804375 * rgb[2];
    let y = 0.2126729 * rgb[0] + 0.7151522 * rgb[1] + 0.0721750 * rgb[2];
    let z = 0.0193339 * rgb[0] + 0.1191920 * rgb[1] + 0.9503041 * rgb[2];
    // Normalise by D65 white.
    let xn = x / 0.95047;
    let yn = y / 1.00000;
    let zn = z / 1.08883;
    let f = |t: f32| {
        if t > 0.008856 {
            t.cbrt()
        } else {
            7.787 * t + 16.0 / 116.0
        }
    };
    let l = 116.0 * f(yn) - 16.0;
    let a = 500.0 * (f(xn) - f(yn));
    let b = 200.0 * (f(yn) - f(zn));
    [l, a, b]
}

/// CIEDE2000 colour difference between two CIE Lab colours.
/// Reference: Sharma, Wu, Dalal (2005).
pub fn ciede2000(lab1: [f32; 3], lab2: [f32; 3]) -> f32 {
    use std::f32::consts::PI;
    let (l1, a1, b1) = (lab1[0], lab1[1], lab1[2]);
    let (l2, a2, b2) = (lab2[0], lab2[1], lab2[2]);

    let c1 = (a1 * a1 + b1 * b1).sqrt();
    let c2 = (a2 * a2 + b2 * b2).sqrt();
    let avg_c = (c1 + c2) / 2.0;
    let c7 = avg_c.powi(7);
    let g = 0.5 * (1.0 - (c7 / (c7 + 25.0f32.powi(7))).sqrt());
    let a1p = a1 * (1.0 + g);
    let a2p = a2 * (1.0 + g);
    let c1p = (a1p * a1p + b1 * b1).sqrt();
    let c2p = (a2p * a2p + b2 * b2).sqrt();

    let h1p = if b1 == 0.0 && a1p == 0.0 {
        0.0
    } else {
        b1.atan2(a1p).rem_euclid(2.0 * PI).to_degrees()
    };
    let h2p = if b2 == 0.0 && a2p == 0.0 {
        0.0
    } else {
        b2.atan2(a2p).rem_euclid(2.0 * PI).to_degrees()
    };

    let dl = l2 - l1;
    let dc = c2p - c1p;
    let dh_p = if c1p * c2p == 0.0 {
        0.0
    } else if (h2p - h1p).abs() <= 180.0 {
        h2p - h1p
    } else if h2p - h1p > 180.0 {
        h2p - h1p - 360.0
    } else {
        h2p - h1p + 360.0
    };
    let dh = 2.0 * (c1p * c2p).sqrt() * (dh_p / 2.0).to_radians().sin();

    let avg_lp = (l1 + l2) / 2.0;
    let avg_cp = (c1p + c2p) / 2.0;
    let avg_hp = if c1p * c2p == 0.0 {
        h1p + h2p
    } else if (h1p - h2p).abs() <= 180.0 {
        (h1p + h2p) / 2.0
    } else if h1p + h2p < 360.0 {
        (h1p + h2p + 360.0) / 2.0
    } else {
        (h1p + h2p - 360.0) / 2.0
    };

    let t = 1.0 - 0.17 * ((avg_hp - 30.0).to_radians()).cos()
        + 0.24 * (2.0 * avg_hp.to_radians()).cos()
        + 0.32 * (3.0 * avg_hp.to_radians() + 6.0f32.to_radians()).cos()
        - 0.20 * (4.0 * avg_hp.to_radians() - 63.0f32.to_radians()).cos();

    let sl = 1.0 + 0.015 * (avg_lp - 50.0).powi(2) / (20.0 + (avg_lp - 50.0).powi(2)).sqrt();
    let sc = 1.0 + 0.045 * avg_cp;
    let sh = 1.0 + 0.015 * avg_cp * t;
    let cp7 = avg_cp.powi(7);
    let rc = 2.0 * (cp7 / (cp7 + 25.0f32.powi(7))).sqrt();
    let d_theta = 30.0 * (-((avg_hp - 275.0) / 25.0).powi(2)).exp();
    let rt = -(rc * (2.0 * d_theta.to_radians()).sin());

    let lterm = dl / sl;
    let cterm = dc / sc;
    let hterm = dh / sh;
    (lterm * lterm + cterm * cterm + hterm * hterm + rt * cterm * hterm).sqrt()
}
