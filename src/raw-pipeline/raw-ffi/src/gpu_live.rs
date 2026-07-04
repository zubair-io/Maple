//! `gpu`-gated LIVE-session FFI (epic #925, P4b-core / #1027) — the headless C
//! ABI that drives `raw_gpu::LiveSession` (the pooled, zero-alloc live-render
//! runner) from a host. A persistent handle uploads the decoded f32 scene-linear
//! image ONCE and renders every slider tick through the gated live chain → the
//! terminal dither → one readback of the u8 RGB surface.
//!
//! Gated behind `#[cfg(feature = "gpu")]` with the rest of `gpu.rs`, so wgpu is
//! ABSENT from the default xcframework. The present variant (chain output →
//! `CAMetalLayer` / WebGPU canvas) is per-platform (P4b-apple #1028 / P4b-web
//! #1029); this core entry reads the surface back to host memory, which is the
//! parity-test path and the fallback. Nothing ships until P5.
//!
//! ## Why a NEW params struct (not `MapleAdjustmentParams`)
//!
//! [`crate::MapleAdjustmentParams`] is frozen byte-for-byte with Swift's
//! `makeAdjustmentParams` and is ALL-SCALAR. `FullChainInputs` needs
//! variable-length data the live chain re-applies on the GPU —  the user tone
//! curves (point lists), the prepared-curve mode, the Auto Profile fitted curve,
//! and the residual 3D-LUT grid — which cannot live in a flat scalar struct. So
//! [`MapleGpuLiveParams`] is a SEPARATE, gpu-gated struct carrying the scalars
//! inline + raw `(ptr, len)` pairs for each array. It is never shared with the
//! frozen struct, so it can be shaped for the GPU chain without ABI churn there.
//!
//! ## Threading / lifetime
//!
//! The handle owns BOTH the `GpuContext` (the `!Send`/`!Sync` device + pipeline
//! cache + the live pool) and the `LiveSession` (the upload-once image + the
//! persistent ping-pong / readback buffers). `LiveSession` does not borrow the
//! context (it holds only GPU buffers), so the two live side-by-side behind one
//! opaque pointer. Single-threaded around the GPU — the host keeps the handle on
//! one owner, exactly as the P1a/P1b notes require.

use crate::error::{catch_panic_rc, set_last_error};
use raw_gpu::{CancelToken, GpuContext, LiveSession};
use std::os::raw::c_void;

/// Return code for a present the host cancelled before rendering (mirrors
/// [`crate::scene_linear_f32`]'s `RC_CANCELLED = 4`): the host flipped the cancel
/// flag (a newer edit superseded this present) before the chain was encoded, so
/// nothing was drawn. Distinct from the arg-error (-1) / GPU-failure (-3) codes so
/// the Swift caller maps it onto the silent "dropped" path, not a render error.
/// Only returned when a non-null cancel flag was passed AND the host set it.
#[cfg(target_vendor = "apple")]
const RC_PRESENT_CANCELLED: i32 = 4;

