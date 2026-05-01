//! Print the (clean_make, clean_model) of a RAW for camera_calibration table population.
//!
//! Usage: cargo run --release --example inspect-camera -- <path/to.raw>

use std::path::Path;

fn main() {
    let path = std::env::args().nth(1).expect("usage: inspect-camera <path/to.raw>");
    let raw = raw_core::decode::decode(Path::new(&path)).expect("decode failed");
    println!("file:              {}", path);
    println!("camera_make:       {:?}", raw.camera_make);
    println!("camera_model:      {:?}", raw.camera_model);
    println!("baseline_exposure: {}", raw.baseline_exposure);
    println!(
        "as_shot_neutral:   [{:.4}, {:.4}, {:.4}]",
        raw.as_shot_neutral[0], raw.as_shot_neutral[1], raw.as_shot_neutral[2]
    );
    println!("cfa:               {:?}", raw.cfa);
    println!("dimensions:        {} x {}", raw.width, raw.height);
}
