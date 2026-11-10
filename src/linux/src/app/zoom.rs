//! The canvas zoom state over the shared `raw_core::canvas` model (#5714) and a
//! single debounced native patch (#4317).
use super::*;
use raw_core::canvas::{
    CanvasZoomContext, CanvasZoomModel, DoubleTapBehavior, Point, Size, ZoomStop,
    WHEEL_ZOOM_SENSITIVITY,
};

/// One frame's canvas geometry: the viewport in egui points, the oriented
/// (cropped) source extent in pixels, and egui's points → pixels factor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct CanvasGeometry {
    pub viewport: egui::Rect,
    pub source: egui::Vec2,
    pub pixels_per_point: f32,
}

impl CanvasGeometry {
    fn context(&self) -> CanvasZoomContext {
        CanvasZoomContext::new(
            size(self.viewport.size()),
            size(self.source),
            f64::from(self.pixels_per_point),
        )
    }

    fn local(&self, position: egui::Pos2) -> Point {
        let offset = position - self.viewport.min;
        Point::new(f64::from(offset.x), f64::from(offset.y))
    }
}

fn size(extent: egui::Vec2) -> Size {
    Size::new(f64::from(extent.x), f64::from(extent.y))
}

fn has_fill_stop(context: &CanvasZoomContext) -> bool {
    CanvasZoomModel::badge_stops(context).contains(ZoomStop::Fill)
}

/// egui's `zoom_delta()` smooths a Ctrl+wheel notch over several frames, and a
/// smoothed tail starting at the fit stop carries the photo past it; the raw
/// events keep one notch as one model step.
pub(super) fn zoom_steps(context: &egui::Context) -> Vec<f32> {
    let (line_scroll_speed, scroll_zoom_speed) =
        context.options(|o| (o.line_scroll_speed, o.scroll_zoom_speed));
    context.input(|input| {
        let touch_zoom = input.multi_touch().map(|touch| touch.zoom_delta);
        let steps = input.events.iter().filter_map(|event| match event {
            egui::Event::Zoom(factor) if touch_zoom.is_none() => Some(*factor),
            egui::Event::MouseWheel {
                unit,
                delta,
                modifiers,
                // egui reads Shift+wheel as horizontal scroll, never zoom
            } if (modifiers.ctrl || modifiers.command || modifiers.mac_cmd) && !modifiers.shift => {
                let points = match unit {
                    egui::MouseWheelUnit::Point => delta.y,
                    egui::MouseWheelUnit::Line => line_scroll_speed * delta.y,
                    egui::MouseWheelUnit::Page => input.screen_rect().height() * delta.y,
                };
                Some((scroll_zoom_speed * points).exp())
            }
            _ => None,
        });
        touch_zoom
            .into_iter()
            .chain(steps)
            .filter(|factor| *factor != 1.0 && factor.is_finite())
            .collect()
    })
}

#[derive(Default)]
pub(super) struct ZoomCanvas {
    pub native: Option<(u32, u32)>,
    pub generation: u64,
    model: CanvasZoomModel,
    drag_translation: egui::Vec2,
    last_context: Option<CanvasZoomContext>,
    pending: Option<(Instant, raw_core::pipeline::TileRect, bool)>,
    pub patch: Option<(raw_core::pipeline::TileRect, egui::TextureHandle)>,
    pub base: Option<(std::sync::Arc<egui::ColorImage>, egui::TextureHandle)>,
    pub error: Option<String>,
    pub resolution_status: Option<String>,
    whole_fallback: bool,
    detail_requested: bool,
}
impl ZoomCanvas {
    /// Real pixels per source pixel; `0` is fit.
    #[must_use]
    pub fn scale(&self) -> f32 {
        self.model.pixel_scale as f32
    }

    /// Points; positive = photo moved right/down.
    #[must_use]
    pub fn pan(&self) -> egui::Vec2 {
        egui::vec2(
            self.model.pan_offset.width as f32,
            self.model.pan_offset.height as f32,
        )
    }

