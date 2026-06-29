//! `maple_gpu_fit_auto_profile` gate (epic #925, P4b-apple / #1028).
//!
//! Two layers:
//!  1. **Decompose-vs-compose parity (autonomous, no fixture):** applying the
//!     fitted curve + residual as TWO ops (the wgpu live chain's
//!     `AutoProfileCurvePass` + `ResidualLutPass`) matches sampling the composed
//!     33³ cube (the default `CIColorCube` path) within the cube's grid-interp
//!     tolerance. This is the parity the A2 FFI underwrites — the FFI just
//!     SURFACES the un-composed artifacts; the math equivalence is raw-core's
//!     `bake_auto_profile_lut` (`out[node] = residual.sample(curve(node))`).
//!  2. **Error paths (always run)** + a **fixture-gated real-RAW round-trip** that
//!     drives `maple_gpu_fit_auto_profile` on `test_0002.dng` and confirms the
//!     surfaced curve+LUT, applied two-pass, match `maple_compute_auto_profile_lut`'s
//!     cube. Skips cleanly when the gitignored RAW is absent (CI without fixtures).

use super::*;
use raw_core::view::auto_profile::curve::{ChannelCurve, ProfileCurve};
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::view::auto_profile::{bake_auto_profile_lut, PROFILE_CURVE_FLAT_LEN};

/// The composed-cube edge the default Apple path bakes (`AutoProfileLUT.lutSize`,
/// `DEFAULT_LUT_SIZE`). The decompose-vs-compose test composes at this edge so the
/// comparison mirrors exactly what the cube path does on device.
const CUBE_N: usize = 33;

/// Tolerance for two-pass (exact `apply_curve` ∘ `residual.sample`) vs the 33³
/// composed cube's trilinear sample. The ONLY divergence is the cube's grid
/// interpolation of a smooth composed function — sub-1e-2 for the #550-class
/// curves + a mild residual (the same interp error the per-band parity gate
/// already budgets). A larger delta would mean the decomposition isn't the cube's
/// `residual.sample(curve(node))` (a real layout/order bug).
const DECOMPOSE_TOL: f32 = 1.5e-2;

/// A non-identity per-channel curve (distinct monotone shapes per channel so a
/// channel-swap surfaces) — mirrors `bake.rs`'s golden-test curve.
fn non_identity_curve() -> ProfileCurve {
    let mut c = ProfileCurve::identity();
    let shape = |i: usize, exp: f32, lift: f32| {
        let x = i as f32 / 31.0;
        let y = lift + (1.0 - lift) * x.powf(exp);
        (x, y.clamp(0.0, 1.0))
    };
    let (mut r, mut g, mut b) = (
        ChannelCurve::identity(),
        ChannelCurve::identity(),
        ChannelCurve::identity(),
    );
    for i in 0..32 {
        r.anchors[i] = shape(i, 0.7, 0.05); // shadow lift + brighten
        g.anchors[i] = shape(i, 1.0, 0.0); // identity
        b.anchors[i] = shape(i, 1.4, 0.0); // darken midtones
    }
    c.r = r;
    c.g = g;
    c.b = b;
    c
}

/// A non-identity residual LUT (the identity grid warped by a mild per-node gamma)
/// so the residual carries a real cross-node shift, not a pass-through.
fn non_identity_residual(size: usize) -> ColorLut {
    let mut lut = ColorLut::identity(size);
    for v in lut.data.iter_mut() {
        *v = v.clamp(0.0, 1.0).powf(0.92);
    }
    lut
}

/// A structured display-space `[0, 1]³` probe set spanning shadows → highlights +
/// the off-grid interior (so the cube's trilinear interpolation is genuinely
/// exercised, not just sampled at grid nodes).
fn probe_values() -> Vec<[f32; 3]> {
    let mut v = Vec::new();
    let axis = [0.0, 0.05, 0.17, 0.33, 0.5, 0.625, 0.78, 0.9, 1.0];
    for &r in &axis {
        for &g in &axis {
            for &b in &axis {
                v.push([r, g, b]);
            }
        }
    }
    v
}

