//! Content identity for the actual colour-harness inputs (#4074).
//! Paths locate bytes; they are not identity. Repeated RAWs are streamed once.
use super::{hash_corpus, EvidenceSource};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

pub(super) fn hash(repo: &Path) -> Result<String, String> {
    hash_manifest(repo, &repo.join("test-fixtures/references/manifest.json"))
}

/// Hash the selected manifest's actual files, including relocated absolute inputs.
pub fn hash_manifest(repo: &Path, path: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let cases = manifest
        .get_mut("cases")
        .and_then(Value::as_array_mut)
        .filter(|cases| !cases.is_empty())
        .ok_or("colour manifest needs nonempty cases")?;
    let mut names = BTreeSet::new();
    let mut files = BTreeMap::new();
    for case in cases {
        let name = required_string(case, "name")?.to_owned();
        if !names.insert(name.clone()) {
            return Err(format!("duplicate colour case: {name}"));
        }
        for key in ["raw", "xmp"] {
            replace_file(case, key, repo, &mut files)?;
        }
        if case.get("acr_xmp").is_some_and(|v| !v.is_null()) {
            replace_file(case, "acr_xmp", repo, &mut files)?;
        }
        let outputs = case
            .get_mut("outputs")
            .and_then(Value::as_array_mut)
            .filter(|outputs| !outputs.is_empty())
            .ok_or_else(|| format!("{name}: no reference outputs"))?;
        let mut resolutions = BTreeSet::new();
        for output in outputs {
            let resolution = required_string(output, "resolution")?.to_owned();
            if !resolutions.insert(resolution) {
                return Err(format!("{name}: duplicate reference resolution"));
            }
            if output
                .get("long_edge")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .is_none()
            {
                return Err(format!("{name}: invalid long_edge"));
            }
            replace_file(output, "png", repo, &mut files)?;
        }
    }
    let fixed = hash_corpus(repo, EvidenceSource::ColorHarness.corpus())?;
    let (format, profile) = crate::color::profile_loader::bundled_profile_version();
    let mut hash = blake3::Hasher::new();
    hash.update(b"maple-colour-corpus-v1\0");
    hash.update(fixed.as_bytes());
    hash.update(&format.to_le_bytes());
    hash.update(profile.as_bytes());
    hash.update(&serde_json::to_vec(&manifest).map_err(|e| e.to_string())?);
    Ok(format!("blake3:{}", hash.finalize().to_hex()))
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("colour manifest needs nonempty string {key}"))
}

fn replace_file(
    value: &mut Value,
    key: &str,
    repo: &Path,
    files: &mut BTreeMap<PathBuf, String>,
) -> Result<(), String> {
    let source = repo.join(required_string(value, key)?);
    let path = source
        .canonicalize()
        .map_err(|e| format!("{}: {e}", source.display()))?;
    let digest = match files.get(&path) {
        Some(digest) => digest.clone(),
        None => {
            let digest = file_digest(&path)?;
            files.insert(path, digest.clone());
            digest
        }
    };
    // The decoder can use a file extension to select its input path. Bind
    // that semantic hint while excluding checkout-specific directories.
    let extension = source
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    value[key] = serde_json::json!({"digest": digest, "extension": extension});
    Ok(())
}

fn file_digest(path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err(format!("{}: input is not a regular file", path.display()));
    }
    let mut file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut hash = blake3::Hasher::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        if count == 0 {
            break;
        }
        // Exact input bytes, including CR in an XMP/PNG; originals are read-only.
        hash.update(&buffer[..count]);
    }
    Ok(format!("blake3:{}", hash.finalize().to_hex()))
}

#[cfg(test)]
mod tests;
