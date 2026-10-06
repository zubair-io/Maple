use super::*;

#[test]
fn output_bits_do_not_depend_on_pool_size() {
    let (w, h) = (257, 289);
    let plane: Vec<f32> = (0..w * h)
        .map(|i| 0.25 + ((i * 179 + i / w * 31) % 1024) as f32 / 16384.0)
        .collect();
    // Constant-h tiled, profile-modulated general, and non-five-tap general paths.
    for (patch_radius, profile) in [(2, None), (2, Some([0.000003, 0.000000001])), (3, None)] {
        let mut reference = None;
        for threads in [1, 2, 4, 7] {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .unwrap();
            let output = pool.install(|| {
                denoise_plane_cancellable(
                    &plane,
                    w,
                    h,
                    NlmParams {
                        patch_radius,
                        search_radius: 2,
                        h: 0.02,
                    },
                    CancelToken::never(),
                    &plane,
                    profile.as_ref().map(|p| &p[..]),
                    100,
                    true,
                )
            });
            let bits: Vec<_> = output.iter().map(|x| x.to_bits()).collect();
            if let Some(expected) = &reference {
                assert_eq!(
                    &bits, expected,
                    "patch={patch_radius}, profile={profile:?}, threads={threads}"
                );
            } else {
                reference = Some(bits);
            }
        }
    }
}

#[test]
fn cancelled_tiled_dispatch_returns_input_bits() {
    let plane = vec![0.317; 257 * 65];
    let flag = std::sync::atomic::AtomicBool::new(true);
    let out = denoise_plane_cancellable(
        &plane,
        257,
        65,
        NlmParams {
            patch_radius: 2,
            search_radius: 3,
            h: 0.04,
        },
        CancelToken::new(&flag),
        &plane,
        None,
        0,
        false,
    );
    assert_eq!(out, plane);
}
