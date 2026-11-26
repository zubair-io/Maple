//! cargo run --release -p raw-core --example cpu-preview-tick-bench -- <raw> <long-edge> <default|engaged> <late|detail> [ticks]
use raw_core::{
    cancel::CancelToken,
    decode,
    pipeline::{CpuPreview, RawInput, RenderQuality},
    xmp::AdjustmentModel,
};
use std::{collections::hash_map::DefaultHasher, hash::Hasher, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let path = args.get(1).ok_or("expected RAW path")?;
    let cap: u32 = args.get(2).ok_or("expected long edge")?.parse()?;
    let base = match args.get(3).map(String::as_str) {
        Some("default") => AdjustmentModel::default(),
        Some("engaged") => AdjustmentModel {
            sharpen_amount: 80.0,
            nr_luminance: 40.0,
            nr_color: 50.0,
            clarity: 30.0,
            texture: 30.0,
            dehaze: 20.0,
            ..Default::default()
        },
        _ => return Err("expected default or engaged".into()),
    };
    let late = match args.get(4).map(String::as_str) {
        Some("late") => true,
        Some("detail") => false,
        _ => return Err("expected late or detail".into()),
    };
    let ticks: usize = args.get(5).map(|v| v.parse()).transpose()?.unwrap_or(12);
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("dng")
        .to_ascii_lowercase();
    let bytes = std::fs::read(path)?;
    let raw = decode::decode_bytes(&bytes, &ext)?;
    let source = RawInput::Bytes {
        bytes: &bytes,
        ext: &ext,
    };
    let mut hash = DefaultHasher::new();
    let start = Instant::now();
    let (mut preview, (w, h, pixels, _)) = CpuPreview::open(
        &raw,
        source,
        base.clone(),
        RenderQuality::Preview,
        cap,
        None,
    )?;
    let open_ms = start.elapsed().as_secs_f64() * 1000.0;
    hash.write(&pixels);
    let mut times = Vec::with_capacity(ticks);
    for i in 1..=ticks {
        let model = if late {
            AdjustmentModel {
                contrast: i as f32 * 3.0,
                ..base.clone()
            }
        } else {
            AdjustmentModel {
                sharpen_amount: base.sharpen_amount + i as f32,
                ..base.clone()
            }
        };
        if std::env::var_os("MAPLE_PROFILE").is_some() {
            eprintln!("[bench] tick {i}");
        }
        let start = Instant::now();
        let (_, _, pixels, _) = preview.render(
            &raw,
            source,
            model,
            RenderQuality::Preview,
            cap,
            None,
            CancelToken::never(),
        )?;
        times.push(start.elapsed().as_secs_f64() * 1000.0);
        hash.write(&pixels);
    }
    let first = times[0];
    let second = times.get(1).copied().unwrap_or(first);
    let mut steady: Vec<f64> = times.iter().skip(2).copied().collect();
    steady.sort_by(f64::total_cmp);
    let min = steady.first().copied().unwrap_or(f64::NAN);
    let median = steady.get(steady.len() / 2).copied().unwrap_or(f64::NAN);
    println!(
        "dims={w}x{h} open_ms={open_ms:.1} tick1_ms={first:.1} tick2_ms={second:.1} steady_min_ms={min:.1} steady_median_ms={median:.1} hash={:016x}",
        hash.finish()
    );
    Ok(())
}