    /// True once zoomed away from fit, in or out.
    #[must_use]
    pub fn is_zoomed(&self) -> bool {
        self.model.is_zoomed_in()
    }

    /// True once laid out with a zoom below both fit and 100%, where the fit
    /// preview already holds more pixels than the screen shows.
    #[must_use]
    fn below_fit_preview(&self) -> bool {
        self.model.pixel_scale < 1.0
            && self.last_context.is_some_and(|context| {
                context.effective_scale(self.model.pixel_scale) < context.fit_scale()
            })
    }

    pub fn refining(&self) -> bool {
        self.error.is_none()
            && self.pending.is_some_and(|(_, rect, _)| {
                self.patch
                    .as_ref()
                    .is_none_or(|(ready, _)| !same(*ready, rect))
            })
    }
    /// The last laid-out geometry; before the first layout, an empty one whose
    /// home position is the viewport centre.
    fn laid_out_context(&self) -> CanvasZoomContext {
        self.last_context.unwrap_or_default()
    }

    pub fn fit(&mut self) {
        self.settle(self.model.reset_to_fit(&self.laid_out_context()));
        self.invalidate();
    }

    /// Re-centred zoom to `scale` real pixels per source pixel (the 100%
    /// control and Z use 1), clamped to the model's explicit range.
    pub fn zoom_to(&mut self, scale: f64) {
        self.settle(self.model.zoom_to_scale(scale, &self.laid_out_context()));
    }

    /// The fill stop for the last laid-out geometry; ignored when fill is not
    /// a distinct stop there.
    pub fn fill(&mut self) {
        if let Some(context) = self.last_context.filter(has_fill_stop) {
            self.settle(self.model.zoom_to_fill(&context));
        }
    }

    /// True when the last laid-out geometry has a fill stop distinct from fit.
    #[must_use]
    pub fn can_fill(&self) -> bool {
        self.last_context.as_ref().is_some_and(has_fill_stop)
    }

    /// The editor's fit ↔ 100% toggle, anchored at `position`.
    pub fn double_click(&mut self, position: egui::Pos2, geometry: &CanvasGeometry) {
        let next = self.model.double_tap(
            geometry.local(position),
            DoubleTapBehavior::ToggleFitAnd100,
            &geometry.context(),
        );
        self.settle(next);
    }

    /// Starts a drag from the current pan, discarding any translation left by
    /// a drag whose release the canvas never saw.
    pub fn drag_started(&mut self) {
        self.drag_translation = egui::Vec2::ZERO;
        self.model = self.model.rebase_drag_baseline(Size::ZERO);
    }

    /// One drag frame; egui reports per-frame deltas, the model expects the
    /// translation since the drag began.
    pub fn drag(&mut self, delta: egui::Vec2, geometry: &CanvasGeometry) {
        self.drag_translation += delta;
        let (next, _) = self
            .model
            .drag_changed(size(self.drag_translation), &geometry.context());
        self.model = next;
    }

    pub fn drag_ended(&mut self) {
        self.drag_translation = egui::Vec2::ZERO;
        let (next, _) = self.model.drag_ended();
        self.model = next;
    }

    /// One Ctrl+wheel or pinch step: the multiplicative `factor` becomes the
    /// model's wheel delta, so the zoom anchors at `position`.
    pub fn zoom_at(&mut self, factor: f32, position: egui::Pos2, geometry: &CanvasGeometry) {
        let normalized_delta_y = f64::from(factor).log2() / WHEEL_ZOOM_SENSITIVITY;
        let next = self.model.wheel_zoom(
            normalized_delta_y,
            geometry.local(position),
            &geometry.context(),
        );
        self.settle(next);
    }

