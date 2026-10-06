//! #3941 research: exact shared mask union before ONE joint 2048 inference.
//! Partitioning only evaluates mask geometry; no model sees separate pieces.
use raw_core::{
    stages::removal_generation::{prepare, GenerationMaskRequest},
    types::{accepted_removal::NativeWindow, removal_mask::RemovalMask},
};

pub(super) const SIDE: u32 = 2048;
const HOLE_RADIUS: u32 = 8;
const FRINGE_RADIUS: f32 = 4.0;

pub(super) fn window(mask: &RemovalMask) -> Result<NativeWindow, String> {
    let bounds = expanded(mask, SIDE)?;
    let centered = |start: u32, extent: u32| {
        ((u64::from(start) * 2 + u64::from(extent)).saturating_sub(u64::from(SIDE)) / 2) as u32
    };
    let x = centered(bounds.x, bounds.width).min(mask.source_width - SIDE);
    let y = centered(bounds.y, bounds.height).min(mask.source_height - SIDE);
    Ok(NativeWindow {
        x,
        y,
        width: SIDE,
        height: SIDE,
    })
}

fn expanded(mask: &RemovalMask, side: u32) -> Result<NativeWindow, String> {
    mask.validate()?;
    if mask.source_width < side || mask.source_height < side || !mask.pixels.contains(&255) {
        return Err("large research requires a nonempty native research source context".into());
    }
    let left = mask.x.saturating_sub(HOLE_RADIUS);
    let top = mask.y.saturating_sub(HOLE_RADIUS);
    let right = (mask.x + mask.width)
        .saturating_add(HOLE_RADIUS)
        .min(mask.source_width);
    let bottom = (mask.y + mask.height)
        .saturating_add(HOLE_RADIUS)
        .min(mask.source_height);
    if right - left > side || bottom - top > side {
        return Err(
            "complete selection and expansion exceed native research research context".into(),
        );
    }
    Ok(NativeWindow {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    })
}

