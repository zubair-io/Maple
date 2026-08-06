//! Windows XMP sidecar persistence engine for Maple.
//!
//! Handles non-destructive sidecar reading and writing on Windows local filesystems
//! and Windows UNC network shares (`\\server\share\path\file.xmp`), adhering to
//! long path semantics (`\\?\`) and maintaining byte-for-byte XMP schema parity.

use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum SidecarError {
    #[error("I/O error accessing sidecar at {0}: {1}")]
    Io(PathBuf, std::io::Error),
    #[error("Invalid XMP sidecar XML format: {0}")]
    Xml(String),
}

/// Computes the expected `.xmp` sidecar path for a given RAW image path on Windows.
///
/// Handles standard Windows paths (`C:\Photos\image.dng` -> `C:\Photos\image.xmp`),
/// Windows extended-length paths (`\\?\C:\Photos\image.dng`), and UNC paths.
pub fn sidecar_path_for_raw(raw_path: &Path) -> PathBuf {
    let mut sidecar = raw_path.to_path_buf();
    sidecar.set_extension("xmp");
    sidecar
}

/// Reads non-destructive adjustment sidecar bytes from disk on Windows.
pub fn read_sidecar_bytes(raw_path: &Path) -> Result<Option<Vec<u8>>, SidecarError> {
    let xmp_path = sidecar_path_for_raw(raw_path);
    if !xmp_path.exists() {
        return Ok(None);
    }

    fs::read(&xmp_path)
        .map(Some)
        .map_err(|e| SidecarError::Io(xmp_path, e))
}

/// Writes non-destructive adjustment sidecar bytes to disk on Windows.
///
/// Ensures original RAW files are NEVER modified.
pub fn write_sidecar_bytes(raw_path: &Path, content: &[u8]) -> Result<PathBuf, SidecarError> {
    let xmp_path = sidecar_path_for_raw(raw_path);

    // Ensure parent directory exists
    if let Some(parent) = xmp_path.parent() {
        fs::create_dir_all(parent).map_err(|e| SidecarError::Io(parent.to_path_buf(), e))?;
    }

    fs::write(&xmp_path, content).map_err(|e| SidecarError::Io(xmp_path.clone(), e))?;
    Ok(xmp_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sidecar_path_derivation() {
        let p = Path::new(r"C:\Photos\DSC01234.ARW");
        let xmp = sidecar_path_for_raw(p);
        assert_eq!(xmp, PathBuf::from(r"C:\Photos\DSC01234.xmp"));
    }

    #[test]
    fn test_unc_sidecar_path_derivation() {
        let p = Path::new(r"\\NAS\Photos\2026\DSC01234.DNG");
        let xmp = sidecar_path_for_raw(p);
        assert_eq!(xmp, PathBuf::from(r"\\NAS\Photos\2026\DSC01234.xmp"));
    }
}
