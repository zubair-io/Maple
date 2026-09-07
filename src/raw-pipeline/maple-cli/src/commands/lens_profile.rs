//! Explicit CLI profile import and resolver diagnostics (#2435).
use raw_core::xmp;
use std::path::Path;

pub(super) fn select(
    model: &mut xmp::AdjustmentModel,
    lens_profile: Option<(&Path, bool)>,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some((path, acknowledged)) = lens_profile {
        let registration = raw_core::lens_profile::register(&std::fs::read_to_string(path)?)?;
        let reference = registration["reference"]
            .as_str()
            .ok_or("LCP registration has no reference")?;
        model.lens_profile = if acknowledged {
            reference.replacen("lcp1:", "lcp1-ack:", 1)
        } else {
            reference.to_owned()
        };
        eprintln!("LCP selection: {}", model.lens_profile);
    }
    Ok(())
}

/// Print real resolver evidence once per CLI render, including embedded priority.
pub(super) fn report_lens_resolution(
    raw: &raw_core::RawImage,
    model: &xmp::AdjustmentModel,
) -> Result<(), Box<dyn std::error::Error>> {
    if model.lens_profile.is_empty() {
        return Ok(());
    }
    if raw.opcode_list3.is_some() {
        eprintln!("Lens correction source: embedded OpcodeList3 (external profile not applied)");
    } else if let Some(resolution) =
        raw_core::lens_profile::resolve_for_raw(raw, &model.lens_profile)?
    {
        eprintln!("Lens correction: {}", resolution.metadata());
    }
    Ok(())
}
