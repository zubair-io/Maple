//! `maple-cli synthetic` — generate a synthetic scene-linear input and run
//! it through the view transform (or the slider chain when `--params` is
//! given). Used by the diagnostic harnesses (`test_banding.sh`,
//! `test_hue_stability.sh`, `test_halo_detection.sh`). Honours
//! `MAPLE_STAGE_DUMP` for per-stage EXR output via raw-core's view path.

use raw_core::pipeline::{render_from_scene_linear, render_from_scene_linear_with_chain};
use raw_core::synthetic_input::{chroma_ramp, halo_disk, hue_patch, neutral_ramp, Primary, RampHue};
use raw_core::xmp;
use std::path::Path;

use super::types::SyntheticKind;

pub fn run(
    kind: SyntheticKind,
    primary: Option<&str>,
    hue: Option<&str>,
    ev: f32,
    out: &Path,
    width: Option<u32>,
    height: Option<u32>,
    params: Option<&Path>,
) -> Result<i32, Box<dyn std::error::Error>> {
    let model = match params {
        Some(p) => xmp::parse(&std::fs::read_to_string(p)?)?,
        None => xmp::AdjustmentModel::default(),
    };

    // Per-kind defaults give the detectors enough resolution to be
    // useful without wasting time on huge buffers.
    let (default_w, default_h) = match kind {
        SyntheticKind::NeutralRamp => (1024u32, 8u32),
        SyntheticKind::HuePatch => (64u32, 64u32),
        SyntheticKind::HaloDisk => (256u32, 256u32),
        SyntheticKind::ChromaRamp => (1024u32, 8u32),
    };
    let w = width.unwrap_or(default_w);
    let h = height.unwrap_or(default_h);

    // Validate against each kind's minimum dimensions BEFORE calling the
    // generator — otherwise raw_core::synthetic_input::* panics on failed
    // assertions (the generators use `assert!`, which fires in both debug
    // and release builds) and leaves the user with a stack trace instead of
    // a CLI error. Constraints mirror the asserts in synthetic_input.rs.
    let (min_w, min_h) = match kind {
        SyntheticKind::NeutralRamp => (2u32, 1u32),
        SyntheticKind::HuePatch => (1u32, 1u32),
        SyntheticKind::HaloDisk => (4u32, 4u32),
        SyntheticKind::ChromaRamp => (2u32, 1u32),
    };
    if w < min_w || h < min_h {
        return Err(format!(
            "--kind {:?}: width must be >= {} and height must be >= {} (got {}x{})",
            kind, min_w, min_h, w, h,
        )
        .into());
    }

    let image = match kind {
        SyntheticKind::NeutralRamp => neutral_ramp(w, h),
        SyntheticKind::HuePatch => {
            let letter = primary.ok_or("--primary is required for --kind hue-patch")?;
            let p = Primary::from_letter(letter).ok_or_else(|| {
                format!("--primary '{}' not recognised — use r/g/b/c/m/y", letter)
            })?;
            hue_patch(p, ev, w, h)
        }
        SyntheticKind::HaloDisk => halo_disk(w, h),
        SyntheticKind::ChromaRamp => {
            let slug = hue.ok_or("--hue is required for --kind chroma-ramp")?;
            let rh = RampHue::from_slug(slug).ok_or_else(|| {
                format!(
                    "--hue '{}' not recognised — use foliage/blue/magenta/skin",
                    slug
                )
            })?;
            chroma_ramp(rh, w, h)
        }
    };

    // With `--params`, run the slider chain so clarity / dehaze etc.
    // take effect — needed by the halo detector to compare
    // clarity=+100 / dehaze=+100 against a clean control. Without
    // `--params`, only AgX + sRGB encode run (the cheap path for
    // banding / hue-stability detectors that don't care about the
    // slider stages).
    let (w_out, h_out, bytes) = if params.is_some() {
        render_from_scene_linear_with_chain(image, &model)?
    } else {
        render_from_scene_linear(image, &model)?
    };
    let png = raw_core::png::encode(w_out, h_out, &bytes)?;
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(out, png)?;
    Ok(0)
}
