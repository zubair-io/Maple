//! Read-only queries on the zoom state: input routing (spec §5.0 table) and
//! the named stop the zoom sits on.

use super::geometry::Size;
use super::zoom::CanvasZoomModel;
use super::zoom_context::CanvasZoomContext;
use super::zoom_rules::{distinct_stops, ZoomStop, ZoomStops};

/// Where a one-finger / mouse drag on the canvas routes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DragIntent {
    /// Nothing to pan (fit or below): the drag belongs to the editing surface.
    Editing,
    /// The image overflows the viewport: the drag pans it.
    Pan,
}

/// Where a scroll-wheel event over the canvas routes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WheelIntent {
    /// Command held: zoom anchored at the cursor, in any zoom state.
    Zoom,
    /// The image overflows the viewport and no modifier is held.
    Pan,
    /// Nothing to pan and no modifier: the host's armed-tool nudge.
    Editing,
}

impl CanvasZoomModel {
    /// True when the image overflows the viewport on some axis.
    #[must_use]
    pub fn can_pan(&self, context: &CanvasZoomContext) -> bool {
        self.is_zoomed_in() && context.max_pan_offset(self.pixel_scale) != Size::ZERO
    }

    /// `Pan` when the image overflows the viewport, else `Editing`.
    #[must_use]
    pub fn drag_intent(&self, context: &CanvasZoomContext) -> DragIntent {
        if self.can_pan(context) {
            DragIntent::Pan
        } else {
            DragIntent::Editing
        }
    }

    /// `Zoom` with the command modifier; otherwise as `drag_intent`.
    #[must_use]
    pub fn wheel_intent(&self, command_held: bool, context: &CanvasZoomContext) -> WheelIntent {
        if command_held {
            WheelIntent::Zoom
        } else if self.can_pan(context) {
            WheelIntent::Pan
        } else {
            WheelIntent::Editing
        }
    }

    /// The named stop the zoom sits on, or `None` for a free scale.
    #[must_use]
    pub fn current_stop(&self) -> Option<ZoomStop> {
        if self.pixel_scale == 0.0 {
            Some(ZoomStop::Fit)
        } else if self.fills_viewport {
            Some(ZoomStop::Fill)
        } else if self.pixel_scale == 1.0 {
            Some(ZoomStop::ActualSize)
        } else {
            None
        }
    }

    /// The badge cycle for this geometry: `fit → fill → 100%` without stops
    /// that coincide.
    #[must_use]
    pub fn badge_stops(context: &CanvasZoomContext) -> ZoomStops {
        distinct_stops(context.fit_scale(), context.fill_scale(), Some(1.0))
    }
}
