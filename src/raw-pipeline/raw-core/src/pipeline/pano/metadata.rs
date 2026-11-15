use super::{native_render_dims, PanoSourceMetadata, RawImage};
use rawler::decoders::{RawDecodeParams, WellKnownIFD};
use rawler::rawsource::RawSource;
use rawler::tags::{ExifTag, TiffCommonTag};

/// Assemble [`PanoSourceMetadata`] from the source bytes + the decoded
/// [`RawImage`]. Best-effort: a metadata read failure degrades the
/// affected `Option` field to `None`, never the whole decode.
///
/// Runs its own rawler metadata pass (same pattern as
/// [`crate::api::read_exif`] — cheap relative to a develop): `decode_bytes`
/// doesn't surface the EXIF focal tags or the XMP packet, and re-using its
/// internal decoder would mean threading rawler types through `RawImage`.
pub(super) fn read_pano_metadata_from_parts(
    bytes: &[u8],
    ext: &str,
    raw: &RawImage,
) -> PanoSourceMetadata {
    let hint_path = format!("rawfile.{}", ext);
    let source = RawSource::new_from_slice(bytes).with_path(std::path::Path::new(&hint_path));
    let params = RawDecodeParams::default();
    let decoder = rawler::get_decoder(&source).ok();

    let metadata = decoder
        .as_ref()
        .and_then(|dec| dec.raw_metadata(&source, &params).ok());
    let gps = metadata
        .as_ref()
        .and_then(|md| md.exif.gps.as_ref())
        .and_then(|g| {
            let lat = gps_coordinate(
                g.gps_latitude?,
                g.gps_latitude_ref.as_deref()?,
                "N",
                "S",
                90.0,
            )?;
            let lon = gps_coordinate(
                g.gps_longitude?,
                g.gps_longitude_ref.as_deref()?,
                "E",
                "W",
                180.0,
            )?;
            (lat != 0.0 || lon != 0.0).then_some((lat, lon))
        });
    let focal_mm = metadata
        .as_ref()
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
        // is_finite() guards a rational tag with a zero denominator
        // (some firmware writes 0/0) from surfacing as `inf`, which
        // would otherwise skip maple-pano's sensor-geometry fallback
        // (Some(inf) short-circuits the `.or_else`) and later propagate
        // into focal_px (Copilot review on #3122).
        .filter(|v| v.is_finite() && *v > 0.0);

    // EXIF FocalPlaneXResolution (0x920E) + FocalPlaneResolutionUnit
    // (0x9210) — same IFD lookup pattern as FocalLengthIn35mmFormat
    // above, also falling back to the "*2" tag IDs (0xA20E / 0xA210)
    // some camera firmware writes instead of the primary ones (Copilot
    // review on #3122). Sensor-geometry fallback for bodies that omit
    // the 35mm-equivalent tag (#2700); the derivation itself lives in
    // `maple_pano::ingest::priors`, this is just the raw EXIF read.
    let focal_plane_x_resolution = exif_ifd
        .as_ref()
        .and_then(|ifd| ifd.get_entry(ExifTag::FocalPlaneXResolution))
        .or_else(|| {
            root_ifd
                .as_ref()
                .and_then(|ifd| ifd.get_entry_recursive(ExifTag::FocalPlaneXResolution))
        })
        .or_else(|| {
            exif_ifd
                .as_ref()
                .and_then(|ifd| ifd.get_entry(ExifTag::FocalPlaneXResolution2))
        })
        .or_else(|| {
            root_ifd
                .as_ref()
                .and_then(|ifd| ifd.get_entry_recursive(ExifTag::FocalPlaneXResolution2))
        })
        .map(|e| e.value.force_f32(0))
        // Same is_finite() guard as focal_35mm_equiv above — belt and
        // braces, `derive_focal_35mm_equiv` also validates this input.
        .filter(|v| v.is_finite() && *v > 0.0);
    let focal_plane_resolution_unit = exif_ifd
        .as_ref()
        .and_then(|ifd| ifd.get_entry(ExifTag::FocalPlaneResolutionUnit))
        .or_else(|| {
            root_ifd
                .as_ref()
                .and_then(|ifd| ifd.get_entry_recursive(ExifTag::FocalPlaneResolutionUnit))
        })
        .or_else(|| {
            exif_ifd
                .as_ref()
                .and_then(|ifd| ifd.get_entry(ExifTag::FocalPlaneResolutionUnit2))
        })
        .or_else(|| {
            root_ifd
                .as_ref()
                .and_then(|ifd| ifd.get_entry_recursive(ExifTag::FocalPlaneResolutionUnit2))
        })
        .map(|e| e.value.force_u16(0));

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
        focal_plane_x_resolution,
        focal_plane_resolution_unit,
        orientation: raw.orientation,
        output_dims: native_render_dims(raw),
        xmp_packet,
        gps,
    }
}

fn gps_coordinate(
    dms: [rawler::formats::tiff::Rational; 3],
    reference: &str,
    positive: &str,
    negative: &str,
    maximum: f64,
) -> Option<f64> {
    let mut parts = [0.0; 3];
    for (out, rational) in parts.iter_mut().zip(dms) {
        if rational.d == 0 {
            return None;
        }
        *out = rational.n as f64 / rational.d as f64;
    }
    if parts[1] >= 60.0 || parts[2] >= 60.0 {
        return None;
    }
    let value = parts[0] + parts[1] / 60.0 + parts[2] / 3600.0;
    if value > maximum {
        return None;
    }
    if reference.eq_ignore_ascii_case(positive) {
        Some(value)
    } else if reference.eq_ignore_ascii_case(negative) {
        Some(-value)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rawler::formats::tiff::Rational;

    #[test]
    fn gps_dms_preserves_hemisphere_and_fractional_seconds() {
        let dms = [
            Rational { n: 48, d: 1 },
            Rational { n: 30, d: 1 },
            Rational { n: 15, d: 2 },
        ];
        assert_eq!(
            gps_coordinate(dms, "N", "N", "S", 90.0),
            Some(48.50208333333333)
        );
        assert_eq!(
            gps_coordinate(dms, "s", "N", "S", 90.0),
            Some(-48.50208333333333)
        );
        assert_eq!(
            gps_coordinate(dms, "W", "E", "W", 180.0),
            Some(-48.50208333333333)
        );
    }

    #[test]
    fn gps_rejects_invalid_reference_zero_denominator_and_out_of_range_dms() {
        let rational = |n, d| Rational { n, d };
        let dms = [rational(90, 1), rational(0, 1), rational(0, 1)];
        assert_eq!(gps_coordinate(dms, "?", "N", "S", 90.0), None);
        for bad in [
            [rational(48, 0), rational(0, 1), rational(0, 1)],
            [rational(48, 1), rational(60, 1), rational(0, 1)],
            [rational(48, 1), rational(0, 1), rational(60, 1)],
            [rational(90, 1), rational(0, 1), rational(1, 1)],
        ] {
            assert_eq!(gps_coordinate(bad, "N", "N", "S", 90.0), None);
        }
    }
}
