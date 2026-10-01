//! Initial RAW decode, verified companion preparation and first GPU upload.
//! Split from the hot live-render lifecycle to keep reviewable source budgets.
use super::*;

#[wasm_bindgen]
impl WebLiveSession {
    /// Open a persistent live session for `raw` and present its first frame to
    /// `canvas`. Decodes ONCE, develops the stripped prefix FIT TO the caller's
    /// viewport target (#1080), fits the Auto Profile artifacts, uploads to a
    /// [`LiveSession`], sizes the canvas to the developed dims, and presents.
    /// `xmp` is optional sidecar content (the model); `None` ⇒ a fresh import at
    /// the camera As-Shot WB. `ext` is a lowercase extension (`"dng"`, `"cr2"`, …).
    ///
    /// `max_long_edge` is the viewport target in REAL (backing-store) pixels: the
    /// develop fits the image to it (long-edge fit, aspect preserved, never
    /// upscaled), so the GPU session + canvas are viewport-sized instead of full
    /// sensor res. ADDITIVE: omitting it (`undefined`/`null` — the pre-#1080 call
    /// shape) or passing `0` caps the long edge at
    /// [`crate::gpu_render::DEFAULT_TARGET_LONG_EDGE`] (2048, the downlevel WebGPU
    /// texture baseline) so the no-target path can't configure an over-limit
    /// surface; explicit values are clamped to the device's actual texture cap.
    ///
    /// `target_color_space` (#3191, the web half of the #1338 P3 toggle) is the
    /// canvas colour space the caller wants — `"display-p3"` or `"srgb"`, mirroring
    /// Apple's `CanvasColorSpace` wire strings. ADDITIVE: omitting it
    /// (`undefined`/`null` — the pre-#3191 call shape) preserves the historical
    /// always-P3 behaviour. The request is a preference, not a guarantee: an
    /// unsupported target degrades to whatever the browser reports (typically
    /// `srgb`) — [`WebLiveSession::color_space`] always surfaces the ACHIEVED tag,
    /// and [`crate::gpu_render::target_primaries_for_color_space`] derives the
    /// display-encode `target_primaries` from that same achieved tag every tick, so
    /// the two can never drift apart (#1512) regardless of what was requested. Fixed
    /// for the session's lifetime, same as the canvas dims — switching the setting
    /// takes effect on the NEXT session open (asset switch / reload), not the next
    /// render tick.
    ///
    /// Async (WebGPU adapter/device request + present are async). Returns the
    /// opened handle; subsequent edits drive [`WebLiveSession::render`].
    #[wasm_bindgen]
    pub async fn open(
        raw: Vec<u8>,
        ext: String,
        xmp: Option<String>,
        canvas: OffscreenCanvas,
        max_long_edge: Option<u32>,
        target_color_space: Option<String>,
    ) -> Result<WebLiveSession, JsError> {
        Self::open_internal(
            raw,
            ext,
            xmp,
            canvas,
            max_long_edge,
            target_color_space,
            None,
        )
        .await
    }

    /// Open and present only after the complete saved companion bundle validates.
    /// Same RAW decode and GPU chain as `open`; no incomplete first frame.
    pub async fn open_with_saved_removals(
        raw: Vec<u8>,
        ext: String,
        xmp: String,
        canvas: OffscreenCanvas,
        max_long_edge: Option<u32>,
        target_color_space: Option<String>,
        manifest: String,
        companions: Vec<u8>,
    ) -> Result<WebLiveSession, JsError> {
        Self::open_internal(
            raw,
            ext,
            Some(xmp),
            canvas,
            max_long_edge,
            target_color_space,
            Some((manifest, companions)),
        )
        .await
    }
}

