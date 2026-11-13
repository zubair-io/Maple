//! Arc-length prompt sampling with ordered add/erase semantics (#3942).
use super::removal_smart::{SmartMaskRequest, SmartPrompt};
use crate::types::removal_mask::RemovalStroke;

fn native(p: [f32; 2], w: u32, h: u32) -> [f64; 2] {
    [
        f64::from(p[0]) * f64::from(w),
        f64::from(p[1]) * f64::from(h),
    ]
}

fn distance(a: [f64; 2], b: [f64; 2]) -> f64 {
    // Coordinates are bounded u32 source pixels; squared f64 length cannot
    // overflow. Explicit IEEE sqrt avoids platform libc hypot differences.
    let (dx, dy) = (a[0] - b[0], a[1] - b[1]);
    (dx * dx + dy * dy).sqrt()
}

pub(super) fn prepare(mut request: SmartMaskRequest) -> Result<SmartMaskRequest, String> {
    request
        .window
        .validate(request.source_width, request.source_height)?;
    if request.schema != 1
        || !request.prompts.is_empty()
        || request.strokes.is_empty()
        || request.strokes.len() > 64
    {
        return Err("smart selection: stroke preparation requires schema-1 gestures without precomputed prompts".into());
    }
    let (w, h) = (request.source_width, request.source_height);
    for stroke in &request.strokes {
        stroke.validate()?;
    }
    let lengths: Vec<_> = request
        .strokes
        .iter()
        .map(|s| {
            s.points
                .windows(2)
                .map(|p| distance(native(p[0], w, h), native(p[1], w, h)))
                .sum::<f64>()
        })
        .collect();
    let minimum: Vec<_> = lengths
        .iter()
        .map(|len| if *len == 0.0 { 1 } else { 2 })
        .collect();
    let required: usize = minimum.iter().sum();
    if required > 64 {
        return Err("smart selection: too many gesture endpoints; apply this selection before adding more gestures".into());
    }
    let extra: Vec<_> = request
        .strokes
        .iter()
        .zip(&lengths)
        .zip(&minimum)
        .map(|((s, len), min)| {
            let desired = ((*len / (2.0 * f64::from(s.radius) * f64::from(w)).max(1.0)).ceil()
                as usize)
                .saturating_add(1)
                .min(64);
            desired.saturating_sub(*min)
        })
        .collect();
    let wanted: usize = extra.iter().sum();
    let available = (64 - required).min(wanted);
    let mut counts = minimum.clone();
    if wanted > 0 {
        for i in 0..counts.len() {
            counts[i] += extra[i] * available / wanted;
        }
        let mut order: Vec<_> = (0..counts.len()).collect();
        order.sort_by_key(|i| std::cmp::Reverse(extra[*i] * available % wanted));
        let remaining = required + available - counts.iter().sum::<usize>();
        for i in order.into_iter().take(remaining) {
            counts[i] += 1;
        }
    }
    let mut prompts = Vec::with_capacity(64);
    for (i, stroke) in request.strokes.iter().enumerate() {
        let samples = sample(stroke, w, h, lengths[i], counts[i]);
        for point in samples {
            if request.strokes[i + 1..]
                .iter()
                .any(|later| super::removal_selection::covers_point(w, h, later, point))
            {
                continue;
            }
            let world = [point[0] * f64::from(w), point[1] * f64::from(h)];
            let window = request.window;
            if world[0] < f64::from(window.x)
                || world[0] > f64::from(window.x + window.width)
                || world[1] < f64::from(window.y)
                || world[1] > f64::from(window.y + window.height)
            {
                return Err("smart selection: gesture outside model context".into());
            }
            let position = [
                world[0].clamp(
                    f64::from(window.x) + 0.5,
                    f64::from(window.x + window.width) - 0.5,
                ) / f64::from(w),
                world[1].clamp(
                    f64::from(window.y) + 0.5,
                    f64::from(window.y + window.height) - 0.5,
                ) / f64::from(h),
            ];
            prompts.push(SmartPrompt {
                position,
                label: if stroke.subtract { 0 } else { 1 },
            });
        }
    }
    if !prompts.iter().any(|p| p.label == 1) {
        return Err(
            "smart selection: no remaining positive intent; clear or add to the selection".into(),
        );
    }
    request.prompts = prompts;
    Ok(request)
}

fn sample(stroke: &RemovalStroke, w: u32, h: u32, length: f64, count: usize) -> Vec<[f64; 2]> {
    if count == 1 || length == 0.0 {
        return vec![[
            f64::from(stroke.points[0][0]),
            f64::from(stroke.points[0][1]),
        ]];
    }
    let mut segment = 0;
    let mut traversed = 0.0;
    (0..count)
        .map(|index| {
            let target = length * index as f64 / (count - 1) as f64;
            loop {
                let a = native(stroke.points[segment], w, h);
                let b = native(stroke.points[segment + 1], w, h);
                let len = distance(a, b);
                if target <= traversed + len || segment + 2 == stroke.points.len() {
                    let t = if len == 0.0 {
                        0.0
                    } else {
                        ((target - traversed) / len).clamp(0.0, 1.0)
                    };
                    return [
                        (a[0] + (b[0] - a[0]) * t) / f64::from(w),
                        (a[1] + (b[1] - a[1]) * t) / f64::from(h),
                    ];
                }
                traversed += len;
                segment += 1;
            }
        })
        .collect()
}

#[cfg(test)]
#[path = "removal_smart_strokes_tests.rs"]
mod tests;
