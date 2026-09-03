//! Process-wide bitmap-mask raster registry (#3271, spec §5.3 as refined by
//! the implementation plan: rasters do NOT ride the per-tick params structs
//! as a table + plane — that would mean a multi-megabyte copy across the FFI
//! on every slider tick even when the mask itself hasn't changed. Instead the
//! host registers each raster ONCE, gets back an id, and every entry family
//! (XMP parse, the CPU chain params, the GPU-live params) resolves that id
//! from this one process-wide table.
//!
//! A `Mask::Bitmap` layer's `raster_id` is meaningless outside the process
//! that registered it — a fresh launch, or a raster the host never
//! re-registered this session, resolves to nothing. [`resolve_into`] and
//! [`layers_and_rasters_from_flat`] both leave that case as an UNRESOLVED
//! bitmap mask (weight 0 everywhere) rather than inventing a fallback,
//! matching `Mask::Bitmap`'s own doc: "`0` means unresolved, which evaluates
//! to weight 0 (never a global correction) rather than silently falling back
//! to `Everywhere`."

use raw_core::types::local_adjustment::flat::KIND_BITMAP;
use raw_core::types::{layers_from_flat, LocalAdjustment, Mask, MaskRaster, LAYER_FLAT_LEN};
use raw_core::xmp::AdjustmentModel;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

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

/// Register an R8 raster (row-major, `width * height` bytes, `0` = weight 0,
/// `255` = weight 1) under a 16-lowercase-hex-char digest. Returns the raster
/// id (>= 1) a `Mask::Bitmap` record's `raster_id` resolves against, or a
/// negative error code.
///
/// `digest_ptr` must point at exactly 16 bytes (no NUL terminator — the
/// caller knows the length). Re-registering the SAME digest gets a NEW id
/// each call; the caller is responsible for releasing the old one via
/// [`maple_mask_raster_release`] once no in-flight render references it,
/// the same handle-lifecycle contract `MapleCancelFlag` and
/// `MapleFallbackIdHasher` use elsewhere in this crate.
///
/// # Safety
/// `digest_ptr` must be valid for 16 `u8` reads. `data_ptr` must be valid for
/// `data_len` `u8` reads, or null when `data_len == 0`.
///
/// Returns:
///    id  success (>= 1)
///   -1   `digest_ptr` null, or `data_ptr` null with `data_len > 0`
///   -2   `data_len != width * height`
///   -3   the 16 bytes at `digest_ptr` are not valid lowercase hex (or not
///        valid UTF-8 at all)
#[no_mangle]
pub extern "C" fn maple_mask_raster_register(
    digest_ptr: *const u8,
    width: u32,
    height: u32,
    data_ptr: *const u8,
    data_len: usize,
) -> i32 {
    if digest_ptr.is_null() || (data_ptr.is_null() && data_len > 0) {
        return -1;
    }
    let expected_len = (width as usize) * (height as usize);
    if data_len != expected_len {
        return -2;
    }
    let digest_bytes = unsafe { std::slice::from_raw_parts(digest_ptr, 16) };
    let Ok(digest) = std::str::from_utf8(digest_bytes) else {
        return -3;
    };
    let is_lowercase_hex = digest.len() == 16
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !is_lowercase_hex {
        return -3;
    }
    let data: &[u8] = if data_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(data_ptr, data_len) }
    };

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let raster = Arc::new(MaskRaster::from_u8(id, digest, width, height, data));
    with_registry(|r| r.insert(id, raster));
    id as i32
}

/// Forget a raster. Renders already holding an `Arc<MaskRaster>` (cloned out
/// of this registry before the release, e.g. mid-flight on another thread)
/// keep it alive until they finish — this only removes the registry's own
/// reference, so no in-flight render is invalidated.
#[no_mangle]
pub extern "C" fn maple_mask_raster_release(id: u32) {
    with_registry(|r| {
        r.remove(&id);
    });
}

/// Resolve every `Mask::Bitmap` layer in `model.local_adjustments` against
/// this registry, in place, and populate `model.mask_rasters` with the
/// distinct rasters found.
///
/// Two ways a Bitmap mask reaches here with an UNRESOLVED raster:
/// * `raster_id == 0` — freshly parsed from a sidecar, which never carries
///   pixels, only the recipe (spec §5.3). Resolved by `recipe.digest`.
/// * `raster_id != 0` but stale — a value serialized in-process earlier this
///   session whose raster has since been released. Resolved by id first,
///   falling back to digest (matches `stages::local_adjustments::mask::resolve`'s
///   own fallback order) — a re-registration of the same recipe under a new
///   id still finds it.
///
/// A layer that resolves neither way is left exactly as parsed: `raster_id`
/// unchanged (0 stays 0), not defaulted to anything — `AdjustmentModel`'s own
/// mask evaluator already treats an unresolved id as weight 0.
pub(crate) fn resolve_into(model: &mut AdjustmentModel) {
    let mut rasters: Vec<Arc<MaskRaster>> = Vec::new();
    for layer in &mut model.local_adjustments {
        let Mask::Bitmap { recipe, raster_id } = &mut layer.mask else {
            continue;
        };
        let found = if *raster_id != 0 {
            lookup(*raster_id)
        } else {
            None
        }
        .or_else(|| lookup_digest(&recipe.digest));
        if let Some(raster) = found {
            *raster_id = raster.id;
            if !rasters.iter().any(|r| r.id == raster.id) {
                rasters.push(raster);
            }
        }
    }
    model.mask_rasters = rasters;
}

/// Decode a flat local-adjustment wire (`raw_core::types::layers_from_flat`'s
/// own wire — see `scene_linear_chain::read_local_adjustments` /
/// `gpu_live::params`) and resolve every `KIND_BITMAP` record's `raster_id`
/// against this registry.
///
/// Unlike [`resolve_into`], there is no digest to fall back on here: the
/// per-tick params wire carries only the id (see `flat.rs`'s slot map), so a
/// `raster_id` that doesn't resolve stays a `Mask::Bitmap` with an empty
/// recipe and that same unresolved id — weight 0, the same "never a silent
/// global correction" contract.
pub(crate) fn layers_and_rasters_from_flat(
    flat: &[f32],
) -> (Vec<LocalAdjustment>, Vec<Arc<MaskRaster>>) {
    let mut ids: Vec<u32> = Vec::new();
    for slot in flat.chunks_exact(LAYER_FLAT_LEN) {
        if slot[6] == KIND_BITMAP {
            let id = slot[2] as u32;
            if id != 0 && !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    let rasters: Vec<Arc<MaskRaster>> = ids.into_iter().filter_map(lookup).collect();
    (layers_from_flat(flat, &rasters), rasters)
}

#[cfg(test)]
#[path = "mask_registry_tests.rs"]
mod tests;
