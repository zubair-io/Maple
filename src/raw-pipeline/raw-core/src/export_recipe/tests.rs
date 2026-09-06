#[cfg(test)]
mod tests {
    use super::super::*;
    #[test]
    fn recipe_round_trip_preserves_every_declared_field_and_rejects_unknowns() {
        let original = ExportRecipe::default();
        let json = serde_json::to_string(&original).unwrap();
        assert_eq!(ExportRecipe::parse(&json).unwrap(), original);
        let mut value = serde_json::to_value(&original).unwrap();
        value["unsupportedFutureField"] = 1.into();
        assert!(ExportRecipe::parse(&value.to_string()).is_err());
        value
            .as_object_mut()
            .unwrap()
            .remove("unsupportedFutureField");
        value.as_object_mut().unwrap().remove("watermark");
        assert!(ExportRecipe::parse(&value.to_string()).is_err());
        assert_eq!(
            serde_json::to_value(original)
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            RECIPE_FIELDS.len()
        );
    }
    #[test]
    fn capabilities_fail_closed_without_changing_stored_choices() {
        let mut recipe = ExportRecipe::default();
        recipe.validate().unwrap();
        recipe.rendering_intent = "relative-colorimetric".into();
        assert!(recipe.validate().unwrap_err().contains("renderingIntent"));
        assert_eq!(
            ExportRecipe::parse(&serde_json::to_string(&recipe).unwrap()).unwrap(),
            recipe
        );
        recipe.rendering_intent = "maple-display".into();
        recipe.format = "tiff".into();
        assert!(recipe.validate().is_err());
        recipe.quality = None;
        recipe.bit_depth = 16;
        recipe.validate().unwrap();
        recipe.watermark = Some("Copyright photographer".into());
        assert!(recipe.validate().unwrap_err().contains("watermarks"));
    }
    #[test]
    fn filename_uses_shared_engine_and_rejects_paths_or_misleading_extensions() {
        let mut recipe = ExportRecipe::default();
        recipe.naming_template = "{original}_{n}.{ext}".into();
        assert_eq!(recipe.filename("DSC123", None, 4).unwrap(), "DSC123_5.jpg");
        recipe.naming_template = "../{original}.{ext}".into();
        assert!(recipe.validate().is_err());
        recipe.naming_template = "{original}.png".into();
        assert!(recipe.validate().is_err());
    }
}
