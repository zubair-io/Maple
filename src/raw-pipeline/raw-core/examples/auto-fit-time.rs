//! Times the standalone Auto-Profile fit (`fit_auto_profile_from_raw`) — the
//! entry Apple's GPU-live and CPU paths call on every cold open.
//! Usage: auto-fit-time <RAW> [preview|full]
use raw_core::pipeline::{fit_auto_profile_from_raw, RawInput, RenderQuality};
use raw_core::xmp::AdjustmentModel;
use std::path::Path;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = Path::new(&args[1]);
    let quality = match args.get(2).map(String::as_str) {
        Some("full") => RenderQuality::Full,
        _ => RenderQuality::Preview,
    };
    let bytes = std::fs::read(path).expect("read");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let t = Instant::now();
    let raw = raw_core::decode::decode_bytes(&bytes, ext).expect("decode");
    let decode_ms = t.elapsed().as_millis();
    let model = AdjustmentModel::default();
    let t = Instant::now();
    let fit = fit_auto_profile_from_raw(&raw, &model, quality, RawInput::Path(path));
    let fit_ms = t.elapsed().as_millis();
    let t = Instant::now();
    let _again = fit_auto_profile_from_raw(&raw, &model, quality, RawInput::Path(path));
    let cached_ms = t.elapsed().as_millis();
    println!(
        "{} sensor={}x{} decode={}ms fit={}ms (cached again={}ms) curve={} lut={}",
        path.file_name().unwrap().to_string_lossy(),
        raw.width,
        raw.height,
        decode_ms,
        fit_ms,
        cached_ms,
        fit.as_ref().map(|f| f.0.is_some()).unwrap_or(false),
        fit.as_ref().map(|f| f.1.is_some()).unwrap_or(false),
    );
}
