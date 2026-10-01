//! Verified accepted companions on a retained RAW (#3955). Cold inspection and
//! export share raw-core; no inference, original mutation or per-tick asset I/O.
use crate::{
    error::{catch_panic_rc, set_last_error, with_large_stack},
    handle::{MapleRawHandle, MapleRawHandleInner},
    model::{load_xmp_model_from_doc, LoadModel},
};
use raw_core::{
    pipeline::{RawInput, RenderQuality, ResolvedCalibrationRemovals},
    types::accepted_removal::ContentDigest,
};
use std::ffi::{c_char, CStr};

/// Immutable prepared stack plus original bytes for RAW-pinned Auto fitting.
/// Caller keeps the associated RAW handle alive and frees this exactly once.
#[repr(C)]
pub struct MapleSavedRemovals {
    inner: *mut std::ffi::c_void,
}

struct SavedState {
    stack: ResolvedCalibrationRemovals,
    original: ContentDigest,
    source: Vec<u8>,
    ext: String,
}

/// Rust-owned removal output. Preview is packed RGB8; export is its encoded
/// container; selection is MIMF; detection is UTF-8 JSON. The called entry point
/// determines the byte format. Dimensions describe the image/mask source.
#[repr(C)]
pub struct MapleRemovalBuffer {
    pub bytes: *mut u8,
    pub len: usize,
    pub width: u32,
    pub height: u32,
}
impl MapleRemovalBuffer {
    pub(super) fn empty() -> Self {
        Self {
            bytes: std::ptr::null_mut(),
            len: 0,
            width: 0,
            height: 0,
        }
    }
    pub(super) fn owned(width: u32, height: u32, bytes: Vec<u8>) -> Self {
        let data = bytes.into_boxed_slice();
        Self {
            len: data.len(),
            bytes: Box::into_raw(data).cast::<u8>(),
            width,
            height,
        }
    }
}

unsafe fn inner<'a>(raw: *const MapleRawHandle) -> Result<&'a MapleRawHandleInner, String> {
    let handle = raw.as_ref().ok_or("null RAW handle")?;
    (handle.inner as *const MapleRawHandleInner)
        .as_ref()
        .ok_or_else(|| "closed RAW handle".into())
}
unsafe fn saved<'a>(owner: *const MapleSavedRemovals) -> Result<&'a SavedState, String> {
    let owner = owner.as_ref().ok_or("null saved-removal owner")?;
    (owner.inner as *const SavedState)
        .as_ref()
        .ok_or_else(|| "closed saved-removal owner".into())
}

/// Bounded native calibration RGB including the complete accepted stack.
/// cap/length count f32 elements. Failure never changes output. 0 success,
/// 1 null length, 5 invalid source/stack/geometry, 20 cancelled, 100 probe.
/// # Safety
/// raw/owner/cancel remain live until return; xmp NUL-terminated UTF-8. length
/// writable; non-null output aligned/writable for cap f32s, disjoint from owners.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_saved_context_f32(
    raw: *const MapleRawHandle,
    owner: *const MapleSavedRemovals,
    xmp: *const c_char,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    cancel: *const crate::cancel::MapleCancelFlag,
    output: *mut f32,
    cap: usize,
    length: *mut usize,
) -> i32 {
    if length.is_null() {
        return 1;
    }
    *length = 0;
    if cap > isize::MAX as usize / std::mem::size_of::<f32>() {
        return failed("saved context capacity exceeds allocation".into());
    }
    let args = (
        raw as usize,
        owner as usize,
        xmp as usize,
        cancel as usize,
        output as usize,
        length as usize,
    );
    with_large_stack(move || {
        let raw = match inner(args.0 as *const MapleRawHandle) {
            Ok(raw) => raw,
            Err(e) => return failed(e),
        };
        let owner = match saved(args.1 as *const MapleSavedRemovals) {
            Ok(owner) => owner,
            Err(e) => return failed(e),
        };
        if owner.original != raw.original {
            return failed("saved context RAW owner changed".into());
        }
        let xmp = match text(args.2 as *const c_char) {
            Ok(xmp) => xmp,
            Err(e) => return failed(e),
        };
        let model = match load_xmp_model_from_doc(Some(xmp)) {
            LoadModel::Ok(model) => model,
            LoadModel::Err(code) => return code,
        };
        let flag = crate::cancel::token_from_ptr(args.3 as *const crate::cancel::MapleCancelFlag);
        let token = flag
            .as_ref()
            .map_or_else(raw_core::cancel::CancelToken::never, |flag| {
                raw_core::cancel::CancelToken::new(flag.as_ref())
            });
        let image = match owner.stack.generation_context(
            &raw.raw,
            &raw.original,
            &model,
            raw_core::types::accepted_removal::NativeWindow {
                x,
                y,
                width,
                height,
            },
            token,
        ) {
            Ok(image) => image,
            Err(raw_core::Error::Cancelled) => return 20,
            Err(e) => return failed(e.to_string()),
        };
        let count = image.pixels.len() * 3;
        *(args.5 as *mut usize) = count;
        if args.4 == 0 || cap < count {
            return 100;
        }
        std::ptr::copy_nonoverlapping(
            image.pixels.as_ptr().cast::<f32>(),
            args.4 as *mut f32,
            count,
        );
        0
    })
}
unsafe fn text<'a>(value: *const c_char) -> Result<&'a str, String> {
    if value.is_null() {
        return Err("null saved-render string".into());
    }
    CStr::from_ptr(value).to_str().map_err(|e| e.to_string())
}
unsafe fn bytes<'a>(input: *const u8, length: usize) -> Result<&'a [u8], String> {
    if length > isize::MAX as usize {
        return Err("saved-render input exceeds an allocation".into());
    }
    if length == 0 {
        return Ok(&[]);
    }
    if input.is_null() {
        return Err("null saved-render input".into());
    }
    Ok(std::slice::from_raw_parts(input, length))
}
fn failed(error: String) -> i32 {
    set_last_error(error);
    5
}

