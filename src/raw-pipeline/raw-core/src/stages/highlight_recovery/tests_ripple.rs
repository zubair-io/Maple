use super::*;

const PANO_01_NEUTRAL: [f32; 3] = [0.421_139_2, 1.0, 0.525_532_5];
const SKY: [f32; 3] = [1.2, 1.0, 1.6];
const DEMOSAIC_DIP: f32 = 0.985;

fn green_to_known(p: [f32; 3]) -> f32 {
    p[1] / ((p[0] + p[2]) / 2.0)
}

/// Post-WB sky brightening toward the sun, as pano_01 records it: G, the
/// lowest channel, crosses its ceiling of 1.0 while R and B stay below theirs. Demosaic interpolation leaves every other
/// clipped green site just under the ceiling, the pattern pano_01 shows.
fn sun_halo(size: usize) -> (Image, Vec<bool>) {
    let mut img = Image::new(size as u32, size as u32, ColorSpace::CameraNativeLinearRgb);
    let mut clipped = vec![false; size * size];
    let centre = (size as f32 - 1.0) / 2.0;
    for y in 0..size {
        for x in 0..size {
            let r = ((x as f32 - centre).hypot(y as f32 - centre) / centre).min(1.0);
            let level = 1.12 - 0.3 * r;
            let scene = SKY.map(|c| c * level);
            let blown = scene[1] >= 1.0;
            let green = match (blown, (x + y) % 2 == 1) {
                (false, _) => scene[1],
                (true, true) => DEMOSAIC_DIP,
                (true, false) => 1.0,
            };
            img.pixels[y * size + x] = [scene[0], green, scene[2]];
            clipped[y * size + x] = blown;
        }
    }
    (img, clipped)
}

#[test]
fn demosaic_ripple_beside_a_green_clip_keeps_the_sky_hue() {
    let (mut img, clipped) = sun_halo(96);
    apply(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        PANO_01_NEUTRAL,
        0.0,
    );
    let truth = green_to_known(SKY);
    let worst = img
        .pixels
        .iter()
        .zip(&clipped)
        .filter(|(_, blown)| **blown)
        .map(|(p, _)| (green_to_known(*p) / truth - 1.0).abs())
        .fold(0.0f32, f32::max);
    assert!(
        clipped.iter().filter(|b| **b).count() > 500,
        "fixture must hold a blown halo"
    );
    assert!(
        worst < 0.03,
        "clipped sky drifted off its hue: worst G/known error {worst}"
    );
}

#[test]
fn near_ceiling_pixel_without_a_clip_nearby_is_scene_evidence() {
    let mut img = Image::new(8, 1, ColorSpace::CameraNativeLinearRgb);
    img.pixels = vec![[0.5, 0.985, 0.6]; 8];
    img.pixels[7] = [0.5, 1.0, 0.6];
    let original = img.pixels.clone();
    apply(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        NEUTRAL,
        0.0,
    );
    assert_eq!(img.pixels[..5], original[..5]);
}

#[test]
fn near_ceiling_channel_above_another_stays_scene_evidence() {
    let mut img = Image::new(8, 1, ColorSpace::CameraNativeLinearRgb);
    img.pixels = vec![[0.985, 0.8, 0.4]; 8];
    img.pixels[7] = [1.0, 0.8, 0.4];
    let original = img.pixels.clone();
    apply(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        NEUTRAL,
        0.0,
    );
    assert_eq!(img.pixels[..7], original[..7]);
}

const NEUTRAL: [f32; 3] = [1.0, 1.0, 1.0];

#[test]
fn calibrated_mask_preserves_scalar_rules() {
    // Exhaust channel-order, clip and near-clip combinations, including
    // signed scene values and nonfinite input. The scalar oracle expresses
    // the pre-optimization mask rule without either fast-rejection branch.
    let values = [
        f32::NEG_INFINITY,
        -0.1,
        0.0,
        0.6,
        0.969,
        0.97,
        0.985,
        0.995,
        1.0,
        1.4,
        f32::INFINITY,
        f32::NAN,
    ];
    let mut img = Image::new(48, 36, ColorSpace::CameraNativeLinearRgb);
    img.pixels = values
        .iter()
        .flat_map(|&r| values.iter().flat_map(move |&g| values.map(|b| [r, g, b])))
        .collect();
    use crate::linearize::{
        gain_map_tests::{calibrated_raw, list, payload},
        GainMaps,
    };
    let mut raw = calibrated_raw(img.width, img.height);
    raw.sensor_gain_maps = GainMaps::parse(&list(&[(
        9,
        0,
        payload(
            [0; 4],
            [1; 2],
            [2; 2],
            [1.; 2],
            [0.; 2],
            &[0.7, 1.3, 1.8, 0.9],
        ),
    )]))
    .unwrap();
    for calibration in [None, SensorGains::for_raw(&raw, (0, 0), 1)] {
        let levels = |v, i: usize| {
            calibration.map_or(v, |g| {
                g.scale(v, i as u32 % img.width, i as u32 / img.width)
            })
        };
        for thresholds in [[0.995; 3], [0.8, 1.0, 1.3]] {
            let floors = thresholds.map(|v| v - 0.025);
            let hard: Vec<_> = img
                .pixels
                .iter()
                .enumerate()
                .map(|(i, p)| channels_at_or_above(p, levels(thresholds, i)))
                .collect();
            assert_eq!(
                mask::any_clipped(&img, thresholds, calibration),
                hard.iter().any(|&h| h != 0)
            );
            for (left, top, right, bottom) in [(0, 0, 48, 36), (3, 5, 43, 31), (8, 9, 8, 9)] {
                let expected: Vec<_> = img
                    .pixels
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        let h = hard[i];
                        let band =
                            channels_at_or_above(p, levels(floors, i)) & lowest_channels(p) & !h;
                        let (x, y) = (i as i32 % 48, i as i32 / 48);
                        if band == 0 || x < left || x >= right || y < top || y >= bottom {
                            return h;
                        }
                        let mut near = 0;
                        for ny in (y - 2).max(top)..(y + 3).min(bottom) {
                            for nx in (x - 2).max(left)..(x + 3).min(right) {
                                near |= hard[(ny * 48 + nx) as usize];
                            }
                        }
                        h | (band & near)
                    })
                    .collect();
                if calibration.is_none() {
                    assert_eq!(
                        clip_mask_with_ripple(&img, thresholds, floors, (left, top, right, bottom)),
                        expected
                    );
                }
                assert_eq!(
                    clip_mask_calibrated(
                        &img,
                        thresholds,
                        floors,
                        (left, top, right, bottom),
                        calibration
                    ),
                    expected
                );
            }
        }
    }
}
