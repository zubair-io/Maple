//! Print the (clean_make, clean_model) of a RAW for camera_calibration table population.
//!
//! Usage: cargo run --release --example inspect-camera -- <path/to.raw>

use std::path::Path;

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: inspect-camera <path/to.raw>");
    let raw = raw_core::decode::decode(Path::new(&path)).expect("decode failed");
    println!("file:              {}", path);
    println!("camera_make:       {:?}", raw.camera_make);
    println!("camera_model:      {:?}", raw.camera_model);
    println!("unique_camera_model: {:?}", raw.unique_camera_model);
    let key = raw_core::color::profile_loader::camera_key_for(&raw);
    let bundled = raw_core::color::profile_loader::lookup_profile(&raw);
    println!("camera_key:        {:?}", key);
    println!(
        "bundled_profile:   {}",
        if bundled.is_some() { "HIT" } else { "MISS" }
    );
    if let Some(p) = bundled {
        println!("  illum1/2: {:?}/{:?}", p.illum1, p.illum2);
        println!("  cm1: {:?}", p.cm1.map(|m| m.0));
        println!("  cm2: {:?}", p.cm2.map(|m| m.0));
        println!("  fm1: {:?}", p.fm1.map(|m| m.0));
        println!("  fm2: {:?}", p.fm2.map(|m| m.0));
    }
    println!("baseline_exposure: {}", raw.baseline_exposure);
    println!(
        "as_shot_neutral:   [{:.4}, {:.4}, {:.4}]",
        raw.as_shot_neutral[0], raw.as_shot_neutral[1], raw.as_shot_neutral[2]
    );
    println!("cfa:               {:?}", raw.cfa);
    println!("dimensions:        {} x {}", raw.width, raw.height);
}
