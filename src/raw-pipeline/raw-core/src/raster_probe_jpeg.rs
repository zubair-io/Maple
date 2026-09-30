//! Use zune-jpeg's seekable header reader directly. image::JpegDecoder
//! reads its entire input before invoking this same parser (#3620).

use std::io::{self, BufRead, Seek};
use zune_jpeg::zune_core::{colorspace::ColorSpace, options::DecoderOptions};
use zune_jpeg::{errors::DecodeErrors, zune_core::bytestream::ZByteIoError};

pub(super) fn headers<R: BufRead + Seek>(reader: R) -> io::Result<Option<(u32, u32, u8, bool)>> {
    // Match image::JpegDecoder's header options and color-type mapping.
    let options = DecoderOptions::default()
        .set_strict_mode(false)
        .set_max_width(usize::MAX)
        .set_max_height(usize::MAX);
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(reader, options);
    match decoder.decode_headers() {
        Ok(()) => {}
        Err(DecodeErrors::IoErrors(ZByteIoError::StdIoError(error)))
            if error.kind() != io::ErrorKind::UnexpectedEof =>
        {
            return Err(error)
        }
        Err(_) => return Ok(None),
    }
    let Some((width, height)) = decoder.dimensions() else {
        return Ok(None);
    };
    let Some(color) = decoder.input_colorspace() else {
        return Ok(None);
    };
    let (channels, alpha) = match color {
        ColorSpace::Luma => (1, false),
        ColorSpace::LumaA => (2, true),
        ColorSpace::RGBA => (4, true),
        _ => (3, false),
    };
    Ok(Some((width as u32, height as u32, channels, alpha)))
}
