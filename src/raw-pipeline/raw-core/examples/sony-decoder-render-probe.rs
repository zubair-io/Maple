//! Diagnostic-only #3633: replace Sony sensor samples, preserving all metadata.
//! Usage: sony-decoder-render-probe RAW XMP LIBRAW_U16LE NEW_OUTPUT_DIRECTORY
use raw_core::pipeline::{render_from_raw_with_quality_source_and_film, RawInput, RenderQuality};
use raw_core::types::adjustment::Profile;
use std::{error::Error, path::Path};

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(
        args.len(),
        5,
        "RAW XMP LIBRAW_U16LE NEW_OUTPUT_DIRECTORY required"
    );
    let raw_path = Path::new(&args[1]);
    let mut raw = raw_core::decode::decode(raw_path)?;
    assert_eq!(raw.camera_model, "ILCE-7RM4");
    assert_eq!((raw.width, raw.height), (9600, 6376));
    let bytes = std::fs::read(&args[3])?;
    assert_eq!(bytes.len(), raw.raw_data.len() * 2);
    let samples: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|v| u16::from_le_bytes([v[0], v[1]]))
        .collect();
    assert_eq!(samples.len(), (raw.width * raw.height) as usize);
    let out = Path::new(&args[4]);
    std::fs::create_dir(out)?;
    let mut model = raw_core::xmp::parse(&std::fs::read_to_string(&args[2])?)?;
    model.profile = Profile::Neutral;
    raw_core::lens_profile::set_auto_match_enabled(false);
    // The ONLY RawImage field changed: metadata, dimensions, CFA, crop, black,
    // white, WB and resolved calibration remain from the same decoded source.
    raw.raw_data = samples;
    let (w, h, pixels) = render_from_raw_with_quality_source_and_film(
        &raw,
        &model,
        RenderQuality::Amaze,
        Some(RawInput::Path(raw_path)),
        None,
    )?;
    std::fs::write(
        out.join("libraw-samples.png"),
        raw_core::png::encode(w, h, &pixels)?,
    )?;
    println!(
        "Rendered {w}x{h}; black {:?}; white {}; WB {:?}; BE {}",
        raw.black_level, raw.white_level, raw.as_shot_neutral, raw.baseline_exposure
    );
    Ok(())
}
