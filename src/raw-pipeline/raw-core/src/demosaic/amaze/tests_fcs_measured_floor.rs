//! Measured-target envelope witnesses for the unsupported-green FCS guard.

use super::*;

#[test]
fn unsupported_green_does_not_erase_the_value_estimate_of_a_chroma_line() {
    for pattern in PATTERNS {
        for centre_colour in [0, 2] {
            for exposure in [0.01_f32, 1.0, 16.0] {
                let i = (10..14)
                    .flat_map(|y| (10..14).map(move |x| y * SIDE + x))
                    .find(|&i| sampled(pattern, i) == centre_colour)
                    .unwrap();
                let target = 2 - centre_colour;
                let mut image =
                    Image::new(SIDE as u32, SIDE as u32, ColorSpace::CameraNativeLinearRgb);
                image.pixels.fill([0.07 * exposure; 3]);
                let mut green = vec![0.07 * exposure; SIDE * SIDE];
                let mut cfa = vec![0.07 * exposure; SIDE * SIDE];
                image.pixels[i][target] = 0.14 * exposure;
                for (offset, value) in [
                    (-1_isize, 0.06),
                    (1, 0.73),
                    (-(SIDE as isize), 0.06),
                    (SIDE as isize, 0.30),
                ] {
                    let n = (i as isize + offset) as usize;
                    green[n] = value * exposure;
                    cfa[n] = green[n];
                }
                for (dx, dy) in [(-1_isize, -1_isize), (1, -1), (-1, 1), (1, 1)] {
                    cfa[(i as isize + dy * SIDE as isize + dx) as usize] = 0.4 * exposure;
                }
                let before = image.pixels[i];
                fcs::suppress_false_colour(
                    &mut image,
                    &cfa,
                    &green,
                    SIDE,
                    SIDE,
                    pattern,
                    fcs::FALSE_COLOUR_SUPPRESS_STRENGTH,
                );
                assert!((image.pixels[i][target] - 0.4 * exposure).abs() < 1e-6 * exposure,
                    "{pattern:?} colour={centre_colour} exposure={exposure}: uncertain green must not suppress the measured chroma-line estimate");
                assert_eq!(image.pixels[i][centre_colour], before[centre_colour]);
                assert_eq!(image.pixels[i][1], before[1]);
            }
        }
    }
}

#[test]
fn unsupported_green_keeps_positive_chroma_inside_the_measured_envelope() {
    for pattern in PATTERNS {
        for centre_colour in [0, 2] {
            for exposure in [0.01_f32, 1.0, 16.0] {
                let i = (10..14)
                    .flat_map(|y| (10..14).map(move |x| y * SIDE + x))
                    .find(|&i| sampled(pattern, i) == centre_colour)
                    .unwrap();
                let target = 2 - centre_colour;
                let mut image =
                    Image::new(SIDE as u32, SIDE as u32, ColorSpace::CameraNativeLinearRgb);
                image.pixels.fill([0.07 * exposure; 3]);
                let mut green = vec![0.07 * exposure; SIDE * SIDE];
                let mut cfa = vec![0.07 * exposure; SIDE * SIDE];
                image.pixels[i][target] = 0.2 * exposure;
                for (offset, value) in [
                    (-1_isize, 0.06),
                    (1, 0.73),
                    (-(SIDE as isize), 0.06),
                    (SIDE as isize, 0.30),
                ] {
                    let n = (i as isize + offset) as usize;
                    green[n] = value * exposure;
                    cfa[n] = green[n];
                }
                for ((dx, dy), value) in [(-1_isize, -1_isize), (1, -1), (-1, 1), (1, 1)]
                    .into_iter()
                    .zip([0.1, 0.3, 0.5, 0.7])
                {
                    cfa[(i as isize + dy * SIDE as isize + dx) as usize] = value * exposure;
                }
                let before = image.pixels[i];
                fcs::suppress_false_colour(
                    &mut image,
                    &cfa,
                    &green,
                    SIDE,
                    SIDE,
                    pattern,
                    fcs::FALSE_COLOUR_SUPPRESS_STRENGTH,
                );
                assert_eq!(image.pixels[i], before,
                    "{pattern:?} colour={centre_colour} exposure={exposure}: the bright donor mean must not replace an in-envelope positive kernel estimate");
            }
        }
    }
}