    /// Carries the zoom into this frame's geometry (fill follows a resize, a
    /// density change keeps the centred image point centred, pan stays inside
    /// the image) and returns the image's on-screen rectangle.
    pub fn image_rect(&mut self, geometry: &CanvasGeometry) -> egui::Rect {
        let context = geometry.context();
        let carried = match self.last_context.replace(context) {
            Some(previous) if previous != context => {
                self.model.geometry_changed(&previous, &context)
            }
            _ => self.model.reclamp_pan(&context),
        };
        self.settle(carried);
        let extent = context
            .display_frame_in_points(self.model.pixel_scale)
            .map_or(egui::Vec2::ZERO, |frame| {
                egui::vec2(frame.width as f32, frame.height as f32)
            });
        egui::Rect::from_center_size(geometry.viewport.center() + self.pan(), extent)
    }

    /// Adopts `next`, releasing any native detail when it returns to fit. When
    /// the zoom or clamp moved the photo, a drag in progress continues from
    /// the new pan: the pan is committed together with the translation so far.
    fn settle(&mut self, next: CanvasZoomModel) {
        if next == self.model {
            return;
        }
        let returned_to_fit = self.model.is_zoomed_in() && !next.is_zoomed_in();
        self.model = CanvasZoomModel {
            base_pan: next.pan_offset,
            ..next
        }
        .rebase_drag_baseline(size(self.drag_translation));
        if returned_to_fit {
            self.invalidate();
        }
    }

    /// Places the photo at `pan` points from centre, as if dragged there; the
    /// next layout clamps it.
    #[cfg(test)]
    pub fn set_pan(&mut self, pan: egui::Vec2) {
        self.model.pan_offset = size(pan);
        self.model.base_pan = size(pan);
    }

    pub fn invalidate(&mut self) {
        self.generation += 1;
        self.pending = None;
        self.patch = None;
        self.base = None;
        self.error = None;
        self.resolution_status = None;
        self.whole_fallback = false;
    }
}

impl MapleApp {
    pub(super) fn cancel_detail(&mut self) {
        if self.zoom.detail_requested {
            self.worker.cancel_detail();
            self.zoom.detail_requested = false;
            self.zoom.generation += 1;
        }
        self.zoom.pending = None;
    }

    pub(super) fn schedule_detail(
        &mut self,
        context: &egui::Context,
        viewport: egui::Rect,
        image: egui::Rect,
        size: egui::Vec2,
    ) {
        if !self.zoom.is_zoomed() || self.comparing || self.selected.is_none() {
            self.cancel_detail();
            return;
        }
        if self.zoom.below_fit_preview() {
            self.cancel_detail();
            if self.zoom.patch.is_some() || self.zoom.base.is_some() {
                self.zoom.invalidate();
            }
            return;
        }
        if self.zoom.scale() < 1.0
            || self.zoom.whole_fallback
            || self
                .document
                .as_ref()
                .is_some_and(|d| crate::whole_detail::required(&d.model))
        {
            let Some(native) = self.zoom.native else {
                return;
            };
            let rect = crate::whole_detail::request_rect(
                native,
                (size.x as u32, size.y as u32),
                self.zoom.scale(),
            );
            self.queue_detail(context, rect);
            return;
        }
        if self.zoom.native.is_none() {
            return;
        }
        let visible = viewport.intersect(image);
        if !visible.is_positive() {
            return;
        }
        let min = (visible.min - image.min) / image.size() * size;
        let max = (visible.max - image.min) / image.size() * size;
        let visible_rect = raw_core::pipeline::TileRect {
            src_x: min.x.floor() as u32,
            src_y: min.y.floor() as u32,
            src_w: (max.x.ceil() - min.x.floor()) as u32,
            src_h: (max.y.ceil() - min.y.floor()) as u32,
            out_w: 0,
            out_h: 0,
        };
        if self
            .zoom
            .patch
            .as_ref()
            .is_some_and(|(old, _)| contains(*old, visible_rect))
        {
            return;
        }
        let margin = ((max - min).max_elem() * 0.125).min(256.0);
        let min = (min - egui::Vec2::splat(margin))
            .max(egui::Vec2::ZERO)
            .floor();
        let max = (max + egui::Vec2::splat(margin)).min(size).ceil();
        let rect = raw_core::pipeline::TileRect {
            src_x: min.x as u32,
            src_y: min.y as u32,
            src_w: (max.x - min.x) as u32,
            src_h: (max.y - min.y) as u32,
            out_w: (max.x - min.x) as u32,
            out_h: (max.y - min.y) as u32,
        };
        if self
            .zoom
            .patch
            .as_ref()
            .is_some_and(|(old, _)| contains(*old, rect))
        {
            return;
        }
        self.queue_detail(context, rect);
    }

