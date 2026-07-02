//! Dump scene-linear Rec.2020 values at specified pixel coordinates.
//!
//! Usage:
//!   cargo run --release -p raw-core --example dump_pixel -- <raw_path> <x> <y> [<x> <y> ...]
//!
//! Prints for each (x, y):
//!   - the raw Bayer count at that position
//!   - the demosaiced camera-native RGB
//!   - the camera-native RGB after BaselineExposure is applied
//!   - the scene-linear Rec.2020 RGB after DCP (pre-AgX)
//!
//! To cross-validate against another renderer, render the same RAW to a
//! 16-bit linear Rec.2020 or ProPhoto TIFF and read the same pixel.
//! Ratios (Maple / other) tell us the scaling factor between pipelines.

use raw_core::color::dcp;
use raw_core::image::CfaPattern;
use raw_core::{decode, demosaic, linearize};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: dump_pixel <raw> <x> <y> ...");
    let coords: Vec<(u32, u32)> = {
        let rest: Vec<String> = args.collect();
        if rest.is_empty() || rest.len() % 2 != 0 {
            eprintln!("expected pairs of x y coordinates after <raw>");
            std::process::exit(2);
        }
        rest.chunks(2)
            .map(|c| (c[0].parse::<u32>().unwrap(), c[1].parse::<u32>().unwrap()))
            .collect()
    };

    let raw = decode::decode(std::path::Path::new(&path))?;
    println!("file: {}", path);
    println!("dims: {}×{}", raw.width, raw.height);
    println!("cfa: {:?}", raw.cfa);
    println!("camera: {} {}", raw.camera_make, raw.camera_model);
    println!(
        "black_level: {:?}, white_level: {}",
        raw.black_level, raw.white_level
    );
    println!(
        "as_shot_neutral (G-normalized camera reading): {:?}",
        raw.as_shot_neutral
    );
    println!("baseline_exposure: {:+.3} EV", raw.baseline_exposure);

    // Route around demosaic for already-3-channel LinearRgb sources (DNG
    // LinearRaw + Canon sRaw CR2 — see ticket #373). dump_pixel's original
    // path called `color_at`, which panics for CfaPattern::LinearRgb.
    let is_linear_rgb = matches!(raw.cfa, CfaPattern::LinearRgb);
    let mut camera_rgb = if is_linear_rgb {
        linearize::linearraw_to_camera_rgb(&raw)?
    } else {
        let mosaic = linearize::sensor_linearize(&raw);
        demosaic::bilinear(&mosaic, raw.cfa)
    };
    let camera_rgb_pre_baseline = camera_rgb.clone();
    if raw.baseline_exposure.abs() > 1e-4 {
        let be = raw.baseline_exposure.exp2();
        for p in &mut camera_rgb.pixels {
            p[0] *= be;
            p[1] *= be;
            p[2] *= be;
        }
    }
    let camera_rgb_pre_wb = camera_rgb.clone();

    // Mirror pipeline/develop.rs § "skip_pre_gain" decision — apply WB
    // pre-gain (divide camera RGB by AsShotNeutral) so a neutral patch reads
    // (1, 1, 1) into DCP, EXCEPT for 8-bit lossy LinearRaw DNGs.
    let skip_pre_gain = is_linear_rgb && raw.white_level <= 255;
    if !skip_pre_gain {
        let asn = raw.as_shot_neutral;
        for p in &mut camera_rgb.pixels {
            if asn[0] > 1e-6 {
                p[0] /= asn[0];
            }
            if asn[1] > 1e-6 {
                p[1] /= asn[1];
            }
            if asn[2] > 1e-6 {
                p[2] /= asn[2];
            }
        }
    }

    let profile = dcp::profile_for(&raw)?;
    println!(
        "skip_pre_gain: {} (white_level <= 255 ∧ LinearRgb)",
        skip_pre_gain
    );
    println!("wb_already_baked: {}", profile.wb_already_baked);
    println!("scene_cct: {:.0} K", profile.scene_cct);
    println!(
        "scene_white_xyz (Y=1 normalized): {:?}",
        profile.scene_white_xyz
    );
    let scene = dcp::apply(&camera_rgb, &profile)?;
    println!();

    for (x, y) in coords {
        if x >= raw.width || y >= raw.height {
            println!("({}, {}): OUT OF BOUNDS", x, y);
            continue;
        }
        let i = (y as usize) * (raw.width as usize) + (x as usize);
        // raw_v reporting differs by cfa: for LinearRgb the buffer is 3×w×h
        // interleaved (`[R G B]` per pixel); for Bayer it's 1×w×h scalar.
        if is_linear_rgb {
            let off = 3 * i;
            println!("({}, {}):", x, y);
            println!(
                "    raw counts (R, G, B): ({}, {}, {})",
                raw.raw_data[off],
                raw.raw_data[off + 1],
                raw.raw_data[off + 2]
            );
        } else {
            let raw_v = raw.raw_data[i];
            let mosaic_c = raw.cfa.color_at(x, y);
            println!("({}, {}):", x, y);
            println!("    raw count: {} (CFA channel {})", raw_v, mosaic_c);
        }
        let demo_pre = camera_rgb_pre_baseline.pixels[i];
        let demo_pre_wb = camera_rgb_pre_wb.pixels[i];
        let demo_post = camera_rgb.pixels[i];
        let sl = scene.pixels[i];
        println!(
            "    camera-native RGB (post-decode, pre-BaselineExposure):   ({:.4}, {:.4}, {:.4})",
            demo_pre[0], demo_pre[1], demo_pre[2]
        );
        println!(
            "    camera-native RGB (post-BaselineExposure, pre-pre-gain): ({:.4}, {:.4}, {:.4})",
            demo_pre_wb[0], demo_pre_wb[1], demo_pre_wb[2]
        );
        println!(
            "    camera-native RGB (post-pre-gain, into DCP):             ({:.4}, {:.4}, {:.4})",
            demo_post[0], demo_post[1], demo_post[2]
        );
        println!(
            "    scene-linear Rec.2020 (post-DCP, pre-AgX):               ({:.4}, {:.4}, {:.4})",
            sl[0], sl[1], sl[2]
        );
        // Per-channel ratio R/G and B/G — direct visibility on the R+B crush.
        if demo_pre[1].abs() > 1e-6 {
            println!(
                "    raw RGB ratios (R/G, B/G):                               ({:.4}, {:.4})",
                demo_pre[0] / demo_pre[1],
                demo_pre[2] / demo_pre[1]
            );
        }
        if sl[1].abs() > 1e-6 {
            println!(
                "    scene RGB ratios (R/G, B/G):                             ({:.4}, {:.4})",
                sl[0] / sl[1],
                sl[2] / sl[1]
            );
        }
        // Luminance in scene-linear Rec.2020 (0.18 target for mid-gray).
        let luma = 0.2627 * sl[0] + 0.6780 * sl[1] + 0.0593 * sl[2];
        println!(
            "    scene-linear luma: {:.4}  (mid-gray reference: 0.1800)",
            luma
        );
    }

    Ok(())
}
