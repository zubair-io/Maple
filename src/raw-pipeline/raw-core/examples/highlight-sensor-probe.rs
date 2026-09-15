//! CFA-aligned, sensor-support attribution for test_0000 under #3633.
//! `cargo run --release -p raw-core --example highlight-sensor-probe -- RAW`
//! Counterfactual only: AMaZE's fixed clipping branches are not qualified for
//! unbounded reconstructed mosaic samples, and no production path uses this.
use raw_core::{
    decode,
    demosaic::amaze,
    linearize,
    stages::{highlight_recovery, white_balance},
    xmp::HighlightRecoveryMode,
};

fn main() {
    let path = std::env::args().nth(1).expect("test_0000 RAW path");
    let raw = decode::decode(std::path::Path::new(&path)).expect("decode");
    let (left, top, side) = (8544u32, 960u32, 128u32);
    let mosaic = linearize::sensor_linearize_region(&raw, left, top, side, side);
    let baseline = amaze(&mosaic, raw.cfa);
    let gain = raw.baseline_exposure.exp2();
    let mut camera = baseline.clone();
    for p in &mut camera.pixels {
        *p = p.map(|v| v * gain);
    }
    white_balance::apply_pre_gain(&mut camera, raw.as_shot_neutral);
    highlight_recovery::apply(
        &mut camera,
        HighlightRecoveryMode::ChromaticAdaptation,
        raw.as_shot_neutral,
        raw.baseline_exposure,
    );
    let index = |x: u32, y: u32| ((y - top) * side + x - left) as usize;
    let seed = index(8612, 1045);
    let estimate = camera.pixels[seed][1] / gain;
    println!(
        "crop origin={left},{top} gain={gain} seedG={} recovered_seedG={estimate}",
        mosaic.pixels[seed][1]
    );
    for delta in [0.001, estimate - mosaic.pixels[seed][1]] {
        let mut changed = mosaic.clone();
        changed.pixels[seed][1] += delta;
        let rendered = amaze(&changed, raw.cfa);
        for (x, y) in [(8612, 1045), (8614, 1046), (8611, 1045)] {
            let i = index(x, y);
            println!(
                "delta={delta:.8} sensor={x},{y} before={:?} after={:?}",
                baseline.pixels[i], rendered.pixels[i]
            );
        }
        let changed_known = (0..side * side)
            .filter(|i| {
                let c = raw.cfa.color_at(i % side + left, i / side + top) as usize;
                let i = *i as usize;
                mosaic.pixels[i][c] < 1.0 && rendered.pixels[i][c] != mosaic.pixels[i][c]
            })
            .count();
        println!("changed_measured_unclipped={changed_known}");
    }
}
