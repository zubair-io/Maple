//! Read-only #3633 attribution: existing scene anchoring On versus Off.
use raw_core::pipeline::{
    develop_scene_linear_from_raw_with_quality_with_gain,
    render_from_raw_with_quality_source_and_film, RawInput, RenderQuality,
};
use raw_core::types::adjustment::{AutoExposureMode, Profile};
use std::{error::Error, path::Path};
fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(args.len(), 4, "RAW XMP NEW_OUTPUT_DIRECTORY");
    let raw_path = Path::new(&args[1]);
    let raw = raw_core::decode::decode(raw_path)?;
    assert_eq!(raw.camera_model, "ILCE-7RM4");
    let out = Path::new(&args[3]);
    std::fs::create_dir(out)?;
    raw_core::lens_profile::set_auto_match_enabled(false);
    let mut model = raw_core::xmp::parse(&std::fs::read_to_string(&args[2])?)?;
    model.profile = Profile::Neutral;
    println!(
        "parsed AE {:?}; exposure {}; contrast {}; profile {:?}",
        model.auto_exposure, model.exposure, model.contrast, model.profile
    );
    let (scene, gain) =
        develop_scene_linear_from_raw_with_quality_with_gain(&raw, &model, RenderQuality::Amaze)?;
    println!(
        "anchor gain {gain}; EV {}; pixels {}x{}",
        gain.log2(),
        scene.width,
        scene.height
    );
    drop(scene);
    for (name, mode) in [("on", AutoExposureMode::On), ("off", AutoExposureMode::Off)] {
        model.auto_exposure = mode;
        let (w, h, pixels) = render_from_raw_with_quality_source_and_film(
            &raw,
            &model,
            RenderQuality::Amaze,
            Some(RawInput::Path(raw_path)),
            None,
        )?;
        std::fs::write(
            out.join(format!("{name}.png")),
            raw_core::png::encode(w, h, &pixels)?,
        )?;
        println!("rendered {name}: {w}x{h}");
    }
    Ok(())
}
