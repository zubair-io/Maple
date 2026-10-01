//! #3875 diagnostic: isolate chroma NR/resampling order on identical pixels.
//! Usage: nr-resize-order <raw-file> <output-directory> [long-edge=1600]
//! Writes NR-before-resize, NR-after-resize, and no-NR controls. This is
//! deliberately not a production pipeline or a qualification replacement:
//! all paths share one developed scene and one Neutral display transform.
use raw_core::{
    image::Image,
    pipeline::{
        develop_scene_linear_from_raw_with_quality, downsample_image_area,
        render_from_scene_linear, RenderQuality,
    },
    stages::noise_reduction,
    types::adjustment::Profile,
    xmp::AdjustmentModel,
};
use std::{path::Path, time::Instant};

fn write_frame(out: &Path, name: &str, image: Image, model: &AdjustmentModel) {
    let (w, h, bytes) = render_from_scene_linear(image, model).expect("display transform");
    let png = raw_core::png::encode(w, h, &bytes).expect("encode PNG");
    std::fs::write(out.join(format!("{name}.png")), png).expect("write diagnostic");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(
        args.len() >= 3,
        "nr-resize-order <raw-file> <output-directory> [long-edge]"
    );
    let path = Path::new(&args[1]);
    let out = Path::new(&args[2]);
    let edge: u32 = args
        .get(3)
        .map(|s| s.parse().expect("long edge"))
        .unwrap_or(1600);
    assert!(edge > 0, "long edge must be positive");
    std::fs::create_dir_all(out).expect("output directory");
    let bytes = std::fs::read(path).expect("read RAW");
    let raw = raw_core::decode::decode_bytes(
        &bytes,
        path.extension().and_then(|e| e.to_str()).unwrap_or(""),
    )
    .expect("decode RAW");
    let amount = AdjustmentModel::default().nr_color;
    let model = AdjustmentModel {
        profile: Profile::Neutral,
        nr_color: 0.0,
        ..Default::default()
    };
    let scene = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Preview)
        .expect("develop common scene");
    println!(
        "scene={}x{} target={} amount={} iso={} noise_profile={:?}",
        scene.width, scene.height, edge, amount, raw.iso, raw.noise_profile
    );
    let mut resized = scene.clone();
    downsample_image_area(&mut resized, edge);
    write_frame(out, "no-nr", resized.clone(), &model);
    let started = Instant::now();
    noise_reduction::apply_color(&mut resized, amount, raw.noise_profile.as_deref(), raw.iso);
    println!("NR after resize: {:?}", started.elapsed());
    write_frame(out, "nr-after-resize", resized, &model);
    let mut native = scene;
    let started = Instant::now();
    noise_reduction::apply_color(&mut native, amount, raw.noise_profile.as_deref(), raw.iso);
    println!("NR before resize: {:?}", started.elapsed());
    downsample_image_area(&mut native, edge);
    write_frame(out, "nr-before-resize", native, &model);
}
