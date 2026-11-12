//! Name-only imported Auto WB in the Linux shell (#4669): the first frame
//! renders As Shot, one background estimate per open session, then the UI
//! re-renders once with the pair overlaid on the render model only.
use crate::jobs::Event;
use eframe::egui;
use raw_core::{types::adjustment::AdjustmentModel, RawImage};
use std::sync::{mpsc, Arc};

/// Interactive renders never estimate: an unresolved name-only Auto renders
/// As Shot until the UI sends the resolved pair. Final outputs keep it.
pub(crate) fn as_shot_until_resolved(mut model: AdjustmentModel) -> AdjustmentModel {
    model.unresolved_auto_wb = false;
    model
}

/// Run the shared estimator off the render thread. Failure keeps As Shot on
/// screen; the next open retries.
pub(crate) fn spawn_estimate(
    id: u64,
    raw: Arc<RawImage>,
    results: mpsc::Sender<Event>,
    context: egui::Context,
) {
    std::thread::spawn(move || {
        let estimate =
            raw_core::stages::imported_auto_wb::estimate(&raw, raw_core::CancelToken::never());
        if let Ok(pair) = estimate {
            let _ = results.send(Event::ImportedWhiteBalance(id, pair));
            context.request_repaint();
        }
    });
}

#[cfg(test)]
#[path = "imported_auto_tests.rs"]
mod tests;
