//! #3875: apply one real Auto fit to already-developed NR diagnostic EXRs.
//! Usage: view-preview-noise RAW INPUT_EXR_DIRECTORY OUTPUT_DIRECTORY
//! [--full-fit] [--native-fit] [--output-edge=N]
//! Holds fit and working resolution fixed. This is not the export parity gate.
//! Also writes the Windows CPU's composed 33-cube/trilinear tail, using the
//! identical fit and display input, to isolate approximation from resize error.
use exr::prelude::read_first_rgba_layer_from_file;
use raw_core::{
    image::{ColorSpace, Image},
    pipeline::{
        downsample_image_area, fit_auto_profile_from_raw_at_cap, FitCap, RawInput, RenderQuality,
    },
    view::{
        agx,
        auto_profile::{apply_curve, bake_auto_profile_lut},
        encode,
    },
    xmp::AdjustmentModel,
};
use std::path::Path;

// Diagnostic mirror of RenderEngine.ApplyDisplayLut. Not a production sampler.
fn trilinear(rgb: &mut [f32], lut: &[f32], n: usize) {
    for pixel in rgb.chunks_exact_mut(3) {
        let p = [pixel[0], pixel[1], pixel[2]].map(|v| v.clamp(0.0, 1.0) * (n - 1) as f32);
        let lo = p.map(|v| v as usize);
        let hi = lo.map(|v| (v + 1).min(n - 1));
        let f = [
            p[0] - lo[0] as f32,
            p[1] - lo[1] as f32,
            p[2] - lo[2] as f32,
        ];
        for c in 0..3 {
            let at = |r, g, b| lut[((b * n + g) * n + r) * 3 + c];
            let x = |g, b| at(lo[0], g, b) * (1.0 - f[0]) + at(hi[0], g, b) * f[0];
            let y = |b| x(lo[1], b) * (1.0 - f[1]) + x(hi[1], b) * f[1];
            pixel[c] = y(lo[2]) * (1.0 - f[2]) + y(hi[2]) * f[2];
        }
    }
}

fn write_display(mut image: Image, rgb: &[f32], path: &Path, output_edge: Option<u32>) {
    for (pixel, channels) in image.pixels.iter_mut().zip(rgb.chunks_exact(3)) {
        pixel.copy_from_slice(channels);
    }
    // Use the same production Mitchell kernel as the scene trace reducer,
    // but after the display transform and before the sole quantization.
    if let Some(edge) = output_edge {
        downsample_image_area(&mut image, edge);
    }
    let bytes = encode::dither_and_quantize(&mut image);
    let png = raw_core::png::encode(image.width, image.height, &bytes).unwrap();
    std::fs::write(path, png).unwrap();
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert!(
        args.len() >= 4
            && args[4..].iter().all(|s| s == "--full-fit"
                || s == "--native-fit"
                || s.starts_with("--output-edge=")),
        "RAW INPUT_EXR_DIRECTORY OUTPUT_DIRECTORY [--full-fit] [--native-fit] [--output-edge=N]"
    );
    let output_edge = args[4..]
        .iter()
        .find_map(|s| s.strip_prefix("--output-edge="))
        .map(|s| s.parse::<u32>().expect("output edge must be an integer"));
    assert!(output_edge != Some(0), "output edge must be positive");
    let quality = if args[4..].iter().any(|s| s == "--full-fit") {
        RenderQuality::Full
    } else {
        RenderQuality::Preview
    };
    let cap = if args[4..].iter().any(|s| s == "--native-fit") {
        FitCap::Native
    } else {
        FitCap::Proxy
    };
    let path = Path::new(&args[1]);
    let raw = raw_core::decode::decode_bytes(
        &std::fs::read(path).unwrap(),
        path.extension().unwrap().to_str().unwrap(),
    )
    .unwrap();
    let model = AdjustmentModel::default();
    let (curve, residual) =
        fit_auto_profile_from_raw_at_cap(&raw, &model, quality, RawInput::Path(path), cap)
            .expect("fixture must yield a real Auto fit");
    let curve = curve.expect("Auto curve");
    let residual = residual.expect("Auto residual LUT");
    let baked = bake_auto_profile_lut(&curve, &residual, 33);
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
        let mut baked_rgb = rgb.clone();
        trilinear(&mut baked_rgb, &baked, 33);
        apply_curve(&mut rgb, &curve);
        residual.apply(&mut rgb);
        let name = input.file_stem().unwrap().to_str().unwrap();
        write_display(
            image.clone(),
            &baked_rgb,
            &output.join(format!("{name}-baked.png")),
            output_edge,
        );
        write_display(
            image.clone(),
            &rgb,
            &output.join(format!("{name}.png")),
            output_edge,
        );
        println!(
            "{name}: {}x{} fixed Auto fit ({quality:?}, {cap:?})",
            image.width, image.height
        );
    }
}
