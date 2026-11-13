//! Shared native ORT initialization for panorama and object removal (#3941).
//! Extracted from maple-pano: both consumers initialize the same ort environment.
#![cfg(any(feature = "ml", feature = "ml-static"))]

use std::path::{Path, PathBuf};

pub const ORT_DYLIB_ENV: &str = "ORT_DYLIB_PATH";
pub const MIN_ORT_MINOR: u32 = 22;

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("ONNX Runtime unavailable: {reason}")]
    RuntimeUnavailable { reason: String },
    #[error("ONNX Runtime error: {0}")]
    Runtime(String),
}

/// Verified handle to the ONNX Runtime environment. Construction proves
/// ORT is initialized and ready — after which
/// [`ort::session::Session`] creation cannot hit the load-dynamic panic
/// paths for the realistic failure modes.
///
/// Two construction paths:
/// - **`ml` (macOS/host, `load-dynamic`):** `dylib` is the path that was
///   dlopen'd and version-verified; `version` is the reported ORT version.
/// - **`ml-static` (iOS, M6 #1244):** ORT is statically linked; `dylib`
///   is an empty `PathBuf` (sentinel) and `version` is `"static"`. The
///   `ORT_DYLIB_PATH` environment variable is not consulted.
#[derive(Debug, Clone)]
pub struct OrtRuntime {
    /// The dylib that passed the pre-flight, OR an empty sentinel when
    /// the static-link path was used (`ml-static`).
    dylib: PathBuf,
    /// `GetVersionString()` as reported by the dylib, or `"static"` when
    /// the static-link path was used.
    version: String,
}

impl OrtRuntime {
    pub fn dylib(&self) -> &Path {
        &self.dylib
    }
    pub fn version(&self) -> &str {
        &self.version
    }

    /// Initialize the ONNX Runtime environment.
    ///
    /// **`ml` (macOS/host, load-dynamic):** probes the dylib at
    /// `explicit` (or `ORT_DYLIB_PATH`) with `libloading`, verifies the
    /// version, then calls `ort::init_from`. With neither path present this
    /// is [`RuntimeError::RuntimeUnavailable`] — `ort` would panic on a missing
    /// dylib; requiring an explicit path keeps the failure mode typed.
    ///
    /// **`ml-static` (iOS, M6 #1244):** the ORT C library is statically
    /// linked; calls `ort::init()` directly. The `explicit` argument is
    /// ignored and `ORT_DYLIB_PATH` is not consulted.
    ///
    /// Idempotent: `ort`'s environment is process-global, first-set-wins
    /// (`OnceLock`). The detector and matcher both call it; in any sane
    /// configuration the second call is a no-op.
    pub fn preflight(explicit: Option<&Path>) -> Result<Self, RuntimeError> {
        // ── ml-static path (iOS, statically-linked ORT) ──────────────────
        // Only active when `ml` is NOT also enabled. When both features are
        // present (e.g. `--all-features`), `ml`'s `#[cfg(feature = "ml")]`
        // block below takes precedence (it's checked first) and this block
        // is dead code. In a pure `ml-static` iOS build, `ort` is compiled
        // without `load-dynamic` and `ort::init_from` does not exist, so
        // we call `ort::init()` directly.
        #[cfg(all(feature = "ml-static", not(feature = "ml")))]
        {
            let _ = explicit; // dylib path is irrelevant for static builds
            ort::init()
                .commit()
                .map_err(|e| RuntimeError::Runtime(format!("ort environment init failed: {e}")))?;
            return Ok(Self {
                dylib: PathBuf::new(), // sentinel: no dylib in static builds
                version: "static".to_owned(),
            });
        }

        // ── ml path (macOS/host, load-dynamic) ───────────────────────────
        #[cfg(feature = "ml")]
        {
            let path = match explicit {
                Some(p) => p.to_path_buf(),
                None => match std::env::var_os(ORT_DYLIB_ENV) {
                    Some(v) if !v.is_empty() => PathBuf::from(v),
                    _ => {
                        return Err(RuntimeError::RuntimeUnavailable {
                            reason: format!("{ORT_DYLIB_ENV} is not set"),
                        });
                    }
                },
            };
            if !path.is_file() {
                return Err(RuntimeError::RuntimeUnavailable {
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
                return Err(RuntimeError::RuntimeUnavailable {
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
                .map_err(|e| RuntimeError::Runtime(format!("ort environment init failed: {e}")))?;
            return Ok(Self {
                dylib: path,
                version,
            });
        }

        // This branch is only reachable if neither `ml` nor `ml-static` is
        // enabled — which cannot happen since `OrtRuntime` itself is only
        // compiled under those features. Belt-and-suspenders.
        #[allow(unreachable_code)]
        Err(RuntimeError::RuntimeUnavailable {
            reason: "no ORT feature enabled (build configuration error)".to_owned(),
        })
    }
}

/// dlopen the candidate dylib, resolve `OrtGetApiBase`, and read the
/// runtime's version string. Any failure is [`RuntimeError::RuntimeUnavailable`]
/// (the "skip on CI" class) because it means this machine cannot run the
/// ML stack as configured.
///
/// Only compiled under the `ml` feature (`load-dynamic` path).
#[cfg(feature = "ml")]
fn probe_dylib(path: &Path) -> Result<String, RuntimeError> {
    // Mirrors the first steps `ort::api()` performs, but with errors
    // instead of panics. The library handle is dropped at the end of the
    // probe; dlopen is reference-counted, and ort re-opens it by path.
    type GetApiBase = unsafe extern "C" fn() -> *const ort::sys::OrtApiBase;
    let lib = unsafe { libloading::Library::new(path) }.map_err(|e| {
        RuntimeError::RuntimeUnavailable {
            reason: format!("failed to load {}: {e}", path.display()),
        }
    })?;
    let get_base: libloading::Symbol<'_, GetApiBase> = unsafe { lib.get(b"OrtGetApiBase") }
        .map_err(|e| RuntimeError::RuntimeUnavailable {
            reason: format!(
                "{} does not export OrtGetApiBase ({e}) — not an ONNX Runtime dylib?",
                path.display()
            ),
        })?;
    let base = unsafe { get_base() };
    if base.is_null() {
        return Err(RuntimeError::RuntimeUnavailable {
            reason: format!("{}: OrtGetApiBase returned null", path.display()),
        });
    }
    let version_cstr = unsafe { ((*base).GetVersionString)() };
    if version_cstr.is_null() {
        return Err(RuntimeError::RuntimeUnavailable {
            reason: format!("{}: GetVersionString returned null", path.display()),
        });
    }
    let version = unsafe { std::ffi::CStr::from_ptr(version_cstr) }
        .to_string_lossy()
        .into_owned();
    Ok(version)
}
