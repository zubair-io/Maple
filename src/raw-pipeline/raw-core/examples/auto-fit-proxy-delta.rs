//! #3510 evidence harness: for each RAW in a directory, fit the Auto Profile
//! artifacts the pre-#3510 way (native develop, full embedded JPEG) and the
//! proxied way, apply each to the SAME Neutral display render, and write the
//! two PNGs (+ timings) so `compare_images.py` can CIEDE2000 them.
//! Usage: auto-fit-proxy-delta <raw-dir> <out-dir>
use raw_core::pipeline::{
    fit_auto_profile_from_raw_at_cap, render_sized_from_raw_with_quality_and_source, FitCap,
    RawInput, RenderQuality,
};
use raw_core::types::adjustment::{AutoExposureMode, Profile};
use raw_core::view::auto_profile::apply_curve;
use raw_core::xmp::AdjustmentModel;
use std::path::Path;
use std::time::Instant;

const RENDER_LE: u32 = 1536;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = Path::new(&args[1]);
    let out = Path::new(&args[2]);
    std::fs::create_dir_all(out).unwrap();
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map_or(false, |n| n.starts_with("test_00"))
        })
        .filter(|p| {
            !p.to_string_lossy().contains(".xmp") && !p.to_string_lossy().ends_with(".json")
        })
        .collect();
    entries.sort();
    println!("fixture\tsensor\tfit_native_ms\tfit_proxy_ms\tnative_png\tproxy_png");
    for path in entries {
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw = match raw_core::decode::decode_bytes(&bytes, ext) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("{name}: decode failed: {e}");
                continue;
            }
        };
        let auto_model = AdjustmentModel {
            profile: Profile::Auto,
            ..AdjustmentModel::default()
        };
        let neutral = AdjustmentModel {
            profile: Profile::Neutral,
            auto_exposure: AutoExposureMode::Off,
            ..AdjustmentModel::default()
        };
        let (w, h, base) = match render_sized_from_raw_with_quality_and_source(
            &raw,
            &neutral,
            RenderQuality::Preview,
            Some(RawInput::Path(&path)),
            RENDER_LE,
        ) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("{name}: render failed: {e}");
                continue;
            }
        };
        let chans = base.len() / (w as usize * h as usize);
        let mut pngs = Vec::new();
        let mut times = Vec::new();
        for (cap, label) in [(FitCap::Native, "native"), (FitCap::Proxy, "proxy")] {
            let t = Instant::now();
            let fit = fit_auto_profile_from_raw_at_cap(
                &raw,
                &auto_model,
                RenderQuality::Preview,
                RawInput::Path(&path),
                cap,
            );
            times.push(t.elapsed().as_millis());
            let Some((curve, residual)) = fit else {
                eprintln!("{name}: no fit ({label})");
                pngs.push(String::from("-"));
                continue;
            };
            let mut pix: Vec<f32> = Vec::with_capacity(w as usize * h as usize * 3);
            for i in 0..w as usize * h as usize {
                for c in 0..3 {
                    pix.push(base[i * chans + c] as f32 / 255.0);
                }
            }
            if let Some(c) = &curve {
                apply_curve(&mut pix, c);
            }
            if let Some(l) = &residual {
                l.apply(&mut pix);
            }
            let rgb8: Vec<u8> = pix
                .iter()
                .map(|v| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8)
                .collect();
            let png = raw_core::png::encode(w, h, &rgb8).unwrap();
            let p = out.join(format!("{name}-{label}.png"));
            std::fs::write(&p, png).unwrap();
            pngs.push(p.to_string_lossy().to_string());
        }
        println!(
            "{name}\t{}x{}\t{}\t{}\t{}\t{}",
            raw.width,
            raw.height,
            times.first().copied().unwrap_or(0),
            times.get(1).copied().unwrap_or(0),
            pngs.first().cloned().unwrap_or_default(),
            pngs.get(1).cloned().unwrap_or_default()
        );
    }
}
