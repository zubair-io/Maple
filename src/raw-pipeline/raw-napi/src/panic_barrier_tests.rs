//! #4733 — a panic inside `Task::compute` must come back as `{ ok: false,
//! error }`, never unwind out of napi's `extern "C"` libuv callback (which
//! aborts the host Node/Bun process).

use std::ffi::c_void;

use crate::error::guarded_compute;
use crate::raster_resize::RasterFileResult;

/// Same shape as napi's `async_work.rs` `execute`: `compute()` runs inside an
/// `extern "C"` frame. An escaping panic aborts this test binary rather than
/// failing an assertion — that abort is the bug under test.
unsafe extern "C" fn napi_execute_trampoline(data: *mut c_void) {
    let slot = unsafe { &mut *(data as *mut Option<napi::Result<RasterFileResult>>) };
    *slot = Some(guarded_compute("PanickingTask", || {
        let decoded: Option<u32> = None;
        Ok(RasterFileResult {
            ok: decoded.expect("decoder invariant violated") > 0,
            error: None,
        })
    }));
}

#[test]
fn panicking_compute_resolves_ok_false_and_host_survives() {
    let mut slot: Option<napi::Result<RasterFileResult>> = None;
    unsafe { napi_execute_trampoline(&mut slot as *mut _ as *mut c_void) };

    let result = slot
        .expect("trampoline returned")
        .expect("panic maps to Ok, not a rejected promise");
    assert!(!result.ok);
    assert_eq!(
        result.error.as_deref(),
        Some("PanickingTask panicked: decoder invariant violated")
    );
}

#[test]
fn non_panicking_compute_passes_through() {
    let result = guarded_compute("Fine", || {
        Ok(RasterFileResult {
            ok: true,
            error: None,
        })
    })
    .unwrap();
    assert!(result.ok);
}

/// CI guard: every `Task::compute` in this crate opens with
/// `guarded_compute(`. A new binding that forgets the barrier fails here.
#[test]
fn every_task_compute_body_is_panic_guarded() {
    let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let unguarded: Vec<String> = std::fs::read_dir(&src_dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
        .flat_map(|path| {
            let text = std::fs::read_to_string(&path).unwrap();
            let lines: Vec<String> = text.lines().map(str::to_owned).collect();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            lines
                .iter()
                .enumerate()
                .filter(|(_, line)| line.trim_start().starts_with("fn compute(&mut self)"))
                .filter(|(i, _)| {
                    !lines
                        .get(i + 1)
                        .is_some_and(|next| next.trim_start().starts_with("guarded_compute("))
                })
                .map(|(i, _)| format!("{name}:{}", i + 1))
                .collect::<Vec<_>>()
        })
        .collect();
    assert!(
        unguarded.is_empty(),
        "Task::compute bodies without guarded_compute (#4733): {unguarded:?}"
    );
}