pub(super) fn planes(
    mask: &RemovalMask,
    protection: &RemovalMask,
    window: NativeWindow,
) -> Result<Vec<f32>, String> {
    mask.validate()?;
    protection.validate()?;
    window.validate(mask.source_width, mask.source_height)?;
    let side = window.width;
    if ![1536, 2048, 3072].contains(&side)
        || window.height != side
        || !window.contains(&expanded(mask, side)?)
        || (mask.source_width, mask.source_height)
            != (protection.source_width, protection.source_height)
    {
        return Err("large research window or protection source differs".into());
    }
    let count = (side * side) as usize;
    let mut values = vec![0.0_f32; count * 2];
    // Distance to a union is the minimum distance to its pieces. Binary holes
    // combine by OR and monotonic smoothstep coverage by maximum. Every piece
    // calls the unchanged production EDT, including protection and edge rules.
    let inner = 1024 - 2 * HOLE_RADIUS;
    for y in (0..mask.height).step_by(inner as usize) {
        for x in (0..mask.width).step_by(inner as usize) {
            let width = inner.min(mask.width - x);
            let height = inner.min(mask.height - y);
            let pixels = (y..y + height)
                .flat_map(|row| {
                    let start = (row * mask.width + x) as usize;
                    mask.pixels[start..start + width as usize].iter().copied()
                })
                .collect::<Vec<_>>();
            if !pixels.contains(&255) {
                continue;
            }
            let piece = RemovalMask {
                source_width: mask.source_width,
                source_height: mask.source_height,
                x: mask.x + x,
                y: mask.y + y,
                width,
                height,
                pixels,
            };
            let px = piece.x.saturating_sub(HOLE_RADIUS);
            let py = piece.y.saturating_sub(HOLE_RADIUS);
            let tile = NativeWindow {
                x: px,
                y: py,
                width: (piece.x + width)
                    .saturating_add(HOLE_RADIUS)
                    .min(mask.source_width)
                    - px,
                height: (piece.y + height)
                    .saturating_add(HOLE_RADIUS)
                    .min(mask.source_height)
                    - py,
            };
            let prepared = prepare(
                &GenerationMaskRequest {
                    schema: 1,
                    window: tile,
                    hole_radius: HOLE_RADIUS,
                    fringe_radius: FRINGE_RADIUS,
                },
                &piece,
                Some(protection),
            )?;
            for ty in 0..tile.height {
                for tx in 0..tile.width {
                    let sx = tile.x + tx;
                    let sy = tile.y + ty;
                    if sx < window.x
                        || sy < window.y
                        || sx >= window.x + side
                        || sy >= window.y + side
                    {
                        continue;
                    }
                    let from = (ty * tile.width + tx) as usize;
                    let to = ((sy - window.y) * side + sx - window.x) as usize;
                    values[to] = values[to].max(f32::from(prepared.hole[from]) / 255.0);
                    values[count + to] = values[count + to].max(prepared.coverage[from]);
                }
            }
        }
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line() -> RemovalMask {
        RemovalMask {
            source_width: 3000,
            source_height: 2500,
            x: 500,
            y: 1100,
            width: 1500,
            height: 1,
            pixels: vec![255; 1500],
        }
    }
    fn protected() -> RemovalMask {
        RemovalMask {
            source_width: 3000,
            source_height: 2500,
            x: 700,
            y: 1102,
            width: 1,
            height: 1,
            pixels: vec![255],
        }
    }
    #[test]
    fn joined_shared_masks_match_closed_form_across_partition_boundary() {
        let intent = line();
        let window = window(&intent).unwrap();
        let actual = planes(&intent, &protected(), window).unwrap();
        let count = (SIDE * SIDE) as usize;
        for y in 0..SIDE {
            for x in 0..SIDE {
                let sx = window.x + x;
                let sy = window.y + y;
                let dx = sx.abs_diff(sx.clamp(500, 1999));
                let dy = sy.abs_diff(1100);
                let squared = f64::from(dx).powi(2) + f64::from(dy).powi(2);
                let hole = squared <= 64.0 && (sx, sy) != (700, 1102);
                let t = (1.0 - squared.sqrt() / 4.0).clamp(0.0, 1.0);
                let coverage = if hole {
                    (t * t * (3.0 - 2.0 * t)) as f32
                } else {
                    0.0
                };
                let index = (y * SIDE + x) as usize;
                assert_eq!(actual[index], if hole { 1.0 } else { 0.0 });
                assert_eq!(actual[count + index].to_bits(), coverage.to_bits());
            }
        }
    }
    // #3941: the private resolution sweep keeps the original source window.
    #[test]
    fn research_extents_preserve_shared_mask_geometry() {
        for side in [1536, 3072] {
            let mask = RemovalMask {
                source_width: 4000,
                source_height: 4000,
                x: 100,
                y: 100,
                width: 1,
                height: 1,
                pixels: vec![255],
            };
            let protection = RemovalMask {
                pixels: vec![0],
                ..mask.clone()
            };
            let window = NativeWindow {
                x: 0,
                y: 0,
                width: side,
                height: side,
            };
            let values = planes(&mask, &protection, window).unwrap();
            let count = (side * side) as usize;
            assert_eq!(values.len(), count * 2);
            let at = (100 * side + 100) as usize;
            assert_eq!(values[at], 1.0);
            assert_eq!(values[count + at], 1.0);
            assert_eq!(values[at + 8], 1.0);
            assert_eq!(values[at + 9], 0.0);
            assert_eq!(values[count + at + 4], 0.0);
        }
    }

    #[test]
    fn complete_oversize_protection_overlap_and_wrong_sources_refuse() {
        let mut intent = line();
        intent.width = 2100;
        intent.pixels = vec![255; 2100];
        assert!(window(&intent).is_err());
        let intent = line();
        let window = window(&intent).unwrap();
        let mut protection = protected();
        protection.y = intent.y;
        assert!(planes(&intent, &protection, window).is_err());
        protection.source_width += 1;
        assert!(planes(&intent, &protection, window).is_err());
    }

    #[test]
    fn retained_context_translates_exact_masks_without_clipping_intent_or_expansion() {
        let intent = line();
        let original = window(&intent).unwrap();
        let retained = NativeWindow {
            x: original.x + 35,
            y: original.y - 21,
            ..original
        };
        let a = planes(&intent, &protected(), original).unwrap();
        let b = planes(&intent, &protected(), retained).unwrap();
        let count = (SIDE * SIDE) as usize;
        assert_eq!(
            a[..count].iter().sum::<f32>(),
            b[..count].iter().sum::<f32>()
        );
        for y in retained.y.max(original.y)..(retained.y + SIDE).min(original.y + SIDE) {
            for x in retained.x.max(original.x)..(retained.x + SIDE).min(original.x + SIDE) {
                let ai = ((y - original.y) * SIDE + x - original.x) as usize;
                let bi = ((y - retained.y) * SIDE + x - retained.x) as usize;
                assert_eq!(a[ai].to_bits(), b[bi].to_bits());
                assert_eq!(a[count + ai].to_bits(), b[count + bi].to_bits());
            }
        }
        let clipped = NativeWindow {
            x: intent.x,
            ..original
        };
        assert!(planes(&intent, &protected(), clipped).is_err());
        let wrong_extent = NativeWindow {
            width: 1024,
            ..original
        };
        assert!(planes(&intent, &protected(), wrong_extent).is_err());
        let outside_source = NativeWindow {
            x: 1000,
            ..original
        };
        assert!(planes(&intent, &protected(), outside_source).is_err());
    }
}