/// DECOMPOSE-VS-COMPOSE PARITY (the A2 claim): applying the curve then the
/// residual as two separate ops matches sampling the composed 33³ cube within the
/// cube's grid-interp tolerance. This is what makes surfacing the un-composed
/// artifacts (the FFI) equivalent to the cube the default Apple path uses.
#[test]
fn two_pass_curve_then_residual_matches_composed_cube() {
    let curve = non_identity_curve();
    let residual = non_identity_residual(49); // the residual's native fit edge

    // Compose path: bake `residual.sample(curve(node))` into a 33³ cube, wrap it
    // as a ColorLut so we can trilinearly SAMPLE it exactly as a CIColorCube does.
    let cube_data = bake_auto_profile_lut(&curve, &residual, CUBE_N);
    let cube = ColorLut {
        size: CUBE_N,
        data: cube_data,
    };

    let mut max_delta = 0.0f32;
    let mut moved = 0.0f32; // how far the tail moves the probes (non-vacuity)
    for p in probe_values() {
        // Two-pass: exact apply_curve, then exact residual.sample.
        let mut rgb = p.to_vec();
        raw_core::view::auto_profile::apply_curve(&mut rgb, &curve);
        let two_pass = residual.sample([rgb[0], rgb[1], rgb[2]]);

        // Cube: trilinear sample of the composed grid at the ORIGINAL probe.
        let cubed = cube.sample(p);

        for c in 0..3 {
            max_delta = max_delta.max((two_pass[c] - cubed[c]).abs());
            moved = moved.max((p[c] - two_pass[c]).abs());
        }
    }

    eprintln!(
        "A2 DECOMPOSE-VS-COMPOSE: max |two-pass − cube| = {max_delta:e} (< {DECOMPOSE_TOL:e}); \
         tail moved probes by {moved:e}"
    );
    assert!(
        moved > 1e-2,
        "the curve+residual must actually move the probes (test is vacuous otherwise): {moved}"
    );
    assert!(
        max_delta < DECOMPOSE_TOL,
        "two-pass (curve∘residual) vs composed cube max delta {max_delta} exceeds {DECOMPOSE_TOL} \
         — the decomposition is not the cube's residual.sample(curve(node)) (a layout/order bug)"
    );
}

/// Null / mis-aligned args are rejected with -1 and the out-params are left at
/// their initial-zero state (the FFI writes `*curve_present = 0` / `*lut_size = 0`
/// before any work, but on a null out-param it can't, so we only assert the rc).
#[test]
fn fit_auto_profile_rejects_null_args() {
    let mut curve = [0f32; PROFILE_CURVE_FLAT_LEN];
    let mut present = -1i32;
    let mut lut = vec![0f32; 8];
    let mut size = 999u32;

    // raw_path null.
    let rc = unsafe {
        maple_gpu_fit_auto_profile(
            std::ptr::null(),
            std::ptr::null(),
            0,
            curve.as_mut_ptr(),
            &mut present,
            lut.as_mut_ptr(),
            lut.len(),
            &mut size,
        )
    };
    assert_eq!(rc, -1, "null raw_path must return -1");

    // curve_out null.
    let path = std::ffi::CString::new("/nonexistent.dng").unwrap();
    let rc = unsafe {
        maple_gpu_fit_auto_profile(
            path.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            &mut present,
            lut.as_mut_ptr(),
            lut.len(),
            &mut size,
        )
    };
    assert_eq!(rc, -1, "null curve_out must return -1");

    // lut_size null.
    let rc = unsafe {
        maple_gpu_fit_auto_profile(
            path.as_ptr(),
            std::ptr::null(),
            0,
            curve.as_mut_ptr(),
            &mut present,
            lut.as_mut_ptr(),
            lut.len(),
            std::ptr::null_mut(),
        )
    };
    assert_eq!(rc, -1, "null lut_size must return -1");
}

