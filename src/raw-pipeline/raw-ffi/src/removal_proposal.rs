//! Thin native proposal preparation shared with the browser worker (#3941).
use crate::{
    cancel::{token_from_ptr, MapleCancelFlag},
    error::{catch_panic_rc, set_last_error},
};
use raw_core::{cancel::CancelToken, pipeline::PreparedRemovalGeneration};
use std::ffi::{c_char, c_void, CStr};

#[repr(C)]
pub struct MapleRemovalGeneration {
    inner: *mut c_void,
}

unsafe fn text<'a>(input: *const c_char) -> Result<&'a str, String> {
    if input.is_null() {
        return Err("null proposal string".into());
    }
    CStr::from_ptr(input).to_str().map_err(|e| e.to_string())
}
unsafe fn values<'a, T>(input: *const T, len: usize) -> Result<&'a [T], String> {
    if len > isize::MAX as usize / std::mem::size_of::<T>() {
        return Err("proposal input exceeds allocation".into());
    }
    if len == 0 {
        return Ok(&[]);
    }
    if input.is_null() {
        return Err("null proposal input".into());
    }
    Ok(std::slice::from_raw_parts(input, len))
}
unsafe fn prepared<'a>(
    owner: *const MapleRemovalGeneration,
) -> Result<&'a PreparedRemovalGeneration, String> {
    let owner = owner.as_ref().ok_or("null proposal owner")?;
    owner
        .inner
        .cast::<PreparedRemovalGeneration>()
        .as_ref()
        .ok_or_else(|| "closed proposal owner".into())
}
fn failed(error: String) -> i32 {
    set_last_error(error);
    5
}

unsafe fn write<T: Copy>(values: &[T], output: *mut T, cap: usize, length: *mut usize) -> i32 {
    if cap > isize::MAX as usize / std::mem::size_of::<T>() {
        return failed("proposal output exceeds allocation".into());
    }
    *length = values.len();
    if output.is_null() || cap < values.len() {
        return 100;
    }
    std::ptr::copy_nonoverlapping(values.as_ptr(), output, values.len());
    0
}

/// UTF-8 native context plan. 0 success, 1 null length, 5 invalid, 100 probe.
/// # Safety
/// source is NUL-terminated UTF-8; intent is readable for its length. length is
/// writable; non-null output is writable for cap bytes; all buffers disjoint.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_generation_plan_buf(
    source: *const c_char,
    intent: *const u8,
    intent_len: usize,
    hole_radius: u32,
    fringe_radius: f32,
    output: *mut u8,
    cap: usize,
    length: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_generation_plan_buf", || {
        if length.is_null() {
            return 1;
        }
        *length = 0;
        let result = (|| {
            raw_core::pipeline::plan_removal_generation(
                text(source)?,
                values(intent, intent_len)?,
                hole_radius,
                fringe_radius,
            )
        })();
        match result {
            Ok(value) => write(value.as_bytes(), output, cap, length),
            Err(e) => failed(e),
        }
    })
}

/// Complete painted-area intents, as u32 count and u32 length/MIMF records
/// in little-endian order. Every context is preflighted; failure emits no prefix.
/// 0 success, 1 null length, 5 invalid, 100 size probe.
/// # Safety
/// Same source, input/output allocation and disjointness contract as plan_buf.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_paint_intents_buf(
    source: *const c_char,
    intent: *const u8,
    intent_len: usize,
    hole_radius: u32,
    fringe_radius: f32,
    output: *mut u8,
    cap: usize,
    length: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_paint_intents_buf", || {
        if length.is_null() {
            return 1;
        }
        *length = 0;
        let result = (|| {
            raw_core::pipeline::paint_generation_intents_packed(
                text(source)?,
                values(intent, intent_len)?,
                hole_radius,
                fringe_radius,
            )
        })();
        match result {
            Ok(value) => write(&value, output, cap, length),
            Err(e) => failed(e),
        }
    })
}

