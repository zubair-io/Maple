//! #1472: cancellable native Auto preparation, off the Apple GPU actor.
//! Uses the full render's pinned develop and Render(None) quality key. The
//! standalone proxy API stays unchanged. One fit returns both GPU artifacts
//! for both render paths, avoiding a second fit or host color math.
use crate::{
    cancel::{token_from_ptr, MapleCancelFlag, SendCancelPtr},
    error::{set_last_error, with_large_stack},
};
use raw_core::{
    pipeline::{cached_auto_profile_fit, fit_native_auto_profile_cancellable, RawInput},
    view::auto_profile::{
        cache::{CacheKey, FitOrigin},
        ProfileCurve, PROFILE_CURVE_FLAT_LEN,
    },
    xmp::AdjustmentModel,
    CancelToken, Error,
};
use std::{
    ffi::{c_char, CStr},
    path::Path,
};

/// Prepare the unchanged full-render Auto tail at quality 0 Full, 1 Preview,
/// 2 AMaZE or 3 Auto. Preview is uncapped at its half-resolution demosaic;
/// quality keys never alias. The fit ignores live edits and accepted patches.
/// Returns 0 with artifacts, 1 without a usable tail, 4 cancelled, 6/7 on
/// read/decode failure, 8 on develop failure, 10 if original identity changes,
/// -1 for invalid pointers/quality, -2 for insufficient residual capacity.
/// Scalar outputs are reset at entry; on -2 lut_size reports the needed edge.
/// Array outputs are untouched on any failure. Cancellation may finish a
/// noninterruptible solver; no cancelled result is copied to the host.
///
/// # Safety
/// raw_path is a valid UTF-8 C string. curve_out holds >=220 aligned f32;
/// lut_out holds its capacity of aligned f32. Scalar outputs are
/// valid aligned writable pointers. Buffers do not overlap and remain alive
/// through return. cancel is null or a live maple_cancel_flag_new allocation,
/// retained until this synchronous call (including its joined worker) returns.
#[no_mangle]
pub unsafe extern "C" fn maple_prepare_native_auto_profile(
    raw_path: *const c_char,
    quality: i32,
    curve_out: *mut f32,
    curve_present: *mut i32,
    lut_out: *mut f32,
    lut_capacity: usize,
    lut_size: *mut u32,
    cancel: *const MapleCancelFlag,
) -> i32 {
    if !(0..=3).contains(&quality)
        || raw_path.is_null()
        || [curve_out, lut_out]
            .iter()
            .any(|p| p.is_null() || (*p as usize) % std::mem::align_of::<f32>() != 0)
        || curve_present.is_null()
        || lut_size.is_null()
        || (curve_present as usize) % std::mem::align_of::<i32>() != 0
        || (lut_size as usize) % std::mem::align_of::<u32>() != 0
    {
        return -1;
    }
    *curve_present = 0;
    *lut_size = 0;
    let path = match CStr::from_ptr(raw_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(_) => return 2,
    };
    let out = (
        curve_out as usize,
        curve_present as usize,
        lut_out as usize,
        lut_size as usize,
    );
    let cancel = SendCancelPtr(cancel);
    with_large_stack(move || {
        let cancel = cancel;
        let token = match token_from_ptr(cancel.0) {
            Some(flag) => CancelToken::new(flag.as_ref()),
            None => CancelToken::never(),
        };
        if token.is_cancelled() {
            return 4;
        }
        let path = Path::new(&path);
        let quality = crate::auto_profile::quality_from_wire(quality);
        let identity = identity(path, quality);
        let Some((key, _, _)) = identity.as_ref() else {
            set_last_error("native Auto: original metadata unavailable".into());
            return 6;
        };
        let model = AdjustmentModel::default();
        let pair = match cached_auto_profile_fit(&model, Some(key)) {
            Some(pair) => Some(pair),
            None => {
                let raw =
                    match crate::scene_linear_f32::file_decode::decode_file_cached(path, token) {
                        Ok(raw) => raw,
                        Err(rc) => return rc,
                    };
                if token.is_cancelled() {
                    return 4;
                }
                if identity != self::identity(path, quality) {
                    return 10;
                }
                match fit_native_auto_profile_cancellable(
                    &raw,
                    &model,
                    quality,
                    RawInput::Path(path),
                    token,
                ) {
                    Ok(pair) => pair,
                    Err(Error::Cancelled) => return 4,
                    Err(error) => {
                        set_last_error(format!("native Auto develop: {error}"));
                        return 8;
                    }
                }
            }
        };
        if token.is_cancelled() {
            return 4;
        }
        if identity != self::identity(path, quality) {
            return 10;
        }
        let Some((curve, residual)) = pair else {
            return 1;
        };
        let n = residual.as_ref().map_or(0, |lut| lut.size);
        *(out.3 as *mut u32) = n as u32;
        let needed = n.checked_pow(3).and_then(|n| n.checked_mul(3));
        if needed.is_none_or(|n| n > lut_capacity) {
            return -2;
        }
        let curve_flat = curve.as_ref().map(ProfileCurve::to_flat);
        if curve_flat
            .as_ref()
            .is_some_and(|f| f.len() != PROFILE_CURVE_FLAT_LEN)
        {
            return 9;
        }
        if token.is_cancelled() {
            return 4;
        }
        if identity != self::identity(path, quality) {
            return 10;
        }
        if let Some(flat) = curve_flat {
            std::ptr::copy_nonoverlapping(flat.as_ptr(), out.0 as *mut f32, flat.len());
            *(out.1 as *mut i32) = 1;
        }
        if let Some(lut) = residual {
            std::ptr::copy_nonoverlapping(lut.data.as_ptr(), out.2 as *mut f32, lut.data.len());
        }
        0
    })
}

// Include size and creation identity as well as the core's path+mtime key.
// Capture before decode and verify before delivery; never publish stale bytes
// under a new timestamp. The same production core LRU serves full export.
fn identity(
    path: &Path,
    quality: raw_core::pipeline::RenderQuality,
) -> Option<(CacheKey, u64, Option<std::time::SystemTime>)> {
    let key = CacheKey::from_path(path, quality)?.with_origin(FitOrigin::Render(None));
    let metadata = std::fs::metadata(path).ok()?;
    Some((key, metadata.len(), metadata.created().ok()))
}

#[cfg(test)]
#[path = "native_auto_profile_tests.rs"]
mod tests;
