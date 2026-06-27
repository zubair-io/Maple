use crate::{
    color::{
        matrices::{M_REC2020_TO_SRGB, M_SRGB_TO_P3},
        oklab::{oklab_to_srgb_linear, srgb_linear_to_oklab},
        oklab_gamut::compress_to_unit_cube_oklab,
    },
    image::{ColorSpace, Image},
    view::dither::bayer_offset_lsb,
};
use rayon::prelude::*;

/// Which display primaries the `display_encode` view-tail converts to.
///
/// The OETF is identical for both variants (IEC 61966-2-1 / 2.4-gamma —
/// the same `srgb_gamma_encode` call follows in both cases). Only the
/// primaries matrix changes.
///
/// - `Srgb` — the current (pre-#1337) behavior: Rec.2020 → sRGB primaries.
///   `0` in the C FFI / WGSL uniform so legacy callers that never set the
///   field default to this — bit-identical to the pre-#1337 pipeline.
/// - `P3` — Rec.2020 → Display P3 primaries (SMPTE RP 431-2, D65 white).
///   When the `CAMetalLayer` is tagged Display P3 (as it is on Apple), the
///   bytes produced by this path are geometrically correct for that
///   colorspace; `Srgb` bytes were re-interpreted through P3 primaries,
///   giving an unintended saturation bump. Ticket #1337 plumbs the choice;
///   the user-facing toggle is #1338.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum TargetPrimaries {
    /// Rec.2020 → sRGB primaries (default — legacy-compatible, zero in FFI).
    #[default]
    Srgb,
    /// Rec.2020 → Display P3 primaries (SMPTE RP 431-2, D65).
    P3,
}

impl TargetPrimaries {
    /// Construct from a C FFI / WGSL `u32` value: `0` → `Srgb`, `1` → `P3`,
    /// any other value → `Srgb` (defensive default — matches `Look::from`
    /// and `WbMethod` conventions throughout this crate).
    pub fn from_u32(v: u32) -> Self {
        match v {
            1 => Self::P3,
            _ => Self::Srgb,
        }
    }
}

/// Rec.2020 → display-primary linear via compile-time 3×3 matrices and
/// **hue-preserving Oklab gamut compression** for any out-of-gamut triple.
///
/// `target` selects the output primaries:
/// - [`TargetPrimaries::Srgb`] — the existing `M_REC2020_TO_SRGB` (unchanged).
/// - [`TargetPrimaries::P3`]  — Display P3 primaries (ticket #1337).
///
/// ## Pipeline order
///
/// **sRGB path (unchanged):**
///   1. Rec.2020 → linear sRGB (`M_REC2020_TO_SRGB`)
///   2. Oklab gamut compress in linear sRGB (valid — helpers are sRGB-defined)
///
/// **P3 path (corrected per #1337 review):**
///   1. Rec.2020 → linear sRGB (`M_REC2020_TO_SRGB`)
///   2. Oklab gamut compress in linear sRGB (same helpers — valid here)
///   3. linear sRGB → Display P3 (`M_SRGB_TO_P3`) ← primary swap is the *last* step
///
/// The gamut compression **must** happen in linear sRGB because the Oklab
/// `srgb_linear_to_oklab` / `oklab_to_srgb_linear` helpers are calibrated
/// against the sRGB-primary LMS cone matrix. Feeding linear P3 through them
/// without this reorder gives wrong hue/chroma — the LMS matrix assumes sRGB
/// primaries. By compressing in sRGB first then rotating to P3, both paths use
/// the same validated Oklab round-trip, and the P3 primary swap is a simple
/// matrix multiply with no gamut semantics.
///
/// ## Byte-identity contracts
///
/// **sRGB path:** when the post-matrix triple is already in `[0, 1]^3`,
/// [`compress_to_unit_cube_oklab`] returns it **unmodified** — bit-for-bit
/// identical to the pre-#438 pipeline.
///
/// **P3 path default (legacy callers):** when `target_primaries = 0` (the FFI
/// zero-default), the sRGB path runs — no change for any existing caller.
pub fn rec2020_to_display(img: &mut Image, target: TargetPrimaries) {
    img.assert_space(ColorSpace::DisplayLinearRec2020);
    img.pixels.par_iter_mut().for_each(|p| {
        // Step 1: Rec.2020 → linear sRGB (valid working space for Oklab).
        let srgb = M_REC2020_TO_SRGB.mul_vec(*p);
        // Step 2: Oklab gamut compress in linear sRGB (helpers are sRGB-defined).
        let compressed =
            compress_to_unit_cube_oklab(srgb, srgb_linear_to_oklab, oklab_to_srgb_linear);
        // Step 3 (P3 only): rotate compressed sRGB primaries → P3 primaries.
        *p = match target {
            TargetPrimaries::Srgb => compressed,
            TargetPrimaries::P3 => M_SRGB_TO_P3.mul_vec(compressed),
        };
    });
    // Tag the buffer with the primaries it actually carries. Both
    // `DisplayLinearSrgb` and `DisplayLinearP3` use the same OETF
    // (`srgb_gamma_encode`), so the gamma stage accepts both via
    // `ColorSpace::is_display_linear()` rather than a single-variant assert.
    img.space = match target {
        TargetPrimaries::Srgb => ColorSpace::DisplayLinearSrgb,
        TargetPrimaries::P3 => ColorSpace::DisplayLinearP3,
    };
}

