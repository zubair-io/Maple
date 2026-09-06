//! Reproduce the committed, tiny paired RAWs used by Apple/Web #3311 tests.
//! Run with `cargo run -p raw-core --features test-support --example
//! gen-batch-transfer-fixtures -- <repo>/test-fixtures/batch-transfer`.
use raw_core::{
    color::{
        dcp::{estimate_as_shot_cct_tint, profile_for_with_source, ProfileSource},
        matrices::M_XYZ_D65_TO_REC2020,
    },
    decode::decode_bytes,
    test_support::synth_dng::SyntheticGreyDng,
};
use std::{fs, path::PathBuf};

fn gradient_bytes(width: u32, height: u32, neutral: [f32; 3]) -> Vec<u8> {
    let mut bytes = SyntheticGreyDng {
        width,
        height,
        as_shot_neutral_override: Some(neutral),
        // Declare a calibrated Rec.2020 sensor, as the synthetic chart does.
        // Identity CM is deliberately rejected as placeholder calibration.
        color_matrix_1_override: Some(M_XYZ_D65_TO_REC2020.0),
        calibration_illuminant_1_override: Some(21),
        ..Default::default()
    }
    .write_to_bytes();
    let ifd = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes(bytes[ifd..ifd + 2].try_into().unwrap()) as usize;
    let entry = (0..count)
        .map(|i| ifd + 2 + i * 12)
        .find(|&i| u16::from_le_bytes(bytes[i..i + 2].try_into().unwrap()) == 273)
        .unwrap();
    let strip = u32::from_le_bytes(bytes[entry + 8..entry + 12].try_into().unwrap()) as usize;
    for y in 0..height {
        for x in 0..width {
            let i = strip + ((y * width + x) * 2) as usize;
            let value = u16::from_le_bytes(bytes[i..i + 2].try_into().unwrap());
            // A two-dimensional gradient makes misplaced crops observably wrong.
            let factor = 0.4 + (x / 2) as f32 / width as f32 + (y / 2) as f32 / height as f32;
            bytes[i..i + 2]
                .copy_from_slice(&((value as f32 * factor).round() as u16).to_le_bytes());
        }
    }
    bytes
}
fn main() {
    let destination = PathBuf::from(std::env::args().nth(1).expect("fixture directory"));
    fs::create_dir_all(&destination).unwrap();
    let mut baselines = Vec::new();
    for (name, width, height, neutral) in [
        ("source", 96, 64, [0.95047, 1.0, 1.08883]),
        ("target", 80, 120, [1.0098, 1.0, 0.6445]),
    ] {
        let bytes = gradient_bytes(width, height, neutral);
        let raw = decode_bytes(&bytes, "dng").unwrap();
        assert!(matches!(
            profile_for_with_source(&raw).unwrap().1,
            ProfileSource::EmbeddedCmOnly { .. }
        ));
        let (temperature, tint) = estimate_as_shot_cct_tint(&raw).unwrap();
        fs::write(destination.join(format!("{name}.dng")), bytes).unwrap();
        baselines.push(serde_json::json!({"name":name,"width":width,"height":height,"temperature":(temperature/50.).round()*50.,"tint":tint.round()}));
    }
    let value = serde_json::json!({"fixtures":baselines,"correction":{"temperature":1200,"tint":10},"crop":{"top":0.25,"left":0.25,"bottom":0.75,"right":0.75,"angle":0}});
    fs::write(
        destination.join("pair.json"),
        serde_json::to_string_pretty(&value).unwrap() + "\n",
    )
    .unwrap();
    println!("{value}");
}
