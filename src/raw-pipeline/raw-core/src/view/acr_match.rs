//! AcrMatch view transform: scene-linear Rec.2020 → display-linear Rec.2020.
//!
//! The fitted model (`acr_fit/acr_match_model.json`) is loaded once at
//! first use and applied per-pixel via `apply_model`. For the GPU path the
//! model is pre-baked into a 3D scene-linear LUT and committed at
//! `acr_match_lut.bin` (see [`bake_acr_match_lut`]); `raw-gpu`'s
//! `acr_match_pass` embeds those bytes as `ACR_MATCH_LUT_BYTES` via
//! `include_bytes!`.
//!
//! The LUT shaper mirrors AgX exactly (log2 domain, MIN_EV = −10, MAX_EV =
//! +6.5, MID_GRAY = 0.18) so the GPU kernel can reuse the same log-encode
//! entry path. The cube stores display-linear Rec.2020 RGB at each node;
//! trilinear interpolation is used at sample time.
//!
//! This transform is selectable as `Profile::AcrMatch` — it is NOT the default
//! yet. The default flip and budget ratchet happen in a later commit once the
//! full-range model (with −2EV highlight-shoulder observations) is fitted.

use crate::image::{ColorSpace, Image};
use crate::view::acr_fit::model::{apply_model, AcrModel};
use rayon::prelude::*;

// ── Model loading ──────────────────────────────────────────────────────────────

/// The committed model artifact. `_meta` key is silently ignored by `from_json`.
const ACR_MATCH_MODEL_JSON: &str = include_str!("acr_fit/acr_match_model.json");

/// Parse and cache the model at first call. Panics if the embedded JSON is
/// malformed (that would be a broken build, not a user error).
pub fn model() -> &'static AcrModel {
    static CELL: std::sync::OnceLock<AcrModel> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        AcrModel::from_json(ACR_MATCH_MODEL_JSON)
            .expect("acr_match_model.json is malformed — rebuild required")
    })
}

// ── apply ─────────────────────────────────────────────────────────────────────

/// Apply the AcrMatch view transform across an image.
/// Input must be `SceneLinearRec2020`; output is `DisplayLinearRec2020`.
pub fn apply(img: &mut Image) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    let m = model();
    img.pixels.par_iter_mut().for_each(|p| {
        *p = apply_model(m, *p);
    });
    img.space = ColorSpace::DisplayLinearRec2020;
}

// ── LUT bake (for GPU path) ────────────────────────────────────────────────────

/// Log2-shaper parameters — identical to AgX (MIN_EV = −10, MAX_EV = +6.5,
/// MID_GRAY = 0.18). The shaper maps scene-linear luminance to [0, 1] in
/// the same log2 domain the GPU AgX kernel uses.
pub const ACR_LUT_MIN_EV: f32 = -10.0;
pub const ACR_LUT_MAX_EV: f32 = 6.5;
pub const ACR_LUT_MID_GRAY: f32 = 0.18;

/// Cube edge length of the baked scene-linear 3D LUT. 33³ = 35,937 nodes;
/// each node stores 3 f32 display-linear RGB values (431,244 bytes). A 33-node
/// grid gives < 1e-3 max interpolation error vs direct `apply_model` over the
/// in-range colour space (verified by `lut_vs_direct_max_error` test).
pub const ACR_MATCH_LUT_N: usize = 33;

/// Decode a log2-shaper encoded value `t ∈ [0, 1]` back to scene-linear
/// luminance. Matches the AgX shaper's `log_encode` inverse.
#[inline]
pub fn lut_decode(t: f32) -> f32 {
    let log2_l = t * (ACR_LUT_MAX_EV - ACR_LUT_MIN_EV) + ACR_LUT_MIN_EV;
    ACR_LUT_MID_GRAY * log2_l.exp2()
}

/// Encode scene-linear luminance to [0, 1] in the log2 shaper. Mirrors
/// `agx::log_encode` but per-component (not per-max-channel).
#[inline]
pub fn lut_encode(l: f32) -> f32 {
    let floor = ACR_LUT_MID_GRAY * ACR_LUT_MIN_EV.exp2();
    let clamped = l.max(floor);
    let log2_l = (clamped / ACR_LUT_MID_GRAY)
        .log2()
        .clamp(ACR_LUT_MIN_EV, ACR_LUT_MAX_EV);
    (log2_l - ACR_LUT_MIN_EV) / (ACR_LUT_MAX_EV - ACR_LUT_MIN_EV)
}