/// Rec.2020 → sRGB linear: the legacy single-target entry. A thin wrapper
/// around [`rec2020_to_display`] with `TargetPrimaries::Srgb` for
/// backward-compatibility with existing callers that have not been updated
/// to pass a `TargetPrimaries` yet.
///
/// **ABI note:** this function's signature is unchanged from pre-#1337 —
/// do not add parameters here; they belong in [`rec2020_to_display`].
pub fn rec2020_to_srgb(img: &mut Image) {
    rec2020_to_display(img, TargetPrimaries::Srgb);
}

/// Piecewise sRGB gamma encode. Per IEC 61966-2-1.
pub fn srgb_gamma(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.003_130_8 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

// Display-space Levels look-layer was previously applied here (black=66,
// white=227, gamma=0.65) to compensate for Blender 4.x AgX's mid-gray lift
// when measured against the reference renderer. Maple AgX (v6) is now
// calibrated directly against the reference renderer — its polynomial places
// mid-gray near 0.18 display-linear, matching the reference renderer's tone
// placement. The Levels layer is therefore no longer
// needed; leaving it in compounds the correction and crushes midtones.

/// In-place sRGB gamma encode in f32 space.
///
/// Pre-#519 this lived inside `quantize_u8` — gamma + dither + u8 cast
/// all in one pass. It was split out so the (then-live) empirical Look
/// LUT could run in f32 sRGB-encoded space between the gamma encode and
/// the dither+quantize step. #443 retired the static Look LUT (Auto
/// Profile owns view-shaping now), so nothing runs between the two
/// halves any more — but keeping them split is harmless and lets a
/// caller dither separately.
///
/// After this call the buffer is sRGB-gamma-encoded f32 in `[0, 1]`,
/// ready for `dither_and_quantize`.
pub fn srgb_gamma_encode(img: &mut Image) {
    // Both `DisplayLinearSrgb` and `DisplayLinearP3` use IEC 61966-2-1 / 2.4-gamma.
    debug_assert!(
        img.space.is_display_linear(),
        "srgb_gamma_encode: expected display-linear space (Srgb or P3), got {:?}",
        img.space
    );
    img.pixels.par_iter_mut().for_each(|p| {
        p[0] = srgb_gamma(p[0]);
        p[1] = srgb_gamma(p[1]);
        p[2] = srgb_gamma(p[2]);
    });
    img.space = ColorSpace::DisplayEncodedSrgb;
}

/// 8×8 Bayer-dithered quantise from sRGB-encoded f32 → packed `u8` RGB.
///
/// Input must be sRGB-gamma-encoded (via [`srgb_gamma_encode`]) and in
/// `[0, 1]`. Returns a flat row-major `Vec<u8>` of length `3 * w * h`.
///
/// Dithering (#441): adds an 8×8 Bayer-matrix `[-0.5, +0.5)` LSB
/// offset to `v * 255` before the round. The offset is positional —
/// `dither::bayer_offset_lsb((i % w) as u32, (i / w) as u32)` — so
/// the same input image always produces the same output (no
/// randomness). The mean offset across the 8×8 tile is exactly 0, so
/// flat-colour regions stay on their u8 plateau ±1 LSB while smooth
/// gradients pick up enough sub-LSB variance that the eye reads the
/// quantization error as noise instead of contour bands.
pub fn dither_and_quantize(img: &mut Image) -> Vec<u8> {
    img.assert_space(ColorSpace::DisplayEncodedSrgb);
    let w = img.width as usize;
    let mut out = vec![0u8; img.pixels.len() * 3];
    out.par_chunks_mut(3)
        .zip(img.pixels.par_iter())
        .enumerate()
        .for_each(|(i, (dst, p))| {
            // Recover (x, y) from the linear iteration index. `w` is
            // the source-image stride; row-major layout means
            // `i = y * w + x`. The same offset is applied to all three
            // channels at a pixel, so a neutral input stays neutral
            // after dithering (no chroma noise).
            let x = (i % w) as u32;
            let y = (i / w) as u32;
            let off = bayer_offset_lsb(x, y);
            for (j, &c) in p.iter().enumerate() {
                dst[j] = (c * 255.0 + off + 0.5).clamp(0.0, 255.0) as u8;
            }
        });
    out
}

/// Final encode: display-linear sRGB → u8 RGB via piecewise gamma +
/// Bayer-dithered quantize. Returns a flat row-major `Vec<u8>` of
/// length 3 * w * h.
///
/// Thin wrapper over [`srgb_gamma_encode`] + [`dither_and_quantize`].
/// Pre-#519 this was the single combined pass, then it was split so the
/// (then-live) Look LUT could run between the halves; #443 retired the
/// static Look LUT, so the wrapper now just chains gamma + dither with
/// nothing in between. Callers that need the steps separately (e.g. the
/// render path) call the two halves directly.
pub fn quantize_u8(img: &mut Image) -> Vec<u8> {
    srgb_gamma_encode(img);
    dither_and_quantize(img)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gamma_zero_maps_to_zero() {
        assert!((srgb_gamma(0.0) - 0.0).abs() < 1e-6);
    }

    #[test]
    fn gamma_one_maps_to_one() {
        assert!((srgb_gamma(1.0) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn gamma_below_threshold_is_linear_times_12_92() {
        let x = 0.001;
        let expected = x * 12.92;
        assert!((srgb_gamma(x) - expected).abs() < 1e-6);
    }

    #[test]
    fn rec2020_white_maps_to_srgb_white() {
        let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
        img.pixels[0] = [1.0, 1.0, 1.0];
        rec2020_to_srgb(&mut img);
        for &c in &img.pixels[0] {
            assert!((c - 1.0).abs() < 1e-2);
        }
    }

    #[test]
    fn in_gamut_input_passes_through_byte_identical() {
        // #438 contract: when the post-matrix triple already fits in
        // [0, 1]^3, the gamut compression must be a no-op. The encode
        // path's only behavioural change is on out-of-gamut input.
        //
        // We construct a Rec.2020 input whose post-matrix sRGB triple is
        // strictly in-gamut, run it through `rec2020_to_srgb`, then
        // compute the pure-matrix expected value and assert bit-equality.
        let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
        let inputs = [
            [0.18f32, 0.18, 0.18],
            [0.5, 0.5, 0.5],
            [0.4, 0.3, 0.2],
            [0.05, 0.05, 0.05],
        ];
        for input in inputs {
            img.pixels[0] = input;
            img.space = ColorSpace::DisplayLinearRec2020;
            let expected = M_REC2020_TO_SRGB.mul_vec(input);
            // Pre-condition: this input must actually be in-gamut post-
            // matrix, otherwise the test is asserting on a no-op branch
            // we never enter.
            for &c in &expected {
                assert!(
                    c >= 0.0 && c <= 1.0,
                    "test setup: input {:?} maps post-matrix to {:?} which is NOT in [0,1]",
                    input,
                    expected
                );
            }
            rec2020_to_srgb(&mut img);
            let got = img.pixels[0];
            for i in 0..3 {
                assert_eq!(
                    got[i].to_bits(),
                    expected[i].to_bits(),
                    "byte-identity broken on channel {} for input {:?}: got {} expected {}",
                    i,
                    input,
                    got[i],
                    expected[i]
                );
            }
        }
    }

    #[test]
    fn saturated_rec2020_red_preserves_hue_within_2_degrees() {
        // The flagship #438 scene: pure Rec.2020 (1, 0, 0). The matrix
        // multiply drives sRGB G and B negative; the old per-channel
        // clamp inside `srgb_gamma` would clip them to 0, leaving an
        // R=1, G=0, B=0 result that *is* sRGB red — but pure sRGB red
        // is a different hue from pure Rec.2020 red (different
        // chromaticity coordinates). The hue-preserving compressor
        // bisects chroma at constant L so the perceptual hue is
        // preserved.
        //
        // Strict gate: convert the input Rec.2020 triple to Oklab (via
        // the existing `rec2020_to_oklab`) and the post-encode sRGB-
        // linear triple to Oklab (via the new `srgb_linear_to_oklab`);
        // both sit in the same Oklab axes, so the (a, b) hue angle is
        // directly comparable. The 2° budget mirrors #471's
        // OklabChromaReduction tolerance.
        use crate::color::oklab::{rec2020_to_oklab, srgb_linear_to_oklab};
        let scene = [1.0f32, 0.0, 0.0];
        let lab_in = rec2020_to_oklab(scene);
        let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
        img.pixels[0] = scene;
        rec2020_to_srgb(&mut img);
        let srgb = img.pixels[0];
        // All channels must land in [0, 1] — no negatives, no overshoot.
        for (i, &c) in srgb.iter().enumerate() {
            assert!(
                c >= 0.0 && c <= 1.0,
                "saturated Rec.2020 red channel {} out of [0,1]: {}",
                i,
                c
            );
        }
        let lab_out = srgb_linear_to_oklab(srgb);
        let h_in = lab_in[2].atan2(lab_in[1]).to_degrees();
        let h_out = lab_out[2].atan2(lab_out[1]).to_degrees();
        let mut diff = (h_out - h_in).abs();
        if diff > 180.0 {
            diff = 360.0 - diff;
        }
        assert!(
            diff < 2.0,
            "hue drift {}° (in={}° out={}°) on saturated Rec.2020 red -> sRGB {:?}",
            diff,
            h_in,
            h_out,
            srgb
        );
        // Red must still dominate.
        assert!(
            srgb[0] > srgb[1] && srgb[0] > srgb[2],
            "red dominance lost: {:?}",
            srgb
        );
    }

    /// #1621 end-to-end: the user's actual "push the color" scenario through
    /// the COMPOSED view tail — AgX (Rec.2020 gamut compress) THEN
    /// `rec2020_to_srgb` (sRGB gamut compress). A scene-linear ramp of
    /// increasing green saturation (foliage) must produce output chroma that
    /// is monotonic non-decreasing and spans a real range (the old hard
    /// clip-to-hull flattened the saturated half into a posterized plateau).
    #[test]
    fn full_view_tail_saturated_green_ramp_no_collapse() {
        use crate::color::oklab::srgb_linear_to_oklab;
        const N: usize = 128;
        let mut chromas = Vec::with_capacity(N);
        for i in 0..N {
            let s = 0.95 * (i as f32) / ((N - 1) as f32); // 0 → 0.95 saturation
            let m = 0.22f32; // mid scene-linear luminance
            let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
            // Hold green, pull red/blue down → increasingly saturated green.
            img.pixels[0] = [m * (1.0 - s), m, m * (1.0 - s)];
            crate::view::agx::apply(&mut img, 0.0);
            rec2020_to_srgb(&mut img);
            let lab = srgb_linear_to_oklab(img.pixels[0]);
            chromas.push((lab[1] * lab[1] + lab[2] * lab[2]).sqrt());
        }
        // Monotonic non-decreasing (sub-LSB tolerance, per the gamut sweep).
        for w in chromas.windows(2) {
            assert!(
                w[1] >= w[0] - 1.5e-3,
                "view-tail chroma inverted: {} -> {}",
                w[0],
                w[1]
            );
        }
        // No collapse: the saturated ramp must span a real output-chroma range.
        let span = chromas[N - 1] - chromas[0];
        eprintln!("full view-tail green ramp: out-chroma span = {span:.4}");
        assert!(span > 0.05, "view-tail saturated ramp collapsed (span {span})");
    }

    #[test]
    fn quantize_produces_expected_length() {
        let mut img = Image::new(4, 4, ColorSpace::DisplayLinearSrgb);
        let bytes = quantize_u8(&mut img);
        assert_eq!(bytes.len(), 4 * 4 * 3);
    }

    #[test]
    fn quantize_black_is_zero() {
        // Display-linear 0 → sRGB-encoded 0 → u8 0.
        let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
        let bytes = quantize_u8(&mut img);
        assert!(bytes.iter().all(|b| *b == 0));
    }

    #[test]
    fn quantize_white_is_255() {
        // Display-linear 1.0 → sRGB-encoded 1.0 → u8 255.
        let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
        for p in &mut img.pixels {
            *p = [1.0, 1.0, 1.0];
        }
        let bytes = quantize_u8(&mut img);
        assert!(bytes.iter().all(|b| *b == 255));
    }

    #[test]
    fn dither_breaks_up_smooth_gradient() {
        // Smooth scene-linear gradient — the un-dithered post-gamma
        // output has visible run-length plateaus (multiple columns
        // sharing the same u8), so the band as a whole spans far fewer
        // u8 values than columns. That ratio IS the banding signal.
        // Bayer ±0.5 LSB jitter must strictly increase the unique-count
        // (gradient picks up more steps, plateaus break apart).
        //
        // Pick scene-linear [0, 0.02] — a deep-shadow band where the
        // sRGB gamma curve is locally flat; the un-dithered path
        // collapses 512 columns into a small handful of u8 values
        // (textbook sky-banding).
        let w = 512u32;
        let h = 8u32;
        let mut img = Image::new(w, h, ColorSpace::DisplayLinearSrgb);
        for y in 0..h as usize {
            for x in 0..w as usize {
                let v = (x as f32 / (w - 1) as f32) * 0.02;
                img.pixels[y * w as usize + x] = [v, v, v];
            }
        }

        // Un-dithered baseline — mirrors the pre-#441 quantize body.
        let mut undith_seen = [false; 256];
        for p in &img.pixels {
            let g = srgb_gamma(p[0]);
            let b = (g * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
            undith_seen[b as usize] = true;
        }
        let undith_unique = undith_seen.iter().filter(|&&b| b).count();

        let bytes = quantize_u8(&mut img);
        let mut dith_seen = [false; 256];
        for chunk in bytes.chunks_exact(3) {
            dith_seen[chunk[0] as usize] = true;
        }
        let dith_unique = dith_seen.iter().filter(|&&b| b).count();

        // Also count column-to-column "transitions" — how often
        // adjacent columns in a single row hold different u8 values.
        // The banding artefact IS the long flat plateau: un-dithered
        // adjacent columns frequently share a u8, transitions << w-1.
        // Dither breaks the plateau boundaries — transitions across
        // an 8-row tile should approach w-1.
        let row_transitions =
            |row: &[u8]| -> usize { row.windows(2).filter(|p| p[0] != p[1]).count() };
        let mut undith_row = Vec::with_capacity(w as usize);
        for x in 0..w as usize {
            let v = (x as f32 / (w - 1) as f32) * 0.02;
            let g = srgb_gamma(v);
            undith_row.push((g * 255.0 + 0.5).clamp(0.0, 255.0) as u8);
        }
        let undith_tx = row_transitions(&undith_row);
        // Average transitions across the dithered tile rows.
        let mut dith_tx_total = 0usize;
        for y in 0..h as usize {
            let row: Vec<u8> = (0..w as usize)
                .map(|x| bytes[(y * w as usize + x) * 3])
                .collect();
            dith_tx_total += row_transitions(&row);
        }
        let dith_tx_avg = dith_tx_total / h as usize;

        eprintln!(
            "shadow ramp [0, 0.02] over {w}x{h}: \
             un-dithered={undith_unique} unique u8 ({undith_tx} col transitions), \
             dithered={dith_unique} unique u8 ({dith_tx_avg} avg col transitions)"
        );

        // Same unique-count range bounds (no clipping introduced).
        assert_eq!(
            undith_unique, dith_unique,
            "dither must not change the span of u8 values (it only \
             re-distributes them spatially): un={undith_unique} \
             d={dith_unique}",
        );
        // Banding signature: un-dithered transitions are a small
        // fraction of column count (long plateaus). Dither must lift
        // the per-row transition count substantially.
        assert!(
            dith_tx_avg > undith_tx * 3,
            "dither must break plateaus — expected at least 3x more \
             column transitions; un-dithered={undith_tx} \
             dithered_avg={dith_tx_avg}",
        );
        // And dither transitions should be a substantial fraction of
        // w-1 (the upper bound is every adjacent pair differing). The
        // observed value on this fixture is ~253/511 — well above the
        // banding-prone un-dithered 39.
        assert!(
            dith_tx_avg as u32 >= w / 4,
            "dither transitions {dith_tx_avg} should be a substantial \
             fraction of column count (≥ {})",
            w / 4,
        );
    }

    #[test]
    fn dither_preserves_mean_on_solid_color() {
        // 16×16 of mid-gray. After gamma, scene 0.18 → display-encoded
        // ≈ 0.461 → u8 ≈ 117.5. Bayer dither produces a mix of 117 and
        // 118; nothing should land further than ±1 LSB from 117.5
        // (i.e. all outputs ∈ {117, 118}).
        let mut img = Image::new(16, 16, ColorSpace::DisplayLinearSrgb);
        for p in &mut img.pixels {
            *p = [0.18, 0.18, 0.18];
        }
        let bytes = quantize_u8(&mut img);
        let mut min_b = u8::MAX;
        let mut max_b = u8::MIN;
        let mut sum: u32 = 0;
        for &b in &bytes {
            min_b = min_b.min(b);
            max_b = max_b.max(b);
            sum += b as u32;
        }
        // ±1 LSB band: max - min ≤ 1.
        assert!(
            max_b - min_b <= 1,
            "solid colour dithered to >1 LSB span: [{min_b}, {max_b}]",
        );
        let mean = sum as f32 / bytes.len() as f32;
        // Tile mean = 0; centered around the un-dithered value 117.5.
        assert!(
            (mean - 117.5).abs() < 1.0,
            "dithered mean {mean} drifted from un-dithered ~117.5",
        );
    }

    #[test]
    fn quantize_mid_gray_lands_near_118() {
        // Display-linear 0.18 → sRGB-encoded ≈ 0.461 → u8 ≈ 118. This is
        // the classic mid-gray placement in display-encoded sRGB; the
        // Maple AgX polynomial is calibrated to land scene 0.18 here.
        let mut img = Image::new(1, 1, ColorSpace::DisplayLinearSrgb);
        img.pixels[0] = [0.18, 0.18, 0.18];
        let bytes = quantize_u8(&mut img);
        for &b in &bytes {
            assert!(
                (b as i32 - 118).abs() <= 2,
                "mid-gray u8 = {}, expected near 118",
                b
            );
        }
    }
}

// P3 / TargetPrimaries tests (#1337) live in a sibling file (600-LOC budget).
#[cfg(test)]
#[path = "encode_p3_tests.rs"]
mod encode_p3_tests;
