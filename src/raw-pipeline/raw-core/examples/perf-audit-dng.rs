//! Writes a photographic synthetic Bayer DNG for the performance audit: the
//! `SyntheticPerfDng` container with a real photograph as its scene, so colour
//! stages see photographic statistics instead of the saturated test pattern.
//!
//! cargo run --release -p raw-core --features test-support --example perf-audit-dng -- \
//!     <photo.png> <width> <height> <out.dng> [noise=0.004]
use raw_core::image::CfaPattern;
use raw_core::test_support::synth_perf::SyntheticPerfDng;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (photo, width, height, out, noise) = match args.as_slice() {
        [photo, width, height, out] => (photo, width, height, out, 0.004),
        [photo, width, height, out, noise] => {
            (photo, width, height, out, noise.parse().expect("noise"))
        }
        _ => {
            eprintln!("usage: perf-audit-dng <photo.png> <width> <height> <out.dng> [noise]");
            std::process::exit(2);
        }
    };
    let photo = image::open(photo).expect("read photo").into_rgb8();
    let dng = SyntheticPerfDng {
        width: width.parse().expect("width"),
        height: height.parse().expect("height"),
        cfa: CfaPattern::Rggb,
    };
    dng.write_photo_to(std::path::Path::new(out), &photo, noise)
        .expect("write DNG");
    println!("wrote {out} ({}x{})", dng.width, dng.height);
}
