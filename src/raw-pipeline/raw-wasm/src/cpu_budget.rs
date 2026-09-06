//! wasm32 CPU develop memory budget (#2661).
//!
//! The wasm32 build links with `--max-memory=4294967296` — the wasm32 hard
//! ceiling, already maxed out (see `.cargo/config.toml`). A full-native-res
//! CPU develop of a large sensor does not fit in that heap: the develop chain
//! holds multiple full-resolution f32 buffers at once, and once the demosaic
//! output exceeds the remaining headroom the allocator aborts
//! (`handle_alloc_error` → an unrecoverable `unreachable` trap that poisons
//! the whole WASM instance).
//!
//! Peak RSS, measured natively (`/usr/bin/time -l`, release, single-threaded
//! `RAYON_NUM_THREADS=1`, M4 Mac, 2026-08-06) through the same raw-core
//! entries the wasm render fns call:
//!
//! | input                              | develop              | peak    |
//! |------------------------------------|----------------------|---------|
//! | 12288×8192 DNG (100.7 MP)          | unsized full-res     | 9.22 GB |
//! | 8688×5792 CR2 (50.3 MP)            | unsized full-res     | 5.80 GB |
//! | 100.7 MP, `max_long_edge = 8192`   | sized (FULL demosaic)| 7.24 GB |
//! | 100.7 MP, `max_long_edge = 6144`   | sized (half demosaic)| 3.81 GB |
//! | 100.7 MP, `max_long_edge = 4096`   | sized (half demosaic)| 3.42 GB |
//! | 100.7 MP, `max_long_edge = 2048`   | sized (half demosaic)| 2.79 GB |
//!
//! Two facts fall out of the table:
//!
//! 1. Full-res develop costs ~115 B/sensor-pixel worst-case, so anything
//!    above ~32 MP cannot develop unsized inside the 4 GiB heap
//!    (`FULL_DEVELOP_MAX_SENSOR_PX`).
//! 2. The `#1637` half-res demosaic gate in `develop_sized.rs` is the memory
//!    cliff: it only engages when `max_long_edge × 2 ≤ sensor long edge`.
//!    Above that the sized chain still allocates the full-res f32 RGB
//!    demosaic buffer (the 6144 → 8192 jump in the table). A safe cap must
//!    therefore stay at or below half the sensor long edge AND bound the
//!    post-demosaic stage buffers (`SIZED_DEVELOP_MAX_LONG_EDGE`, 3.42 GB
//!    measured on the 100 MP reference — ~20% headroom under the ceiling).
//!
//! The clamp lives HERE — at the wasm boundary — because safety depends on
//! the native sensor dimensions, which the TS worker does not know until the
//! decode has already happened inside a single wasm call. Sized replies carry
//! the native dims in `full_width`/`full_height`, so caller fit/zoom math is
//! unaffected by clamping.

use wasm_bindgen::prelude::*;

/// Default develop target when a caller passes no explicit `max_long_edge` —
/// shared by the GPU one-shot entry (`render_bytes_gpu`, #1080: the downlevel
/// WebGPU `max_texture_dimension_2d` baseline every adapter meets) and the
/// worker's CPU fallback for the same unsized requests, so a GPU-adapter
/// failure re-renders the SAME develop the GPU call would have produced.
pub(crate) const DEFAULT_TARGET_LONG_EDGE: u32 = 2048;

/// Largest sensor (in pixels) whose FULL-native-resolution CPU develop fits
/// the 4 GiB wasm32 heap: ~115 B/sensor-px worst-case (see module doc) against
/// a 3.5 GiB working budget — the ~0.8 GiB reserve absorbs the raw file bytes
/// copied across the JS boundary, allocator fragmentation, and session state
/// retained by earlier renders. Sensors at or below this develop exactly as
/// before; the 22 MP and 24 MP bodies common on the no-WebGPU fallback path
/// keep their native-resolution refine.
pub(crate) const FULL_DEVELOP_MAX_SENSOR_PX: u64 = 32_000_000;

/// Long-edge ceiling for sized CPU develops of sensors too large for a
/// full-res develop: 3.42 GB measured peak on the 100 MP reference. Composed
/// with the half-sensor bound in [`clamp_develop_long_edge`] so the `#1637`
/// half-res demosaic branch always engages for clamped develops.
pub(crate) const SIZED_DEVELOP_MAX_LONG_EDGE: u32 = 4096;

/// The effective `max_long_edge` a CPU develop of a `native_w × native_h`
/// sensor may use: `requested` untouched for sensors that fit a full-res
/// develop (`None` keeps meaning "unsized"), otherwise clamped to
/// `min(sensor_long_edge / 2, SIZED_DEVELOP_MAX_LONG_EDGE)` — never above the
/// request, and `None` resolves to the clamp itself.
pub(crate) fn clamp_develop_long_edge(
    native_w: u32,
    native_h: u32,
    requested: Option<u32>,
) -> Option<u32> {
    let sensor_px = u64::from(native_w) * u64::from(native_h);
    if sensor_px <= FULL_DEVELOP_MAX_SENSOR_PX {
        return requested;
    }
    let ceiling = (native_w.max(native_h) / 2).min(SIZED_DEVELOP_MAX_LONG_EDGE);
    Some(match requested {
        Some(r) => r.min(ceiling),
        None => ceiling,
    })
}

