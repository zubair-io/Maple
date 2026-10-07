//! Native desktop interaction slice of #4317. RAW previews use resident GPU
//! textures with CPU fallback; full parity/performance qualification remains.
mod cloud;
mod comparison;
mod events;
mod export_dialog;
mod film_controls;
mod inspector;
mod style;
#[cfg(test)]
mod tests;
mod views;
mod zoom;

use crate::{
    jobs::{Command, Event, ThumbnailWorker, Worker},
    library::{Folder, Photo},
    sidecar::SidecarDocument,
};
use eframe::egui;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

type ExportSelection = (Photo, raw_core::types::adjustment::AdjustmentModel, PathBuf);

enum Navigation {
    Folder(PathBuf),
    Photo(Photo),
    CloudDownload(crate::cloud::CloudEntry),
    CloudReady(Photo, crate::cloud::CloudEntry),
    CloudBrowse,
}

pub struct MapleApp {
    zoom: zoom::ZoomCanvas,
    cloud: cloud::CloudState,
    cloud_editor: Option<crate::cloud::CloudEntry>,
    save_documents: std::collections::VecDeque<(u64, SidecarDocument)>,
    pending_navigation: Option<Navigation>,
    worker: Worker,
    thumbnails: ThumbnailWorker,
    thumbnail_cache: std::collections::HashMap<PathBuf, Result<egui::TextureHandle, String>>,
    thumbnail_pending: std::collections::HashSet<PathBuf>,
    thumbnail_epoch: u64,
    thumbnail_order: std::collections::VecDeque<PathBuf>,
    folder: Option<Folder>,
    selected: Option<Photo>,
    document: Option<SidecarDocument>,
    white_balance: Option<crate::white_balance::WhiteBalance>,
    texture: Option<egui::TextureHandle>,
    gpu_texture: Option<crate::gpu_texture::NativeTexture>,
    gpu_state: Option<eframe::egui_wgpu::RenderState>,
    comparing: bool,
    comparison_split: f32,
    comparison_baseline: Option<raw_core::types::adjustment::AdjustmentModel>,
    comparison_model: Option<raw_core::types::adjustment::AdjustmentModel>,
    comparison_texture: Option<egui::TextureHandle>,
    comparison_error: Option<String>,
    session: u64,
    generation: u64,
    edit_revision: u64,
    auto_pending: Option<(u64, u64)>,
    dirty: Option<Instant>,
    history: Vec<SidecarDocument>,
    redo: Vec<SidecarDocument>,
    before_edit: Option<SidecarDocument>,
    browse: bool,
    active_group: crate::controls::Group,
    maple_icon: egui::TextureHandle,
    busy: bool,
    status: String,
    error: Option<String>,
    saving: usize,
    close_pending: bool,
    save_failed: bool,
    export_picker: Option<std::sync::mpsc::Receiver<Option<ExportSelection>>>,
    picker: Option<std::sync::mpsc::Receiver<Option<PathBuf>>>,
}

