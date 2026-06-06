//! Per-image color LUT: a smooth Nᶟ RGB→RGB grid applied by trilinear interpolation.
//! Value-keyed (no atan2 / ÷L) + smooth ⇒ spatially coherent (cannot blotch).
use rayon::prelude::*;

/// Grid layout matches `bake.rs`: index = ((b*N + g)*N + r)*3 + c, values in [0,1].
#[derive(Clone, Debug, PartialEq)]
pub struct ColorLut {
    pub size: usize,
    pub data: Vec<f32>,
}

impl ColorLut {
    /// Identity LUT of `size` nodes per axis (clamped to ≥2).
    pub fn identity(size: usize) -> Self {
        let n = size.max(2);
        let mut data = vec![0.0f32; n * n * n * 3];
        let denom = (n - 1) as f32;
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let i = ((b * n + g) * n + r) * 3;
                    data[i] = r as f32 / denom;
                    data[i + 1] = g as f32 / denom;
                    data[i + 2] = b as f32 / denom;
                }
            }
        }
        Self { size: n, data }
    }

    #[inline]
    fn node(&self, r: usize, g: usize, b: usize) -> [f32; 3] {
        let n = self.size;
        let i = ((b * n + g) * n + r) * 3;
        [self.data[i], self.data[i + 1], self.data[i + 2]]
    }

    /// Trilinear lookup of one RGB triplet (inputs clamped to [0,1]).
    pub fn sample(&self, rgb: [f32; 3]) -> [f32; 3] {
        let n = self.size;
        let last = (n - 1) as f32;
        let mut lo = [0usize; 3];
        let mut f = [0f32; 3];
        for c in 0..3 {
            let p = rgb[c].clamp(0.0, 1.0) * last;
            let l = p.floor().min(last - 1.0);
            lo[c] = l as usize;
            f[c] = p - l;
        }
        let mut out = [0f32; 3];
        for c in 0..3 {
            let c000 = self.node(lo[0], lo[1], lo[2])[c];
            let c100 = self.node(lo[0] + 1, lo[1], lo[2])[c];
            let c010 = self.node(lo[0], lo[1] + 1, lo[2])[c];
            let c110 = self.node(lo[0] + 1, lo[1] + 1, lo[2])[c];
            let c001 = self.node(lo[0], lo[1], lo[2] + 1)[c];
            let c101 = self.node(lo[0] + 1, lo[1], lo[2] + 1)[c];
            let c011 = self.node(lo[0], lo[1] + 1, lo[2] + 1)[c];
            let c111 = self.node(lo[0] + 1, lo[1] + 1, lo[2] + 1)[c];
            let c00 = c000 * (1.0 - f[0]) + c100 * f[0];
            let c10 = c010 * (1.0 - f[0]) + c110 * f[0];
            let c01 = c001 * (1.0 - f[0]) + c101 * f[0];
            let c11 = c011 * (1.0 - f[0]) + c111 * f[0];
            let c0 = c00 * (1.0 - f[1]) + c10 * f[1];
            let c1 = c01 * (1.0 - f[1]) + c11 * f[1];
            out[c] = c0 * (1.0 - f[2]) + c1 * f[2];
        }
        out
    }

    /// Apply in place to an interleaved RGB f32 buffer (DisplayEncodedSrgb, [0,1]).
    pub fn apply(&self, rgb: &mut [f32]) {
        rgb.par_chunks_mut(3).for_each(|p| {
            let o = self.sample([p[0], p[1], p[2]]);
            p[0] = o[0];
            p[1] = o[1];
            p[2] = o[2];
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_lut_is_noop() {
        let lut = ColorLut::identity(17);
        let mut px = vec![0.2f32, 0.5, 0.8, 0.0, 1.0, 0.33];
        let before = px.clone();
        lut.apply(&mut px);
        for (a, b) in px.iter().zip(&before) {
            assert!((a - b).abs() < 1e-4, "{a} vs {b}");
        }
    }

    #[test]
    fn trilinear_recovers_node_values() {
        // A LUT that adds +0.1 to red everywhere: sampling returns node+shift.
        let mut lut = ColorLut::identity(9);
        for n in lut.data.chunks_mut(3) {
            n[0] = (n[0] + 0.1).min(1.0);
        }
        let mut px = vec![0.5f32, 0.5, 0.5];
        lut.apply(&mut px);
        assert!((px[0] - 0.6).abs() < 1e-3, "got {}", px[0]);
        assert!((px[1] - 0.5).abs() < 1e-3);
    }
}
