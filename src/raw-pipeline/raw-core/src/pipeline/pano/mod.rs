//! Panorama ingest entry point — `decode_for_pano` (#1156, epic #1094).
//!
//! Maple Pano's stitcher (the `maple-pano` crate) needs **unbiased
//! scene-referred linear pixels**: feature descriptors, gain compensation,
//! and bundle adjustment all assume the only thing separating two
//! overlapping frames is the camera rotation and a scalar exposure gain.
//! Any display-prep stage (per-image auto-exposure anchoring, capture
//! sharpening, auto-profile/histogram fitting, the view transform) breaks
//! that assumption per-image.
//!
//! [`decode_for_pano`] is therefore the canonical develop chain
//! ([`super::develop`]) **truncated after the decode-referred stages**,
//! plus one pano-only stage the canonical chain does not run yet (2a):
//!
//! 1. `linearize` (black/white level; or `linearraw_to_camera_rgb`),
//! 2. `demosaic` at `RenderQuality::Full`,
//! 2a. **DNG OpcodeList3** when present (#1159): `GainMap`
//!     (vignette/shading) and `WarpRectilinear` (geometric distortion +
//!     lateral CA), applied in list order on the demosaiced linear data
//!     — the DNG processing-model stage for List3. See [`opcodes`] /
//!     [`opcode_apply`] and the divergence note below,
//! 3. DNG § 6.3 DefaultCrop,
//! 4. DNG § C.1.2 BaselineExposure gain,
//! 5. DNG WB pre-gain (`AsShotNeutral`),
//! 6. highlight recovery (default `ChromaticAdaptation` — sensor-signal
//!    reconstruction of clipped channels, *not* display prep; without it
//!    clipped skies feed magenta-fringed pixels to the matcher),
//! 7. DCP `profile_for` + `apply_colorimetry` (CM/FM + HSM →
//!    scene-linear Rec.2020 D65),
//! 8. ProfileGainTableMap when present (DNG 1.6 § 6.8 spatially-varying
//!    calibration gain — the in-file lens-shading/vignette mechanism
//!    raw-core already applies),
//! 9. EXIF orientation.
//!
//! **Excluded — everything after PGTM in the canonical chain:** the
//! decode-time denoisers (`chroma_prefilter`, `deep_denoise` — default-off
//! anyway), capture sharpening, damped auto-exposure (#429), user white
//! balance / tone / color / effects stages, sharpen, and noise reduction.
//! The output is the scene as the calibrated sensor saw it, in the
//! Rec.2020 D65 linear f32 working space, **unbounded** (nothing clips).
//!
//! The stage composition is glue-mirrored from
//! [`super::develop::develop_scene_linear_from_raw_with_quality_cancellable`]
//! (same stage functions, same order, never-cancel token, default
//! camera-calibration knobs). `tests::matches_develop_with_display_stages_zeroed`
//! locks the two paths together bit-for-bit on a synthetic DNG, so the
//! mirror cannot drift silently.
//!
//! ## OpcodeList3 — a deliberate pano-path divergence (#1159)
//!
//! Stage 2a is the one place `decode_for_pano` is more than a truncation
//! of the canonical chain. The DJI pano fixtures carry their lens
//! corrections as DNG `OpcodeList3` opcodes, *not* as a
//! ProfileGainTableMap: the L2D-20c (`pano_01`) writes `GainMap` +
//! `WarpRectilinear`, the L3D-100c (`pano_00`) `WarpRectilinear` only.
//! Without them, the stitcher sees 5–80 px reprojection residuals
//! (frames get dropped at the spec §5.3 1.5/6 px gates) and vignette
//! banding at seams — the stitching spec (§5.1) requires vignette
//! correction **before** matching.
//!
//! The canonical develop chain does not apply opcodes anywhere yet;
//! adopting them there is a budgets-ratchet decision that needs a full
//! color-harness evaluation (ACR applies opcodes, so this likely
//! *improves* parity on opcode-carrying bodies) — tracked in #1190.
//! Until that lands, the bit-pin test compares the two paths on
//! opcode-free sources (where stage 2a is structurally a no-op), and
//! `tests::applies_opcode_list3_on_dji_fixtures` proves the divergence is
//! real on opcode-carrying sources.

