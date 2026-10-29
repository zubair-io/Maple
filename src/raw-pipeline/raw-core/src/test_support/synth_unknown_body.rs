//! A 3FR-shaped TIFF from a Hasselblad body rawler has no definition for
//! (#5499): an 8-bit RGB preview in IFD0, oriented `Rotate90`, and a 16-bit
//! CFA SubIFD.

use super::synth_dng::*;

pub const MODEL: &str = "Hasselblad H0D";
pub const PREVIEW_WIDTH: u32 = 32;
pub const PREVIEW_HEIGHT: u32 = 16;

const TAG_MAKE: u16 = 271;
const TAG_MODEL: u16 = 272;
const TAG_SUB_IFDS: u16 = 330;
const PHOTOMETRIC_CFA: u16 = 32803;
const CFA_SIDE: u32 = 2;

/// The preview's RGB bytes, a ramp so a test can tell them apart.
pub fn preview_rgb() -> Vec<u8> {
    (0..PREVIEW_WIDTH * PREVIEW_HEIGHT * 3)
        .map(|i| (i % 251) as u8)
        .collect()
}

pub fn unknown_body_3fr() -> Vec<u8> {
    let preview = preview_rgb();
    let preview_len = preview.len() as u32;
    let build = |cfa_ifd_at: u32, strips_at: u32| {
        let mut root = Ifd::new();
        root.add_long(TAG_NEW_SUBFILE_TYPE, 1);
        root.add_long(TAG_IMAGE_WIDTH, PREVIEW_WIDTH);
        root.add_long(TAG_IMAGE_LENGTH, PREVIEW_HEIGHT);
        root.add_shorts(TAG_BITS_PER_SAMPLE, vec![8, 8, 8]);
        root.add_short(TAG_COMPRESSION, 1);
        root.add_short(TAG_PHOTOMETRIC, 2);
        root.add_ascii(TAG_MAKE, "Hasselblad");
        root.add_ascii(TAG_MODEL, MODEL);
        root.add_long(TAG_STRIP_OFFSETS, strips_at);
        root.add_short(TAG_ORIENTATION, 6);
        root.add_short(TAG_SAMPLES_PER_PIXEL, 3);
        root.add_long(TAG_ROWS_PER_STRIP, PREVIEW_HEIGHT);
        root.add_long(TAG_STRIP_BYTE_COUNTS, preview_len);
        root.add_long(TAG_SUB_IFDS, cfa_ifd_at);
        let mut cfa = Ifd::new();
        cfa.add_long(TAG_IMAGE_WIDTH, CFA_SIDE);
        cfa.add_long(TAG_IMAGE_LENGTH, CFA_SIDE);
        cfa.add_short(TAG_BITS_PER_SAMPLE, 16);
        cfa.add_short(TAG_COMPRESSION, 1);
        cfa.add_short(TAG_PHOTOMETRIC, PHOTOMETRIC_CFA);
        cfa.add_long(TAG_STRIP_OFFSETS, strips_at + preview_len);
        cfa.add_short(TAG_SAMPLES_PER_PIXEL, 1);
        cfa.add_long(TAG_STRIP_BYTE_COUNTS, CFA_SIDE * CFA_SIDE * 2);
        let mut buf = vec![0x49, 0x49, 0x2A, 0x00, 8, 0, 0, 0];
        root.serialise_into(&mut buf, 8);
        let cfa_at = buf.len() as u32;
        cfa.serialise_into(&mut buf, cfa_at);
        (cfa_at, buf)
    };
    let (cfa_at, sized) = build(0, 0);
    let (_, mut bytes) = build(cfa_at, sized.len() as u32);
    bytes.extend_from_slice(&preview);
    bytes.extend_from_slice(&[0xFF; (CFA_SIDE * CFA_SIDE * 2) as usize]);
    bytes
}