impl WebLiveSession {
    async fn open_internal(
        raw: Vec<u8>,
        ext: String,
        xmp: Option<String>,
        canvas: OffscreenCanvas,
        max_long_edge: Option<u32>,
        target_color_space: Option<String>,
        companions: Option<(String, Vec<u8>)>,
    ) -> Result<WebLiveSession, JsError> {
        let raw_img =
            raw_core::decode::decode_bytes(&raw, &ext).map_err(|e| JsError::new(&e.to_string()))?;

        // As-shot derivation — IDENTICAL to `render_bytes` / `render_bytes_gpu`
        // (#1892): display-only slider seed; the model itself stays at the
        // parse result (default on a fresh open).
        let ((as_shot_temperature, as_shot_tint), camera_support) =
            crate::open_metadata::assess(&raw_img);
        let model = parse_model(&xmp).map_err(|e| JsError::new(&e))?;
        let white_balance = GpuWhiteBalance::resolve(&raw_img).map_err(|e| JsError::new(&e))?;
        let original = raw_core::types::accepted_removal::ContentDigest::for_bytes(&raw);
        let saved_removals = match companions {
            Some((manifest, bytes)) => Some(
                crate::removal_saved::prepare(
                    &raw_img,
                    &original,
                    xmp.as_deref().unwrap_or(""),
                    &manifest,
                    &bytes,
                )
                .map_err(|e| JsError::new(&e))?,
            ),
            None => None,
        };
        require_prepared_removals(saved_removals.as_ref(), &model).map_err(|e| JsError::new(&e))?;

        // Context BEFORE develop: the effective develop target clamps to this
        // device's texture cap (#1080, composing with #1079's adapter-clamped
        // limits + validation). Fallible (#1079): no WebGPU adapter/device
        // surfaces as a JsError — the worker falls back to the CPU render path
        // instead of trapping.
        let ctx = GpuContext::new_async()
            .await
            .map_err(|e| JsError::new(&e))?;
        let target_long_edge = effective_target_long_edge(max_long_edge, &ctx);

        // Develop the stripped prefix ONCE — fit to the viewport target — and
        // upload it. `prefix_model` is the exact model this buffer reflects,
        // cached for the re-develop check. Native dims ride the handle so the
        // editor's zoom math stays full-res-aware (#1101 contract).
        let (full_width, full_height) = raw_core::pipeline::native_render_dims(&raw_img);
        let (rgba, width, height, prefix_model, whites_anchor_ev, nr_sampling_scale) = develop_prefix_rgba_saved(
            &raw_img,
            &raw,
            &ext,
            &original,
            &model,
            target_long_edge,
            saved_removals.as_ref(),
        )
        .map_err(|e| JsError::new(&e))?;

        // Fallible (#1079): an image past the device's buffer/binding limits
        // surfaces as a JsError for the same CPU fallback.
        let session = LiveSession::new(&ctx, &rgba, width, height).map_err(|e| JsError::new(&e))?;

        // Size the canvas to the developed (viewport-sized) dims so the present's
        // surface-dims == image-dims invariant holds (the FS recovers each pixel
        // from the fragment position; a mismatch desyncs the dither cell). CSS
        // scales the element to the layout box on the main thread. Then build the
        // persistent present surface ONCE (surface + configure + colour-space
        // retag + present-pipeline compile) — every tick reuses it. `None` (the
        // pre-#3191 call shape) preserves the historical always-P3 request.
        let geometry =
            crate::gpu_render::display_geometry(raw_img.orientation, (width, height), &model);
        let (width, height) = geometry.surface_dimensions((width, height));
        canvas.set_width(width);
        canvas.set_height(height);
        let requested_color_space = resolve_target_color_space(target_color_space.as_deref());
        let present =
            WebPresentSurface::create(&ctx, &canvas, width, height, requested_color_space)
                .map_err(|e| JsError::new(&e))?;

        let lens_profile_json = crate::lens_profile::metadata(&raw_img, &model);
        let mut handle = WebLiveSession {
            ctx,
            raw_img,
            original,
            saved_removals,
            raw,
            ext,
            present,
            session,
            prefix_model,
            render_model: model.clone(),
            whites_anchor_ev,
            white_balance,
            nr_sampling_scale,
            target_long_edge,
            width,
            height,
            full_width,
            full_height,
            as_shot_temperature,
            as_shot_tint,
            camera_support_json: camera_support.map(|support| support.to_json()),
            lens_profile_json,
            // No look loaded on open — the editor uploads one on selection via
            // `set_film_lut` (Task 9). Matches the render entries' `film_lut:
            // None` no-op contract.
            film_lut: None,
            film_lut_key: 0,
        };
        handle
            .present_for_model(&model)
            .await
            .map_err(|e| JsError::new(&e))?;
        Ok(handle)
    }
}