pub mod opcode_apply;
pub mod opcodes;

use rawler::decoders::{RawDecodeParams, WellKnownIFD};
use rawler::rawsource::RawSource;
use rawler::tags::{ExifTag, TiffCommonTag};

use crate::{
    cancel::CancelToken,
    color::dcp,
    demosaic,
    error::Result,
    image::{CfaPattern, ExifOrientation, Image, RawImage},
    linearize,
    stages::{highlight_recovery, white_balance},
    types::HighlightRecoveryMode,
};

use super::{
    develop::{crop_to_default, effective_quality_divisor},
    dump_after,
    render::native_render_dims,
    stage, RenderQuality,
};

/// Source metadata the pano stitcher needs alongside the pixels.
///
/// Everything except the camera identity and orientation is optional —
/// vendor RAWs vary in which EXIF/XMP fields they ship. The *derivations*
/// (focal length in pixels, gimbal rotation prior) live in
/// `maple-pano`'s `ingest` module; this struct carries the raw fields.
#[derive(Clone, Debug)]
pub struct PanoSourceMetadata {
    /// Camera make as decoded (e.g. `"Hasselblad"` for DJI Mavic 3 bodies).
    pub camera_make: String,
    /// Camera model as decoded (e.g. `"L2D-20c"`).
    pub camera_model: String,
    /// DNG `UniqueCameraModel` (tag 50708) when present.
    pub unique_camera_model: Option<String>,
    /// EXIF `FocalLength` (tag 0x920A) in millimetres, when present and
    /// positive.
    pub focal_mm: Option<f32>,
    /// EXIF `FocalLengthIn35mmFormat` (tag 0xA405) in millimetres, when
    /// present and positive. Integer-rounded by every known camera
    /// firmware (the DJI L2D-20c writes 24 for a true 24.6), so focal
    /// derivations from it carry a ~2–3 % error — fine for a bundle-
    /// adjustment seed, which is its only consumer.
    pub focal_35mm_equiv: Option<f32>,
    /// EXIF orientation of the source. [`decode_for_pano`] has already
    /// applied it to the pixel buffer; carried for diagnostics.
    pub orientation: ExifOrientation,
    /// The dimensions [`decode_for_pano`]'s image has after DefaultCrop +
    /// orientation (also available without paying for a develop via
    /// [`read_pano_metadata`] — the 21-frame priors pass uses that).
    pub output_dims: (u32, u32),
    /// The raw XMP packet (TIFF tag 700) verbatim, when the source carries
    /// one. DJI drone bodies store the gimbal yaw/pitch/roll prior here
    /// (`drone-dji:Gimbal{Yaw,Pitch,Roll}Degree` attributes); parsing is
    /// `maple_pano::ingest`'s job — raw-core stays vendor-namespace-free.
    pub xmp_packet: Option<Vec<u8>>,
}

/// A decoded, normalized pano source frame: scene-linear Rec.2020 D65 f32
/// pixels (EXIF-oriented, DefaultCrop applied, **no display prep**) plus
/// the metadata fields the stitcher derives its priors from.
#[derive(Clone, Debug)]
pub struct PanoIngest {
    /// `ColorSpace::SceneLinearRec2020`, unbounded, display-oriented.
    pub image: Image,
    pub metadata: PanoSourceMetadata,
    /// Labels of the `OpcodeList3` corrections that ran (stage 2a, #1159)
    /// — e.g. `["GainMap(…)", "WarpRectilinear(…)"]`; empty when the
    /// source carries none. Decode-time fact, surfaced so the stitch
    /// report can show which frames were lens-corrected.
    pub applied_opcodes: Vec<String>,
}

