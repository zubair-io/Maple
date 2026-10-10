//! Native Smart paint and person proposals (#3941/#3942). Thin marshalling;
//! model execution and prompt checks remain in maple-removal/raw-core.
use crate::{
    error::{catch_panic_rc, set_last_error},
    removal_inference::{new_operation, operation, utf8, MapleRemovalInference},
    removal_saved::MapleRemovalBuffer,
};
use maple_removal::{OrtRuntime, PersonDetector, SelectionEmbedding, SmartSelector};
use raw_core::types::accepted_removal::SourceAnchor;
use std::{
    ffi::{c_char, c_void},
    path::Path,
    sync::{atomic::Ordering, Mutex},
};

#[repr(C)]
pub struct MapleRemovalSelector {
    inner: *mut c_void,
}
#[repr(C)]
pub struct MapleRemovalEmbedding {
    inner: *mut c_void,
}
#[repr(C)]
pub struct MapleRemovalDetector {
    inner: *mut c_void,
}
struct Embedding {
    selector: usize,
    value: SelectionEmbedding,
}

fn failed(error: impl ToString) -> i32 {
    set_last_error(error.to_string());
    5
}
unsafe fn runtime(path: *const c_char) -> Result<OrtRuntime, String> {
    let explicit = if path.is_null() {
        None
    } else {
        Some(Path::new(utf8(path)?))
    };
    OrtRuntime::preflight(explicit).map_err(|e| e.to_string())
}
unsafe fn selector<'a>(
    owner: *const MapleRemovalSelector,
) -> Result<&'a Mutex<SmartSelector>, String> {
    owner
        .as_ref()
        .and_then(|v| v.inner.cast::<Mutex<SmartSelector>>().as_ref())
        .ok_or_else(|| "null removal selector".into())
}
unsafe fn detector<'a>(
    owner: *const MapleRemovalDetector,
) -> Result<&'a Mutex<PersonDetector>, String> {
    owner
        .as_ref()
        .and_then(|v| v.inner.cast::<Mutex<PersonDetector>>().as_ref())
        .ok_or_else(|| "null removal detector".into())
}
unsafe fn source(value: *const c_char) -> Result<SourceAnchor, String> {
    serde_json::from_str(utf8(value)?).map_err(|e| e.to_string())
}

/// Load the pinned encoder/decoder from a local directory. No download.
/// 0 success, 1 null output, 5 invalid/load failure, 99 panic.
/// # Safety
/// Strings are NUL-terminated UTF-8, output is writable/disjoint and initially
/// null. The returned owner stays alive through its embeddings and operations.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_selector_open(
    directory: *const c_char,
    dylib: *const c_char,
    output: *mut *mut MapleRemovalSelector,
) -> i32 {
    catch_panic_rc("maple_removal_selector_open", || {
        if output.is_null() {
            return 1;
        }
        *output = std::ptr::null_mut();
        let result = (|| {
            let directory = Path::new(utf8(directory)?);
            let runtime = runtime(dylib)?;
            SmartSelector::load(directory, &runtime).map_err(|e| e.to_string())
        })();
        match result {
            Ok(model) => {
                let inner = Box::into_raw(Box::new(Mutex::new(model))).cast();
                *output = Box::into_raw(Box::new(MapleRemovalSelector { inner }));
                0
            }
            Err(e) => failed(e),
        }
    })
}

/// # Safety
/// owner is null or exclusively owned, with all operations/embeddings finished.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_selector_close(owner: *mut MapleRemovalSelector) {
    if !owner.is_null() {
        let owner = Box::from_raw(owner);
        drop(Box::from_raw(owner.inner.cast::<Mutex<SmartSelector>>()));
    }
}

/// Create one cancellable encode/refine operation after selector initialization.
/// # Safety
/// owner is live; output is writable/disjoint. Free the operation once after
/// encode/refine/cancel calls return. Cancellation can run concurrently.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_selector_operation_new(
    owner: *const MapleRemovalSelector,
    output: *mut *mut MapleRemovalInference,
) -> i32 {
    catch_panic_rc("maple_removal_selector_operation_new", || {
        if output.is_null() {
            return 1;
        }
        *output = std::ptr::null_mut();
        if let Err(e) = selector(owner) {
            return failed(e);
        }
        new_operation(output)
    })
}

