//! #3875 diagnostic: isolate sensor-noise-profile scaling after preview resize.
//! Usage: probe-preview-noise RAW SIZED_PRE_NR_EXR OUTPUT LINEAR_SCALE
//! This does not change production processing or establish display parity.
use exr::prelude::read_first_rgba_layer_from_file;
use raw_core::{
    image::{ColorSpace, Image},
    stages::noise_reduction,
};
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(args.len(), 5, "RAW SIZED_PRE_NR_EXR OUTPUT LINEAR_SCALE");
    let raw_path = Path::new(&args[1]);
    let raw = raw_core::decode::decode_bytes(
        &std::fs::read(raw_path).unwrap(),
        raw_path.extension().unwrap().to_str().unwrap(),
    )
    .unwrap();
    let profile = raw
        .noise_profile
        .as_ref()
        .expect("fixture needs a noise profile");
    let decoded = read_first_rgba_layer_from_file(
        &args[2],
        |size, _| (size.x(), vec![[0.0_f32; 3]; size.x() * size.y()]),
        |(width, pixels), pos, (r, g, b, _): (f32, f32, f32, f32)| {
            pixels[pos.y() * *width + pos.x()] = [r, g, b];
        },
    )
    .unwrap();
    let size = decoded.layer_data.size;
    let mut input = Image::new(
        size.x() as u32,
        size.y() as u32,
        ColorSpace::SceneLinearRec2020,
    );
    input.pixels = decoded.layer_data.channel_data.pixels.1;
    let scale: f32 = args[4].parse().unwrap();
    assert!(scale > 0.0 && scale <= 1.0);
    let output = Path::new(&args[3]);
    std::fs::create_dir_all(output).unwrap();
    println!("ISO={} noise_profile={profile:?} scale={scale}", raw.iso);
    for (name, variance_scale) in [
        ("unchanged", 1.0),
        ("linear", scale),
        ("area", scale * scale),
    ] {
        let scaled: Vec<f32> = profile.iter().map(|v| v * variance_scale).collect();
        let mut candidate = input.clone();
        noise_reduction::apply_color(&mut candidate, 25.0, Some(&scaled), raw.iso);
        raw_core::stage_dump::dump_image(name, &candidate, output);
        println!("{name}: variance scale={variance_scale}");
    }
}