/// FIXTURE-GATED real-RAW round-trip: `maple_gpu_fit_auto_profile` on a real RAW
/// surfaces a curve + residual whose two-pass application matches the cube the
/// default `maple_compute_auto_profile_lut` bakes (within the grid-interp
/// tolerance). Skips cleanly when the gitignored RAW is absent (CI without
/// fixtures), mirroring `render_tests.rs`'s fixture gate.
#[test]
fn fixture_fit_matches_cube_when_present() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return; // skip-pass: no fixture (CI without RAWs)
    }
    // An XMP forcing Profile::Auto is required for a non-`1` fit. The fixtures dir
    // may not ship a matching sidecar; without one the model defaults to Neutral
    // and the fit returns `1` (no tail). Treat a `1` here as a soft skip — this
    // test's value is the parity when a tail EXISTS, not forcing one.
    let cpath = std::ffi::CString::new(path.to_str().unwrap()).unwrap();

    let mut curve = [0f32; PROFILE_CURVE_FLAT_LEN];
    let mut present = 0i32;
    // The residual fits at edge 49 → 49³·3 floats; allocate generously.
    let mut lut = vec![0f32; 49 * 49 * 49 * 3];
    let mut size = 0u32;

    let rc = unsafe {
        maple_gpu_fit_auto_profile(
            cpath.as_ptr(),
            std::ptr::null(), // no sidecar
            0,                // Full quality (matches the cube call below)
            curve.as_mut_ptr(),
            &mut present,
            lut.as_mut_ptr(),
            lut.len(),
            &mut size,
        )
    };
    if rc == 1 {
        eprintln!("A2 FIXTURE: no Auto tail for test_0002.dng (Neutral default) — soft skip");
        return;
    }
    assert_eq!(rc, 0, "fit returned {rc} (expected 0 or the soft-skip 1)");
    assert!(
        present == 1 || size > 0,
        "a successful fit must surface a curve or a residual"
    );

    // Build the composed cube the DEFAULT Apple path bakes, for the same RAW.
    let n = CUBE_N;
    let mut cube_flat = vec![0f32; n * n * n * 3];
    let cube_rc = unsafe {
        crate::auto_profile::maple_compute_auto_profile_lut(
            cpath.as_ptr(),
            std::ptr::null(),
            0,
            n as u32,
            cube_flat.as_mut_ptr(),
        )
    };
    assert_eq!(cube_rc, 0, "cube bake returned {cube_rc}");
    let cube = ColorLut {
        size: n,
        data: cube_flat,
    };

    // Reconstruct the two-pass artifacts and compare on the probe set.
    let parsed_curve = if present == 1 {
        ProfileCurve::from_flat(&curve).expect("surfaced curve must parse")
    } else {
        ProfileCurve::identity()
    };
    let residual = if size > 0 {
        let nn = size as usize;
        ColorLut {
            size: nn,
            data: lut[..nn * nn * nn * 3].to_vec(),
        }
    } else {
        ColorLut::identity(2)
    };

    let mut max_delta = 0.0f32;
    for p in probe_values() {
        let mut rgb = p.to_vec();
        raw_core::view::auto_profile::apply_curve(&mut rgb, &parsed_curve);
        let two_pass = if size > 0 {
            residual.sample([rgb[0], rgb[1], rgb[2]])
        } else {
            [rgb[0], rgb[1], rgb[2]]
        };
        let cubed = cube.sample(p);
        for c in 0..3 {
            max_delta = max_delta.max((two_pass[c] - cubed[c]).abs());
        }
    }
    eprintln!(
        "A2 FIXTURE [test_0002, curve_present={present}, lut_size={size}]: \
         max |two-pass − cube| = {max_delta:e} (< {DECOMPOSE_TOL:e})"
    );
    assert!(
        max_delta < DECOMPOSE_TOL,
        "fixture two-pass vs cube max delta {max_delta} exceeds {DECOMPOSE_TOL}"
    );
}

/// FIXTURE-GATED (#1662): the GPU Auto-Profile fit must route its decode through
/// the SHARED #949 decoded-`RawImage` cache — the same one the scene-linear
/// render FFI populated moments earlier under the file's `(path, mtime)` key —
/// instead of the uncached `decode_bytes`. Before the fix the GPU fit re-decoded
/// the RAW from scratch on every cold open, which was the ~10s double-decode on
/// large RAWs (the CPU fit `maple_compute_auto_profile_lut` already cached; the
/// GPU fit did not).
///
/// Observable: after the fit runs, the file's key is present in the cache. Uses
/// `test_0017` — no other raw-ffi test decodes it, so the key is pristine and is
/// present iff THIS fit inserted it (no `clear_for_test`, so no interference with
/// concurrent fixture tests). The decode runs BEFORE the Auto/Neutral tail
/// decision, so an `rc` of 0 (tail) or 1 (no tail) both mean the decode executed.
#[test]
fn fixture_gpu_fit_routes_decode_through_shared_cache() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0017.dng");
    if !path.exists() {
        return; // skip-pass: no fixture (CI without RAWs)
    }
    let key = raw_core::decode_cache::CacheKey::from_path(&path)
        .expect("a real fixture file is stattable");

    let cpath = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    let mut curve = [0f32; PROFILE_CURVE_FLAT_LEN];
    let mut present = 0i32;
    let mut lut = vec![0f32; 49 * 49 * 49 * 3];
    let mut size = 0u32;

    // The decode cache is a process-wide singleton with CAPACITY = 1, so under
    // Cargo's default parallel test execution a concurrent decode in another
    // test could evict our just-inserted entry in the window between the fit
    // returning and the check (Copilot #1663). Re-run a few times and require
    // the key present on AT LEAST ONE iteration: the old uncached fit NEVER
    // inserts (every iteration absent → fail), while the fixed fit inserts on
    // every call, so an eviction would have to win the race on every iteration.
    // In practice the fixed path is present on the first iteration.
    let mut populated = false;
    for _ in 0..5 {
        let rc = unsafe {
            maple_gpu_fit_auto_profile(
                cpath.as_ptr(),
                std::ptr::null(),
                0,
                curve.as_mut_ptr(),
                &mut present,
                lut.as_mut_ptr(),
                lut.len(),
                &mut size,
            )
        };
        assert!(rc == 0 || rc == 1, "fit ran (rc={rc})");
        if raw_core::decode_cache::get(&key).is_some() {
            populated = true;
            break;
        }
    }
    assert!(
        populated,
        "GPU fit must populate the shared decode cache (#1662) — it was calling \
         the uncached decode_bytes, forcing a second full decode on cold open"
    );
}