/// Export must preserve its requested dimensions. Reuse the measured CPU
/// develop bound, but reject instead of silently applying the preview clamp.
/// Called after sensor decode, before any full RGB demosaic/stage allocation.
pub(crate) fn validate_export_dimensions(
    native_w: u32,
    native_h: u32,
    requested: Option<u32>,
) -> Result<(), String> {
    if clamp_develop_long_edge(native_w, native_h, requested) != requested {
        let ceiling = clamp_develop_long_edge(native_w, native_h, None).unwrap();
        return Err(format!(
            "Browser export of {native_w}×{native_h} exceeds the renderer's 4 GiB memory budget. \
             Choose a maximum long edge of {ceiling} pixels or less, or export full resolution \
             with Windows, the CLI, or a Self Hosted server directory."
        ));
    }
    Ok(())
}

/// The develop target the CPU fallback uses for an unsized request — exposed
/// to the TS worker so its GPU-adapter-failure retry renders through
/// `render_bytes_sized` at the SAME [`DEFAULT_TARGET_LONG_EDGE`] the failed
/// `render_bytes_gpu` call would have self-capped to (#2661). A runtime
/// getter instead of a codegen'd constant: the value crosses the boundary
/// once at worker init, so it can never drift.
#[wasm_bindgen]
pub fn default_target_long_edge() -> u32 {
    DEFAULT_TARGET_LONG_EDGE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_rejects_over_budget_requests_without_changing_the_requested_size() {
        assert!(validate_export_dimensions(8000, 4000, None).is_ok());
        assert!(validate_export_dimensions(6000, 4000, Some(6000)).is_ok());
        for request in [None, Some(12288), Some(8192), Some(4097)] {
            let error = validate_export_dimensions(12288, 8192, request).unwrap_err();
            assert!(error.contains("4 GiB"));
            assert!(error.contains("4096 pixels"));
        }
        assert!(validate_export_dimensions(12288, 8192, Some(4096)).is_ok());
        assert!(validate_export_dimensions(12288, 8192, Some(2048)).is_ok());
        assert!(validate_export_dimensions(7360, 4912, Some(3680)).is_ok());
        assert!(validate_export_dimensions(7360, 4912, Some(3681)).is_err());
    }

    /// Sensors at or below the full-develop budget pass through untouched —
    /// both the unsized shape and any explicit request (even one above the
    /// sized ceiling: a 24 MP native-res refine stays native).
    #[test]
    fn small_sensor_is_never_clamped() {
        // 6000×4000 = 24 MP.
        assert_eq!(clamp_develop_long_edge(6000, 4000, None), None);
        assert_eq!(clamp_develop_long_edge(6000, 4000, Some(6000)), Some(6000));
        assert_eq!(clamp_develop_long_edge(6000, 4000, Some(1024)), Some(1024));
        // Exactly at the boundary: 8000×4000 = 32 MP.
        assert_eq!(clamp_develop_long_edge(8000, 4000, None), None);
    }

    /// The 100 MP reference (12288×8192): unsized and over-half requests
    /// clamp to the sized ceiling; sensor/2 exceeds it so the ceiling wins.
    #[test]
    fn large_sensor_clamps_unsized_and_oversized_requests() {
        assert_eq!(clamp_develop_long_edge(12288, 8192, None), Some(4096));
        assert_eq!(
            clamp_develop_long_edge(12288, 8192, Some(12288)),
            Some(4096)
        );
        assert_eq!(clamp_develop_long_edge(12288, 8192, Some(8192)), Some(4096));
    }

    /// Requests already at or under the clamp pass through unchanged — the
    /// editor's viewport-sized fast phase must not be perturbed.
    #[test]
    fn large_sensor_keeps_small_requests() {
        assert_eq!(clamp_develop_long_edge(12288, 8192, Some(2048)), Some(2048));
        assert_eq!(clamp_develop_long_edge(12288, 8192, Some(4096)), Some(4096));
    }

    /// A sensor over the pixel budget but with a long edge under 2 × the
    /// sized ceiling (36 MP, 7360×4912): the half-sensor bound wins, so the
    /// `#1637` half-res demosaic branch still engages
    /// (`clamp × 2 ≤ sensor long edge`).
    #[test]
    fn clamp_never_exceeds_half_the_sensor_long_edge() {
        let clamped = clamp_develop_long_edge(7360, 4912, Some(7360)).unwrap();
        assert_eq!(clamped, 3680);
        assert!(clamped * 2 <= 7360);
    }

    /// The exported getter mirrors the shared constant.
    #[test]
    fn default_target_long_edge_matches_constant() {
        assert_eq!(default_target_long_edge(), DEFAULT_TARGET_LONG_EDGE);
    }
}
