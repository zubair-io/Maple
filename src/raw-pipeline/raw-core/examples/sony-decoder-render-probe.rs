//! Diagnostic-only #3633: replace Sony sensor samples, preserving all metadata.
//! Usage: sony-decoder-render-probe RAW XMP LIBRAW_U16LE NEW_OUTPUT_DIRECTORY
use raw_core::pipeline::{render_from_raw_with_quality_source_and_film, RawInput, RenderQuality};
use raw_core::types::adjustment::Profile;
use std::{
    error::Error,
    io::{BufReader, Read},
    path::Path,
};

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
    assert_eq!(raw.raw_data.len(), (raw.width * raw.height) as usize);
    let sample_file = std::fs::File::open(&args[3])?;
    let expected_bytes = (raw.raw_data.len() * std::mem::size_of::<u16>()) as u64;
    assert_eq!(sample_file.metadata()?.len(), expected_bytes);
    let mut reader = BufReader::new(sample_file);
    let mut sample_bytes = [0; 2];
    for sample in &mut raw.raw_data {
        reader.read_exact(&mut sample_bytes)?;
        *sample = u16::from_le_bytes(sample_bytes);
    }
    let out = Path::new(&args[4]);
    std::fs::create_dir(out)?;
    let mut model = raw_core::xmp::parse(&std::fs::read_to_string(&args[2])?)?;
    model.profile = Profile::Neutral;
    raw_core::lens_profile::set_auto_match_enabled(false);
    // The ONLY RawImage field changed: metadata, dimensions, CFA, crop, black,
    // white, WB and resolved calibration remain from the same decoded source.
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
