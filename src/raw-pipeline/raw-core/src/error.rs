use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("I/O error reading {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("rawler failed to decode {path}: {reason}")]
    Decode { path: PathBuf, reason: String },

    #[error("unsupported CFA pattern: {0:?}")]
    UnsupportedCfa(String),

    /// Container format the decoder recognises but cannot fully decode (e.g.
    /// Sigma Foveon X3F — rawler's X3F decoder is a stub and returns
    /// "X3F decoding not implemented yet" from `decode_compressed`). Distinct
    /// from a generic `Decode` error so callers (FFI, UI, harness) can
    /// surface a clear "this format isn't supported" message instead of a
    /// truncated rawler diagnostic. See ticket #417.
    #[error("unsupported RAW format: {0}")]
    UnsupportedFormat(String),

    #[error("DCP profile missing or unparseable: {0}")]
    Dcp(String),

    #[error("XMP parse error: {0}")]
    Xmp(String),

    #[error("PNG write error: {0}")]
    Png(String),

    #[error("pipeline assertion failed: {0}")]
    Pipeline(String),
}

pub type Result<T> = std::result::Result<T, Error>;
