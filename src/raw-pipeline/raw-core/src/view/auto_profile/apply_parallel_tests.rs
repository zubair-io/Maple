//! #4352: independent pixels retain exact bits across worker counts and RGB tails.
use super::apply_curve;
use crate::view::auto_profile::{ChannelCurve, ProfileCurve};

fn input() -> Vec<f32> {
    let special = [
        0.0,
        -0.0,
        -0.2,
        0.95,
        1.0,
        4.0,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::from_bits(0x7fc0_abcd),
    ];
    (0..12_305)
        .map(|i| {
            if i < special.len() {
                special[i]
            } else {
                ((i * 7919 % 65_521) as f32 / 65_521.0) * 1.4 - 0.2
            }
        })
        .collect()
}

fn curves() -> Vec<ProfileCurve> {
    let identity = ProfileCurve::identity();
    let channel = ChannelCurve {
        anchors: std::array::from_fn(|i| {
            let x = i as f32 / 31.0;
            (x, x * x)
        }),
    };
    let fitted = ProfileCurve {
        r: channel.clone(),
        g: channel.clone(),
        b: channel,
        ..identity.clone()
    };
    let matrix = ProfileCurve {
        matrix: [[0.95, 0.03, 0.02], [0.01, 0.97, 0.02], [0.03, 0.02, 0.95]],
        ..fitted.clone()
    };
    let chroma = ProfileCurve {
        chroma_boost: 1.1,
        chroma_offset: [0.002, -0.003],
        lightness_offset: 0.01,
        lightness_band_offsets: [-0.01, 0.002, 0.0, -0.002, 0.01],
        ab_band_offsets: [[0.001, -0.001]; 5],
        ..matrix.clone()
    };
    vec![identity, fitted, matrix, chroma]
}

#[test]
fn curve_worker_counts_preserve_pixel_bits_and_incomplete_rgb_tail() {
    // A single pixel cannot split among Rayon workers. The captured pre-change
    // serial implementation is additionally qualified by the independent #4352 oracle.
    for curve in curves() {
        for len in [0, 1, 2, 3, 12_303, 12_304, 12_305] {
            let original = input();
            let mut expected = original[..len].to_vec();
            for pixel in expected.chunks_exact_mut(3) {
                apply_curve(pixel, &curve);
            }
            for threads in [1, 2, 8] {
                let pool = rayon::ThreadPoolBuilder::new()
                    .num_threads(threads)
                    .build()
                    .unwrap();
                let mut actual = original[..len].to_vec();
                pool.install(|| apply_curve(&mut actual, &curve));
                assert_eq!(
                    actual.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                    expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                    "len={len}, threads={threads}, curve={curve:?}"
                );
                assert_eq!(actual[len - len % 3..], original[len - len % 3..len]);
            }
        }
    }
}