/// Prepare an immutable native context. No model inference or file I/O.
/// 0 success, 1 null owner output, 5 invalid input, 99 caught panic.
/// # Safety
/// Strings are NUL-terminated UTF-8; inputs are readable for their lengths,
/// f32 inputs aligned. output is writable and disjoint, owner closed once.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_generation_open(
    request: *const c_char,
    prior: *const c_char,
    scene: *const f32,
    scene_len: usize,
    intent: *const u8,
    intent_len: usize,
    protected: *const u8,
    protected_len: usize,
    output: *mut *mut MapleRemovalGeneration,
) -> i32 {
    catch_panic_rc("maple_removal_generation_open", || {
        if output.is_null() {
            return 1;
        }
        *output = std::ptr::null_mut();
        let result = (|| {
            PreparedRemovalGeneration::prepare(
                text(request)?,
                text(prior)?,
                values(scene, scene_len)?,
                values(intent, intent_len)?,
                values(protected, protected_len)?,
            )
        })();
        match result {
            Ok(value) => {
                *output = Box::into_raw(Box::new(MapleRemovalGeneration {
                    inner: Box::into_raw(Box::new(value)).cast::<c_void>(),
                }));
                0
            }
            Err(e) => failed(e),
        }
    })
}

/// # Safety
/// owner is null or a live owner with no concurrent call; close exactly once.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_generation_close(owner: *mut MapleRemovalGeneration) {
    if !owner.is_null() {
        let owner = Box::from_raw(owner);
        drop(Box::from_raw(
            owner.inner.cast::<PreparedRemovalGeneration>(),
        ));
    }
}

/// kind=0 is 3×1024² CHW sRGB model guide; kind=1 is 1024² binary hole.
/// length/cap count f32 elements. 0 success, 1 null length, 5 invalid, 100 probe.
/// # Safety
/// owner stays live; length writable, output aligned/writable for cap f32s;
/// outputs disjoint from owner, and no concurrent close.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_generation_inputs_f32(
    owner: *const MapleRemovalGeneration,
    kind: u32,
    output: *mut f32,
    cap: usize,
    length: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_generation_inputs_f32", || {
        if length.is_null() {
            return 1;
        }
        *length = 0;
        let result = prepared(owner).and_then(|value| match kind {
            0 => Ok(value.rgb()),
            1 => Ok(value.hole()),
            _ => Err("unknown proposal input kind".into()),
        });
        match result {
            Ok(value) => write(value, output, cap, length),
            Err(e) => failed(e),
        }
    })
}

/// Accepted-publication request as UTF-8 JSON (no NUL), with the frozen recipe.
/// # Safety
/// owner stays live; length writable, output writable for cap bytes and disjoint.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_generation_request_buf(
    owner: *const MapleRemovalGeneration,
    output: *mut u8,
    cap: usize,
    length: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_generation_request_buf", || {
        if length.is_null() {
            return 1;
        }
        *length = 0;
        match prepared(owner) {
            Ok(value) => write(value.request().as_bytes(), output, cap, length),
            Err(e) => failed(e),
        }
    })
}

/// Validated native .f16 companion; no persistence. Invalid output cannot become
/// an accepted edit. Returns 0 success, 1 null length, 5 invalid, 20 cancelled,
/// 100 size probe.
/// # Safety
/// owner stays live; generated is aligned/readable for len f32s; cancel is null
/// or a live MapleCancelFlag. length writable; output writable for cap bytes,
/// disjoint from inputs/owner. No concurrent close or cancel-flag free.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_generation_finish_buf(
    owner: *const MapleRemovalGeneration,
    generated: *const f32,
    len: usize,
    cancel: *const MapleCancelFlag,
    output: *mut u8,
    cap: usize,
    length: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_generation_finish_buf", || {
        if length.is_null() {
            return 1;
        }
        *length = 0;
        let flag = token_from_ptr(cancel);
        let token = flag.as_ref().map_or_else(CancelToken::never, |flag| {
            CancelToken::new(unsafe { flag.as_ref() })
        });
        let result = prepared(owner).and_then(|value| value.finish(values(generated, len)?, token));
        match result {
            Ok(value) => write(&value, output, cap, length),
            Err(error) if error == "guided removal: cancelled" => {
                set_last_error(error);
                20
            }
            Err(e) => failed(e),
        }
    })
}

#[cfg(test)]
#[path = "removal_proposal_tests.rs"]
mod tests;
