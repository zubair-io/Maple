//! #3510 evidence harness: for each RAW in a directory, fit the Auto Profile
//! artifacts the pre-#3510 way (native develop, full embedded JPEG) and the
//! proxied way, apply each to the SAME Neutral display render, and write the
//! two PNGs (+ timings) so `compare_images.py` can CIEDE2000 them.
//! Usage: auto-fit-proxy-delta <raw-dir> <out-dir>
//! Add `--render-matrix` to hold each fit fixed across native/preview renders
//! (preview defaults to 1600px),
//! with default detail, chroma NR disabled, and sensor noise calibration
//! omitted while retaining NR (#3875). Diagnostic only:
//! deliberately overriding render-origin cache entries is not host behavior.
//! `--variance-ratio=<0..1>` restricts the matrix to default and a diagnostic
//! noise-profile variance scale at preview size; native rendering remains unchanged.
//! Supply an independently derived variance ratio (for example, normalized
//! resize-kernel energy), not a value fitted against image error. An area ratio
//! alone does not describe the Mitchell resize kernel.
//! `--native-auto` renders native matrix references with export's Auto
//! reconstruction, holding the Preview-fitted artifacts fixed to isolate
//! reconstruction from Auto fitting. This is not production cache behavior.
//! `--preview-edge=N` changes only the matrix preview working resolution;
//! compare all outputs at the same final viewport size to isolate early resize.
use raw_core::pipeline::{
    fit_auto_profile_from_raw_at_cap, render_sized_from_raw_with_quality_and_source, FitCap,
    RawInput, RenderQuality,
};
use raw_core::types::adjustment::{AutoExposureMode, Profile};
use raw_core::view::auto_profile::apply_curve;
use raw_core::view::auto_profile::cache::{self, CacheKey, FitOrigin};
use raw_core::xmp::AdjustmentModel;
use std::path::Path;
use std::time::Instant;

const RENDER_LE: u32 = 1536;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let native_auto = args.iter().any(|arg| arg == "--native-auto");
    let preview_edge = args
        .iter()
        .find_map(|arg| {
            arg.strip_prefix("--preview-edge=")
                .map(|value| value.parse::<u32>().expect("preview edge"))
        })
        .unwrap_or(1600);
    assert!(preview_edge > 0, "preview edge must be positive");
    if native_auto {
        assert!(args.iter().any(|arg| arg == "--render-matrix"));
    }
    let variance_ratio = args.iter().find_map(|arg| {
        arg.strip_prefix("--variance-ratio=")
            .map(|value| value.parse::<f32>().expect("variance ratio"))
    });
    if let Some(ratio) = variance_ratio {
        assert!(
            ratio > 0.0 && ratio <= 1.0,
            "variance ratio must be in (0, 1]"
        );
        assert!(args.iter().any(|arg| arg == "--render-matrix"));
    }
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
        let mut raw = match raw_core::decode::decode_bytes(&bytes, ext) {
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
            if args.iter().any(|a| a == "--render-matrix") {
                // Require both artifacts: a missing one would let the render
                // refit and invalidate the claim that the fit is held fixed.
                let curve = curve.as_ref().expect("matrix requires a fitted curve");
                let residual = residual.as_ref().expect("matrix requires a residual LUT");
                assert!(
                    preview_edge < raw.width.max(raw.height),
                    "matrix preview must be smaller than native"
                );
                for edge in [preview_edge, raw.width.max(raw.height)] {
                    let quality = if native_auto && edge == raw.width.max(raw.height) {
                        RenderQuality::Auto
                    } else {
                        RenderQuality::Preview
                    };
                    let quality_suffix = if quality == RenderQuality::Auto {
                        "-auto"
                    } else {
                        ""
                    };
                    let key = CacheKey::from_path(&path, quality)
                        .expect("fixture cache identity")
                        .with_origin(FitOrigin::Render(
                            (edge < raw.width.max(raw.height)).then_some(edge),
                        ));
                    cache::insert(key.clone(), curve.clone());
                    cache::insert_lut(key, residual.clone());
                    let variants = if variance_ratio.is_some() {
                        vec![
                            (auto_model.nr_color, "default"),
                            (auto_model.nr_color, "variance-scaled"),
                        ]
                    } else {
                        vec![
                            (auto_model.nr_color, "default"),
                            (0.0, "no-nr"),
                            (auto_model.nr_color, "no-noise-profile"),
                        ]
                    };
                    for (nr_color, detail) in variants {
                        let model = AdjustmentModel {
                            nr_color,
                            ..auto_model.clone()
                        };
                        // Remove calibration only during this counterfactual render;
                        // both Auto fits above still use the original decoded RAW.
                        // Restore before the next render/fit so the experiment has
                        // one independent variable and never changes source bytes.
                        let saved_profile = if detail == "no-noise-profile" {
                            raw.noise_profile.take()
                        } else if detail == "variance-scaled" && edge == preview_edge {
                            let original = raw
                                .noise_profile
                                .clone()
                                .expect("variance diagnostic requires sensor calibration");
                            raw.noise_profile = Some(
                                original
                                    .iter()
                                    .map(|v| v * variance_ratio.unwrap())
                                    .collect(),
                            );
                            Some(original)
                        } else {
                            None
                        };
                        let rendered = render_sized_from_raw_with_quality_and_source(
                            &raw,
                            &model,
                            quality,
                            Some(RawInput::Path(&path)),
                            edge,
                        );
                        if detail == "no-noise-profile"
                            || (detail == "variance-scaled" && edge == preview_edge)
                        {
                            raw.noise_profile = saved_profile;
                        }
                        let (rw, rh, rgb) = rendered.expect("fixed-fit render");
                        let png = raw_core::png::encode(rw, rh, &rgb).unwrap();
                        std::fs::write(
                            out.join(format!(
                                "{name}-{label}-fit-{edge}-{detail}{quality_suffix}.png"
                            )),
                            png,
                        )
                        .unwrap();
                    }
                }
            }
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
