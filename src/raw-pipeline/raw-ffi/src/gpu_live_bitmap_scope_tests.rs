//! Live-chain host parity with a REGISTERED bitmap raster and a scope target
//! (#3369). Every other live-chain parity case leaves `mask_rasters` empty
//! (`gpu_live_p3_tests.rs` says so in as many words), and the bitmap parity
//! that does exist (`raw_gpu::local_adjustments::tests_bitmap`) runs the pass
//! ALONE, not inside the full chain with sharpen/NR/view tail around it and
//! the scope pass reading the alpha lane after it. The Apple app never hit
//! this combination before #3366 either — a loaded bitmap mask's raster was
//! never registered, so its weight was always 0 — and the first time it did,
//! the canvas rendered garbage. This is the case that should have caught it.

use super::gpu_live_tests::{
    cpu_reference, make_params, nonidentity_curve, nonidentity_lut, owned_arrays, scene_linear_rgba,
};
use super::*;
use crate::{maple_mask_raster_register, MapleScopeStats};
use raw_core::types::{BitmapRecipe, LocalAdjustment, Mask, PartialAdjustments, WbMethod};
use raw_core::xmp::AdjustmentModel;

/// The mild model from `gpu_live_tests.rs` (private there), sharpen ON —
/// the default the app ships with.
fn base_model() -> AdjustmentModel {
    AdjustmentModel {
        temperature: 6000.0,
        tint: 3.0,
        exposure: 0.1,
        brightness: 8.0,
        contrast: 8.0,
        highlights: -5.0,
        shadows: 5.0,
        vibrance: 6.0,
        saturation: 5.0,
        sharpen_amount: 50.0,
        sharpen_radius: 1.0,
        sharpen_detail: 25.0,
        nr_color: 15.0,
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        ..AdjustmentModel::default()
    }
}

/// Register a left-half-white raster under a digest unique to this file and
/// return a model carrying one bitmap layer over it, with `mask_rasters`
/// resolved the way the CPU reference needs.
fn bitmap_model(digest: &[u8; 16], adjustments: PartialAdjustments) -> AdjustmentModel {
    let (rw, rh) = (32usize, 24usize);
    let mut raster = vec![0u8; rw * rh];
    for y in 0..rh {
        for x in 0..rw / 2 {
            raster[y * rw + x] = 255;
        }
    }
    let id = maple_mask_raster_register(
        digest.as_ptr(),
        rw as u32,
        rh as u32,
        raster.as_ptr(),
        raster.len(),
    );
    assert!(id >= 1, "raster registration failed: {id}");
    let mut model = base_model();
    model.local_adjustments = vec![LocalAdjustment {
        mask: Mask::Bitmap {
            recipe: BitmapRecipe {
                digest: std::str::from_utf8(digest).unwrap().into(),
                ..Default::default()
            },
            raster_id: id as u32,
        },
        range: None,
        adjustments,
    }];
    crate::mask_registry::resolve_into(&mut model);
    assert_eq!(
        model.mask_rasters.len(),
        1,
        "raster must resolve for the CPU reference"
    );
    model
}

fn render_ffi(
    model: &AdjustmentModel,
    scope_enabled: bool,
    scope_layer: i32,
) -> (Vec<u8>, Vec<u8>) {
    let (w, h) = (32u32, 24u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let curve = nonidentity_curve();
    let lut = nonidentity_lut(9);
    let arr = owned_arrays(model, &curve, &lut);
    let mut params = make_params(model, WbMethod::Cat16, 9, &arr);
    let mut bins = vec![0u32; 128 * 128];
    let mut stats = MapleScopeStats {
        frame: 0,
        total: 0,
        _pad: 0,
        bins_ptr: bins.as_mut_ptr(),
        bins_len: bins.len() as u32,
    };
    params.scope_layer = scope_layer;
    params.scope_enabled = scope_enabled as u8;
    if scope_enabled {
        params.scope_out = &mut stats;
    }

    let mut handle = MapleGpuLiveSession {
        inner: std::ptr::null_mut(),
    };
    assert_eq!(
        unsafe { maple_gpu_live_open(input.as_ptr(), w, h, &mut handle) },
        0
    );
    let mut out = vec![0u8; (w * h * 3) as usize];
    // Two ticks, like the app: the scope sample is one tick late by design.
    assert_eq!(
        unsafe { maple_gpu_live_render(&handle, &params, out.as_mut_ptr()) },
        0
    );
    assert_eq!(
        unsafe { maple_gpu_live_render(&handle, &params, out.as_mut_ptr()) },
        0
    );
    unsafe { maple_gpu_live_close(&mut handle) };

    let want = cpu_reference(&input, w, h, model, WbMethod::Cat16, &curve, &lut);
    (out, want)
}

fn assert_parity(name: &str, out: &[u8], want: &[u8]) {
    assert_eq!(out.len(), want.len(), "[{name}] length");
    let max_delta = out
        .iter()
        .zip(want)
        .map(|(a, b)| (*a as i32 - *b as i32).unsigned_abs())
        .max()
        .unwrap_or(0);
    let mismatches = out.iter().zip(want).filter(|(a, b)| a != b).count();
    let frac = mismatches as f32 / want.len() as f32;
    eprintln!("BITMAP+SCOPE PARITY [{name}]: max byte delta = {max_delta}, {mismatches}/{} differ ({:.1}%)", want.len(), frac * 100.0);
    assert!(
        max_delta <= 1,
        "[{name}] FFI vs CPU max byte delta {max_delta} > 1"
    );
    assert!(
        frac < 0.05,
        "[{name}] {:.1}% of bytes differ from CPU",
        frac * 100.0
    );
}

/// The on-screen state that rendered garbage: a resolvable bitmap raster,
/// NO adjustments on the layer, scope enabled and targeting it.
#[test]
fn bitmap_layer_with_empty_adjustments_and_scope_target_matches_cpu() {
    let model = bitmap_model(b"b17a0000000000a0", PartialAdjustments::default());
    let (out, want) = render_ffi(&model, true, 0);
    assert_parity("empty+scope0", &out, &want);
}

/// Same layer carrying a real control, scope still targeting it.
#[test]
fn bitmap_layer_with_exposure_and_scope_target_matches_cpu() {
    let model = bitmap_model(
        b"b17a0000000000a1",
        PartialAdjustments {
            exposure: Some(0.5),
            ..Default::default()
        },
    );
    let (out, want) = render_ffi(&model, true, 0);
    assert_parity("exposure+scope0", &out, &want);
}

/// Control: scope disabled, same bitmap layer. If this passes while the two
/// above fail, the scope-target path (alpha lane / scope pass) is the culprit.
#[test]
fn bitmap_layer_with_exposure_and_no_scope_matches_cpu() {
    let model = bitmap_model(
        b"b17a0000000000a2",
        PartialAdjustments {
            exposure: Some(0.5),
            ..Default::default()
        },
    );
    let (out, want) = render_ffi(&model, false, -1);
    assert_parity("exposure+noscope", &out, &want);
}
