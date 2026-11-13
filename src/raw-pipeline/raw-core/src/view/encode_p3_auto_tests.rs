use super::*;
use crate::color::matrices::M_SRGB_TO_P3;

fn neutral_p3(rec2020: Rgb) -> Rgb {
    let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
    img.pixels[0] = rec2020;
    rec2020_to_display(&mut img, TargetPrimaries::P3);
    srgb_gamma_encode(&mut img);
    img.pixels[0]
}

fn specials() -> Vec<Rgb> {
    let edge = [
        0.0,
        -0.0,
        -1.0,
        1e-8,
        0.003_130_8,
        0.18,
        1.0,
        16.0,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::from_bits(0x7fc0_0011),
    ];
    (0..edge.len() * 4)
        .map(|i| std::array::from_fn(|c| edge[(i * 7 + c * 3) % edge.len()]))
        .collect()
}

fn oklab_sweep() -> Vec<Rgb> {
    let mut out = Vec::new();
    for hue in (0..360).step_by(15) {
        let (sin_h, cos_h) = (hue as f32).to_radians().sin_cos();
        for l in [0.3, 0.5, 0.7, 0.85] {
            for step in 0..40 {
                let c = 0.01 * step as f32;
                out.push(crate::color::oklab::oklab_to_rec2020([
                    l,
                    c * cos_h,
                    c * sin_h,
                ]));
            }
        }
    }
    out
}

fn contrast_tail(p: Rgb) -> Rgb {
    p.map(|v| (v * v * (3.0 - 2.0 * v) * 0.4 + v * 0.6).clamp(0.0, 1.0))
}

fn lightness_tail(p: Rgb) -> Rgb {
    let lin = gamma_decode(p);
    let [l, a, b] = srgb_linear_to_oklab(lin);
    gamma_encode(oklab_to_srgb_linear([l * 0.92, a, b]).map(|v| v.clamp(0.0, 1.0)))
}

#[test]
fn identity_tail_equals_neutral_p3_bit_exact() {
    for x in specials().into_iter().chain(oklab_sweep()) {
        let got = p3_auto_pixel(x, &|p| p);
        let want = neutral_p3(x);
        assert!(same_bits(got, want), "x={x:?} got={got:?} want={want:?}");
    }
}

#[test]
fn in_gamut_pixels_are_the_srgb_render_colour_managed_into_p3() {
    let mut checked = 0;
    for x in oklab_sweep() {
        let uncompressed = M_REC2020_TO_SRGB.mul_vec(x);
        if !same_bits(compress_srgb(uncompressed), uncompressed) {
            continue;
        }
        let got = p3_auto_pixel(x, &contrast_tail);
        let want = gamma_encode(
            M_SRGB_TO_P3.mul_vec(gamma_decode(contrast_tail(gamma_encode(uncompressed)))),
        );
        for c in 0..3 {
            assert!(
                (got[c] - want[c]).abs() < 1e-6,
                "x={x:?} got={got:?} want={want:?}"
            );
        }
        checked += 1;
    }
    assert!(checked > 200, "only {checked} in-gamut pixels exercised");
}

#[test]
fn headroom_ratio_is_one_for_neutrals_and_non_finite() {
    assert_eq!(headroom_ratio(0.0, 0.3), 1.0);
    assert_eq!(headroom_ratio(0.2, f32::NAN), 1.0);
    assert_eq!(headroom_ratio(0.2, 0.19), 1.0);
    assert!(headroom_ratio(0.2, 0.3) > 1.0);
}

