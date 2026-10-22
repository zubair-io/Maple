//! Display-oriented DefaultCrop dimensions without decoding sensor pixels.
//!
//! [`from_source`] is the cold metadata query a host falls back to for canvas
//! layout when its own metadata reader does not understand the RAW container.
//! The non-DNG path shares [`default_crop`] with the pixel decoder. DNG reads
//! the selected raw IFD directly; synthetic and physical equivalence tests
//! pin its crop and orientation against the pixel decoder.
use crate::{
    error::Error,
    image::{CropRect, ExifOrientation},
    Result,
};
use rawler::{
    decoders::{FormatHint, RawDecodeParams, WellKnownIFD},
    formats::tiff::IFD,
    rawsource::RawSource,
    tags::{DngTag, TiffCommonTag},
};

/// `[width, height]` of the DefaultCrop rectangle (the whole sensor when the
/// file declares none), swapped into display orientation. DNG bypasses
/// rawler's pixel-decoding dummy path; other formats use its dummy metadata.
pub fn from_source(source: &RawSource) -> Result<[u32; 2]> {
    let fail = |reason: String| Error::Decode {
        path: source.path().to_path_buf(),
        reason,
    };
    let decoder = rawler::get_decoder(source).map_err(|error| fail(error.to_string()))?;
    // Rawler's DNG dummy path still decompresses the raster. Read its selected
    // raw IFD directly so cold layout never needs strips, tiles or sample storage.
    if decoder.format_hint() == FormatHint::DNG {
        let raw = decoder
            .ifd(WellKnownIFD::Raw)
            .map_err(|e| fail(e.to_string()))?
            .ok_or_else(|| fail("DNG has no raw IFD".into()))?;
        let dimensions = [TiffCommonTag::ImageWidth, TiffCommonTag::ImageLength]
            .map(|tag| raw.get_entry(tag).map(|e| e.force_u32(0)).unwrap_or(0));
        let [width, height] = dimensions;
        if width < 2 || height < 2 {
            return Err(fail("invalid DNG sensor dimensions".into()));
        }
        let crop = dng_crop(&raw, width, height);
        let [w, h] = crop.map_or(dimensions, |r| [r.w, r.h]);
        let root = decoder
            .ifd(WellKnownIFD::Root)
            .map_err(|e| fail(e.to_string()))?;
        let orientation = root
            .as_ref()
            .and_then(|r| r.get_entry(TiffCommonTag::Orientation))
            .map_or(1, |e| e.force_u16(0));
        return Ok(if ExifOrientation::from_u16(orientation).swaps_wh() {
            [h, w]
        } else {
            [w, h]
        });
    }
    let raw = rawler::decode_dummy(source).map_err(|error| fail(error.to_string()))?;
    if raw.width < 2 || raw.height < 2 {
        return Err(fail(format!(
            "invalid sensor dimensions {}×{}: a decodable RAW must be at least 2×2 pixels",
            raw.width, raw.height
        )));
    }
    let orientation = decoder
        .raw_metadata(source, &RawDecodeParams::default())
        .ok()
        .and_then(|metadata| metadata.exif.orientation)
        .map(ExifOrientation::from_u16)
        .unwrap_or_else(|| crate::decode::rawler_orientation_to_core(&raw.orientation));
    let root = decoder.ifd(WellKnownIFD::Root).ok().flatten();
    let (sensor_w, sensor_h) = (raw.width as u32, raw.height as u32);
    let crop = default_crop(raw.crop_area, sensor_w, sensor_h, root.as_deref());
    let width = crop.map_or(sensor_w, |rect| rect.w);
    let height = crop.map_or(sensor_h, |rect| rect.h);
    Ok(if orientation.swaps_wh() {
        [height, width]
    } else {
        [width, height]
    })
}

