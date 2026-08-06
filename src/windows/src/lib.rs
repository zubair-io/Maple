//! Native Windows host library for Maple RAW Photo Editor.
//!
//! Provides native Rust core execution (`raw-core`), GPU acceleration (`raw-gpu` + `wgpu` DirectX 12/Vulkan),
//! native sidecar I/O, file picking, and directory watching for the Windows desktop shell.

pub mod sidecar;
pub mod watcher;

use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum WindowsHostError {
    #[error("Sidecar operation failed: {0}")]
    Sidecar(#[from] sidecar::SidecarError),
    #[error("Watcher error: {0}")]
    Watcher(#[from] watcher::WatcherError),
    #[error("GPU context error: {0}")]
    Gpu(String),
}

/// Represents the active native Windows session.
pub struct WindowsSession {
    pub current_directory: Option<PathBuf>,
    pub watcher: Option<watcher::WindowsFolderWatcher>,
}

impl WindowsSession {
    pub fn new() -> Self {
        Self {
            current_directory: None,
            watcher: None,
        }
    }

    /// Opens a directory on Windows and begins watching for sidecar changes.
    pub fn set_active_directory(&mut self, path: &Path) -> Result<(), WindowsHostError> {
        self.current_directory = Some(path.to_path_buf());
        let watcher = watcher::WindowsFolderWatcher::watch_folder(path)?;
        self.watcher = Some(watcher);
        Ok(())
    }

    /// Opens native Windows file dialog to select a RAW file or photo directory.
    pub fn pick_folder() -> Option<PathBuf> {
        rfd::FileDialog::new()
            .set_title("Select Photo Directory")
            .pick_folder()
    }

    /// Opens native Windows file dialog to select RAW images.
    pub fn pick_raw_file() -> Option<PathBuf> {
        rfd::FileDialog::new()
            .set_title("Select RAW Image")
            .add_filter("RAW Images", &["dng", "arw", "cr2", "cr3", "nef", "orf", "rw2", "pef"])
            .pick_file()
    }
}

impl Default for WindowsSession {
    fn default() -> Self {
        Self::new()
    }
}
