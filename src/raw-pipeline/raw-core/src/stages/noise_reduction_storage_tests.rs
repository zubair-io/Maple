//! #1472: separate channel storage must preserve the materialized Oklab
//! adapter's exact pixels, including negative/HDR values and camera noise.
use super::*;

fn materialized_color_reference(
    image: &Image,
    amount: f32,
    noise: Option<&[f32]>,
    iso: u32,
    cancel: CancelToken<'_>,
) -> Vec<[f32; 3]> {
    let lab: Vec<[f32; 3]> = image.pixels.iter().copied().map(rec2020_to_oklab).collect();
    let l: Vec<f32> = lab.iter().map(|p| p[0]).collect();
    let a: Vec<f32> = lab.iter().map(|p| p[1]).collect();
    let b: Vec<f32> = lab.iter().map(|p| p[2]).collect();
    let filter = |plane: &[f32]| {
        denoise_plane_cancellable(
            plane,
            image.width as usize,
            image.height as usize,
            chroma_params(amount),
            cancel,
            &l,
            noise,
            iso,
            true,
        )
    };
    let denoised_a = filter(&a);
    let denoised_b = filter(&b);
    lab.iter()
        .zip(denoised_a)
        .zip(denoised_b)
        .map(|((p, a), b)| oklab_to_rec2020([p[0], a, b]))
        .collect()
}

#[test]
fn channel_planes_match_materialized_color_adapter_bit_for_bit() {
    use std::sync::atomic::AtomicBool;
    let cancelled = AtomicBool::new(true);
    let camera = [0.0002, 0.00002, 0.0003, 0.00004, 0.0004, 0.00005];
    let four_channel = [
        0.0002, 0.00002, 0.0003, 0.00004, 0.0001, 0.00003, 0.0004, 0.00005,
    ];
    for (w, h) in [(1, 1), (3, 10), (37, 29)] {
        let mut source = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        source.pixels.iter_mut().enumerate().for_each(|(i, p)| {
            let noise = ((i as u32).wrapping_mul(0x9e3779b9) >> 8) as f32 / 16777216.0;
            let base = if i % (w as usize) < w as usize / 2 {
                0.015
            } else {
                4.0
            };
            *p = [base + 0.08 * (noise - 0.5), base * 0.7, base * 0.3];
        });
        for profile in [
            None,
            Some(&camera[..]),
            Some(&four_channel[..]),
            Some(&[][..]),
        ] {
            for amount in [25.0, 100.0] {
                for cancel in [CancelToken::never(), CancelToken::new(&cancelled)] {
                    let expected =
                        materialized_color_reference(&source, amount, profile, 3200, cancel);
                    let mut actual = source.clone();
                    apply_color_cancellable(&mut actual, amount, cancel, profile, 3200);
                    assert_eq!(actual.space, ColorSpace::SceneLinearRec2020);
                    for (i, (a, b)) in actual.pixels.iter().zip(expected).enumerate() {
                        assert_eq!(
                            a.map(f32::to_bits),
                            b.map(f32::to_bits),
                            "{w}x{h} amount {amount}, pixel {i}"
                        );
                    }
                }
            }
        }
    }
}
