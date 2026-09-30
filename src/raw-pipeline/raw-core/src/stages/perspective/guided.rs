//! Guided geometry (#3438). Endpoints are in the same centred coordinates as
//! `Perspective::matrix`; no image processing or second homography lives here.

use super::{Homography, Perspective, ASPECT_MAX_RATIO, KEYSTONE_MAX};

#[derive(Clone, Copy, Debug)]
pub struct GuideLine(pub [f32; 4]);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GuideFamily {
    Vertical,
    Horizontal,
    Both,
}

#[derive(Clone, Copy, Debug)]
pub struct GuidedCorrection {
    pub vertical: f32,
    pub horizontal: f32,
    pub rotate: f32,
    pub limited: bool,
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn equation(line: GuideLine) -> Result<[f64; 3], &'static str> {
    let [x1, y1, x2, y2] = line.0.map(f64::from);
    if !line.0.iter().all(|x| x.is_finite()) || (x2 - x1).hypot(y2 - y1) < 1e-4 {
        return Err("Draw a longer line along a straight edge.");
    }
    let l = cross([x1, y1, 1.0], [x2, y2, 1.0]);
    let norm = l[0].hypot(l[1]);
    Ok(l.map(|x| x / norm))
}

fn vanishing(lines: &[GuideLine]) -> Result<[f64; 3], &'static str> {
    let v = cross(equation(lines[0])?, equation(lines[1])?);
    let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    if norm < 1e-6 {
        return Err("Draw the guides on two different edges.");
    }
    let normalized = v.map(|x| x / norm);
    // Roundoff must not author a keystone for an already-parallel pair.
    let z = if normalized[2].abs() < 1e-6 {
        0.0
    } else {
        normalized[2]
    };
    Ok([normalized[0], normalized[1], z])
}

/// Solve a pair of vertical/horizontal guides, or two pairs (vertical first).
/// Homogeneous vanishing points include parallel lines at infinity, so a
/// parallel pair levels the frame without inventing a keystone correction.
/// Endpoints are post-perspective/pre-crop. Existing geometry is undone before
/// solving; existing aspect, scale, offsets and crop are preserved by the caller.
pub fn solve_guides(
    lines: &[GuideLine],
    family: GuideFamily,
    aspect_ratio: f32,
    current: Perspective,
    crop_angle: f32,
) -> Result<GuidedCorrection, &'static str> {
    let expected = if family == GuideFamily::Both { 4 } else { 2 };
    if lines.len() != expected || !aspect_ratio.is_finite() || aspect_ratio <= 0.0 {
        return Err("Draw two guides per selected direction on a loaded image.");
    }
    if !crop_angle.is_finite() {
        return Err("Reset the invalid crop angle before drawing guides.");
    }
    let inverse = current
        .matrix(aspect_ratio)
        .inverse()
        .ok_or("Reset the singular geometry before drawing guides.")?;
    let lines = lines
        .iter()
        .map(|line| {
            equation(*line)?;
            let [x1, y1, x2, y2] = line.0;
            let a = inverse
                .project(x1, y1)
                .ok_or("Choose edges inside the image.")?;
            let b = inverse
                .project(x2, y2)
                .ok_or("Choose edges inside the image.")?;
            Ok(GuideLine([a.0, a.1, b.0, b.1]))
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    let a = vanishing(&lines[..2])?;
    let (kh, kv) = match family {
        GuideFamily::Both => {
            let b = vanishing(&lines[2..])?;
            let det = a[0] * b[1] - a[1] * b[0];
            if det.abs() < 1e-6 {
                return Err("Choose distinct vertical and horizontal edge pairs.");
            }
            (
                (a[1] * b[2] - a[2] * b[1]) / det,
                (a[2] * b[0] - a[0] * b[2]) / det,
            )
        }
        GuideFamily::Vertical if a[1].abs() >= 1e-6 => (0.0, -a[2] / a[1]),
        GuideFamily::Horizontal if a[0].abs() >= 1e-6 => (-a[2] / a[0], 0.0),
        _ => return Err("Choose edges running in the selected direction."),
    };
    let horizontal = (kh as f32 / KEYSTONE_MAX * 100.0).clamp(-100.0, 100.0);
    let vertical = (kv as f32 / KEYSTONE_MAX * 100.0).clamp(-100.0, 100.0);
    let p = Perspective {
        horizontal,
        vertical,
        ..Perspective::IDENTITY
    };
    let h = p.matrix(aspect_ratio);
    // Average unit directions so guide length and endpoint order cannot bias
    // the rotation. In the Both case the vertical pair is authoritative.
    let (sin, cos) = lines[..2]
        .iter()
        .map(|line| direction_angle(*line, h, aspect_ratio, family))
        .try_fold((0.0, 0.0), |(sin, cos), angle| {
            let angle = angle?;
            Ok::<_, &'static str>((sin + (2.0 * angle).sin(), cos + (2.0 * angle).cos()))
        })?;
    // Preserve Aspect and crop straighten. Find the direction that will become
    // the selected screen axis after that existing tail, then rotate towards it.
    let (crop_sin, crop_cos) = crop_angle.to_radians().sin_cos();
    let stretch = ASPECT_MAX_RATIO.powf(current.aspect / 100.0);
    let tail_angle = if family == GuideFamily::Horizontal {
        (-crop_sin * stretch).atan2(crop_cos / stretch)
    } else {
        -(crop_sin / stretch).atan2(crop_cos * stretch)
    };
    let rotation = (0.5 * sin.atan2(cos)).to_degrees() as f32 + tail_angle.to_degrees();
    Ok(GuidedCorrection {
        vertical,
        horizontal,
        rotate: rotation.clamp(-10.0, 10.0),
        limited: kh.abs() > f64::from(KEYSTONE_MAX)
            || kv.abs() > f64::from(KEYSTONE_MAX)
            || rotation.abs() > 10.0,
    })
}

fn direction_angle(
    line: GuideLine,
    h: Homography,
    ar: f32,
    family: GuideFamily,
) -> Result<f64, &'static str> {
    let [x1, y1, x2, y2] = line.0;
    let a = h
        .project(x1, y1)
        .ok_or("A guide crosses the projective horizon. Choose another edge.")?;
    let b = h
        .project(x2, y2)
        .ok_or("A guide crosses the projective horizon. Choose another edge.")?;
    let dx = f64::from((b.0 - a.0) * ar);
    let dy = f64::from(b.1 - a.1);
    Ok(if family == GuideFamily::Horizontal {
        -dy.atan2(dx)
    } else {
        dx.atan2(dy)
    })
}

#[cfg(test)]
#[path = "guided_tests.rs"]
mod tests;
