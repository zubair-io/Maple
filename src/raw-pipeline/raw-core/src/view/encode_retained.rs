//! Exact adjacent display encoding for the retained WASM viewport (#4352).
use super::*;

pub(crate) fn rec2020_to_display_encoded(img: &mut Image, target: TargetPrimaries) {
    img.assert_space(ColorSpace::DisplayLinearRec2020);
    match target {
        TargetPrimaries::Srgb => img.pixels.par_iter_mut().for_each(|p| {
            let srgb = M_REC2020_TO_SRGB.mul_vec(*p);
            *p = compress_to_unit_cube_oklab(srgb, srgb_linear_to_oklab, oklab_to_srgb_linear);
            p[0] = srgb_gamma(p[0]);
            p[1] = srgb_gamma(p[1]);
            p[2] = srgb_gamma(p[2]);
        }),
        TargetPrimaries::P3 => img.pixels.par_iter_mut().for_each(|p| {
            let p3 = M_REC2020_TO_P3.mul_vec(*p);
            *p = compress_to_unit_cube_oklab(p3, p3_linear_to_oklab, oklab_to_p3_linear);
            p[0] = srgb_gamma(p[0]);
            p[1] = srgb_gamma(p[1]);
            p[2] = srgb_gamma(p[2]);
        }),
    }
    // Preserve the exact existing srgb_gamma_encode end tag for either
    // requested target; the target matrix and compression hull remain above.
    img.space = ColorSpace::DisplayEncodedSrgb;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_encoding_matches_original_two_stages_exactly() {
        let specials = [
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
        for threads in [1, 2, 8] {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .unwrap();
            pool.install(|| {
                for target in [TargetPrimaries::Srgb, TargetPrimaries::P3] {
                    for len in [0, 1, 17, 4097] {
                        let mut original = Image::new(len, 1, ColorSpace::DisplayLinearRec2020);
                        original.whites_anchor_ev = Some(1.25);
                        original.nr_sampling_scale = 0.125;
                        for (i, p) in original.pixels.iter_mut().enumerate() {
                            *p = std::array::from_fn(|c| specials[(i * 7 + c) % specials.len()]);
                        }
                        let mut fused = original.clone();
                        rec2020_to_display(&mut original, target);
                        srgb_gamma_encode(&mut original);
                        rec2020_to_display_encoded(&mut fused, target);
                        assert_eq!(fused.space, original.space);
                        assert_eq!(fused.whites_anchor_ev, original.whites_anchor_ev);
                        assert_eq!(fused.nr_sampling_scale, original.nr_sampling_scale);
                        for (a, e) in fused
                            .pixels
                            .iter()
                            .flatten()
                            .zip(original.pixels.iter().flatten())
                        {
                            assert_eq!(
                                a.to_bits(),
                                e.to_bits(),
                                "threads={threads} target={target:?} len={len}"
                            );
                        }
                    }
                }
            });
        }
    }
}
