//! Phase-1 end-to-end seam test (#1484): a baked `InpaintPatch` composited at
//! the pre-user-grade seam via the **real** `stages::inpaint_composite` stage
//! re-grades coherently with the surrounding sensor data — exercising the full
//! Phase-1 path (carrier → inverse view+grade → composite → WB/exposure/AgX/
//! encode) through the production stages rather than inline math.
//!
//! The "model" is the identity (its display output = its input crop), so the
//! test measures the round-trip fidelity of bake→invert→composite→re-grade. A
//! real removal swaps the crop's content; the grading behavior this test pins
//! down is identical.

use crate::image::{ColorSpace, Image};
use crate::stages::{inpaint_composite, white_balance};
use crate::types::{InpaintPatch, WbMethod};
use crate::view::{agx, agx_inverse, encode, grade_inverse};

const W: usize = 32;
const H: usize = 32;

fn luma(p: [f32; 3]) -> f32 {
    0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2]
}

/// Pre-grade scene-linear "sensor" data: a log luma ramp down Y (deep shadow →
/// bright highlight) crossed with color bands across X, so the right-half region
/// the patch covers spans every tonal zone.
fn synthetic_scene() -> Vec<[f32; 3]> {
    let mut px = Vec::with_capacity(W * H);
    for y in 0..H {
        let t = y as f32 / (H as f32 - 1.0);
        let l = 0.005 * (4.0f32 / 0.005).powf(t);
        for x in 0..W {
            let base = match x * 4 / W {
                0 => [1.0f32, 1.0, 1.0],
                1 => [1.3, 0.9, 0.6],
                2 => [0.7, 0.95, 1.3],
                _ => [0.8, 1.2, 0.7],
            };
            px.push([l * base[0], l * base[1], l * base[2]]);
        }
    }
    px
}

/// Full forward bake-preview / live path on a `W×H` buffer: WB → exposure → AgX
/// → rec2020→sRGB → gamma. Returns display-encoded f32 in [0,1].
fn forward_display(pre: &[[f32; 3]], t: f32, tint: f32, ev: f32, m: WbMethod) -> Vec<[f32; 3]> {
    let mut img = Image {
        width: W as u32,
        height: H as u32,
        pixels: pre.to_vec(),
        space: ColorSpace::SceneLinearRec2020,
    };
    white_balance::apply(&mut img, t, tint, m);
    let g = ev.exp2();
    for p in &mut img.pixels {
        p[0] *= g;
        p[1] *= g;
        p[2] *= g;
    }
    agx::apply(&mut img, 0.0);
    encode::rec2020_to_srgb(&mut img);
    encode::srgb_gamma_encode(&mut img);
    img.pixels
}

fn to_u8(disp: &[[f32; 3]]) -> Vec<[u8; 3]> {
    disp.iter()
        .map(|p| {
            [
                (p[0] * 255.0 + 0.5).clamp(0.0, 255.0) as u8,
                (p[1] * 255.0 + 0.5).clamp(0.0, 255.0) as u8,
                (p[2] * 255.0 + 0.5).clamp(0.0, 255.0) as u8,
            ]
        })
        .collect()
}

#[test]
fn baked_patch_composited_at_seam_regrades_like_sensor() {
    let scene = synthetic_scene();
    let m = WbMethod::Cat16;
    let (t0, tint0, ev0) = (5500.0f32, 0.0f32, 0.0f32);
    let slope0 = 1.0f32;

    // 1) Bake the whole scene at G0, quantize to 8-bit ("model input").
    let u8s = to_u8(&forward_display(&scene, t0, tint0, ev0, m));

    // 2) Build an InpaintPatch for the RIGHT HALF by inverting that region's
    //    display pixels back to pre-grade scene-linear.
    let rx0 = W / 2;
    let pw = (W - rx0) as u32;
    let ph = H as u32;
    let mut pixels = Vec::with_capacity((pw * ph) as usize);
    for y in 0..H {
        for x in rx0..W {
            let mut tmp = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
            tmp.pixels[0] = agx_inverse::display_u8_to_scene_linear(u8s[y * W + x], slope0);
            grade_inverse::inverse_exposure(&mut tmp, ev0);
            grade_inverse::inverse_white_balance(&mut tmp, t0, tint0, m);
            pixels.push(tmp.pixels[0]);
        }
    }
    let patch = InpaintPatch {
        width: pw,
        height: ph,
        origin: [rx0 as f32 / W as f32, 0.0],
        extent: [(W - rx0) as f32 / W as f32, 1.0],
        pixels,
        coverage: vec![1.0; (pw * ph) as usize],
    };

    // 3) Composite into a copy of the pre-grade scene via the real stage.
    let mut composited = Image {
        width: W as u32,
        height: H as u32,
        pixels: scene.clone(),
        space: ColorSpace::SceneLinearRec2020,
    };
    inpaint_composite::apply(&mut composited, &[patch]);

    // 4) Re-render composited (candidate) vs original scene (truth) under a push
    //    matrix; measure the patched region by tonal zone.
    let evs = [-2.0f32, 0.0, 2.0];
    let temps = [4500.0f32, 6500.0];
    let mut mid_sum = 0.0f64;
    let mut mid_cnt = 0usize;
    let mut mid_max = 0.0f32;
    let mut hi_max = 0.0f32;
    let mut all_finite = true;
    for &ev in &evs {
        for &t in &temps {
            let cand = forward_display(&composited.pixels, t, tint0, ev, m);
            let truth = forward_display(&scene, t, tint0, ev, m);
            for y in 0..H {
                for x in rx0..W {
                    let i = y * W + x;
                    let l = luma(scene[i]);
                    for c in 0..3 {
                        let e = (cand[i][c] - truth[i][c]).abs() * 255.0;
                        if !e.is_finite() {
                            all_finite = false;
                        }
                        if l >= 0.05 && l <= 1.0 {
                            mid_sum += e as f64;
                            mid_cnt += 1;
                            mid_max = mid_max.max(e);
                        } else if l > 1.0 {
                            hi_max = hi_max.max(e);
                        }
                    }
                }
            }
        }
    }
    let mid_mean = if mid_cnt > 0 {
        mid_sum / mid_cnt as f64
    } else {
        0.0
    };
    eprintln!(
        "[phase1 seam] patched-region re-grade error (u8): midtone mean={:.3} max={:.2} (n={}), highlight max={:.2}",
        mid_mean, mid_max, mid_cnt, hi_max
    );

    assert!(all_finite, "non-finite re-grade error in patched region");
    assert!(
        mid_mean < 1.5,
        "seam midtone mean {:.3} u8 too high",
        mid_mean
    );
    assert!(mid_max < 6.0, "seam midtone max {:.2} u8 too high", mid_max);
    assert!(
        hi_max < 64.0,
        "seam highlight error {:.2} u8 not bounded",
        hi_max
    );

    // 5) The untouched LEFT half must be byte-identical to truth — the composite
    //    must not leak past its region.
    let cand0 = forward_display(&composited.pixels, t0, tint0, ev0, m);
    let truth0 = forward_display(&scene, t0, tint0, ev0, m);
    for y in 0..H {
        for x in 0..rx0 {
            let i = y * W + x;
            for c in 0..3 {
                assert!(
                    (cand0[i][c] - truth0[i][c]).abs() < 1e-6,
                    "composite leaked into the untouched left half at ({x},{y})"
                );
            }
        }
    }
}
