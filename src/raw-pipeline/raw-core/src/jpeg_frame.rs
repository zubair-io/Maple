use zune_jpeg::zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions};
use zune_jpeg::JpegDecoder;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct JpegFrame {
    pub width: u32,
    pub height: u32,
    pub is_color: bool,
}

impl JpegFrame {
    pub fn area(self) -> u64 {
        u64::from(self.width) * u64::from(self.height)
    }
}

/// Same decoder options as `image`'s JPEG decoder, so rejection and dimensions match.
pub(crate) fn jpeg_frame(bytes: &[u8]) -> Option<JpegFrame> {
    let options = DecoderOptions::default()
        .set_strict_mode(false)
        .set_max_width(usize::MAX)
        .set_max_height(usize::MAX);
    let mut decoder = JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    decoder.decode_headers().ok()?;
    let (width, height) = decoder.dimensions()?;
    let is_color = !matches!(
        decoder.input_colorspace()?,
        ColorSpace::Luma | ColorSpace::LumaA
    );
    Some(JpegFrame {
        width: u32::try_from(width).ok()?,
        height: u32::try_from(height).ok()?,
        is_color,
    })
}