/// Decode a RAW byte slice into a [`PanoIngest`] (see module docs for the
/// exact stage list). `ext` is the lowercase file-extension hint, exactly
/// as in [`crate::decode_raw`].
pub fn decode_for_pano(bytes: &[u8], ext: &str) -> Result<PanoIngest> {
    let raw = crate::decode::decode_bytes(bytes, ext)?;
    // Stage 2a inputs (#1159): best-effort — a source without (parseable)
    // opcodes develops exactly as before.
    let list3 = opcodes::read_opcode_list3(bytes, ext, raw.width, raw.height);
    let (scene, applied_opcodes) = develop_scene_linear_for_pano(&raw, list3.as_ref())?;
    let image = stage("pano_orient", || {
        orient_scene_linear(scene, raw.orientation)
    });
    let metadata = read_pano_metadata_from_parts(bytes, ext, &raw);
    Ok(PanoIngest {
        image,
        metadata,
        applied_opcodes,
    })
}

/// Metadata-only variant of [`decode_for_pano`]: same
/// [`PanoSourceMetadata`] (including `output_dims`), **without running the
/// develop chain**. Costs one rawler decode of the container (the raw strip
/// is read but never linearized/demosaiced), so a many-frame priors pass —
/// e.g. printing the gimbal table for a 21-frame pano — stays cheap.
pub fn read_pano_metadata(bytes: &[u8], ext: &str) -> Result<PanoSourceMetadata> {
    let raw = crate::decode::decode_bytes(bytes, ext)?;
    Ok(read_pano_metadata_from_parts(bytes, ext, &raw))
}

