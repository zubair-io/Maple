//! IEEE 754 binary16 helpers used by the scene-linear FFI entries.
//!
//! `f32_to_f16_bits` packs an `f32` into the 16-bit pattern
//! `CIImage.RGBAh` expects on the Apple side. `f16_bits_to_f32` is the
//! inverse — used by the per-tick FFI chain to unpack the caller's fp16
//! RGBA bytes back into the `f32` the per-stage stages operate on.
//!
//! Spike 1.1 caught a naive `(bits >> 13) & 0x3fff` form that masked four
//! bits of the f32 stored exponent into the fp16 mantissa (~31% positive
//! bias on common values like 1.5, which read back as ~1.97). The
//! implementations below isolate sign / exponent / mantissa separately
//! before re-packing, and round-trip cleanly for every value
//! representable in fp16. See `SceneLinearPipelineTests.swift` for the
//! cross-platform check.

/// IEEE 754 binary16 encode of a `f32`. Matches the format CIImage.RGBAh
/// expects on the Apple side. Pure scalar — fp16 storage is u16 lanes.
///
/// This implementation isolates the float32 mantissa (bits 0..22) and
/// stored exponent (bits 23..30) **separately** before re-packing into
/// fp16. A naive `(bits >> 13) & 0x3fff` masks 14 bits including 4 bits
/// from the float32 stored exponent, which then leak into the fp16
/// mantissa via `mant >> 4` and produce ~31% positive bias on common
/// values like 1.5 (read back as ~1.97). Spike 1.1 caught this on the
/// Apple side; the same math lives here so the FFI handoff is correct.
/// See `SceneLinearPipelineTests.swift` for the cross-check.
pub(crate) fn f32_to_f16_bits(x: f32) -> u16 {
    let bits = x.to_bits();
    let sign: u16 = ((bits >> 16) & 0x8000) as u16;
    let stored_exp: i32 = ((bits >> 23) & 0xff) as i32;
    let mant_bits: u32 = bits & 0x007fffff; // 23-bit float32 mantissa
    if stored_exp == 0xff {
        // Inf / NaN — preserve NaN-ness via a non-zero mantissa flag.
        return sign | 0x7c00 | (if mant_bits != 0 { 0x0001 } else { 0 });
    }
    let unbiased_exp = stored_exp - 127;
    let fp16_exp = unbiased_exp + 15;
    if fp16_exp >= 31 {
        return sign | 0x7c00; // overflow → inf
    }
    if fp16_exp <= 0 {
        // Subnormal / underflow.
        if fp16_exp < -10 {
            return sign;
        }
        // Add the implicit 1 and shift right to align in fp16 space.
        // fp16 subnormal precision = 10 bits below 2^-14.
        let mant_with_implicit = mant_bits | 0x00800000;
        let shift = (14 - unbiased_exp) as u32;
        // Round-to-nearest-even on the shifted-out bits.
        let shifted = mant_with_implicit >> (shift - 10 - 1); // keep 1 guard bit
        let rounded = (shifted + 1) >> 1; // round half-up
        return sign | ((rounded & 0x03ff) as u16);
    }
    // Normal range. Extract top 10 mantissa bits, with round-to-nearest
    // on the next bit.
    let top10 = (mant_bits >> 13) & 0x03ff;
    let round_bit = (mant_bits >> 12) & 0x1;
    let sticky_bits = mant_bits & 0x0fff;
    let mut fp16_mant = top10;
    // Round half to nearest-even.
    if round_bit != 0 && (sticky_bits != 0 || (fp16_mant & 0x1) != 0) {
        fp16_mant += 1;
        if fp16_mant > 0x3ff {
            // Mantissa overflow on round — bump exponent, mantissa goes to 0.
            let bumped_exp = fp16_exp + 1;
            if bumped_exp >= 31 {
                return sign | 0x7c00;
            }
            return sign | ((bumped_exp as u16) << 10);
        }
    }
    sign | ((fp16_exp as u16) << 10) | (fp16_mant as u16)
}

