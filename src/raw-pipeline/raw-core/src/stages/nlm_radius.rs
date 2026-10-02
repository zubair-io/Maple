//! #1472: editor search radii fit in one byte. Preserve wider public NLM
//! parameters without allocating an isize for every ordinary image pixel.
use super::NlmParams;
use rayon::prelude::*;

pub(super) enum LocalRadiusPlane {
    Compact(Vec<u8>),
    Wide(Vec<isize>),
}

impl LocalRadiusPlane {
    pub(super) fn empty() -> Self {
        Self::Compact(Vec::new())
    }

    pub(super) fn variance_scaled(
        n: usize,
        l_plane: &[f32],
        params: NlmParams,
        s_coeff: f32,
        o_coeff: f32,
    ) -> (Self, Vec<f32>) {
        let patch_area = ((2 * params.patch_radius + 1) * (2 * params.patch_radius + 1)) as f32;
        let local_params = |l_val: f32| {
            let local_l = l_val.clamp(0.0, 10.0);
            let var = s_coeff * local_l + o_coeff;
            let sigma = var.max(0.0).sqrt();
            let scale = (sigma / 0.002366).clamp(0.1, 10.0);
            let local_h = params.h * scale;
            let local_h_sq = local_h * local_h;
            let inv_norm = 1.0 / (local_h_sq * patch_area);
            let local_s = (params.search_radius as f32 * scale).round() as isize;
            (local_s.clamp(1, params.search_radius as isize), inv_norm)
        };
        let mut inv_norm = vec![0.0f32; n];
        let radius = if params.search_radius <= u8::MAX as usize {
            let mut radius = vec![0u8; n];
            radius
                .par_iter_mut()
                .zip(inv_norm.par_iter_mut())
                .zip(l_plane.par_iter())
                .for_each(|((r, inv), &l)| {
                    let (value, norm) = local_params(l);
                    *r = value as u8;
                    *inv = norm;
                });
            Self::Compact(radius)
        } else {
            let mut radius = vec![0isize; n];
            radius
                .par_iter_mut()
                .zip(inv_norm.par_iter_mut())
                .zip(l_plane.par_iter())
                .for_each(|((r, inv), &l)| {
                    let (value, norm) = local_params(l);
                    *r = value;
                    *inv = norm;
                });
            Self::Wide(radius)
        };
        (radius, inv_norm)
    }

    #[inline(always)]
    pub(super) fn get(&self, index: usize) -> isize {
        match self {
            Self::Compact(values) => values[index] as isize,
            Self::Wide(values) => values[index],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_radius_at_and_above_byte_boundary() {
        for maximum in [255, 256, 300] {
            let (radius, _) = LocalRadiusPlane::variance_scaled(
                1,
                &[10.0],
                NlmParams {
                    patch_radius: 2,
                    search_radius: maximum,
                    h: 0.04,
                },
                0.01,
                0.000005,
            );
            assert_eq!(radius.get(0), maximum as isize);
            assert_eq!(
                matches!(radius, LocalRadiusPlane::Compact(_)),
                maximum <= 255
            );
        }
    }
}
