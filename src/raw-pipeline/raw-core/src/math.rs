use bytemuck::{Pod, Zeroable};

#[repr(C)]
#[derive(Copy, Clone, Debug, PartialEq, Pod, Zeroable)]
pub struct Matrix3(pub [[f32; 3]; 3]);

pub type Vec3 = [f32; 3];

impl Matrix3 {
    pub const IDENTITY: Self = Self([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);

    pub fn mul_vec(&self, v: Vec3) -> Vec3 {
        let m = &self.0;
        [
            m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
        ]
    }

    pub fn mul_mat(&self, other: &Self) -> Self {
        let a = &self.0;
        let b = &other.0;
        let mut out = [[0.0f32; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
            }
        }
        Self(out)
    }

    pub fn inverse(&self) -> Option<Self> {
        let m = &self.0;
        let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        if det.abs() < 1e-12 {
            return None;
        }
        let inv_det = 1.0 / det;
        let mut out = [[0.0f32; 3]; 3];
        out[0][0] = (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_det;
        out[0][1] = -(m[0][1] * m[2][2] - m[0][2] * m[2][1]) * inv_det;
        out[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det;
        out[1][0] = -(m[1][0] * m[2][2] - m[1][2] * m[2][0]) * inv_det;
        out[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det;
        out[1][2] = -(m[0][0] * m[1][2] - m[0][2] * m[1][0]) * inv_det;
        out[2][0] = (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_det;
        out[2][1] = -(m[0][0] * m[2][1] - m[0][1] * m[2][0]) * inv_det;
        out[2][2] = (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det;
        Some(Self(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32, eps: f32) -> bool {
        (a - b).abs() < eps
    }

    #[test]
    fn identity_is_identity() {
        let v = [0.2, 0.5, 0.8];
        assert_eq!(Matrix3::IDENTITY.mul_vec(v), v);
    }

    #[test]
    fn mul_mat_is_associative_against_identity() {
        let a = Matrix3([[2.0, 0.0, 0.0], [0.0, 3.0, 0.0], [0.0, 0.0, 4.0]]);
        assert_eq!(a.mul_mat(&Matrix3::IDENTITY), a);
        assert_eq!(Matrix3::IDENTITY.mul_mat(&a), a);
    }

    #[test]
    fn diagonal_inverse_is_reciprocal() {
        let a = Matrix3([[2.0, 0.0, 0.0], [0.0, 3.0, 0.0], [0.0, 0.0, 4.0]]);
        let inv = a.inverse().unwrap();
        let expect = Matrix3([[0.5, 0.0, 0.0], [0.0, 1.0 / 3.0, 0.0], [0.0, 0.0, 0.25]]);
        for i in 0..3 {
            for j in 0..3 {
                assert!(approx(inv.0[i][j], expect.0[i][j], 1e-6));
            }
        }
    }

    #[test]
    fn inverse_round_trip() {
        let a = Matrix3([
            [0.7328, 0.4296, -0.1624],
            [-0.7036, 1.6975, 0.0061],
            [0.0030, 0.0136, 0.9834],
        ]);
        let inv = a.inverse().unwrap();
        let product = a.mul_mat(&inv);
        for i in 0..3 {
            for j in 0..3 {
                let expect = if i == j { 1.0 } else { 0.0 };
                assert!(approx(product.0[i][j], expect, 1e-5));
            }
        }
    }
}
