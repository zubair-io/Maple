use super::{MapleApp, Navigation};
use eframe::egui;

impl MapleApp {
    pub(super) fn views(&mut self, context: &egui::Context) {
        context.accesskit_node_builder(egui::accesskit_root_id(), |node| {
            node.set_label("Maple");
        });
        self.history_shortcuts(context);
        if self.browse || self.cloud.active {
            egui::TopBottomPanel::top("controls")
                .frame(super::style::panel("bg"))
                .show(context, |ui| self.toolbar(context, ui));
        } else {
            egui::Area::new(egui::Id::new("editor-top-bar"))
                .anchor(egui::Align2::CENTER_TOP, [0.0, 12.0])
                .show(context, |ui| {
                    ui.set_max_width((context.screen_rect().width() - 32.0).min(980.0));
                    super::style::panel("surface")
                        .rounding(16.0)
                        .show(ui, |ui| self.toolbar(context, ui));
                });
        }
        if self.cloud_editor.is_none() {
            self.cloud.dialog(context);
        }
        if self.cloud.active {
            self.cloud.views(context, &mut self.browse);
            if let Some(entry) = self.cloud.edit_request.take() {
                self.navigate(Navigation::CloudDownload(entry));
            }
            return;
        }
        egui::TopBottomPanel::bottom("status")
            .frame(super::style::panel("surface"))
            .show(context, |ui| {
                ui.label(
                    egui::RichText::new(&self.status)
                        .small()
                        .color(super::style::color("text_muted")),
                );
                if let Some(error) = &self.error {
                    ui.colored_label(egui::Color32::LIGHT_RED, error);
                }
            });
        if self.browse {
            egui::SidePanel::left("sources")
                .default_width(220.0)
                .frame(super::style::panel("sidebar"))
                .show(context, |ui| {
                    if let Some(entry) = &self.cloud_editor {
                        ui.heading("Maple cloud");
                        ui.label(&entry.name);
                        ui.label(&entry.path);
                        return;
                    }
                    ui.heading("Folders");
                    let navigation = self.folder.as_ref().and_then(|folder| {
                        ui.label(folder.path.display().to_string());
                        let parent = folder.path.parent().map(|path| path.to_path_buf());
                        let up = ui
                            .add_enabled(parent.is_some(), egui::Button::new("Parent folder"))
                            .clicked()
                            .then_some(parent)
                            .flatten();
                        let mut selected = up;
                        egui::ScrollArea::vertical().show(ui, |ui| {
                            for path in &folder.folders {
                                if ui
                                    .add_sized(
                                        [ui.available_width(), 36.0],
                                        egui::Button::new(
                                            path.file_name().unwrap_or_default().to_string_lossy(),
                                        )
                                        .frame(false),
                                    )
                                    .clicked()
                                {
                                    selected = Some(path.clone());
                                }
                            }
                        });
                        selected
                    });
                    if let Some(path) = navigation {
                        self.open_folder(path);
                    }
                });
        }

        if !self.browse && self.cloud_editor.is_some() {
            let mut next = None;
            egui::TopBottomPanel::bottom("cloud-filmstrip").show(context, |ui| {
                egui::ScrollArea::horizontal().show(ui, |ui| {
                    ui.horizontal(|ui| {
                        for entry in self.cloud.photos() {
                            if ui
                                .add_enabled(
                                    !self.cloud.downloading,
                                    egui::Button::new(&entry.name),
                                )
                                .clicked()
                            {
                                next = Some(entry);
                            }
                        }
                    });
                });
            });
            if let Some(entry) = next {
                self.navigate(Navigation::CloudDownload(entry));
            }
        }
        if !self.browse && self.cloud_editor.is_none() {
            let mut selected = None;
            egui::TopBottomPanel::bottom("filmstrip")
                .frame(super::style::panel("surface"))
                .show(context, |ui| {
                    egui::ScrollArea::horizontal().show(ui, |ui| {
                        ui.horizontal(|ui| {
                            if let Some(folder) = &self.folder {
                                for photo in &folder.photos {
                                    let name = photo
                                        .path
                                        .file_name()
                                        .unwrap_or_default()
                                        .to_string_lossy();
                                    let selected_now = self
                                        .selected
                                        .as_ref()
                                        .is_some_and(|current| current.path == photo.path);
                                    let response = match self.thumbnail_cache.get(&photo.path) {
                                        Some(Ok(texture)) => ui.add(
                                            egui::Image::new(texture)
                                                .fit_to_exact_size(egui::vec2(72.0, 46.0))
                                                .rounding(5.0)
                                                .sense(egui::Sense::click()),
                                        ),
                                        Some(Err(error)) => {
                                            ui.button("Preview unavailable").on_hover_text(error)
                                        }
                                        None => ui.button(name.as_ref()),
                                    }
                                    .on_hover_text(name.as_ref());
                                    if ui.clip_rect().intersects(response.rect)
                                        && !self.thumbnail_pending.contains(&photo.path)
                                        && self
                                            .thumbnails
                                            .request(self.thumbnail_epoch, photo.clone())
                                    {
                                        self.thumbnail_pending.insert(photo.path.clone());
                                    }
                                    response.widget_info(|| {
                                        egui::WidgetInfo::labeled(
                                            egui::WidgetType::Button,
                                            response.enabled(),
                                            format!("Open {name}"),
                                        )
                                    });
                                    if response.clicked() {
                                        selected = Some(photo.clone());
                                    }
                                    if selected_now {
                                        ui.painter().rect_stroke(
                                            response.rect,
                                            5.0,
                                            egui::Stroke::new(
                                                2.0_f32,
                                                super::style::color("primary"),
                                            ),
                                        );
                                    }
                                }
                            }
                        });
                    });
                });
            if let Some(photo) = selected {
                self.select(photo);
            }
        }
        egui::CentralPanel::default()
            .frame(super::style::panel(if self.browse {
                "bg"
            } else {
                "image_canvas"
            }))
            .show(context, |ui| {
                if self.browse && self.cloud_editor.is_none() {
                    let mut selected = None;
                    if let Some(folder) = &self.folder {
                        let columns = (ui.available_width() / 160.0).floor().max(1.0) as usize;
                        let rows = folder.photos.len().div_ceil(columns);
                        egui::ScrollArea::vertical().show_rows(ui, 155.0, rows, |ui, range| {
                            for row in range {
                                ui.horizontal(|ui| {
                                    for photo in
                                        folder.photos.iter().skip(row * columns).take(columns)
                                    {
                                        ui.allocate_ui_with_layout(
                                            egui::vec2(150.0, 145.0),
                                            egui::Layout::top_down(egui::Align::Center),
                                            |ui| {
                                                let response = match self
                                                    .thumbnail_cache
                                                    .get(&photo.path)
                                                {
                                                    Some(Ok(texture)) => ui.add(
                                                        egui::Image::new(texture)
                                                            .fit_to_exact_size(
                                                                texture.size_vec2()
                                                                    * (140.0
                                                                        / texture.size_vec2().x)
                                                                        .min(
                                                                            110.0
                                                                                / texture
                                                                                    .size_vec2()
                                                                                    .y,
                                                                        ),
                                                            )
                                                            .sense(egui::Sense::click()),
                                                    ),
                                                    Some(Err(error)) => ui
                                                        .add_sized(
                                                            [140.0, 110.0],
                                                            egui::Button::new(
                                                                "Preview unavailable",
                                                            ),
                                                        )
                                                        .on_hover_text(error),
                                                    None => {
                                                        if !self
                                                            .thumbnail_pending
                                                            .contains(&photo.path)
                                                            && self.thumbnails.request(
                                                                self.thumbnail_epoch,
                                                                photo.clone(),
                                                            )
                                                        {
                                                            self.thumbnail_pending
                                                                .insert(photo.path.clone());
                                                        }
                                                        ui.add_sized(
                                                            [140.0, 110.0],
                                                            egui::Button::new("Loading…"),
                                                        )
                                                    }
                                                };
                                                let name = photo
                                                    .path
                                                    .file_name()
                                                    .unwrap_or_default()
                                                    .to_string_lossy();
                                                response.widget_info(|| {
                                                    egui::WidgetInfo::labeled(
                                                        egui::WidgetType::Button,
                                                        response.enabled(),
                                                        format!("Open {name}"),
                                                    )
                                                });
                                                if response.clicked() {
                                                    selected = Some(photo.clone());
                                                }
                                                ui.label(name);
                                            },
                                        );
                                    }
                                });
                            }
                        });
                    } else {
                        ui.centered_and_justified(|ui| {
                            ui.label("Choose a folder to browse your photographs.");
                        });
                    }
                    if let Some(photo) = selected {
                        self.select(photo);
                    }
                } else {
                    self.photo_preview(ui);
                }
            });
        if !self.browse {
            self.inspector(context);
        }
    }
    fn toolbar(&mut self, context: &egui::Context, ui: &mut egui::Ui) {
        ui.horizontal_wrapped(|ui| {
            ui.add(egui::Image::new(&self.maple_icon).fit_to_exact_size(egui::vec2(24.0, 24.0)));
            ui.heading("Maple");
                ui.menu_button("Library", |ui| {
                if ui
                    .add_enabled(
                        self.cloud_editor.is_none(),
                        egui::Button::new("Connect to Maple…"),
                    )
                    .clicked()
                {
                    self.cloud.dialog = true;
                }
                ui.add_enabled(
                    self.cloud_editor.is_none(),
                    egui::Checkbox::new(&mut self.cloud.active, "Cloud"),
                );
                if self.cloud_editor.is_some() && ui.button("Back to cloud").clicked() {
                    self.navigate(Navigation::CloudBrowse);
                }
                if ui.button("Open folder…").clicked() {
                    self.choose_folder(context);
                }
                });
                ui.separator();
                ui.selectable_value(&mut self.browse, true, "Browse");
                ui.selectable_value(&mut self.browse, false, "Full image");
                if ui.add_enabled(
                    !self.cloud.active && !self.cloud.downloading && self.auto_pending.is_none()
                        && self.before_edit.is_none()
                        && self.selected.as_ref().is_some_and(|photo| photo.kind == crate::library::MediaKind::Raw)
                        && self.document.is_some(),
                    egui::Button::new("AUTO"),
                ).clicked() { self.auto_adjust(); }
                if ui
                    .add_enabled(
                        !self.cloud.active && !self.cloud.downloading && !self.history.is_empty(),
                        egui::Button::new("Undo"),
                    )
                    .clicked()
                {
                    self.undo(false);
                }
                ui.menu_button("More", |ui| {
                if ui
                    .add_enabled(
                        !self.cloud.active && !self.cloud.downloading && !self.redo.is_empty(),
                        egui::Button::new("Redo"),
                    )
                    .clicked()
                {
                    self.undo(true);
                }
                if ui
                    .add_enabled(
                        !self.cloud.active
                            && !self.cloud.downloading
                            && self.document.is_some()
                            && self.saving == 0,
                        egui::Button::new("Save XMP"),
                    )
                    .clicked()
                {
                    self.save_failed = false;
                    self.dirty = Some(std::time::Instant::now());
                    self.flush();
                }
                });
                if ui.add_enabled(
                    !self.cloud.active && !self.cloud.downloading && self.document.is_some(),
                    egui::Button::new("Reset"),
                ).on_hover_text("Restore develop defaults and as-shot white balance; keep crop, rotation, ratings and flags").clicked() {
                    self.reset_develop();
                }
                if self.save_failed
                    && self.saving == 0
                    && !self.cloud.downloading
                    && ui.button("Reload XMP (discard edits)").clicked()
                {
                    self.pending_navigation = None;
                    if let Some(photo) = self.selected.clone() {
                        if self.cloud_editor.is_some() {
                            self.cloud.reload(self.session, &photo);
                        } else {
                            self.dirty = None;
                            self.save_failed = false;
                            self.load_photo(photo);
                        }
                    }
                }
                if ui
                    .add_enabled(
                        !self.cloud.active
                            && self.document.is_some()
                            && self.export_picker.is_none(),
                        egui::Button::new("Export…"),
                    )
                    .clicked()
                {
                    self.choose_export(context);
                }
                if ui.add_enabled(!self.cloud.active && !self.cloud.downloading && self.document.is_some() && (self.texture.is_some() || self.gpu_texture.is_some()) && !self.browse,
                    egui::Button::new("Before / after").selected(self.comparing)).clicked() {
                    self.comparing = !self.comparing;
                    if self.comparing && !self.cloud.active && !self.browse { self.request_comparison(); }
                }
                if !self.browse && self.document.is_some() {
                    if ui.button("Fit").clicked() { self.zoom.fit(); }
                    if ui.add_enabled(self.zoom.native.is_some(),egui::Button::new("100%")).clicked() { self.zoom.scale=1.0; self.zoom.pan=egui::Vec2::ZERO; }
                }
                if self.comparing {
                    ui.add(egui::Slider::new(&mut self.comparison_split, 0.0..=1.0)
                        .text("Comparison split").show_value(false));
                }
                if self.busy || self.saving > 0 || self.auto_pending.is_some() {
                    ui.spinner();
                }
            });
    }
}
