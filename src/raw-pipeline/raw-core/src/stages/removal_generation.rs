//! Separate native reconstruction and blend masks (#3943). Preparation runs
//! once before inference, never in the live grading loop. Expansion and fringe
//! widths are explicit qualification inputs, not chosen shipping defaults.

use crate::types::accepted_removal::NativeWindow;
use crate::types::removal_mask::RemovalMask;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenerationMaskRequest {
    pub schema: u32,
    pub window: NativeWindow,
    /// Euclidean expansion of intent, in native source pixels.
    pub hole_radius: u32,
    /// Exterior smoothstep blend width. The intent interior stays opaque.
    pub fringe_radius: f32,
}

#[derive(Debug)]
pub struct GenerationMasks {
    pub window: NativeWindow,
    /// Row-major binary hole: 255 means reconstruct, 0 means known context.
    pub hole: Vec<u8>,
    /// Row-major blend coverage, 1 throughout intent and 0 on protection.
    pub coverage: Vec<f32>,
}

fn selected(mask: &RemovalMask, x: u32, y: u32) -> bool {
    x >= mask.x
        && y >= mask.y
        && x - mask.x < mask.width
        && y - mask.y < mask.height
        && mask.pixels[(y - mask.y) as usize * mask.width as usize + (x - mask.x) as usize] == 255
}

pub fn prepare(
    request: &GenerationMaskRequest,
    intent: &RemovalMask,
    protected: Option<&RemovalMask>,
) -> Result<GenerationMasks, String> {
    intent.validate()?;
    let window = request.window;
    window.validate(intent.source_width, intent.source_height)?;
    // The model remains fixed at 1024²; native contexts can be 2048² so the
    // authoring path can preserve source detail for guided native transfer.
    if request.schema != 1
        || window.width > 2048
        || window.height > 2048
        || !request.fringe_radius.is_finite()
        || request.fringe_radius < 0.0
        || f64::from(request.fringe_radius) > f64::from(request.hole_radius)
    {
        return Err("generation masks: invalid schema, native context or fringe width".into());
    }
    if intent.x < window.x
        || intent.y < window.y
        || intent.x + intent.width > window.x + window.width
        || intent.y + intent.height > window.y + window.height
    {
        return Err("generation masks: context must contain the complete intent window".into());
    }
    if let Some(protected) = protected {
        protected.validate()?;
        if (protected.source_width, protected.source_height)
            != (intent.source_width, intent.source_height)
        {
            return Err("generation masks: protected source geometry differs".into());
        }
    }
    let (w, h) = (window.width as usize, window.height as usize);
    let mut distances = vec![f64::INFINITY; w * h];
    let mut bounds = [intent.source_width, intent.source_height, 0, 0];
    for y in 0..h {
        for x in 0..w {
            let (sx, sy) = (window.x + x as u32, window.y + y as u32);
            if selected(intent, sx, sy) {
                if protected.is_some_and(|mask| selected(mask, sx, sy)) {
                    return Err(
                        "generation masks: intent overlaps protected pixels; edit the selection"
                            .into(),
                    );
                }
                distances[y * w + x] = 0.0;
                bounds = [
                    bounds[0].min(sx),
                    bounds[1].min(sy),
                    bounds[2].max(sx + 1),
                    bounds[3].max(sy + 1),
                ];
            }
        }
    }
    if distances.iter().all(|v| v.is_infinite()) {
        return Err("generation masks: empty selection".into());
    }
    let radius = request.hole_radius;
    if bounds[0].saturating_sub(radius) < window.x
        || bounds[1].saturating_sub(radius) < window.y
        || bounds[2].saturating_add(radius).min(intent.source_width) > window.x + window.width
        || bounds[3].saturating_add(radius).min(intent.source_height) > window.y + window.height
    {
        return Err("generation masks: context truncates the reconstruction expansion".into());
    }
    // Exact separable squared Euclidean distance. Both passes allocate only
    // context/scanline storage, even when the source is a 100MP RAW.
    for row in distances.chunks_exact_mut(w) {
        let transformed = distance_line(row);
        row.copy_from_slice(&transformed);
    }
    let mut column = vec![0.0; h];
    for x in 0..w {
        for y in 0..h {
            column[y] = distances[y * w + x];
        }
        let transformed = distance_line(&column);
        for y in 0..h {
            distances[y * w + x] = transformed[y];
        }
    }
    let radius_squared = f64::from(request.hole_radius).powi(2);
    let mut hole = Vec::with_capacity(w * h);
    let mut coverage = Vec::with_capacity(w * h);
    for (index, squared) in distances.into_iter().enumerate() {
        let protected = protected.is_some_and(|mask| {
            selected(
                mask,
                window.x + (index % w) as u32,
                window.y + (index / w) as u32,
            )
        });
        let reconstruct = !protected && squared <= radius_squared;
        hole.push(if reconstruct { 255 } else { 0 });
        let alpha = if !reconstruct {
            0.0
        } else if squared == 0.0 {
            1.0
        } else if request.fringe_radius == 0.0 {
            0.0
        } else {
            let t = (1.0 - squared.sqrt() / f64::from(request.fringe_radius)).clamp(0.0, 1.0);
            (t * t * (3.0 - 2.0 * t)) as f32
        };
        coverage.push(alpha);
    }
    Ok(GenerationMasks {
        window,
        hole,
        coverage,
    })
}

/// Host boundary: two contiguous row-major f32 planes, hole (0/1) then
/// coverage (0..1), both at the request's exact native window dimensions.
pub fn prepare_json(request: &str, intent: &[u8], protected: &[u8]) -> Result<Vec<f32>, String> {
    let request: GenerationMaskRequest = serde_json::from_str(request)
        .map_err(|e| format!("generation masks: invalid request: {e}"))?;
    let intent = crate::pipeline::removal_mask_from_bytes(intent)?;
    let protected = if protected.is_empty() {
        None
    } else {
        Some(crate::pipeline::removal_mask_from_bytes(protected)?)
    };
    let masks = prepare(&request, &intent, protected.as_ref())?;
    Ok(masks
        .hole
        .iter()
        .map(|v| f32::from(*v) / 255.0)
        .chain(masks.coverage)
        .collect())
}

// Lower envelope of parabolas f[q] + (x-q)^2. Infinite sites are omitted,
// so a row without intent stays infinite until the vertical pass.
fn distance_line(input: &[f64]) -> Vec<f64> {
    let sites: Vec<usize> = input
        .iter()
        .enumerate()
        .filter_map(|(i, v)| v.is_finite().then_some(i))
        .collect();
    if sites.is_empty() {
        return vec![f64::INFINITY; input.len()];
    }
    let mut vertices = vec![sites[0]];
    let mut boundaries = vec![f64::NEG_INFINITY];
    for q in sites.into_iter().skip(1) {
        let intersection = loop {
            let p = *vertices.last().unwrap();
            let s = ((input[q] + (q * q) as f64) - (input[p] + (p * p) as f64))
                / (2.0 * (q - p) as f64);
            if s > *boundaries.last().unwrap() {
                break s;
            }
            vertices.pop();
            boundaries.pop();
        };
        vertices.push(q);
        boundaries.push(intersection);
    }
    let mut k = 0;
    (0..input.len())
        .map(|x| {
            while k + 1 < vertices.len() && boundaries[k + 1] < x as f64 {
                k += 1;
            }
            let delta = x as f64 - vertices[k] as f64;
            input[vertices[k]] + delta * delta
        })
        .collect()
}

#[cfg(test)]
#[path = "removal_generation_tests.rs"]
mod tests;
