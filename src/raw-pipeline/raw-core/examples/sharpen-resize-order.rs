//! #3875 diagnostic: isolate sharpening/resizing order on identical scene pixels.
//! Usage: sharpen-resize-order PRE_SHARPEN_EXR OUTPUT EDGE
//! No production defaults or stages are changed. The reduced-radius candidate
//! uses the existing stage's legal radius clamp, not a replacement kernel.
use exr::prelude::read_first_rgba_layer_from_file;
use raw_core::{
    image::{ColorSpace, Image},
    pipeline::downsample_image_area,
    stages::sharpen,
    xmp::AdjustmentModel,
};
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(args.len(), 4, "PRE_SHARPEN_EXR OUTPUT EDGE");
    let edge: u32 = args[3].parse().expect("positive output edge");
    assert!(edge > 0);
    let decoded = read_first_rgba_layer_from_file(
        &args[1],
        |size, _| (size.x(), vec![[0.0_f32; 3]; size.x() * size.y()]),
        |(width, pixels), pos, (r, g, b, _): (f32, f32, f32, f32)| {
            pixels[pos.y() * *width + pos.x()] = [r, g, b];
        },
    )
    .expect("read scene-linear EXR");
    let size = decoded.layer_data.size;
    let mut native = Image::new(
        size.x() as u32,
        size.y() as u32,
        ColorSpace::SceneLinearRec2020,
    );
    native.pixels = decoded.layer_data.channel_data.pixels.1;
    let mut reduced = native.clone();
    downsample_image_area(&mut reduced, edge);
    let model = AdjustmentModel::default();
    let scale = reduced.width as f32 / native.width as f32;
    let output = Path::new(&args[2]);
    std::fs::create_dir_all(output).unwrap();
    println!(
        "native={}x{} reduced={}x{} scale={scale} radius={} amount={}",
        native.width,
        native.height,
        reduced.width,
        reduced.height,
        model.sharpen_radius,
        model.sharpen_amount
    );
    let apply = |image: &mut Image, radius| {
        sharpen::apply(
            image,
            model.sharpen_amount,
            radius,
            model.sharpen_detail,
            model.sharpen_masking,
        )
    };
    apply(&mut native, model.sharpen_radius);
    downsample_image_area(&mut native, edge);
    raw_core::stage_dump::dump_image("reference", &native, output);
    for (name, radius) in [
        ("unchanged-radius", model.sharpen_radius),
        (
            "scaled-radius",
            (model.sharpen_radius * scale).clamp(0.5, 3.0),
        ),
    ] {
        let mut candidate = reduced.clone();
        apply(&mut candidate, radius);
        raw_core::stage_dump::dump_image(name, &candidate, output);
        println!("{name}: radius={radius}");
    }
    // A zero-stage control measures the contribution; it is not a proposed fix.
    raw_core::stage_dump::dump_image("unsharpened-control", &reduced, output);
}
