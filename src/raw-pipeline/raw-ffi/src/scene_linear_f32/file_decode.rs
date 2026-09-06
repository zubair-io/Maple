use crate::error::set_last_error;
use raw_core::decode_cache::{get_or_decode, CacheKey};
use raw_core::{CancelToken, Error, RawImage};
use std::path::Path;
use std::sync::Arc;

/// A warm mosaic avoids both the full RAW read and rawler demux. The path key
/// is captured before I/O; content changed afterward cannot be stored under a
/// newer modification time. Error codes remain the existing file FFI contract.
pub(super) fn decode_file_cached(
    path: &Path,
    cancel: CancelToken<'_>,
) -> Result<Arc<RawImage>, i32> {
    if cancel.is_cancelled() {
        return Err(super::RC_CANCELLED);
    }
    let key = CacheKey::from_path(path);
    let decode = || {
        // A same-key waiter can be cancelled while another caller decodes.
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let bytes = raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(path)).map_err(
            |source| Error::Io {
                path: path.to_owned(),
                source,
            },
        )?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        raw_core::pipeline::stage("ffi_rawler_decode", || {
            raw_core::decode::decode_bytes(&bytes, extension).map(Arc::new)
        })
    };
    let result = match key {
        Some(key) => get_or_decode(&key, decode),
        None => decode(),
    };
    // A warm flight result must also respect this caller's cancellation.
    if cancel.is_cancelled() {
        return Err(super::RC_CANCELLED);
    }
    result.map_err(|error| match error {
        Error::Cancelled => super::RC_CANCELLED,
        Error::Io { source, .. } => {
            set_last_error(format!("raw read: {source}"));
            6
        }
        other => {
            set_last_error(format!("decode: {other}"));
            7
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn cancelled_request_never_attempts_missing_file_read() {
        let flag = AtomicBool::new(true);
        let result = decode_file_cached(
            Path::new("/missing-maple-cancelled-raw.dng"),
            CancelToken::new(&flag),
        );
        assert!(matches!(result, Err(4)));
    }

    #[test]
    fn missing_file_preserves_read_error_code() {
        let result = decode_file_cached(
            Path::new("/missing-maple-read-raw.dng"),
            CancelToken::never(),
        );
        assert!(matches!(result, Err(6)));
    }
}