#[test]
fn chroma_sweep_across_the_srgb_hull_is_continuous_and_monotonic_with_hue_held() {
    for hue_deg in [0.0f32, 40.0, 100.0, 145.0, 200.0, 265.0, 320.0] {
        let (sin_h, cos_h) = hue_deg.to_radians().sin_cos();
        let mut previous: Option<(f32, f32)> = None;
        let mut crossed_hull = false;
        for step in 0..=400 {
            let c = 0.001 * step as f32;
            let x = crate::color::oklab::oklab_to_rec2020([0.6, c * cos_h, c * sin_h]);
            let out = p3_auto_pixel(x, &lightness_tail);
            let lab = p3_linear_to_oklab(gamma_decode(out));
            let chroma = oklab_chroma(lab);
            let srgb_raw = M_REC2020_TO_SRGB.mul_vec(x);
            crossed_hull |= !same_bits(compress_srgb(srgb_raw), srgb_raw);
            if let Some((last_c, last_h)) = previous {
                assert!(
                    chroma >= last_c - 2e-3,
                    "hue {hue_deg}: chroma fell {last_c} -> {chroma} at c={c}"
                );
                assert!(
                    chroma - last_c < 0.02,
                    "hue {hue_deg}: chroma jumped {last_c} -> {chroma} at c={c}"
                );
                if chroma > 0.03 {
                    let hue = lab[2].atan2(lab[1]).to_degrees();
                    let drift = ((hue - last_h + 540.0) % 360.0) - 180.0;
                    assert!(
                        drift.abs() < 3.0,
                        "hue {hue_deg}: hue jumped by {drift} at c={c}"
                    );
                }
            }
            previous = Some((chroma, lab[2].atan2(lab[1]).to_degrees()));
        }
        assert!(
            crossed_hull,
            "hue {hue_deg}: sweep never left the sRGB hull"
        );
    }
}

#[test]
fn p3_only_colour_keeps_its_wide_gamut_saturation_with_auto_on() {
    let m_p3_to_srgb = M_SRGB_TO_P3.inverse().expect("invertible");
    let target_p3 = [0.05f32, 0.92, 0.10];
    let rec2020 = M_REC2020_TO_P3
        .inverse()
        .expect("invertible")
        .mul_vec(target_p3);
    assert!(M_REC2020_TO_SRGB
        .mul_vec(rec2020)
        .iter()
        .any(|&c| c < -1e-3));
    for tail in [
        &(|p| p) as &dyn Fn(Rgb) -> Rgb,
        &contrast_tail,
        &lightness_tail,
    ] {
        let out = gamma_decode(p3_auto_pixel(rec2020, &tail));
        assert!(out.iter().all(|c| (0.0..=1.0).contains(c)));
        let as_srgb = m_p3_to_srgb.mul_vec(out);
        assert!(
            as_srgb.iter().any(|&c| c < -1e-3 || c > 1.0 + 1e-3),
            "Auto capped P3 at the sRGB gamut: {out:?} -> {as_srgb:?}"
        );
    }
}

#[test]
fn every_input_yields_a_finite_pixel_inside_the_unit_cube() {
    for x in specials().into_iter().chain(oklab_sweep()) {
        for tail in [
            &(|p| p) as &dyn Fn(Rgb) -> Rgb,
            &contrast_tail,
            &lightness_tail,
        ] {
            let out = p3_auto_pixel(x, &tail);
            assert!(
                out.iter().all(|c| (0.0..=1.0).contains(c)),
                "x={x:?} out={out:?}"
            );
        }
    }
}

#[test]
fn near_identity_prepared_tail_stays_close_to_neutral_p3() {
    use crate::view::auto_profile::{apply::prepared_tail, lut::ColorLut};
    let lut = ColorLut::identity(17);
    let tail = prepared_tail(None, Some((lut.size, &lut.data)), 1.0);
    for x in oklab_sweep()
        .into_iter()
        .filter(|x| x.iter().all(|c| *c >= 0.0))
    {
        let got = gamma_decode(p3_auto_pixel(x, &tail));
        let want = gamma_decode(neutral_p3(x));
        for c in 0..3 {
            assert!(
                (got[c] - want[c]).abs() < 1e-3,
                "x={x:?} got={got:?} want={want:?}"
            );
        }
    }
}
