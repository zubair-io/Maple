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
    pub(super) fn is_empty(&self) -> bool {
        self.iter().next().is_none()
    }
    pub(super) fn iter(&self) -> impl ExactSizeIterator<Item = (f32, f32)> + use<'a, '_> {
        let len = match self {
            Self::Owned(v) => v.len(),
            Self::Flat(v) => v.len() / 2,
        };
        (0..len).map(|i| match self {
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
                let mut flat = [0.0; COLOR_CURVES_FLAT_LEN];
                for (chunk, lut) in flat.chunks_exact_mut(COLOR_CURVE_LUT_LEN).zip(luts) {
                    chunk.copy_from_slice(&lut.offsets);
                }
                *cached = Some(CachedLuts {
                    points: curves.map(|points| points.iter().collect()),
                    flat,
                    identity: luts.iter().all(|lut| lut.is_identity),
                });
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
