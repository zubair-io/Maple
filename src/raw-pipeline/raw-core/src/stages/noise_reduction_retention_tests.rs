//! Storage-lifetime oracle for #4372. The reference preserves the pre-change
//! adapter while calling the same existing scalar NLM kernels and parameters.
use super::*;
use std::sync::atomic::AtomicBool;

fn original_color_adapter(
    img: &mut Image,
    amount: f32,
    cancel: CancelToken<'_>,
    noise_profile: Option<&[f32]>,
    iso: u32,
    sampling_scale: f32,
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 {
        return;
    }
    let mut params = chroma_params(amount);
    params.search_radius = chroma_search_radius(sampling_scale);

    let w = img.width as usize;
    let h = img.height as usize;

    let mut oklab: Vec<[f32; 3]> = vec![[0.0; 3]; img.pixels.len()];
    oklab
        .par_iter_mut()
        .zip(img.pixels.par_iter())
        .for_each(|(dst, src)| *dst = rec2020_to_oklab(*src));

    let l_plane: Vec<f32> = oklab.par_iter().map(|p| p[0]).collect();
    let a_plane: Vec<f32> = oklab.par_iter().map(|p| p[1]).collect();
    let b_plane: Vec<f32> = oklab.par_iter().map(|p| p[2]).collect();

    // Run both NLM passes in parallel — each is already internally
    // parallel via the row-update sweeps, but at viewport sizes the
    // outer split still helps on 8+-core machines. Both share the same
    // cancel token (a `Copy` borrow), so a host cancel unwinds both.
    let (denoised_a, denoised_b) = rayon::join(
        || {
            denoise_plane_cancellable(
                &a_plane,
                w,
                h,
                params,
                cancel,
                &l_plane,
                noise_profile,
                iso,
                true,
            )
        },
        || {
            denoise_plane_cancellable(
                &b_plane,
                w,
                h,
                params,
                cancel,
                &l_plane,
                noise_profile,
                iso,
                true,
            )
        },
    );

    img.pixels
        .par_iter_mut()
        .zip(oklab.par_iter())
        .zip(denoised_a.par_iter())
        .zip(denoised_b.par_iter())
        .for_each(|(((dst, lab), &new_a), &new_b)| {
            *dst = oklab_to_rec2020([lab[0], new_a, new_b]);
        });
}

fn assert_same_bits(a: &Image, b: &Image) {
    assert_eq!((a.width, a.height, a.space), (b.width, b.height, b.space));
    assert_eq!(a.pixels.len(), b.pixels.len());
    for (index, (a, b)) in a.pixels.iter().zip(&b.pixels).enumerate() {
        assert_eq!(a.map(f32::to_bits), b.map(f32::to_bits), "pixel {index}");
    }
}

#[test]
fn existing_l_plane_writeback_matches_original_adapter_for_hdr_and_tails() {
    let noise = [0.0001, 0.00001, 0.0002, 0.00002, 0.0003, 0.00003];
    for (w, h) in [(1, 1), (1, 7), (7, 1), (17, 9), (129, 129)] {
        for profile in [None, Some(noise.as_slice())] {
            for scale in [1.0, 0.5] {
                let mut input = Image::new(w, h, ColorSpace::SceneLinearRec2020);
                for (i, pixel) in input.pixels.iter_mut().enumerate() {
                    let value = ((i % 29) as f32 - 7.0) * 0.125;
                    *pixel = [value, value * 0.3, value * 4.0];
                }
                let mut original = input.clone();
                original_color_adapter(
                    &mut original,
                    25.0,
                    CancelToken::never(),
                    profile,
                    800,
                    scale,
                );
                apply_color_sampled_cancellable(
                    &mut input,
                    25.0,
                    CancelToken::never(),
                    profile,
                    800,
                    scale,
                );
                assert_same_bits(&original, &input);
            }
        }
    }
}

#[test]
fn copied_l_preserves_signed_zero_nonfinite_payloads_and_writeback_tails() {
    let values = [
        0.0,
        -0.0,
        f32::from_bits(0x7fc12345),
        f32::INFINITY,
        f32::NEG_INFINITY,
        -0.25,
        64.0,
    ];
    for len in [1, 3, 7, 17] {
        let oklab: Vec<_> = (0..len)
            .map(|i| [values[i % values.len()], 0.2, -0.3])
            .collect();
        let l_plane: Vec<_> = oklab.par_iter().map(|pixel| pixel[0]).collect();
        for (pixel, l) in oklab.iter().zip(&l_plane) {
            assert_eq!(pixel[0].to_bits(), l.to_bits());
            assert_eq!(
                oklab_to_rec2020(*pixel).map(f32::to_bits),
                oklab_to_rec2020([*l, pixel[1], pixel[2]]).map(f32::to_bits)
            );
        }
    }
}

#[test]
fn storage_release_preserves_cancelled_and_zero_amount_adapter_results() {
    let cancelled = AtomicBool::new(true);
    let mut source = Image::new(17, 9, ColorSpace::SceneLinearRec2020);
    for (i, pixel) in source.pixels.iter_mut().enumerate() {
        *pixel = [i as f32 * 0.01, -0.0, 2.0];
    }
    for amount in [0.0, 25.0] {
        let mut original = source.clone();
        let mut candidate = source.clone();
        original_color_adapter(
            &mut original,
            amount,
            CancelToken::new(&cancelled),
            None,
            100,
            1.0,
        );
        apply_color_sampled_cancellable(
            &mut candidate,
            amount,
            CancelToken::new(&cancelled),
            None,
            100,
            1.0,
        );
        assert_same_bits(&original, &candidate);
        if amount == 0.0 {
            assert_same_bits(&source, &candidate);
        }
    }
}

#[test]
fn existing_l_plane_matches_original_adapter_for_nonfinite_input() {
    let values = [
        [-0.0, 0.0, -0.0],
        [f32::from_bits(0x7fc12345), 0.5, 0.2],
        [f32::INFINITY, 0.2, -0.1],
        [f32::NEG_INFINITY, 0.3, 0.4],
        [-0.4, 0.6, 4.0],
    ];
    let noise = [0.0001, 0.00001];
    for (w, h) in [(1, 7), (17, 9)] {
        for profile in [None, Some(noise.as_slice())] {
            let mut candidate = Image::new(w, h, ColorSpace::SceneLinearRec2020);
            for (i, pixel) in candidate.pixels.iter_mut().enumerate() {
                *pixel = values[i % values.len()];
            }
            let mut original = candidate.clone();
            original_color_adapter(&mut original, 25.0, CancelToken::never(), profile, 100, 1.0);
            apply_color_sampled_cancellable(
                &mut candidate,
                25.0,
                CancelToken::never(),
                profile,
                100,
                1.0,
            );
            assert_same_bits(&original, &candidate);
        }
    }
}
