//! Instance-wide bitmap-mask raster registry (#3300) — the web mirror of
//! raw-ffi's `mask_registry.rs` (`maple_mask_raster_register` / `_release`,
//! #3271). Same design, same reasoning: a `Mask::Bitmap` layer's raster
//! never rides the sidecar (only its recipe does) and never rides the
//! per-tick render request either — that would copy a multi-megabyte plane
//! across the JS↔wasm boundary on every slider tick. Instead the host
//! registers each raster ONCE with this WASM instance, gets back an id, and
//! every entry that parses a model ([`parse_model`]) resolves the layer's
//! recipe `digest` against this one table before rendering — the persistent
//! `WebLiveSession`, the one-shot CPU / GPU decodes, the scene-linear
//! entries, native detail, and export all go through it, so a registered
//! raster applies identically on every path.
//!
//! A raster id is meaningless outside the WASM instance that issued it: a
//! reloaded worker, or a raster the host never re-registered, resolves to
//! nothing, and [`resolve_into`] leaves that layer as an UNRESOLVED bitmap
//! mask (weight 0 everywhere) rather than inventing a fallback — matching
//! `Mask::Bitmap`'s own doc: "`0` means unresolved, which evaluates to
//! weight 0 (never a global correction) rather than silently falling back
//! to `Everywhere`."

use raw_core::types::{Mask, MaskRaster};
use raw_core::xmp::AdjustmentModel;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use wasm_bindgen::prelude::*;

/// `0` is reserved for "unresolved" on the wire (`Mask::Bitmap::raster_id`),
/// so real ids start at 1.
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

static REGISTRY: Mutex<Option<HashMap<u32, Arc<MaskRaster>>>> = Mutex::new(None);

fn with_registry<R>(f: impl FnOnce(&mut HashMap<u32, Arc<MaskRaster>>) -> R) -> R {
    let mut guard = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

fn lookup(id: u32) -> Option<Arc<MaskRaster>> {
    if id == 0 {
        return None;
    }
    with_registry(|r| r.get(&id).cloned())
}

fn lookup_digest(digest: &str) -> Option<Arc<MaskRaster>> {
    if digest.is_empty() {
        return None;
    }
    with_registry(|r| r.values().find(|raster| raster.digest == digest).cloned())
}

fn is_lowercase_hex_digest(digest: &str) -> bool {
    digest.len() == 16
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Register an R8 raster (row-major, `width * height` bytes, `0` = weight 0,
/// `255` = weight 1) under a 16-lowercase-hex-char digest. Returns the
/// raster id (>= 1) a `Mask::Bitmap` record's `raster_id` resolves against.
/// Re-registering the SAME digest gets a NEW id each call; the caller
/// releases the old one via [`release`] once no render references it.
///
/// Plain Rust (no JS types) so the host-target tests can drive it directly;
/// [`mask_raster_register`] is the `#[wasm_bindgen]` wrapper.
pub(crate) fn register(digest: &str, width: u32, height: u32, data: &[u8]) -> Result<u32, String> {
    if !is_lowercase_hex_digest(digest) {
        return Err(format!(
            "mask_raster_register: digest must be 16 lowercase hex chars, got {digest:?}"
        ));
    }
    // `checked_mul`: on wasm32 `usize` is 32 bits, so `65536 * 65536` would
    // wrap to 0 and let an empty `data` slip past the length check.
    let Some(expected_len) = (width as usize).checked_mul(height as usize) else {
        return Err(format!(
            "mask_raster_register: width * height overflows ({width} * {height})"
        ));
    };
    if data.len() != expected_len {
        return Err(format!(
            "mask_raster_register: data length {} != width * height ({width} * {height} = {expected_len})",
            data.len()
        ));
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let raster = Arc::new(MaskRaster::from_u8(id, digest, width, height, data));
    with_registry(|r| r.insert(id, raster));
    Ok(id)
}

/// Forget a raster. Renders already holding an `Arc<MaskRaster>` (cloned out
/// of this registry before the release) keep it alive until they finish —
/// this only removes the registry's own reference.
pub(crate) fn release(id: u32) {
    with_registry(|r| {
        r.remove(&id);
    });
}

/// JS entry: see [`register`]. Throws (a rejected `JsError`) on a malformed
/// digest or a `data` length that doesn't match `width * height`.
#[wasm_bindgen]
pub fn mask_raster_register(
    digest: &str,
    width: u32,
    height: u32,
    data: &[u8],
) -> Result<u32, JsError> {
    register(digest, width, height, data).map_err(|e| JsError::new(&e))
}

/// JS entry: see [`release`].
#[wasm_bindgen]
pub fn mask_raster_release(id: u32) {
    release(id);
}

/// Resolve every `Mask::Bitmap` layer in `model.local_adjustments` against
/// this registry, in place, and populate `model.mask_rasters` with the
/// distinct rasters found — the same two-step lookup as raw-ffi's
/// `resolve_into`: a carried `raster_id` first (an in-session serialization
/// that still resolves), then the recipe `digest` (a fresh sidecar parse,
/// where the id is always `0`; or a stale id whose digest was re-registered
/// under a new one). A layer that resolves neither way is left exactly as
/// parsed — `raster_id` unchanged, never defaulted — so it renders as
/// weight 0.
pub(crate) fn resolve_into(model: &mut AdjustmentModel) {
    let mut rasters: Vec<Arc<MaskRaster>> = Vec::new();
    for layer in &mut model.local_adjustments {
        let Mask::Bitmap { recipe, raster_id } = &mut layer.mask else {
            continue;
        };
        let found = lookup(*raster_id).or_else(|| lookup_digest(&recipe.digest));
        if let Some(raster) = found {
            *raster_id = raster.id;
            if !rasters.iter().any(|r| r.id == raster.id) {
                rasters.push(raster);
            }
        }
    }
    model.mask_rasters = rasters;
}

/// Parse an optional XMP sidecar into a model with its bitmap masks resolved
/// against this registry — the ONE model-parse every render entry in this
/// crate goes through, so a registered raster applies on every path. `None`
/// (a fresh import with no sidecar) is `AdjustmentModel::default()`, the
/// same fresh-open contract `render_bytes` / `WebLiveSession` document.
pub(crate) fn parse_model(xmp: Option<&str>) -> raw_core::Result<AdjustmentModel> {
    let mut model = match xmp {
        Some(x) => raw_core::xmp::parse(x)?,
        None => AdjustmentModel::default(),
    };
    resolve_into(&mut model);
    Ok(model)
}

#[cfg(test)]
#[path = "mask_registry_tests.rs"]
mod tests;
