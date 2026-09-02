//! Canonical display **encode** entry for the Apple FFI path (#877).
//!
//! Split out of `scene_linear_chain.rs` (file-budget; #877). This is the
//! exact pair of view-encode stages the CPU/CLI reference runs between
//! `agx` and `auto_profile` — `rec2020_to_srgb` (hue-preserving Oklab gamut
//! compression, #438) then `srgb_gamma_encode` — exposed as an FFI-facing
//! f32 RGBA entry so the Apple canvas reaches sRGB through raw-core's
//! reference math instead of CoreImage's per-channel-clamp conversion.

use super::stage;
use crate::error::Result;
use crate::view::encode::TargetPrimaries;

/// Apply the canonical display **encode** — [`crate::view::encode::rec2020_to_display`]
/// (hue-preserving Oklab gamut compression against the TARGET primaries' hull, #438 /
/// #1337) followed by `srgb_gamma_encode` — to a post-AgX **display-linear Rec.2020**
/// f32 RGBA buffer, returning a **newly allocated** display-encoded f32 RGBA buffer in
/// the requested primaries. The input slice is read but never mutated.
///
/// This is the exact pair of view-encode stages the CPU/CLI reference runs between
/// `agx` and `auto_profile` (see `pipeline::render`: `agx → rec2020_to_display →
/// srgb_gamma_encode → auto_profile`). The Apple canvas previously reached sRGB
/// **implicitly** at the CoreImage `createCGImage` boundary, which does a per-channel
/// clamp of the Rec.2020→sRGB matrix output — it does NOT do the Oklab chroma
/// compression, so saturated wide-gamut greens (Rec.2020 ≫ sRGB) clipped green up /
/// blue to zero and diverged from the reference (#871 / #877). Routing the encode
/// through this entry makes the Apple buffer **gamut-correct by construction**,
/// sharing raw-core's reference math.
///
/// At `TargetPrimaries::Srgb` the output is in the same [0,1]³ sRGB-gamma-encoded
/// sRGB-primary space the Auto Profile cube (#812) was fit and baked in, so the cube
/// applies on the matching domain (no per-channel clamp inside the cube's color
/// management) — the Auto Profile cube is always fit in sRGB regardless of the
/// canvas's target primaries (#3190), so a `P3` caller applies the cube BEFORE this
/// encode, not after.
///
/// Input/output: packed f32 RGBA, row-major, 4 lanes per pixel. Alpha is read but
/// ignored; output alpha is 1.0 unconditionally (straight alpha, every stage operates
/// on RGB only).
pub fn encode_display_f32(
    in_f32_rgba: &[f32],
    width: u32,
    height: u32,
    target: TargetPrimaries,
) -> Result<Vec<f32>> {
    use crate::image::{ColorSpace, Image};
    use crate::view::encode;

    let pixel_count = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| {
            crate::error::Error::Pipeline(format!(
                "encode_display_f32: pixel count overflow: {}x{}",
                width, height
            ))
        })?;
    let expected_len = pixel_count.checked_mul(4).ok_or_else(|| {
        crate::error::Error::Pipeline(format!(
            "encode_display_f32: expected input length overflow (RGBA 4-lane multiplier): {}x{}",
            width, height
        ))
    })?;
    if in_f32_rgba.len() != expected_len {
        return Err(crate::error::Error::Pipeline(format!(
            "encode_display_f32: input length {} != width({}) * height({}) * 4 = {}",
            in_f32_rgba.len(),
            width,
            height,
            expected_len
        )));
    }

    // The incoming buffer is post-AgX display-linear Rec.2020 (that is what
    // the Apple FFI chain hands back and the Metal sharpen/nr_color kernels
    // produce). Tag it as such so the encode stages' `assert_space`
    // pre-conditions hold.
    let mut img = stage("ffi_encode_unpack_f32", || {
        let mut pixels: Vec<[f32; 3]> = Vec::with_capacity(pixel_count);
        for chunk in in_f32_rgba.chunks_exact(4) {
            pixels.push([chunk[0], chunk[1], chunk[2]]);
        }
        Image {
            width,
            height,
            pixels,
            space: ColorSpace::DisplayLinearRec2020,
        }
    });

    // Canonical encode: Oklab gamut compression (against the TARGET
    // primaries' hull) then sRGB/P3-shared gamma OETF. Identical call
    // sequence to `pipeline::render`.
    stage("ffi_encode_rec2020_to_display", || {
        encode::rec2020_to_display(&mut img, target)
    });
    stage("ffi_encode_srgb_gamma", || {
        encode::srgb_gamma_encode(&mut img)
    });

    // Pack the display-gamma-encoded [0,1] result back to f32 RGBA.
    let out = stage("ffi_encode_pack_f32", || {
        let mut v: Vec<f32> = Vec::with_capacity(pixel_count * 4);
        for p in &img.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    Ok(out)
}

/// sRGB-target convenience wrapper — the pre-#3190 entry point, kept for
/// existing callers (mirrors [`crate::view::encode::rec2020_to_srgb`]
/// wrapping [`crate::view::encode::rec2020_to_display`]).
pub fn encode_display_srgb_f32(in_f32_rgba: &[f32], width: u32, height: u32) -> Result<Vec<f32>> {
    encode_display_f32(in_f32_rgba, width, height, TargetPrimaries::Srgb)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `encode_display_srgb_f32` must byte-match the canonical CPU encode
    /// (`rec2020_to_srgb` + `srgb_gamma_encode`) over the same input — it is
    /// literally a thin wrapper over those two stages, so any divergence is a
    /// bug. Drive a saturated wide-gamut green (the #877 class) and a neutral.
    #[test]
    fn encode_display_srgb_f32_matches_cpu_encode() {
        use crate::image::{ColorSpace, Image};
        use crate::view::encode;

        let cases: [[f32; 3]; 4] = [
            [0.0, 0.8, 0.0],    // saturated wide-gamut green (#877)
            [0.0, 1.0, 0.0],    // pure Rec.2020 green primary
            [0.46, 0.46, 0.46], // neutral mid
            [0.95, 0.97, 0.9],  // near-white highlight
        ];
        for rgb in cases {
            // Reference: the exact two CPU stages on a 1×1 image.
            let mut ref_img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
            ref_img.pixels[0] = rgb;
            encode::rec2020_to_srgb(&mut ref_img);
            encode::srgb_gamma_encode(&mut ref_img);
            let expected = ref_img.pixels[0];

            // Under test: the FFI-facing f32 RGBA wrapper.
            let input = vec![rgb[0], rgb[1], rgb[2], 1.0];
            let out = encode_display_srgb_f32(&input, 1, 1).expect("encode_display_srgb_f32");
            assert_eq!(out.len(), 4);
            for c in 0..3 {
                assert_eq!(
                    out[c].to_bits(),
                    expected[c].to_bits(),
                    "channel {} byte-mismatch for input {:?}: got {} expected {}",
                    c,
                    rgb,
                    out[c],
                    expected[c]
                );
            }
            assert!((out[3] - 1.0).abs() < 1e-6, "alpha must be 1.0");
            // The whole point of #877: every channel is in [0,1] (no
            // per-channel clip artefact — Oklab compression brought it in).
            for c in 0..3 {
                assert!(
                    out[c] >= 0.0 && out[c] <= 1.0,
                    "channel {} out of [0,1] for {:?}: {}",
                    c,
                    rgb,
                    out[c]
                );
            }
        }
    }

    /// Length mismatch on the encode entry errors (no panic).
    #[test]
    fn encode_display_srgb_f32_rejects_size_mismatch() {
        let r = encode_display_srgb_f32(&[0.0; 10], 4, 4);
        assert!(r.is_err(), "size mismatch must error");
    }

    /// #3190: the P3-target entry must byte-match the canonical CPU encode
    /// (`rec2020_to_display(.., P3)` + `srgb_gamma_encode`), the same
    /// contract `encode_display_srgb_f32_matches_cpu_encode` proves for the
    /// sRGB target — and it must actually DIFFER from the sRGB-target
    /// result on a saturated wide-gamut input, or the target param would be
    /// silently inert.
    #[test]
    fn encode_display_f32_p3_target_matches_cpu_encode_and_differs_from_srgb() {
        use crate::image::{ColorSpace, Image};
        use crate::view::encode;

        let rgb = [0.0f32, 0.8, 0.0]; // saturated wide-gamut green (#877)
        let input = vec![rgb[0], rgb[1], rgb[2], 1.0];

        let mut ref_img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
        ref_img.pixels[0] = rgb;
        encode::rec2020_to_display(&mut ref_img, TargetPrimaries::P3);
        encode::srgb_gamma_encode(&mut ref_img);
        let expected = ref_img.pixels[0];

        let out_p3 =
            encode_display_f32(&input, 1, 1, TargetPrimaries::P3).expect("encode_display_f32 (P3)");
        for c in 0..3 {
            assert_eq!(
                out_p3[c].to_bits(),
                expected[c].to_bits(),
                "channel {c} byte-mismatch vs the reference P3 encode"
            );
        }
        assert!((out_p3[3] - 1.0).abs() < 1e-6, "alpha must be 1.0");

        let out_srgb = encode_display_srgb_f32(&input, 1, 1).expect("encode_display_srgb_f32");
        let diff = (0..3)
            .map(|c| (out_p3[c] - out_srgb[c]).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            diff > 1e-3,
            "P3 and sRGB targets produced near-identical output ({diff}) on a saturated \
             wide-gamut input — the target_primaries param looks inert"
        );
    }
}
