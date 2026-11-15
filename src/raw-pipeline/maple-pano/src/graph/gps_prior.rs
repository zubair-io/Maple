use super::{CandidateProvider, GraphImage, GroundFootprint};
use crate::ingest::GpsPrior;

pub const GPS_MAX_NEIGHBOURS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GpsNomination {
    pub a: usize,
    pub b: usize,
    pub distance_m: f64,
    pub limit_m: f64,
}

pub struct GpsPriorProvider<'a> {
    pub fixes: &'a [Option<GpsPrior>],
    pub ground: &'a [Option<GroundFootprint>],
}

pub(super) fn valid_fix(fix: GpsPrior) -> bool {
    fix.lat_deg.is_finite()
        && fix.lon_deg.is_finite()
        && fix.lat_deg.abs() <= 90.0
        && fix.lon_deg.abs() <= 180.0
        && (fix.lat_deg != 0.0 || fix.lon_deg != 0.0)
}

fn distance(a: GpsPrior, b: GpsPrior) -> f64 {
    let footprint = |g: GpsPrior| GroundFootprint {
        lat_deg: g.lat_deg,
        lon_deg: g.lon_deg,
        diagonal_m: 0.0,
    };
    footprint(a).distance_m(&footprint(b))
}

impl GpsPriorProvider<'_> {
    pub fn nominations(&self, image_count: usize) -> Vec<GpsNomination> {
        let fixes: Vec<_> = self
            .fixes
            .iter()
            .take(image_count)
            .map(|g| g.filter(|&fix| valid_fix(fix)))
            .collect();
        let mut steps: Vec<_> = fixes
            .windows(2)
            .filter_map(|pair| {
                let d = distance(pair[0]?, pair[1]?);
                (d > 1.0).then_some(d)
            })
            .collect();
        steps.sort_unstable_by(f64::total_cmp);
        let radius = steps
            .get(steps.len().saturating_sub(1) / 2)
            .copied()
            .map_or(5.0, |step| (step * 2.5).max(5.0));
        let mut nearest = vec![Vec::new(); fixes.len()];
        for (a, fix) in fixes.iter().enumerate() {
            let Some(fix) = fix else { continue };
            for (b, other) in fixes.iter().enumerate() {
                let Some(other) = other else { continue };
                if a == b {
                    continue;
                }
                let limit_m = self
                    .ground
                    .get(a)
                    .copied()
                    .flatten()
                    .zip(self.ground.get(b).copied().flatten())
                    .map_or(radius, |(x, y)| (x.diagonal_m + y.diagonal_m) * 0.5);
                let distance_m = distance(*fix, *other);
                if distance_m <= limit_m {
                    let entries = &mut nearest[a];
                    entries.push((b, distance_m, limit_m));
                    entries.sort_unstable_by(|x, y| x.1.total_cmp(&y.1).then(x.0.cmp(&y.0)));
                    entries.truncate(GPS_MAX_NEIGHBOURS);
                }
            }
        }
        let mut out = Vec::new();
        for (a, entries) in nearest.iter().enumerate() {
            for &(b, distance_m, limit_m) in entries {
                // Mutual nearest neighbours bound incoming as well as outgoing fan-out.
                if a < b && nearest[b].iter().any(|&(i, _, _)| i == a) {
                    out.push(GpsNomination {
                        a,
                        b,
                        distance_m,
                        limit_m,
                    });
                }
            }
        }
        out.sort_unstable_by_key(|n| (n.a, n.b));
        out
    }
}

impl CandidateProvider for GpsPriorProvider<'_> {
    fn name(&self) -> &'static str {
        "gps-proximity"
    }
    fn candidates(&self, images: &[GraphImage]) -> Vec<(usize, usize)> {
        self.nominations(images.len())
            .into_iter()
            .map(|n| (n.a, n.b))
            .collect()
    }
}

#[cfg(test)]
#[path = "gps_prior_tests.rs"]
mod tests;
