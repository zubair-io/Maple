//! Ad-hoc probe for #1726 verification: prints scene-linear Rec.2020 RGB at
//! a non-neutral pixel through a real DCP profile, at as-shot vs two
//! extreme user-WB targets — used to confirm the camera-space gain
//! produces a directionally-correct, monotone cast (warm target -> warm
//! cast, cool target -> cool cast) rather than the near-total
//! double-Bradford-cancellation attempt 1 shipped.
//!
//! Usage:
//!   cargo run --release -p raw-core --example wb_camera_probe -- <raw_path> <x> <y>

use raw_core::color::dcp;
use raw_core::image::CfaPattern;
use raw_core::stages::wb_camera;
use raw_core::{decode, demosaic, linearize};

fn render_at(
    raw: &raw_core::image::RawImage,
    temperature: f32,
    tint: f32,
) -> Result<raw_core::image::Image, Box<dyn std::error::Error>> {
    let is_linear_rgb = matches!(raw.cfa, CfaPattern::LinearRgb);
    let mut camera_rgb = if is_linear_rgb {
        linearize::linearraw_to_camera_rgb(raw)?
    } else {
        let mosaic = linearize::sensor_linearize(raw);
        demosaic::bilinear(&mosaic, raw.cfa)
    };
    if raw.baseline_exposure.abs() > 1e-4 {
        let be = raw.baseline_exposure.exp2();
        for p in &mut camera_rgb.pixels {
            p[0] *= be;
            p[1] *= be;
            p[2] *= be;
        }
    }
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

    let (profile, source) = dcp::profile_for_with_source(raw)?;
    println!("  profile_source: {:?}", source);
    println!("  scene_cct (as-shot): {:.1} K", profile.scene_cct);

    if !skip_pre_gain && !matches!(source, dcp::ProfileSource::RawlerFallback) {
        wb_camera::apply(&mut camera_rgb, &profile, raw.as_shot_neutral, temperature, tint);
    }
    Ok(dcp::apply_colorimetry(&camera_rgb, &profile)?)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: wb_camera_probe <raw> <x> <y>");
    let x: u32 = args.next().expect("x").parse()?;
    let y: u32 = args.next().expect("y").parse()?;

    let raw = decode::decode(std::path::Path::new(&path))?;
    println!("file: {}", path);
    println!("camera: {} {}", raw.camera_make, raw.camera_model);
    let i = (y as usize) * (raw.width as usize) + (x as usize);

    let (profile, _source) = dcp::profile_for_with_source(&raw)?;
    let as_shot_cct = profile.scene_cct;

    for (label, temperature, tint) in [
        ("as-shot", as_shot_cct, 0.0),
        ("50000K", 50000.0_f32, 0.0),
        ("2000K", 2000.0_f32, 0.0),
    ] {
        println!("-- target: {} ({:.0}K, tint {:.1}) --", label, temperature, tint);
        let scene = render_at(&raw, temperature, tint)?;
        let p = scene.pixels[i];
        println!(
            "  pixel ({}, {}) scene-linear Rec.2020: [{:.4}, {:.4}, {:.4}]",
            x, y, p[0], p[1], p[2]
        );
    }

    Ok(())
}
