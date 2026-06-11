//! SplitMix64 — tiny deterministic PRNG for the ground-truth renderer.
//!
//! `rand` is deliberately not a dependency: the renderer needs a PRNG
//! *stream* that is stable across platforms and crate-version bumps, so
//! the generator is pinned in-tree (the stream is pure integer math). Note
//! this stabilizes only the randomness — whole-output byte-identity is
//! guaranteed per platform + toolchain, not across them, because
//! transcendental math and PNG encoding can differ between targets (see
//! the determinism note in `render`). SplitMix64 is the standard
//! 64-bit mixer from Steele et al., "Fast Splittable Pseudorandom Number
//! Generators" (OOPSLA 2014); passes BigCrush, one u64 of state.

/// SplitMix64 generator. Identical seed → identical stream, forever.
#[derive(Debug, Clone)]
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    /// Next raw 64-bit value.
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform `f64` in `[0, 1)`, from the top 53 bits.
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// Uniform `f64` in `[lo, hi)`.
    pub fn next_range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next_f64()
    }

    /// Uniformly distributed unit vector on the sphere
    /// (z uniform in [−1, 1), azimuth uniform — the archimedes map).
    pub fn next_unit_vector(&mut self) -> crate::math::Vec3 {
        let z = self.next_range(-1.0, 1.0);
        let az = self.next_range(0.0, std::f64::consts::TAU);
        let r = (1.0 - z * z).max(0.0).sqrt();
        crate::math::Vec3::new(r * az.cos(), r * az.sin(), z)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_first_values_for_seed_zero() {
        // Reference values from the canonical SplitMix64 (seed = 0).
        let mut rng = SplitMix64::new(0);
        assert_eq!(rng.next_u64(), 0xE220_A839_7B1D_CDAF);
        assert_eq!(rng.next_u64(), 0x6E78_9E6A_A1B9_65F4);
        assert_eq!(rng.next_u64(), 0x06C4_5D18_8009_454F);
    }

    #[test]
    fn same_seed_same_stream() {
        let mut a = SplitMix64::new(42);
        let mut b = SplitMix64::new(42);
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn f64_stays_in_unit_interval() {
        let mut rng = SplitMix64::new(7);
        for _ in 0..1000 {
            let v = rng.next_f64();
            assert!((0.0..1.0).contains(&v));
        }
    }

    #[test]
    fn unit_vectors_are_unit_length() {
        let mut rng = SplitMix64::new(9);
        for _ in 0..100 {
            let v = rng.next_unit_vector();
            assert!((v.norm() - 1.0).abs() < 1e-12);
        }
    }
}