/// C-ABI live-render params for the GPU chain (gpu-gated; see the module docs on
/// why this is separate from [`crate::MapleAdjustmentParams`]). Scalars inline;
/// variable-length arrays as `(ptr, len)` pairs the caller owns for the duration
/// of the render call.
///
/// All point arrays are flat `f32` pairs (`[x0, y0, x1, y1, …]`), so a `len` is
/// the FLOAT count (= 2 × point count). The Auto Profile curve is the
/// `ProfileCurve::to_flat()` layout (`raw_gpu::PROFILE_CURVE_FLAT_LEN` floats);
/// the residual LUT is `size³ × 3` floats.
#[repr(C)]
pub struct MapleGpuLiveParams {
    // --- white balance (the matrix is derived Rust-side from temp/tint via the
    //     same `wb_cat16_matrix` the CPU chain uses, so the live builder's WB
    //     gate sees the canonical temp/tint, not a host-derived matrix) ---
    pub temperature: f32,
    pub tint: f32,
    /// WB method: 0 = CAT16 (default), 1 = diagonal Rec.2020.
    pub wb_method: u32,
    // --- scene tone controls (exposure in EV; the rest [-100, 100]) ---
    pub exposure: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    // --- AgX contrast (routed to the sigmoid slope) ---
    pub contrast: f32,
    // --- parametric tone-curve region sliders (shadows, darks, lights, highlights) ---
    pub parametric_shadows: f32,
    pub parametric_darks: f32,
    pub parametric_lights: f32,
    pub parametric_highlights: f32,
    /// Tone-curve per-channel mode: 0 = PerChannel, 1 = RatioPreserving.
    pub tone_curve_mode: u32,
    // --- color / spatial sliders ([-100, 100] / [0, 100]) ---
    pub vibrance: f32,
    pub saturation: f32,
    pub clarity: f32,
    pub texture: f32,
    pub dehaze: f32,
    pub sharpen_amount: f32,
    pub sharpen_radius: f32,
    pub sharpen_detail: f32,
    pub sharpen_masking: f32,
    pub nr_luminance: f32,
    pub nr_color: f32,
    // --- capture sharpening (only applied when `capture_sharpening_enabled != 0`;
    //     the decode-boundary contract bakes it on Apple, so the live path passes
    //     it disabled there — see the plan — but the core entry supports it) ---
    pub capture_sharpening_enabled: u32,
    pub capture_sharpening_sigma: f32,
    pub capture_sharpening_iterations: u32,
    pub capture_sharpening_highlight_threshold: f32,
    pub capture_sharpening_strength: f32,
    // --- user tone curves: flat (x, y) f32 pairs; len = float count (2× points) ---
    pub tone_curve_luma_ptr: *const f32,
    pub tone_curve_luma_len: usize,
    pub tone_curve_red_ptr: *const f32,
    pub tone_curve_red_len: usize,
    pub tone_curve_green_ptr: *const f32,
    pub tone_curve_green_len: usize,
    pub tone_curve_blue_ptr: *const f32,
    pub tone_curve_blue_len: usize,
    // --- Auto Profile fitted curve (flat; PROFILE_CURVE_FLAT_LEN floats) ---
    pub profile_curve_ptr: *const f32,
    pub profile_curve_len: usize,
    // --- Auto Profile residual 3D LUT (size³ × 3 floats) ---
    pub residual_lut_size: u32,
    pub residual_lut_ptr: *const f32,
    pub residual_lut_len: usize,
    // --- brightness — scene-linear midtone-band gain, [-100, 100] (#1102,
    //     tone/zoom design § 4.1; runs between exposure and highlights) ---
    //
    // Placed at the END of the struct (after the array pointers) so adding
    // the field does not shift the offset of any earlier field — same
    // append-only ABI convention as `MapleAdjustmentParams::look_mode`. A
    // host built against the pre-#1102 header that re-binds to the new one
    // sees every existing field at its old offset; an un-set tail field
    // reads as 0.0 = identity.
    pub brightness: f32,
    // --- vignette — scene-linear radial EV gain (#1109, tone/zoom design
    //     § 10.1; runs between dehaze and sharpen). Appended at the tail
    //     per the same convention: un-set amount reads 0.0 = identity
    //     (feather is inert at amount 0). ---
    pub vignette_amount: f32,
    pub vignette_feather: f32,
    // --- film grain — display-linear deterministic noise (#1110, tone/zoom
    //     design § 10.2; runs between agx and display_encode). Appended at
    //     the tail; un-set amount reads 0.0 = identity. ---
    pub grain_amount: f32,
    pub grain_size: f32,
    pub grain_roughness: f32,
    // --- split toning — display-linear Oklab tint (#1111, tone/zoom design
    //     § 10.3; runs between agx and grain). Appended at the tail; un-set
    //     saturations read 0.0 = identity. ---
    pub split_tone_shadow_hue: f32,
    pub split_tone_shadow_saturation: f32,
    pub split_tone_highlight_hue: f32,
    pub split_tone_highlight_saturation: f32,
    pub split_tone_balance: f32,
    // --- HSL 8-band per-channel adjustments — scene-linear Oklab (#1112,
    //     tone/zoom design § 10.4; runs after saturation / before clarity).
    //     Appended at the tail per the same ABI convention; un-set fields
    //     read as 0.0 = identity. ---
    pub hsl_hue_red: f32,
    pub hsl_hue_orange: f32,
    pub hsl_hue_yellow: f32,
    pub hsl_hue_green: f32,
    pub hsl_hue_aqua: f32,
    pub hsl_hue_blue: f32,
    pub hsl_hue_purple: f32,
    pub hsl_hue_magenta: f32,
    pub hsl_sat_red: f32,
    pub hsl_sat_orange: f32,
    pub hsl_sat_yellow: f32,
    pub hsl_sat_green: f32,
    pub hsl_sat_aqua: f32,
    pub hsl_sat_blue: f32,
    pub hsl_sat_purple: f32,
    pub hsl_sat_magenta: f32,
    pub hsl_lum_red: f32,
    pub hsl_lum_orange: f32,
    pub hsl_lum_yellow: f32,
    pub hsl_lum_green: f32,
    pub hsl_lum_aqua: f32,
    pub hsl_lum_blue: f32,
    pub hsl_lum_purple: f32,
    pub hsl_lum_magenta: f32,
    // --- decoded WB (the WB the buffer being rendered was decoded at — #1240
    //     follow-up). The chain's WB step computes `M_net = M_live · M_decoded⁻¹`
    //     instead of `M_live` alone, mirroring `apply_delta`: identity at
    //     `live == decoded` (post-DCP D65 buffer, slider at as-shot CCT), shift
    //     relative to as-shot otherwise. Without this, the GPU chain applied
    //     `M_live` ABSOLUTELY from D65 and the editor canvas rendered the as-shot
    //     scene with `wb_cat16(asShot)` baked in (e.g. test_0002 → uniform colour
    //     cast user reported). Appended at the tail per the ABI convention; an
    //     un-set host (zero/zero) reads as "decoded == 6500/0", collapsing the
    //     ratio to the absolute apply that earlier hosts expected.
    pub decoded_temperature: f32,
    pub decoded_tint: f32,
    // --- target display primaries — view-tail display_encode matrix (#1337).
    //     Appended at the tail per the append-only ABI convention; a legacy
    //     host that zero-initializes reads 0 = sRGB (the pre-#1337 default,
    //     bit-identical output). 1 = Display P3 (SMPTE RP 431-2, D65). ---
    pub target_primaries: u32,
    // --- input shape tag (#1331) — appended after target_primaries. 0 =
    //     PostDcpRec2020Fp16 (RAW, all stages), 1 = LinearRec2020Fp16 (pano,
    //     skip CS only — WB stays engaged), 2 = SrgbGammaEncoded8 (JPEG/HEIF,
    //     CPU pre-pass). A stale host leaves this 0 = the historic RAW path;
    //     bit-exact. ---
    pub input_shape: u32,
}

