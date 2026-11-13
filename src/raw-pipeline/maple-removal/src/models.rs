//! Concrete artifact pins. Hash the same bytes consumed by ORT, avoiding a
//! verification/read race. These exports are experimental, not release models.
use crate::{OrtRuntime, RemovalInferenceError, Result};
use ort::{session::Session, tensor::TensorElementType, value::ValueType};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};

const LAMA_SIDE: i64 =
    raw_core::types::removal_models::EXPERIMENTAL_REMOVAL_MODELS[0].native_side as i64;

pub(crate) enum Model {
    Lama,
    Encoder,
    Decoder,
    Detector,
}

impl Model {
    fn pin(&self) -> raw_core::types::removal_models::ExperimentalRemovalModelPin {
        let index = match self {
            Self::Lama => 0,
            Self::Encoder => 1,
            Self::Decoder => 2,
            Self::Detector => 3,
        };
        raw_core::types::removal_models::EXPERIMENTAL_REMOVAL_MODELS[index]
    }
}

fn model_error(message: impl Into<String>) -> RemovalInferenceError {
    RemovalInferenceError::Model(message.into())
}

fn verified_bytes(path: &Path, size: u64, expected: &str) -> Result<Vec<u8>> {
    let file = File::open(path).map_err(|e| model_error(format!("{}: {e}", path.display())))?;
    if file
        .metadata()
        .map_err(|e| model_error(e.to_string()))?
        .len()
        != size
    {
        return Err(model_error("artifact size mismatch"));
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(size + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| model_error(e.to_string()))?;
    if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(&bytes)) != expected {
        return Err(model_error("artifact checksum mismatch"));
    }
    Ok(bytes)
}

pub(crate) fn load(model: Model, directory: &Path, _runtime: &OrtRuntime) -> Result<Session> {
    load_verified(model, directory, _runtime).map(|(session, _)| session)
}

pub(crate) fn load_verified(
    model: Model,
    directory: &Path,
    _runtime: &OrtRuntime,
) -> Result<(Session, raw_core::types::accepted_removal::ContentDigest)> {
    let pin = model.pin();
    let bytes = verified_bytes(&directory.join(pin.file), pin.size, pin.sha256)?;
    let digest = raw_core::types::accepted_removal::ContentDigest::for_bytes(&bytes);
    let session = Session::builder()?
        .with_intra_threads(4)?
        .with_inter_threads(1)?
        .commit_from_memory(&bytes)?;
    let float = TensorElementType::Float32;
    let int = TensorElementType::Int64;
    let inputs: Vec<(&str, TensorElementType, &[i64])> = match model {
        Model::Lama => vec![(
            "masked_image_and_mask",
            float,
            &[1, 4, LAMA_SIDE, LAMA_SIDE],
        )],
        Model::Encoder => vec![("image", float, &[1, 3, 1024, 1024])],
        Model::Decoder => vec![
            ("image_embeddings", float, &[1, 256, 64, 64]),
            ("point_coords", float, &[1, -1, 2]),
            ("point_labels", float, &[1, -1]),
            ("mask_input", float, &[1, 1, 256, 256]),
            ("has_mask_input", float, &[1]),
            ("orig_im_size", float, &[2]),
        ],
        Model::Detector => vec![
            ("images", float, &[1, 3, 640, 640]),
            ("orig_target_sizes", int, &[1, 2]),
        ],
    };
    let outputs: Vec<(&str, TensorElementType, &[i64])> = match model {
        Model::Lama => vec![("generated_rgb", float, &[1, 3, LAMA_SIDE, LAMA_SIDE])],
        Model::Encoder => vec![("image_embeddings", float, &[1, 256, 64, 64])],
        Model::Decoder => vec![
            ("masks", float, &[-1, -1, -1, -1]),
            ("iou_predictions", float, &[-1, 4]),
            ("low_res_masks", float, &[-1, -1, -1, -1]),
        ],
        Model::Detector => vec![
            ("labels", int, &[1, 300]),
            ("boxes", float, &[1, 300, 4]),
            ("scores", float, &[1, 300]),
        ],
    };
    if session.inputs.len() != inputs.len() || session.outputs.len() != outputs.len() {
        return Err(model_error("model interface count mismatch"));
    }
    for (actual, (name, ty, shape)) in session
        .inputs
        .iter()
        .map(|v| (&v.name, &v.input_type))
        .zip(inputs)
        .chain(
            session
                .outputs
                .iter()
                .map(|v| (&v.name, &v.output_type))
                .zip(outputs),
        )
    {
        if actual.0 != name
            || !matches!(actual.1, ValueType::Tensor { ty: t, shape: s, .. } if *t == ty && &s[..] == shape)
        {
            return Err(model_error(format!("model interface mismatch: {name}")));
        }
    }
    Ok((session, digest))
}

pub(crate) fn output_f32(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
    expected: &[i64],
) -> Result<Vec<f32>> {
    let value = outputs
        .get(name)
        .ok_or_else(|| model_error(format!("missing output: {name}")))?;
    let (shape, data) = value.try_extract_tensor::<f32>()?;
    if &shape[..] != expected || data.iter().any(|v| !v.is_finite()) {
        return Err(model_error(format!(
            "output shape/finiteness mismatch: {name}"
        )));
    }
    Ok(data.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verification_rejects_equal_size_wrong_bytes_and_changed_length() {
        let path = std::env::temp_dir().join(format!("maple-removal-pin-{}", std::process::id()));
        std::fs::write(&path, b"abc").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"abc"));
        assert_eq!(verified_bytes(&path, 3, &hash).unwrap(), b"abc");
        std::fs::write(&path, b"xyz").unwrap();
        assert!(verified_bytes(&path, 3, &hash).is_err());
        std::fs::write(&path, b"abcd").unwrap();
        assert!(verified_bytes(&path, 3, &hash).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
