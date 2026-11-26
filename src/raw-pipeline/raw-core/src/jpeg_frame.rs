use zune_jpeg::zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions};
use zune_jpeg::JpegDecoder;

#[derive(Clone, Copy)]
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

#[cfg(test)]
mod tests {
    use super::jpeg_frame;
    use crate::test_support::synth_jpeg::{jpeg, without_huffman_tables};
    use image::ImageDecoder;

    fn decoder_view(bytes: &[u8]) -> Option<(u32, u32, bool)> {
        let decoder = image::codecs::jpeg::JpegDecoder::new(std::io::Cursor::new(bytes)).ok()?;
        let (width, height) = decoder.dimensions();
        let is_color = !matches!(
            decoder.color_type(),
            image::ColorType::L8 | image::ColorType::L16
        );
        Some((width, height, is_color))
    }

    fn header_view(bytes: &[u8]) -> Option<(u32, u32, bool)> {
        jpeg_frame(bytes).map(|frame| (frame.width, frame.height, frame.is_color))
    }

    #[test]
    fn the_header_read_agrees_with_the_decoder_it_stands_in_for() {
        let color = jpeg(321, 123, true, 1);
        let gray = jpeg(77, 400, false, 2);
        let broken = without_huffman_tables(&color);
        let truncated = &color[..color.len() / 2];
        let headerless = &color[..20];
        assert_eq!(header_view(&color), Some((321, 123, true)));
        assert_eq!(header_view(&gray), Some((77, 400, false)));
        [
            color.as_slice(),
            gray.as_slice(),
            broken.as_slice(),
            truncated,
            headerless,
            &[0xFF, 0xD8, 0xFF, 0x00, 0x12, 0x34],
            &[],
        ]
        .into_iter()
        .for_each(|bytes| assert_eq!(header_view(bytes), decoder_view(bytes)));
    }
}
