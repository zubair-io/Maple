//! Probe rawler's raw output for sRaw / LinearRaw before any Maple math.
//!
//! Investigation tool for ticket #373: prints rawler's RawImage post-decode
//! to verify whether sRaw / LinearRaw buffers carry WB pre-applied (and which
//! WB), what `wb_coeffs` reports, and how Maple's AsShotNeutral derivation
//! relates to the raw R/G/B ratios in the buffer.
//!
//! Usage:
//!   cargo run --release -p raw-core --example sraw_probe -- <raw>

use rawler::decoders::RawDecodeParams;
use rawler::rawimage::RawImageData;
use rawler::rawsource::RawSource;

fn main() {
    let path = std::env::args().nth(1).expect("usage: sraw_probe <raw>");
    let bytes = std::fs::read(&path).unwrap();
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let hint = format!("rawfile.{}", ext);
    let source = RawSource::new_from_slice(&bytes).with_path(std::path::Path::new(&hint));
    let params = RawDecodeParams::default();
    let raw = rawler::decode(&source, &params).expect("decode");
    println!("photometric: {:?}", raw.photometric);
    println!("wb_coeffs (rawler's get_wb()): {:?}", raw.wb_coeffs);
    println!("dims: {}×{}", raw.width, raw.height);
    println!("cpp: {}", raw.cpp);
    println!("blacklevel: {:?}", raw.blacklevel);
    println!("whitelevel: {:?}", raw.whitelevel);

    // For LinearRaw cpp=3, sample a 100×100 patch near the image center.
    if let RawImageData::Integer(data) = &raw.data {
        println!(
            "data len: {} (expected w*h*cpp = {})",
            data.len(),
            raw.width * raw.height * raw.cpp
        );
        if raw.cpp == 3 {
            let cx = (raw.width / 2) as usize;
            let cy = (raw.height / 2) as usize;
            let off_c = (cy * raw.width + cx) * 3;
            println!(
                "center pixel ({},{}): R={} G={} B={}",
                cx,
                cy,
                data[off_c],
                data[off_c + 1],
                data[off_c + 2]
            );
            let half = 50usize;
            let mut sum = [0u64; 3];
            let mut n = 0u64;
            for dy in 0..(2 * half) {
                for dx in 0..(2 * half) {
                    let y = cy + dy - half;
                    let x = cx + dx - half;
                    let off = (y * raw.width + x) * 3;
                    sum[0] += data[off] as u64;
                    sum[1] += data[off + 1] as u64;
                    sum[2] += data[off + 2] as u64;
                    n += 1;
                }
            }
            let mean_r = sum[0] as f64 / n as f64;
            let mean_g = sum[1] as f64 / n as f64;
            let mean_b = sum[2] as f64 / n as f64;
            println!(
                "center {}×{} patch mean: R={:.1} G={:.1} B={:.1}",
                2 * half,
                2 * half,
                mean_r,
                mean_g,
                mean_b
            );
            println!(
                "center patch ratios (R/G, B/G): ({:.4}, {:.4})",
                mean_r / mean_g,
                mean_b / mean_g
            );
            if raw.wb_coeffs[1].is_normal() && !raw.wb_coeffs[1].is_nan() {
                // rawler reports wb_coeffs as MULTIPLIERS: gain that
                // balances camera-RGB to neutral. So a neutral reading
                // (R, G, B) satisfies R * mult_R = G * mult_G = B * mult_B.
                // i.e. R/G = mult_G / mult_R. If the buffer is already
                // WB-baked, R/G should be ≈ 1.0. If NOT baked, R/G should
                // be ≈ mult_G/mult_R = the camera reading.
                let m_g = raw.wb_coeffs[1];
                let asn_r = m_g / raw.wb_coeffs[0];
                let asn_b = m_g / raw.wb_coeffs[2];
                println!(
                    "AsShotNeutral derived from wb_coeffs (G/R, G/B): ({:.4}, {:.4})",
                    asn_r, asn_b
                );
                println!("→ if buffer is pre-WB'd, ratios should be ≈ (1.0, 1.0)");
                println!(
                    "→ if buffer is raw camera-RGB, ratios should be ≈ ({:.4}, {:.4}) (AsShotNeutral)",
                    asn_r, asn_b
                );
            }
        }
    }
}
