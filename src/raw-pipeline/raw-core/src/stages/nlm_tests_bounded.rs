use super::super::{denoise_plane_cancellable, get_noise_params};
use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Barrier,
};

fn plane(w: usize, h: usize) -> Vec<f32> {
    (0..w * h)
        .map(|i| {
            let noise = ((i * 137 + i / w * 29) % 197) as f32 / 197.0;
            match i % 5 {
                0 => -0.25 + noise * 0.025,
                1 => 0.5 + noise * 0.1,
                2 => 2.0 + noise * 0.1,
                3 => 12.0 + noise * 0.3,
                _ => noise * 0.001,
            }
        })
        .collect()
}

fn equal_bits(a: &[f32], b: &[f32]) {
    assert_eq!(a.len(), b.len());
    for (i, (a, b)) in a.iter().zip(b).enumerate() {
        assert_eq!(a.to_bits(), b.to_bits(), "pixel {i}: {a} vs {b}");
    }
}

#[test]
fn tiles_preserve_full_path_bits_across_strip_seeds_profiles_and_borders() {
    let profiles: [Option<&[f32]>; 4] = [
        None,
        Some(&[0.00002, 0.000002, 0.00003, 0.000003, 0.00004, 0.000004]),
        Some(&[
            0.00002, 0.000002, 0.00003, 0.000003, 0.00005, 0.000005, 0.00004, 0.000004,
        ]),
        Some(&[]),
    ];
    for threads in [1, 3, 7, 23] {
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .unwrap()
            .install(|| {
                for (w, h, p, s) in [
                    (37, 1059, 2, 3),
                    (19, 769, 0, 2),
                    (71, 263, 3, 1),
                    (3, 10, 2, 3),
                    (1, 1, 0, 256),
                ] {
                    let input = plane(w, h);
                    let params = NlmParams {
                        patch_radius: p,
                        search_radius: s,
                        h: 0.04,
                    };
                    for profile in profiles {
                        for (iso, chroma) in [(800, false), (800, true), (0, true)] {
                            let expected = denoise_plane_cancellable(
                                &input,
                                w,
                                h,
                                params,
                                CancelToken::never(),
                                &input,
                                profile,
                                iso,
                                chroma,
                            );
                            let actual = denoise(
                                &input,
                                w,
                                h,
                                params,
                                CancelToken::never(),
                                &input,
                                profile.is_some(),
                                get_noise_params(profile, iso, chroma),
                            );
                            equal_bits(&expected, &actual);
                        }
                    }
                }
            });
    }
}

#[test]
fn columns_preserve_horizontal_reseed_phase_and_partial_last_tile() {
    for threads in [3, 7] {
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .unwrap()
            .install(|| {
                let (w, h) = (2051, 769);
                let input = plane(w, h);
                let params = NlmParams {
                    patch_radius: 3,
                    search_radius: 2,
                    h: 0.05,
                };
                for profile in [None, Some(&[0.00002, 0.000002][..])] {
                    let expected = denoise_plane_cancellable(
                        &input,
                        w,
                        h,
                        params,
                        CancelToken::never(),
                        &input,
                        profile,
                        800,
                        true,
                    );
                    let actual = denoise(
                        &input,
                        w,
                        h,
                        params,
                        CancelToken::never(),
                        &input,
                        profile.is_some(),
                        get_noise_params(profile, 800, true),
                    );
                    equal_bits(&expected, &actual);
                }
            });
    }
}

#[test]
fn short_guide_does_not_leak_metadata_from_previous_tile() {
    let (w, h) = (37, 1059);
    let input = plane(w, h);
    let params = NlmParams {
        patch_radius: 2,
        search_radius: 3,
        h: 0.04,
    };
    for len in [0, 17, 257 * w, h * w - 17] {
        let profile = Some(&[0.00002, 0.000002][..]);
        let guide = &input[..len];
        let expected = denoise_plane_cancellable(
            &input,
            w,
            h,
            params,
            CancelToken::never(),
            guide,
            profile,
            800,
            true,
        );
        let actual = denoise(
            &input,
            w,
            h,
            params,
            CancelToken::never(),
            guide,
            true,
            get_noise_params(profile, 800, true),
        );
        equal_bits(&expected, &actual);
    }
}

#[test]
fn normal_100mp_workers_fit_scratch_target_without_full_weight_planes() {
    let params = NlmParams {
        patch_radius: 2,
        search_radius: 3,
        h: 0.05,
    };
    for w in [11600, 12288] {
        for dynamic in [false, true] {
            let count = worker_count(w, dynamic, params);
            assert!(count * worker_bytes(w, dynamic, params) <= SCRATCH_TARGET);
            assert!(use_bounded(w * 8192, dynamic, params));
            assert!(!use_bounded(1600 * 1250, dynamic, params));
        }
    }
}

#[test]
fn cancellation_discards_partial_tiles_and_returns_whole_input() {
    let (w, h) = (1024, 2048);
    let input = plane(w, h);
    let params = NlmParams {
        patch_radius: 2,
        search_radius: 12,
        h: 0.05,
    };
    let flag = AtomicBool::new(false);
    let barrier = Barrier::new(2);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            barrier.wait();
            std::thread::sleep(std::time::Duration::from_millis(10));
            flag.store(true, Ordering::Relaxed);
        });
        barrier.wait();
        let output = denoise(
            &input,
            w,
            h,
            params,
            CancelToken::new(&flag),
            &[],
            false,
            (0.0, 0.0),
        );
        assert!(flag.load(Ordering::Relaxed));
        equal_bits(&input, &output);
    });
    equal_bits(
        &input,
        &denoise(
            &input,
            w,
            h,
            params,
            CancelToken::new(&flag),
            &[],
            false,
            (0.0, 0.0),
        ),
    );
}
