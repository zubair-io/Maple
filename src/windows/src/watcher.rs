//! Windows filesystem notification watcher for Maple.
//!
//! Monitors source directories for external sidecar changes (.xmp files updated
//! by external apps or sync tools), notifying the UI layer to auto-refresh state.

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum WatcherError {
    #[error("Failed to initialize file watcher: {0}")]
    Notify(#[from] notify::Error),
}

pub struct WindowsFolderWatcher {
    _watcher: RecommendedWatcher,
    rx: Receiver<notify::Result<Event>>,
}

impl WindowsFolderWatcher {
    /// Spawns a filesystem watcher for a given directory path.
    pub fn watch_folder(dir_path: &Path) -> Result<Self, WatcherError> {
        let (tx, rx) = channel();

        let mut watcher = RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            Config::default(),
        )?;

        watcher.watch(dir_path, RecursiveMode::Recursive)?;

        Ok(Self {
            _watcher: watcher,
            rx,
        })
    }

    /// Non-blocking check for modified `.xmp` sidecar paths.
    pub fn poll_modified_sidecars(&self) -> Vec<PathBuf> {
        let mut modified = Vec::new();
        while let Ok(Ok(event)) = self.rx.try_recv() {
            if matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                for path in event.paths {
                    if path.extension().and_then(|ext| ext.to_str()) == Some("xmp") {
                        modified.push(path);
                    }
                }
            }
        }
        modified
    }
}
