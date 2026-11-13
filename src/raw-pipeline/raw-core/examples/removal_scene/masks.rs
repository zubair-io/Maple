//! Real intent/hole/coverage inputs for the native RAW qualification harness.
use raw_core::stages::removal_generation::{prepare_json, GenerationMaskRequest};
use raw_core::types::accepted_removal::{ContentDigest, NativeWindow};
use serde::{Deserialize, Serialize};
use std::path::Path;

type ProbeResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Recipe {
    request: GenerationMaskRequest,
    intent: ContentDigest,
    protected: Option<ContentDigest>,
    planes: ContentDigest,
    release_qualified: bool,
}

pub fn write(
    directory: &Path,
    intent: &Path,
    protected: Option<&Path>,
    request: GenerationMaskRequest,
    source: [u32; 2],
) -> ProbeResult<()> {
    let intent = std::fs::read(intent)?;
    let protected = protected
        .map(std::fs::read)
        .transpose()?
        .unwrap_or_default();
    let geometry = raw_core::pipeline::removal_mask_from_bytes(&intent)?;
    if [geometry.source_width, geometry.source_height] != source {
        return Err("generation intent differs from the RAW context source".into());
    }
    let values = prepare_json(&serde_json::to_string(&request)?, &intent, &protected)?;
    let planes: Vec<u8> = values.into_iter().flat_map(f32::to_le_bytes).collect();
    let recipe = Recipe {
        request,
        intent: ContentDigest::for_bytes(&intent),
        protected: (!protected.is_empty()).then(|| ContentDigest::for_bytes(&protected)),
        planes: ContentDigest::for_bytes(&planes),
        release_qualified: false,
    };
    std::fs::write(directory.join("intent.mimf"), intent)?;
    if !protected.is_empty() {
        std::fs::write(directory.join("protected.mimf"), protected)?;
    }
    std::fs::write(directory.join("masks.f32"), planes)?;
    std::fs::write(
        directory.join("masks.json"),
        serde_json::to_vec_pretty(&recipe)?,
    )?;
    Ok(())
}

/// Revalidate actual intent, protection and prepared planes before baking.
/// A legacy central-square experiment remains available only when neither
/// mask file exists; a partial new recipe cannot silently use that fallback.
pub fn coverage(
    directory: &Path,
    window: NativeWindow,
    source: [u32; 2],
) -> ProbeResult<(Vec<f32>, Option<ContentDigest>)> {
    if !directory.join("masks.json").exists() && !directory.join("masks.f32").exists() {
        return Ok((
            (0..1024 * 1024)
                .map(|i| {
                    if (412..612).contains(&(i % 1024)) && (412..612).contains(&(i / 1024)) {
                        1.0
                    } else {
                        0.0
                    }
                })
                .collect(),
            None,
        ));
    }
    let recipe: Recipe = serde_json::from_slice(&std::fs::read(directory.join("masks.json"))?)?;
    if recipe.release_qualified || recipe.request.window != window {
        return Err("generation mask recipe differs from the experimental RAW context".into());
    }
    let intent = std::fs::read(directory.join("intent.mimf"))?;
    recipe.intent.verify(&intent)?;
    let geometry = raw_core::pipeline::removal_mask_from_bytes(&intent)?;
    if [geometry.source_width, geometry.source_height] != source {
        return Err("generation mask recipe source differs".into());
    }
    let protected = match &recipe.protected {
        Some(digest) => {
            let bytes = std::fs::read(directory.join("protected.mimf"))?;
            digest.verify(&bytes)?;
            bytes
        }
        None => Vec::new(),
    };
    let expected = prepare_json(
        &serde_json::to_string(&recipe.request)?,
        &intent,
        &protected,
    )?;
    let planes = std::fs::read(directory.join("masks.f32"))?;
    recipe.planes.verify(&planes)?;
    let actual: Vec<_> = planes
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect();
    if planes.len() != expected.len() * 4
        || actual
            .iter()
            .zip(&expected)
            .any(|(a, b)| a.to_bits() != b.to_bits())
    {
        return Err("generation masks differ from the shared native preparation".into());
    }
    Ok((actual[actual.len() / 2..].to_vec(), Some(recipe.planes)))
}
