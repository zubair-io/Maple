use super::*;

impl MapleApp {
    pub(super) fn request_comparison(&mut self) {
        let (Some(baseline), Some(document)) = (&self.comparison_baseline, &self.document) else {
            return;
        };
        if self
            .comparison_model
            .as_ref()
            .is_some_and(|model| model.crop == document.model.crop)
            && self.comparison_error.is_none()
        {
            return;
        }
        let mut model = baseline.clone();
        model.crop = document.model.crop;
        self.comparison_model = Some(model.clone());
        self.comparison_texture = None;
        self.comparison_error = None;
        self.worker.send(Command::Comparison(self.session, model));
    }

    pub(super) fn photo_preview(&mut self, ui: &mut egui::Ui) {
        let displayed = self
            .gpu_texture
            .as_ref()
            .map(|texture| (texture.id(), texture.size()))
            .or_else(|| {
                self.texture
                    .as_ref()
                    .map(|texture| (texture.id(), texture.size_vec2()))
            });
        let Some((texture_id, image_size)) = displayed else {
            ui.centered_and_justified(|ui| {
                ui.label(if self.busy {
                    "Developing preview…"
                } else {
                    "Select a photograph in Browse."
                });
            });
            return;
        };
        let available = ui.available_size();
        let (viewport, response) = ui.allocate_exact_size(available, egui::Sense::click_and_drag());
        response.widget_info(|| {
            egui::WidgetInfo::labeled(egui::WidgetType::Other, true, "Photo preview")
        });
        let source_size =
            self.zoom
                .native
                .map(|(w, h)| {
                    let crop = self.document.as_ref().map(|d| {
                        raw_core::stages::crop::CropPresentation::new(&d.model.crop, w, h)
                    });
                    let (w, h) = crop.map_or((w, h), |c| c.dims);
                    egui::vec2(w as f32, h as f32)
                })
                .unwrap_or(image_size);
        let ppp = ui.ctx().pixels_per_point();
        if response.double_clicked() {
            if self.zoom.scale == 0.0 && self.zoom.native.is_some() {
                self.zoom.scale = 1.0;
            } else {
                self.zoom.fit();
            }
        }
        if response.dragged() && !self.comparing {
            self.zoom.pan += ui.input(|i| i.pointer.delta());
        }
        if response.hovered() && self.zoom.native.is_some() {
            let factor = ui.input(|i| i.zoom_delta());
            if factor != 1.0 {
                self.zoom.zoom_at(
                    factor,
                    response.hover_pos().unwrap_or(viewport.center()),
                    viewport,
                    source_size,
                    ppp,
                );
            }
        }
        if self.zoom.native.is_some() && !super::zoom::text_is_focused(ui.ctx()) {
            if ui.input(|i| super::keyboard::plain_key_pressed(i, egui::Key::F)) {
                self.zoom.fit();
            }
            if ui.input(|i| super::keyboard::plain_key_pressed(i, egui::Key::Z)) {
                self.zoom.scale = 1.0;
                self.zoom.pan = egui::Vec2::ZERO;
            }
        }
        let image = self.zoom.image_rect(viewport, source_size, ppp);
        let uv = egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1.0, 1.0));
        let painter = ui
            .painter()
            .with_clip_rect(viewport.intersect(ui.clip_rect()));
        let base_id = self
            .zoom
            .base
            .as_ref()
            .filter(|_| self.zoom.scale > 0.0 && !self.comparing)
            .map_or(texture_id, |(_, texture)| texture.id());
        painter.image(base_id, image, uv, egui::Color32::WHITE);
        if self.zoom.scale > 0.0 && !self.comparing {
            if let Some((rect, texture)) = &self.zoom.patch {
                let min = image.min
                    + egui::vec2(rect.src_x as f32, rect.src_y as f32) / source_size * image.size();
                let size =
                    egui::vec2(rect.src_w as f32, rect.src_h as f32) / source_size * image.size();
                painter.image(
                    texture.id(),
                    egui::Rect::from_min_size(min, size),
                    uv,
                    egui::Color32::WHITE,
                );
            }
            self.schedule_detail(ui.ctx(), viewport, image, source_size);
        }
        let refinement_status = if self.zoom.refining() {
            Some("Refining…")
        } else if self.zoom.scale >= 1.0 {
            self.zoom.resolution_status.as_deref()
        } else {
            None
        };
        if self.zoom.scale > 0.0 && !self.comparing {
            if let Some(status) = refinement_status {
                painter.text(
                    viewport.right_bottom() + egui::vec2(-8.0, -8.0),
                    egui::Align2::RIGHT_BOTTOM,
                    status,
                    egui::FontId::proportional(13.0),
                    egui::Color32::WHITE,
                );
            }
        }
        let percent = image.width() / source_size.x * ppp * 100.0;
        painter.text(
            viewport.left_bottom() + egui::vec2(8.0, -8.0),
            egui::Align2::LEFT_BOTTOM,
            if self.zoom.native.is_some() {
                format!("{percent:.0}%")
            } else {
                "Fit".into()
            },
            egui::FontId::proportional(13.0),
            egui::Color32::WHITE,
        );
        if let Some(error) = &self.zoom.error {
            painter.text(
                viewport.left_top() + egui::vec2(8.0, 8.0),
                egui::Align2::LEFT_TOP,
                error,
                egui::FontId::proportional(13.0),
                egui::Color32::LIGHT_RED,
            );
        }
        if self.comparing {
            if let Some(before) = &self.comparison_texture {
                let split_x = image.left() + image.width() * self.comparison_split;
                let clip = egui::Rect::from_min_max(image.min, egui::pos2(split_x, image.bottom()));
                ui.painter()
                    .with_clip_rect(clip.intersect(ui.clip_rect()))
                    .image(before.id(), image, uv, egui::Color32::WHITE);
                let handle = egui::Rect::from_center_size(
                    egui::pos2(split_x, image.center().y),
                    egui::vec2(16.0, image.height()),
                );
                let drag = ui.interact(
                    handle,
                    ui.id().with("comparison-divider"),
                    egui::Sense::drag(),
                );
                drag.widget_info(|| {
                    egui::WidgetInfo::slider(
                        true,
                        f64::from(self.comparison_split),
                        "Before/after divider",
                    )
                });
                if drag.dragged() {
                    if let Some(position) = drag.interact_pointer_pos() {
                        self.comparison_split =
                            ((position.x - image.left()) / image.width()).clamp(0.0, 1.0);
                    }
                }
                ui.painter().line_segment(
                    [
                        egui::pos2(split_x, image.top()),
                        egui::pos2(split_x, image.bottom()),
                    ],
                    egui::Stroke::new(1.0_f32, egui::Color32::WHITE),
                );
                for (position, label, anchor) in [
                    (
                        image.left_top() + egui::vec2(8.0, 8.0),
                        "Before",
                        egui::Align2::LEFT_TOP,
                    ),
                    (
                        image.right_top() + egui::vec2(-8.0, 8.0),
                        "After",
                        egui::Align2::RIGHT_TOP,
                    ),
                ] {
                    ui.painter().text(
                        position,
                        anchor,
                        label,
                        egui::FontId::proportional(14.0),
                        egui::Color32::WHITE,
                    );
                }
            } else {
                let message = self
                    .comparison_error
                    .as_deref()
                    .unwrap_or("Preparing before image…");
                ui.painter().text(
                    image.center_top() + egui::vec2(0.0, 12.0),
                    egui::Align2::CENTER_TOP,
                    message,
                    egui::FontId::proportional(14.0),
                    egui::Color32::WHITE,
                );
            }
        }
    }
}
