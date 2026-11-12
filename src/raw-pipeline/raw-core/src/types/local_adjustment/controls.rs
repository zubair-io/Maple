//! Slider domains for a layer's local controls and its colour range — the
//! one table hosts read instead of hand-copying ranges into each panel
//! (`docs/design/maple-ui/components/mask-panel.md`).
//!
//! `name` is the `PartialAdjustments` / `RangeRefinement::Color` field name.
//! Local temperature is a Kelvin DELTA off the frame's white point
//! (`stages::local_adjustments::apply_pixel`), not the absolute CCT the
//! global slider carries; exposure is EV (the stage applies `exp2(ev)`).

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LocalControl {
    pub name: &'static str,
    pub label: &'static str,
    pub min: f32,
    pub max: f32,
    pub step: f32,
}

const fn control(
    name: &'static str,
    label: &'static str,
    min: f32,
    max: f32,
    step: f32,
) -> LocalControl {
    LocalControl {
        name,
        label,
        min,
        max,
        step,
    }
}

/// The eleven point controls in `apply_pixel` order, then the six spatial
/// controls (#3407) in Lightroom's panel order.
pub const LOCAL_CONTROLS: [LocalControl; 17] = [
    control("exposure", "Exposure", -4.0, 4.0, 0.05),
    control("contrast", "Contrast", -100.0, 100.0, 1.0),
    control("highlights", "Highlights", -100.0, 100.0, 1.0),
    control("shadows", "Shadows", -100.0, 100.0, 1.0),
    control("whites", "Whites", -100.0, 100.0, 1.0),
    control("blacks", "Blacks", -100.0, 100.0, 1.0),
    control("hue", "Hue", -100.0, 100.0, 1.0),
    control("saturation", "Saturation", -100.0, 100.0, 1.0),
    control("vibrance", "Vibrance", -100.0, 100.0, 1.0),
    control("temperature", "Temp", -2000.0, 2000.0, 10.0),
    control("tint", "Tint", -150.0, 150.0, 1.0),
    control("texture", "Texture", -100.0, 100.0, 1.0),
    control("clarity", "Clarity", -100.0, 100.0, 1.0),
    control("dehaze", "Dehaze", -100.0, 100.0, 1.0),
    control("sharpness", "Sharpness", -100.0, 100.0, 1.0),
    control("luminance_noise", "Noise", 0.0, 100.0, 1.0),
    control("defringe", "Defringe", 0.0, 100.0, 1.0),
];

/// The five colour-range coordinates a panel exposes; the hue itself is
/// seeded by the eyedropper (`stages::mask_range_sample`). Oklab chroma of a
/// saturated colour tops out near 0.3.
pub const RANGE_CONTROLS: [LocalControl; 5] = [
    control("hue_half_width_deg", "Hue width", 1.0, 90.0, 1.0),
    control("chroma_min", "Chroma min", 0.0, 0.3, 0.005),
    control("l_min", "L min", 0.0, 1.0, 0.01),
    control("l_max", "L max", 0.0, 1.0, 0.01),
    control("feather", "Feather", 0.0, 1.0, 0.01),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_domain_is_well_formed_and_named_once() {
        for table in [&LOCAL_CONTROLS[..], &RANGE_CONTROLS[..]] {
            for (index, entry) in table.iter().enumerate() {
                assert!(entry.min < entry.max && entry.step > 0.0, "{entry:?}");
                assert!(entry.step <= entry.max - entry.min, "{entry:?}");
                assert!(table[..index].iter().all(|other| other.name != entry.name));
            }
        }
    }

    #[test]
    fn the_skin_preset_sits_inside_the_range_domains() {
        let crate::types::RangeRefinement::Color {
            hue_half_width_deg,
            chroma_min,
            l_min,
            l_max,
            feather,
            ..
        } = crate::types::SKIN_TONE_RANGE;
        for (value, entry) in [hue_half_width_deg, chroma_min, l_min, l_max, feather]
            .into_iter()
            .zip(RANGE_CONTROLS)
        {
            assert!((entry.min..=entry.max).contains(&value), "{entry:?}");
        }
    }
}
