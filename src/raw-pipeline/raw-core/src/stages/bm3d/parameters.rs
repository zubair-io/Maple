//! CPU/GPU shared BM3D tuning and orthonormal basis.
use std::sync::OnceLock;

/// Patch edge length.
pub const BLOCK: usize = 8;
/// Reference-patch grid stride.
pub const STRIDE: usize = 6;
/// Half-extent of the (19×19) block-matching search window.
pub const SEARCH_HALF: usize = 9;
/// Maximum group size (power of two for the group-axis WHT).
pub const GROUP_MAX: usize = 16;
/// Hard-threshold multiplier on σ (pass 1).
pub const LAMBDA_HT: f32 = 2.7;
/// Match ceiling: mean-relative per-pixel SSD ≤ `T_MATCH_SQ · σ_Y²`.
/// 2.5² — two flat patches under iid noise differ by ~2σ² per pixel, so
/// this keeps genuinely similar content while rejecting structure.
pub const T_MATCH_SQ: f32 = 6.25;
/// Strength→σ slope: at strength 100, σ_Y = 20 % of the median-luma
/// anchor. Initial calibration value (the stage ships default-off; the
/// engaged response is gated by the identity/monotonicity tests and the
/// slider-matrix harness when cases are added).
pub const SIGMA_K: f32 = 0.2;
/// Chroma σ multiplier (spec § 3.2: ≈1.8× luma).
pub const CHROMA_SIGMA_RATIO: f32 = 1.8;
/// Anchor pedestal so a near-black frame still gets a non-zero σ.
pub const ANCHOR_PEDESTAL: f32 = 1e-3;
/// High-frequency re-injection gain at strength 100.
pub const HF_K: f32 = 0.15;
/// Rec.2020 luma weights (same constants as the sibling stages).
pub const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Orthonormal DCT-II basis, `basis[k][n] = c(k)·cos(π(2n+1)k / 16)` with
/// `c(0) = 1/√8`, `c(k>0) = 1/2`. Rows are the basis vectors; the matrix
/// is orthogonal, so the inverse transform is multiplication by the
/// transpose.
pub fn dct_basis() -> &'static [[f32; BLOCK]; BLOCK] {
    static BASIS: OnceLock<[[f32; BLOCK]; BLOCK]> = OnceLock::new();
    BASIS.get_or_init(|| {
        let mut b = [[0f32; BLOCK]; BLOCK];
        let n = BLOCK as f64;
        for (k, row) in b.iter_mut().enumerate() {
            let scale = if k == 0 {
                (1.0 / n).sqrt()
            } else {
                (2.0 / n).sqrt()
            };
            for (i, v) in row.iter_mut().enumerate() {
                let angle = std::f64::consts::PI * (2.0 * i as f64 + 1.0) * k as f64 / (2.0 * n);
                *v = (scale * angle.cos()) as f32;
            }
        }
        b
    })
}

/// Separable high-frequency reinjection kernel (sigma about 1.5 pixels).
pub const HIGH_PASS_KERNEL: [f32; 3] = [1.0, 0.800_737_4, 0.411_112_3];
