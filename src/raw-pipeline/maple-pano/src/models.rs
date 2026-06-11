//! ML model manifest, integrity verification, and ONNX Runtime pre-flight
//! (`ml` feature, #1139).
//!
//! # Models policy
//!
//! Model files are **never committed** to the repo. The committed contract
//! is `maple-pano/models.toml` (embedded into the binary at compile time):
//! file name, byte size, SHA-256, source URL, and license for every model
//! the `ml` feature consumes. At load time [`ModelDir::resolve`] locates
//! the files in the directory named by the `MAPLE_PANO_MODELS` environment
//! variable (or an explicit path argument, which wins over the variable)
//! and verifies size + digest before any inference session is created.
//! A digest mismatch is a hard [`MlError::ModelVerification`] — there is
//! deliberately no "load anyway" path.
//!
//! # ONNX Runtime pre-flight
//!
//! `ort` is built with `load-dynamic`: the onnxruntime dylib is dlopen'd at
//! runtime from the path in the `ORT_DYLIB_PATH` environment variable
//! (ort's own convention). On failure ort *panics* inside a `OnceLock`
//! initializer, which is unusable as an API contract, so
//! [`OrtRuntime::preflight`] probes the dylib first with `libloading` —
//! checking that it loads, exports `OrtGetApiBase`, and reports an ONNX
//! Runtime version compatible with the bound API (1.22 for ort
//! 2.0.0-rc.10) — and returns a typed [`MlError`] instead. Only after the
//! probe succeeds does it hand the same path to [`ort::init_from`].
//!
//! [`MlError::is_environment_missing`] classifies the "this machine simply
//! doesn't have the ML environment" cases (unset variables, absent files,
//! unloadable dylib) so the `ml` smoke tests can skip-pass on CI — the
//! house pattern shared with the fixture-gated color harness — while real
//! defects (hash mismatch, inference failure) still fail loudly.

use std::fmt::Write as _;
use std::fs::File;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Deserialize;
use sha2::{Digest as _, Sha256};

/// Environment variable naming the directory that holds the ONNX models
/// listed in `models.toml`.
pub const MODELS_DIR_ENV: &str = "MAPLE_PANO_MODELS";

/// Environment variable naming the onnxruntime dylib to load. This is the
/// variable `ort` itself reads with `load-dynamic`; the pre-flight uses the
/// same one so there is a single source of truth.
pub const ORT_DYLIB_ENV: &str = "ORT_DYLIB_PATH";

/// Minimum ONNX Runtime minor version the bound `ort` API requires
/// (`ort 2.0.0-rc.10` binds API version 22 → onnxruntime 1.22.x). A dylib
/// reporting an older minor would make `ort` panic; the pre-flight rejects
/// it with a typed error instead. Newer minors are accepted — ONNX Runtime
/// keeps the C API backward-compatible and `ort` itself only warns.
const MIN_ORT_MINOR: u32 = 22;

/// Errors for the `ml` feature (model manifest, model files, ONNX Runtime
/// loading, and inference).
///
/// Lives here (not in [`crate::error::PanoError`]) so the `ml` feature
/// stays additive: the geometry-side error type is untouched and the two
/// concurrent milestone tracks don't contend on one file.
#[derive(Debug, thiserror::Error)]
pub enum MlError {
    #[error(
        "model directory not specified: set {MODELS_DIR_ENV} or pass an explicit path \
         (models are not committed — see maple-pano/models.toml for the pinned files)"
    )]
    ModelsDirUnset,

    #[error("model directory {0} does not exist or is not a directory")]
    ModelsDirMissing(PathBuf),

    #[error(
        "model file {path} is missing (expected {file} from models.toml; download it from \
         {source_url} into the models directory)"
    )]
    ModelMissing {
        path: PathBuf,
        file: String,
        // Not `source`: thiserror reserves that name for error chaining.
        source_url: String,
    },

    #[error("model file {path} failed verification: {reason}")]
    ModelVerification { path: PathBuf, reason: String },

    #[error(
        "onnxruntime dylib unavailable: {reason} (set {ORT_DYLIB_ENV} to a \
         libonnxruntime dylib, ONNX Runtime 1.{MIN_ORT_MINOR}+)"
    )]
    RuntimeUnavailable { reason: String },

    #[error("ONNX Runtime error: {0}")]
    Runtime(String),

    #[error("model {path} has an unexpected interface: {reason}")]
    ModelInterface { path: PathBuf, reason: String },

    #[error("inference failed: {0}")]
    Inference(String),

    #[error("invalid image input: {0}")]
    BadImage(String),

    #[error("i/o error on {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl MlError {
    /// `true` when the error means "the ML environment is not present on
    /// this machine" — the model directory or the onnxruntime dylib is
    /// simply absent. The `ml` smoke tests skip-pass on these (CI has no
    /// models and no dylib; the house pattern), while everything else —
    /// digest mismatches, interface drift, inference failures — remains a
    /// hard failure.
    pub fn is_environment_missing(&self) -> bool {
        matches!(
            self,
            MlError::ModelsDirUnset
                | MlError::ModelsDirMissing(_)
                | MlError::ModelMissing { .. }
                | MlError::RuntimeUnavailable { .. }
        )
    }
}