// Rawler places DefaultCrop relative to ActiveArea and truncates rational
// coordinates to integers. Mirror that metadata convention without constructing
// a RawImage (whose malformed border arithmetic can overflow in debug builds).
fn dng_crop(ifd: &IFD, width: u32, height: u32) -> Option<CropRect> {
    let origin = ifd.get_entry(DngTag::DefaultCropOrigin)?;
    let size = ifd.get_entry(DngTag::DefaultCropSize)?;
    if origin.count() < 2 || size.count() < 2 {
        return None;
    }
    let active = ifd.get_entry(DngTag::ActiveArea).filter(|a| a.count() >= 4);
    let x = origin
        .force_u32(0)
        .saturating_add(active.map_or(0, |a| a.force_u32(1)));
    let y = origin
        .force_u32(1)
        .saturating_add(active.map_or(0, |a| a.force_u32(0)));
    CropRect::clamped(x, y, size.force_u32(0), size.force_u32(1), width, height)
}

/// The DNG § 6.3 DefaultCropOrigin/Size rectangle, in sensor-absolute
/// coordinates, or `None` for "no crop" (full-sensor render).
///
/// Rawler's `crop_area` is consistently populated for DNG / CR2 / CR3 / ARW /
/// NEF / RAF / ORF / RW2 from either the camera-table per-body crop or the DNG
/// tags themselves (see rawler/src/decoders/dng.rs `get_crop`), so it is the
/// primary source. The direct DNG-tag read is a belt-and-braces fallback for a
/// source that claims to be a DNG but was routed to a non-DNG decoder that
/// does not know about `DefaultCrop*` — vanishingly rare in practice.
///
/// Coordinates are not even-aligned here: the pipeline applies the crop
/// post-demosaic and (for half-res Preview) halves the rect at apply-time.
/// test_0002 (DNG without crop tags), test_0013 (iPhone DNG, ditto) and
/// test_0016 (X3F rawler can't decode) take the `None` path, matching ACR's
/// full-sensor render on those fixtures.
///
/// Takes the pieces rather than the whole `rawler::RawImage` because the pixel
/// decoder has already moved the sample buffer out of its `RawImage` by the
/// time it derives the crop.
pub(crate) fn default_crop(
    crop_area: Option<rawler::imgop::Rect>,
    width: u32,
    height: u32,
    root_ifd: Option<&IFD>,
) -> Option<CropRect> {
    crop_area
        .and_then(|r| {
            CropRect::clamped(
                r.p.x as u32,
                r.p.y as u32,
                r.d.w as u32,
                r.d.h as u32,
                width,
                height,
            )
        })
        .or_else(|| {
            let ifd = root_ifd?;
            let origin = ifd.get_entry(DngTag::DefaultCropOrigin)?;
            let size = ifd.get_entry(DngTag::DefaultCropSize)?;
            if origin.value.count() < 2 || size.value.count() < 2 {
                return None;
            }
            let x = origin.value.force_f32(0).round() as u32;
            let y = origin.value.force_f32(1).round() as u32;
            let w = size.value.force_f32(0).round() as u32;
            let h = size.value.force_f32(1).round() as u32;
            CropRect::clamped(x, y, w, h, width, height)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::synth_dng::SyntheticGreyDng;

    fn synthetic(orientation: Option<u16>, default_crop: Option<[u16; 4]>) -> Vec<u8> {
        SyntheticGreyDng {
            width: 16,
            height: 8,
            orientation,
            default_crop,
            ..Default::default()
        }
        .write_to_bytes()
    }

    fn display_size_from_pixel_decode(bytes: &[u8]) -> [u32; 2] {
        let decoded = crate::decode::decode_bytes(bytes, "dng").unwrap();
        let (w, h) = decoded
            .crop_rect
            .map_or((decoded.width, decoded.height), |rect| (rect.w, rect.h));
        if decoded.orientation.swaps_wh() {
            [h, w]
        } else {
            [w, h]
        }
    }

    #[test]
    fn metadata_query_matches_the_pixel_decoder_for_every_orientation_and_crop() {
        for crop in [None, Some([4, 2, 8, 4]), Some([0, 0, 16, 8])] {
            for orientation in (1..=8_u16).map(Some).chain([None]) {
                let bytes = synthetic(orientation, crop);
                let source = RawSource::new_from_slice(&bytes).with_path("rawfile.dng");
                let size = from_source(&source).unwrap();
                assert_eq!(
                    size,
                    display_size_from_pixel_decode(&bytes),
                    "orientation={orientation:?} crop={crop:?}"
                );
                let [w, h] = crop.map_or([16, 8], |c| [u32::from(c[2]), u32::from(c[3])]);
                let swapped = orientation.is_some_and(|value| value >= 5);
                assert_eq!(size, if swapped { [h, w] } else { [w, h] });
            }
        }
    }

    #[test]
    fn an_overrunning_dng_crop_is_clamped_without_decoding_pixels() {
        let bytes = synthetic(Some(6), Some([12, 6, 100, 100]));
        let source = RawSource::new_from_slice(&bytes).with_path("rawfile.dng");
        assert_eq!(from_source(&source).unwrap(), [2, 4]);
    }

    #[test]
    fn dng_layout_does_not_read_or_allocate_the_declared_pixel_raster() {
        let mut bytes = synthetic(Some(6), None);
        let ifd = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let count = u16::from_le_bytes(bytes[ifd..ifd + 2].try_into().unwrap()) as usize;
        for n in 0..count {
            let at = ifd + 2 + n * 12;
            let tag = u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap());
            if tag == 273 {
                // StripOffsets points outside the file: decode must fail.
                bytes[at + 8..at + 12].copy_from_slice(&u32::MAX.to_le_bytes());
            }
            if tag == 256 || tag == 257 {
                // A full raster would require terabytes.
                bytes[at + 2..at + 4].copy_from_slice(&4u16.to_le_bytes());
                bytes[at + 8..at + 12].copy_from_slice(&1_000_000u32.to_le_bytes());
            }
        }
        let source = RawSource::new_from_slice(&bytes).with_path("rawfile.dng");
        assert_eq!(from_source(&source).unwrap(), [1_000_000; 2]);
        // Do not invoke a full decode of an intentionally enormous image.
        // The invalid strip proves this query cannot have read image samples.
    }

    #[test]
    fn malformed_source_is_rejected_without_panicking() {
        let source = RawSource::new_from_slice(b"invalid RAW").with_path("rawfile.dng");
        assert!(from_source(&source).is_err());
    }

    /// Rawler's Canon sRAW/mRAW path (`cr2.rs` `convert_to_rgb`) borrows the
    /// pixel buffer before honouring the dummy flag; the buffer is unallocated
    /// under a dummy decode and only `PixU16::pixels_mut`'s `debug_assert!`
    /// objects, which rawler reports as a decode error. Release builds — what
    /// every host ships — take the early return and read the dimensions fine.
    const DEBUG_ONLY_RAWLER_GAPS: &[&str] = &["test_0010.CR2"];

    /// Every provisioned fixture: the cold query agrees with the real decode.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn metadata_query_matches_the_pixel_decoder_on_every_fixture() {
        let root =
            crate::test_support::fixtures::require(crate::test_support::fixtures::raws_root());
        let mut checked = 0;
        let mut unsupported = Vec::new();
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
                continue;
            };
            if !path.is_file() || ext.eq_ignore_ascii_case("xmp") {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let Ok(decoded) = crate::decode::decode_bytes(&bytes, ext) else {
                continue;
            };
            let (w, h) = decoded
                .crop_rect
                .map_or((decoded.width, decoded.height), |rect| (rect.w, rect.h));
            let expected = if decoded.orientation.swaps_wh() {
                [h, w]
            } else {
                [w, h]
            };
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            match from_source(&RawSource::new(&path).unwrap()) {
                Ok(size) => assert_eq!(size, expected, "{}", path.display()),
                Err(_) if cfg!(debug_assertions) && DEBUG_ONLY_RAWLER_GAPS.contains(&&*name) => {}
                Err(error) => unsupported.push(format!("{}: {error}", path.display())),
            }
            checked += 1;
        }
        assert!(
            checked > 0,
            "no decodable fixtures under test-fixtures/raws"
        );
        assert!(
            unsupported.is_empty(),
            "cold dimensions query failed on {} of {checked} decodable fixtures:\n{}",
            unsupported.len(),
            unsupported.join("\n")
        );
    }
}
