//! Generate the committed saturated P3 AVIF used by the Android decoder test.
use raw_core::{
    raster::RasterImage,
    raster_encode::EmbeddedMetadata,
    raster_encode_avif::{encode_avif_opts, AvifOptions},
    view::encode::TargetPrimaries,
};

fn main() {
    let pixels = (0..32 * 16)
        .flat_map(|i| match i % 32 / 8 {
            0 => [255, 0, 0],
            1 => [0, 255, 0],
            2 => [0, 0, 255],
            _ => [128, 128, 128],
        })
        .collect();
    let raster = RasterImage::new_rgb(32, 16, pixels);
    let icc = raw_core::icc::profile_for(TargetPrimaries::P3);
    let bytes = encode_avif_opts(
        &raster,
        &AvifOptions {
            quality: 100,
            effort: 1,
            bitdepth: 10,
            ..Default::default()
        },
        &EmbeddedMetadata {
            icc: Some(&icc),
            ..Default::default()
        },
        TargetPrimaries::P3,
    )
    .unwrap();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/android/wide-p3.avif");
    std::fs::write(path, bytes).unwrap();
}