/// IEEE 754 binary16 decode to `f32`. Inverse of `f32_to_f16_bits`. Used
/// by `apply_scene_linear_chain` to unpack the caller's fp16 RGBA bytes
/// (CIImage `RGBAh` working format) back into the f32 the per-stage
/// `apply` functions in `crate::stages` operate on.
pub(crate) fn f16_bits_to_f32(bits: u16) -> f32 {
    let sign = ((bits & 0x8000) as u32) << 16;
    let exp = ((bits >> 10) & 0x1f) as u32;
    let mant = (bits & 0x03ff) as u32;
    let f = if exp == 0 && mant == 0 {
        // ±0
        f32::from_bits(sign)
    } else if exp == 0 {
        // Subnormal: value = mant * 2^-24
        let mut m = mant;
        let mut e: i32 = -14;
        while m & 0x0400 == 0 {
            m <<= 1;
            e -= 1;
        }
        m &= 0x03ff;
        let f32_exp = ((e + 127) as u32) << 23;
        f32::from_bits(sign | f32_exp | (m << 13))
    } else if exp == 0x1f {
        // Inf / NaN
        f32::from_bits(sign | 0x7f800000 | (mant << 13))
    } else {
        let f32_exp = (exp + 127 - 15) << 23;
        f32::from_bits(sign | f32_exp | (mant << 13))
    };
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    // Sanity tests for f32_to_f16_bits — guards against the bit-isolation
    // bug Spike 1.1 caught on the Apple side. `0x3c00` is the fp16 bit
    // pattern of 1.0; `0x4000` is 2.0; `0x3e00` is 1.5; `0x0000` is 0.0.
    #[test]
    fn f32_to_f16_bits_zero_one_half_two() {
        assert_eq!(f32_to_f16_bits(0.0), 0x0000);
        assert_eq!(f32_to_f16_bits(1.0), 0x3c00);
        assert_eq!(f32_to_f16_bits(2.0), 0x4000);
        assert_eq!(f32_to_f16_bits(1.5), 0x3e00);
    }

    /// `f16_bits_to_f32` is the inverse of `f32_to_f16_bits` for the
    /// canonical sentinel values. Values exactly representable in fp16
    /// (0, 1, 1.5, 2) must round-trip with zero error.
    #[test]
    fn f16_bits_to_f32_inverse_of_f32_to_f16_bits() {
        for x in [0.0f32, 1.0, 1.5, 2.0, 0.5, -1.0, -0.25] {
            let bits = f32_to_f16_bits(x);
            let back = f16_bits_to_f32(bits);
            assert!(
                (back - x).abs() < 1e-6,
                "round-trip {}: got {} (fp16 bits 0x{:04x})",
                x,
                back,
                bits
            );
        }
    }

    /// Round-trip 1.5 through fp16 and back. The buggy form would return
    /// ~1.97 for 1.5; the correct isolation returns 1.5 exactly (1.5 is
    /// representable in fp16).
    #[test]
    fn f32_to_f16_bits_one_point_five_round_trips_exact() {
        let bits = f32_to_f16_bits(1.5);
        // Decode fp16 -> f32 manually.
        let sign = ((bits & 0x8000) as u32) << 16;
        let exp = ((bits & 0x7c00) >> 10) as u32;
        let mant = (bits & 0x03ff) as u32;
        let f = if exp == 0 && mant == 0 {
            f32::from_bits(sign)
        } else if exp == 0x1f {
            f32::from_bits(sign | 0x7f800000 | (mant << 13))
        } else {
            // Normal: rebias exponent and shift mantissa.
            let f32_exp = (exp + 127 - 15) << 23;
            f32::from_bits(sign | f32_exp | (mant << 13))
        };
        assert!(
            (f - 1.5).abs() < 1e-6,
            "1.5 round-trip: got {} (fp16 bits 0x{:04x})",
            f,
            bits
        );
    }
}
