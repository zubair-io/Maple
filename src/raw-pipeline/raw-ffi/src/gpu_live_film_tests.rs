//! Host-parity gate for `MapleGpuLiveParams`'s film-look tail (epic #2683,
//! Task 8). Sibling of `gpu_live_chain_parity_tests.rs`'s family: drives the
//! FFI live-render entry with a synthetic non-identity lattice and holds it
//! to the CPU stage composition — the same develop subset
//! `gpu_live_tests.rs`'s own `cpu_reference` runs, with
//! `raw_core::stages::film_look::apply` inserted at `render/mod.rs`'s
//! position (post-agx, pre `rec2020_to_srgb` — color_grade and grain sit
//! either side of it there too, but every model in this file leaves both
//! at their `AdjustmentModel::default()` zero, so they're no-ops and can be
//! omitted from the reference without changing the numeric result).

use super::gpu_live_tests::{make_params, owned_arrays, scene_linear_rgba};
use raw_core::image::{ColorSpace, Image};
use raw_core::stages::film_look;
use raw_core::types::WbMethod;
use raw_core::view::auto_profile::curve::ProfileCurve;
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::AdjustmentModel;

const DIMS: (u32, u32) = (8, 8);

/// A deliberately non-identity, non-monochrome, channel-rotating lattice
/// (mirrors `stages::film_look`'s own private test helper — that one is not
/// visible outside its module, so this follows the family's established
/// "mirror, don't share" pattern for the feature).
fn nonidentity_film_lut(n: usize) -> Vec<f32> {
    let denom = (n - 1) as f32;
    let mut data = vec![0.0f32; n * n * n * 3];
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let i = ((b * n + g) * n + r) * 3;
                data[i] = (g as f32 / denom).powf(0.6);
                data[i + 1] = (b as f32 / denom).powf(1.4);
                data[i + 2] = (r as f32 / denom).powf(0.8);
            }
        }
    }
    data
}

/// Base model for every case here: WB at D65 neutral (the params builder's
/// `decoded_temperature: 0.0` sentinel means the WB matrix applies
/// ABSOLUTELY — see `make_params`/`inputs_from_params` — so `temperature:
/// 6500.0, tint: 0.0` keeps that apply an exact identity), and the
/// non-zero `AdjustmentModel::default()` stragglers (`sharpen_amount`,
/// `nr_color`) zeroed so the develop-subset reference below doesn't need to
/// carry them.
fn base_model() -> AdjustmentModel {
    AdjustmentModel {
        temperature: 6500.0,
        tint: 0.0,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        ..AdjustmentModel::default()
    }
}

/// The CPU reference: the same develop-stage subset `gpu_live_tests.rs`'s
/// `cpu_reference` composes, plus `agx` then (optionally) `film_look`, then
/// the display encode + identity Auto-Profile tail + dither. `lut` is
/// `None` for the film-off case (byte-identical to every other sibling
/// file's `cpu_reference` at this model).
fn cpu_reference(
    input: &[f32],
    w: u32,
    h: u32,
    model: &AdjustmentModel,
    lut: Option<(&[f32], usize)>,
    strength: f32,
) -> Vec<u8> {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in input.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }

    raw_core::stages::white_balance::apply(
        &mut img,
        model.temperature,
        model.tint,
        WbMethod::Cat16,
    );
    raw_core::stages::scene_tone_controls::apply(&mut img, model);
    raw_core::stages::tone_curves::apply(&mut img, model);
    raw_core::stages::vibrance::apply(&mut img, model.vibrance);
    raw_core::stages::saturation::apply(&mut img, model.saturation);
    raw_core::stages::clarity::apply(&mut img, model.clarity);
    raw_core::stages::texture::apply(&mut img, model.texture);
    raw_core::stages::dehaze::apply(&mut img, model.dehaze);
    raw_core::stages::local_adjustments::apply(&mut img, &model.local_adjustments);
    raw_core::stages::sharpen::apply(
        &mut img,
        model.sharpen_amount,
        model.sharpen_radius,
        model.sharpen_detail,
        model.sharpen_masking,
    );
    raw_core::stages::noise_reduction::apply_luminance(&mut img, model.nr_luminance, None, 100);
    raw_core::stages::noise_reduction::apply_color(&mut img, model.nr_color, None, 100);

    // View tail: agx → film_look (render/mod.rs's position, `color_grade`
    // elided — a no-op at this file's models) → rec2020_to_srgb →
    // srgb_gamma_encode → identity curve/LUT (the Auto-Profile tail the GPU
    // chain always appends).
    raw_core::view::agx::apply(&mut img, model.contrast);
    if let Some((data, size)) = lut {
        let film_lut = raw_core::film::FilmLut {
            size,
            data: data.to_vec(),
        };
        film_look::apply(&mut img, &film_lut, strength);
    }
    raw_core::view::encode::rec2020_to_srgb(&mut img);
    raw_core::view::encode::srgb_gamma_encode(&mut img);

    let mut rgb: Vec<f32> = Vec::with_capacity(img.pixels.len() * 3);
    for p in &img.pixels {
        rgb.extend_from_slice(&[p[0], p[1], p[2]]);
    }
    raw_core::view::auto_profile::apply::apply_curve(&mut rgb, &ProfileCurve::identity());
    ColorLut::identity(2).apply(&mut rgb);

    let mut rgba = Vec::with_capacity(input.len());
    for px in rgb.chunks_exact(3) {
        rgba.extend_from_slice(&[px[0], px[1], px[2], 1.0]);
    }
    raw_gpu::dither_and_quantize(&rgba, w as usize, h as usize)
}

