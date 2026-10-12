use super::*;

const DAYLIGHT: [f32; 3] = [0.5, 1.0, 0.7];
const SKY: [f32; 3] = [0.8, 1.0, 1.25];
const DEMOSAIC_DIP: f32 = 0.985;

fn green_to_known(p: [f32; 3]) -> f32 {
    p[1] / ((p[0] + p[2]) / 2.0)
}

/// Post-WB blue sky brightening toward the sun: G crosses its ceiling of 1.0
/// while R and B stay below theirs. Demosaic interpolation leaves every other
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
        DAYLIGHT,
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

const NEUTRAL: [f32; 3] = [1.0, 1.0, 1.0];
