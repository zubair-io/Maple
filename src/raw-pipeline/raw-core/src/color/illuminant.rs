use crate::math::Vec3;

/// DNG CalibrationIlluminant. Spec § 3.4.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum Illuminant {
    StdA,
    D50,
    D55,
    D65,
    Other(u32),
}

impl Illuminant {
    /// Approximate correlated color temperature in Kelvin.
    pub fn cct(self) -> f32 {
        match self {
            Self::StdA => 2856.0,
            Self::D50 => 5003.0,
            Self::D55 => 5503.0,
            Self::D65 => 6504.0,
            Self::Other(k) => k as f32,
        }
    }

    pub fn xyz(self) -> Vec3 {
        match self {
            Self::StdA => [1.0985, 1.0000, 0.3558],
            Self::D50 => [0.9642, 1.0000, 0.8251],
            Self::D55 => [0.9568, 1.0000, 0.9214],
            Self::D65 => [0.9504, 1.0000, 1.0888],
            Self::Other(_) => [0.9504, 1.0000, 1.0888],
        }
    }
}