/// Validate all assets/source before publishing an immutable owner. Source
/// bytes are copied once after validation and retained for the Auto view tail.
/// No RAW re-decode. Returns 0 success, 1 null output, 5 invalid, 99 panic.
///
/// # Safety
/// raw is live for the call; strings are NUL-terminated UTF-8; source/companions
/// are readable for their lengths; output is writable, initially null, and
/// disjoint from inputs. The returned owner must be closed exactly once.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_saved_open(
    raw: *const MapleRawHandle,
    xmp: *const c_char,
    manifest: *const c_char,
    companions: *const u8,
    companions_len: usize,
    source: *const u8,
    source_len: usize,
    ext: *const c_char,
    output: *mut *mut MapleSavedRemovals,
) -> i32 {
    catch_panic_rc("maple_removal_saved_open", || {
        if output.is_null() {
            return 1;
        }
        *output = std::ptr::null_mut();
        let result = (|| {
            let raw = inner(raw)?;
            let source = bytes(source, source_len)?;
            if ContentDigest::for_bytes(source) != raw.original {
                return Err("saved-removal original bytes differ from decoded RAW".into());
            }
            let model = match load_xmp_model_from_doc(Some(text(xmp)?)) {
                LoadModel::Ok(model) => model,
                LoadModel::Err(code) => return Err(format!("saved-removal XMP invalid ({code})")),
            };
            let stack = ResolvedCalibrationRemovals::prepare_bundle(
                &raw.raw,
                &raw.original,
                &model.inpaint_removals,
                text(manifest)?,
                bytes(companions, companions_len)?,
            )?;
            Ok(SavedState {
                stack,
                original: raw.original.clone(),
                source: source.to_vec(),
                ext: text(ext)?.to_owned(),
            })
        })();
        match result {
            Ok(saved) => {
                let inner = Box::into_raw(Box::new(saved)).cast::<std::ffi::c_void>();
                *output = Box::into_raw(Box::new(MapleSavedRemovals { inner }));
                0
            }
            Err(e) => failed(e),
        }
    })
}

/// # Safety
/// owner is null or a live owner returned by open, with no concurrent calls.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_saved_close(owner: *mut MapleSavedRemovals) {
    if !owner.is_null() {
        let owner = Box::from_raw(owner);
        drop(Box::from_raw(owner.inner.cast::<SavedState>()));
    }
}

/// Ordered dependency-review indices as UTF-8 JSON. 100 is a size probe;
/// 0 success, 1 null owner/length, 5 invalid capacity, 99 panic. No inference.
/// # Safety
/// owner is live; length is writable; non-null output is writable for cap bytes;
/// all output storage is disjoint from the owner.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_saved_review_buf(
    owner: *const MapleSavedRemovals,
    output: *mut u8,
    cap: usize,
    length: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_saved_review_buf", || {
        if length.is_null() {
            return 1;
        }
        *length = 0;
        let owner = match saved(owner) {
            Ok(owner) => owner,
            Err(e) => return failed(e),
        };
        if cap > isize::MAX as usize {
            return failed("saved review capacity exceeds an allocation".into());
        }
        let json = match serde_json::to_vec(owner.stack.needs_review()) {
            Ok(json) => json,
            Err(e) => return failed(e.to_string()),
        };
        *length = json.len();
        if output.is_null() || cap < json.len() {
            return 100;
        }
        std::ptr::copy_nonoverlapping(json.as_ptr(), output, json.len());
        0
    })
}

