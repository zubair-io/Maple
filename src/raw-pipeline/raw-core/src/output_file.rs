//! Native derived-output publication (#4910). CLI/FFI writers adopt this in #4698;
//! originals and sidecars are never destinations.
use std::io::{self, Write};
use std::path::Path;

fn protected(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
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
    }
    Ok(())
}

/// Stage bytes in an exclusively created, random sibling, then atomically
/// replace the destination entry. Never open an existing output or fixed .tmp
/// name for writing, including when either is a symlink or hard link.
/// As with the native host queues, the containing directory must be trusted.
pub fn write_derived(out: &Path, inputs: &[&Path], bytes: &[u8]) -> io::Result<()> {
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
    Ok(())
}