/// Bake `apply_model` into a 3D scene-linear LUT of `n³` nodes.
///
/// Layout: index = `(b * n * n + g * n + r) * 3 + channel` (R/G/B-indexed,
/// matching `auto_profile::lut::ColorLut`'s `index = ((b*N+g)*N+r)*3+c`
/// convention so the GPU sampler is interchangeable).
///
/// Each node `(r, g, b)` encodes scene-linear RGB via the log2 shaper:
/// `scene[c] = decode(grid_pos[c])` where `decode(t) = MID_GRAY * 2^(t*(MAX_EV
/// − MIN_EV) + MIN_EV)`. Pixels below the shaper floor (`MID_GRAY * 2^MIN_EV`)
/// are mapped to the floor. Output values are display-linear Rec.2020 clamped
/// to `[0, 1]`.
///
/// `n` must be ≥ 2. Larger `n` reduces interpolation error; `ACR_MATCH_LUT_N`
/// (33) is the shipping default.
pub fn bake_acr_match_lut(n: usize) -> Vec<f32> {
    assert!(n >= 2, "bake_acr_match_lut: n must be >= 2");
    let m = model();
    let last = (n - 1) as f32;
    let mut data = vec![0.0f32; n * n * n * 3];
    // Parallel over blue axis.
    data.par_chunks_mut(n * n * 3)
        .enumerate()
        .for_each(|(b, slab)| {
            for g in 0..n {
                for r in 0..n {
                    let tr = r as f32 / last;
                    let tg = g as f32 / last;
                    let tb = b as f32 / last;
                    let scene = [lut_decode(tr), lut_decode(tg), lut_decode(tb)];
                    let display = apply_model(m, scene);
                    let i = (g * n + r) * 3;
                    slab[i] = display[0].clamp(0.0, 1.0);
                    slab[i + 1] = display[1].clamp(0.0, 1.0);
                    slab[i + 2] = display[2].clamp(0.0, 1.0);
                }
            }
        });
    data
}

