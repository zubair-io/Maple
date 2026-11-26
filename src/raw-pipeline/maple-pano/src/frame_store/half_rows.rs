//! The store's on-disk pixel encoding: RGB as three little-endian IEEE
//! binary16 values (#6057). Scene-linear values carry 11 significant bits,
//! finer than 16-bit integers in the shadows, at half the bytes of `f32`.

use half::f16;

/// Bytes one stored pixel occupies.
pub(super) const STORED_BYTES_PER_PIXEL: u64 = 6;

/// `pixels` encoded for the store. Finite values past the binary16 range
/// saturate to its largest finite value rather than becoming infinities.
pub(super) fn encode(pixels: &[[f32; 3]]) -> Vec<u8> {
    let max = f16::MAX.to_f32();
    pixels
        .iter()
        .flatten()
        .flat_map(|&v| {
            let v = if v.is_finite() { v.clamp(-max, max) } else { v };
            f16::from_f32(v).to_le_bytes()
        })
        .collect()
}

/// Decode `bytes`, `out.len()` stored pixels, into `out`.
pub(super) fn decode_into(bytes: &[u8], out: &mut [[f32; 3]]) {
    for (px, raw) in out.iter_mut().zip(bytes.chunks_exact(6)) {
        *px = std::array::from_fn(|c| f16::from_le_bytes([raw[2 * c], raw[2 * c + 1]]).to_f32());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_within_half_precision_and_saturates() {
        let pixels = [
            [0.0, 1.0, -0.5],
            [1.0e-5, 0.1234, 7.0e4],
            [f32::NAN, 3.0, 65504.0],
        ];
        let mut back = [[0.0f32; 3]; 3];
        decode_into(&encode(&pixels), &mut back);
        assert_eq!(back[0], [0.0, 1.0, -0.5]);
        assert!((back[1][1] - 0.1234).abs() <= 0.1234 * 2.0f32.powi(-11));
        assert_eq!(back[1][2], 65504.0);
        assert!(back[2][0].is_nan());
        assert_eq!(back[2][1..], [3.0, 65504.0]);
    }
}