/// Encode an immutable photographic 1024² CHW context in 0..255. Source and
/// window bind the embedding; prompts may change during later refinement.
/// 20 means cancelled; failed/cancelled runs publish no embedding.
/// # Safety
/// All owners/operation remain live until return; strings are UTF-8 C strings,
/// RGB is readable for rgb_len f32s; output is writable/disjoint, initially null.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_selector_encode(
    owner: *const MapleRemovalSelector,
    op: *const MapleRemovalInference,
    anchor: *const c_char,
    request: *const c_char,
    rgb: *const f32,
    rgb_len: usize,
    output: *mut *mut MapleRemovalEmbedding,
) -> i32 {
    catch_panic_rc("maple_removal_selector_encode", || {
        if output.is_null() {
            return 1;
        }
        *output = std::ptr::null_mut();
        let result: Result<Option<SelectionEmbedding>, String> = (|| {
            let model = selector(owner)?;
            let op = operation(op)?;
            if op.cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            if rgb.is_null() || rgb_len != 3 * 1024 * 1024 {
                return Err("selection tensor size mismatch".into());
            }
            let source = source(anchor)?;
            let mut model = model.lock().map_err(|e| e.to_string())?;
            if op.cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            let result = model.encode(
                &source,
                utf8(request)?,
                std::slice::from_raw_parts(rgb, rgb_len),
                &op.options,
            );
            if op.cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            result.map(Some).map_err(|e| e.to_string())
        })();
        match result {
            Ok(Some(value)) => {
                let inner = Box::into_raw(Box::new(Embedding {
                    selector: owner as usize,
                    value,
                }))
                .cast();
                *output = Box::into_raw(Box::new(MapleRemovalEmbedding { inner }));
                0
            }
            Ok(None) => 20,
            Err(e) => failed(e),
        }
    })
}

/// # Safety
/// embedding is null or exclusively owned and no refinement is in flight.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_embedding_free(embedding: *mut MapleRemovalEmbedding) {
    if !embedding.is_null() {
        let embedding = Box::from_raw(embedding);
        drop(Box::from_raw(embedding.inner.cast::<Embedding>()));
    }
}

/// Refine positive/negative prompts against the retained source embedding.
/// Output is a lossless MIMF selection, not accepted pixels. Shared prompt
/// checks reject failed candidates; no prior selection is modified here.
/// # Safety
/// All owners stay live; strings are UTF-8 C strings; output is writable,
/// empty and disjoint. Free successful output with saved_free_buffer.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_selector_refine(
    owner: *const MapleRemovalSelector,
    op: *const MapleRemovalInference,
    embedding: *const MapleRemovalEmbedding,
    anchor: *const c_char,
    request: *const c_char,
    output: *mut MapleRemovalBuffer,
) -> i32 {
    catch_panic_rc("maple_removal_selector_refine", || {
        if output.is_null() {
            return 1;
        }
        *output = MapleRemovalBuffer::empty();
        let result: Result<Option<MapleRemovalBuffer>, String> = (|| {
            let model = selector(owner)?;
            let op = operation(op)?;
            let embedding = embedding
                .as_ref()
                .and_then(|v| v.inner.cast::<Embedding>().as_ref())
                .ok_or("null selection embedding")?;
            if embedding.selector != owner as usize {
                return Err("selection embedding owner mismatch".into());
            }
            if op.cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            let source = source(anchor)?;
            let mut model = model.lock().map_err(|e| e.to_string())?;
            if op.cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            let result = model.refine(&source, &embedding.value, utf8(request)?, &op.options);
            if op.cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            let bytes = result.map_err(|e| e.to_string())?;
            let mask = raw_core::pipeline::removal_mask_from_bytes(&bytes)?;
            Ok(Some(MapleRemovalBuffer::owned(
                mask.source_width,
                mask.source_height,
                bytes,
            )))
        })();
        match result {
            Ok(Some(buffer)) => {
                *output = buffer;
                0
            }
            Ok(None) => 20,
            Err(e) => failed(e),
        }
    })
}

