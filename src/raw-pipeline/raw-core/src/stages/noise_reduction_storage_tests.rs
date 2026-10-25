//! Storage oracle for #5157. Both adapters fill the L / a / b planes straight
//! from each pixel's Oklab conversion; the references here keep the previous
//! layout — one interleaved `Vec<[f32; 3]>` copy split into planes — around
//! the same NLM kernels and parameters, and require bit-identical output.
use super::retention_tests::assert_same_bits;
use super::*;
use std::sync::atomic::AtomicBool;

fn interleaved_luminance_adapter(
    img: &mut Image,
    amount: f32,
    cancel: CancelToken<'_>,
    noise_profile: Option<&[f32]>,
    iso: u32,
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 {
        return;
    }
    let params = luma_params(amount);
    let w = img.width as usize;
    let h = img.height as usize;

    let mut oklab: Vec<[f32; 3]> = vec![[0.0; 3]; img.pixels.len()];
    oklab
        .par_iter_mut()
        .zip(img.pixels.par_iter())
        .for_each(|(dst, src)| *dst = rec2020_to_oklab(*src));
    let l_plane: Vec<f32> = oklab.par_iter().map(|p| p[0]).collect();

    let denoised_l = denoise_plane_cancellable(
        &l_plane,
        w,
        h,
        params,
        cancel,
        &l_plane,
        noise_profile,
        iso,
        false,
    );

    img.pixels
        .par_iter_mut()
        .zip(oklab.par_iter())
        .zip(denoised_l.par_iter())
        .for_each(|((dst, lab), &new_l)| {
            *dst = oklab_to_rec2020([new_l, lab[1], lab[2]]);
        });
}

fn interleaved_color_adapter(
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
    drop(oklab);

    let (denoised_a, denoised_b) = denoise_chroma_pair_cancellable(
        &a_plane,
        &b_plane,
        w,
        h,
        params,
        cancel,
        &l_plane,
        noise_profile,
        iso,
    );

    img.pixels
        .par_iter_mut()
        .zip(l_plane.par_iter())
        .zip(denoised_a.par_iter())
        .zip(denoised_b.par_iter())
        .for_each(|(((dst, &l), &new_a), &new_b)| {
            *dst = oklab_to_rec2020([l, new_a, new_b]);
        });
}

/// A step edge between a deep shadow and an HDR highlight, hashed per-pixel
/// noise on every channel, and a sprinkle of negative and non-finite values
/// so the planes carry every payload the writeback has to preserve.
fn synthetic_frame(w: u32, h: u32) -> Image {
    let mut frame = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    let half = (w as usize) / 2;
    for (i, pixel) in frame.pixels.iter_mut().enumerate() {
        let hashed = (i as u32).wrapping_mul(0x9e37_79b9);
        let noise = (hashed >> 8) as f32 / 16_777_216.0 - 0.5;
        let base = if i % (w as usize) < half { 0.015 } else { 4.0 };
        *pixel = match i % 97 {
            13 => [-0.25, base * 0.7, -0.0],
            41 => [f32::INFINITY, base * 0.7, base * 0.3],
            71 => [f32::from_bits(0x7fc1_2345), 0.5, 0.2],
            _ => [base + 0.08 * noise, base * 0.7 + 0.02 * noise, base * 0.3],
        };
    }
    frame
}

const CAMERA_PROFILE: [f32; 6] = [0.0002, 0.00002, 0.0003, 0.00004, 0.0004, 0.00005];
const FOUR_CHANNEL_PROFILE: [f32; 8] = [
    0.0002, 0.00002, 0.0003, 0.00004, 0.0001, 0.00003, 0.0004, 0.00005,
];
/// 129 x 128 crosses the 16384-pixel threshold where the profile-less kernel
/// takes its tiled dispatch.
const SIZES: [(u32, u32); 5] = [(1, 1), (3, 10), (37, 29), (129, 65), (129, 128)];
const AMOUNTS: [f32; 3] = [0.0, 25.0, 100.0];

fn profiles() -> [Option<&'static [f32]>; 4] {
    [
        None,
        Some(&CAMERA_PROFILE[..]),
        Some(&FOUR_CHANNEL_PROFILE[..]),
        Some(&[][..]),
    ]
}

#[test]
fn luminance_planes_match_interleaved_adapter_bit_for_bit() {
    let cancelled = AtomicBool::new(true);
    for (w, h) in SIZES {
        let source = synthetic_frame(w, h);
        for profile in profiles() {
            for amount in AMOUNTS {
                for cancel in [CancelToken::never(), CancelToken::new(&cancelled)] {
                    let mut expected = source.clone();
                    interleaved_luminance_adapter(&mut expected, amount, cancel, profile, 3200);
                    let mut actual = source.clone();
                    apply_luminance_cancellable(&mut actual, amount, cancel, profile, 3200);
                    assert_same_bits(&expected, &actual);
                }
            }
        }
    }
}

#[test]
fn color_planes_match_interleaved_adapter_bit_for_bit() {
    let cancelled = AtomicBool::new(true);
    for (w, h) in SIZES {
        let source = synthetic_frame(w, h);
        for profile in profiles() {
            for amount in AMOUNTS {
                for scale in [1.0, 0.5] {
                    for cancel in [CancelToken::never(), CancelToken::new(&cancelled)] {
                        let mut expected = source.clone();
                        interleaved_color_adapter(
                            &mut expected,
                            amount,
                            cancel,
                            profile,
                            3200,
                            scale,
                        );
                        let mut actual = source.clone();
                        apply_color_sampled_cancellable(
                            &mut actual,
                            amount,
                            cancel,
                            profile,
                            3200,
                            scale,
                        );
                        assert_same_bits(&expected, &actual);
                    }
                }
            }
        }
    }
}
