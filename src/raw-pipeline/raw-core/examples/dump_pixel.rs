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
    println!("camera: {} {}", raw.camera_make, raw.camera_model);
    println!("black_level: {:?}, white_level: {}", raw.black_level, raw.white_level);
    println!("as_shot_neutral (G-normalized camera reading): {:?}", raw.as_shot_neutral);
    println!("baseline_exposure: {:+.3} EV", raw.baseline_exposure);

    let mosaic = linearize::sensor_linearize(&raw);
    let mut camera_rgb = demosaic::bilinear(&mosaic, raw.cfa);
    let camera_rgb_pre_baseline = camera_rgb.clone();
    if raw.baseline_exposure.abs() > 1e-4 {
        let be = raw.baseline_exposure.exp2();
        for p in &mut camera_rgb.pixels {
            p[0] *= be; p[1] *= be; p[2] *= be;
        }
    }
    let profile = dcp::profile_for(&raw)?;
    println!("scene_cct: {:.0} K", profile.scene_cct);
    println!("scene_white_xyz (Y=1 normalized): {:?}", profile.scene_white_xyz);
    let scene = dcp::apply(&camera_rgb, &profile)?;
    println!();

    for (x, y) in coords {
        if x >= raw.width || y >= raw.height {
            println!("({}, {}): OUT OF BOUNDS", x, y);
            continue;
        }
        let i = (y as usize) * (raw.width as usize) + (x as usize);
        let raw_v = raw.raw_data[i];
        let mosaic_c = raw.cfa.color_at(x, y);
        let demo_pre = camera_rgb_pre_baseline.pixels[i];
        let demo_post = camera_rgb.pixels[i];
        let sl = scene.pixels[i];
        println!("({}, {}):", x, y);
        println!("    raw count: {} (CFA channel {})", raw_v, mosaic_c);
        println!("    camera-native RGB (post-demosaic, pre-BaselineExposure): ({:.4}, {:.4}, {:.4})",
            demo_pre[0], demo_pre[1], demo_pre[2]);
        println!("    camera-native RGB (post-BaselineExposure):               ({:.4}, {:.4}, {:.4})",
            demo_post[0], demo_post[1], demo_post[2]);
        println!("    scene-linear Rec.2020 (post-DCP, pre-AgX):               ({:.4}, {:.4}, {:.4})",
            sl[0], sl[1], sl[2]);
        // Luminance in scene-linear Rec.2020 (0.18 target for mid-gray).
        let luma = 0.2627 * sl[0] + 0.6780 * sl[1] + 0.0593 * sl[2];
        println!("    scene-linear luma: {:.4}  (mid-gray reference: 0.1800)", luma);
    }

    Ok(())
}
