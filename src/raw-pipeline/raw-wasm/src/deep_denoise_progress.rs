//! Web bridge for the BM3D deep-denoise progress signal (#1153).
//!
//! `deep_denoise` is the one develop stage whose runtime is seconds rather
//! than milliseconds, so the editor shows a DETERMINATE progress bar while
//! it runs (tone/zoom design spec § 3.2). The numbers are the stage's own
//! per-reference-row ticks — raw-core's
//! [`raw_core::stages::bm3d::Progress`] sink — never a simulated animation.
//!
//! ## Why a push callback and not a poll
//!
//! The develop runs SYNCHRONOUSLY inside the render worker, so while it is
//! in flight the worker's event loop cannot service an incoming poll
//! message. An outgoing `postMessage`, however, is delivered to the main
//! thread's loop, which is not blocked — so the only workable direction is
//! Rust → JS → `postMessage`. The worker registers one callback at WASM
//! init and re-broadcasts each tick.
//!
//! The callback lives in a `thread_local`: raw-core invokes the sink from
//! the thread that called `develop` (the pass loop's serial section, not a
//! rayon worker), which is the worker thread that registered it.

use std::cell::RefCell;

use raw_core::stages::bm3d;
use wasm_bindgen::prelude::*;

thread_local! {
    static PROGRESS_CALLBACK: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

/// Install (or clear, by passing `null`/`undefined`) the JS progress
/// callback. It is invoked as `callback(pass, fraction)` where `pass` is
/// the stage's pass label (`"pass 1/2"` / `"pass 2/2"`) and `fraction` is
/// the OVERALL `[0, 1]` completion across both passes — so a caller can
/// bind it straight to a progress element without knowing the pass split.
///
/// Called once per worker after `init()`. Ticks are only emitted while
/// `deepDenoise > 0` actually engages the stage, so a session that never
/// touches deep denoise pays nothing.
#[wasm_bindgen(js_name = setDeepDenoiseProgress)]
pub fn set_deep_denoise_progress(callback: Option<js_sys::Function>) {
    let registered = callback.is_some();
    PROGRESS_CALLBACK.with(|slot| *slot.borrow_mut() = callback);
    bm3d::set_progress_sink(registered.then_some(forward as bm3d::ProgressSink));
}

/// raw-core sink → the registered JS callback. A throwing callback is
/// swallowed: a UI progress hiccup must never abort a develop that is
/// seconds into its work.
fn forward(pass: &'static str, fraction: f32) {
    let overall = bm3d::overall_fraction(pass, fraction);
    PROGRESS_CALLBACK.with(|slot| {
        let borrowed = slot.borrow();
        let Some(callback) = borrowed.as_ref() else {
            return;
        };
        let _ = callback.call2(
            &JsValue::NULL,
            &JsValue::from_str(pass),
            &JsValue::from_f64(f64::from(overall)),
        );
    });
}