/// Render `model` through the gpu-live FFI, wiring `film_lut` (or the
/// off-sentinel `film_lut_size: 0` when `None`) onto the tail
/// `make_params` leaves off by default.
fn gpu_surface(
    input: &[f32],
    model: &AdjustmentModel,
    lut: Option<(&[f32], usize)>,
    strength: f32,
) -> Vec<u8> {
    let (w, h) = DIMS;
    let curve = ProfileCurve::identity();
    let identity_lut = ColorLut::identity(2);
    let arr = owned_arrays(model, &curve, &identity_lut);
    let mut p = make_params(model, WbMethod::Cat16, 2, &arr);
    match lut {
        Some((data, size)) => {
            p.film_strength = strength;
            p.film_lut_size = size as u32;
            p.film_lut_key = 1;
            p.film_lut_ptr = data.as_ptr();
            p.film_lut_len = data.len();
        }
        None => {
            p.film_strength = 0.0;
            p.film_lut_size = 0;
            p.film_lut_key = 0;
            p.film_lut_ptr = std::ptr::null();
            p.film_lut_len = 0;
        }
    }
    super::gpu_live_wb_frame_tests::gpu_render(input, w, h, &p)
}

/// **THE GATE.** With a non-identity lattice at full strength, the gpu-live
/// surface must (a) differ meaningfully from the film-off render — proving
/// the tail is actually wired, not silently gated off — and (b) match the
/// CPU composition above within the family's 1-LSB tolerance.
#[test]
fn film_lut_engaged_differs_from_off_and_matches_cpu_reference() {
    let (w, h) = DIMS;
    let input = scene_linear_rgba(w as usize, h as usize);
    let model = base_model();
    let n = 9usize;
    let lattice = nonidentity_film_lut(n);

    let off = gpu_surface(&input, &model, None, 0.0);
    let on = gpu_surface(&input, &model, Some((&lattice, n)), 100.0);

    let moved = off
        .iter()
        .zip(&on)
        .map(|(a, b)| (*a as i16 - *b as i16).unsigned_abs())
        .max()
        .unwrap_or(0);
    assert!(
        moved >= 8,
        "film-on vs film-off moved the surface by only {moved} bytes — too close to \
         film-off for the tolerance check below to gate anything real"
    );

    let cpu_off = cpu_reference(&input, w, h, &model, None, 0.0);
    assert_eq!(
        off, cpu_off,
        "film-off gpu-live must match the film-off CPU reference exactly (dither is \
         deterministic and identical GPU-vs-CPU)"
    );

    let cpu_on = cpu_reference(&input, w, h, &model, Some((&lattice, n)), 100.0);
    let max_delta = on
        .iter()
        .zip(&cpu_on)
        .map(|(a, b)| (*a as i16 - *b as i16).unsigned_abs())
        .max()
        .unwrap_or(0);
    let mismatches = on.iter().zip(&cpu_on).filter(|(a, b)| a != b).count();
    let frac = mismatches as f64 / on.len() as f64;
    eprintln!(
        "FILM LUT PARITY: film-on vs film-off max delta {moved}; gpu-live vs CPU \
         max byte delta {max_delta}, mismatch fraction {frac:.4}"
    );
    assert!(
        max_delta <= 1,
        "film-on gpu-live vs CPU reference max byte delta {max_delta} > 1"
    );
    assert!(
        frac <= 0.05,
        "film-on gpu-live vs CPU reference mismatch fraction {frac:.4} > 0.05"
    );
}

/// A `film_lut_size` that doesn't match the caller's `film_lut_len` must
/// render identically to fully-off — proving `inputs_from_params`'s
/// `film_lut_or_off` gate (not the GPU pass itself) is what rejects a
/// mismatched host buffer.
#[test]
fn mismatched_film_lut_len_renders_identically_to_off() {
    let (w, h) = DIMS;
    let input = scene_linear_rgba(w as usize, h as usize);
    let model = base_model();
    let n = 5usize;
    let mut lattice = nonidentity_film_lut(n);
    lattice.pop(); // now one float short of n³·3

    let off = gpu_surface(&input, &model, None, 0.0);
    let mismatched = gpu_surface(&input, &model, Some((&lattice, n)), 100.0);

    assert_eq!(
        off, mismatched,
        "a mismatched film_lut_len must render identically to film-off, not error \
         or read past the caller's slice"
    );
}
