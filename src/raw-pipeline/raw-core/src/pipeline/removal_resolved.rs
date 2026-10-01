//! Validated saved calibration stack, prepared once after asset I/O (#3955).
//! Missing or incompatible edits cannot silently produce a partial render.
use crate::{
    cancel::CancelToken,
    image::{Image, RawImage},
    types::{
        accepted_removal::{ContentDigest, RemovalPlate, SourceAnchor},
        InpaintPatch, Removal,
    },
    xmp::AdjustmentModel,
};
use std::collections::BTreeMap;

/// Immutable decoded companions bound to one original, calibration recipe and
/// exact ordered record list. Installed inference models are not needed to open
/// or render an accepted result. Hosts retain this outside the slider loop.
pub struct ResolvedCalibrationRemovals {
    source: SourceAnchor,
    records: ContentDigest,
    patches: Vec<InpaintPatch>,
    needs_review: Vec<usize>,
}

impl ResolvedCalibrationRemovals {
    /// Complete host transfer: digest filenames and lengths describe bytes
    /// concatenated in manifest order. Both C and WASM use this verifier.
    pub fn prepare_bundle(
        raw: &RawImage,
        original: &ContentDigest,
        records: &[Removal],
        manifest: &str,
        bytes: &[u8],
    ) -> Result<Self, String> {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Companion {
            name: String,
            length: usize,
        }
        let encoded = crate::types::inpaint::encode_removals(records)?;
        let expected = super::removal_asset_names(&encoded)?;
        let entries: Vec<Companion> = serde_json::from_str(manifest).map_err(|e| e.to_string())?;
        if entries.len() != expected.len() {
            return Err("saved companion count changed".into());
        }
        let mut assets = BTreeMap::new();
        let mut offset = 0usize;
        for entry in entries {
            if !expected.contains(&entry.name) || assets.contains_key(&entry.name) {
                return Err("unexpected or duplicate saved companion name".into());
            }
            let end = offset
                .checked_add(entry.length)
                .ok_or("saved companion length overflows")?;
            let value = bytes
                .get(offset..end)
                .ok_or("saved companion bundle is truncated")?;
            assets.insert(entry.name, value.to_vec());
            offset = end;
        }
        if offset != bytes.len() {
            return Err("saved companion bundle has trailing bytes".into());
        }
        Self::prepare(raw, original, records, &assets)
    }

    pub fn needs_review(&self) -> &[usize] {
        &self.needs_review
    }

    /// Native authoring input includes the entire ordered accepted stack. Its
    /// frozen dependencies must describe pixels the generator actually saw.
    /// Asset I/O and inference are outside this bounded source operation.
    pub fn generation_context(
        &self,
        raw: &RawImage,
        original: &ContentDigest,
        model: &AdjustmentModel,
        window: crate::types::accepted_removal::NativeWindow,
        cancel: CancelToken<'_>,
    ) -> crate::Result<Image> {
        self.verify_current(raw, original, model)?;
        let mut image = super::render_removal_calibration_context(raw, window, cancel)?;
        if cancel.is_cancelled() {
            return Err(crate::Error::Cancelled);
        }
        crate::stages::inpaint_composite::apply_window(
            &mut image,
            &self.patches,
            window.region(self.source.width, self.source.height),
        )
        .map_err(crate::Error::Pipeline)?;
        Ok(image)
    }

    fn verify_current(
        &self,
        raw: &RawImage,
        original: &ContentDigest,
        model: &AdjustmentModel,
    ) -> crate::Result<()> {
        let source = super::removal_calibration_source_anchor(raw, original)?;
        let encoded = crate::types::inpaint::encode_removals(&model.inpaint_removals)
            .map_err(crate::Error::Pipeline)?;
        if self.source != source || self.records != ContentDigest::for_bytes(encoded.as_bytes()) {
            return Err(crate::Error::Pipeline(
                "saved removal source or stack changed".into(),
            ));
        }
        Ok(())
    }

    /// Verify all companions before making any portion of a stack renderable.
    /// Asset keys are the shared digest basenames, never arbitrary sidecar paths.
    /// The host reads assets before calling; this entry performs no file I/O.
    pub fn prepare(
        raw: &RawImage,
        original: &ContentDigest,
        records: &[Removal],
        assets: &BTreeMap<String, Vec<u8>>,
    ) -> Result<Self, String> {
        let source =
            super::removal_calibration_source_anchor(raw, original).map_err(|e| e.to_string())?;
        let encoded = crate::types::inpaint::encode_removals(records)?;
        let mut patches = Vec::with_capacity(records.len());
        let mut needs_review = Vec::new();
        for (index, removal) in records.iter().enumerate() {
            let accepted = removal.accepted.as_ref().ok_or_else(|| {
                format!("removal {index}: legacy scene plate requires its legacy renderer")
            })?;
            if accepted.plate != RemovalPlate::LinearCalibrationV1 {
                return Err(format!("removal {index}: incompatible post-DCP plate"));
            }
            let mask_name = format!("{}.mask", accepted.mask.hex());
            let patch_name = format!("{}.f16", ContentDigest::parse(&removal.patch_ref)?.hex());
            let mask = assets
                .get(&mask_name)
                .ok_or_else(|| format!("removal {index}: missing companion {mask_name}"))?;
            let patch = assets
                .get(&patch_name)
                .ok_or_else(|| format!("removal {index}: missing companion {patch_name}"))?;
            patches.push(super::resolve_accepted_removal(
                removal, &source, mask, patch,
            )?);
            if super::removal_needs_review(removal, &records[..index])? {
                needs_review.push(index);
            }
        }
        Ok(Self {
            source,
            records: ContentDigest::for_bytes(encoded.as_bytes()),
            patches,
            needs_review,
        })
    }

    /// Native full-frame saved-result qualification. Current source and ordered
    /// metadata must still match preparation; source/stack changes require a new
    /// preparation rather than applying an old result to the new image.
    /// Retained live/tile integration remains tracked by #3955.
    pub fn develop(
        &self,
        raw: &RawImage,
        original: &ContentDigest,
        model: &AdjustmentModel,
        cancel: CancelToken<'_>,
    ) -> crate::Result<Image> {
        self.develop_with_gain(
            raw,
            original,
            model,
            super::RenderQuality::Amaze,
            None,
            cancel,
        )
        .map(|(scene, _)| scene)
    }

    pub(crate) fn develop_with_gain(
        &self,
        raw: &RawImage,
        original: &ContentDigest,
        model: &AdjustmentModel,
        quality: super::RenderQuality,
        max_long_edge: Option<u32>,
        cancel: CancelToken<'_>,
    ) -> crate::Result<(Image, f32)> {
        if cancel.is_cancelled() {
            return Err(crate::Error::Cancelled);
        }
        self.verify_current(raw, original, model)?;
        super::removal_calibration::develop_with_gain(
            raw,
            model,
            quality,
            max_long_edge,
            &self.patches,
            cancel,
        )
    }
}

#[cfg(test)]
#[path = "removal_resolved_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "removal_resolved_display_tests.rs"]
mod display_tests;
