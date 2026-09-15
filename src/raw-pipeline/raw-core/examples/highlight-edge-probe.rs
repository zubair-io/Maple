//! Numeric saturated-edge attribution for #3633; not a reference-image gate.
//! Run with `cargo run --release -p raw-core --example highlight-edge-probe`.
use raw_core::{
    demosaic::amaze,
    image::{CfaPattern, ColorSpace, Image},
    stages::highlight_recovery,
    xmp::HighlightRecoveryMode,
};

fn main() {
    let side = 64u32;
    let chroma = [0.5f32, 1.2, 0.65];
    for cfa in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        for direction in 0..3 {
            for phase in 0..2 {
                let mut mosaic = Image::new(side, side, ColorSpace::CameraNativeMosaic);
                let truth: Vec<[f32; 3]> = (0..side * side)
                    .map(|i| {
                        let (x, y) = ((i % side) as i32, (i / side) as i32);
                        let distance = match direction {
                            0 => x - 32 - phase,
                            1 => y - 32 - phase,
                            _ => x - y - phase,
                        };
                        let intensity = if (0..2).contains(&distance) { 1.0 } else { 0.1 };
                        chroma.map(|v| v * intensity)
                    })
                    .collect();
                for (i, pixel) in mosaic.pixels.iter_mut().enumerate() {
                    let c = cfa.color_at(i as u32 % side, i as u32 / side) as usize;
                    pixel[c] = truth[i][c].min(1.0);
                }
                let mut rgb = amaze(&mosaic, cfa);
                let before = rgb.pixels.clone();
                highlight_recovery::apply(
                    &mut rgb,
                    HighlightRecoveryMode::ChromaticAdaptation,
                    [1.0; 3],
                    0.0,
                );
                let mut witness_error = 0.0f32;
                let mut measured_clips = 0usize;
                let mut below_sensor_bound = 0usize;
                for y in 8..side - 8 {
                    for x in 8..side - 8 {
                        let i = (y * side + x) as usize;
                        let p = before[i];
                        if p.iter().all(|v| *v < 0.995) && p[1] > 1e-4 {
                            witness_error = witness_error
                                .max((p[0] / p[1] - chroma[0] / chroma[1]).abs())
                                .max((p[2] / p[1] - chroma[2] / chroma[1]).abs());
                        }
                        let c = cfa.color_at(x, y) as usize;
                        if truth[i][c] >= 1.0 {
                            measured_clips += 1;
                            below_sensor_bound += usize::from(rgb.pixels[i][c] < 1.0 - 1e-5);
                        }
                    }
                }
                println!("cfa={cfa:?} direction={direction} phase={phase} witness_ratio_error={witness_error:.6} measured_clips={measured_clips} reconstructed_below_sensor_bound={below_sensor_bound}");
            }
        }
    }
}
