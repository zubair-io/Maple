//! Named illuminants already used by the XMP reader, shared with UI pickers.
//! These are Robertson slider coordinates; the camera's own SliderFrame maps
//! them through its calibration. They are not sensor-independent RGB gains.
use super::WhiteBalancePreset;

impl WhiteBalancePreset {
    pub const ALL: [Self; 9] = [
        Self::AsShot,
        Self::Auto,
        Self::Daylight,
        Self::Cloudy,
        Self::Shade,
        Self::Tungsten,
        Self::Fluorescent,
        Self::Flash,
        Self::Custom,
    ];

    pub const fn name(self) -> &'static str {
        match self {
            Self::AsShot => "As Shot",
            Self::Auto => "Auto",
            Self::Daylight => "Daylight",
            Self::Cloudy => "Cloudy",
            Self::Shade => "Shade",
            Self::Tungsten => "Tungsten",
            Self::Fluorescent => "Fluorescent",
            Self::Flash => "Flash",
            Self::Custom => "Custom",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|preset| preset.name() == name)
    }

    /// Existing XMP preset values, kept pixel-identical when exposed in #3307.
    /// The ACR named-preset fixture corpus gates these values independently of
    /// the UI. Always persist the resolved pair so reopening never re-estimates.
    pub const fn pair(self) -> Option<(f32, f32)> {
        match self {
            Self::Daylight => Some((5500.0, 10.0)),
            Self::Cloudy => Some((6500.0, 10.0)),
            Self::Shade => Some((7500.0, 10.0)),
            Self::Tungsten => Some((2850.0, 0.0)),
            Self::Fluorescent => Some((3800.0, 21.0)),
            Self::Flash => Some((5500.0, 0.0)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_named_illuminant_matches_the_xmp_reader() {
        for preset in WhiteBalancePreset::ALL {
            assert_eq!(WhiteBalancePreset::from_name(preset.name()), Some(preset));
            if let Some((temperature, tint)) = preset.pair() {
                let model =
                    crate::xmp::parse(&format!("<x crs:WhiteBalance=\"{}\"/>", preset.name()))
                        .unwrap();
                assert_eq!((model.temperature, model.tint), (temperature, tint));
            }
        }
        assert_eq!(WhiteBalancePreset::from_name("unrecognized"), None);
    }
}