impl MapleApp {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        Self::from_context(cc.egui_ctx.clone())
    }

    pub fn with_gpu(cc: &eframe::CreationContext<'_>, gpu: raw_gpu::GpuContext) -> Self {
        let mut app = Self::from_context_with_gpu(cc.egui_ctx.clone(), Some(gpu));
        app.gpu_state = cc.wgpu_render_state.clone();
        app
    }

    fn from_context(context: egui::Context) -> Self {
        Self::from_context_with_gpu(context, None)
    }

    fn from_context_with_gpu(context: egui::Context, gpu: Option<raw_gpu::GpuContext>) -> Self {
        style::apply(&context);
        let icon = image::load_from_memory_with_format(
            include_bytes!("../../../apple/Maple/Assets.xcassets/AppIcon.appiconset/maple512.png"),
            image::ImageFormat::Png,
        )
        .expect("the canonical Maple icon is valid PNG")
        .to_rgba8();
        let maple_icon = context.load_texture(
            "maple-app-icon",
            egui::ColorImage::from_rgba_unmultiplied(
                [icon.width() as usize, icon.height() as usize],
                icon.as_raw(),
            ),
            egui::TextureOptions::LINEAR,
        );
        Self {
            zoom: Default::default(),
            cloud: cloud::CloudState::new(context.clone()),
            cloud_editor: None,
            save_documents: Default::default(),
            pending_navigation: None,
            worker: Worker::with_gpu(context.clone(), gpu),
            thumbnails: ThumbnailWorker::new(context.clone()),
            thumbnail_cache: Default::default(),
            thumbnail_pending: Default::default(),
            thumbnail_order: Default::default(),
            thumbnail_epoch: 0,
            folder: None,
            selected: None,
            document: None,
            white_balance: None,
            texture: None,
            gpu_texture: None,
            gpu_state: None,
            comparing: false,
            comparison_split: 0.5,
            comparison_baseline: None,
            comparison_model: None,
            comparison_texture: None,
            comparison_error: None,
            session: 0,
            generation: 0,
            edit_revision: 0,
            auto_pending: None,
            dirty: None,
            history: Vec::new(),
            redo: Vec::new(),
            before_edit: None,
            browse: true,
            active_group: crate::controls::Group::Light,
            maple_icon,
            busy: false,
            status: "Open a folder to begin".into(),
            error: None,
            picker: None,
            export_picker: None,
            saving: 0,
            close_pending: false,
            save_failed: false,
        }
    }

    fn choose_folder(&mut self, context: &egui::Context) {
        if self.picker.is_some() {
            return;
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        let context = context.clone();
        std::thread::spawn(move || {
            let _ = sender.send(rfd::FileDialog::new().pick_folder());
            context.request_repaint();
        });
        self.picker = Some(receiver);
    }

    pub fn open_folder(&mut self, path: PathBuf) {
        self.navigate(Navigation::Folder(path));
    }

    pub fn select(&mut self, photo: Photo) {
        self.navigate(Navigation::Photo(photo));
    }

    fn navigate(&mut self, navigation: Navigation) {
        self.auto_pending = None;
        if self.save_failed {
            self.error =
                Some("Save failed. Retry Save XMP or reload XMP before changing images.".into());
            return;
        }
        if self.dirty.is_some() || self.saving > 0 {
            self.pending_navigation = Some(navigation);
            self.flush();
        } else {
            self.apply_navigation(navigation);
        }
    }

    fn apply_navigation(&mut self, navigation: Navigation) {
        self.auto_pending = None;
        match navigation {
            Navigation::Folder(path) => self.load_folder(path),
            Navigation::Photo(photo) => {
                self.cloud_editor = None;
                self.load_photo(photo);
            }
            Navigation::CloudDownload(entry) => self.cloud.request_edit(entry),
            Navigation::CloudReady(photo, entry) => {
                self.load_photo(photo);
                self.cloud_editor = Some(entry);
                self.cloud.active = false;
            }
            Navigation::CloudBrowse => {
                self.cloud_editor = None;
                self.selected = None;
                self.document = None;
                self.texture = None;
                self.gpu_texture = None;
                self.cloud.active = true;
                self.browse = true;
            }
        }
    }

    fn load_folder(&mut self, path: PathBuf) {
        self.cloud_editor = None;
        self.cloud.active = false;
        self.invalidate_thumbnails();
        self.busy = true;
        self.status = "Reading folder…".into();
        self.worker.send(Command::Folder(path));
    }

    fn load_photo(&mut self, photo: Photo) {
        self.zoom = Default::default();
        self.session += 1;
        self.generation = 0;
        self.comparing = false;
        self.comparison_baseline = None;
        self.comparison_model = None;
        self.comparison_texture = None;
        self.comparison_error = None;
        self.auto_pending = None;
        self.document = None;
        self.white_balance = None;
        self.texture = None;
        self.gpu_texture = None;
        self.history.clear();
        self.redo.clear();
        self.before_edit = None;
        self.error = None;
        self.busy = true;
        self.status = "Opening image…".into();
        self.worker.send(Command::Open(self.session, photo.clone()));
        self.selected = Some(photo);
        self.browse = false;
    }

    fn render(&mut self) {
        self.zoom.invalidate();
        if self.comparing {
            self.request_comparison();
        }
        if let Some(document) = &self.document {
            self.generation += 1;
            self.busy = true;
            self.worker.send(Command::Render(
                self.session,
                self.generation,
                document.model.clone(),
            ));
        }
    }

    fn flush(&mut self) {
        if self.dirty.take().is_some() {
            if let Some(document) = &self.document {
                self.save_documents
                    .push_back((self.session, document.clone()));
                self.saving += 1;
                self.worker
                    .send(Command::Save(self.session, document.clone()));
            }
        }
    }

    fn changed(&mut self) {
        self.edit_revision += 1;
        self.dirty = Some(Instant::now());
        self.redo.clear();
    }

    fn auto_adjust(&mut self) {
        if self.auto_pending.is_some() {
            return;
        }
        if let Some(document) = &self.document {
            self.auto_pending = Some((self.session, self.edit_revision));
            self.worker.send(Command::Auto(
                self.session,
                self.edit_revision,
                document.model.clone(),
            ));
            self.status = "Analyzing RAW for AUTO…".into();
        }
    }

    fn reset_develop(&mut self) {
        let Some(document) = &mut self.document else {
            return;
        };
        let previous = document.clone();
        match document.reset_develop() {
            Ok(()) => {
                self.history.push(previous);
                self.before_edit = None;
                self.changed();
                self.render();
            }
            Err(error) => self.error = Some(format!("Reset failed: {error}")),
        }
    }

    fn undo(&mut self, redo: bool) {
        self.edit_revision += 1;
        let previous = if redo {
            self.redo.pop()
        } else {
            self.history.pop()
        };
        if let Some(previous) = previous {
            if let Some(current) = self.document.replace(previous) {
                if redo {
                    self.history.push(current);
                } else {
                    self.redo.push(current);
                }
            }
            self.dirty = Some(Instant::now());
            self.render();
        }
    }

    fn invalidate_thumbnails(&mut self) {
        self.thumbnail_epoch += 1;
        self.thumbnail_cache.clear();
        self.thumbnail_pending.clear();
        self.thumbnail_order.clear();
    }
}

impl eframe::App for MapleApp {
    fn update(&mut self, context: &egui::Context, _: &mut eframe::Frame) {
        self.poll(context);
        if context.input(|input| input.viewport().close_requested())
            && (self.dirty.is_some() || self.saving > 0 || self.save_failed)
        {
            context.send_viewport_cmd(egui::ViewportCommand::CancelClose);
            if !self.save_failed {
                self.close_pending = true;
                self.flush();
            }
        }
        if self.close_pending && self.saving == 0 {
            self.close_pending = false;
            context.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        self.views(context);
    }
    fn on_exit(&mut self) {
        self.auto_pending = None;
        self.flush();
        self.worker.finish();
        self.poll(&egui::Context::default());
        if let Some(error) = &self.error {
            eprintln!("{error}");
        }
    }
}

#[cfg(test)]
mod film_tests;

#[cfg(test)]
mod zoom_crop_tests;
#[cfg(test)]
mod zoom_fallback_tests;
#[cfg(test)]
mod zoom_tests;

#[cfg(test)]
mod accessibility_tests;

mod keyboard;

#[cfg(test)]
mod keyboard_tests;
