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
            // A ceiling at the highest supported ratio leaves their variation
            // intact, while stopping the value blend's bright-side overshoot.
            let expected = truth[centre][1] * 0.54;
            assert!((collapsed.pixels[centre][t] - expected).abs() < 1e-6 * exposure);
            assert!(fallback.pixels[centre][t] > 2.0 * expected);
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
