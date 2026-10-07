//! Continuous source-pixel zoom and a single debounced native patch (#4317).
use super::*;

#[derive(Default)]
pub(super) struct ZoomCanvas {
    pub native: Option<(u32, u32)>,
    pub generation: u64,
    pub scale: f32,
    pub pan: egui::Vec2,
    pending: Option<(Instant, raw_core::pipeline::TileRect, bool)>,
    pub patch: Option<(raw_core::pipeline::TileRect, egui::TextureHandle)>,
    pub base: Option<(std::sync::Arc<egui::ColorImage>, egui::TextureHandle)>,
    pub error: Option<String>,
    pub resolution_status: Option<String>,
    whole_fallback: bool,
    detail_requested: bool,
}
impl ZoomCanvas {
    pub fn refining(&self) -> bool {
        self.error.is_none()
            && self.pending.is_some_and(|(_, rect, _)| {
                self.patch
                    .as_ref()
                    .is_none_or(|(ready, _)| !same(*ready, rect))
            })
    }
    pub fn fit(&mut self) {
        self.scale = 0.0;
        self.pan = egui::Vec2::ZERO;
        self.invalidate();
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
    pub fn image_rect(
        &mut self,
        viewport: egui::Rect,
        size: egui::Vec2,
        pixels_per_point: f32,
    ) -> egui::Rect {
        let fit = (viewport.width() / size.x).min(viewport.height() / size.y) * pixels_per_point;
        let scale = if self.scale == 0.0 {
            fit
        } else {
            self.scale.clamp(0.0001, 8.0)
        };
        let extent = size * (scale / pixels_per_point);
        let limit = ((extent - viewport.size()) * 0.5).max(egui::Vec2::ZERO);
        self.pan = self.pan.clamp(-limit, limit);
        egui::Rect::from_center_size(viewport.center() + self.pan, extent)
    }
    pub fn zoom_at(
        &mut self,
        factor: f32,
        position: egui::Pos2,
        viewport: egui::Rect,
        size: egui::Vec2,
        ppp: f32,
    ) {
        let old = self.image_rect(viewport, size, ppp);
        let fit = (viewport.width() / size.x).min(viewport.height() / size.y) * ppp;
        let current = old.width() / size.x * ppp;
        let next = (current * factor).clamp(fit.min(8.0), 8.0);
        if next <= fit * 1.02 {
            self.fit();
            return;
        }
        self.scale = next;
        self.pan = (position - viewport.center()) - (position - old.center()) * (next / current);
        self.image_rect(viewport, size, ppp);
    }
}

impl MapleApp {
    pub(super) fn cancel_detail(&mut self) {
        if self.zoom.detail_requested {
            self.worker.cancel_detail();
            self.zoom.detail_requested = false;
            self.zoom.generation += 1;
            self.zoom.pending = None;
        }
    }

    pub(super) fn schedule_detail(
        &mut self,
        context: &egui::Context,
        viewport: egui::Rect,
        image: egui::Rect,
        size: egui::Vec2,
    ) {
        if self.zoom.scale <= 0.0 || self.comparing || self.selected.is_none() {
            self.cancel_detail();
            return;
        }
        if self.zoom.scale < 1.0
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
                self.zoom.scale,
            );
            self.queue_detail(context, rect);
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
