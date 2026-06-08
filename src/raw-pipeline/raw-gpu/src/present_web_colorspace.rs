//! `display-p3` canvas re-tag for the web present proof (epic #925 / P1c, #989).
//!
//! Re-tags the canvas's WebGPU context to `display-p3` *after* wgpu configures it,
//! so the present matches the live web pipeline's `colorSpace: 'display-p3'`. See
//! [`crate::present_web`] for the full rationale (wgpu-23 hardcodes `colorSpace`
//! absent in its own `GPUCanvasContext.configure()` call → browser default `srgb`).
//!
//! ## Why this is done entirely through `js_sys` (untyped), not typed `web-sys`
//! wgpu-23 vendors its OWN private copy of the WebGPU bindings
//! (`vendor/wgpu/.../backend/webgpu/webgpu_sys/`) which defines `GpuCanvasContext`,
//! `GpuCanvasConfiguration`, `GpuCanvasAlphaMode`, `GpuTextureFormat`, … . If we
//! ALSO pulled those types from the public `web-sys` crate, wasm-bindgen would see
//! two definitions of each `GPU*` JS type with the same name and reject the build
//! (`duplicate string enums`). So the binary must contain exactly one definition of
//! each — wgpu's — and our code contributes zero `web_sys::Gpu*` types. We touch the
//! context purely through `js_sys` `Reflect` / `Object` / `Function` on untyped
//! `JsValue`s, which is exactly what a hand-written JS WebGPU app does
//! (`ctx.configure({ device, format, colorSpace })` is a plain-object dictionary).
//!
//! A bonus: `js_sys` and `HtmlCanvasElement::get_context` are all **stable**, so
//! this needs no `web_sys_unstable_apis` cfg — the harness builds with the same
//! `RUSTFLAGS=""` as the P0 harness.

use js_sys::{Function, Object, Reflect};
use wasm_bindgen::{JsCast, JsValue};
use web_sys::HtmlCanvasElement;

/// Call a no-arg JS method `name` on `obj`, returning its result (or `None` if the
/// property isn't a callable function / the call throws).
fn call0(obj: &JsValue, name: &str) -> Option<JsValue> {
    let f = Reflect::get(obj, &JsValue::from_str(name)).ok()?;
    let f: &Function = f.dyn_ref()?;
    f.call0(obj).ok()
}

/// Re-tag `canvas`'s WebGPU context to `display-p3`, reusing wgpu's device, and
/// return the colour-space tag the browser actually reports afterwards.
///
/// Returns the achieved tag (`"display-p3"`, `"srgb"`, or `"unknown"` if the
/// context / read-back is unavailable). Never panics — any failure degrades to a
/// best-effort read or `"unknown"`, because a passthrough present must still
/// succeed even if the wide-gamut re-tag doesn't.
pub(crate) fn retag_display_p3(canvas: &HtmlCanvasElement) -> String {
    // The canvas's WebGPU context is a singleton per context-type, so this is the
    // SAME context wgpu configured — reconfiguring it re-tags wgpu's surface.
    // `get_context("webgpu")` hands back a generic `js_sys::Object`, NOT a
    // `web_sys::Gpu*` type, so there is no collision with wgpu's vendored bindings.
    let ctx = match canvas.get_context("webgpu") {
        Ok(Some(obj)) => JsValue::from(obj),
        _ => return "unknown".to_string(),
    };

    // Read wgpu's live configuration to reuse its device + format. Without these we
    // can't build a valid config (a fresh JS device would mismatch wgpu's).
    if let Some(current) = call0(&ctx, "getConfiguration") {
        let new_cfg = Object::new();
        let mut have_required = true;
        for key in ["device", "format"] {
            match Reflect::get(&current, &JsValue::from_str(key)) {
                Ok(v) if !v.is_undefined() && !v.is_null() => {
                    let _ = Reflect::set(&new_cfg, &JsValue::from_str(key), &v);
                }
                _ => have_required = false,
            }
        }
        // Carry over the optional fields wgpu set, so the re-configure is a pure
        // colour-space delta (don't drop usage / alphaMode).
        for key in ["usage", "alphaMode", "viewFormats"] {
            if let Ok(v) = Reflect::get(&current, &JsValue::from_str(key)) {
                if !v.is_undefined() && !v.is_null() {
                    let _ = Reflect::set(&new_cfg, &JsValue::from_str(key), &v);
                }
            }
        }

        if have_required {
            // The whole point: the wide-gamut tag. `configure()` takes a dictionary,
            // i.e. a plain object — exactly what we built.
            let _ = Reflect::set(
                &new_cfg,
                &JsValue::from_str("colorSpace"),
                &JsValue::from_str(crate::present_web::TARGET_COLOR_SPACE),
            );
            if let Ok(configure) = Reflect::get(&ctx, &JsValue::from_str("configure")) {
                if let Some(configure) = configure.dyn_ref::<Function>() {
                    // If this throws (unsupported value / older browser), fall
                    // through to reporting whatever is currently set.
                    let _ = configure.call1(&ctx, &new_cfg);
                }
            }
        }
    }

    read_color_space(&ctx)
}

/// Read back `GPUCanvasContext.getConfiguration().colorSpace` untyped — the GROUND
/// TRUTH the browser reports. Returns the tag, or `"unknown"` if absent.
fn read_color_space(ctx: &JsValue) -> String {
    let Some(cfg) = call0(ctx, "getConfiguration") else {
        return "unknown".to_string();
    };
    match Reflect::get(&cfg, &JsValue::from_str("colorSpace")) {
        Ok(v) => v.as_string().unwrap_or_else(|| "unknown".to_string()),
        Err(_) => "unknown".to_string(),
    }
}
