//! Stage timings for the embedded-preview thumbnail tier
//! (`maple_render_thumbnail_*_to_file`): a DNG carrying a camera-sized
//! baseline JPEG preview is extracted, resized and re-encoded exactly as the
//! FFI does, and each stage is timed.
//!
//! cargo run --release -p raw-core --features test-support,avif --example thumbnail-bench -- [W H]

use std::time::Instant;

fn photo_like(width: u32, height: u32) -> Vec<u8> {
    (0..height)
        .flat_map(|y| {
            (0..width).flat_map(move |x| {
                let hash = (x.wrapping_mul(2_654_435_761) ^ y.wrapping_mul(40_503)) >> 27;
                let fx = x as f32 / width as f32;
                let fy = y as f32 / height as f32;
                let ripple = ((fx * 37.0).sin() * (fy * 23.0).cos() * 40.0) as i32;
                [
                    (fx * 200.0) as i32 + ripple + hash as i32,
                    (fy * 180.0) as i32 - ripple + hash as i32,
                    ((fx + fy) * 90.0) as i32 + hash as i32,
                ]
                .map(|v| v.clamp(0, 255) as u8)
            })
        })
        .collect()
}

fn time<T>(label: &str, runs: u32, mut f: impl FnMut() -> T) -> T {
    let mut best = f64::MAX;
    let mut out = None;
    for _ in 0..runs {
        let start = Instant::now();
        out = Some(f());
        best = best.min(start.elapsed().as_secs_f64() * 1e3);
    }
    println!("{label:<44} {best:>9.2} ms");
    out.unwrap()
}

fn main() {
    let args: Vec<u32> = std::env::args()
        .skip(1)
        .filter_map(|a| a.parse().ok())
        .collect();
    let (width, height) = match args.as_slice() {
        [w, h, ..] => (*w, *h),
        _ => (6000, 4000),
    };
    let rgb = photo_like(width, height);
    let jpeg = raw_core::jpeg::encode(width, height, &rgb, 90).unwrap();
    let dng =
        raw_core::test_support::synth_dng_preview::dng_with_jpeg_preview(&jpeg, width, height);
    println!(
        "preview {width}x{height}, {:.1} MB JPEG, {:.1} MB DNG",
        jpeg.len() as f64 / 1e6,
        dng.len() as f64 / 1e6
    );
    let runs = 5;
    let (img, orientation) = time("extract_embedded_preview", runs, || {
        raw_core::preview::extract_embedded_preview(&dng, "dng").unwrap()
    });
    println!("-- Auto-profile fit downsample to 1536");
    let (fit_w, fit_h) = (1536, (1536 * height + width / 2) / width);
    time("  image crate Triangle (previous)", runs, || {
        img.resize_exact(fit_w, fit_h, image::imageops::FilterType::Triangle)
    });
    time("  resize_exact_triangle", runs, || {
        raw_core::preview::resize_exact_triangle(&img, fit_w, fit_h)
    });
    for (label, max_px, avif) in [
        ("grid thumb 512 AVIF q55", 512u32, true),
        ("describe preview 1280 JPEG q85", 1280, false),
        ("display preview 2048 JPEG q85", 2048, false),
    ] {
        println!("-- {label}");
        let mut copies = vec![img.clone(); runs as usize];
        let rgb8 = time("  resize_long_edge", runs, || {
            raw_core::preview::resize_long_edge(copies.pop().unwrap(), max_px)
        });
        let (w, h) = rgb8.dimensions();
        let oriented = time("  apply_orientation", runs, || {
            raw_core::image::apply_orientation(rgb8.as_raw(), w, h, orientation)
        });
        let (ow, oh, pixels) = oriented;
        time("  encode", runs, || {
            if avif {
                raw_core::avif::encode(ow, oh, &pixels, 55).unwrap()
            } else {
                raw_core::jpeg::encode(ow, oh, &pixels, 85).unwrap()
            }
        });
        time("  end-to-end (extract+resize+encode)", runs, || {
            let (img, orientation) =
                raw_core::preview::extract_embedded_preview(&dng, "dng").unwrap();
            let rgb8 = raw_core::preview::resize_long_edge(img, max_px);
            let (w, h) = rgb8.dimensions();
            let (ow, oh, px) = raw_core::image::apply_orientation(rgb8.as_raw(), w, h, orientation);
            if avif {
                raw_core::avif::encode(ow, oh, &px, 55).unwrap()
            } else {
                raw_core::jpeg::encode(ow, oh, &px, 85).unwrap()
            }
        });
    }
}
