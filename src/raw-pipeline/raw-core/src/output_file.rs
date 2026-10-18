//! Native derived-output publication (#4910). CLI/FFI writers adopt this in #4698;
//! originals and sidecars are never destinations.
use std::io::{self, Write};
use std::path::Path;

#[cfg(windows)]
fn file_identity(path: &Path) -> io::Result<(u32, u64)> {
    use std::fs::File;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let file = File::open(path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // The live File owns the handle for the duration of this query.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((
        info.dwVolumeSerialNumber,
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    ))
}

fn protected(path: &Path) -> bool {
    #[cfg(windows)]
    let path = Path::new(
        path.to_str()
            .unwrap_or_default()
            .trim_end_matches(['.', ' ']),
    );
    path.extension()
        .and_then(|s| s.to_str())
        .or_else(|| path.file_name()?.to_str()?.strip_prefix('.'))
        .is_some_and(|ext| {
            ext.eq_ignore_ascii_case("xmp")
                || rawler::decoders::supported_extensions()
                    .iter()
                    .any(|raw| ext.eq_ignore_ascii_case(raw))
        })
}

/// Validate before decoding and again immediately before publication. Inputs
/// include the image and any explicitly supplied sidecar, regardless of suffix.
pub fn validate_destination(out: &Path, inputs: &[&Path]) -> io::Result<()> {
    let deny = || {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "output would replace an original or sidecar",
        )
    };
    if protected(out) {
        return Err(deny());
    }
    let resolved = match out.canonicalize() {
        Ok(path) => path,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if protected(&resolved) {
        return Err(deny());
    }
    for input in inputs {
        let source = match input.canonicalize() {
            Ok(path) => path,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        if resolved == source {
            return Err(deny());
        }
        // Canonicalization does not collapse hard links. Atomic replacement
        // would preserve the other link's bytes, but reject source aliases too.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let source = source.metadata()?;
            let destination = resolved.metadata()?;
            if source.dev() == destination.dev() && source.ino() == destination.ino() {
                return Err(deny());
            }
        }
        #[cfg(windows)]
        if file_identity(&resolved)? == file_identity(&source)? {
            return Err(deny());
        }
    }
    Ok(())
}

/// Stage bytes in an exclusively created, random sibling, then atomically
/// replace the destination entry. Never open an existing output or fixed .tmp
/// name for writing, including when either is a symlink or hard link.
/// As with the native host queues, the containing directory must be trusted.
pub fn write_derived(out: &Path, inputs: &[&Path], bytes: &[u8]) -> io::Result<()> {
    // Windows can briefly deny a rename while another publisher is replacing
    // the same entry. Retry the whole guarded publication so every attempt
    // rechecks aliases and owns a fresh staging file.
    #[cfg(windows)]
    for attempt in 0..20 {
        match write_derived_once(out, inputs, bytes) {
            Err(error) if attempt < 19 && matches!(error.raw_os_error(), Some(5 | 32)) => {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            result => return result,
        }
    }
    #[cfg(windows)]
    unreachable!("the final publication attempt always returns");

    #[cfg(not(windows))]
    write_derived_once(out, inputs, bytes)
}

fn write_derived_once(out: &Path, inputs: &[&Path], bytes: &[u8]) -> io::Result<()> {
    validate_destination(out, inputs)?;
    let parent = out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut builder = tempfile::Builder::new();
    builder.prefix(".maple-export-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Match ordinary output creation; the kernel applies the process umask.
        builder.permissions(std::fs::Permissions::from_mode(0o666));
    }
    let mut staging = builder.tempfile_in(parent)?;
    staging.write_all(bytes)?;
    staging.as_file().sync_all()?;
    validate_destination(out, inputs)?;
    staging.persist(out).map_err(|e| e.error)?;
    // On Unix the rename is durable only after the containing directory is synced.
    #[cfg(unix)]
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}
