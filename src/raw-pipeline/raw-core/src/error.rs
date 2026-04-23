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

    #[error("DCP profile missing or unparseable: {0}")]
    Dcp(String),

    #[error("XMP parse error: {0}")]
    Xmp(String),

    #[error("PNG write error: {0}")]
    Png(String),

    #[error("pipeline assertion failed: {0}")]
    Pipeline(&'static str),
}

pub type Result<T> = std::result::Result<T, Error>;