/// Internal handle state: the owned context + session. Behind the opaque pointer.
struct LiveHandleInner {
    ctx: GpuContext,
    session: LiveSession,
    width: u32,
    height: u32,
    /// The cached `CAMetalLayer` present surface (#1742) — created on the first
    /// [`maple_gpu_present_chain`] call and reused across every subsequent call on
    /// this handle. `None` until the first present; only Apple builds populate or
    /// read it (`present_chain_to_surface` is Apple-gated in `raw-gpu`).
    #[cfg(target_vendor = "apple")]
    present_surface: Option<raw_gpu::PersistentPresentSurface>,
}

/// Opaque handle to a GPU-resident live-render session. Allocate via
/// [`maple_gpu_live_open`]; free via [`maple_gpu_live_close`]. The pointee layout
/// is intentionally undocumented — treat `*mut c_void` as opaque.
#[repr(C)]
pub struct MapleGpuLiveSession {
    inner: *mut c_void,
}

/// Open a live-render session: construct a `GpuContext` (Metal on Apple), upload
/// the decoded scene-linear f32 RGBA image ONCE, and allocate the session's
/// persistent buffers. The returned handle renders every subsequent edit via
/// [`maple_gpu_live_render`] without re-uploading or re-allocating (pooled,
/// zero-alloc at stable dims).
///
/// `pixels` MUST point to `width × height × 4` f32 lanes (interleaved RGBA,
/// scene-linear Rec.2020 — the post-DCP develop buffer). The handle copies the
/// pixels into a GPU buffer, so `pixels` need not outlive this call.
///
/// Returns 0 on success and writes the handle into `*handle_out` (always written,
/// null on error). Non-zero on error (call `maple_last_error`):
///   -1 `handle_out` null · -2 `pixels` null · -3 zero dimension ·
///   -4 pixel-count overflow · -5 GPU init failed (no adapter / device request) ·
///   -6 the session was rejected (image exceeds the device's buffer/binding
///      limits — #1079) · 99 a Rust-side panic was contained (see
///      `maple_last_error`; mirrors the CPU entries' worker-panic rc).
///
/// A nonzero return is always safe to treat as "use the CPU render path".
///
/// # Safety
/// `pixels` valid for `width*height*4` f32 reads; `handle_out` a valid `*mut`.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_live_open(
    pixels: *const f32,
    width: u32,
    height: u32,
    handle_out: *mut MapleGpuLiveSession,
) -> i32 {
    if handle_out.is_null() {
        return -1;
    }
    // Always write a null handle first so the caller can rely on the out-param.
    (*handle_out).inner = std::ptr::null_mut();
    if pixels.is_null() {
        set_last_error("gpu_live_open: pixels null".into());
        return -2;
    }
    if width == 0 || height == 0 {
        set_last_error(format!("gpu_live_open: zero dimension {width}x{height}"));
        return -3;
    }
    let lanes = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
    {
        Some(n) => n,
        None => {
            set_last_error(format!(
                "gpu_live_open: pixel-count overflow {width}x{height}"
            ));
            return -4;
        }
    };
    let px = std::slice::from_raw_parts(pixels, lanes);

    // Panic barrier (#1079): wgpu validation/`handle_error_fatal` panics must not
    // unwind through this `extern "C"` frame (an abort on Apple). rc 99 + a
    // last-error message instead — the Swift host CPU-falls-back on any nonzero.
    catch_panic_rc("gpu_live_open", || {
        let ctx = match GpuContext::new_blocking() {
            Ok(ctx) => ctx,
            Err(e) => {
                set_last_error(format!("gpu_live_open: {e}"));
                return -5;
            }
        };
        // Validates dims against the device's REAL limits before allocating.
        let session = match LiveSession::new(&ctx, px, width, height) {
            Ok(s) => s,
            Err(e) => {
                set_last_error(format!("gpu_live_open: {e}"));
                return -6;
            }
        };
        let boxed = Box::new(LiveHandleInner {
            ctx,
            session,
            width,
            height,
            #[cfg(target_vendor = "apple")]
            present_surface: None,
        });
        (*handle_out).inner = Box::into_raw(boxed) as *mut c_void;
        0
    })
}

