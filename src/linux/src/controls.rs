//! The initial Linux editing surface; values/ranges/defaults stay in raw-core.

use raw_core::types::adjustment::{
    AdjustmentModel, FieldSpec, WbSource, ADJUSTMENT_SCHEMA, TRANSFER_XMP_ATTRIBUTES,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    Light,
    Color,
    Effects,
    Detail,
    Film,
}

macro_rules! controls {
    ($(($variant:ident, $field:ident, $label:literal, $group:ident)),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum Control { $($variant),+ }
        impl Control {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
            pub fn name(self) -> &'static str { match self { $(Self::$variant => stringify!($field)),+ } }
            pub fn label(self) -> &'static str { match self { $(Self::$variant => $label),+ } }
            pub fn group(self) -> Group { match self { $(Self::$variant => Group::$group),+ } }
            pub fn xmp(self) -> &'static str {
                TRANSFER_XMP_ATTRIBUTES.iter().find(|(name, _)| *name == self.name()).expect("Control has a canonical XMP wire key").1[0]
            }
            pub fn get(self, model: &AdjustmentModel) -> f32 { match self { $(Self::$variant => model.$field),+ } }
            fn assign(self, model: &mut AdjustmentModel, value: f32) { match self { $(Self::$variant => model.$field = value),+ } }
        }
    };
}

controls!(
    (Temperature, temperature, "Temperature", Color),
    (Tint, tint, "Tint", Color),
    (Exposure, exposure, "Exposure", Light),
    (Brightness, brightness, "Brightness", Light),
    (Contrast, contrast, "Contrast", Light),
    (Highlights, highlights, "Highlights", Light),
    (Shadows, shadows, "Shadows", Light),
    (Whites, whites, "Whites", Light),
    (Blacks, blacks, "Blacks", Light),
    (Vibrance, vibrance, "Vibrance", Color),
    (Saturation, saturation, "Saturation", Color),
    (Clarity, clarity, "Clarity", Effects),
    (Texture, texture, "Texture", Effects),
    (Dehaze, dehaze, "Dehaze", Effects),
    (SharpenAmount, sharpen_amount, "Sharpening", Detail),
    (SharpenRadius, sharpen_radius, "Radius", Detail),
    (SharpenDetail, sharpen_detail, "Detail", Detail),
    (SharpenMasking, sharpen_masking, "Masking", Detail),
    (NrLuminance, nr_luminance, "Luminance noise", Detail),
    (NrColor, nr_color, "Color noise", Detail),
    (FilmStrength, film_strength, "Strength", Film),
);

impl Control {
    pub fn spec(self) -> &'static FieldSpec {
        ADJUSTMENT_SCHEMA
            .iter()
            .find(|spec| spec.name == self.name())
            .expect("Linux controls reference canonical schema fields")
    }

    pub fn step(self) -> f32 {
        let (min, max) = self.spec().range;
        match max - min {
            span if span <= 10.0 => 0.01,
            span if span >= 5000.0 => 50.0,
            _ => 1.0,
        }
    }

    pub fn set(self, model: &mut AdjustmentModel, value: f32) -> Result<(), String> {
        let (min, max) = self.spec().range;
        if !value.is_finite() || !(min..=max).contains(&value) {
            return Err(format!("{} must be between {min} and {max}", self.label()));
        }
        self.assign(model, value);
        if matches!(self, Self::Temperature | Self::Tint) {
            model.temperature_seen = true;
            model.tint_seen = true;
            model.wb_source = WbSource::Manual;
            model.wb_sample_x = 0.0;
            model.wb_sample_y = 0.0;
            model.wb_algorithm_version = 0.0;
        }
        Ok(())
    }
}
