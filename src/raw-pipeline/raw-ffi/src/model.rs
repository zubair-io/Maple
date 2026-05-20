//! Helpers for marshalling the XMP sidecar input that every render entry
//! shares — load the optional XMP file, parse it to a raw-core
//! `AdjustmentModel`, and report the matching error code via
//! `set_last_error`.
//!
//! Tile-path dehaze guard. Dehaze relies on a full-image dark-channel
//! computation; running it on a crop tile would produce a wrong dark
//! channel (radius 67 px on the reference scenes). The non-tile FFI
//! paths catch this via raw-core's stage error (and bubble up as rc=10);
//! the tile path needs an explicit pre-check before calling the core
//! renderer or the rejection is silently bypassed and tiles render with
//! no dehaze (silent degradation rather than the contracted hard error).

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
                Ok(m) => LoadModel::Ok(m),
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

/// Returns `true` when `model.dehaze` is meaningfully non-zero (matches
/// `dehaze::apply`'s own early-exit threshold of `1e-3`). Tile-path
/// safety gate — see module doc.
pub(crate) fn dehaze_active(model: &xmp::AdjustmentModel) -> bool {
    model.dehaze.abs() > 1e-3
}