/// Render one edit on a live session: build the gated chain from `params`, run it
/// + the terminal dither on the session's pooled buffers, and copy the resulting
/// `width × height × 3` u8 RGB surface into `out_ptr` (row-major, alpha dropped —
/// the canonical `dither_and_quantize` layout). `out_ptr` MUST hold at least
/// `3 × width × height` bytes (query dims from the open call).
///
/// The dehaze atmospheric light is measured INTERNALLY from the post-prefix
/// buffer (a mid-chain readback when dehaze is engaged — raw-core measures A at
/// dehaze's position, not from the original input), so the host does not supply
/// it. The on-GPU reduction that removes that per-tick readback is C5b.
///
/// Returns 0 on success. Non-zero on error (call `maple_last_error`):
///   -1 handle/params/out null · -3 the GPU render returned no buffer
///   (cancelled internally) · -4 the GPU render failed (init/readback error) ·
///   -5 internal output-size mismatch (`out_ptr` is NOT written) ·
///   99 a Rust-side panic was contained.
///
/// A nonzero return is always safe to treat as "use the CPU render path".
///
/// # Safety
/// `handle` a live handle from [`maple_gpu_live_open`]; `params` valid (incl. its
/// array pointers); `out_ptr` valid for `3*w*h` bytes.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_live_render(
    handle: *const MapleGpuLiveSession,
    params: *const MapleGpuLiveParams,
    out_ptr: *mut u8,
) -> i32 {
    if handle.is_null() || params.is_null() || out_ptr.is_null() {
        set_last_error("gpu_live_render: null pointer".into());
        return -1;
    }
    let inner_ptr = (*handle).inner as *const LiveHandleInner;
    if inner_ptr.is_null() {
        set_last_error("gpu_live_render: closed/invalid handle".into());
        return -1;
    }
    let inner = &*inner_ptr;
    let p = &*params;

    // Panic barrier (#1079) — see `maple_gpu_live_open`.
    catch_panic_rc("gpu_live_render", || {
        let inputs = params::inputs_from_params(p);
        let cancel = CancelToken::new();
        let out = match inner.session.render_to_buffer(&inner.ctx, &inputs, &cancel) {
            Ok(Some(v)) => v,
            Ok(None) => {
                set_last_error("gpu_live_render: render returned None".into());
                return -3;
            }
            Err(e) => {
                set_last_error(format!("gpu_live_render: {e}"));
                return -4;
            }
        };

        // REAL length check (#1079; was debug_assert_eq! only): a short buffer
        // here would under- or over-run the host's `3*w*h` allocation in release
        // builds. Bail with an rc instead of copying.
        let expected = (inner.width as usize) * (inner.height as usize) * 3;
        if out.len() != expected {
            set_last_error(format!(
                "gpu_live_render: internal: dither output len {} != expected {expected}",
                out.len()
            ));
            return -5;
        }
        let out_slice = std::slice::from_raw_parts_mut(out_ptr, expected);
        out_slice.copy_from_slice(&out);
        0
    })
}

