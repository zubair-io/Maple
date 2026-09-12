//! Automatic lens correction from the bundled Lensfun database (#3564).
//!
//! Precedence, in order: embedded DNG `OpcodeList3` corrections (never
//! compounded), an explicit `papp:LensProfile` selection (`lcp1:` or
//! `lensfun1:`), then the automatic match from the RAW's own EXIF identity.
//! An automatic match writes nothing to the sidecar — like Auto Profile, it
//! is the product default and reproducible from the bundled snapshot.

use super::lensfun::{self, matcher, Match};
use super::{LensQuery, ProfileRef, Resolution, Source};
use crate::{AdjustmentModel, RawImage};

/// The shot's identity and settings as the resolver sees them.
pub(super) fn query_for(raw: &RawImage) -> LensQuery<'_> {
    LensQuery {
        make: raw
            .lens_metadata
            .camera_make
            .as_deref()
            .unwrap_or(&raw.camera_make),
        camera: raw
            .lens_metadata
            .camera_model
            .as_deref()
            .unwrap_or(&raw.camera_model),
        lens: raw.lens_metadata.lens_model.as_deref().unwrap_or(""),
        focal_mm: raw.focal_length.unwrap_or(0.0) as f64,
        f_number: raw.aperture.map(f64::from),
        focus_m: raw.lens_metadata.focus_m,
    }
}

fn frame_size(raw: &RawImage) -> (f64, f64) {
    raw.lens_metadata
        .active_area
        .map(|a| (f64::from(a.width), f64::from(a.height)))
        .unwrap_or((f64::from(raw.width), f64::from(raw.height)))
}

/// The bundled lens the RAW's EXIF identity names, if any.
pub fn auto_match(raw: &RawImage) -> Option<Match<'static>> {
    let q = query_for(raw);
    matcher::find(lensfun::database(), q.make, q.camera, q.lens)
}

fn resolve_match(raw: &RawImage, matched: &Match<'_>) -> Result<Resolution, String> {
    let (width, height) = frame_size(raw);
    lensfun::resolve::resolve(lensfun::database(), matched, width, height, &query_for(raw))
}

/// A manual `lensfun1:<slug>` pick, resolved for this RAW's body.
pub(super) fn resolve_slug(raw: &RawImage, slug: &str) -> Result<Resolution, String> {
    let db = lensfun::database();
    let q = query_for(raw);
    let camera = matcher::camera_named(db, q.make, q.camera)
        .ok_or("This camera body is not in the bundled lens database")?;
    let (lens, mount) = matcher::by_slug(db, slug, camera.crop)
        .ok_or("The sidecar names a bundled lens that does not fit this camera")?;
    let matched = Match {
        camera,
        lens,
        mount,
        slug: slug.to_owned(),
    };
    resolve_match(raw, &matched)
}

/// The automatic resolution, or `None` when the RAW carries its own
/// corrections or nothing in the bundle matches it.
pub fn resolve_auto(raw: &RawImage) -> Result<Option<Resolution>, String> {
    if raw.opcode_list3.is_some() {
        return Ok(None);
    }
    auto_match(raw)
        .map(|matched| resolve_match(raw, &matched))
        .transpose()
}

/// The resolution the develop path will apply for `model`: explicit
/// selection first, automatic match otherwise. `Ok(None)` means no external
/// correction (embedded corrections, no match, or nothing selected).
pub fn resolve_for_model(
    raw: &RawImage,
    model: &AdjustmentModel,
) -> Result<Option<Resolution>, String> {
    if model.lens_profile.is_empty() {
        resolve_auto(raw)
    } else {
        super::resolve_for_raw(raw, &model.lens_profile)
    }
}

/// Whether an approximation in `resolution` needs the user's explicit
/// acknowledgement before it is applied. An imported LCP is a deliberate
/// choice the user can ratify; a bundled match is the product default, so
/// its out-of-range clamps are reported, not gated.
pub(super) fn needs_acknowledgement(reference: &str, resolution: &Resolution) -> bool {
    !resolution.approximations.is_empty()
        && matches!(resolution.source, Source::Lcp)
        && !matches!(
            super::parse_reference(reference),
            Ok(ProfileRef::Lcp {
                acknowledged: true,
                ..
            })
        )
}

/// Whether the develop path has an external correction to run for this
/// shot: the scales are not all zero, and either the sidecar names a
/// profile or the bundle matches the RAW (embedded corrections excluded).
pub fn applies(raw: &RawImage, model: &AdjustmentModel) -> bool {
    use crate::pipeline::pano::opcode_apply::LensCorrectionScales;
    if LensCorrectionScales::from_model(model) == LensCorrectionScales::NONE
        || raw.opcode_list3.is_some()
    {
        return false;
    }
    !model.lens_profile.is_empty() || auto_match(raw).is_some()
}

/// Every bundled lens this RAW's body can carry, for the hosts' dropdown:
/// `[{"slug", "maker", "model"}]`, empty when the body is not in the bundle.
pub fn compatible_lenses(raw: &RawImage) -> serde_json::Value {
    let db = lensfun::database();
    let q = query_for(raw);
    let Some(camera) = matcher::camera_named(db, q.make, q.camera) else {
        return serde_json::json!([]);
    };
    matcher::compatible(db, camera)
        .into_iter()
        .map(|lens| {
            let mount = lens
                .mounts
                .iter()
                .copied()
                .find(|m| *m == camera.mount)
                .unwrap_or(lens.mounts[0]);
            serde_json::json!({
                "slug": matcher::slug(lens, &db.mounts[mount]),
                "maker": lens.maker,
                "model": lens.model,
            })
        })
        .collect::<Vec<_>>()
        .into()
}

/// The evidence JSON hosts display for `model` on this RAW, `Ok(None)` when
/// nothing external applies.
pub fn evidence_for(
    raw: &RawImage,
    model: &AdjustmentModel,
) -> Result<Option<serde_json::Value>, String> {
    Ok(resolve_for_model(raw, model)?.map(|r| r.metadata()))
}
