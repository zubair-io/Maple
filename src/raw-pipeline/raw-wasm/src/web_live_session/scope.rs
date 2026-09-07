//! Scope sampling is independent of the mutable render Promise (#3397).
use super::WebLiveSession;
use wasm_bindgen::prelude::*;

/// A bounded sample of quantized display pixels. RGBA retains the session's
/// achieved display primaries; the Web host converts to its scopes' sRGB space.
#[wasm_bindgen]
pub struct WebScopePixels {
    pixels: raw_gpu::ScopePixels,
}

#[wasm_bindgen]
impl WebScopePixels {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.pixels.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.pixels.height
    }

    /// Copies at most 512 × 512 RGBA bytes into JS. Free the handle after use.
    #[wasm_bindgen(getter)]
    pub fn rgba(&self) -> Vec<u8> {
        self.pixels.rgba.clone()
    }
}

#[wasm_bindgen]
impl WebLiveSession {
    /// Capture the latest presented chain output, returning an independently
    /// completing Promise. The host invokes this between render calls, but does
    /// NOT await it in the render queue. One sample may be pending at a time.
    ///
    /// This is deliberately a synchronous method returning an owned future:
    /// `async &self` would keep a wasm-bindgen borrow until mapping completed,
    /// rejecting the next mutable render. The pending sample keeps its staging
    /// buffer alive even when JS frees the source session.
    pub fn sample_scope(&self) -> js_sys::Promise {
        let pending = self
            .last_presented
            .get()
            .ok_or_else(|| "scope sample: no presented frame".to_string())
            .and_then(|index| self.scope_sampler.sample(&self.ctx, index));
        wasm_bindgen_futures::future_to_promise(async move {
            let readback = pending.map_err(|error| JsError::new(&error))?;
            let pixels = readback
                .read()
                .await
                .map_err(|error| JsError::new(&error))?;
            Ok(WebScopePixels { pixels }.into())
        })
    }
}