/// One pinned model in `models.toml`.
#[derive(Debug, Clone, Deserialize)]
pub struct ModelEntry {
    /// File name inside the models directory.
    pub file: String,
    /// Hex-encoded SHA-256 of the file contents.
    pub sha256: String,
    /// Exact byte size.
    pub size: u64,
    /// Where the pinned bytes come from (commit-pinned URL).
    pub source: String,
    /// License note for the export + weights.
    pub license: String,
    /// Interface notes (shapes, conventions).
    pub notes: String,
}

/// The parsed, compile-time-embedded `models.toml`.
#[derive(Debug, Clone, Deserialize)]
pub struct ModelManifest {
    /// Manifest schema version (currently 1).
    pub schema: u32,
    /// ALIKED detector/descriptor model.
    pub aliked: ModelEntry,
    /// LightGlue matcher model (ALIKED-paired).
    pub lightglue: ModelEntry,
}

impl ModelManifest {
    /// The manifest committed next to this crate's `Cargo.toml`, parsed
    /// once. Panics never: the embedded file is validated by the
    /// `manifest_*` unit tests, so a parse failure here is a build defect,
    /// not a runtime condition — but it still surfaces as an `Err` so a
    /// corrupted custom build can't silently proceed.
    pub fn embedded() -> Result<&'static ModelManifest, MlError> {
        static MANIFEST: OnceLock<Result<ModelManifest, String>> = OnceLock::new();
        MANIFEST
            .get_or_init(|| {
                toml::from_str::<ModelManifest>(include_str!("../models.toml"))
                    .map_err(|e| format!("embedded models.toml is invalid: {e}"))
            })
            .as_ref()
            .map_err(|e| MlError::ModelVerification {
                path: PathBuf::from("models.toml"),
                reason: e.clone(),
            })
    }
}

/// A resolved-and-verified set of model paths. Construction is the only
/// way to get one, so holding a `ModelDir` is proof the files matched the
/// pinned digests at resolve time.
#[derive(Debug, Clone)]
pub struct ModelDir {
    /// Verified path of the ALIKED detector model.
    pub aliked: PathBuf,
    /// Verified path of the LightGlue matcher model.
    pub lightglue: PathBuf,
}

impl ModelDir {
    /// Locate and verify the pinned models.
    ///
    /// `explicit` wins over the `MAPLE_PANO_MODELS` environment variable;
    /// with neither present this is [`MlError::ModelsDirUnset`] (an
    /// environment-missing error, so gated tests skip).
    pub fn resolve(explicit: Option<&Path>) -> Result<Self, MlError> {
        let dir = match explicit {
            Some(p) => p.to_path_buf(),
            None => match std::env::var_os(MODELS_DIR_ENV) {
                Some(v) if !v.is_empty() => PathBuf::from(v),
                _ => return Err(MlError::ModelsDirUnset),
            },
        };
        if !dir.is_dir() {
            return Err(MlError::ModelsDirMissing(dir));
        }
        let manifest = ModelManifest::embedded()?;
        let aliked = verify_entry(&dir, &manifest.aliked)?;
        let lightglue = verify_entry(&dir, &manifest.lightglue)?;
        Ok(Self { aliked, lightglue })
    }
}

/// Check existence, size, and SHA-256 of one manifest entry inside `dir`.
/// Returns the verified absolute path.
fn verify_entry(dir: &Path, entry: &ModelEntry) -> Result<PathBuf, MlError> {
    let path = dir.join(&entry.file);
    if !path.is_file() {
        return Err(MlError::ModelMissing {
            path,
            file: entry.file.clone(),
            source_url: entry.source.clone(),
        });
    }
    let meta = std::fs::metadata(&path).map_err(|source| MlError::Io {
        path: path.clone(),
        source,
    })?;
    if meta.len() != entry.size {
        return Err(MlError::ModelVerification {
            path,
            reason: format!(
                "size is {} bytes, models.toml pins {}",
                meta.len(),
                entry.size
            ),
        });
    }
    let digest = sha256_file(&path)?;
    if !digest.eq_ignore_ascii_case(&entry.sha256) {
        return Err(MlError::ModelVerification {
            path,
            reason: format!("SHA-256 is {digest}, models.toml pins {}", entry.sha256),
        });
    }
    Ok(path)
}

