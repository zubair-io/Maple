//! Error type shared by the maple-pano library and the `pano-gt-render`
//! binary.

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum PanoError {
    #[error("i/o error on {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("failed to decode image {path}: {source}")]
    ImageDecode {
        path: PathBuf,
        #[source]
        source: image::ImageError,
    },

    #[error("failed to encode PNG: {0}")]
    PngEncode(#[from] png::EncodingError),

    #[error(
        "equirect source must be full-sphere 2:1 (width = 2 x height, width >= 4); \
         got {width}x{height}"
    )]
    BadSourceAspect { width: u32, height: u32 },

    #[error("invalid options: {0}")]
    InvalidOptions(String),

    #[error(
        "radial distortion k1={k1}, k2={k2} is not invertible at pixel ({px:.1}, {py:.1}) \
         (the polynomial folds back inside the frame) — reduce |k1|/|k2| or the field of view"
    )]
    DistortionNotInvertible { k1: f64, k2: f64, px: f64, py: f64 },
}

impl PanoError {
    /// Wrap an `io::Error` with the path it occurred on.
    pub fn io(path: &std::path::Path, source: std::io::Error) -> Self {
        Self::Io {
            path: path.to_path_buf(),
            source,
        }
    }
}
