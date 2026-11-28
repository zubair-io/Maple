//! Grid thumbnails are rendered by a small pool of threads pulling from one bounded queue.
use std::{
    panic::{self, AssertUnwindSafe},
    path::PathBuf,
    sync::{mpsc, Arc, Mutex, PoisonError},
    thread,
};

use eframe::egui;

use crate::library::Photo;

/// Two renders at once cut a four-photo folder's wall time by about a fifth on a 2-core machine, for twice the memory while rendering.
const WORKERS: usize = 2;
const QUEUE_DEPTH: usize = 2;

type Tile = Result<egui::ColorImage, String>;
type Render = dyn Fn(&Photo) -> Tile + Send + Sync;

/// A small bounded queue keeps grid discovery from accumulating full decodes.
pub struct ThumbnailWorker {
    sender: Option<mpsc::SyncSender<(u64, Photo)>>,
    pub events: mpsc::Receiver<(u64, PathBuf, Tile)>,
    threads: Vec<thread::JoinHandle<()>>,
}

impl ThumbnailWorker {
    pub fn new(context: egui::Context) -> Self {
        Self::with_workers(context, WORKERS)
    }

    pub fn with_workers(context: egui::Context, workers: usize) -> Self {
        Self::spawn(context, workers, Arc::new(super::tile::render))
    }

    fn spawn(context: egui::Context, workers: usize, render: Arc<Render>) -> Self {
        let (sender, queue) = mpsc::sync_channel::<(u64, Photo)>(QUEUE_DEPTH);
        let queue = Arc::new(Mutex::new(queue));
        let (results, events) = mpsc::channel();
        let threads = (0..workers)
            .map(|_| {
                let (queue, results, render, context) = (
                    queue.clone(),
                    results.clone(),
                    render.clone(),
                    context.clone(),
                );
                thread::spawn(move || loop {
                    let next = queue.lock().unwrap_or_else(PoisonError::into_inner).recv();
                    let Ok((generation, photo)) = next else { break };
                    let image = panic::catch_unwind(AssertUnwindSafe(|| render(&photo)))
                        .unwrap_or_else(|_| Err("The thumbnail could not be made".into()));
                    if results.send((generation, photo.path, image)).is_err() {
                        break;
                    }
                    context.request_repaint();
                })
            })
            .collect();
        Self {
            sender: Some(sender),
            events,
            threads,
        }
    }

    pub fn request(&self, generation: u64, photo: Photo) -> bool {
        self.sender
            .as_ref()
            .is_some_and(|sender| sender.try_send((generation, photo)).is_ok())
    }
}

impl Drop for ThumbnailWorker {
    fn drop(&mut self) {
        self.sender.take();
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
#[path = "worker_tests.rs"]
mod worker_tests;
