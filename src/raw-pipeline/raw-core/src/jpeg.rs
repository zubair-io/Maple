use crate::error::{Error, Result};
use image::{ImageBuffer, Rgb};
use image::codecs::jpeg::JpegEncoder;
use std::path::Path;

/// Write a sRGB 8-bit JPEG. `quality` in [1, 100]; default 92 per spec § 04.
/// Embeds no profile in v1 (color-managed viewers assume sRGB for untagged JPEG).
pub fn write(path: &Path, width: u32, height: u32, rgb: &[u8], quality: u8) -> Result<()> {
    let expected_len = (width as usize) * (height as usize) * 3;
    if rgb.len() != expected_len {
        return Err(Error::Png(format!(
            "expected {} bytes, got {}", expected_len, rgb.len()
        )));
    }
    let buf = ImageBuffer::<Rgb<u8>, _>::from_raw(width, height, rgb.to_vec())
        .ok_or_else(|| Error::Png("failed to build ImageBuffer".into()))?;
    let file = std::fs::File::create(path).map_err(|e| Error::Io {
        path: path.to_path_buf(), source: e,
    })?;
    let w = std::io::BufWriter::new(file);
    let mut encoder = JpegEncoder::new_with_quality(w, quality);
    encoder.encode_image(&buf).map_err(|e| Error::Png(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_tiny_jpeg() {
        let tmp_dir = tempfile::TempDir::new().unwrap();
        let path = tmp_dir.path().join("test.jpg");
        let rgb: Vec<u8> = vec![255, 0, 0,  0, 255, 0,  0, 0, 255,  255, 255, 255];
        write(&path, 2, 2, &rgb, 92).unwrap();
        // Verify the file was created and has content.
        let metadata = std::fs::metadata(&path).unwrap();
        assert!(metadata.len() > 0);
    }

    #[test]
    fn wrong_length_errors() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        assert!(write(tmp.path(), 2, 2, &[0u8; 10], 92).is_err());
    }
}
