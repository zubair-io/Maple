use super::*;

impl CloudState {
    pub fn dialog(&mut self, context: &egui::Context) {
        let mut open = self.dialog;
        egui::Window::new("Connect to Maple")
            .open(&mut open)
            .show(context, |ui| {
                ui.label("Server URL");
                ui.text_edit_singleline(&mut self.server);
                if ui
                    .add_enabled(!self.connecting, egui::Button::new("Connect / sign in"))
                    .clicked()
                {
                    self.connecting = true;
                    self.epoch += 1;
                    self.active = false;
                    self.folder = None;
                    self.selected = None;
                    self.texture = None;
                    self.cache.clear();
                    self.pending.clear();
                    self.order.clear();
                    self.libraries.clear();
                    self.error = None;
                    self.message = "Connecting…".into();
                    self.worker.send(Command::Connect(self.server.clone()));
                }
                if let Some(url) = &self.sign_in {
                    ui.hyperlink_to("Open browser sign-in", url);
                }
                if ui.button("Disconnect and forget credentials").clicked() {
                    self.worker.send(Command::Disconnect);
                }
                ui.label(&self.message);
                if let Some(error) = &self.error {
                    ui.colored_label(egui::Color32::LIGHT_RED, error);
                }
            });
        self.dialog = open;
    }
    pub fn views(&mut self, context: &egui::Context, browse: &mut bool) {
        egui::SidePanel::left("cloud-sources")
            .default_width(220.0)
            .show(context, |ui| {
                ui.heading("Maple cloud");
                let mut address = None;
                for library in &self.libraries {
                    if ui
                        .button(library.label.as_deref().unwrap_or(&library.slug))
                        .clicked()
                    {
                        address = Some(format!("{}:", library.slug));
                    }
                }
                if let Some(folder) = &self.folder {
                    ui.separator();
                    ui.label(&folder.address);
                    if let Some(parent) = &folder.parent {
                        if ui.button("Parent folder").clicked() {
                            address = Some(parent.clone());
                        }
                    }
                    for child in &folder.folders {
                        if ui.button(&child.name).clicked() {
                            address = Some(child.address.clone());
                        }
                    }
                }
                if let Some(address) = address {
                    self.navigate(address, None);
                    *browse = true;
                }
            });
        egui::TopBottomPanel::bottom("cloud-status").show(context, |ui| {
            ui.label(&self.message);
            if let Some(error) = &self.error {
                ui.colored_label(egui::Color32::LIGHT_RED, error);
            }
        });
        let mut selected = None;
        egui::CentralPanel::default().show(context, |ui| {
            if *browse {
                if let Some(folder) = &self.folder {
                    let columns = (ui.available_width() / 160.0).floor().max(1.0) as usize;
                    egui::ScrollArea::vertical().show_rows(
                        ui,
                        155.0,
                        folder.images.len().div_ceil(columns),
                        |ui, range| {
                            for row in range {
                                ui.horizontal(|ui| {
                                    for entry in
                                        folder.images.iter().skip(row * columns).take(columns)
                                    {
                                        ui.allocate_ui_with_layout(
                                            egui::vec2(150.0, 145.0),
                                            egui::Layout::top_down(egui::Align::Center),
                                            |ui| {
                                                let response = match self.cache.get(&entry.address)
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
                                                        if !self.pending.contains(&entry.address)
                                                            && self.worker.image(
                                                                self.epoch,
                                                                entry.clone(),
                                                                false,
                                                            )
                                                        {
                                                            self.pending
                                                                .insert(entry.address.clone());
                                                        }
                                                        ui.add_sized(
                                                            [140.0, 110.0],
                                                            egui::Button::new("Loading…"),
                                                        )
                                                    }
                                                };
                                                if response.clicked() {
                                                    selected = Some(entry.clone());
                                                }
                                                ui.label(&entry.name);
                                            },
                                        );
                                    }
                                });
                            }
                        },
                    );
                    if let Some(cursor) = &folder.next_cursor {
                        if ui
                            .add_enabled(!self.loading, egui::Button::new("Load more"))
                            .clicked()
                        {
                            self.navigate(folder.address.clone(), Some(cursor.clone()));
                        }
                    }
                } else {
                    ui.label("Choose a library to browse its photographs.");
                }
            } else {
                if let Some(texture) = &self.texture {
                    let available = ui.available_size();
                    ui.add(
                        egui::Image::new(texture).fit_to_exact_size(
                            texture.size_vec2()
                                * (available.x / texture.size_vec2().x)
                                    .min(available.y / texture.size_vec2().y),
                        ),
                    );
                } else {
                    ui.label("Select a cloud photograph to load its preview.");
                }
                if let Some(entry) = self.selected.clone() {
                    if ui
                        .add_enabled(
                            !self.downloading
                                && !entry.is_video
                                && !entry.is_stub
                                && !entry.is_audio,
                            egui::Button::new("Edit original…"),
                        )
                        .clicked()
                    {
                        self.edit_request = Some(entry.clone());
                    }

                    if ui.button("Retry preview").clicked() {
                        self.select(entry);
                    }
                }
            }
        });
        if let Some(entry) = selected {
            self.select(entry);
            *browse = false;
        }
    }
}
