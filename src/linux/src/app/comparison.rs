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
        // The worker renders an unresolved request As Shot and echoes that model, so
        // store the same one; the landing pair clears it for one re-request (#4669).
        let model = crate::imported_auto::as_shot_until_resolved(self.render_model(&model));
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
        let geometry = super::zoom::CanvasGeometry {
            viewport,
            source: source_size,
            pixels_per_point: ui.ctx().pixels_per_point(),
        };
        if response.double_clicked() {
            if self.zoom.native.is_some() {
                let position = response.interact_pointer_pos().unwrap_or(viewport.center());
                self.zoom.double_click(position, &geometry);
            } else {
                self.zoom.fit();
            }
        }
        if response.drag_started() {
            self.zoom.drag_started();
        }
        if response.dragged() && !self.comparing {
            self.zoom.drag(response.drag_delta(), &geometry);
        }
        if response.drag_stopped() {
            self.zoom.drag_ended();
        }
        if response.hovered() && self.zoom.native.is_some() {
            let position = response.hover_pos().unwrap_or(viewport.center());
            for factor in super::zoom::zoom_steps(ui.ctx()) {
                self.zoom.zoom_at(factor, position, &geometry);
            }
        }
        if self.zoom.native.is_some() && !super::zoom::text_is_focused(ui.ctx()) {
            if ui.input(|i| super::keyboard::plain_key_pressed(i, egui::Key::F)) {
                self.zoom.fit();
            }
            if ui.input(|i| super::keyboard::plain_key_pressed(i, egui::Key::Z)) {
                self.zoom.zoom_to(1.0);
            }
        }
        let image = self.zoom.image_rect(&geometry);
        let uv = egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1.0, 1.0));
        let painter = ui
            .painter()
            .with_clip_rect(viewport.intersect(ui.clip_rect()));
        let base_id = self
            .zoom
            .base
            .as_ref()
            .filter(|_| self.zoom.is_zoomed() && !self.comparing)
            .map_or(texture_id, |(_, texture)| texture.id());
        painter.image(base_id, image, uv, egui::Color32::WHITE);
        if self.zoom.is_zoomed() && !self.comparing {
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
        } else if self.zoom.scale() >= 1.0 {
            self.zoom.resolution_status.as_deref()
        } else {
            None
        };
        if self.zoom.is_zoomed() && !self.comparing {
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
        let percent = image.width() / source_size.x * geometry.pixels_per_point * 100.0;
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
