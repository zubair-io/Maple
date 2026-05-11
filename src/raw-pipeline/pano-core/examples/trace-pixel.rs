//! Trace a single source-image pixel through every stage of the
//! panorama pipeline that touches its colour, printing per-channel
//! values at each step. The goal is to root-cause where the
//! magenta-bloom / out-of-gamut handling for sun-cloud pixels first
//! goes off the rails.
//!
//! Usage:
//!   cargo run --release -p pano-core --example trace-pixel -- <DNG> <px> <py> [<px2> <py2> ...]
//!
//! Stages traced (raw-core only, since pano-core operates on already-
//! decoded scene-linear Rec.2020 buffers):
//!
//!   1. raw count (pre-linearisation)
//!   2. demosaiced camera-native RGB (pre-baseline-exposure)
//!   3. camera-native RGB after BaselineExposure
//!   4. camera-native RGB after GainMap (vignette correction)
//!   5. camera-native RGB after highlight_recovery::Blend
//!   6. scene-linear Rec.2020 D65 (post-DCP)
//!   7. display-linear Rec.2020 (post-AgX)
//!   8. display-linear sRGB (post-Rec.2020 → sRGB matrix)
//!   9. sRGB-encoded u8-equivalent values (post-gamut clamp + transfer)
//!
//! For each stage we print:
//!   - the RGB triple
//!   - chroma-imbalance ratio: `min(R,G,B) / max(R,G,B)` (1.0 = neutral, < 0.1 = severely off-balance)

use raw_core::color::dcp;
use raw_core::color::matrices::M_REC2020_TO_SRGB;
use raw_core::image::{CfaPattern, ColorSpace, Image};
use raw_core::stages::highlight_recovery;
use raw_core::view::agx;
use raw_core::xmp::HighlightRecoveryMode;
use raw_core::{decode, demosaic, linearize, pano};

fn chroma_ratio(r: f32, g: f32, b: f32) -> f32 {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    if max <= 0.0 {
        1.0
    } else {
        (min / max).max(-9.999)
    }
}

fn print_stage(label: &str, p: [f32; 3]) {
    let cr = chroma_ratio(p[0], p[1], p[2]);
    println!(
        "    {label:<60} ({:7.4}, {:7.4}, {:7.4})  chroma={:+.3}",
        p[0], p[1], p[2], cr
    );
}

