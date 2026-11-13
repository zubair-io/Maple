use super::*;
use crate::prng::SplitMix64;

fn largest(mask: &[Vec<bool>], axes: CropAxes) -> Option<CropRect> {
    let mut search = LargestRect::new(mask[0].len() as u32, axes);
    mask.iter().for_each(|row| search.push_row(row));
    search.finish()
}

fn all_covered(mask: &[Vec<bool>], r: CropRect) -> bool {
    (r.y..r.y + r.height).all(|y| (r.x..r.x + r.width).all(|x| mask[y as usize][x as usize]))
}

/// The largest all-covered area by trying every rectangle.
fn brute_force_area(mask: &[Vec<bool>], axes: CropAxes) -> u64 {
    let (h, w) = (mask.len() as u32, mask[0].len() as u32);
    let mut best = 0;
    for y0 in 0..h {
        for y1 in y0 + 1..=h {
            for x0 in 0..w {
                for x1 in x0 + 1..=w {
                    let pinned = match axes {
                        CropAxes::Both => false,
                        CropAxes::FullWidth => (x0, x1) != (0, w),
                        CropAxes::FullHeight => (y0, y1) != (0, h),
                    };
                    if pinned {
                        continue;
                    }
                    let r = CropRect {
                        x: x0,
                        y: y0,
                        width: x1 - x0,
                        height: y1 - y0,
                    };
                    if all_covered(mask, r) {
                        best = best.max(r.area());
                    }
                }
            }
        }
    }
    best
}

fn random_mask(rng: &mut SplitMix64, w: usize, h: usize, density: f64) -> Vec<Vec<bool>> {
    (0..h)
        .map(|_| (0..w).map(|_| rng.next_range(0.0, 1.0) < density).collect())
        .collect()
}

#[test]
fn the_search_finds_the_largest_covered_rectangle() {
    let mut rng = SplitMix64::new(5573);
    for case in 0..300 {
        let (w, h) = (1 + case % 9, 1 + (case / 9) % 8);
        let mask = random_mask(&mut rng, w, h, [0.5, 0.8, 0.95][case % 3]);
        for axes in [CropAxes::Both, CropAxes::FullWidth, CropAxes::FullHeight] {
            let found = largest(&mask, axes);
            let ctx = format!("case {case} {axes:?} {mask:?}");
            assert_eq!(
                found.map_or(0, |r| r.area()),
                brute_force_area(&mask, axes),
                "{ctx}"
            );
            if let Some(r) = found {
                assert!(all_covered(&mask, r), "{ctx}: {r:?}");
                match axes {
                    CropAxes::Both => {}
                    CropAxes::FullWidth => assert_eq!((r.x, r.width), (0, w as u32), "{ctx}"),
                    CropAxes::FullHeight => assert_eq!((r.y, r.height), (0, h as u32), "{ctx}"),
                }
            }
        }
    }
}

#[test]
fn an_empty_mask_has_no_rectangle_and_a_full_one_is_kept_whole() {
    assert_eq!(largest(&vec![vec![false; 4]; 3], CropAxes::Both), None);
    let whole = CropRect {
        x: 0,
        y: 0,
        width: 4,
        height: 3,
    };
    let full = vec![vec![true; 4]; 3];
    for axes in [CropAxes::Both, CropAxes::FullWidth, CropAxes::FullHeight] {
        assert_eq!(largest(&full, axes), Some(whole), "{axes:?}");
    }
}

#[test]
fn a_wrapping_canvas_keeps_its_whole_periodic_axis() {
    let mask = vec![
        vec![true, true, false, true],
        vec![true, true, true, true],
        vec![true, true, true, true],
        vec![true, false, true, true],
    ];
    let expected = CropRect {
        x: 0,
        y: 1,
        width: 4,
        height: 2,
    };
    assert_eq!(largest(&mask, CropAxes::FullWidth), Some(expected));
    let columns = vec![
        vec![false, true, true, true],
        vec![true, false, true, true],
        vec![true, true, true, true],
    ];
    let expected = CropRect {
        x: 2,
        y: 0,
        width: 2,
        height: 3,
    };
    assert_eq!(largest(&columns, CropAxes::FullHeight), Some(expected));
}
