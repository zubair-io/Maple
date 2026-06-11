//! Minimal hand-rolled 3-vector / 3×3-matrix math (f64).
//!
//! Deliberately dependency-free (no `nalgebra`): the pano geometry needs
//! exactly rotations, dot/cross products, and the axis-angle exp/log maps.
//! Matrices are row-major: `m.0[row][col]`.

/// 3-vector of `f64`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    pub fn dot(self, o: Vec3) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    pub fn cross(self, o: Vec3) -> Vec3 {
        Vec3::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }

    pub fn norm(self) -> f64 {
        self.dot(self).sqrt()
    }

    pub fn scale(self, s: f64) -> Vec3 {
        Vec3::new(self.x * s, self.y * s, self.z * s)
    }

    /// Unit-length copy. Returns `None` when the norm is too small to
    /// normalize meaningfully.
    pub fn normalized(self) -> Option<Vec3> {
        let n = self.norm();
        if n < 1e-12 {
            None
        } else {
            Some(self.scale(1.0 / n))
        }
    }
}

impl std::ops::Sub for Vec3 {
    type Output = Vec3;

    fn sub(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}

impl std::ops::Add for Vec3 {
    type Output = Vec3;

    fn add(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}

/// Row-major 3×3 matrix of `f64`: `Mat3([[r0c0, r0c1, r0c2], …])`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mat3(pub [[f64; 3]; 3]);

impl Mat3 {
    pub const fn identity() -> Self {
        Mat3([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
    }

    pub fn mul_vec(&self, v: Vec3) -> Vec3 {
        let m = &self.0;
        Vec3::new(
            m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
            m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
            m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
        )
    }

    pub fn mul_mat(&self, o: &Mat3) -> Mat3 {
        let mut r = [[0.0; 3]; 3];
        for (i, row) in r.iter_mut().enumerate() {
            for (j, cell) in row.iter_mut().enumerate() {
                *cell = (0..3).map(|k| self.0[i][k] * o.0[k][j]).sum();
            }
        }
        Mat3(r)
    }

    /// Transpose. For the rotation matrices used throughout this crate the
    /// transpose is the inverse.
    pub fn transpose(&self) -> Mat3 {
        let m = &self.0;
        Mat3([
            [m[0][0], m[1][0], m[2][0]],
            [m[0][1], m[1][1], m[2][1]],
            [m[0][2], m[1][2], m[2][2]],
        ])
    }

    /// Rotation about +X by `a` radians (right-hand rule).
    pub fn rotation_x(a: f64) -> Mat3 {
        let (s, c) = a.sin_cos();
        Mat3([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])
    }

    /// Rotation about +Y by `a` radians (right-hand rule).
    pub fn rotation_y(a: f64) -> Mat3 {
        let (s, c) = a.sin_cos();
        Mat3([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])
    }

    /// Rotation about +Z by `a` radians (right-hand rule).
    pub fn rotation_z(a: f64) -> Mat3 {
        let (s, c) = a.sin_cos();
        Mat3([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
    }

    /// Max absolute element-wise difference — test helper for comparing
    /// rotations without caring about axis-angle sign ambiguity at θ = π.
    pub fn max_abs_diff(&self, o: &Mat3) -> f64 {
        let mut m = 0.0_f64;
        for i in 0..3 {
            for j in 0..3 {
                m = m.max((self.0[i][j] - o.0[i][j]).abs());
            }
        }
        m
    }
}

/// Axis-angle (Rodrigues vector) → rotation matrix.
///
/// `omega = θ·n̂` in radians; returns `R = exp([omega]×)`, i.e. the rotation
/// by angle θ about unit axis n̂ (right-hand rule). `omega = [0,0,0]` gives
/// the identity.
pub fn axis_angle_to_matrix(omega: [f64; 3]) -> Mat3 {
    let w = Vec3::new(omega[0], omega[1], omega[2]);
    let theta = w.norm();
    if theta < 1e-12 {
        // exp of a ≤ 1e-12 rad rotation differs from I by ≤ 1e-12 per element
        // — far below every tolerance in this crate.
        return Mat3::identity();
    }
    let n = w.scale(1.0 / theta);
    let (s, c) = theta.sin_cos();
    let t = 1.0 - c;
    let (x, y, z) = (n.x, n.y, n.z);
    // Rodrigues: R = I + sinθ·K + (1−cosθ)·K², K = [n̂]×, written out.
    Mat3([
        [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
        [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
        [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
    ])
}

/// Rotation matrix → axis-angle (Rodrigues vector), the inverse of
/// [`axis_angle_to_matrix`].
///
/// Returns `θ·n̂` with `θ ∈ [0, π]`. At exactly θ = π the axis sign is
/// inherently ambiguous (`ω` and `−ω` encode the same rotation); the value
/// returned still satisfies `exp(log(R)) = R`.
pub fn matrix_to_axis_angle(r: &Mat3) -> [f64; 3] {
    let m = &r.0;
    let trace = m[0][0] + m[1][1] + m[2][2];
    // cos θ from the trace; antisymmetric part a = (R − Rᵀ)∨ = 2·sinθ·n̂,
    // so s = ‖a‖/2 = sin θ (θ ∈ [0, π] ⇒ sin θ ≥ 0).
    let c = ((trace - 1.0) * 0.5).clamp(-1.0, 1.0);
    let a = Vec3::new(m[2][1] - m[1][2], m[0][2] - m[2][0], m[1][0] - m[0][1]);
    let s = (a.norm() * 0.5).clamp(0.0, 1.0);

    if s < 1e-7 && c > 0.0 {
        // θ ≈ 0: ω ≈ a/2 (error O(θ³)).
        return [a.x * 0.5, a.y * 0.5, a.z * 0.5];
    }
    if c > -0.999_999 {
        // General case. atan2(s, c) recovers θ with full precision (unlike
        // acos(c), which is ill-conditioned as |c| → 1), and the axis from
        // `a` is well-conditioned while sin θ is not tiny.
        let theta = s.atan2(c);
        let k = theta / (2.0 * s);
        return [a.x * k, a.y * k, a.z * k];
    }
    // Near θ = π: `a` → 0, so take the axis from the symmetric part using
    // the exact identity n_i² = (m_ii − c)/(1 − c) (well-conditioned here:
    // 1 − c ≈ 2). Largest diagonal picks the dominant component; the other
    // two come from off-diagonal sums m_ik + m_ki = 2(1 − c)·n_i·n_k.
    let t = 1.0 - c;
    let nx2 = ((m[0][0] - c) / t).max(0.0);
    let ny2 = ((m[1][1] - c) / t).max(0.0);
    let nz2 = ((m[2][2] - c) / t).max(0.0);
    let n = if nx2 >= ny2 && nx2 >= nz2 {
        let x = nx2.sqrt();
        Vec3::new(
            x,
            (m[0][1] + m[1][0]) / (2.0 * t * x),
            (m[0][2] + m[2][0]) / (2.0 * t * x),
        )
    } else if ny2 >= nz2 {
        let y = ny2.sqrt();
        Vec3::new(
            (m[0][1] + m[1][0]) / (2.0 * t * y),
            y,
            (m[1][2] + m[2][1]) / (2.0 * t * y),
        )
    } else {
        let z = nz2.sqrt();
        Vec3::new(
            (m[0][2] + m[2][0]) / (2.0 * t * z),
            (m[1][2] + m[2][1]) / (2.0 * t * z),
            z,
        )
    };
    let n = n.normalized().unwrap_or(Vec3::new(1.0, 0.0, 0.0));
    // θ from sin θ via asin — well-conditioned near π (θ = π − asin s,
    // valid because c < 0 puts θ in (π/2, π]). acos(c) would lose ~8
    // digits here.
    let theta = std::f64::consts::PI - s.asin();
    // Sign continuity with the (tiny but signed) antisymmetric part. At
    // exactly θ = π the sign is inherently ambiguous (ω ≡ −ω).
    let n = if n.dot(a) < 0.0 { n.scale(-1.0) } else { n };
    [n.x * theta, n.y * theta, n.z * theta]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    #[test]
    fn rotation_y_sends_z_toward_x() {
        // +90° yaw about +Y maps +Z (forward) to +X.
        let r = Mat3::rotation_y(PI / 2.0);
        let v = r.mul_vec(Vec3::new(0.0, 0.0, 1.0));
        assert!((v.x - 1.0).abs() < 1e-12 && v.y.abs() < 1e-12 && v.z.abs() < 1e-12);
    }

    #[test]
    fn rotation_x_sends_z_toward_minus_y() {
        // +90° pitch about +X maps +Z to −Y (up, in the y-down frame).
        let r = Mat3::rotation_x(PI / 2.0);
        let v = r.mul_vec(Vec3::new(0.0, 0.0, 1.0));
        assert!(v.x.abs() < 1e-12 && (v.y + 1.0).abs() < 1e-12 && v.z.abs() < 1e-12);
    }

    #[test]
    fn transpose_is_inverse_for_rotations() {
        let r = Mat3::rotation_y(0.7).mul_mat(&Mat3::rotation_x(-0.3));
        let i = r.mul_mat(&r.transpose());
        assert!(i.max_abs_diff(&Mat3::identity()) < 1e-12);
    }

    #[test]
    fn axis_angle_matches_elementary_rotations() {
        for a in [-1.2, -0.4, 0.0, 0.3, 1.9] {
            assert!(axis_angle_to_matrix([a, 0.0, 0.0]).max_abs_diff(&Mat3::rotation_x(a)) < 1e-12);
            assert!(axis_angle_to_matrix([0.0, a, 0.0]).max_abs_diff(&Mat3::rotation_y(a)) < 1e-12);
            assert!(axis_angle_to_matrix([0.0, 0.0, a]).max_abs_diff(&Mat3::rotation_z(a)) < 1e-12);
        }
    }

    #[test]
    fn exp_log_round_trip_across_angle_range() {
        // Angles spanning tiny → almost π, axes in assorted directions.
        let axes = [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.6, -0.7, 0.39],
            [-0.2, 0.5, 0.84],
        ];
        // `PI - 9.27e-5` probes the ill-conditioned acos regime that the
        // atan2 formulation exists for (a plain `acos(trace)` log map
        // loses ~7 digits there).
        let angles = [1e-9, 1e-4, 0.1, 1.0, 2.0, 3.0, PI - 9.27e-5, PI - 1e-9, PI];
        for axis in axes {
            let n = Vec3::new(axis[0], axis[1], axis[2]).normalized().unwrap();
            for theta in angles {
                let omega = [n.x * theta, n.y * theta, n.z * theta];
                let r = axis_angle_to_matrix(omega);
                let back = axis_angle_to_matrix(matrix_to_axis_angle(&r));
                assert!(
                    r.max_abs_diff(&back) < 1e-9,
                    "exp∘log != id for axis {axis:?} theta {theta}"
                );
            }
        }
    }

    #[test]
    fn log_of_identity_is_zero() {
        let omega = matrix_to_axis_angle(&Mat3::identity());
        assert_eq!(omega, [0.0, 0.0, 0.0]);
    }
}
