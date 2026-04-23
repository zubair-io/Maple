use crate::error::{Error, Result};
use std::path::Path;

/// Write a sRGB 8-bit PNG. Tags the sRGB chunk per IEC 61966-2.1
/// (matching ACR reference output).
pub fn write(path: &Path, width: u32, height: u32, rgb: &[u8]) -> Result<()> {
    let expected_len = (width as usize) * (height as usize) * 3;
    if rgb.len() != expected_len {
        return Err(Error::Png(format!(
            "expected {} bytes, got {}", expected_len, rgb.len()
        )));
    }
    let file = std::fs::File::create(path).map_err(|e| Error::Io {
        path: path.to_path_buf(),
        source: e,
    })?;
    let w = std::io::BufWriter::new(file);
    let mut encoder = png::Encoder::new(w, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Default);
    encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
    let mut writer = encoder.write_header().map_err(|e| Error::Png(e.to_string()))?;
    writer.write_image_data(rgb).map_err(|e| Error::Png(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn write_tiny_png_round_trip() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path();
        let rgb: Vec<u8> = vec![255, 0, 0,  0, 255, 0,  0, 0, 255,  255, 255, 255];
        write(path, 2, 2, &rgb).unwrap();

        let mut f = std::fs::File::open(path).unwrap();
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).unwrap();
        let decoder = png::Decoder::new(buf.as_slice());
        let mut reader = decoder.read_info().unwrap();
        let info = reader.info();
        assert_eq!(info.width, 2);
        assert_eq!(info.height, 2);
        assert_eq!(info.color_type, png::ColorType::Rgb);
        let mut out = vec![0; reader.output_buffer_size()];
        reader.next_frame(&mut out).unwrap();
        assert_eq!(&out[..12], &rgb[..]);
    }

    #[test]
    fn wrong_length_errors() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let err = write(tmp.path(), 2, 2, &[0u8; 10]).unwrap_err();
        match err {
            Error::Png(_) => {},
            _ => panic!("expected Error::Png"),
        }
    }
}
