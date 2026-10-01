//! #3875: apply one real Auto fit to already-developed NR diagnostic EXRs.
//! Usage: view-preview-noise RAW INPUT_EXR_DIRECTORY OUTPUT_DIRECTORY
//! Holds fit and working resolution fixed. This is not the export parity gate.
use exr::prelude::read_first_rgba_layer_from_file;
use raw_core::{
    image::{ColorSpace, Image},
    pipeline::{fit_auto_profile_from_raw_at_cap, FitCap, RawInput, RenderQuality},
    view::{agx, auto_profile::apply_curve, encode},
    xmp::AdjustmentModel,
};
use std::path::Path;

fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(args.len(), 4, "RAW INPUT_EXR_DIRECTORY OUTPUT_DIRECTORY");
    let path = Path::new(&args[1]);
    let raw = raw_core::decode::decode_bytes(
        &std::fs::read(path).unwrap(),
        path.extension().unwrap().to_str().unwrap(),
    )
    .unwrap();
    let model = AdjustmentModel::default();
    let (curve, residual) = fit_auto_profile_from_raw_at_cap(
        &raw,
        &model,
        RenderQuality::Preview,
        RawInput::Path(path),
        FitCap::Proxy,
    )
    .expect("fixture must yield a real Auto fit");
    let curve = curve.expect("Auto curve");
    let residual = residual.expect("Auto residual LUT");
    let output = Path::new(&args[3]);
    std::fs::create_dir_all(output).unwrap();
    for entry in std::fs::read_dir(&args[2]).unwrap() {
        let input = entry.unwrap().path();
        if input.extension().and_then(|v| v.to_str()) != Some("exr") {
            continue;
        }
        let decoded = read_first_rgba_layer_from_file(
            &input,
            |size, _| (size.x(), vec![[0.0_f32; 3]; size.x() * size.y()]),
            |(width, pixels), pos, (r, g, b, _): (f32, f32, f32, f32)| {
                pixels[pos.y() * *width + pos.x()] = [r, g, b];
            },
        )
        .unwrap();
        let size = decoded.layer_data.size;
        let mut image = Image::new(
            size.x() as u32,
            size.y() as u32,
            ColorSpace::SceneLinearRec2020,
        );
        image.pixels = decoded.layer_data.channel_data.pixels.1;
        // The traced default model has no display curves, grading or grain.
        // Apply Auto in float after gamma, before the sole quantization.
        agx::apply(&mut image, model.contrast, model.whites);
        encode::rec2020_to_srgb(&mut image);
        encode::srgb_gamma_encode(&mut image);
        let mut rgb: Vec<f32> = image.pixels.iter().flatten().copied().collect();
        apply_curve(&mut rgb, &curve);
        residual.apply(&mut rgb);
        for (pixel, channels) in image.pixels.iter_mut().zip(rgb.chunks_exact(3)) {
            pixel.copy_from_slice(channels);
        }
        let bytes = encode::dither_and_quantize(&mut image);
        let png = raw_core::png::encode(image.width, image.height, &bytes).unwrap();
        let name = input.file_stem().unwrap().to_str().unwrap();
        std::fs::write(output.join(format!("{name}.png")), png).unwrap();
        println!(
            "{name}: {}x{} fixed proxy Auto fit",
            image.width, image.height
        );
    }
}
