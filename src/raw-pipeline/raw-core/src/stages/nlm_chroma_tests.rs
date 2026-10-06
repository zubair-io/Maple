use super::*;
use std::sync::atomic::AtomicBool;

fn inputs(n: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let a = (0..n)
        .map(|i| ((i * 37 % 257) as f32 - 128.0) * 0.001)
        .collect();
    let b = (0..n)
        .map(|i| ((i * 53 % 251) as f32 - 125.0) * 0.002)
        .collect();
    let l = (0..n).map(|i| (i % 127) as f32 * 0.03).collect();
    (a, b, l)
}

fn bits(values: &[f32]) -> Vec<u32> {
    values.iter().map(|x| x.to_bits()).collect()
}

#[test]
fn paired_chroma_matches_independent_passes_for_profiles_and_pool_sizes() {
    let profiles: [&[f32]; 4] = [
        &[],
        &[8.35468701e-5, 2.895240131e-8],
        &[0.0001, 0.00000001, 0.0002, 0.00000002, 0.0003, 0.00000003],
        &[
            0.0001, 0.00000001, 0.0002, 0.00000002, 0.0003, 0.00000003, 0.0004, 0.00000004,
        ],
    ];
    for threads in [1, 2, 8] {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .unwrap();
        pool.install(|| {
            for (w, h) in [(1, 1), (17, 19), (129, 131)] {
                let (a, b, l) = inputs(w * h);
                for profile in [None].into_iter().chain(profiles.into_iter().map(Some)) {
                    for iso in [0, 100] {
                        let params = NlmParams {
                            patch_radius: 2,
                            search_radius: 1,
                            h: 0.02,
                        };
                        let expected = rayon::join(
                            || {
                                denoise_plane_cancellable(
                                    &a,
                                    w,
                                    h,
                                    params,
                                    CancelToken::never(),
                                    &l,
                                    profile,
                                    iso,
                                    true,
                                )
                            },
                            || {
                                denoise_plane_cancellable(
                                    &b,
                                    w,
                                    h,
                                    params,
                                    CancelToken::never(),
                                    &l,
                                    profile,
                                    iso,
                                    true,
                                )
                            },
                        );
                        let got = denoise_chroma_pair_cancellable(
                            &a,
                            &b,
                            w,
                            h,
                            params,
                            CancelToken::never(),
                            &l,
                            profile,
                            iso,
                        );
                        assert_eq!(
                            bits(&got.0),
                            bits(&expected.0),
                            "A {w}x{h} threads={threads} iso={iso}"
                        );
                        assert_eq!(
                            bits(&got.1),
                            bits(&expected.1),
                            "B {w}x{h} threads={threads} iso={iso}"
                        );
                    }
                }
            }
        });
    }
}

#[test]
fn paired_chroma_preserves_cancelled_and_identity_input_bits() {
    let (mut a, mut b, mut l) = inputs(17 * 19);
    for (i, value) in [0x80000000, 0x7fc01234, 0xffc05678, 0x7f800000, 0xff800000]
        .into_iter()
        .enumerate()
    {
        a[i] = f32::from_bits(value);
        b[i + 7] = f32::from_bits(value);
        l[i + 14] = f32::from_bits(value);
    }
    let flag = AtomicBool::new(true);
    for (h, search_radius, token) in [
        (0.02, 1, CancelToken::new(&flag)),
        (0.0, 1, CancelToken::never()),
        (0.02, 0, CancelToken::never()),
    ] {
        let params = NlmParams {
            patch_radius: 2,
            search_radius,
            h,
        };
        let got = denoise_chroma_pair_cancellable(
            &a,
            &b,
            17,
            19,
            params,
            token,
            &l,
            Some(&[0.0001, 0.00000001]),
            100,
        );
        assert_eq!(bits(&got.0), bits(&a));
        assert_eq!(bits(&got.1), bits(&b));
    }
}

#[test]
fn paired_dynamic_chroma_keeps_exceptional_plane_and_luminance_bits() {
    let (mut a, mut b, mut l) = inputs(19 * 17);
    for (i, value) in [0x80000000, 0x7fc01234, 0xffc05678, 0x7f800000, 0xff800000]
        .into_iter()
        .enumerate()
    {
        a[i + 40] = f32::from_bits(value);
        b[i + 70] = f32::from_bits(value);
        l[i + 100] = f32::from_bits(value);
    }
    let params = NlmParams {
        patch_radius: 2,
        search_radius: 1,
        h: 0.02,
    };
    let profile = Some(&[0.0001, 0.00000001][..]);
    let expected = rayon::join(
        || {
            denoise_plane_cancellable(
                &a,
                19,
                17,
                params,
                CancelToken::never(),
                &l,
                profile,
                100,
                true,
            )
        },
        || {
            denoise_plane_cancellable(
                &b,
                19,
                17,
                params,
                CancelToken::never(),
                &l,
                profile,
                100,
                true,
            )
        },
    );
    let got = denoise_chroma_pair_cancellable(
        &a,
        &b,
        19,
        17,
        params,
        CancelToken::never(),
        &l,
        profile,
        100,
    );
    assert_eq!(bits(&got.0), bits(&expected.0));
    assert_eq!(bits(&got.1), bits(&expected.1));
}
