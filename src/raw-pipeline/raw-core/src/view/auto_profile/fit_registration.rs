use super::paired_observations::ObservationSet;
mod features;
mod optimizer;
use features::Gray;

#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(feature = "stage-dump", derive(serde::Serialize))]
pub(super) struct Warp {
    pub coefficients: [f64; 6],
}

impl Warp {
    pub(super) const IDENTITY: Self = Self {
        coefficients: [1., 0., 0., 0., 1., 0.],
    };
    pub(super) fn map(self, u: f64, v: f64) -> [f64; 2] {
        let [a, b, x, c, d, y] = self.coefficients;
        [a * u + b * v + x, c * u + d * v + y]
    }
    /// Axis-aligned source extent, in source pixels, of one target pixel.
    pub(super) fn support(self, width: usize, height: usize, tw: usize, th: usize) -> [f64; 2] {
        let [a, b, _, c, d, _] = self.coefficients;
        let (tw, th) = (tw as f64, th as f64);
        [
            width as f64 * (a.abs() / tw + b.abs() / th),
            height as f64 * (c.abs() / tw + d.abs() / th),
        ]
    }
}

#[cfg_attr(feature = "stage-dump", derive(serde::Serialize))]
pub(super) struct Registration {
    pub warp: Warp,
    identity_correlation: f64,
    aligned_correlation: f64,
    maximum_grid_displacement: f64,
}

fn register(source: Gray, target: Gray) -> Option<Registration> {
    if source.width != target.width
        || source.height != target.height
        || source.width.min(source.height) < 32
    {
        return None;
    }
    let mut warp = Warp::IDENTITY;
    let mut previous = 0;
    let mut first = 0.;
    let mut final_scores = None;
    for edge in [
        64.min(source.width.max(source.height)),
        128.min(source.width.max(source.height)),
    ] {
        if edge == previous {
            continue;
        }
        let src = source.normalized(edge);
        let dst = target.normalized(edge);
        let (next, identity, score) = optimizer::stage(&src, &dst, warp)?;
        if previous == 0 {
            first = score;
        }
        warp = next;
        final_scores = Some((identity, score));
        previous = edge;
    }
    let (identity_correlation, aligned_correlation) = final_scores?;
    let maximum_grid_displacement = [0., 0.5, 1.]
        .into_iter()
        .flat_map(|v| [0., 0.5, 1.].map(move |u| (u, v)))
        .map(|(u, v)| {
            let p = warp.map(u, v);
            ((p[0] - u) * source.width as f64).hypot((p[1] - v) * source.height as f64)
        })
        .fold(0., f64::max);
    (first >= 0.8
        && aligned_correlation >= 0.6
        && aligned_correlation > identity_correlation + 1e-3
        && maximum_grid_displacement >= 0.5)
        .then_some(Registration {
            warp,
            identity_correlation,
            aligned_correlation,
            maximum_grid_displacement,
        })
}

pub(super) fn estimate(observations: &ObservationSet) -> Option<Registration> {
    if observations.rows.len()
        != observations
            .grid_width
            .checked_mul(observations.grid_height)?
    {
        return None;
    }
    let luma = |rgb: [f64; 3]| 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    let source = Gray {
        width: observations.grid_width,
        height: observations.grid_height,
        pixels: observations.rows.iter().map(|r| luma(r.baseline)).collect(),
    };
    let target = Gray {
        pixels: observations.rows.iter().map(|r| luma(r.target)).collect(),
        ..source.clone()
    };
    if !source
        .pixels
        .iter()
        .chain(&target.pixels)
        .all(|v| v.is_finite())
    {
        return None;
    }
    register(source, target)
}

#[cfg(test)]
mod tests;
