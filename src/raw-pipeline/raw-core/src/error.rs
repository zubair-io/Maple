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

    /// Embedded-preview extraction failed (`crate::preview::extract_embedded_preview`)
    /// — either the RAW has none of rawler's `preview_image`/`full_image`/
    /// `thumbnail_image` slots populated, the decoder couldn't be
    /// identified, or extraction panicked (caught via `catch_unwind`).
    /// Distinct from `Decode` because the RAW itself may decode fine — this
    /// only means it has no camera-embedded preview to fast-path from.
    #[error("embedded preview extraction failed: {0}")]
    Preview(String),

    #[error("pipeline assertion failed: {0}")]
    Pipeline(String),

    /// The host requested cancellation (via a [`crate::CancelToken`]) while a
    /// develop pass was in flight, and a stage unwound early. Distinct from
    /// every other variant so the FFI can map it to a dedicated rc and the
    /// caller can drop the result silently rather than surfacing an error.
    /// Only ever produced when a non-never `CancelToken` is threaded through
    /// the develop chain; the default never-cancel path can never return it.
    #[error("render cancelled by host")]
    Cancelled,
}

pub type Result<T> = std::result::Result<T, Error>;
