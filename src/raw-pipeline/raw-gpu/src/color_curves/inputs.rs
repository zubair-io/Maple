//! Secondary-curve inputs and a one-entry, per-render-thread baked-LUT cache.
use super::{
    bake_curve_lut, BakedLut, COLOR_CURVES_FLAT_LEN, COLOR_CURVE_LUT_LEN, NUM_COLOR_CURVES,
};
use std::cell::RefCell;

/// Model hosts retain owned point storage; FFI hosts borrow flat C pairs for
/// the duration of the render, without six per-tick Vec allocations.
#[derive(Clone, Debug)]
pub enum ColorCurvePoints<'a> {
    Owned(Vec<(f32, f32)>),
    Flat(&'a [f32]),
}

impl Default for ColorCurvePoints<'_> {
    fn default() -> Self {
        Self::Owned(Vec::new())
    }
}
impl From<Vec<(f32, f32)>> for ColorCurvePoints<'_> {
    fn from(points: Vec<(f32, f32)>) -> Self {
        Self::Owned(points)
    }
}
impl<'a> ColorCurvePoints<'a> {
    pub fn into_owned(self) -> Vec<(f32, f32)> {
        match self {
            Self::Owned(points) => points,
            Self::Flat(_) => self.iter().collect(),
        }
    }
    pub(super) fn iter(&self) -> impl ExactSizeIterator<Item = (f32, f32)> + use<'a, '_> {
        let len = match self {
            Self::Owned(v) => v.len(),
            Self::Flat(v) => v.len() / 2,
        };
        (0..len).map(move |i| match self {
            Self::Owned(v) => v[i],
            Self::Flat(v) => (v[2 * i], v[2 * i + 1]),
        })
    }
}

#[derive(Clone, Debug, Default)]
pub struct ColorCurveInputs<'a> {
    pub hue_vs_hue: ColorCurvePoints<'a>,
    pub hue_vs_sat: ColorCurvePoints<'a>,
    pub hue_vs_luma: ColorCurvePoints<'a>,
    pub luma_vs_sat: ColorCurvePoints<'a>,
    pub sat_vs_sat: ColorCurvePoints<'a>,
    pub sat_vs_luma: ColorCurvePoints<'a>,
}

