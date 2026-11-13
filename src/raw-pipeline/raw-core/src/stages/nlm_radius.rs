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
        let mut radius = Self::new(n, params.search_radius);
        let mut inv_norm = vec![0.0f32; n];
        radius.fill_variance_scaled(&mut inv_norm, l_plane, params, s_coeff, o_coeff);
        (radius, inv_norm)
    }

    pub(super) fn new(n: usize, search_radius: usize) -> Self {
        if search_radius <= u8::MAX as usize {
            Self::Compact(vec![0u8; n])
        } else {
            Self::Wide(vec![0isize; n])
        }
    }

    pub(super) fn fill_variance_scaled(
        &mut self,
        inv_norm: &mut [f32],
        l_plane: &[f32],
        params: NlmParams,
        s_coeff: f32,
        o_coeff: f32,
    ) {
        self.fill_indexed(
            inv_norm,
            |i| l_plane.get(i).copied(),
            params,
            s_coeff,
            o_coeff,
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn fill_tile(
        &mut self,
        inv_norm: &mut [f32],
        guide: &[f32],
        image_width: usize,
        row_start: usize,
        col_start: usize,
        tile_width: usize,
        params: NlmParams,
        noise: (f32, f32),
    ) {
        self.fill_indexed(
            inv_norm,
            |i| {
                guide
                    .get((row_start + i / tile_width) * image_width + col_start + i % tile_width)
                    .copied()
            },
            params,
            noise.0,
            noise.1,
        );
    }

    fn fill_indexed(
        &mut self,
        inv_norm: &mut [f32],
        guide: impl Fn(usize) -> Option<f32> + Sync,
        params: NlmParams,
        s_coeff: f32,
        o_coeff: f32,
    ) {
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
        match self {
            Self::Compact(radius) => {
                radius
                    .par_iter_mut()
                    .zip(inv_norm.par_iter_mut())
                    .enumerate()
                    .for_each(|(i, (r, inv))| {
                        let (value, norm) = guide(i).map(local_params).unwrap_or((0, 0.0));
                        *r = value as u8;
                        *inv = norm;
                    });
            }
            Self::Wide(radius) => {
                radius
                    .par_iter_mut()
                    .zip(inv_norm.par_iter_mut())
                    .enumerate()
                    .for_each(|(i, (r, inv))| {
                        let (value, norm) = guide(i).map(local_params).unwrap_or((0, 0.0));
                        *r = value;
                        *inv = norm;
                    });
            }
        }
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
