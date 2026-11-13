//! Diagnose Auto's JPEG fit loss separately from LUT baking and pixel averaging.
//! No production settings are changed. Usage: RAW OUTPUT.json
use raw_core::color::matrices::M_REC2020_TO_SRGB;
use raw_core::decode::decode_bytes;
use raw_core::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use raw_core::stages::{color_grade, grain};
use raw_core::types::adjustment::AutoExposureMode;
use raw_core::view::acr_fit::{apply_model, solve_acr_model_from_display_pairs};
use raw_core::view::agx_inverse::srgb_gamma_inv;
use raw_core::view::auto_profile::pairs::{sample_display_pairs, DisplayPair};
use raw_core::view::auto_profile::preview;
use raw_core::view::{agx, encode};
use raw_core::xmp::AdjustmentModel;

#[derive(Default)]
struct Bands {
    count: [u64; 5],
    sum: [[f64; 3]; 5],
}

fn band(rgb: [f32; 3]) -> usize {
    let y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    [0.1, 0.25, 0.5, 0.75]
        .iter()
        .filter(|&&edge| y >= edge)
        .count()
}

impl Bands {
    fn add(&mut self, candidate: [f32; 3], target: [f32; 3]) {
        let b = band(target);
        self.count[b] += 1;
        for c in 0..3 {
            self.sum[b][c] += f64::from(candidate[c]) - f64::from(target[c]);
        }
    }
    fn finish(self) -> serde_json::Value {
        serde_json::json!((0..5)
            .map(|b| {
                let n = self.count[b];
                let bias = self.sum[b].map(|v| if n > 0 { v / n as f64 } else { 0.0 });
                serde_json::json!({"band": b, "n": n, "bias": bias,
                "measurable": n >= 100,
                "breach": n >= 100 && bias.iter().any(|v| v.abs() > 0.05)})
            })
            .collect::<Vec<_>>())
    }
}

fn summarize(pairs: &[DisplayPair], transform: impl Fn([f32; 3]) -> [f32; 3]) -> serde_json::Value {
    let mut bands = Bands::default();
    for p in pairs {
        bands.add(transform(p.maple), p.jpeg);
    }
    bands.finish()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("usage: auto_jpeg_fit_probe RAW OUTPUT.json".into());
    }
    let path = std::path::Path::new(&args[1]);
    let bytes = std::fs::read(path)?;
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let raw = decode_bytes(&bytes, &ext)?;
    let preview = preview::extract_for_fit(path).ok_or("no embedded preview")?;
    let model = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        ..Default::default()
    };
    let mut scene = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full)?;
    agx::apply(&mut scene, model.contrast, model.whites);
    color_grade::apply_model(&mut scene, &model);
    grain::apply(
        &mut scene,
        model.grain_amount,
        model.grain_size,
        model.grain_roughness,
    );
    encode::rec2020_to_srgb(&mut scene);
    encode::srgb_gamma_encode(&mut scene);
    let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut scene.pixels);
    let (w, h) = (scene.width as usize, scene.height as usize);
    let pairs = sample_display_pairs(
        pixels,
        w,
        h,
        preview.image.clone(),
        preview.color_space,
        raw.orientation,
    );
    let fitted = solve_acr_model_from_display_pairs(&pairs)?;
    let (_, lut) = raw_core::view::acr_fit::acr_model_as_profile_artifacts(
        &fitted,
        raw_core::view::auto_profile::bake::DEFAULT_LUT_SIZE,
    );
    let lut = lut.ok_or("fit produced no LUT")?;
    let inverse = M_REC2020_TO_SRGB.inverse().ok_or("singular matrix")?;
    let direct = |rgb: [f32; 3]| {
        let linear = rgb.map(srgb_gamma_inv);
        let out = apply_model(&fitted, inverse.mul_vec(linear));
        M_REC2020_TO_SRGB
            .mul_vec(out)
            .map(|v| encode::srgb_gamma(v.clamp(0.0, 1.0)))
    };
    let direct_bands = summarize(&pairs, direct);
    let baked_bands = summarize(&pairs, |v| lut.sample(v));
    let input_bands = summarize(&pairs, |v| v);
    drop(pairs);
    // The real application order is LUT on each native pixel BEFORE box means.
    lut.apply_with_strength(pixels, 1.0);
    let actual_pairs = sample_display_pairs(
        pixels,
        w,
        h,
        preview.image,
        preview.color_space,
        raw.orientation,
    );
    let pixel_bands = summarize(&actual_pairs, |v| v);
    let result = serde_json::json!({
        "purpose": "JPEG-pair fit diagnostic, not the physical PNG gate; default pinned prefix, no ACR inputs",
        "geometry": "production fit pair sampler: integer-span box means; physical gate independently uses Pillow BOX",
        "input": input_bands, "direct_model_on_pair_mean": direct_bands,
        "baked_lut_on_pair_mean": baked_bands, "baked_lut_before_pixel_mean": pixel_bands,
        "fit_stats": {"patches_used": fitted.stats.patches_used},
    });
    std::fs::write(&args[2], serde_json::to_vec_pretty(&result)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn white_is_in_highlight_band_and_empty_bands_do_not_pass_as_measured() {
        assert_eq!(band([1.0; 3]), 4);
        assert_eq!(band([0.0; 3]), 0);
        let empty = Bands::default().finish();
        assert!(empty
            .as_array()
            .unwrap()
            .iter()
            .all(|b| b["measurable"] == false));
    }
}
