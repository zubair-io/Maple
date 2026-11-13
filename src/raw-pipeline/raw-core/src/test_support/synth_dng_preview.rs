//! A DNG whose IFD0 is a valid Bayer raw and whose SubIFD is an 8-bit RGB
//! preview (`NewSubFileType` 1) with caller-chosen declared dimensions — the
//! layout `rawler`'s `full_image` reads the embedded preview from.

use super::synth_dng::*;

const TAG_SUB_IFDS: u16 = 330;
const TAG_SAMPLE_FORMAT: u16 = 339;
const SAMPLE_FORMAT_INT: u16 = 2;
const PHOTOMETRIC_RGB: u16 = 2;
const PHOTOMETRIC_YCBCR: u16 = 6;
const COMPRESSION_NONE: u16 = 1;
const COMPRESSION_JPEG: u16 = 7;
const IFD0_AT: u32 = 8;
const JPEG_SIDE: (u32, u32) = (8, 4);

#[derive(Clone, Copy)]
pub enum PreviewStrip {
    Uncompressed,
    /// A real 8x4 baseline JPEG strip, whatever dimensions the IFD declares.
    Jpeg,
    /// An uncompressed preview IFD declaring signed samples (`SampleFormat`
    /// 2); rawler's `plain_image_from_ifd` reaches an `unimplemented!` arm.
    SignedSamples,
}

pub fn dng_with_preview_sub_ifd(
    strip: PreviewStrip,
    declared_width: u32,
    declared_height: u32,
) -> Vec<u8> {
    let grey = SyntheticGreyDng::default();
    let raw_len = grey.width * grey.height * 2;
    let preview_data = match strip {
        PreviewStrip::Uncompressed | PreviewStrip::SignedSamples => {
            vec![0x80; (declared_width * declared_height * 3) as usize]
        }
        PreviewStrip::Jpeg => baseline_jpeg(),
    };
    let (compression, photometric) = match strip {
        PreviewStrip::Uncompressed | PreviewStrip::SignedSamples => {
            (COMPRESSION_NONE, PHOTOMETRIC_RGB)
        }
        PreviewStrip::Jpeg => (COMPRESSION_JPEG, PHOTOMETRIC_YCBCR),
    };

    let ifd0 = |raw_at: u32, sub_ifd_at: u32| {
        let mut ifd = grey.build_ifd0(raw_at);
        ifd.add_long(TAG_SUB_IFDS, sub_ifd_at);
        ifd
    };
    let preview = |strips_at: u32| {
        let mut ifd = Ifd::new();
        ifd.add_long(TAG_NEW_SUBFILE_TYPE, 1);
        ifd.add_long(TAG_IMAGE_WIDTH, declared_width);
        ifd.add_long(TAG_IMAGE_LENGTH, declared_height);
        ifd.add_shorts(TAG_BITS_PER_SAMPLE, vec![8, 8, 8]);
        ifd.add_short(TAG_COMPRESSION, compression);
        ifd.add_short(TAG_PHOTOMETRIC, photometric);
        ifd.add_long(TAG_STRIP_OFFSETS, strips_at);
        if matches!(strip, PreviewStrip::SignedSamples) {
            ifd.add_short(TAG_SAMPLE_FORMAT, SAMPLE_FORMAT_INT);
        }
        ifd.add_short(TAG_SAMPLES_PER_PIXEL, 3);
        ifd.add_long(TAG_ROWS_PER_STRIP, declared_height);
        ifd.add_long(TAG_STRIP_BYTE_COUNTS, preview_data.len() as u32);
        ifd
    };
    let serialised_len = |ifd: Ifd, at: u32| {
        let mut probe = Vec::new();
        ifd.serialise_into(&mut probe, at);
        probe.len() as u32
    };

    let raw_at = IFD0_AT + serialised_len(ifd0(0, 0), IFD0_AT);
    let sub_ifd_at = raw_at + raw_len;
    let preview_at = sub_ifd_at + serialised_len(preview(0), sub_ifd_at);

    let mut bytes = vec![0x49, 0x49, 0x2A, 0x00, 8, 0, 0, 0];
    ifd0(raw_at, sub_ifd_at).serialise_into(&mut bytes, IFD0_AT);
    bytes.extend_from_slice(&grey.build_strip());
    preview(preview_at).serialise_into(&mut bytes, sub_ifd_at);
    bytes.extend_from_slice(&preview_data);
    bytes
}

fn baseline_jpeg() -> Vec<u8> {
    let (width, height) = JPEG_SIDE;
    let rgb = vec![0x80; (width * height * 3) as usize];
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
        .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
        .expect("encoding a constant 8x4 JPEG cannot fail");
    out
}
