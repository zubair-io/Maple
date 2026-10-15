//! Android native binding. Colour and geometry remain in raw-core/raw-gpu.
mod fields;
mod film;
mod preview;
mod transfer;
mod xmp;

use preview::Session;
use std::{
    cell::RefCell,
    ffi::{c_char, c_void, CStr, CString},
    panic::{catch_unwind, AssertUnwindSafe},
    ptr,
};

thread_local! { static ERROR: RefCell<CString> = RefCell::new(CString::new("").unwrap()); }

fn guarded<T>(fallback: T, body: impl FnOnce() -> Result<T, String>) -> T {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(Ok(value)) => value,
        result => {
            let message = match result {
                Ok(Err(message)) => message,
                Err(panic) => panic
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| {
                        panic
                            .downcast_ref::<&str>()
                            .map(|value| (*value).to_owned())
                    })
                    .unwrap_or_else(|| "Native operation failed".into()),
                _ => "Native operation failed".into(),
            };
            ERROR
                .with(|slot| *slot.borrow_mut() = CString::new(message.replace('\0', "")).unwrap());
            fallback
        }
    }
}

unsafe fn text<'a>(value: *const c_char) -> Result<&'a str, String> {
    if value.is_null() {
        return Err("Missing string argument".into());
    }
    CStr::from_ptr(value).to_str().map_err(|e| e.to_string())
}

#[no_mangle]
pub extern "C" fn maple_android_error() -> *const c_char {
    ERROR.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_open(
    path: *const c_char,
    xml: *const c_char,
    edge: u32,
) -> *mut c_void {
    guarded(ptr::null_mut(), || {
        Ok(Box::into_raw(Box::new(Session::open(text(path)?, text(xml)?, edge)?)).cast())
    })
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_close(handle: *mut c_void) {
    if !handle.is_null() {
        guarded((), || {
            drop(Box::from_raw(handle.cast::<Session>()));
            Ok(())
        });
    }
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_values(handle: *mut c_void) -> *mut c_char {
    guarded(ptr::null_mut(), || {
        let session = handle.cast::<Session>().as_ref().ok_or("Closed editor")?;
        let mut values: serde_json::Map<String, serde_json::Value> =
            raw_core::types::ADJUSTMENT_SCHEMA
                .iter()
                .enumerate()
                .filter_map(|(i, spec)| {
                    fields::get(&session.model, i)
                        .map(|v| (spec.name.to_owned(), serde_json::json!(v)))
                })
                .collect();
        let (temperature, tint) = session.white_balance_values();
        values.insert("temperature".into(), serde_json::json!(temperature));
        values.insert("tint".into(), serde_json::json!(tint));
        values.insert(
            "_raw".into(),
            serde_json::json!(if session.source_is_raw() { 1.0 } else { 0.0 }),
        );
        values.insert("_aspect".into(), serde_json::json!(session.aspect()));
        Ok(CString::new(serde_json::Value::Object(values).to_string())
            .map_err(|e| e.to_string())?
            .into_raw())
    })
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_free_string(value: *mut c_char) {
    if !value.is_null() {
        drop(CString::from_raw(value));
    }
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_set(handle: *mut c_void, index: usize, value: f32) -> i32 {
    guarded(-1, || {
        let session = handle.cast::<Session>().as_mut().ok_or("Closed editor")?;
        if !session.source_is_raw() && !fields::raster_allowed(index) {
            return Err("This adjustment requires a RAW source".into());
        }
        fields::set(&mut session.model, index, value)?;
        Ok(0)
    })
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_model(handle: *mut c_void, xml: *const c_char) -> i32 {
    guarded(-1, || {
        let session = handle.cast::<Session>().as_mut().ok_or("Closed editor")?;
        let model = xmp::parse(text(xml)?)?;
        if !session.source_is_raw() {
            raw_core::pipeline::validate_raster_adjustments(&model).map_err(|e| e.to_string())?;
        }
        session.model = model;
        Ok(0)
    })
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_raster_compatible(xml: *const c_char) -> bool {
    guarded(false, || {
        let model = xmp::parse(text(xml)?)?;
        Ok(raw_core::pipeline::validate_raster_adjustments(&model).is_ok())
    })
}

#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn maple_android_surface(
    handle: *mut c_void,
    window: *mut c_void,
    width: u32,
    height: u32,
) -> i32 {
    guarded(-1, || {
        let session = handle.cast::<Session>().as_mut().ok_or("Closed editor")?;
        // Drop the old surface before JNI releases its ANativeWindow reference.
        session.surface = None;
        if let Some(window) = std::ptr::NonNull::new(window) {
            session.surface = Some(raw_gpu::AndroidPresentSurface::new(
                &session.ctx,
                window,
                width,
                height,
            )?);
        }
        Ok(0)
    })
}

#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn maple_android_render(handle: *mut c_void) -> i32 {
    guarded(-1, || {
        handle
            .cast::<Session>()
            .as_mut()
            .ok_or("Closed editor")?
            .render()?;
        Ok(0)
    })
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_thumbnail(
    path: *const c_char,
    destination: *const c_char,
    xml: *const c_char,
    edge: u32,
) -> i32 {
    guarded(-1, || {
        transfer::thumbnail(text(path)?, text(destination)?, text(xml)?, edge)?;
        Ok(0)
    })
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_export(
    path: *const c_char,
    xml: *const c_char,
    destination: *const c_char,
) -> i32 {
    guarded(-1, || {
        transfer::export(text(path)?, text(xml)?, text(destination)?)?;
        Ok(0)
    })
}
