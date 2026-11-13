//! Read-only sensor attribution for #3633; no demosaic or display transform.
//! Usage: sony-sensor-probe RAW NEW_OUTPUT_DIRECTORY
use std::{
    error::Error,
    io::{BufWriter, Write},
    path::Path,
};

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(args.len(), 3, "RAW NEW_OUTPUT_DIRECTORY required");
    let raw = raw_core::decode::decode(Path::new(&args[1]))?;
    assert_eq!(raw.camera_model, "ILCE-7RM4");
    let out = Path::new(&args[2]);
    std::fs::create_dir(out)?;
    let mut data = BufWriter::new(std::fs::File::create(out.join("sensor.u16le"))?);
    for value in &raw.raw_data {
        data.write_all(&value.to_le_bytes())?;
    }
    data.flush()?;
    let metadata = serde_json::json!({
        "width": raw.width, "height": raw.height,
        "black_level": raw.black_level, "white_level": raw.white_level,
        "as_shot_neutral": raw.as_shot_neutral,
        "baseline_exposure": raw.baseline_exposure,
        "cfa": format!("{:?}", raw.cfa),
        "crop_rect": format!("{:?}", raw.crop_rect),
        "active_area": format!("{:?}", raw.lens_metadata.active_area),
        "min": raw.raw_data.iter().min(), "max": raw.raw_data.iter().max(),
        "samples": raw.raw_data.len(),
    });
    std::fs::write(
        out.join("metadata.json"),
        serde_json::to_string_pretty(&metadata)?,
    )?;
    println!("{metadata}");
    Ok(())
}
