// Invocation-local preparation shared by the two chroma planes (#4352).
// Each plane retains its independent SSD, weights and reduction order.
use super::{
    denoise_plane_cancellable, denoise_prepared, get_noise_params, CancelToken, NlmParams,
};
use rayon::prelude::*;

pub(super) fn prepare_scaling(
    n: usize,
    params: NlmParams,
    l_plane: &[f32],
    noise_profile: Option<&[f32]>,
    iso: u32,
    is_chroma: bool,
) -> (Vec<isize>, Vec<f32>) {
    let p = params.patch_radius;
    let use_dynamic = noise_profile.is_some();
    let (s_coeff, o_coeff) = if use_dynamic {
        get_noise_params(noise_profile, iso, is_chroma)
    } else {
        (0.0, 0.0)
    };

    let mut local_s_plane = Vec::new();
    let mut local_inv_norm_plane = Vec::new();
    if use_dynamic {
        let patch_area = ((2 * p + 1) * (2 * p + 1)) as f32;
        local_s_plane = vec![0isize; n];
        local_inv_norm_plane = vec![0.0f32; n];
        local_s_plane
            .par_iter_mut()
            .zip(local_inv_norm_plane.par_iter_mut())
            .zip(l_plane.par_iter())
            .for_each(|((s_out, inv_norm_out), &l_val)| {
                let local_l = l_val.clamp(0.0, 10.0);
                let var = s_coeff * local_l + o_coeff;
                let sigma = var.max(0.0).sqrt();
                let scale = (sigma / 0.002366).clamp(0.1, 10.0);

                let local_h = params.h * scale;
                let local_h_sq = local_h * local_h;
                *inv_norm_out = 1.0 / (local_h_sq * patch_area);

                let local_s = (params.search_radius as f32 * scale).round() as isize;
                *s_out = local_s.clamp(1, params.search_radius as isize);
            });
    }

    (local_s_plane, local_inv_norm_plane)
}

pub(crate) fn denoise_chroma_pair_cancellable(
    a_plane: &[f32],
    b_plane: &[f32],
    w: usize,
    h: usize,
    params: NlmParams,
    cancel: CancelToken<'_>,
    l_plane: &[f32],
    noise_profile: Option<&[f32]>,
    iso: u32,
) -> (Vec<f32>, Vec<f32>) {
    // Preserve identity/tiled dispatch and cancellation in the existing entry.
    if noise_profile.is_none() || params.h <= 0.0 || params.search_radius == 0 {
        return rayon::join(
            || {
                denoise_plane_cancellable(
                    a_plane,
                    w,
                    h,
                    params,
                    cancel,
                    l_plane,
                    noise_profile,
                    iso,
                    true,
                )
            },
            || {
                denoise_plane_cancellable(
                    b_plane,
                    w,
                    h,
                    params,
                    cancel,
                    l_plane,
                    noise_profile,
                    iso,
                    true,
                )
            },
        );
    }
    let n = w * h;
    assert_eq!(
        a_plane.len(),
        n,
        "denoise_plane: len {} != w*h = {}",
        a_plane.len(),
        n
    );
    assert_eq!(
        b_plane.len(),
        n,
        "denoise_plane: len {} != w*h = {}",
        b_plane.len(),
        n
    );
    let (local_s_plane, local_inv_norm_plane) =
        prepare_scaling(n, params, l_plane, noise_profile, iso, true);
    rayon::join(
        || {
            denoise_prepared(
                a_plane,
                w,
                h,
                params,
                cancel,
                &local_s_plane,
                &local_inv_norm_plane,
                true,
            )
        },
        || {
            denoise_prepared(
                b_plane,
                w,
                h,
                params,
                cancel,
                &local_s_plane,
                &local_inv_norm_plane,
                true,
            )
        },
    )
}

#[cfg(test)]
#[path = "nlm_chroma_tests.rs"]
mod tests;
