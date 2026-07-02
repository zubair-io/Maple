//! Diagnostic: dump scene-linear Rec.2020 stats from the DCP output of each
//! baseline fixture. Used to distinguish H1 (missing BaselineExposure) from
//! H2 (diffuse-white scaling bug) during the uniform-luma-gap investigation.
//!
//! Runs the pipeline up to (but NOT including) the tone-control / AgX
//! stages — we want to see the RAW scene-referred value. If a known-neutral
//! region reads near 0.18, scaling is right. If it reads near 0.04-0.05,
//! H2 is the bug.
//!
//! Usage:  cargo run -p raw-core --example dump_scene_linear -- <raw_path>

use raw_core::color::dcp;
use raw_core::{decode, demosaic, linearize};
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path: PathBuf = std::env::args().nth(1).expect("raw path arg").into();
    let raw = decode::decode(&path)?;

    println!("=== {} ===", path.display());
    println!("dimensions: {}×{}", raw.width, raw.height);
    println!("white_level: {}", raw.white_level);
    println!("black_level: {:?}", raw.black_level);
    println!("as_shot_neutral: {:?}", raw.as_shot_neutral);
    println!("camera: {} {}", raw.camera_make, raw.camera_model);
    println!("orientation: {:?}", raw.orientation);
    println!(
        "calibration illuminants: {:?}",
        raw.color_matrices.keys().collect::<Vec<_>>()
    );
    println!("baseline_exposure: {:+.3} EV", raw.baseline_exposure);

    // Run linearize → demosaic → BaselineExposure → DCP.
    let mosaic = linearize::sensor_linearize(&raw);
    let mut camera_rgb = demosaic::bilinear(&mosaic, raw.cfa);
    if raw.baseline_exposure.abs() > 1e-4 {
        let be = raw.baseline_exposure.exp2();
        for p in &mut camera_rgb.pixels {
            p[0] *= be;
            p[1] *= be;
            p[2] *= be;
        }
    }
    let profile = dcp::profile_for(&raw)?;
    let scene = dcp::apply(&camera_rgb, &profile)?;

    println!("scene_cct: {:.0} K", profile.scene_cct);

    // Stats on the post-DCP scene-linear Rec.2020 buffer.
    let mut r_sum = 0.0f64;
    let mut g_sum = 0.0f64;
    let mut b_sum = 0.0f64;
    let mut luma_sum = 0.0f64;
    let mut mins = [f32::INFINITY; 3];
    let mut maxs = [f32::NEG_INFINITY; 3];
    let mut hist = [0usize; 10]; // 0..0.05, 0.05..0.10, ..., ≥0.45
    let n = scene.pixels.len() as f64;
    for p in &scene.pixels {
        r_sum += p[0] as f64;
        g_sum += p[1] as f64;
        b_sum += p[2] as f64;
        let luma = 0.2627 * p[0] as f64 + 0.6780 * p[1] as f64 + 0.0593 * p[2] as f64;
        luma_sum += luma;
        for c in 0..3 {
            mins[c] = mins[c].min(p[c]);
            maxs[c] = maxs[c].max(p[c]);
        }
        // Histogram the luminance into 0.05-wide bins up to 0.5, then saturate.
        let bin = ((luma * 20.0).floor() as usize).min(9);
        hist[bin] += 1;
    }

    println!(
        "scene-linear Rec.2020 mean: R={:.4}, G={:.4}, B={:.4}, luma={:.4}",
        r_sum / n,
        g_sum / n,
        b_sum / n,
        luma_sum / n
    );
    println!("scene-linear Rec.2020 min: {:?}", mins);
    println!("scene-linear Rec.2020 max: {:?}", maxs);
    println!("luma histogram (bins 0.05 wide, last bin = saturate ≥0.45):");
    for (i, count) in hist.iter().enumerate() {
        let pct = (*count as f64) / n * 100.0;
        let bar: String = std::iter::repeat('▇')
            .take((pct as usize).min(40))
            .collect();
        println!(
            "  [{:.2}-{:.2}]: {:5.1}% {}",
            (i as f32) * 0.05,
            ((i + 1) as f32) * 0.05,
            pct,
            bar
        );
    }

    Ok(())
}
