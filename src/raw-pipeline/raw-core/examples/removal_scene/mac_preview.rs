//! #4323 research UI adapter; delegates all photographic math to raw-core.
use super::*;
use raw_core::pipeline::{native_render_dims, render_sized_from_raw_with_quality_and_source};
use raw_core::xmp::LensProfileEnable;

pub(super) fn render(path: &Path, output: &Path) -> ProbeResult<()> {
    let (bytes, raw) = decode_raw(path)?;
    let (dw, dh) = native_render_dims(&raw);
    let (width, height) = if raw.orientation.swaps_wh() {
        (dh, dw)
    } else {
        (dw, dh)
    };
    let model = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        lens_profile_enable: LensProfileEnable::Off,
        ..Default::default()
    };
    let (w, h, rgb) = render_sized_from_raw_with_quality_and_source(
        &raw,
        &model,
        RenderQuality::Amaze,
        Some(RawInput::Path(path)),
        2048,
    )?;
    std::fs::create_dir_all(output)?;
    image::RgbImage::from_raw(w, h, rgb)
        .ok_or("preview geometry mismatch")?
        .save(output.join("preview.png"))?;
    std::fs::write(
        output.join("source.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "width": width, "height": height, "orientation": raw.orientation as u8 + 1,
            "displayWidth": dw, "displayHeight": dh, "original": ContentDigest::for_bytes(&bytes),
            "raw": path, "preview": output.join("preview.png"),
            "ignoresSidecar": true, "releaseQualified": false
        }))?,
    )?;
    Ok(())
}
