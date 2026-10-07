use super::*;

impl MapleApp {
    pub(super) fn poll(&mut self, context: &egui::Context) {
        if self.zoom.scale <= 0.0 || self.comparing || self.browse {
            self.cancel_detail();
        }
        self.cloud.poll(context);
        if let Some(error) = self.cloud.edit_error.take() {
            self.error = Some(format!("Cloud transfer failed: {error}"));
            self.busy = false;
        }
        if let Some((photo, entry)) = self.cloud.ready.take() {
            self.navigate(Navigation::CloudReady(photo, entry));
        }
        if let Some((id, photo)) = self.cloud.reloaded.take() {
            if id == self.session {
                self.dirty = None;
                self.save_failed = false;
                self.error = None;
                self.load_photo(photo);
            }
        }
        while let Some((id, result)) = self.cloud.synchronized.pop_front() {
            self.saving = self.saving.saturating_sub(1);
            match result {
                Ok(()) if id == self.session => {
                    self.save_failed = false;
                    self.status = "Synchronized to Maple".into();
                }
                Err(error) => {
                    self.pending_navigation = None;
                    self.cloud.active = false;
                    self.save_failed = true;
                    self.close_pending = false;
                    self.error = Some(format!("Cloud XMP sync failed: {error}"));
                }
                _ => {}
            }
        }
        if let Some(picker) = &self.export_picker {
            match picker.try_recv() {
                Ok(result) => {
                    self.export_picker = None;
                    if let Some((photo, model, path)) = result {
                        self.worker.send(Command::Export(photo, model, path));
                        self.status = "Exporting…".into();
                    }
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => self.export_picker = None,
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
        }
        while let Ok((epoch, path, image)) = self.thumbnails.events.try_recv() {
            if epoch != self.thumbnail_epoch {
                continue;
            }
            self.thumbnail_pending.remove(&path);
            let texture = image.map(|image| {
                context.load_texture(
                    path.display().to_string(),
                    image,
                    egui::TextureOptions::LINEAR,
                )
            });
            self.thumbnail_cache.insert(path.clone(), texture);
            self.thumbnail_order.push_back(path);
            while self.thumbnail_order.len() > 128 {
                if let Some(path) = self.thumbnail_order.pop_front() {
                    self.thumbnail_cache.remove(&path);
                }
            }
        }
        if let Some(picker) = &self.picker {
            match picker.try_recv() {
                Ok(path) => {
                    self.picker = None;
                    if let Some(path) = path {
                        self.open_folder(path);
                    }
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => self.picker = None,
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
        }
        while let Ok(event) = self.worker.events.try_recv() {
            match event {
                Event::NativeSize(id, size) if id == self.session => self.zoom.native = size,
                Event::Detail(id, generation, result)
                    if id == self.session && generation == self.zoom.generation =>
                {
                    match result {
                        Ok(frame) => self.accept_detail(context, frame),
                        Err(error) => {
                            self.zoom.error = Some(format!("Native detail unavailable: {error}"))
                        }
                    }
                }
                Event::Comparison(id, model, result)
                    if id == self.session
                        && self.comparison_model.as_ref() == Some(model.as_ref()) =>
                {
                    match result {
                        Ok(image) => {
                            self.comparison_texture = Some(context.load_texture(
                                "before-preview",
                                image,
                                egui::TextureOptions::LINEAR,
                            ))
                        }
                        Err(error) => self.comparison_error = Some(error),
                    }
                }
                Event::Auto(id, revision, result) if self.auto_pending == Some((id, revision)) => {
                    self.auto_pending = None;
                    if id == self.session && revision == self.edit_revision {
                        match result.and_then(|recommendation| {
                            self.document
                                .as_ref()
                                .ok_or_else(|| "The image closed during AUTO".into())
                                .and_then(|document| {
                                    crate::auto_adjust::apply(&document.model, recommendation)
                                })
                        }) {
                            Ok(model) => {
                                if let Some(document) = &mut self.document {
                                    if document.model == model {
                                        self.status = "AUTO settings already applied".into();
                                        continue;
                                    }
                                    self.history.push(document.clone());
                                    document.model = model;
                                    self.before_edit = None;
                                    self.changed();
                                    self.render();
                                }
                            }
                            Err(error) => self.error = Some(format!("AUTO failed: {error}")),
                        }
                    } else {
                        self.status =
                            "AUTO result discarded because the image or edits changed".into();
                    }
                }
                Event::Exported(path, result) => match result {
                    Ok(()) => self.status = format!("Exported {}", path.display()),
                    Err(error) => self.error = Some(format!("Export failed: {error}")),
                },
                Event::Folder(result) => {
                    self.busy = false;
                    match result {
                        Ok(folder) => {
                            self.status = format!("{} images", folder.photos.len());
                            self.error =
                                (!folder.errors.is_empty()).then(|| folder.errors.join("\n"));
                            self.folder = Some(folder);
                            self.browse = true;
                        }
                        Err(error) => self.error = Some(error),
                    }
                }
                Event::Opened(id, result) if id == self.session => match result {
                    Ok((document, white_balance)) => {
                        self.worker.send(Command::NativeSize(id));
                        self.white_balance = Some(white_balance);
                        self.comparison_baseline = Some(document.model.clone());
                        self.document = Some(*document);
                        self.render();
                    }
                    Err(error) => {
                        self.busy = false;
                        self.error = Some(error);
                    }
                },
                Event::Rendered(id, generation, result)
                    if id == self.session && generation == self.generation =>
                {
                    self.busy = false;
                    match result {
                        Ok(image) => {
                            self.gpu_texture = None;
                            self.texture = Some(context.load_texture(
                                "Maple preview",
                                image,
                                egui::TextureOptions::LINEAR,
                            ));
                            self.status = "Preview ready · CPU reference renderer".into();
                        }
                        Err(error) => self.error = Some(error),
                    }
                }
                Event::GpuFallback(id, generation, reason)
                    if id == self.session && generation == self.generation =>
                {
                    self.error = Some(format!(
                        "GPU preview unavailable; using CPU rendering: {reason}"
                    ));
                }
                Event::GpuRendered(id, generation, frame)
                    if id == self.session && generation == self.generation =>
                {
                    self.busy = false;
                    if !self
                        .gpu_texture
                        .as_ref()
                        .is_some_and(|texture| texture.shares_view(&frame))
                    {
                        let registered = self
                            .gpu_state
                            .as_ref()
                            .ok_or_else(|| "Native GPU renderer is unavailable".to_owned())
                            .and_then(|state| {
                                crate::gpu_texture::NativeTexture::register(state, frame)
                            });
                        match registered {
                            Ok(texture) => {
                                self.texture = None;
                                self.gpu_texture = Some(texture);
                            }
                            Err(error) => self.error = Some(error),
                        }
                    }
                    self.status = "Preview ready · resident GPU renderer".into();
                }
                Event::Saved(id, result) => {
                    let saved = self.save_documents.pop_front();
                    match result {
                        Ok(()) if id == self.session && self.cloud_editor.is_some() => {
                            match (&self.selected, saved) {
                                (Some(photo), Some((saved_id, document))) if saved_id == id => {
                                    self.cloud.synchronize(id, photo, document);
                                    self.status = "Synchronizing XMP…".into();
                                }
                                _ => {
                                    self.saving = self.saving.saturating_sub(1);
                                    self.pending_navigation = None;
                                    self.save_failed = true;
                                    self.close_pending = false;
                                    self.error = Some("Save transaction identity changed".into());
                                }
                            }
                        }
                        Ok(()) => {
                            self.saving = self.saving.saturating_sub(1);
                            self.save_failed = false;
                            self.status = "Saved to XMP".into();
                            self.invalidate_thumbnails();
                        }
                        Err(error) => {
                            self.saving = self.saving.saturating_sub(1);
                            self.pending_navigation = None;
                            self.cloud.active = false;
                            self.save_failed = true;
                            self.close_pending = false;
                            self.error = Some(format!("XMP save failed: {error}"));
                        }
                    }
                }

                _ => {}
            }
        }
        if self.saving == 0 {
            if let Some(navigation) = self.pending_navigation.take() {
                self.apply_navigation(navigation);
            }
        }
        if self
            .dirty
            .is_some_and(|time| time.elapsed() >= Duration::from_millis(750))
        {
            self.flush();
        }
        if self.dirty.is_some() {
            context.request_repaint_after(Duration::from_millis(100));
        }
    }
}
