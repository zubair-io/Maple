//! Name-only imported Auto WB in the Linux shell (#4669): the first frame
//! renders As Shot, one background estimate per open session starts once that
//! frame was sent, then the UI re-renders once with the pair overlaid on the
//! render model only.
use crate::jobs::Event;
use eframe::egui;
use raw_core::{types::adjustment::AdjustmentModel, RawImage};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};

/// Interactive renders never estimate: an unresolved name-only Auto renders
/// As Shot until the UI sends the resolved pair. Final outputs keep it.
pub(crate) fn as_shot_until_resolved(mut model: AdjustmentModel) -> AdjustmentModel {
    model.unresolved_auto_wb = false;
    model
}

/// A session's estimate in flight. Dropping it with its session (navigation,
/// close) cancels the estimate, so the thread unwinds and releases the RAW.
pub(crate) struct Estimate {
    cancel: Arc<AtomicBool>,
}

impl Drop for Estimate {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

/// Run the shared estimator off the render thread. Failure keeps As Shot on
/// screen; the next open retries.
pub(crate) fn spawn_estimate(
    id: u64,
    raw: Arc<RawImage>,
    results: mpsc::Sender<Event>,
    context: egui::Context,
) -> Estimate {
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancel);
    std::thread::spawn(move || {
        let estimate =
            raw_core::stages::imported_auto_wb::estimate(&raw, raw_core::CancelToken::new(&flag));
        drop(raw);
        if let Ok(pair) = estimate {
            let _ = results.send(Event::ImportedWhiteBalance(id, pair));
            context.request_repaint();
        }
    });
    Estimate { cancel }
}

#[cfg(test)]
#[path = "imported_auto_tests.rs"]
mod tests;
