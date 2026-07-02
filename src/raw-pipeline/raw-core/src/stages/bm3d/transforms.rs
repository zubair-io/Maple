//! BM3D patch transforms (#1105): orthonormal 8×8 2-D DCT-II for the
//! per-patch transform and an orthonormal 1-D fast Walsh–Hadamard
//! transform along the group (patch) axis. Clean-room — implemented from
//! the textbook definitions; constants are computed at runtime, no tables
//! copied from any reference implementation.

use std::sync::OnceLock;

use super::BLOCK;

/// Number of pixels in one patch.
pub const PATCH: usize = BLOCK * BLOCK;

/// Orthonormal DCT-II basis, `basis[k][n] = c(k)·cos(π(2n+1)k / 16)` with
/// `c(0) = 1/√8`, `c(k>0) = 1/2`. Rows are the basis vectors; the matrix
/// is orthogonal, so the inverse transform is multiplication by the
/// transpose.
fn dct_basis() -> &'static [[f32; BLOCK]; BLOCK] {
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

/// Forward 2-D DCT-II of an 8×8 patch (row-major `[f32; 64]`), in place.
/// Separable: rows first (`B · X`), then columns (`· Bᵀ`).
pub fn dct2d_forward(p: &mut [f32; PATCH]) {
    let b = dct_basis();
    let mut tmp = [0f32; PATCH];
    // Rows: tmp[r][k] = Σ_n p[r][n]·basis[k][n]
    for r in 0..BLOCK {
        for k in 0..BLOCK {
            let mut acc = 0f32;
            for n in 0..BLOCK {
                acc += p[r * BLOCK + n] * b[k][n];
            }
            tmp[r * BLOCK + k] = acc;
        }
    }
    // Columns: out[k][c] = Σ_r tmp[r][c]·basis[k][r]
    for c in 0..BLOCK {
        for k in 0..BLOCK {
            let mut acc = 0f32;
            for r in 0..BLOCK {
                acc += tmp[r * BLOCK + c] * b[k][r];
            }
            p[k * BLOCK + c] = acc;
        }
    }
}

/// Inverse 2-D DCT-II (i.e. DCT-III with the orthonormal scaling), in
/// place. Multiplication by the transposed basis on both axes.
pub fn dct2d_inverse(p: &mut [f32; PATCH]) {
    let b = dct_basis();
    let mut tmp = [0f32; PATCH];
    // Columns: tmp[r][c] = Σ_k p[k][c]·basis[k][r]
    for c in 0..BLOCK {
        for r in 0..BLOCK {
            let mut acc = 0f32;
            for k in 0..BLOCK {
                acc += p[k * BLOCK + c] * b[k][r];
            }
            tmp[r * BLOCK + c] = acc;
        }
    }
    // Rows: out[r][n] = Σ_k tmp[r][k]·basis[k][n]
    for r in 0..BLOCK {
        for n in 0..BLOCK {
            let mut acc = 0f32;
            for k in 0..BLOCK {
                acc += tmp[r * BLOCK + k] * b[k][n];
            }
            p[r * BLOCK + n] = acc;
        }
    }
}

/// In-place orthonormal fast Walsh–Hadamard transform of `v` (length must
/// be a power of two, ≤ the group cap). Each butterfly stage scales by
/// `1/√2`, so the transform is its own inverse.
pub fn wht_in_place(v: &mut [f32]) {
    let n = v.len();
    debug_assert!(n.is_power_of_two());
    let inv_sqrt2 = std::f32::consts::FRAC_1_SQRT_2;
    let mut h = 1;
    while h < n {
        let mut i = 0;
        while i < n {
            for j in i..i + h {
                let a = v[j];
                let b = v[j + h];
                v[j] = (a + b) * inv_sqrt2;
                v[j + h] = (a - b) * inv_sqrt2;
            }
            i += h * 2;
        }
        h *= 2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dct_round_trip_recovers_input() {
        let mut p = [0f32; PATCH];
        for (i, v) in p.iter_mut().enumerate() {
            *v = ((i * 7919) % 97) as f32 / 97.0 - 0.5;
        }
        let orig = p;
        dct2d_forward(&mut p);
        dct2d_inverse(&mut p);
        for i in 0..PATCH {
            assert!(
                (p[i] - orig[i]).abs() < 1e-5,
                "i={} {} vs {}",
                i,
                p[i],
                orig[i]
            );
        }
    }

    #[test]
    fn dct_of_zero_patch_is_exactly_zero() {
        // The exact-identity guarantee leans on this: mean-relative
        // patches of a uniform field are exactly 0.0, and 0·basis sums
        // to exactly 0.0 in float.
        let mut p = [0f32; PATCH];
        dct2d_forward(&mut p);
        assert!(p.iter().all(|&v| v == 0.0));
        dct2d_inverse(&mut p);
        assert!(p.iter().all(|&v| v == 0.0));
    }

    #[test]
    fn dct_is_orthonormal_energy_preserving() {
        let mut p = [0f32; PATCH];
        for (i, v) in p.iter_mut().enumerate() {
            *v = ((i * 31) % 11) as f32 - 5.0;
        }
        let e_in: f64 = p.iter().map(|&v| (v as f64) * (v as f64)).sum();
        dct2d_forward(&mut p);
        let e_out: f64 = p.iter().map(|&v| (v as f64) * (v as f64)).sum();
        assert!((e_in - e_out).abs() / e_in < 1e-5, "{e_in} vs {e_out}");
    }

    #[test]
    fn wht_round_trip_and_zero_exactness() {
        for n in [1usize, 2, 4, 8, 16] {
            let mut v: Vec<f32> = (0..n).map(|i| (i as f32) * 0.37 - 1.0).collect();
            let orig = v.clone();
            wht_in_place(&mut v);
            wht_in_place(&mut v);
            for i in 0..n {
                assert!((v[i] - orig[i]).abs() < 1e-5, "n={n} i={i}");
            }
            let mut z = vec![0f32; n];
            wht_in_place(&mut z);
            assert!(
                z.iter().all(|&x| x == 0.0),
                "WHT of zeros must be exactly zero"
            );
        }
    }
}