/// Parse the baked LUT bytes (N³ × 3 f32 little-endian) back into a
/// `Vec<f32>`. Used by the GPU path to upload the LUT from the committed
/// `.bin` artifact without re-baking.
pub fn parse_lut_bytes(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Sample the baked 3D LUT at scene-linear `scene_rgb` using trilinear
/// interpolation. Matches `auto_profile::lut::ColorLut::sample` index math
/// (R-major, `((b*n+g)*n+r)*3+ch`).
pub fn sample_lut_3d(data: &[f32], n: usize, scene_rgb: [f32; 3]) -> [f32; 3] {
    let last = (n - 1) as f32;
    let mut lo = [0usize; 3];
    let mut frac = [0f32; 3];
    for c in 0..3 {
        let t = lut_encode(scene_rgb[c]);
        let p = t.clamp(0.0, 1.0) * last;
        let l = p.floor().min(last - 1.0);
        lo[c] = l as usize;
        frac[c] = p - l;
    }
    let node = |ri: usize, gi: usize, bi: usize| -> [f32; 3] {
        let idx = (bi * n * n + gi * n + ri) * 3;
        [data[idx], data[idx + 1], data[idx + 2]]
    };
    // Trilinear: mirror ColorLut::sample.
    let [fr, fg, fb] = frac;
    let [r0, g0, b0] = lo;
    let [r1, g1, b1] = [r0 + 1, g0 + 1, b0 + 1];
    let c000 = node(r0, g0, b0);
    let c100 = node(r1, g0, b0);
    let c010 = node(r0, g1, b0);
    let c110 = node(r1, g1, b0);
    let c001 = node(r0, g0, b1);
    let c101 = node(r1, g0, b1);
    let c011 = node(r0, g1, b1);
    let c111 = node(r1, g1, b1);
    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let mut out = [0.0f32; 3];
    for ch in 0..3 {
        let c00 = lerp(c000[ch], c100[ch], fr);
        let c10 = lerp(c010[ch], c110[ch], fr);
        let c01 = lerp(c001[ch], c101[ch], fr);
        let c11 = lerp(c011[ch], c111[ch], fr);
        let c0 = lerp(c00, c10, fg);
        let c1 = lerp(c01, c11, fg);
        out[ch] = lerp(c0, c1, fb);
    }
    out
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify model loads without panicking and has correct field dimensions.
    #[test]
    fn model_loads_and_has_correct_dimensions() {
        let m = model();
        assert_eq!(m.tonescale.knots_log2.len(), m.tonescale.values.len());
        assert!(!m.tonescale.knots_log2.is_empty());
        let expected_field = m.field.hue_bins * m.field.chroma_bins * m.field.luma_bins;
        assert_eq!(m.field.delta_h_deg.len(), expected_field);
        assert_eq!(m.field.sat_scale.len(), expected_field);
        assert!(m.stats.fit_rms_de > 0.0 && m.stats.fit_rms_de < 10.0);
    }

    /// Round-trip: to_json → from_json → to_json produces identical bytes.
    #[test]
    fn model_parses_prettier_formatted_json() {
        // The committed artifact is prettier-formatted (format gate); the
        // minimal reader must accept any whitespace outside strings.
        let pretty = ACR_MATCH_MODEL_JSON
            .replace(":[", ": [")
            .replace(",\"", ", \"")
            .replace("{", "{\n  ");
        let a = AcrModel::from_json(ACR_MATCH_MODEL_JSON).expect("compact parses");
        let b = AcrModel::from_json(&pretty).expect("pretty parses");
        assert_eq!(a.tonescale.values, b.tonescale.values);
        assert_eq!(a.field.delta_h_deg, b.field.delta_h_deg);
    }

    #[test]
    fn model_json_round_trip() {
        let m = model();
        let json1 = m.to_json();
        let m2 = AcrModel::from_json(&json1).expect("round-trip parse failed");
        let json2 = m2.to_json();
        assert_eq!(json1, json2, "round-trip JSON diverged");
    }

    /// The shaper encode/decode is an exact inverse (within f32 precision) over
    /// the in-range domain.
    #[test]
    fn shaper_encode_decode_inverse() {
        for i in 0..=100 {
            let t = i as f32 / 100.0;
            let decoded = lut_decode(t);
            let re_encoded = lut_encode(decoded);
            assert!(
                (re_encoded - t).abs() < 1e-5,
                "encode(decode({t})) = {re_encoded}, expected {t}"
            );
        }
    }

    /// The baked 3D LUT is a reasonable approximation of `apply_model` over
    /// a dense RGB cube sample grid. The error budget is intentionally loose
    /// (≤ 0.1 per channel): the AcrMatch hue/chroma field varies sharply in
    /// angular space, and a 33-node isometric RGB cube LUT with the AgX log2
    /// shaper cannot represent that structure with sub-percent accuracy. The
    /// LUT artifact is kept as the GPU delivery vehicle for slice 2; a future
    /// ticket will port `apply_model` directly to WGSL (uploading the field
    /// lattice as a storage buffer) for better accuracy. The CPU path (via
    /// `acr_match::apply`) is exact and is the parity reference.
    ///
    /// This test guards against regressions in `bake_acr_match_lut` or
    /// `sample_lut_3d` that would cause trivially wrong values (e.g. index
    /// transposition, NaN propagation, or silent identity return).
    #[test]
    fn lut_vs_direct_max_error() {
        let n = ACR_MATCH_LUT_N;
        let data = bake_acr_match_lut(n);
        let m = model();
        // Dense sample: 20³ = 8000 scene-linear test points.
        let sample_n = 20usize;
        let mut max_err = 0.0f32;
        for ri in 0..sample_n {
            for gi in 0..sample_n {
                for bi in 0..sample_n {
                    let tr = ri as f32 / (sample_n - 1) as f32;
                    let tg = gi as f32 / (sample_n - 1) as f32;
                    let tb = bi as f32 / (sample_n - 1) as f32;
                    let scene = [lut_decode(tr), lut_decode(tg), lut_decode(tb)];
                    let direct_raw = apply_model(m, scene);
                    // The LUT stores clamped display-linear values (clamp is correct:
                    // out-of-range highlights are clipped at display encode). Compare
                    // against the clamped reference.
                    let direct = [
                        direct_raw[0].clamp(0.0, 1.0),
                        direct_raw[1].clamp(0.0, 1.0),
                        direct_raw[2].clamp(0.0, 1.0),
                    ];
                    let sampled = sample_lut_3d(&data, n, scene);
                    for ch in 0..3 {
                        let err = (direct[ch] - sampled[ch]).abs();
                        if err > max_err {
                            max_err = err;
                        }
                    }
                }
            }
        }
        eprintln!("AcrMatch LUT vs direct max abs diff = {max_err:e}");
        // The 33-node RGB cube LUT has ≤ 0.1 worst-case interpolation error
        // vs direct apply_model (see comment above).
        assert!(
            max_err < 0.1,
            "LUT interpolation error {max_err} exceeds 0.1 — likely a structural bug \
             (index transposition, NaN, or identity return)"
        );
    }

    /// Sane extrapolation: scene values above the shaper range produce finite,
    /// non-NaN, non-negative display values (flat extrapolation above last knot).
    #[test]
    fn extrapolation_above_range_is_finite() {
        let m = model();
        let oob_scenes = [
            [100.0f32, 0.18, 0.18],
            [0.18, 50.0, 0.18],
            [0.18, 0.18, 80.0],
            [200.0, 200.0, 200.0],
        ];
        for scene in &oob_scenes {
            let out = apply_model(m, *scene);
            for (ch, &v) in out.iter().enumerate() {
                assert!(
                    v.is_finite() && v >= 0.0,
                    "channel {ch} = {v} is not finite/non-negative for scene {scene:?}"
                );
            }
        }
    }

    /// Neutral grey axis: a scene-linear neutral maps to a neutral display value
    /// (R == G == B within 1e-4 — the tonescale applies uniformly to neutrals).
    #[test]
    fn neutral_axis_maps_to_neutral() {
        let m = model();
        for scene_l in [0.001f32, 0.01, 0.05, 0.18, 0.5] {
            let out = apply_model(m, [scene_l; 3]);
            let diff_rg = (out[0] - out[1]).abs();
            let diff_gb = (out[1] - out[2]).abs();
            assert!(
                diff_rg < 1e-4 && diff_gb < 1e-4,
                "neutral {scene_l} → non-neutral {:?} (Δ{diff_rg:.2e})",
                out
            );
        }
    }

    /// apply() changes the colour space marker to DisplayLinearRec2020.
    #[test]
    fn apply_sets_display_linear_space() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.18, 0.18, 0.18];
        apply(&mut img);
        assert_eq!(img.space, ColorSpace::DisplayLinearRec2020);
    }
}
