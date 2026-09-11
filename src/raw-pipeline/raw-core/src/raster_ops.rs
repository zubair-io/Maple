//! `RasterImage` pixel constructors and geometry ops, split out of `raster.rs`
//! to keep that file under the file-budget threshold. No behaviour change
//! from the original in-line definitions.

use super::*;

impl RasterImage {
    /// Adopt caller-supplied interleaved 8-bit pixels. Greyscale (1 channel)
    /// is expanded to RGB so every downstream op sees 3 or 4 channels.
    pub fn from_raw(width: u32, height: u32, channels: u8, data: Vec<u8>) -> Result<Self> {
        let invalid = |reason: String| Error::Decode {
            path: "<memory>".into(),
            reason,
        };
        if width == 0 || height == 0 {
            return Err(invalid("raw input dimensions must be non-zero".into()));
        }
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|px| px.checked_mul(channels as usize))
            .ok_or_else(|| {
                invalid(format!(
                    "raw input dimensions {width}x{height}x{channels} overflow"
                ))
            })?;
        if data.len() != expected {
            return Err(invalid(format!(
                "raw input has {} bytes, expected {expected} for {width}x{height}x{channels}",
                data.len()
            )));
        }
        match channels {
            3 => Ok(Self::new_rgb(width, height, data)),
            4 => Ok(Self::new_rgba(width, height, data)),
            1 => Ok(Self::new_rgb(
                width,
                height,
                data.iter().flat_map(|&g| [g, g, g]).collect(),
            )),
            other => Err(invalid(format!(
                "unsupported raw channel count {other} (1, 3 or 4)"
            ))),
        }
    }

    /// Strip alpha (if any) and return a 3-channel image.
    pub fn into_rgb8(self) -> Self {
        if self.channels == 3 {
            return self;
        }
        let data = self.to_rgb_bytes();
        Self {
            width: self.width,
            height: self.height,
            channels: 3,
            data,
            orientation: self.orientation,
        }
    }
}
