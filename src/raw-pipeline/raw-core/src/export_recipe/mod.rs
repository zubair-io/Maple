//! Versioned, platform-neutral export recipes (#2438). Unsupported choices
//! survive storage, but execution rejects them before touching any output.
//! This model is deliberately separate from authored development adjustments.

use crate::export::{ExportFormat, ExportOptions, ExportedImage};
use crate::{
    film::FilmLut, image::RawImage, pipeline::RawInput, view::encode::TargetPrimaries,
    AdjustmentModel,
};
use serde::{Deserialize, Serialize};

mod tests;

#[derive(Clone, Copy)]
pub enum WireKind {
    Text,
    Number,
    OptionalText,
    OptionalNumber,
}
pub struct RecipeField {
    pub name: &'static str,
    pub kind: WireKind,
}

macro_rules! recipe {
    ($( $field:ident : $ty:ty => $wire:literal, $kind:ident; )*) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct ExportRecipe {
            $( #[serde(rename = $wire)] pub $field: $ty, )*
        }
        pub const RECIPE_FIELDS: &[RecipeField] = &[
            $( RecipeField { name: $wire, kind: WireKind::$kind }, )*
        ];
    };
}

recipe! {
    schema_version: u32 => "schemaVersion", Number;
    name: String => "name", Text;
    format: String => "format", Text;
    quality: Option<u32> => "quality", OptionalNumber;
    bit_depth: u32 => "bitDepth", Number;
    max_long_edge: Option<u32> => "maxLongEdge", OptionalNumber;
    output_profile: String => "outputProfile", Text;
    rendering_intent: String => "renderingIntent", Text;
    metadata_policy: String => "metadataPolicy", Text;
    naming_template: String => "namingTemplate", Text;
    destination: String => "destination", Text;
    directory: Option<String> => "directory", OptionalText;
    watermark: Option<String> => "watermark", OptionalText;
    overwrite_policy: String => "overwritePolicy", Text;
}

pub const RECIPE_VERSION: u32 = 1;
/// The canonical encoder owns these capabilities; native and WASM share it.
pub const ENCODERS: &[(&str, u32, &str)] =
    &[("jpeg", 8, "jpg"), ("tiff", 16, "tif"), ("png", 8, "png")];
pub const OUTPUT_PROFILES: &[&str] = &["srgb", "display-p3"];
/// The existing display transform and gamut compression, not an ICC CMS intent.
pub const RENDERING_INTENTS: &[&str] = &["maple-display"];
pub const METADATA_POLICIES: &[&str] = &["strip"];

impl Default for ExportRecipe {
    fn default() -> Self {
        Self {
            schema_version: RECIPE_VERSION,
            name: "JPEG sharing".into(),
            format: "jpeg".into(),
            quality: Some(92),
            bit_depth: 8,
            max_long_edge: None,
            output_profile: "srgb".into(),
            rendering_intent: "maple-display".into(),
            metadata_policy: "strip".into(),
            naming_template: "{original}.{ext}".into(),
            destination: "download".into(),
            directory: None,
            watermark: None,
            overwrite_policy: "browser".into(),
        }
    }
}