fn srgb_encode(x: f32) -> f32 {
    if x <= 0.0031308 {
        12.92 * x
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

fn rec2020_to_srgb_linear(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let v = M_REC2020_TO_SRGB.mul_vec([r, g, b]);
    (v[0], v[1], v[2])
}

/// Soft sRGB gamut mapping copied verbatim from pano-smoke. Blends an
/// out-of-range pixel toward Rec.709 luminance just enough to bring all
/// channels into [0, 1].
fn gamut_clamp_srgb(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    if r >= 0.0 && g >= 0.0 && b >= 0.0 && r <= 1.0 && g <= 1.0 && b <= 1.0 {
        return (r, g, b);
    }
    let y = (0.2126 * r + 0.7152 * g + 0.0722 * b).clamp(0.0, 1.0);
    let mut t: f32 = 0.0;
    for c in [r, g, b] {
        if c < 0.0 {
            let denom = y - c;
            if denom > 1e-9 {
                t = t.max(-c / denom);
            } else {
                t = 1.0;
            }
        } else if c > 1.0 {
            let denom = c - y;
            if denom > 1e-9 {
                t = t.max((c - 1.0) / denom);
            } else {
                t = 1.0;
            }
        }
    }
    let t = t.clamp(0.0, 1.0);
    (r + t * (y - r), g + t * (y - g), b + t * (y - b))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or("usage: trace-pixel <dng> <x> <y> [<x> <y> ...]")?;
    let coords: Vec<(u32, u32)> = {
        let rest: Vec<String> = args.collect();
        if rest.is_empty() || rest.len() % 2 != 0 {
            eprintln!("expected pairs of x y coordinates after <dng>");
            std::process::exit(2);
        }
        rest.chunks(2)
            .map(|c| (c[0].parse::<u32>().unwrap(), c[1].parse::<u32>().unwrap()))
            .collect()
    };

    let bytes = std::fs::read(&path)?;
    let raw = decode::decode_bytes(&bytes, "dng")?;
    println!("file: {}", path);
    println!("dims: {}×{}", raw.width, raw.height);
    println!("camera: {} {}", raw.camera_make, raw.camera_model);
    println!("black_level: {:?}, white_level: {}", raw.black_level, raw.white_level);
    println!(
        "as_shot_neutral (G-normalized camera reading): {:?}",
        raw.as_shot_neutral
    );
    println!("baseline_exposure: {:+.3} EV", raw.baseline_exposure);

    let gain_map = pano::extract_gain_map(&bytes);
    println!(
        "gain_map present: {}",
        gain_map.as_ref().map(|_| "yes").unwrap_or("no")
    );

    // Stage 1: linearise + demosaic (NO baseline, NO gain_map, NO highlight recovery)
    let mut camera_rgb = match raw.cfa {
        CfaPattern::LinearRgb => linearize::linearraw_to_camera_rgb(&raw)?,
        _ => {
            let mosaic = linearize::sensor_linearize(&raw);
            demosaic::bilinear(&mosaic, raw.cfa)
        }
    };
    let camera_rgb_pre_baseline: Image = camera_rgb.clone();

    // Stage 2: baseline exposure
    if raw.baseline_exposure.abs() > 1e-4 {
        let be_gain = raw.baseline_exposure.exp2();
        for p in &mut camera_rgb.pixels {
            p[0] *= be_gain;
            p[1] *= be_gain;
            p[2] *= be_gain;
        }
    }
    let camera_rgb_post_baseline: Image = camera_rgb.clone();

    // Stage 3: gain map (vignette correction)
    if let Some(gm) = gain_map.as_ref() {
        // Reuse pano::develop_for_pano_with_gain_map's apply step by going
        // through a clone — we want the post-gainmap snapshot too.
        // The apply_gain_map function is private; redo the math here.
        let (top, left, bottom, right) = gm.rect;
        let img_w = camera_rgb.width;
        let img_h = camera_rgb.height;
        let rx0 = left.min(img_w);
        let ry0 = top.min(img_h);
        let rx1 = right.min(img_w);
        let ry1 = bottom.min(img_h);
        if rx1 > rx0 && ry1 > ry0 {
            let rect_w = (rx1 - rx0) as f64;
            let rect_h = (ry1 - ry0) as f64;
            for y in ry0..ry1 {
                let v_norm = (y as f64 - ry0 as f64) / (rect_h - 1.0).max(1.0);
                for x in rx0..rx1 {
                    let u_norm = (x as f64 - rx0 as f64) / (rect_w - 1.0).max(1.0);
                    let (gr, gg, gb) = gm.sample(u_norm, v_norm);
                    let idx = (y as usize) * (img_w as usize) + (x as usize);
                    let p = &mut camera_rgb.pixels[idx];
                    p[0] *= gr;
                    p[1] *= gg;
                    p[2] *= gb;
                }
            }
        }
    }
    let camera_rgb_post_gainmap: Image = camera_rgb.clone();

    // Stage 4: highlight recovery (Blend mode is the pano default)
    if raw.cfa != CfaPattern::LinearRgb {
        highlight_recovery::apply(&mut camera_rgb, HighlightRecoveryMode::Blend);
    }
    let camera_rgb_post_hr: Image = camera_rgb.clone();

    // Stage 5: clipped-neutral rebalance (Stage I fix; runs after
    // highlight_recovery so the partial-clip blend has had its turn).
    // Re-implements `pano::rebalance_clipped_neutrals_to_camera_white`
    // logic for visibility — keep in sync with the pano.rs body.
    let asn = raw.as_shot_neutral;
    let asn_max = asn[0].max(asn[1]).max(asn[2]);
    let asn_min = asn[0].min(asn[1]).min(asn[2]);
    if raw.cfa != CfaPattern::LinearRgb && asn_max > 0.0 && asn_min / asn_max < 0.995 {
        let scale = 1.0 / asn_max;
        let neutral = [asn[0] * scale, asn[1] * scale, asn[2] * scale];
        const EPSILON: f32 = 0.005;
        const HARD_BLEND_FLOOR: f32 = 0.92;
        const SOFT_BLEND_FLOOR: f32 = 0.5;
        let blend_span = HARD_BLEND_FLOOR - SOFT_BLEND_FLOOR;
        for p in &mut camera_rgb.pixels {
            let r = p[0];
            let g = p[1];
            let b = p[2];
            let max_c = r.max(g).max(b);
            if max_c < 1.0 - EPSILON {
                continue;
            }
            let min_c = r.min(g).min(b);
            let q = min_c / max_c;
            if q <= SOFT_BLEND_FLOOR {
                continue;
            }
            let t = ((q - SOFT_BLEND_FLOOR) / blend_span).clamp(0.0, 1.0);
            let target_r = neutral[0] * max_c;
            let target_g = neutral[1] * max_c;
            let target_b = neutral[2] * max_c;
            p[0] = r + t * (target_r - r);
            p[1] = g + t * (target_g - g);
            p[2] = b + t * (target_b - b);
        }
    }
    let camera_rgb_post_rebalance: Image = camera_rgb.clone();

    // Stage 6: DCP (camera RGB → scene-linear Rec.2020)
    let profile = dcp::profile_for(&raw)?;
    println!("scene_cct: {:.0} K", profile.scene_cct);
    println!("scene_white_xyz (Y=1 normalised): {:?}", profile.scene_white_xyz);
    let scene = dcp::apply(&camera_rgb, &profile)?;

    // Stage 6+: per-pixel report through AgX → sRGB encode
    println!();
    for (x, y) in coords {
        if x >= raw.width || y >= raw.height {
            println!("({}, {}): OUT OF BOUNDS", x, y);
            continue;
        }
        let idx = (y as usize) * (raw.width as usize) + (x as usize);
        println!("==== pixel ({}, {}) ====", x, y);

        let raw_v = raw.raw_data[idx];
        let mosaic_c = raw.cfa.color_at(x, y);
        println!("    raw count {} (CFA channel {}, white_level {})", raw_v, mosaic_c, raw.white_level);

        print_stage("camera-native RGB (post-demosaic, pre-BE):", camera_rgb_pre_baseline.pixels[idx]);
        print_stage("camera-native RGB (post-BaselineExposure):", camera_rgb_post_baseline.pixels[idx]);
        print_stage("camera-native RGB (post-GainMap vignette):", camera_rgb_post_gainmap.pixels[idx]);
        print_stage("camera-native RGB (post-highlight-recovery):", camera_rgb_post_hr.pixels[idx]);
        print_stage("camera-native RGB (post-clipped-rebalance):", camera_rgb_post_rebalance.pixels[idx]);
        print_stage("scene-linear Rec.2020 D65 (post-DCP):     ", scene.pixels[idx]);

        // AgX (per-channel sigmoid)
        let sl = scene.pixels[idx];
        let (r_agx, g_agx, b_agx) = agx::apply_rgb_triple(sl[0], sl[1], sl[2], 0.0);
        print_stage("display-linear Rec.2020 (post-AgX, c=0):  ", [r_agx, g_agx, b_agx]);

        // Rec.2020 → sRGB linear
        let (r_lin, g_lin, b_lin) = rec2020_to_srgb_linear(r_agx, g_agx, b_agx);
        print_stage("display-linear sRGB (post-matrix):        ", [r_lin, g_lin, b_lin]);

        // Soft gamut clamp
        let (r_lin, g_lin, b_lin) = gamut_clamp_srgb(r_lin, g_lin, b_lin);
        print_stage("display-linear sRGB (post-gamut-clamp):   ", [r_lin, g_lin, b_lin]);

        // sRGB encode (final 8/16-bit-equiv values)
        let r_enc = srgb_encode(r_lin);
        let g_enc = srgb_encode(g_lin);
        let b_enc = srgb_encode(b_lin);
        print_stage("display-encoded sRGB (post-transfer):     ", [r_enc, g_enc, b_enc]);
        println!(
            "    final 8-bit: ({:>3}, {:>3}, {:>3})",
            (r_enc * 255.0 + 0.5) as u32,
            (g_enc * 255.0 + 0.5) as u32,
            (b_enc * 255.0 + 0.5) as u32
        );
        println!();
    }

    let _ = ColorSpace::SceneLinearRec2020; // silence import-only warning for ColorSpace
    Ok(())
}
