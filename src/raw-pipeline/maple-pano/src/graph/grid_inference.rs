use super::gps_prior::valid_fix;
use super::{GridLayout, GridOrder};
use crate::ingest::FramePriors;

pub fn infer_grid(priors: &[FramePriors]) -> Option<GridLayout> {
    if priors.len() < 4 {
        return None;
    }
    let (points, minimum_step) = coordinates(priors)?;
    let mut accepted = None;
    for cols in 2..=priors.len() / 2 {
        let rows = priors.len().div_ceil(cols);
        if priors.len() % cols == 1 {
            continue;
        }
        for order in [GridOrder::Raster, GridOrder::Serpentine] {
            let layout = GridLayout {
                rows,
                cols,
                order,
                diagonals: false,
            };
            if fits(&points, layout, minimum_step) {
                if accepted.is_some() {
                    return None;
                }
                accepted = Some(layout);
            }
        }
    }
    accepted
}

fn coordinates(priors: &[FramePriors]) -> Option<(Vec<[f64; 2]>, f64)> {
    if priors.iter().any(|p| p.gps.is_some()) {
        let origin = priors[0].gps.filter(|&g| valid_fix(g))?;
        let cos_lat = origin.lat_deg.to_radians().cos();
        if cos_lat.abs() < 0.01 {
            return None;
        }
        let points = priors
            .iter()
            .map(|p| {
                let g = p.gps.filter(|&g| valid_fix(g))?;
                let lon = (g.lon_deg - origin.lon_deg + 180.0).rem_euclid(360.0) - 180.0;
                Some([
                    lon.to_radians() * 6_371_008.8 * cos_lat,
                    (g.lat_deg - origin.lat_deg).to_radians() * 6_371_008.8,
                ])
            })
            .collect::<Option<Vec<_>>>()?;
        return Some((points, 5.0));
    }
    let origin = priors[0].gimbal?;
    let points = priors
        .iter()
        .map(|p| {
            let g = p.gimbal?;
            if !g.yaw_deg.is_finite() || !g.pitch_deg.is_finite() || g.pitch_deg.abs() >= 80.0 {
                return None;
            }
            let yaw = (g.yaw_deg - origin.yaw_deg + 180.0).rem_euclid(360.0) - 180.0;
            if yaw.abs() > 120.0 {
                return None;
            }
            Some([
                yaw * origin.pitch_deg.to_radians().cos(),
                g.pitch_deg - origin.pitch_deg,
            ])
        })
        .collect::<Option<Vec<_>>>()?;
    Some((points, 2.0))
}

fn fits(points: &[[f64; 2]], layout: GridLayout, minimum_step: f64) -> bool {
    let n = points.len() as f64;
    let mut mean = [0.0; 4];
    for (i, p) in points.iter().enumerate() {
        let (r, c) = layout.cell(i).unwrap();
        for (sum, value) in mean.iter_mut().zip([r as f64, c as f64, p[0], p[1]]) {
            *sum += value / n;
        }
    }
    let (mut rr, mut cc, mut rc) = (0.0, 0.0, 0.0);
    let (mut rp, mut cp) = ([0.0; 2], [0.0; 2]);
    for (i, p) in points.iter().enumerate() {
        let (r, c) = layout.cell(i).unwrap();
        let (r, c) = (r as f64 - mean[0], c as f64 - mean[1]);
        rr += r * r;
        cc += c * c;
        rc += r * c;
        for k in 0..2 {
            rp[k] += r * (p[k] - mean[k + 2]);
            cp[k] += c * (p[k] - mean[k + 2]);
        }
    }
    let det = rr * cc - rc * rc;
    if det <= 0.0 {
        return false;
    }
    let mut row = [0.0; 2];
    let mut col = [0.0; 2];
    for k in 0..2 {
        row[k] = (rp[k] * cc - cp[k] * rc) / det;
        col[k] = (cp[k] * rr - rp[k] * rc) / det;
    }
    let row_len = row[0].hypot(row[1]);
    let col_len = col[0].hypot(col[1]);
    let step = row_len.min(col_len);
    if step < minimum_step || (row[0] * col[0] + row[1] * col[1]).abs() > 0.25 * row_len * col_len {
        return false;
    }
    points.iter().enumerate().all(|(i, p)| {
        let (r, c) = layout.cell(i).unwrap();
        let error =
            |k| p[k] - mean[k + 2] - (r as f64 - mean[0]) * row[k] - (c as f64 - mean[1]) * col[k];
        error(0).hypot(error(1)) <= step * 0.15
    })
}

#[cfg(test)]
#[path = "grid_inference_tests.rs"]
mod tests;
