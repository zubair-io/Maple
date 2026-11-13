//! Platform file plumbing for the frame store: positional I/O, free space,
//! the per-store directory and the orphan sweep.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::PanoError;

pub(super) fn pixels_as_bytes(pixels: &[[f32; 3]]) -> &[u8] {
    // SAFETY: `[f32; 3]` has no padding, so the slice is exactly
    // `len * 12` initialised bytes; `u8` has alignment 1.
    unsafe {
        std::slice::from_raw_parts(pixels.as_ptr().cast::<u8>(), std::mem::size_of_val(pixels))
    }
}

pub(super) fn pixels_as_bytes_mut(pixels: &mut [[f32; 3]]) -> &mut [u8] {
    // SAFETY: as above, and every bit pattern is a valid `f32`, so any
    // bytes written through the view leave the pixels valid.
    unsafe {
        std::slice::from_raw_parts_mut(
            pixels.as_mut_ptr().cast::<u8>(),
            std::mem::size_of_val(pixels),
        )
    }
}

#[cfg(unix)]
pub(super) fn read_exact_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(file, buf, offset)
}

#[cfg(unix)]
pub(super) fn write_all_at(file: &File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::write_all_at(file, buf, offset)
}

#[cfg(windows)]
pub(super) fn read_exact_at(
    file: &File,
    mut buf: &mut [u8],
    mut offset: u64,
) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        match file.seek_read(buf, offset)? {
            0 => return Err(std::io::ErrorKind::UnexpectedEof.into()),
            n => {
                buf = &mut buf[n..];
                offset += n as u64;
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn write_all_at(file: &File, mut buf: &[u8], mut offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        match file.seek_write(buf, offset)? {
            0 => return Err(std::io::ErrorKind::WriteZero.into()),
            n => {
                buf = &buf[n..];
                offset += n as u64;
            }
        }
    }
    Ok(())
}

/// Bytes an unprivileged writer can still put on `path`'s volume.
#[cfg(unix)]
pub(super) fn available_bytes(path: &Path) -> std::io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `c_path` is NUL-terminated and `stats` is a valid out-pointer.
    if unsafe { libc::statvfs(c_path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: statvfs returned 0, so it filled `stats`.
    let stats = unsafe { stats.assume_init() };
    #[allow(clippy::useless_conversion)]
    Ok(u64::from(stats.f_bavail).saturating_mul(u64::from(stats.f_frsize)))
}

#[cfg(windows)]
pub(super) fn available_bytes(path: &Path) -> std::io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut available = 0u64;
    // SAFETY: `wide` is NUL-terminated; the unused totals may be null.
    let ok = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(available)
}

/// `<parent>/<prefix><pid>-<n>`, created fresh (never an existing dir).
pub(super) fn create_unique_dir(parent: &Path, prefix: &str) -> Result<PathBuf, PanoError> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    loop {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = parent.join(format!("{prefix}{}-{n}", std::process::id()));
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(PanoError::io(&dir, e)),
        }
    }
}

/// Remove `<prefix><pid>-*` directories whose process no longer exists —
/// what a stitch killed outright (jetsam, SIGKILL) leaves behind. Process
/// ids are this machine's, so the parent must not be shared with another
/// host or pid namespace.
pub(super) fn sweep_orphans(parent: &Path, prefix: &str) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|n| n.strip_prefix(prefix))
            .and_then(|rest| rest.split_once('-'))
            .and_then(|(pid, _)| pid.parse::<u32>().ok())
        else {
            continue;
        };
        if pid > 0 && pid != std::process::id() && !process_alive(pid) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return true;
    };
    // SAFETY: signal 0 only checks that `pid` exists and may be signalled.
    let signalled = unsafe { libc::kill(pid, 0) } == 0;
    signalled || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: plain handle queries; the handle is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // Access denied means it exists; anything else means it's gone.
            return std::io::Error::last_os_error().raw_os_error() == Some(5);
        }
        let mut code = 0u32;
        let queried = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        queried == 0 || code == STILL_ACTIVE as u32
    }
}
