//! Diagnostic-only Sony HSM attribution for #3633; never modifies the bundle.
//! Usage: sony-hsm-probe RAW XMP HSM_JSON NEW_OUTPUT_DIRECTORY
//! JSON contains dims, encoding, data1/data2 and source_sha256 extracted from
//! the installed Sony ILCE-7RM4 Adobe Standard DCP. Outputs must not exist.
use raw_core::color::{
    dcp,
    hsm::{HsmEncoding, HsmTable},
    profile_loader,
};
use raw_core::pipeline::{render_from_raw_with_quality_source_and_film, RawInput, RenderQuality};
use raw_core::types::adjustment::Profile;
use serde::Deserialize;
use std::{error::Error, path::Path};

#[derive(Deserialize)]
struct Input {
    source_sha256: String,
    dims: [u32; 3],
    encoding: u32,
    data1: Vec<f32>,
    data2: Vec<f32>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(
        args.len(),
        5,
        "RAW XMP HSM_JSON NEW_OUTPUT_DIRECTORY required"
    );
    let raw_path = Path::new(&args[1]);
    let out = Path::new(&args[4]);
    std::fs::create_dir(out)?;
    let input: Input = serde_json::from_str(&std::fs::read_to_string(&args[3])?)?;
    assert_eq!(input.dims, [90, 30, 1]);
    assert!(input.encoding <= 1);
    let mut raw = raw_core::decode::decode(raw_path)?;
    assert_eq!(raw.camera_make, "Sony");
    assert_eq!(raw.camera_model, "ILCE-7RM4");
    assert!(raw.hsm_data.is_empty());
    let bundle = profile_loader::lookup_profile(&raw).expect("Sony bundled profile");
    assert!(bundle.hsm1.is_none() && bundle.hsm2.is_none());
    let illum1 = bundle.illum1.expect("illuminant 1");
    let illum2 = bundle.illum2.expect("illuminant 2");
    let (before, source_before) = dcp::profile_for_with_source(&raw)?;
    assert!(before.hsm.is_none());
    let wb = raw.as_shot_neutral;
    let be = raw.baseline_exposure;
    let mut model = raw_core::xmp::parse(&std::fs::read_to_string(&args[2])?)?;
    model.profile = Profile::Neutral;
    raw_core::lens_profile::set_auto_match_enabled(false);
    let render = |raw: &raw_core::image::RawImage, name: &str| -> Result<(), Box<dyn Error>> {
        let (w, h, bytes) = render_from_raw_with_quality_source_and_film(
            raw,
            &model,
            RenderQuality::Amaze,
            Some(RawInput::Path(raw_path)),
            None,
        )?;
        std::fs::write(out.join(name), raw_core::png::encode(w, h, &bytes)?)?;
        println!("rendered {name}: {w}x{h}");
        Ok(())
    };
    println!("DCP SHA256 {}", input.source_sha256);
    println!(
        "source {source_before:?}; BE {be}; WB {wb:?}; black {:?}; white {}",
        raw.black_level, raw.white_level
    );
    render(&raw, "control.png")?;
    let encoding = HsmEncoding::from_u32(input.encoding);
    raw.hsm_data.insert(
        illum1,
        HsmTable::new(input.dims, input.data1, encoding).expect("valid HSM1"),
    );
    raw.hsm_data.insert(
        illum2,
        HsmTable::new(input.dims, input.data2, encoding).expect("valid HSM2"),
    );
    let (after, source_after) = dcp::profile_for_with_source(&raw)?;
    assert_eq!(source_before, source_after);
    assert_eq!(before.color_matrix.0, after.color_matrix.0);
    assert_eq!(
        before.forward_matrix.map(|m| m.0),
        after.forward_matrix.map(|m| m.0)
    );
    assert_eq!(before.scene_cct, after.scene_cct);
    assert_eq!(before.scene_white_xyz, after.scene_white_xyz);
    assert_eq!(before.wb_already_baked, after.wb_already_baked);
    assert_eq!(raw.as_shot_neutral, wb);
    assert_eq!(raw.baseline_exposure, be);
    assert!(after.hsm.is_some());
    assert!(before.look_table.is_none() && after.look_table.is_none());
    assert!(before.tone_curve.is_none() && after.tone_curve.is_none());
    println!("Resolved calibration invariants passed; only HSM added");
    render(&raw, "hsm.png")?;
    Ok(())
}