/// Streamed SHA-256 of a file, hex-encoded lowercase.
fn sha256_file(path: &Path) -> Result<String, MlError> {
    let mut file = File::open(path).map_err(|source| MlError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0_u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).map_err(|source| MlError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        // Infallible on String.
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

/// Verified handle to the ONNX Runtime dylib. Construction proves the
/// dylib loads and is version-compatible, and registers its path with
/// `ort` — after which [`ort::session::Session`] creation cannot hit the
/// load-dynamic panic paths for the realistic failure modes.
#[derive(Debug, Clone)]
pub struct OrtRuntime {
    /// The dylib that passed the pre-flight.
    pub dylib: PathBuf,
    /// `GetVersionString()` as reported by the dylib (e.g. "1.22.0").
    pub version: String,
}

impl OrtRuntime {
    /// Probe the onnxruntime dylib and initialize `ort` with it.
    ///
    /// `explicit` wins over the `ORT_DYLIB_PATH` environment variable.
    /// With neither present this is [`MlError::RuntimeUnavailable`] — `ort`
    /// would fall back to dlopen'ing a bare `libonnxruntime.dylib`, which
    /// on a stock macOS/Linux box never resolves and would panic; requiring
    /// an explicit path keeps the failure mode a typed error and the
    /// environment reproducible.
    ///
    /// Idempotent: `ort`'s dylib path is process-global, first-set-wins
    /// (`OnceLock`), so calling this twice with different paths verifies
    /// the second path but keeps using the first. The detector and matcher
    /// both call it; in any sane configuration the paths agree.
    pub fn preflight(explicit: Option<&Path>) -> Result<Self, MlError> {
        let path = match explicit {
            Some(p) => p.to_path_buf(),
            None => match std::env::var_os(ORT_DYLIB_ENV) {
                Some(v) if !v.is_empty() => PathBuf::from(v),
                _ => {
                    return Err(MlError::RuntimeUnavailable {
                        reason: format!("{ORT_DYLIB_ENV} is not set"),
                    });
                }
            },
        };
        if !path.is_file() {
            return Err(MlError::RuntimeUnavailable {
                reason: format!("{} does not exist", path.display()),
            });
        }
        let version = probe_dylib(&path)?;
        let minor = version
            .split('.')
            .nth(1)
            .and_then(|m| m.parse::<u32>().ok())
            .unwrap_or(0);
        if minor < MIN_ORT_MINOR {
            return Err(MlError::RuntimeUnavailable {
                reason: format!(
                    "{} reports ONNX Runtime {version}, but ort 2.0.0-rc.10 requires \
                     1.{MIN_ORT_MINOR}+",
                    path.display()
                ),
            });
        }
        // Hand the verified path to ort (first-set-wins; harmless when the
        // environment variable already pointed ort at the same file).
        ort::init_from(path.display().to_string())
            .commit()
            .map_err(|e| MlError::Runtime(format!("ort environment init failed: {e}")))?;
        Ok(Self {
            dylib: path,
            version,
        })
    }
}

/// dlopen the candidate dylib, resolve `OrtGetApiBase`, and read the
/// runtime's version string. Any failure is [`MlError::RuntimeUnavailable`]
/// (the "skip on CI" class) because it means this machine cannot run the
/// ML stack as configured.
fn probe_dylib(path: &Path) -> Result<String, MlError> {
    // Mirrors the first steps `ort::api()` performs, but with errors
    // instead of panics. The library handle is dropped at the end of the
    // probe; dlopen is reference-counted, and ort re-opens it by path.
    type GetApiBase = unsafe extern "C" fn() -> *const ort::sys::OrtApiBase;
    let lib =
        unsafe { libloading::Library::new(path) }.map_err(|e| MlError::RuntimeUnavailable {
            reason: format!("failed to load {}: {e}", path.display()),
        })?;
    let get_base: libloading::Symbol<'_, GetApiBase> = unsafe { lib.get(b"OrtGetApiBase") }
        .map_err(|e| MlError::RuntimeUnavailable {
            reason: format!(
                "{} does not export OrtGetApiBase ({e}) — not an ONNX Runtime dylib?",
                path.display()
            ),
        })?;
    let base = unsafe { get_base() };
    if base.is_null() {
        return Err(MlError::RuntimeUnavailable {
            reason: format!("{}: OrtGetApiBase returned null", path.display()),
        });
    }
    let version_cstr = unsafe { ((*base).GetVersionString)() };
    if version_cstr.is_null() {
        return Err(MlError::RuntimeUnavailable {
            reason: format!("{}: GetVersionString returned null", path.display()),
        });
    }
    let version = unsafe { std::ffi::CStr::from_ptr(version_cstr) }
        .to_string_lossy()
        .into_owned();
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The committed manifest must parse and carry well-formed pins —
    /// this is the compile-time contract the loader trusts.
    #[test]
    fn manifest_embeds_and_parses() {
        let m = ModelManifest::embedded().expect("models.toml parses");
        assert_eq!(m.schema, 1);
        for entry in [&m.aliked, &m.lightglue] {
            assert_eq!(
                entry.sha256.len(),
                64,
                "{}: sha256 must be hex-64",
                entry.file
            );
            assert!(
                entry.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{}: sha256 must be hex",
                entry.file
            );
            assert!(entry.size > 0, "{}: size must be pinned", entry.file);
            assert!(
                entry.source.starts_with("https://"),
                "{}: source must be a URL",
                entry.file
            );
            assert!(!entry.license.is_empty());
            assert!(!entry.notes.is_empty());
            assert!(
                entry.file.ends_with(".onnx"),
                "{}: model files are ONNX",
                entry.file
            );
        }
        assert_ne!(m.aliked.sha256, m.lightglue.sha256);
    }

    #[test]
    fn resolve_with_explicit_missing_dir_errors_and_skips() {
        let err = ModelDir::resolve(Some(Path::new("/nonexistent/maple-pano-models")))
            .expect_err("missing dir must not resolve");
        assert!(matches!(err, MlError::ModelsDirMissing(_)));
        assert!(err.is_environment_missing());
    }

    #[test]
    fn resolve_missing_files_is_environment_missing() {
        let dir = tempdir();
        let err = ModelDir::resolve(Some(&dir)).expect_err("empty dir must not resolve");
        assert!(matches!(err, MlError::ModelMissing { .. }), "got {err:?}");
        assert!(err.is_environment_missing());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    /// A present-but-wrong file is a verification failure — NOT an
    /// environment-missing skip. Wrong bytes must never be silently
    /// tolerated or silently skipped.
    #[test]
    fn resolve_rejects_wrong_bytes_loudly() {
        let dir = tempdir();
        let manifest = ModelManifest::embedded().expect("manifest");
        // Right name + right size, wrong contents → digest mismatch.
        let path = dir.join(&manifest.aliked.file);
        std::fs::write(&path, vec![0_u8; manifest.aliked.size as usize]).expect("write");
        let err = ModelDir::resolve(Some(&dir)).expect_err("wrong bytes must fail");
        assert!(
            matches!(&err, MlError::ModelVerification { reason, .. } if reason.contains("SHA-256")),
            "got {err:?}"
        );
        assert!(!err.is_environment_missing(), "hash mismatch must not skip");

        // Wrong size short-circuits with the size message.
        std::fs::write(&path, b"tiny").expect("write");
        let err = ModelDir::resolve(Some(&dir)).expect_err("wrong size must fail");
        assert!(
            matches!(&err, MlError::ModelVerification { reason, .. } if reason.contains("size")),
            "got {err:?}"
        );
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn sha256_file_matches_known_vector() {
        // SHA-256("abc") — FIPS 180-2 appendix B.1.
        let dir = tempdir();
        let path = dir.join("abc.bin");
        std::fs::write(&path, b"abc").expect("write");
        assert_eq!(
            sha256_file(&path).expect("hash"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn preflight_unset_or_missing_is_environment_missing() {
        // Explicit-but-absent path: never consults the environment, so the
        // test is independent of the developer's shell profile.
        let err = OrtRuntime::preflight(Some(Path::new("/nonexistent/libonnxruntime.dylib")))
            .expect_err("missing dylib must not preflight");
        assert!(matches!(err, MlError::RuntimeUnavailable { .. }));
        assert!(err.is_environment_missing());
    }

    #[test]
    fn preflight_rejects_non_ort_dylib() {
        // A real loadable dylib that is definitely not ONNX Runtime: libz.
        let libz = Path::new("/usr/lib/libz.dylib");
        if !libz.exists() {
            eprintln!("skipping: /usr/lib/libz.dylib not present on this platform");
            return;
        }
        let err = OrtRuntime::preflight(Some(libz)).expect_err("libz is not onnxruntime");
        assert!(
            matches!(&err, MlError::RuntimeUnavailable { reason } if reason.contains("OrtGetApiBase")),
            "got {err:?}"
        );
    }

    /// Unique per-test temp dir under the target-adjacent std temp root.
    /// (No tempfile dep: the crate keeps its dependency surface minimal
    /// and these tests clean up after themselves.)
    fn tempdir() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "maple-pano-models-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }
}