/// Free a live-render session handle. Idempotent for a null `inner`; after this
/// the handle MUST NOT be used. Drops the `GpuContext` + `LiveSession` (releasing
/// all GPU buffers + the pool).
///
/// # Safety
/// `handle` was produced by [`maple_gpu_live_open`] and is not used afterward.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_live_close(handle: *mut MapleGpuLiveSession) {
    if handle.is_null() {
        return;
    }
    let inner = (*handle).inner;
    if !inner.is_null() {
        // Null the handle BEFORE the drop so a contained panic can't leave a
        // dangling pointer for a later double-free. Panic barrier (#1079):
        // releasing wgpu resources can panic on a lost device; swallowing it
        // (after recording the message) beats aborting the app on teardown.
        (*handle).inner = std::ptr::null_mut();
        let _ = catch_panic_rc("gpu_live_close", || {
            drop(Box::from_raw(inner as *mut LiveHandleInner));
            0
        });
    }
}

/// Render one edit on a live session AND present it to a `CAMetalLayer` — the
/// P4b-apple (#1028) live path. Builds the gated chain from `params`, runs it on
/// the session's pooled buffers to its final f32 buffer, then a fullscreen-
/// triangle pass dithers/quantizes that buffer into `layer`'s drawable (NO CPU
/// readback). The colour-correct sibling of [`maple_gpu_present_test_pattern`]
/// (P1b's passthrough pattern).
///
/// `layer` is the `CAMetalLayer*` whose `drawableSize` MUST equal the session's
/// dims (the present samples the f32 buffer by pixel position; a size mismatch
/// desyncs the Bayer dither + the buffer index). The caller resizes the IMAGE to
/// the viewport before [`maple_gpu_live_open`] and sets the layer to the same dims
/// — the present never rescales. The layer's `colorspace` tag is the host's
/// responsibility (sRGB — the chain outputs sRGB-primary gamma-encoded; see the
/// P4b-apple plan).
///
/// `cancel` is an optional host-owned [`crate::cancel::MapleCancelFlag`]. When
/// non-null and the host has already set it (a newer edit superseded this present
/// before it ran), the present bails BEFORE rendering and returns
/// [`RC_PRESENT_CANCELLED`] — the host drops it silently. Pass null for the
/// never-cancel behaviour. (Per-pass mid-render cancellation buys nothing here:
/// the chain encodes into one command buffer and submits once — wgpu can't abort
/// submitted work — so the meaningful bail point is this single entry check, the
/// "queued-but-already-stale render" case under a fast slider drag.)
///
/// The dehaze atmospheric light is measured INTERNALLY from the post-prefix buffer
/// (a mid-chain readback when dehaze is engaged), as in [`maple_gpu_live_render`];
/// the on-GPU reduction that removes that per-tick readback is #1033, so a
/// dehaze-active present pays it (correct, but not yet 16ms-ready for those scenes).
///
/// Returns 0 on a successful present. Non-zero on error (call `maple_last_error`
/// for the message):
///   -1 handle/params/layer null or a closed handle ·
///    4 cancelled before rendering (see [`RC_PRESENT_CANCELLED`]) ·
///   -3 the GPU chain returned no buffer or failed (only when NOT cancelled) ·
///   -4 the present (surface size/configure/draw) failed ·
///   99 a Rust-side panic was contained.
///
/// A nonzero return (other than 4) is always safe to treat as "use the CPU
/// render path".
///
/// # Safety
/// `handle` a live handle from [`maple_gpu_live_open`]; `params` valid (incl. its
/// array pointers); `layer` a valid non-null `CAMetalLayer*` outliving the call;
/// `cancel` null or a valid [`crate::cancel::MapleCancelFlag`] outliving the call.
#[cfg(target_vendor = "apple")]
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_present_chain(
    handle: *const MapleGpuLiveSession,
    params: *const MapleGpuLiveParams,
    layer: *mut c_void,
    cancel: *const crate::cancel::MapleCancelFlag,
) -> i32 {
    if handle.is_null() || params.is_null() || layer.is_null() {
        set_last_error("gpu_present_chain: null pointer".into());
        return -1;
    }
    let inner_ptr = (*handle).inner as *mut LiveHandleInner;
    if inner_ptr.is_null() {
        set_last_error("gpu_present_chain: closed/invalid handle".into());
        return -1;
    }
    let inner = &mut *inner_ptr;
    let p = &*params;

    // Entry cancel-check (the meaningful bail point — see the fn doc). If the host
    // already set the flag, drop this superseded present without touching the GPU.
    if let Some(flag) = crate::cancel::token_from_ptr(cancel) {
        if flag.as_ref().load(std::sync::atomic::Ordering::Relaxed) {
            return RC_PRESENT_CANCELLED;
        }
    }

    // Panic barrier (#1079): THIS entry is the documented abort path — a canvas
    // past the device's texture limit used to panic inside surface configure and
    // unwind through this frame. The configure is now validated Err-first in
    // raw-gpu; the barrier contains anything that still slips (rc 99).
    catch_panic_rc("gpu_present_chain", || {
        let inputs = params::inputs_from_params(p);
        let token = CancelToken::new();
        let final_idx = match inner
            .session
            .render_chain_to_f32(&inner.ctx, &inputs, &token)
        {
            Ok(Some(idx)) => idx,
            Ok(None) => {
                set_last_error("gpu_present_chain: chain render returned None".into());
                return -3;
            }
            Err(e) => {
                set_last_error(format!("gpu_present_chain: {e}"));
                return -3;
            }
        };

        // SAFETY: `layer` is non-null and a valid CAMetalLayer* per this fn's
        // contract, and outlives the handle (the Swift host keeps the view/layer
        // alive for the life of the `MapleGpuLiveSession`) — the same layer
        // pointer is expected on every present against this handle, which is what
        // lets `present_surface` cache the surface across calls (#1742) instead of
        // recreating + reconfiguring it every present.
        match raw_gpu::present_chain_to_surface(
            &inner.ctx,
            &inner.session,
            final_idx,
            layer,
            &mut inner.present_surface,
        ) {
            Ok(()) => 0,
            Err(msg) => {
                set_last_error(format!("gpu_present_chain present: {msg}"));
                -4
            }
        }
    })
}

// The C-params -> FullChainInputs marshalling lives in a sibling module
// (600-LOC file budget; same split pattern as raw_gpu's live_session/limits).
mod params;

// Tests live in sibling files (600-LOC budget). The dehaze / on-GPU-airlight
// host gate is split out (#1098), mirroring raw-gpu's `live_session` /
// `airlight_tests` split; it reuses `gpu_live_tests`' `pub(super)` helpers.
#[cfg(test)]
#[path = "gpu_live_airlight_tests.rs"]
mod gpu_live_airlight_tests;
#[cfg(test)]
#[path = "gpu_live_p3_tests.rs"]
mod gpu_live_p3_tests;
#[cfg(test)]
#[path = "gpu_live_tests.rs"]
mod gpu_live_tests;
// Non-RAW (JPEG/HEIC) WB slider contract parity (#1734) — split out so this
// file stays under the 600-LOC budget.
#[cfg(test)]
#[path = "gpu_live_nonraw_wb_tests.rs"]
mod gpu_live_nonraw_wb_tests;