/// Cold RGB8 inspection. cap=0 native, otherwise bounded early-downsample;
/// film is an optional MLUT buffer. This is not the retained GPU slider path.
/// # Safety
/// raw/owner remain live until return; xmp is NUL-terminated UTF-8; film is
/// readable for film_len; output is writable, initially empty and disjoint.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_saved_preview(
    raw: *const MapleRawHandle,
    owner: *const MapleSavedRemovals,
    xmp: *const c_char,
    cap: u32,
    film: *const u8,
    film_len: usize,
    output: *mut MapleRemovalBuffer,
) -> i32 {
    if output.is_null() {
        return 1;
    }
    *output = MapleRemovalBuffer::empty();
    let args = (
        raw as usize,
        owner as usize,
        xmp as usize,
        film as usize,
        output as usize,
    );
    with_large_stack(move || {
        let result = (|| {
            let raw = inner(args.0 as *const MapleRawHandle)?;
            let owner = saved(args.1 as *const MapleSavedRemovals)?;
            if owner.original != raw.original {
                return Err("saved-removal RAW owner changed".into());
            }
            let model = match load_xmp_model_from_doc(Some(text(args.2 as *const c_char)?)) {
                LoadModel::Ok(model) => model,
                LoadModel::Err(code) => return Err(format!("saved XMP invalid ({code})")),
            };
            let lut = film_lut(bytes(args.3 as *const u8, film_len)?)?;
            let (w, h, rgb) = owner
                .stack
                .render_display(
                    &raw.raw,
                    &raw.original,
                    &model,
                    RenderQuality::Auto,
                    Some(RawInput::Bytes {
                        bytes: &owner.source,
                        ext: &owner.ext,
                    }),
                    (cap > 0).then_some(cap),
                    lut.as_ref(),
                )
                .map_err(|e| e.to_string())?;
            Ok(MapleRemovalBuffer::owned(w, h, rgb))
        })();
        match result {
            Ok(buffer) => {
                *(args.4 as *mut MapleRemovalBuffer) = buffer;
                0
            }
            Err(e) => failed(e),
        }
    })
}

/// ICC-tagged deliverable bytes; request is the shared saved-export JSON.
/// # Safety
/// Same ownership/disjoint-storage requirements as preview. request is an
/// additional NUL-terminated UTF-8 string. No output allocation on failure.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_saved_export(
    raw: *const MapleRawHandle,
    owner: *const MapleSavedRemovals,
    xmp: *const c_char,
    request: *const c_char,
    film: *const u8,
    film_len: usize,
    output: *mut MapleRemovalBuffer,
) -> i32 {
    if output.is_null() {
        return 1;
    }
    *output = MapleRemovalBuffer::empty();
    let args = (
        raw as usize,
        owner as usize,
        xmp as usize,
        request as usize,
        film as usize,
        output as usize,
    );
    with_large_stack(move || {
        let result = (|| {
            let raw = inner(args.0 as *const MapleRawHandle)?;
            let owner = saved(args.1 as *const MapleSavedRemovals)?;
            if owner.original != raw.original {
                return Err("saved-removal RAW owner changed".into());
            }
            let model = match load_xmp_model_from_doc(Some(text(args.2 as *const c_char)?)) {
                LoadModel::Ok(model) => model,
                LoadModel::Err(code) => return Err(format!("saved XMP invalid ({code})")),
            };
            let options =
                raw_core::export::parse_removal_export_options(text(args.3 as *const c_char)?)?;
            let lut = film_lut(bytes(args.4 as *const u8, film_len)?)?;
            let image = owner
                .stack
                .export_encoded(
                    &raw.raw,
                    &raw.original,
                    &model,
                    Some(RawInput::Bytes {
                        bytes: &owner.source,
                        ext: &owner.ext,
                    }),
                    &options,
                    lut.as_ref(),
                )
                .map_err(|e| e.to_string())?;
            Ok(MapleRemovalBuffer::owned(
                image.width,
                image.height,
                image.bytes,
            ))
        })();
        match result {
            Ok(buffer) => {
                *(args.5 as *mut MapleRemovalBuffer) = buffer;
                0
            }
            Err(e) => failed(e),
        }
    })
}

fn film_lut(bytes: &[u8]) -> Result<Option<raw_core::film::FilmLut>, String> {
    if bytes.is_empty() {
        Ok(None)
    } else {
        raw_core::film::decode_mlut(bytes)
            .map(Some)
            .map_err(|e| e.to_string())
    }
}

/// Free owned removal output and clear its descriptor; null/empty is a no-op.
/// # Safety
/// output is null, empty, or a descriptor returned by a removal entry point,
/// with no concurrent access. The byte pointer/length must be unchanged.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_saved_free_buffer(output: *mut MapleRemovalBuffer) {
    if let Some(output) = output.as_mut() {
        if !output.bytes.is_null() {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                output.bytes,
                output.len,
            )));
        }
        *output = MapleRemovalBuffer::empty();
    }
}

#[cfg(test)]
#[path = "removal_saved_tests.rs"]
mod tests;
