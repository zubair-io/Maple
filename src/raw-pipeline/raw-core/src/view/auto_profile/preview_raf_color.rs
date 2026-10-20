use super::preview::JpegColorSpace;
use rawler::formats::tiff::{Value, IFD};
use std::io::Cursor;

pub(super) fn raf_preview_color_space(bytes: &[u8]) -> Option<JpegColorSpace> {
    if bytes.get(..8)? != b"FUJIFILM" {
        return None;
    }
    let start = u32::from_be_bytes(bytes.get(84..88)?.try_into().ok()?) as usize;
    let length = u32::from_be_bytes(bytes.get(88..92)?.try_into().ok()?) as usize;
    let jpeg = bytes.get(start..start.checked_add(length)?)?;
    if jpeg.get(..4)? != [0xff, 0xd8, 0xff, 0xe1] || jpeg.get(6..12)? != b"Exif\0\0" {
        return None;
    }
    let segment_length = u16::from_be_bytes(jpeg.get(4..6)?.try_into().ok()?) as usize;
    let tiff = jpeg.get(12..4usize.checked_add(segment_length)?)?;
    let root = IFD::new_root_with_correction(&mut Cursor::new(tiff), 0, 0, 0, 1, &[0x8769]).ok()?;
    let exif = root.sub.get(&0x8769)?.first()?;
    let Value::Long(offsets) = &exif.entries.get(&0xa005)?.value else {
        return None;
    };
    let interop = IFD::new(
        &mut Cursor::new(tiff),
        *offsets.first()?,
        0,
        0,
        root.endian,
        &[],
    )
    .ok()?;
    let Value::Ascii(index) = &interop.entries.get(&1)?.value else {
        return None;
    };
    match index.strings().first()?.as_str() {
        "R03" => Some(JpegColorSpace::AdobeRgb),
        "R98" => Some(JpegColorSpace::SRgb),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raf(index: &[u8; 4]) -> Vec<u8> {
        let mut tiff = b"II\x2a\0\x08\0\0\0".to_vec();
        for (tag, pointer) in [(0x8769u16, 26u32), (0xa005, 44)] {
            tiff.extend_from_slice(&1u16.to_le_bytes());
            tiff.extend_from_slice(&tag.to_le_bytes());
            tiff.extend_from_slice(&4u16.to_le_bytes());
            tiff.extend_from_slice(&1u32.to_le_bytes());
            tiff.extend_from_slice(&pointer.to_le_bytes());
            tiff.extend_from_slice(&0u32.to_le_bytes());
        }
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&4u32.to_le_bytes());
        tiff.extend_from_slice(index);
        tiff.extend_from_slice(&0u32.to_le_bytes());
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1];
        jpeg.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
        jpeg.extend_from_slice(b"Exif\0\0");
        jpeg.extend_from_slice(&tiff);
        let mut bytes = vec![0; 100];
        bytes[..8].copy_from_slice(b"FUJIFILM");
        bytes[84..88].copy_from_slice(&100u32.to_be_bytes());
        bytes[88..92].copy_from_slice(&(jpeg.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&jpeg);
        bytes
    }

    #[test]
    fn follows_exif_interop_pointer_for_adobe_and_srgb() {
        assert!(matches!(
            raf_preview_color_space(&raf(b"R03\0")),
            Some(JpegColorSpace::AdobeRgb)
        ));
        assert!(matches!(
            raf_preview_color_space(&raf(b"R98\0")),
            Some(JpegColorSpace::SRgb)
        ));
        assert!(raf_preview_color_space(&raf(b"XYZ\0")).is_none());
    }

    #[test]
    fn truncated_or_invalid_preview_offsets_do_not_guess_a_color_space() {
        let mut bytes = raf(b"R03\0");
        for end in 0..bytes.len() {
            assert!(raf_preview_color_space(&bytes[..end]).is_none());
        }
        bytes[84..88].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(raf_preview_color_space(&bytes).is_none());
    }
}