impl ExportRecipe {
    pub fn parse(json: &str) -> Result<Self, String> {
        let value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let object = value.as_object().ok_or("recipe must be an object")?;
        // Option fields are required too: null carries an explicit no-policy choice.
        for field in RECIPE_FIELDS {
            if !object.contains_key(field.name) {
                return Err(format!("recipe is missing {}", field.name));
            }
        }
        let recipe: Self = serde_json::from_value(value).map_err(|e| e.to_string())?;
        if recipe.schema_version != RECIPE_VERSION {
            return Err(format!(
                "unsupported recipe schema version {}",
                recipe.schema_version
            ));
        }
        Ok(recipe)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != RECIPE_VERSION {
            return Err("unsupported recipe schemaVersion".into());
        }
        if self.name.trim().is_empty() || self.name.chars().count() > 80 {
            return Err("recipe name must contain 1–80 characters".into());
        }
        let (_, depth, _) = ENCODERS
            .iter()
            .find(|(format, _, _)| *format == self.format)
            .ok_or_else(|| {
                format!(
                    "unsupported format: {} (choose jpeg, tiff or png)",
                    self.format
                )
            })?;
        if self.bit_depth != *depth {
            return Err(format!("{} requires bitDepth {}", self.format, depth));
        }
        if self.format == "jpeg" {
            if !matches!(self.quality, Some(1..=100)) {
                return Err("JPEG quality must be 1–100".into());
            }
        } else if self.quality.is_some() {
            return Err("lossless formats require quality: null".into());
        }
        if matches!(self.max_long_edge, Some(0)) {
            return Err("maxLongEdge must be positive or null for full resolution".into());
        }
        if !OUTPUT_PROFILES.contains(&self.output_profile.as_str()) {
            return Err(format!(
                "unsupported outputProfile: {}",
                self.output_profile
            ));
        }
        if !RENDERING_INTENTS.contains(&self.rendering_intent.as_str()) {
            return Err(
                "renderingIntent must be maple-display; ICC CMS intents are not implemented".into(),
            );
        }
        if !METADATA_POLICIES.contains(&self.metadata_policy.as_str()) {
            return Err("metadataPolicy must be strip; ICC tagging is always retained".into());
        }
        if self.watermark.is_some() {
            return Err("watermarks are not supported by this encoder".into());
        }
        if self.naming_template.len() > 255 {
            return Err("namingTemplate exceeds 255 bytes".into());
        }
        self.filename("photo", None, 0)?;
        match self.destination.as_str() {
            "download" if self.directory.is_none() && self.overwrite_policy == "browser" => {},
            "directory" if self.directory.as_ref().is_some_and(|p| !p.trim().is_empty())
                && ["error", "skip", "replace"].contains(&self.overwrite_policy.as_str()) => {},
            _ => return Err("destination must be download with browser overwrite policy, or directory with a directory and error/skip/replace policy".into()),
        }
        Ok(())
    }

    pub fn filename(
        &self,
        stem: &str,
        captured_at: Option<&str>,
        index: u64,
    ) -> Result<String, String> {
        let ext = ENCODERS
            .iter()
            .find(|(f, _, _)| *f == self.format)
            .map(|(_, _, ext)| *ext)
            .ok_or("unsupported format")?;
        let name = crate::filename::render_filename(
            &self.naming_template,
            &crate::filename::RenderInputs {
                original_stem: stem,
                ext,
                index,
                captured_at,
            },
            &crate::filename::SequenceOptions {
                start: 1,
                pad_width: 0,
            },
        )
        .map_err(|e| e.to_string())?;
        if !name.ends_with(&format!(".{ext}")) {
            return Err(format!(
                "namingTemplate must produce the .{ext} extension; use {{ext}}"
            ));
        }
        Ok(name)
    }

    pub fn options(&self) -> Result<ExportOptions, String> {
        self.validate()?;
        Ok(ExportOptions {
            format: ExportFormat::from_str(&self.format).ok_or("unsupported format")?,
            quality: self.quality.unwrap_or(92) as u8,
            target: if self.output_profile == "display-p3" {
                TargetPrimaries::P3
            } else {
                TargetPrimaries::Srgb
            },
            max_long_edge: self.max_long_edge,
        })
    }
}

/// Uses exactly the existing export develop/terminal conversion/ICC encoders.
/// A selected but unresolved look fails explicitly rather than losing the look.
pub fn export_with_recipe(
    raw: &RawImage,
    model: &AdjustmentModel,
    source: Option<RawInput<'_>>,
    recipe: &ExportRecipe,
    film: Option<&FilmLut>,
) -> Result<ExportedImage, String> {
    let options = recipe.options()?;
    if !model.film_look.is_empty() && film.is_none() {
        return Err(format!("film LUT unavailable: {}", model.film_look));
    }
    crate::export::export_from_raw_with_film(raw, model, source, &options, film)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod render_tests;
