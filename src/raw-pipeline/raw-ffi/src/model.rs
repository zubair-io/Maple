//! Helpers for marshalling the XMP sidecar input that every render entry
//! shares — load the optional XMP file, parse it to a raw-core
//! `AdjustmentModel`, report the matching error code via `set_last_error`,
//! and (#3271) resolve any `Mask::Bitmap` layer's raster against the
//! process-wide registry (`crate::mask_registry::resolve_into`) so every
//! caller of these two functions gets working bitmap masks for free.
//!
//! Tile-path dehaze / deep-denoise guards. Dehaze relies on a full-image
//! dark-channel computation; running it on a crop tile would produce a
//! wrong dark channel (radius 67 px on the reference scenes). BM3D's
//! reference-patch grid is frame-anchored, so per-tile grids would seam.
//! The core tile entry (`render_scene_linear_tile_from_raw_with_quality`)
//! rejects both itself (dehaze since #1084; deep denoise per #1105) — these
//! FFI pre-checks remain as
//! belt-and-braces with a shorter, host-facing error message, and both
//! layers map to the same rc=10 "fall back to fit-zoom" contract.

use crate::error::set_last_error;
use raw_core::xmp;

/// Outcome of `load_xmp_model_owned`: the parsed model, or the error code
/// the FFI entry should return to the caller.
pub(crate) enum LoadModel {
    Ok(xmp::AdjustmentModel),
    Err(i32),
}

/// Load + parse the sidecar at `xmp_path_str` into an `AdjustmentModel`.
/// `None` returns `AdjustmentModel::default()`. Error codes (4 for parse,
/// 5 for read) match the inlined behaviour every render entry used to
/// duplicate.
pub(crate) fn load_xmp_model_owned(xmp_path_str: Option<&str>) -> LoadModel {
    match xmp_path_str {
        None => LoadModel::Ok(xmp::AdjustmentModel::default()),
        Some(p) => match std::fs::read_to_string(p) {
            Ok(xml) => match xmp::parse(&xml) {
                Ok(mut m) => {
                    crate::mask_registry::resolve_into(&mut m);
                    LoadModel::Ok(m)
                }
                Err(e) => {
                    set_last_error(format!("xmp parse: {}", e));
                    LoadModel::Err(4)
                }
            },
            Err(e) => {
                set_last_error(format!("xmp read: {}", e));
                LoadModel::Err(5)
            }
        },
    }
}

/// Parse an in-memory XMP *document* (the sidecar text itself, not a path)
/// into an `AdjustmentModel`. `None` returns `AdjustmentModel::default()`.
///
/// The bytes-source histogram entry (`maple_histogram_bytes`) needs this: a
/// PhotoKit / Self-Hosted asset has no `.xmp` file on disk, so the Apple host
/// serialises its live in-memory model straight to a string and hands it over
/// — there's nothing to `read_to_string`. Parse failures map to the same
/// code 4 the file path uses, so callers get one "bad XMP" contract regardless
/// of whether the document came from disk or memory.
pub(crate) fn load_xmp_model_from_doc(xmp_doc: Option<&str>) -> LoadModel {
    match xmp_doc {
        None => LoadModel::Ok(xmp::AdjustmentModel::default()),
        Some(xml) => match xmp::parse(xml) {
            Ok(mut m) => {
                crate::mask_registry::resolve_into(&mut m);
                LoadModel::Ok(m)
            }
            Err(e) => {
                set_last_error(format!("xmp parse: {}", e));
                LoadModel::Err(4)
            }
        },
    }
}

/// Returns `true` when `model.dehaze` is meaningfully non-zero (matches
/// `dehaze::apply`'s own early-exit threshold of `1e-3`). Tile-path
/// safety gate — see module doc.
pub(crate) fn dehaze_active(model: &xmp::AdjustmentModel) -> bool {
    model.dehaze.abs() > 1e-3
}

/// Returns `true` when `model.deep_denoise` is meaningfully non-zero
/// (matches `bm3d::apply`'s early-exit threshold of `1e-3`). Tile-path
/// safety gate (#1105): the BM3D reference-patch grid is anchored at the
/// buffer origin, so a tile-relative grid would aggregate different
/// groups than the full-frame render and seam at tile borders — the tile
/// entries reject it exactly like dehaze, and the caller falls back to
/// the full-image render.
pub(crate) fn deep_denoise_active(model: &xmp::AdjustmentModel) -> bool {
    model.deep_denoise.abs() > 1e-3
}

/// Force `auto_exposure: Off` when this model will fit an Auto Profile
/// curve — the scene-linear-decode mirror of the full render path's
/// `auto_will_fit` guard (`render/mod.rs` § Section 0).
///
/// Why this matters for the Apple canvas (#871): the Auto Profile curve is
/// fit against a buffer developed with **auto_exposure Off** (the fit
/// forces it so the fitted curve owns the entire scene→JPEG brightness
/// relationship). The full CPU/CLI/WASM render path then also develops the
/// *displayed* buffer with auto_exposure Off when a curve will fit, so the
/// curve applies on the matching domain.
///
/// The Apple canvas, by contrast, develops the displayed buffer through
/// THIS scene-linear decode (pre-AgX), then applies the same fitted curve
/// as a post-encode `CIColorCube`. Without this guard the decode keeps
/// auto_exposure On (the default) — so AE-lift and the curve-lift STACK,
/// blowing out Auto highlights while Neutral (no curve) stays correct.
/// Forcing Off here makes the Apple Auto displayed buffer byte-match the
/// CLI/WASM Auto buffer the curve was authored against.
///
/// Gated EXACTLY on the render path's `auto_will_fit`: `profile == Auto`
/// AND an embedded preview is extractable (the cube only applies when a
/// curve actually fits, and a fit needs the preview). `Profile::Neutral`
/// is returned unchanged — its decode is byte-identical to before.
pub(crate) fn force_ae_off_if_auto_will_fit_path(
    model: &xmp::AdjustmentModel,
    raw_path: &std::path::Path,
) -> xmp::AdjustmentModel {
    if model.profile != xmp::Profile::Auto {
        return model.clone();
    }
    let will_fit = raw_core::view::auto_profile::preview::extract_preview(raw_path).is_some();
    apply_ae_off(model, will_fit)
}

/// Bytes-source mirror of [`force_ae_off_if_auto_will_fit_path`].
pub(crate) fn force_ae_off_if_auto_will_fit_bytes(
    model: &xmp::AdjustmentModel,
    bytes: &[u8],
    ext: &str,
) -> xmp::AdjustmentModel {
    if model.profile != xmp::Profile::Auto {
        return model.clone();
    }
    let will_fit =
        raw_core::view::auto_profile::preview::extract_preview_from_bytes(bytes, ext).is_some();
    apply_ae_off(model, will_fit)
}

fn apply_ae_off(model: &xmp::AdjustmentModel, will_fit: bool) -> xmp::AdjustmentModel {
    let mut m = model.clone();
    if will_fit {
        m.auto_exposure = xmp::AutoExposureMode::Off;
    }
    m
}
