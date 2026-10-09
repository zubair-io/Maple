//! Query embedding: bge-m3 through fastembed on ONNX Runtime, CLS-pooled and
//! L2-normalised, so a query vector is directly comparable with the document
//! vectors the API's `embed` stage stores (same model, same normalisation).

use crate::error::{Result, SearchError};
use crate::vectors::{normalise, DIM};
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_TOKENS: usize = 512;
const ORT_DYLIB_ENV: &str = "ORT_DYLIB_PATH";
const MIN_ORT_MINOR: u32 = 23;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmbedderConfig {
    pub model_cache_dir: PathBuf,
    #[serde(default)]
    pub ort_dylib_path: Option<PathBuf>,
    #[serde(default)]
    pub intra_threads: Option<usize>,
}

pub struct QueryEmbedder {
    model: Mutex<TextEmbedding>,
}

impl QueryEmbedder {
    /// Loads bge-m3 from `model_cache_dir`, fetching it from Hugging Face
    /// on first use. ONNX Runtime is located and version-checked first: with
    /// `load-dynamic`, `ort` panics on a missing or foreign dylib, and a panic
    /// must never reach the C boundary.
    pub fn open(config: &EmbedderConfig) -> Result<Self> {
        if config.intra_threads == Some(0) {
            return Err(SearchError::Config(
                "intra_threads must be at least 1".into(),
            ));
        }
        init_runtime(config.ort_dylib_path.as_deref())?;
        let options = InitOptions::new(EmbeddingModel::BGEM3)
            .with_cache_dir(config.model_cache_dir.clone())
            .with_max_length(MAX_TOKENS)
            .with_show_download_progress(false);
        let options = match config.intra_threads {
            Some(threads) => options.with_intra_threads(threads),
            None => options,
        };
        let model =
            TextEmbedding::try_new(options).map_err(|e| SearchError::Embedding(e.to_string()))?;
        Ok(Self {
            model: Mutex::new(model),
        })
    }

    pub fn embed(&self, text: &str) -> Result<Vec<f32>> {
        let mut model = self
            .model
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut vector = model
            .embed([text], None)
            .map_err(|e| SearchError::Embedding(e.to_string()))?
            .pop()
            .ok_or_else(|| SearchError::Embedding("the model returned no embedding".into()))?;
        if vector.len() != DIM {
            return Err(SearchError::Dimension {
                got: vector.len(),
                expected: DIM,
            });
        }
        normalise(&mut vector);
        Ok(vector)
    }
}

fn init_runtime(explicit: Option<&Path>) -> Result<()> {
    let path = match explicit {
        Some(path) => path.to_path_buf(),
        None => std::env::var_os(ORT_DYLIB_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| {
                SearchError::RuntimeUnavailable(format!(
                    "no ort_dylib_path configured and {ORT_DYLIB_ENV} is not set"
                ))
            })?,
    };
    let version = runtime_version(&path)?;
    let minor = version
        .split('.')
        .nth(1)
        .and_then(|minor| minor.parse::<u32>().ok())
        .unwrap_or(0);
    if minor < MIN_ORT_MINOR {
        return Err(SearchError::RuntimeUnavailable(format!(
            "{} is ONNX Runtime {version}; 1.{MIN_ORT_MINOR}+ is required",
            path.display()
        )));
    }
    ort::init_from(path.display().to_string())
        .commit()
        .map_err(|e| SearchError::RuntimeUnavailable(format!("environment init failed: {e}")))?;
    Ok(())
}

fn runtime_version(path: &Path) -> Result<String> {
    type GetApiBase = unsafe extern "C" fn() -> *const ort::sys::OrtApiBase;
    let unavailable =
        |reason: String| SearchError::RuntimeUnavailable(format!("{}: {reason}", path.display()));
    if !path.is_file() {
        return Err(unavailable("does not exist".into()));
    }
    // SAFETY: loading ONNX Runtime runs only its own initialisers; the probe
    // mirrors what `ort` does on first use, with errors instead of panics.
    let library =
        unsafe { libloading::Library::new(path) }.map_err(|e| unavailable(e.to_string()))?;
    // SAFETY: `OrtGetApiBase` has this signature in every ONNX Runtime release.
    let get_api_base: libloading::Symbol<'_, GetApiBase> = unsafe { library.get(b"OrtGetApiBase") }
        .map_err(|e| unavailable(format!("not an ONNX Runtime library ({e})")))?;
    // SAFETY: the returned table and version string are static for the
    // library's lifetime, which outlives this function's use of them.
    let version = unsafe {
        let base = get_api_base();
        if base.is_null() {
            return Err(unavailable("OrtGetApiBase returned null".into()));
        }
        let version = ((*base).GetVersionString)();
        if version.is_null() {
            return Err(unavailable("GetVersionString returned null".into()));
        }
        std::ffi::CStr::from_ptr(version)
            .to_string_lossy()
            .into_owned()
    };
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_runtime_is_a_typed_error_not_a_panic() {
        let config = EmbedderConfig {
            model_cache_dir: std::env::temp_dir(),
            ort_dylib_path: Some(PathBuf::from("/nonexistent/libonnxruntime.dylib")),
            intra_threads: Some(2),
        };
        assert!(matches!(
            QueryEmbedder::open(&config),
            Err(SearchError::RuntimeUnavailable(_))
        ));
    }

    #[test]
    fn zero_threads_is_rejected() {
        let config = EmbedderConfig {
            model_cache_dir: std::env::temp_dir(),
            ort_dylib_path: None,
            intra_threads: Some(0),
        };
        assert!(matches!(
            QueryEmbedder::open(&config),
            Err(SearchError::Config(_))
        ));
    }
}
