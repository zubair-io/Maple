//! GPU parity FFI — the Apple-side link+run proof for epic #925 / P1b (#988).
//!
//! Mirrors the WebGPU parity binding (`raw-wasm/src/gpu.rs`): builds the same
//! deterministic RGBA f32 buffer the headless tests use, runs the WGSL exposure
//! kernel GPU-resident via `raw_gpu::run_exposure_gpu` (Metal on Apple), and
//! compares the result to the CPU oracle (`raw_gpu::apply_exposure_gain`),
//! writing the max abs diff so the Swift debug view can assert the 1e-4 gate.
//!
//! The whole module is gated behind `#[cfg(feature = "gpu")]`, so it (and wgpu)
//! is **absent from the default xcframework**. It is compiled only by the opt-in
//! gpu variant (`MAPLE_XCFRAMEWORK_GPU=1 build-xcframework.sh`) and the host
//! validation build. Nothing ships until P5.
//!
//! Threading: `raw_gpu::run_exposure_gpu` constructs its own `GpuContext`
//! (`Send` but `!Sync` — an unsync `OnceCell` pipeline cache) and consumes it entirely
//! within the single synchronous call, never sharing it across threads, so this
//! entry is safe to call from any one thread (the Swift bridge keeps it on a
//! single owner per the P1a note). Unlike the decode entries it does not need a
//! large worker stack, so it does not route through `with_large_stack`.

/// Build the deterministic `n_pixels`-pixel RGBA f32 test buffer (identical to
/// `raw_gpu`'s `test_buffer` and the wasm parity binding), run the GPU exposure
/// chain at `ev`, and write the max absolute difference vs the CPU oracle into
/// `*out_max_diff`.
///
/// This is the on-device proof that wgpu links AND runs on Metal: a green run
/// (rc 0, `*out_max_diff < 1e-4`) means the WGSL→MSL kernel produced the same
/// pixels as the CPU reference. Device logs aren't capturable on-device, so the
/// caller surfaces `*out_max_diff` in-app.
///
/// Returns:
///   0  success — `*out_max_diff` written
///  -1  `out_max_diff` is null
///  -2  `n_pixels == 0` (nothing to compare)
///  -3  the GPU run failed (no adapter / device / readback) — see
///      `maple_last_error`
///  99  a Rust-side panic was contained (#1079)
#[no_mangle]
pub extern "C" fn maple_gpu_exposure_parity(n_pixels: u32, ev: f32, out_max_diff: *mut f32) -> i32 {
    if out_max_diff.is_null() {
        return -1;
    }
    if n_pixels == 0 {
        return -2;
    }

    // Panic barrier (#1079): no panic may unwind through this `extern "C"` frame.
    crate::error::catch_panic_rc("gpu_exposure_parity", || {
        let n = n_pixels as usize;
        // Same spread as raw_gpu::test_buffer / the wasm binding: some channels
        // exceed 1.0 so the scene-linear multiply is exercised above white.
        let mut input = Vec::with_capacity(n * 4);
        for i in 0..n {
            let t = i as f32 / (n.max(2) - 1) as f32; // 0..=1
            input.extend_from_slice(&[t * 2.0, t, t * 0.5 + 0.25, 1.0]);
        }

        let gpu = match raw_gpu::run_exposure_gpu(&input, ev) {
            Ok(v) => v,
            Err(e) => {
                crate::error::set_last_error(format!("gpu_exposure_parity: {e}"));
                return -3;
            }
        };
        let mut cpu = input;
        raw_gpu::apply_exposure_gain(&mut cpu, ev);

        let max_diff = cpu
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);

        unsafe {
            *out_max_diff = max_diff;
        }
        0
    })
}

/// Passthrough display proof (P1b / #988): create a wgpu surface from `layer`
/// (a `CAMetalLayer*`), configure it at `width × height`, render the
/// deterministic four-quadrant test pattern (red/green/blue/white — see
/// `present.wgsl`), and present it — with NO CPU readback. This proves the
/// second half of the #1 risk: that wgpu can present to a `CAMetalLayer` on
/// Metal. It is PLUMBING only; the colour-correct display encode is P2.
///
/// The Swift caller hosts the `CAMetalLayer` (via `UIViewRepresentable` /
/// `NSViewRepresentable`), sets its `colorspace` tag explicitly (the
/// authoritative colour-space declaration), and passes the layer pointer here.
///
/// # Safety
/// `layer` must be a valid, non-null `CAMetalLayer*` that remains valid for the
/// duration of this call. The wgpu surface created from it is dropped before
/// this function returns.
///
/// Returns:
///   0  success — a frame was presented
///  -1  `layer` is null
///  -2  `width == 0` or `height == 0`
///  -3  a wgpu step failed (adapter/device/surface/present) — see
///       `maple_last_error` for the message
///  99  a Rust-side panic was contained (#1079)
///
/// Apple-only: `raw_gpu::present_test_pattern` (and wgpu's `CoreAnimationLayer`
/// surface) exist only on `target_vendor = "apple"`. raw-ffi only ever targets
/// Apple slices + the macOS host, so this gate is a no-op there.
#[cfg(target_vendor = "apple")]
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_present_test_pattern(
    layer: *mut std::ffi::c_void,
    width: u32,
    height: u32,
) -> i32 {
    if layer.is_null() {
        return -1;
    }
    if width == 0 || height == 0 {
        return -2;
    }
    // Panic barrier (#1079): no panic may unwind through this `extern "C"` frame.
    crate::error::catch_panic_rc("gpu_present_test_pattern", || {
        // SAFETY: `layer` is non-null and is a valid CAMetalLayer* per this fn's
        // contract; raw_gpu drops the surface before returning.
        match raw_gpu::present_test_pattern(layer, width, height) {
            Ok(()) => 0,
            Err(msg) => {
                crate::error::set_last_error(format!("gpu present: {msg}"));
                -3
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Host parity proof: the FFI entry runs the GPU exposure chain (Metal on
    /// macOS) and agrees with the CPU oracle within 1e-4 across a spread of EVs.
    /// Mirrors `raw_gpu`'s `wgsl_exposure_matches_cpu_oracle_within_1e_4` but
    /// through the C ABI surface Apple consumes.
    #[test]
    fn gpu_exposure_parity_within_1e_4() {
        for &ev in &[-3.0_f32, 0.0, 0.5, 4.0] {
            let mut max_diff = f32::NAN;
            let rc = maple_gpu_exposure_parity(256, ev, &mut max_diff);
            assert_eq!(rc, 0, "ev={ev}: parity FFI returned {rc}");
            eprintln!("FFI PARITY ev={ev}: max abs diff = {max_diff:e}");
            assert!(
                max_diff < 1e-4,
                "ev={ev}: GPU vs CPU max abs diff {max_diff} exceeds 1e-4"
            );
        }
    }

    #[test]
    fn gpu_exposure_parity_rejects_null_out() {
        assert_eq!(
            maple_gpu_exposure_parity(256, 0.0, std::ptr::null_mut()),
            -1
        );
    }

    #[test]
    fn gpu_exposure_parity_rejects_zero_pixels() {
        let mut max_diff = f32::NAN;
        assert_eq!(maple_gpu_exposure_parity(0, 0.0, &mut max_diff), -2);
        assert!(max_diff.is_nan(), "out must be untouched on the error path");
    }
}