/// Load pinned RT-DETR person proposals. This does not classify background
/// people or protect subjects; the editing flow must review those roles.
/// # Safety
/// Same string/output/lifetime contract as selector_open.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_detector_open(
    directory: *const c_char,
    dylib: *const c_char,
    output: *mut *mut MapleRemovalDetector,
) -> i32 {
    catch_panic_rc("maple_removal_detector_open", || {
        if output.is_null() {
            return 1;
        }
        *output = std::ptr::null_mut();
        let result = (|| {
            let directory = Path::new(utf8(directory)?);
            let runtime = runtime(dylib)?;
            PersonDetector::load(directory, &runtime).map_err(|e| e.to_string())
        })();
        match result {
            Ok(model) => {
                let inner = Box::into_raw(Box::new(Mutex::new(model))).cast();
                *output = Box::into_raw(Box::new(MapleRemovalDetector { inner }));
                0
            }
            Err(e) => failed(e),
        }
    })
}

/// # Safety
/// owner is null or exclusively owned, with all detection calls finished.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_detector_close(owner: *mut MapleRemovalDetector) {
    if !owner.is_null() {
        let owner = Box::from_raw(owner);
        drop(Box::from_raw(owner.inner.cast::<Mutex<PersonDetector>>()));
    }
}

/// # Safety
/// Same operation ownership contract as selector_operation_new.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_detector_operation_new(
    owner: *const MapleRemovalDetector,
    output: *mut *mut MapleRemovalInference,
) -> i32 {
    catch_panic_rc("maple_removal_detector_operation_new", || {
        if output.is_null() {
            return 1;
        }
        *output = std::ptr::null_mut();
        if let Err(e) = detector(owner) {
            return failed(e);
        }
        new_operation(output)
    })
}

/// 640² CHW float photographic RGB in 0..1. JSON contains all 300 proposals;
/// bounds are native source pixels. No threshold or background role is invented.
/// # Safety
/// Owners remain live; RGB is readable for rgb_len f32s, output is writable,
/// empty/disjoint. Free successful output with saved_free_buffer.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_detector_detect(
    owner: *const MapleRemovalDetector,
    op: *const MapleRemovalInference,
    rgb: *const f32,
    rgb_len: usize,
    width: u32,
    height: u32,
    output: *mut MapleRemovalBuffer,
) -> i32 {
    maple_removal_detector_detect_oriented(owner, op, rgb, rgb_len, width, height, 1, output)
}

/// Native source-framed detector input plus TIFF EXIF tag (1–8). Semantic
/// inference sees upright pixels, but output boxes use original source axes.
/// # Safety
/// Same owner, tensor and output lifetime/disjointness as detector_detect.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_detector_detect_oriented(
    owner: *const MapleRemovalDetector,
    op: *const MapleRemovalInference,
    rgb: *const f32,
    rgb_len: usize,
    width: u32,
    height: u32,
    orientation: u32,
    output: *mut MapleRemovalBuffer,
) -> i32 {
    catch_panic_rc("maple_removal_detector_detect", || {
        if output.is_null() {
            return 1;
        }
        *output = MapleRemovalBuffer::empty();
        let result: Result<Option<MapleRemovalBuffer>, String> = (|| {
            let model = detector(owner)?;
            let op = operation(op)?;
            if op.cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            if rgb.is_null() || rgb_len != 3 * 640 * 640 {
                return Err("detector tensor size mismatch".into());
            }
            let orientation = u16::try_from(orientation)
                .map_err(|_| "person detection: invalid EXIF orientation")?;
            raw_core::stages::removal_detection_geometry::upright_size(
                [width, height],
                orientation,
            )?;
            let mut model = model.lock().map_err(|e| e.to_string())?;
            if op.cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            let result = model.detect_oriented(
                std::slice::from_raw_parts(rgb, rgb_len),
                [width, height],
                orientation,
                &op.options,
            );
            if op.cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            let proposals = result.map_err(|e| e.to_string())?;
            let bytes = serde_json::to_vec(&proposals).map_err(|e| e.to_string())?;
            Ok(Some(MapleRemovalBuffer::owned(width, height, bytes)))
        })();
        match result {
            Ok(Some(buffer)) => {
                *output = buffer;
                0
            }
            Ok(None) => 20,
            Err(e) => failed(e),
        }
    })
}

#[cfg(test)]
#[path = "removal_selection_inference_tests.rs"]
mod tests;
