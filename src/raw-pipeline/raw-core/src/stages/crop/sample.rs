//! Sample-depth abstraction for the display-encoded crop helpers (#943).
//!
//! Crop runs after the terminal quantizer, on integer display samples. That
//! was a single `u8` implementation until export added a 16-bit deliverable;
//! rather than fork the rect-slice, orthogonal-rotate and bilinear-warp
//! routines into near-identical `u8` and `u16` copies — three chances for the
//! two depths to drift apart on a geometry edge case — they are generic over
//! this trait.
//!
//! [`Sample::from_f32_rounded`] reproduces the `u8` path's existing
//! `round().clamp()` exactly, so 8-bit crops stay byte-identical to what the
//! color harness has already gated.

/// An integer display-sample depth the crop helpers can operate on.
pub trait Sample: Copy + Default + Send + Sync {
    /// The largest representable level, as f32 — the clamp ceiling for
    /// interpolated values.
    const MAX_LEVEL: f32;

    /// Widen to f32 for interpolation arithmetic.
    fn to_f32(self) -> f32;

    /// Narrow an interpolated value back to the sample depth, rounding to
    /// nearest and clamping into range.
    fn from_f32_rounded(value: f32) -> Self;
}

impl Sample for u8 {
    const MAX_LEVEL: f32 = 255.0;

    #[inline]
    fn to_f32(self) -> f32 {
        self as f32
    }

    #[inline]
    fn from_f32_rounded(value: f32) -> Self {
        value.round().clamp(0.0, Self::MAX_LEVEL) as u8
    }
}

impl Sample for u16 {
    const MAX_LEVEL: f32 = 65535.0;

    #[inline]
    fn to_f32(self) -> f32 {
        self as f32
    }

    #[inline]
    fn from_f32_rounded(value: f32) -> Self {
        value.round().clamp(0.0, Self::MAX_LEVEL) as u16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u8_round_trips_through_f32() {
        for value in [0u8, 1, 127, 254, 255] {
            assert_eq!(u8::from_f32_rounded(value.to_f32()), value);
        }
    }

    #[test]
    fn u16_round_trips_through_f32() {
        for value in [0u16, 1, 32767, 65534, 65535] {
            assert_eq!(u16::from_f32_rounded(value.to_f32()), value);
        }
    }

    #[test]
    fn narrowing_clamps_out_of_range_values() {
        assert_eq!(u8::from_f32_rounded(-12.0), 0);
        assert_eq!(u8::from_f32_rounded(999.0), 255);
        assert_eq!(u16::from_f32_rounded(-1.0), 0);
        assert_eq!(u16::from_f32_rounded(1.0e9), 65535);
    }

    #[test]
    fn narrowing_rounds_to_nearest() {
        assert_eq!(u8::from_f32_rounded(10.4), 10);
        assert_eq!(u8::from_f32_rounded(10.6), 11);
        assert_eq!(u16::from_f32_rounded(1000.5), 1001);
    }
}
