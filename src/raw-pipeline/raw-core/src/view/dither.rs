//! Ordered (Bayer) dithering for 8-bit quantization. Ticket #441.
//!
//! `encode::quantize_u8` applies the sRGB gamma and rounds to u8 without
//! dithering, which produces visible 8-bit banding on smooth gradients
//! (skies are the classic example). Adding ±0.5 LSB positional jitter
//! before the round breaks up the flat plateaus so the eye reads the
//! quantization error as fine noise instead of contour bands.
//!
//! The pattern is the canonical 8×8 Bayer matrix (`B(8)` per
//! Wikipedia: <https://en.wikipedia.org/wiki/Ordered_dithering>). The
//! values 0..=63 expand into the half-open interval `[-0.5, +0.5)` LSB
//! via `(v + 0.5) / 64.0 - 0.5` so the mean offset across the 64-cell
//! tile is exactly 0 (no DC bias — solid colors stay on their u8
//! plateau ±1 LSB).
//!
//! Cross-platform parity: the same matrix is embedded in the Web AgX
//! shader (`src/web/projects/maple-common/src/lib/webgl/shaders/agx-view-transform.ts`).
//! Same indexing (`(x & 7, y & 7)`), same offset formula, so both
//! platforms drop the same dither dots on the same pixels for a given
//! image. Rust outputs gamma-encoded sRGB and dithers post-gamma in
//! u8 units; the Web path writes display-linear Rec.2020 to an RGBA8
//! canvas and the browser does the gamma+quantize, so the Web side
//! dithers in the linear domain — approximate (not byte-identical)
//! parity, which is acceptable here because cross-platform color
//! parity is gated at the AgX-LUT boundary, not post-encode (see
//! `view/agx.rs` `glsl_port_matches_rust_lut`).

/// 8×8 Bayer matrix. Values 0..=63. Indexed `BAYER_8X8[y][x]`.
///
/// Standard recursive Bayer construction:
///   `B(2) = [[0,2],[3,1]]`,
///   `B(2n) = [[4*B(n),     4*B(n)+2],
///             [4*B(n)+3,   4*B(n)+1]]`.
///
/// Trivially golden — any reference (Wikipedia, OpenGL Programming
/// Guide, GIMP source) lists the same matrix.
pub const BAYER_8X8: [[u8; 8]; 8] = [
    [ 0, 32,  8, 40,  2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44,  4, 36, 14, 46,  6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [ 3, 35, 11, 43,  1, 33,  9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47,  7, 39, 13, 45,  5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
];

/// Dither offset in LSB units (`[-0.5, +0.5)`) for pixel `(x, y)`.
///
/// `(BAYER_8X8[y & 7][x & 7] + 0.5) / 64.0 - 0.5` maps `0..=63` to
/// `-0.5, ..., +0.5 - 1/64`. The `+0.5` numerator centers each cell
/// inside its slot so the mean across the tile is exactly 0; the
/// `-0.5` at the end shifts the range from `[0, 1)` LSB to
/// `[-0.5, +0.5)` LSB. Designed to be added directly to `g * 255`
/// before the round-and-clamp step in `quantize_u8`.
#[inline]
pub fn bayer_offset_lsb(x: u32, y: u32) -> f32 {
    let cell = BAYER_8X8[(y as usize) & 7][(x as usize) & 7];
    (cell as f32 + 0.5) / 64.0 - 0.5
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrix_contains_each_value_exactly_once() {
        let mut seen = [false; 64];
        for row in &BAYER_8X8 {
            for &v in row {
                assert!(v < 64, "value {v} out of range");
                assert!(!seen[v as usize], "value {v} appeared twice");
                seen[v as usize] = true;
            }
        }
        assert!(seen.iter().all(|&b| b));
    }

    #[test]
    fn offset_range_is_half_open_lsb() {
        for y in 0u32..8 {
            for x in 0u32..8 {
                let o = bayer_offset_lsb(x, y);
                assert!(o >= -0.5 && o < 0.5, "offset {o} at ({x},{y}) out of [-0.5, +0.5)");
            }
        }
    }

    #[test]
    fn tile_mean_offset_is_zero() {
        let mut sum = 0.0f32;
        for y in 0u32..8 {
            for x in 0u32..8 {
                sum += bayer_offset_lsb(x, y);
            }
        }
        // Exact zero (each cell contributes `(v + 0.5)/64 - 0.5`, sum
        // over v=0..=63 of (v + 0.5) = 32*64 = 2048; / 64 = 32; minus
        // 0.5 * 64 = 32; difference = 0).
        assert!(sum.abs() < 1e-5, "tile mean offset = {sum}");
    }

    #[test]
    fn offset_tiles_across_image() {
        // (x, y) and (x + 8, y) and (x, y + 8) sample the same cell.
        for y in 0u32..8 {
            for x in 0u32..8 {
                let base = bayer_offset_lsb(x, y);
                assert_eq!(base, bayer_offset_lsb(x + 8, y));
                assert_eq!(base, bayer_offset_lsb(x, y + 8));
                assert_eq!(base, bayer_offset_lsb(x + 16, y + 16));
            }
        }
    }
}
