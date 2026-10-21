//! #4660: stage C chooses each R/B site's direction weight from its
//! neighbours' stage-B weights, independent of raster order.
use super::*;
use crate::image::{ColorSpace, Image};

#[test]
fn diagonal_direction_weights_are_read_from_the_stage_b_snapshot() {
    for pattern in [CfaPattern::Rggb, CfaPattern::Grbg] {
        let mut s = Scratch::new();
        let t = Tile {
            top: 0,
            left: 0,
            rr1: 48,
            cc1: 48,
        };
        let weight = |i: usize| (i.wrapping_mul(2_654_435_761) % 1000) as f32 / 1000.0;
        for (i, w) in s.hvwt.iter_mut().enumerate() {
            *w = weight(i);
        }
        let before = s.hvwt.clone();
        reconstruct_green(&mut s, &t, pattern);
        let (p1, m1) = (-(TS as isize) + 1, TS as isize + 1);
        for rr in 8..t.rr1 - 8 {
            for cc in (rb_coset_start(pattern, rr, 8)..t.cc1 - 8).step_by(2) {
                let i = rr * TS + cc;
                let alt = 0.25
                    * (before[hf(i, -m1)]
                        + before[hf(i, p1)]
                        + before[hf(i, -p1)]
                        + before[hf(i, m1)]);
                let own = before[i >> 1];
                let expected = if (0.5 - own).abs() < (0.5 - alt).abs() {
                    alt
                } else {
                    own
                };
                assert_eq!(s.hvwt[i >> 1], expected, "{pattern:?} row {rr} col {cc}");
            }
        }
    }
}

/// A Bayer mosaic of fine stripes, two colour edges and hashed texture,
/// so stage B flags Nyquist areas and stage C's diagonal alternative is
/// taken at many sites.
fn textured_mosaic(w: u32, h: u32) -> Image {
    let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
    for y in 0..h {
        for x in 0..w {
            let stripes = if (x / 2 + y / 3) % 2 == 0 { 0.7 } else { 0.25 };
            let hash = (x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663)) % 1000;
            let scene = [
                stripes * if x > y { 1.0 } else { 0.4 },
                stripes,
                stripes * if x + y > 360 { 0.5 } else { 1.0 },
            ];
            let c = CfaPattern::Rggb.color_at(x, y) as usize;
            img.pixels[(y * w + x) as usize][c] = scene[c] * (0.9 + hash as f32 * 1e-4);
        }
    }
    img
}

/// #4660: a site's reconstruction depends only on its neighbourhood, not on
/// where the AMaZE tile grid started, so a crop demosaiced on its own
/// matches the full frame away from both borders, for every Bayer phase.
/// Both frames span several tiles, so the compared region crosses seams in
/// each grid at different offsets.
#[test]
fn reconstruction_is_independent_of_the_tile_grid_origin() {
    use crate::demosaic::amaze::amaze;
    let (w, h) = (400, 360);
    let full = textured_mosaic(w, h);
    let whole = amaze(&full, CfaPattern::Rggb);
    let (cw, ch, margin) = (300, 280, 32);
    for (x0, y0) in [(58, 46), (59, 46), (58, 47), (59, 47)] {
        let crop_cfa = [
            CfaPattern::Rggb,
            CfaPattern::Grbg,
            CfaPattern::Gbrg,
            CfaPattern::Bggr,
        ]
        .into_iter()
        .find(|p| {
            (0..2).all(|y| {
                (0..2).all(|x| p.color_at(x, y) == CfaPattern::Rggb.color_at(x + x0, y + y0))
            })
        })
        .unwrap();
        let mut crop = Image::new(cw, ch, ColorSpace::CameraNativeMosaic);
        for y in 0..ch {
            for x in 0..cw {
                crop.pixels[(y * cw + x) as usize] = full.pixels[((y + y0) * w + x + x0) as usize];
            }
        }
        let part = amaze(&crop, crop_cfa);
        for y in margin..ch - margin {
            for x in margin..cw - margin {
                assert_eq!(
                    part.pixels[(y * cw + x) as usize],
                    whole.pixels[((y + y0) * w + x + x0) as usize],
                    "offset ({x0},{y0}) site ({x},{y})"
                );
            }
        }
    }
}
