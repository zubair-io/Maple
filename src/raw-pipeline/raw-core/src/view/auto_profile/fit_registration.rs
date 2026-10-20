use super::paired_observations::ObservationSet;
mod features;
mod optimizer;
mod radial;
use features::Gray;
use optimizer::Pixels;

/// Maps display-normalized JPEG coordinates to RAW-crop coordinates: an
/// affine map plus a bounded radial term `radial·n·|n|²`, `n = 2u - 1`,
/// for the lens-correction residual an affine map cannot express (#5046).
/// `|n|` is measured in pixel-isotropic units: `aspect` scales each axis by
/// its share of the frame's long edge, so the term stays radial off-square.
#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(feature = "stage-dump", derive(serde::Serialize))]
pub(super) struct Warp {
    pub coefficients: [f64; 6],
    pub radial: f64,
    pub aspect: [f64; 2],
}

impl Warp {
    pub(super) const IDENTITY: Self = Self {
        coefficients: [1., 0., 0., 0., 1., 0.],
        radial: 0.,
        aspect: [1., 1.],
    };
    pub(super) const MAXIMUM_RADIAL: f64 = 0.025;
    /// Per-axis share of the long edge for a `width × height` frame.
    pub(super) fn aspect_of(width: usize, height: usize) -> [f64; 2] {
        let long = width.max(height) as f64;
        [width as f64 / long, height as f64 / long]
    }
    pub(super) fn is_identity(self) -> bool {
        self.coefficients == Self::IDENTITY.coefficients && self.radial == 0.
    }
    fn radius_squared(self, nx: f64, ny: f64) -> f64 {
        let [sx, sy] = self.aspect;
        (nx * sx).powi(2) + (ny * sy).powi(2)
    }
    pub(super) fn map(self, u: f64, v: f64) -> [f64; 2] {
        let [a, b, x, c, d, y] = self.coefficients;
        let (nx, ny) = (2. * u - 1., 2. * v - 1.);
        let r2 = self.radius_squared(nx, ny);
        [
            a * u + b * v + x + self.radial * nx * r2,
            c * u + d * v + y + self.radial * ny * r2,
        ]
    }
    /// Partial derivatives `[∂x/∂u, ∂x/∂v, ∂y/∂u, ∂y/∂v]` at `(u, v)`.
    pub(super) fn jacobian(self, u: f64, v: f64) -> [f64; 4] {
        let [a, b, _, c, d, _] = self.coefficients;
        let (nx, ny) = (2. * u - 1., 2. * v - 1.);
        let ([sx, sy], r2) = (self.aspect, self.radius_squared(nx, ny));
        [
            a + self.radial * (2. * r2 + 4. * sx * sx * nx * nx),
            b + self.radial * 4. * sy * sy * nx * ny,
            c + self.radial * 4. * sx * sx * nx * ny,
            d + self.radial * (2. * r2 + 4. * sy * sy * ny * ny),
        ]
    }
    /// Newton inverse of [`Self::map`]; `None` where it folds or diverges.
    pub(super) fn inverse_map(self, x: f64, y: f64) -> Option<[f64; 2]> {
        let mut p = [x, y];
        for _ in 0..16 {
            let q = self.map(p[0], p[1]);
            let [a, b, c, d] = self.jacobian(p[0], p[1]);
            let determinant = a * d - b * c;
            if !determinant.is_finite() || determinant <= 0. {
                return None;
            }
            let (ex, ey) = (q[0] - x, q[1] - y);
            if ex.abs().max(ey.abs()) < 1e-12 {
                return Some(p);
            }
            p = [
                p[0] - (d * ex - b * ey) / determinant,
                p[1] - (a * ey - c * ex) / determinant,
            ];
        }
        None
    }
    /// Axis-aligned source extent, in source pixels, of one target pixel at `(u, v)`.
    pub(super) fn support(
        self,
        width: usize,
        height: usize,
        tw: usize,
        th: usize,
        u: f64,
        v: f64,
    ) -> [f64; 2] {
        let [a, b, c, d] = self.jacobian(u, v);
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

fn register(source: Gray, target: Gray, aspect: [f64; 2]) -> Option<Registration> {
    if source.width != target.width
        || source.height != target.height
        || source.width.min(source.height) < 32
    {
        return None;
    }
    let mut warp = Warp {
        aspect,
        ..Warp::IDENTITY
    };
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
        let stage = optimizer::stage(&src, &dst, warp, false, Pixels::All, Pixels::All)?;
        if previous == 0 {
            first = stage.correlation;
        }
        warp = stage.warp;
        final_scores = Some((stage.identity_correlation, stage.correlation));
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
    let accepted = first >= 0.8
        && aligned_correlation >= 0.6
        && aligned_correlation > identity_correlation + 1e-3
        && maximum_grid_displacement >= 0.5;
    accepted.then(|| Registration {
        warp: radial::refine(&source, &target, warp).unwrap_or(warp),
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
    register(
        source,
        target,
        Warp::aspect_of(observations.frame[0], observations.frame[1]),
    )
}

#[cfg(test)]
mod radial_tests;
#[cfg(test)]
mod tests;
