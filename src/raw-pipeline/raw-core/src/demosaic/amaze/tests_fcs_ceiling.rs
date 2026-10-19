//! The fallback must not import bright-side sensor values across a textured
//! luminance edge when a single constant hue cannot be established.

use super::*;

#[test]
fn collapsed_chroma_bounds_value_overshoot_on_a_varying_surface() {
    for pattern in PATTERNS {
        for exposure in [0.01_f32, 1.0, 16.0] {
            let centre = (10..14)
                .flat_map(|y| (10..14).map(move |x| y * SIDE + x))
                .find(|&i| sampled(pattern, i) != 1)
                .unwrap();
            let (cx, cy) = (centre % SIDE, centre / SIDE);
            let c = sampled(pattern, centre);
            let t = 2 - c;
            let truth: Vec<[f32; 3]> = (0..SIDE * SIDE)
                .map(|i| {
                    let (x, y) = (i % SIDE, i / SIDE);
                    let level = if x < cx { 0.75 } else { 0.045 } * exposure;
                    let ratio = 0.5 + 0.04 * (y as f32 - cy as f32);
                    let mut pixel = [level; 3];
                    pixel[c] = ratio * level;
                    pixel[t] = (1.0 - ratio) * level;
                    pixel
                })
                .collect();
            let collapsed = suppress(pattern, &truth, |i| i == centre, -0.5);
            let fallback = suppress(pattern, &truth, |i| i == centre, 0.0);
            // Same-colour ratios span 0.42..0.58 (>15%), rejecting the
            // constant-hue branch. The opposite-colour donors span 0.46..0.54.
            // Green-guided interpolation now follows the dark-side donors
            // directly. The ceiling must stay inactive on that valid estimate,
            // including the zero fallback; neither should import bright values.
            let expected = truth[centre][t];
            assert!((collapsed.pixels[centre][t] - expected).abs() < 1e-6 * exposure);
            assert!((fallback.pixels[centre][t] - expected).abs() < 1e-6 * exposure);
            for (i, actual) in collapsed.pixels.iter().enumerate() {
                if i != centre {
                    assert_eq!(*actual, fallback.pixels[i]);
                }
                assert_eq!(actual[sampled(pattern, i)], truth[i][sampled(pattern, i)]);
                assert_eq!(actual[1], truth[i][1]);
            }
        }
    }
}

#[test]
fn collapsed_chroma_keeps_fallback_without_interpolated_surface_support() {
    for pattern in PATTERNS {
        let centre = (10..14)
            .flat_map(|y| (10..14).map(move |x| y * SIDE + x))
            .find(|&i| sampled(pattern, i) != 1)
            .unwrap();
        let (cx, cy) = (centre % SIDE, centre / SIDE);
        let c = sampled(pattern, centre);
        let t = 2 - c;
        // An interior ratio can still belong to another colour surface;
        // endpoint ratios can represent a plateau despite agreeing with the
        // mean. Neither supplies an interpolated centre for the ceiling.
        for (centre_ratio, surface_ratios) in [
            (0.9, [0.1, 1.0, 0.2, 0.3]),
            (0.5, [0.5, 0.5, 0.5, 0.55]),
            (0.5, [0.45, 0.5, 0.5, 0.5]),
        ] {
            let mut truth: Vec<[f32; 3]> = (0..SIDE * SIDE)
                .map(|i| {
                    let (x, y) = (i % SIDE, i / SIDE);
                    let level = if x < cx { 0.75 } else { 0.045 };
                    let mut pixel = [level; 3];
                    pixel[c] = 0.5 * level;
                    pixel[t] = if y < cy { 0.4 } else { 0.6 } * level;
                    pixel
                })
                .collect();
            truth[centre][c] = centre_ratio * truth[centre][1];
            for ((dx, dy), ratio) in [(-2_isize, -2_isize), (2, -2), (-2, 2), (2, 2)]
                .into_iter()
                .zip(surface_ratios)
            {
                let i = (centre as isize + dy * SIDE as isize + dx) as usize;
                truth[i][c] = ratio * truth[i][1];
            }
            let collapsed = suppress(pattern, &truth, |i| i == centre, -0.5);
            let fallback = suppress(pattern, &truth, |i| i == centre, 0.0);
            // No supported surface fit: retain the guided value fallback,
            // bounded by the dark side's actual 0.4..0.6 donor ratios.
            let level = truth[centre][1];
            assert!(fallback.pixels[centre][t] >= 0.4 * level - 1e-6);
            assert!(fallback.pixels[centre][t] <= 0.6 * level + 1e-6);
            assert_eq!(collapsed.pixels, fallback.pixels);
        }
    }
}