/// The truncated develop chain (module docs stages 1–8). Pre-orientation.
///
/// Glue-mirror of `develop_scene_linear_from_raw_with_quality_cancellable`
/// at `RenderQuality::Full` with a never-cancel token and the default
/// camera-calibration knobs (hot-pixel suppression Off, highlight recovery
/// `ChromaticAdaptation`); every stage call below names the same function
/// the canonical chain calls. Locked together by
/// `tests::matches_develop_with_display_stages_zeroed`.
fn develop_scene_linear_for_pano(
    raw: &RawImage,
    list3: Option<&(opcodes::OpcodeList3, opcodes::ActiveAreaRect)>,
) -> Result<(Image, Vec<String>)> {
    let never = CancelToken::never();
    let quality = RenderQuality::Full;
    let mut camera_rgb = match raw.cfa {
        CfaPattern::LinearRgb => stage("pano_linearraw_decode", || {
            linearize::linearraw_to_camera_rgb(raw)
        })?,
        CfaPattern::XTrans(_) => {
            let mosaic = stage("pano_linearize", || linearize::sensor_linearize(raw));
            // hot_pixel: default Off is a bit-identical no-op — skipped.
            stage("pano_demosaic_xtrans", || {
                demosaic::markesteijn(&mosaic, raw.cfa)
            })
        }
        _ => {
            let mosaic = stage("pano_linearize", || linearize::sensor_linearize(raw));
            // hot_pixel: default Off is a bit-identical no-op — skipped.
            stage("pano_demosaic", || {
                #[cfg(feature = "high-quality-demosaic")]
                {
                    demosaic::hamilton_adams(&mosaic, raw.cfa)
                }
                #[cfg(not(feature = "high-quality-demosaic"))]
                {
                    demosaic::bilinear_cancellable(&mosaic, raw.cfa, never)
                }
            })
        }
    };

    // Stage 2a (#1159): DNG OpcodeList3 on the demosaiced linear data, in
    // ActiveArea coordinates — i.e. BEFORE DefaultCrop moves the origin.
    // The pano-only divergence from the canonical chain (module docs).
    let mut applied_opcodes = Vec::new();
    if let Some((list, aa)) = list3 {
        stage("pano_opcode_list3", || {
            // Pano ingest always wants the vendor's corrections at full
            // strength: the stitcher's reprojection residuals and seam
            // matching are specified against geometrically-corrected,
            // vignette-flattened frames (#1159), so the per-image user
            // scales (#376) deliberately do not reach this path.
            applied_opcodes = opcode_apply::apply_opcode_list3(
                &mut camera_rgb,
                list,
                *aa,
                opcode_apply::LensCorrectionScales::FULL,
            );
        });
        dump_after("pano_00a_opcode_list3", &camera_rgb);
    }

    // DNG § 6.3 DefaultCrop — same call as develop; divisor is 1 at Full
    // for every CFA but we mirror the canonical call shape exactly.
    if let Some(crop) = raw.crop_rect {
        if let Some(cropped) = stage("pano_crop_to_default", || {
            crop_to_default(
                &camera_rgb,
                crop,
                effective_quality_divisor(quality, raw.cfa),
            )
        }) {
            camera_rgb = cropped;
        }
    }
    dump_after("pano_00b_crop_to_default", &camera_rgb);

    // DNG § C.1.2 BaselineExposure — scene-linear gain prior to the color
    // transform. Mirrors develop's inline multiply verbatim.
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("pano_baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }
    dump_after("pano_01_baseline_exposure", &camera_rgb);

    // DNG WB pre-gain (spec § 1.4.4.5 step 4) — skipped for 8-bit lossy
    // LinearRaw exactly as in develop (WB stays baked there).
    let skip_pre_gain = matches!(raw.cfa, CfaPattern::LinearRgb) && raw.white_level <= 255;
    if !skip_pre_gain {
        stage("pano_white_balance::apply_pre_gain", || {
            white_balance::apply_pre_gain(&mut camera_rgb, raw.as_shot_neutral)
        });
    }
    // Clipped-channel reconstruction with the canonical default mode. The
    // per-channel ceilings mirror develop's hr_neutral selection.
    let hr_neutral = if skip_pre_gain {
        [1.0; 3]
    } else {
        raw.as_shot_neutral
    };
    stage("pano_highlight_recovery", || {
        highlight_recovery::apply(
            &mut camera_rgb,
            HighlightRecoveryMode::default(),
            hr_neutral,
        )
    });
    dump_after("pano_02_highlight_recovery", &camera_rgb);

    // DCP colorimetry: camera RGB → scene-linear Rec.2020 D65. CM/FM + HSM
    // only (the Adobe aesthetic layers PTC/PLT don't run — #425).
    let profile = stage("pano_dcp::profile_for", || dcp::profile_for(raw))?;
    let mut scene = stage("pano_dcp::apply", || {
        dcp::apply_colorimetry(&camera_rgb, &profile)
    })?;
    dump_after("pano_03_dcp_apply", &scene);

    // highlight_recovery_oklab::apply_post_dcp is a documented no-op for
    // the default `ChromaticAdaptation` mode — skipped.

    // ProfileGainTableMap (DNG 1.6 § 6.8) — in-file spatially-varying
    // calibration gain (lens shading / vignette), scene-linear Rec.2020.
    // No-op when the source doesn't ship the tag (the DJI pano fixtures
    // don't — their vignette arrives via the stage-2a OpcodeList3 GainMap
    // instead; see module docs).
    if let Some(pgtm) = raw.profile_gain_table_map.as_ref() {
        stage("pano_profile_gain_table_map", || {
            crate::color::profile_gain_table_map::apply(&mut scene, pgtm)
        });
    }
    dump_after("pano_04_profile_gain_table_map", &scene);

    // STOP — everything downstream of PGTM in the canonical chain is
    // display prep or user adjustment (see module docs).
    Ok((scene, applied_opcodes))
}

/// Apply EXIF orientation to a `[f32; 3]` RGB `Image`.
///
/// Same per-orientation source mapping as [`crate::image::apply_orientation`]
/// (u8 RGB) and `pipeline::orient::apply_orientation_f32_rgba` (f32 RGBA) —
/// reproduced here for the interleaved `[f32; 3]` layout so the pano path
/// never quantizes and never pays for a phantom alpha lane.
/// `tests::orient_matches_u8_reference_for_all_orientations` pins this
/// mapping to the canonical u8 implementation.
fn orient_scene_linear(image: Image, orient: ExifOrientation) -> Image {
    if orient == ExifOrientation::Normal {
        return image;
    }
    let (sw, sh) = (image.width as usize, image.height as usize);
    let (new_w, new_h) = if orient.swaps_wh() {
        (image.height, image.width)
    } else {
        (image.width, image.height)
    };
    let (dw, dh) = (new_w as usize, new_h as usize);
    let mut out = Image::new(new_w, new_h, image.space);
    for yp in 0..dh {
        for xp in 0..dw {
            let (sx, sy) = match orient {
                ExifOrientation::Normal => (xp, yp),
                ExifOrientation::HorizontalFlip => (sw - 1 - xp, yp),
                ExifOrientation::Rotate180 => (sw - 1 - xp, sh - 1 - yp),
                ExifOrientation::VerticalFlip => (xp, sh - 1 - yp),
                ExifOrientation::Transpose => (yp, xp),
                ExifOrientation::Rotate90 => (yp, sh - 1 - xp),
                ExifOrientation::Transverse => (sw - 1 - yp, sh - 1 - xp),
                ExifOrientation::Rotate270 => (sw - 1 - yp, xp),
            };
            out.pixels[yp * dw + xp] = image.pixels[sy * sw + sx];
        }
    }
    out
}

/// Assemble [`PanoSourceMetadata`] from the source bytes + the decoded
/// [`RawImage`]. Best-effort: a metadata read failure degrades the
/// affected `Option` field to `None`, never the whole decode.
///
/// Runs its own rawler metadata pass (same pattern as
/// [`crate::api::read_exif`] — cheap relative to a develop): `decode_bytes`
/// doesn't surface the EXIF focal tags or the XMP packet, and re-using its
/// internal decoder would mean threading rawler types through `RawImage`.
fn read_pano_metadata_from_parts(bytes: &[u8], ext: &str, raw: &RawImage) -> PanoSourceMetadata {
    let hint_path = format!("rawfile.{}", ext);
    let source = RawSource::new_from_slice(bytes).with_path(std::path::Path::new(&hint_path));
    let params = RawDecodeParams::default();
    let decoder = rawler::get_decoder(&source).ok();

    // EXIF FocalLength via rawler's metadata pass (Rational → f32).
    let focal_mm = decoder
        .as_ref()
        .and_then(|dec| dec.raw_metadata(&source, &params).ok())
        .and_then(|md| md.exif.focal_length)
        .map(|r| {
            if r.d == 0 {
                0.0
            } else {
                r.n as f32 / r.d as f32
            }
        })
        .filter(|v| *v > 0.0);

    // EXIF FocalLengthIn35mmFormat (0xA405) — rawler's `Exif` struct does
    // not carry it, so read the tag from the Exif IFD (falling back to a
    // recursive Root-IFD search for containers that inline it).
    let root_ifd = decoder
        .as_ref()
        .and_then(|dec| dec.ifd(WellKnownIFD::Root).ok().flatten());
    let exif_ifd = decoder
        .as_ref()
        .and_then(|dec| dec.ifd(WellKnownIFD::Exif).ok().flatten());
    let focal_35mm_equiv = exif_ifd
        .as_ref()
        .and_then(|ifd| ifd.get_entry(ExifTag::FocalLengthIn35mmFormat))
        .or_else(|| {
            root_ifd
                .as_ref()
                .and_then(|ifd| ifd.get_entry_recursive(ExifTag::FocalLengthIn35mmFormat))
        })
        .map(|e| e.value.force_f32(0))
        .filter(|v| *v > 0.0);

    // XMP packet (TIFF tag 700). DJI bodies write it in IFD0; the
    // recursive lookup is belt-and-braces for SubIFD placements. Stored
    // verbatim — namespace-aware parsing happens in maple-pano.
    let xmp_packet = root_ifd
        .as_ref()
        .and_then(|ifd| ifd.get_entry_recursive(TiffCommonTag::Xmp))
        .and_then(|e| match &e.value {
            rawler::formats::tiff::Value::Byte(v) => Some(v.clone()),
            rawler::formats::tiff::Value::Undefined(v) => Some(v.clone()),
            rawler::formats::tiff::Value::Ascii(s) => {
                s.strings().first().map(|s| s.as_bytes().to_vec())
            }
            _ => None,
        })
        .filter(|v| !v.is_empty());

    PanoSourceMetadata {
        camera_make: raw.camera_make.clone(),
        camera_model: raw.camera_model.clone(),
        unique_camera_model: raw.unique_camera_model.clone(),
        focal_mm,
        focal_35mm_equiv,
        orientation: raw.orientation,
        output_dims: native_render_dims(raw),
        xmp_packet,
    }
}

#[cfg(test)]
mod tests;