    fn queue_detail(&mut self, context: &egui::Context, rect: raw_core::pipeline::TileRect) {
        if self
            .zoom
            .patch
            .as_ref()
            .is_some_and(|(ready, _)| same(*ready, rect))
        {
            return;
        }
        match self.zoom.pending {
            Some((time, old, sent)) if same(old, rect) => {
                if !sent && time.elapsed() >= Duration::from_millis(150) {
                    // Keep the request identity while in flight; the bounded worker
                    // drops superseded pans. A newer view restarts the debounce.
                    if let Some(document) = &self.document {
                        self.zoom.generation += 1;
                        self.worker.send(Command::Detail(
                            self.session,
                            self.zoom.generation,
                            document.model.clone(),
                            rect,
                        ));
                        self.zoom.detail_requested = true;
                    }
                    self.zoom.pending = Some((time, rect, true));
                }
            }
            _ => {
                self.zoom.generation += 1;
                self.zoom.pending = Some((Instant::now(), rect, false));
                self.zoom.error = None;
            }
        }
        if self.zoom.pending.is_some_and(|(_, _, sent)| !sent) {
            context.request_repaint_after(Duration::from_millis(150));
        }
    }
    pub(super) fn accept_detail(
        &mut self,
        context: &egui::Context,
        frame: crate::detail::DetailFrame,
    ) {
        if !self
            .zoom
            .pending
            .is_some_and(|(_, rect, _)| same(rect, frame.request))
        {
            return;
        }
        if !self
            .zoom
            .base
            .as_ref()
            .is_some_and(|(base, _)| std::sync::Arc::ptr_eq(base, &frame.base))
        {
            let texture = context.load_texture(
                "detail-reference",
                (*frame.base).clone(),
                egui::TextureOptions::LINEAR,
            );
            self.zoom.base = Some((frame.base, texture));
        }
        self.zoom.whole_fallback = frame.whole_fallback;
        if frame.whole_fallback {
            if let Some((time, _, sent)) = self.zoom.pending {
                self.zoom.pending = Some((time, frame.rect, sent));
            }
        }
        let fraction = frame.patch.size[0] as f32 / frame.rect.src_w as f32;
        self.zoom.resolution_status = (fraction < 0.99)
            .then(|| format!("Refined at {:.0}% source resolution", fraction * 100.0));
        if frame.whole_fallback && self.zoom.resolution_status.is_none() {
            self.zoom.resolution_status = Some("Whole-image refinement".to_owned());
        }
        self.zoom.patch = Some((
            frame.rect,
            context.load_texture("native-detail", frame.patch, egui::TextureOptions::LINEAR),
        ));
        self.zoom.error = None;
    }
}
fn same(a: raw_core::pipeline::TileRect, b: raw_core::pipeline::TileRect) -> bool {
    a.src_x == b.src_x
        && a.src_y == b.src_y
        && a.src_w == b.src_w
        && a.src_h == b.src_h
        && a.out_w == b.out_w
        && a.out_h == b.out_h
}
fn contains(a: raw_core::pipeline::TileRect, b: raw_core::pipeline::TileRect) -> bool {
    a.src_w == a.out_w
        && a.src_h == a.out_h
        && a.src_x <= b.src_x
        && a.src_y <= b.src_y
        && a.src_x + a.src_w >= b.src_x + b.src_w
        && a.src_y + a.src_h >= b.src_y + b.src_h
}

pub(super) fn text_is_focused(context: &egui::Context) -> bool {
    context
        .memory(|memory| memory.focused())
        .is_some_and(|id| egui::TextEdit::load_state(context, id).is_some())
}
