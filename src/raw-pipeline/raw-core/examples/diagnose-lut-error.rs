//! Diagnose the AcrMatch LUT interpolation error distribution.

use raw_core::view::acr_fit::model::apply_model;
use raw_core::view::acr_match::{bake_acr_match_lut, lut_decode, model, sample_lut_3d};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(33);
    let data = bake_acr_match_lut(n);
    let m = model();
    let sample_n = 20usize;
    let mut max_err = 0.0f32;
    let mut max_scene = [0.0f32; 3];
    let mut max_direct = [0.0f32; 3];
    let mut max_direct_raw = [0.0f32; 3];
    let mut max_sampled = [0.0f32; 3];
    let mut max_ch = 0;
    let mut max_ingamut_err = 0.0f32;
    let mut max_ingamut_scene = [0.0f32; 3];

    for ri in 0..sample_n {
        for gi in 0..sample_n {
            for bi in 0..sample_n {
                let tr = ri as f32 / (sample_n - 1) as f32;
                let tg = gi as f32 / (sample_n - 1) as f32;
                let tb = bi as f32 / (sample_n - 1) as f32;
                let scene = [lut_decode(tr), lut_decode(tg), lut_decode(tb)];
                let direct_raw = apply_model(m, scene);
                let direct = [
                    direct_raw[0].clamp(0.0, 1.0),
                    direct_raw[1].clamp(0.0, 1.0),
                    direct_raw[2].clamp(0.0, 1.0),
                ];
                let sampled = sample_lut_3d(&data, n, scene);
                for ch in 0..3 {
                    let err = (direct[ch] - sampled[ch]).abs();
                    if err > max_err {
                        max_err = err;
                        max_scene = scene;
                        max_direct = direct;
                        max_direct_raw = direct_raw;
                        max_sampled = sampled;
                        max_ch = ch;
                    }
                }
                // In-gamut check: raw output (before clamp) is all <= 1.0
                if direct_raw[0] <= 1.0 && direct_raw[1] <= 1.0 && direct_raw[2] <= 1.0 {
                    for ch in 0..3 {
                        let err = (direct[ch] - sampled[ch]).abs();
                        if err > max_ingamut_err {
                            max_ingamut_err = err;
                            max_ingamut_scene = scene;
                        }
                    }
                }
            }
        }
    }

    eprintln!("Max LUT error = {max_err:.4e}");
    eprintln!("  Scene:     {:?}", max_scene);
    eprintln!("  DirectRaw: {:?}", max_direct_raw);
    eprintln!("  Direct:    {:?}", max_direct);
    eprintln!("  Sampled:   {:?}", max_sampled);
    eprintln!("  Channel:   {max_ch}");
    eprintln!("Max IN-GAMUT LUT error = {max_ingamut_err:.4e}");
    eprintln!("  Scene: {:?}", max_ingamut_scene);

    eprintln!("n = {n}");
}