struct CachedLuts {
    points: [Vec<(f32, f32)>; NUM_COLOR_CURVES],
    flat: [f32; COLOR_CURVES_FLAT_LEN],
    identity: bool,
}
thread_local! {
    static BAKED: RefCell<Option<CachedLuts>> = const { RefCell::new(None) };
}
impl ColorCurveInputs<'_> {
    fn curves(&self) -> [&ColorCurvePoints<'_>; NUM_COLOR_CURVES] {
        [
            &self.hue_vs_hue,
            &self.hue_vs_sat,
            &self.hue_vs_luma,
            &self.luma_vs_sat,
            &self.sat_vs_sat,
            &self.sat_vs_luma,
        ]
    }
    pub(super) fn baked_luts(&self) -> [BakedLut; NUM_COLOR_CURVES] {
        std::array::from_fn(|i| bake_curve_lut(self.curves()[i], i < 3))
    }
    fn with_baked<T>(&self, read: impl FnOnce(&CachedLuts) -> T) -> T {
        BAKED.with(|entry| {
            let mut cached = entry.borrow_mut();
            let curves = self.curves();
            let matches = cached.as_ref().is_some_and(|previous| {
                previous.points.iter().zip(curves).all(|(a, b)| {
                    a.len() == b.iter().len()
                        && a.iter().copied().zip(b.iter()).all(|(a, b)| {
                            a.0.to_bits() == b.0.to_bits() && a.1.to_bits() == b.1.to_bits()
                        })
                })
            });
            if !matches {
                let luts = self.baked_luts();
                let current = cached.get_or_insert_with(|| CachedLuts {
                    points: std::array::from_fn(|_| {
                        Vec::with_capacity(super::lut::EDITOR_MAX_KNOTS)
                    }),
                    flat: [0.0; COLOR_CURVES_FLAT_LEN],
                    identity: true,
                });
                for (snapshot, points) in current.points.iter_mut().zip(curves) {
                    snapshot.clear();
                    snapshot.extend(points.iter());
                }
                for (chunk, lut) in current
                    .flat
                    .chunks_exact_mut(COLOR_CURVE_LUT_LEN)
                    .zip(&luts)
                {
                    chunk.copy_from_slice(&lut.offsets);
                }
                current.identity = luts.iter().all(|lut| lut.is_identity);
            }
            read(cached.as_ref().expect("baked above"))
        })
    }
    pub fn is_identity(&self) -> bool {
        self.with_baked(|cached| cached.identity)
    }
    pub fn to_flat(&self) -> ([f32; COLOR_CURVES_FLAT_LEN], bool) {
        self.with_baked(|cached| (cached.flat, cached.identity))
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    #[test]
    fn changing_authored_points_and_counts_allocate_nothing_after_identity_warmup() {
        ColorCurveInputs::default().to_flat();
        let mut points = [0.0f32; 32];
        let mut elapsed = [std::time::Duration::ZERO; 100];
        let allocations = crate::live_chain::tests::allocations::all_allocations(|| {
            for tick in 0..100 {
                let started = std::time::Instant::now();
                let count = 2 + tick % 15;
                let first_y = 0.15 + (tick % 50) as f32 * 0.01;
                for (index, point) in points[..2 * count].chunks_exact_mut(2).enumerate() {
                    point[0] = index as f32 / (count - 1) as f32;
                    point[1] = first_y + index as f32 * 0.001;
                }
                let curve = ColorCurvePoints::Flat(&points[..2 * count]);
                let inputs = ColorCurveInputs {
                    hue_vs_hue: curve.clone(),
                    hue_vs_sat: curve.clone(),
                    hue_vs_luma: curve.clone(),
                    luma_vs_sat: curve.clone(),
                    sat_vs_sat: curve.clone(),
                    sat_vs_luma: curve,
                };
                assert!(!inputs.is_identity());
                let (flat, identity) = inputs.to_flat();
                assert!(!identity);
                assert_eq!(flat[0], first_y + (count - 1) as f32 * 0.001 - 0.5);
                assert_eq!(flat[3 * COLOR_CURVE_LUT_LEN], first_y - 0.5);
                elapsed[tick] = started.elapsed();
            }
        });
        assert_eq!(allocations, 0);
        elapsed.sort_unstable();
        eprintln!(
            "changed-knot baking: p50={}us p95={}us max={}us, {allocations} allocations",
            elapsed[49].as_secs_f64() * 1e6,
            elapsed[94].as_secs_f64() * 1e6,
            elapsed[99].as_secs_f64() * 1e6
        );
    }

    #[test]
    fn larger_imported_curves_retain_capacity_across_edits_and_identity() {
        let mut points = [0.0f32; 130];
        fn inputs(pairs: &[f32]) -> ColorCurveInputs<'_> {
            let curve = ColorCurvePoints::Flat(pairs);
            ColorCurveInputs {
                hue_vs_hue: curve.clone(),
                hue_vs_sat: curve.clone(),
                hue_vs_luma: curve.clone(),
                luma_vs_sat: curve.clone(),
                sat_vs_sat: curve.clone(),
                sat_vs_luma: curve,
            }
        }
        inputs(&points).to_flat();
        let allocations = crate::live_chain::tests::allocations::all_allocations(|| {
            for tick in 0..100 {
                if tick % 9 == 0 {
                    assert!(ColorCurveInputs::default().is_identity());
                }
                let count = 17 + tick % 49;
                let first_y = 0.15 + (tick % 50) as f32 * 0.01;
                for (index, point) in points[..2 * count].chunks_exact_mut(2).enumerate() {
                    point[0] = index as f32 / (count - 1) as f32;
                    point[1] = first_y + index as f32 * 0.001;
                }
                let (flat, identity) = inputs(&points[..2 * count]).to_flat();
                assert!(!identity);
                assert_eq!(flat[0], first_y + (count - 1) as f32 * 0.001 - 0.5);
                assert_eq!(flat[3 * COLOR_CURVE_LUT_LEN], first_y - 0.5);
            }
        });
        assert_eq!(allocations, 0);
    }

    #[test]
    fn cpu_reference_rebakes_changed_points_without_allocating_after_warmup() {
        use raw_core::stages::color_curves::ColorCurveParams;
        let mut points = [(0.0f32, 0.0f32); 16];
        ColorCurveParams::from_slices(&[], &[], &[], &[], &[], &[]);
        let allocations = crate::live_chain::tests::allocations::all_allocations(|| {
            for tick in 0..100 {
                let count = 2 + tick % 15;
                let first_y = 0.15 + (tick % 50) as f32 * 0.01;
                for (index, point) in points[..count].iter_mut().enumerate() {
                    *point = (
                        index as f32 / (count - 1) as f32,
                        first_y + index as f32 * 0.001,
                    );
                }
                let p = &points[..count];
                let baked = ColorCurveParams::from_slices(p, p, p, p, p, p);
                assert!(!baked.is_identity);
                assert_eq!(
                    baked.hue_vs_hue.offsets[0],
                    first_y + (count - 1) as f32 * 0.001 - 0.5
                );
                assert_eq!(baked.luma_vs_sat.offsets[0], first_y - 0.5);
            }
        });
        assert_eq!(allocations, 0);
    }

    #[test]
    fn legacy_lut_goldens_and_input_representations_are_preserved() {
        let mut cases = vec![
            vec![],
            vec![(0.3, 0.8)],
            vec![
                (1.0, 0.7),
                (0.0, 0.3),
                (0.5, 0.8),
                (0.500001, 0.2),
                (0.5, 0.4),
            ],
            vec![
                (f32::NAN, 0.1),
                (0.2, f32::INFINITY),
                (-0.2, -0.1),
                (1.2, 1.1),
            ],
        ];
        cases.push(
            (0..65)
                .rev()
                .map(|i| (i as f32 / 64.0, (i % 7) as f32 / 8.0 + 0.0625))
                .collect(),
        );
        // Recorded from the pre-scratch baker: every f32 LUT bit and the identity flag.
        let goldens: [[u64; 2]; 5] = [
            [0x3b5f19c031bba62c, 0x3b5f19c031bba62c],
            [0x97ca63bcaf24d1df, 0x97ca63bcaf24d1df],
            [0x40691c3490c173d7, 0xf0fb988652f44242],
            [0x68d1f8ffabf97f88, 0x085b2da970e4afdf],
            [0xda9fd2567158161f, 0x2ff4b959e433e0c9],
        ];
        fn hash(lut: &BakedLut) -> u64 {
            let mut hash = 0xcbf29ce484222325u64;
            for value in lut.offsets {
                for byte in value.to_bits().to_le_bytes() {
                    hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
                }
            }
            (hash ^ u64::from(lut.is_identity)).wrapping_mul(0x100000001b3)
        }
        for (points, goldens) in cases.into_iter().zip(goldens) {
            for (periodic, golden) in [false, true].into_iter().zip(goldens) {
                let gpu = bake_curve_lut(&ColorCurvePoints::Owned(points.clone()), periodic);
                let core = raw_core::stages::color_curves::bake_curve_lut(&points, periodic);
                assert_eq!(hash(&gpu), golden);
                assert_eq!(gpu.is_identity, core.is_identity);
                assert_eq!(
                    gpu.offsets.map(f32::to_bits),
                    core.offsets.map(f32::to_bits)
                );
            }
        }
    }

    #[test]
    fn active_curve_identity_checks_and_encoding_allocate_nothing_after_warmup() {
        let flat = [0.1, 0.7, 0.5, 0.5, 0.9, 0.3];
        let inputs = ColorCurveInputs {
            hue_vs_hue: ColorCurvePoints::Flat(&flat),
            ..Default::default()
        };
        let expected = inputs.to_flat();
        assert!(!expected.1);
        let allocations = crate::live_chain::tests::allocations::all_allocations(|| {
            for _ in 0..100 {
                assert!(!inputs.is_identity());
                assert_eq!(inputs.to_flat(), expected);
            }
        });
        assert_eq!(allocations, 0);
    }

    #[test]
    fn borrowed_and_owned_pairs_share_exact_outputs_and_changes_invalidate() {
        let points = vec![(0.1, 0.7), (0.5, 0.5), (0.9, 0.3)];
        let owned = ColorCurveInputs {
            hue_vs_hue: points.into(),
            ..Default::default()
        };
        let flat = [0.1, 0.7, 0.5, 0.5, 0.9, 0.3];
        let borrowed = ColorCurveInputs {
            hue_vs_hue: ColorCurvePoints::Flat(&flat),
            ..Default::default()
        };
        assert_eq!(owned.to_flat(), borrowed.to_flat());
        let identity = ColorCurveInputs::default();
        assert!(identity.is_identity());
        assert_ne!(borrowed.to_flat(), identity.to_flat());
        assert_eq!(owned.to_flat(), borrowed.to_flat());
    }
}
