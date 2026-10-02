//! Display-oriented DefaultCrop dimensions without decoding sensor pixels.
use crate::{error::Error, image::CropRect, Result};
use rawler::{
    decoders::{RawDecodeParams, WellKnownIFD},
    formats::tiff::IFD,
    rawsource::RawSource,
    tags::DngTag,
};

/// Cold metadata query for RAWs unsupported by the platform metadata reader.
/// The dummy decoder allocates no full-sensor pixel buffer.
pub fn from_source(source: &RawSource) -> Result<[u32; 2]> {
    let fail = |error: String| Error::Decode {
        path: source.path().to_path_buf(),
        reason: error,
    };
    let raw = rawler::decode_dummy(source).map_err(|error| fail(error.to_string()))?;
    if raw.width < 2 || raw.height < 2 {
        return Err(fail("Invalid RAW dimensions".into()));
    }
    let decoder = rawler::get_decoder(source).map_err(|error| fail(error.to_string()))?;
    let params = RawDecodeParams::default();
    let orientation = decoder
        .raw_metadata(source, &params)
        .ok()
        .and_then(|metadata| metadata.exif.orientation)
        .map(crate::image::ExifOrientation::from_u16)
        .unwrap_or_else(|| crate::decode::rawler_orientation_to_core(&raw.orientation));
    let root = decoder.ifd(WellKnownIFD::Root).ok().flatten();
    let crop = default_crop(&raw, root.as_deref());
    let width = crop.map_or(raw.width as u32, |rect| rect.w);
    let height = crop.map_or(raw.height as u32, |rect| rect.h);
    Ok(if orientation.swaps_wh() {
        [height, width]
    } else {
        [width, height]
    })
}

// Shared with the real pixel decoder, so crop interpretation cannot drift.
pub(crate) fn default_crop(raw: &rawler::RawImage, root_ifd: Option<&IFD>) -> Option<CropRect> {
    let width = raw.width as u32;
    let height = raw.height as u32;
    raw.crop_area
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
            // Fallback: read DNG tags directly. Rawler already does this
            // for DNG sources (`get_crop` in decoders/dng.rs), so this
            // path is hit only when the source claims to be a DNG but
            // rawler routed it to a non-DNG decoder that doesn't know
            // about `DefaultCrop*` (vanishingly rare in practice — none
            // of the slice-1 fixtures hit it). Kept as belt-and-braces.
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
    const RAW: &[u8] = include_bytes!("../../../../test-fixtures/removal/calibration/source.dng");

    fn cropped_oriented(orientation: u16) -> Vec<u8> {
        let mut bytes = RAW.to_vec();
        let old = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let count = u16::from_le_bytes(bytes[old..old + 2].try_into().unwrap()) as usize;
        let root = bytes.len();
        let payload = root + 2 + (count + 3) * 12 + 4;
        let mut entries: Vec<Vec<u8>> = bytes[old + 2..old + 2 + count * 12]
            .chunks_exact(12)
            .map(<[u8]>::to_vec)
            .collect();
        for (tag, kind, count, value) in [
            (274_u16, 3_u16, 1_u32, u32::from(orientation)),
            (50719, 4, 2, payload as u32),
            (50720, 4, 2, (payload + 8) as u32),
        ] {
            let entry = [
                tag.to_le_bytes().as_slice(),
                kind.to_le_bytes().as_slice(),
                count.to_le_bytes().as_slice(),
                value.to_le_bytes().as_slice(),
            ]
            .concat();
            entries.push(entry);
        }
        entries.sort_by_key(|entry| u16::from_le_bytes(entry[..2].try_into().unwrap()));
        bytes[4..8].copy_from_slice(&(root as u32).to_le_bytes());
        bytes.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for entry in entries {
            bytes.extend_from_slice(&entry);
        }
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        for value in [4_u32, 2, 8, 4] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn metadata_matches_real_decode_and_honors_all_orientations_and_default_crop() {
        for orientation in 1..=8_u16 {
            let bytes = cropped_oriented(orientation);
            let source = RawSource::new_from_slice(&bytes);
            let size = from_source(&source).unwrap();
            let decoded = crate::decode::decode_bytes(&bytes, "dng").unwrap();
            let crop = decoded.crop_rect.unwrap();
            let expected = if decoded.orientation.swaps_wh() {
                [crop.h, crop.w]
            } else {
                [crop.w, crop.h]
            };
            assert_eq!(size, expected);
            assert_eq!(size, if orientation >= 5 { [4, 8] } else { [8, 4] });
        }
        assert_eq!(
            from_source(&RawSource::new_from_slice(RAW)).unwrap(),
            [16, 8]
        );
    }

    #[test]
    fn malformed_source_is_rejected() {
        assert!(from_source(&RawSource::new_from_slice(b"invalid RAW")).is_err());
    }
}
