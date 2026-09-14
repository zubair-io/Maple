//! Diagnostic: production pre-view scene-linear Rec.2020 statistics (#3601).
//!
//! Runs all production develop stages with AE off, stopping before AgX.
//! The separately reported AE-on gain is diagnostic, not an Auto Profile gain.
//!
//! Usage:  cargo run -p raw-core --example dump_scene_linear -- <raw_path>

use raw_core::decode;
use raw_core::pipeline::{develop_scene_linear_from_raw_with_quality_with_gain, RenderQuality};
use raw_core::types::adjustment::AutoExposureMode;
use raw_core::xmp::AdjustmentModel;
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

    // Use the real production develop chain. The former hand-built DCP
    // replica omitted WB pre-gain, camera-space recovery and other stages,
    // so its percentile could not be combined with production AE gain.
    let model = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    let (scene, _) =
        develop_scene_linear_from_raw_with_quality_with_gain(&raw, &model, RenderQuality::Full)?;

    // Stats on the production pre-view scene-linear Rec.2020 buffer.
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

    // White-point calibration (ticket #3601, Task 1): percentiles of
    // log2(luma / AGX_MID_GRAY) — the frame's own white expressed in EV
    // above mid-gray, on the production scene-linear buffer (pre-AgX, AE off,
    // no PNG round trip). `ev_white_img = percentile_P(...)` is the
    // per-frame statistic the whites white-point remap anchors on; this
    // dump lets the calibration tool sweep P against ACR's measured
    // response instead of guessing it.
    const AGX_MID_GRAY: f64 = 0.18;
    let mut lumas: Vec<f32> = scene
        .pixels
        .iter()
        .map(|p| 0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2])
        .collect();
    lumas.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
    let percentiles: &[(&str, f64)] = &[
        ("90", 90.0),
        ("95", 95.0),
        ("97", 97.0),
        ("98", 98.0),
        ("99", 99.0),
        ("99.5", 99.5),
        ("99.9", 99.9),
        ("100", 100.0),
    ];
    println!("scene-linear white-point percentiles (EV = log2(luma/{AGX_MID_GRAY})):");
    let mut json_fields = Vec::with_capacity(percentiles.len());
    for (label, p) in percentiles {
        let idx = if *p >= 100.0 {
            lumas.len() - 1
        } else {
            (((p / 100.0) * (lumas.len() as f64 - 1.0)).round() as usize).min(lumas.len() - 1)
        };
        let luma = lumas[idx].max(1e-8) as f64;
        let ev = (luma / AGX_MID_GRAY).log2();
        println!("  P{:>5}: {:+.4} EV  (luma={:.6})", label, ev, luma);
        json_fields.push(format!("\"P{label}\":{ev:.6}"));
    }
    println!("PERCENTILES_JSON: {{{}}}", json_fields.join(","));

    // Separately report production AE-on gain. This does not mean Auto
    // Profile uses that gain: the display renderer disables AE when an
    // embedded JPEG is available for the profile fit.
    let model = AdjustmentModel::default();
    let (_rendered, ae_gain) =
        develop_scene_linear_from_raw_with_quality_with_gain(&raw, &model, RenderQuality::Full)?;
    let ae_gain_ev = (ae_gain as f64).log2();
    println!("auto_exposure gain: {ae_gain:.6}x ({ae_gain_ev:+.4} EV)");
    println!("AE_GAIN_JSON: {{\"gain\":{ae_gain:.6},\"gain_ev\":{ae_gain_ev:.6}}}");

    Ok(())
}
