//! Browser queue completion for the live render's admission boundary (#3397).
//!
//! wgpu 23's WebGPU `Queue::on_submitted_work_done` is unimplemented. Use the
//! actual device queue from the canvas configuration, as the color-space retag
//! already does for the device. Cache its method once; do not create GPU objects
//! or add a separate exported WASM call for each frame.

use js_sys::{Function, Promise, Reflect};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::OffscreenCanvas;

pub(super) struct QueueCompletion {
    queue: JsValue,
    on_submitted_work_done: Function,
}

impl QueueCompletion {
    /// The canvas must already be configured by `WebPresentSurface::create`.
    pub(super) fn new(canvas: &OffscreenCanvas) -> Result<Self, String> {
        let context = canvas
            .get_context("webgpu")
            .map_err(|cause| error("get webgpu context", cause))?
            .ok_or_else(|| "WebLiveSession GPU completion: no webgpu context".to_string())?;
        let get_configuration = method(&context, "getConfiguration")?;
        let configuration = get_configuration
            .call0(&context)
            .map_err(|cause| error("getConfiguration", cause))?;
        let device = property(&configuration, "device")?;
        let queue = property(&device, "queue")?;
        let on_submitted_work_done = method(&queue, "onSubmittedWorkDone")?;
        Ok(Self {
            queue,
            on_submitted_work_done,
        })
    }

    /// Wait after submitting this frame's presentation work. This bounds GPU
    /// frames in flight while the host coalesces edits behind the render Promise.
    /// The browser fence includes earlier native buffer maps on this queue, but
    /// does not await scope result delivery/conversion or establish display scanout.
    pub(super) async fn wait(&self) -> Result<(), String> {
        let pending = self
            .on_submitted_work_done
            .call0(&self.queue)
            .map_err(|cause| error("onSubmittedWorkDone", cause))?
            .dyn_into::<Promise>()
            .map_err(|_| {
                "WebLiveSession GPU completion: onSubmittedWorkDone returned no Promise".to_string()
            })?;
        JsFuture::from(pending)
            .await
            .map_err(|cause| error("submitted work failed", cause))?;
        Ok(())
    }
}

fn property(object: &JsValue, name: &str) -> Result<JsValue, String> {
    let value = Reflect::get(object, &JsValue::from_str(name))
        .map_err(|cause| error(&format!("read {name}"), cause))?;
    if value.is_null() || value.is_undefined() {
        return Err(format!("WebLiveSession GPU completion: missing {name}"));
    }
    Ok(value)
}

fn method(object: &JsValue, name: &str) -> Result<Function, String> {
    property(object, name)?
        .dyn_into::<Function>()
        .map_err(|_| format!("WebLiveSession GPU completion: {name} is not callable"))
}

fn error(operation: &str, cause: JsValue) -> String {
    format!("WebLiveSession GPU completion: {operation}: {cause:?}")
}
