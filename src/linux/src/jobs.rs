//! Serialized I/O/GPU previews; native CPU detail is independently scheduled (#4317).
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
};

use eframe::egui;
use raw_core::{
    pipeline::{self, ExportDepth, ExportPixels, RawInput},
    types::adjustment::AdjustmentModel,
    view::encode::TargetPrimaries,
};

use crate::{
    library::{Folder, MediaKind, Photo},
    sidecar::{SidecarDocument, SidecarStore},
};

pub enum Command {
    Folder(PathBuf),
    NativeSize(u64),
    Auto(u64, u64, AdjustmentModel),
    Comparison(u64, AdjustmentModel),
    Open(u64, Photo),
    Render(u64, u64, AdjustmentModel),
    Detail(u64, u64, AdjustmentModel, pipeline::TileRect),
    Save(u64, SidecarDocument),
    Export(Photo, AdjustmentModel, PathBuf),
}

pub enum Event {
    Folder(Result<Folder, String>),
    NativeSize(u64, Option<(u32, u32)>),
    Auto(
        u64,
        u64,
        Result<raw_core::stages::auto_adjustments::AutoAdjustments, String>,
    ),
    Opened(
        u64,
        Result<(Box<SidecarDocument>, crate::white_balance::WhiteBalance), String>,
    ),
    Rendered(u64, u64, Result<egui::ColorImage, String>),
    GpuRendered(u64, u64, crate::gpu_texture::GpuFrame),
    GpuFallback(u64, u64, String),
    Detail(u64, u64, Result<crate::detail::DetailFrame, String>),
    Saved(u64, Result<(), String>),
    Comparison(u64, Box<AdjustmentModel>, Result<egui::ColorImage, String>),
    Exported(PathBuf, Result<(), String>),
}

struct Session {
    id: u64,
    photo: Photo,
    store: SidecarStore,
    raw: Option<Arc<raw_core::RawImage>>,
    bytes: Arc<Vec<u8>>,
    native_size: (u32, u32),
    gpu: Option<crate::gpu_preview::GpuPreview>,
    gpu_failed: bool,
}

impl Session {
    fn open(id: u64, photo: Photo) -> Result<(Self, SidecarDocument), String> {
        let (store, document) = SidecarStore::open(&photo.path).map_err(|e| e.to_string())?;
        // Decode and global-fit/detail anchors use one immutable source snapshot.
        // Reading again later could pair an old mosaic with newly changed bytes.
        let bytes = std::fs::read(&photo.path).map_err(|e| e.to_string())?;
        let ext = photo
            .path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("dng");
        let raw = match photo.kind {
            MediaKind::Raw => Some(Arc::new(
                raw_core::decode::decode_bytes(&bytes, ext).map_err(|e| e.to_string())?,
            )),
            MediaKind::Raster => None,
        };
        let native_size = if let Some(raw) = &raw {
            pipeline::native_render_dims(raw)
        } else {
            let metadata = raw_core::raster::probe_raster_metadata(&bytes)
                .map_err(|error| error.to_string())?;
            let orientation =
                raw_core::image::ExifOrientation::from_u16(metadata.orientation.unwrap_or(1));
            if orientation.swaps_wh() {
                (metadata.height, metadata.width)
            } else {
                (metadata.width, metadata.height)
            }
        };
        Ok((
            Self {
                id,
                photo,
                store,
                raw,
                bytes: Arc::new(bytes),
                native_size,
                gpu: None,
                gpu_failed: false,
            },
            document,
        ))
    }

    fn render_gpu(
        &mut self,
        ctx: &raw_gpu::GpuContext,
        model: &AdjustmentModel,
        cancel: &raw_gpu::CancelToken,
    ) -> Result<Option<crate::gpu_texture::GpuFrame>, String> {
        let raw = self.raw.as_ref().expect("RAW GPU session");
        let bytes = self.bytes.as_slice();
        let ext = self
            .photo
            .path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("dng");
        if self.gpu.is_none() {
            self.gpu = crate::gpu_preview::GpuPreview::open_cancellable(
                ctx, raw, bytes, ext, model, 1600, cancel,
            )?;
            if self.gpu.is_none() {
                return Ok(None);
            }
        }
        let preview = self.gpu.as_mut().expect("resident preview");
        if preview.render(ctx, raw, bytes, ext, model, cancel)? {
            Ok(Some(crate::gpu_texture::GpuFrame::from_preview(
                ctx, preview,
            )))
        } else {
            Ok(None)
        }
    }

    fn render(&self, model: &AdjustmentModel, long_edge: u32) -> Result<egui::ColorImage, String> {
        let (model, film) = crate::film::renderable(model)?;
        let model = model.as_ref();
        let result = if let Some(raw) = &self.raw {
            pipeline::render_sized_from_raw_with_quality_source_and_film(
                raw,
                model,
                pipeline::RenderQuality::Preview,
                Some(RawInput::Bytes {
                    bytes: &self.bytes,
                    ext: self
                        .photo
                        .path
                        .extension()
                        .and_then(|v| v.to_str())
                        .unwrap_or("dng"),
                }),
                long_edge,
                film.as_ref().map(|film| film.lut),
            )
        } else {
            pipeline::render_export_raster(
                &self.bytes,
                model,
                Some(long_edge),
                TargetPrimaries::Srgb,
                ExportDepth::Eight,
                film.as_ref().map(|film| film.lut),
            )
            .map(|(w, h, pixels)| match pixels {
                ExportPixels::Eight(rgb) => (w, h, rgb),
                ExportPixels::Sixteen(_) => unreachable!("requested eight bits"),
            })
        };
        result
            .map(|(w, h, rgb)| egui::ColorImage::from_rgb([w as usize, h as usize], &rgb))
            .map_err(|e| e.to_string())
    }
}

enum Work {
    Command(Box<Command>),
    Render,
}
type PendingRender = Option<(u64, u64, u64, AdjustmentModel)>;

pub struct Worker {
    sender: Option<mpsc::Sender<Work>>,
    pending_render: Arc<Mutex<PendingRender>>,
    detail: crate::detail_worker::DetailWorker,
    latest_render: Arc<AtomicU64>,
    active_cancel: Arc<Mutex<Option<raw_gpu::CancelToken>>>,
    pub events: mpsc::Receiver<Event>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Worker {
    pub fn new(context: egui::Context) -> Self {
        Self::with_gpu(context, None)
    }

    pub fn with_gpu(context: egui::Context, mut gpu: Option<raw_gpu::GpuContext>) -> Self {
        let active_cancel = Arc::new(Mutex::new(None::<raw_gpu::CancelToken>));
        let render_cancel = active_cancel.clone();
        let (sender, commands) = mpsc::channel();
        let latest_render = Arc::new(AtomicU64::new(0));
        let current_render = latest_render.clone();
        let pending_render = Arc::new(Mutex::new(None));
        let render_slot = pending_render.clone();
        let (results, events) = mpsc::channel();
        let detail = crate::detail_worker::DetailWorker::new(context.clone(), results.clone());
        let detail_source = detail.source.clone();
        let thread = thread::spawn(move || {
            let mut session: Option<Session> = None;
            for work in commands {
                let (ticket, command) = match work {
                    Work::Command(command) => (0, *command),
                    Work::Render => {
                        let Some((ticket, id, generation, model)) =
                            render_slot.lock().expect("render mailbox").take()
                        else {
                            continue;
                        };
                        (ticket, Command::Render(id, generation, model))
                    }
                };
                if matches!(command, Command::Render(..))
                    && ticket != current_render.load(Ordering::Acquire)
                {
                    continue;
                }
                let event = match command {
                    Command::NativeSize(id) => Event::NativeSize(
                        id,
                        session
                            .as_ref()
                            .filter(|s| s.id == id)
                            .map(|s| s.native_size),
                    ),
                    Command::Detail(..) => unreachable!("detail uses its independent mailbox"),
                    Command::Comparison(id, model) => {
                        let image = session
                            .as_ref()
                            .filter(|session| session.id == id)
                            .ok_or_else(|| "The comparison image is no longer open".to_owned())
                            .and_then(|session| session.render(&model, 1600));
                        Event::Comparison(id, Box::new(model), image)
                    }
                    Command::Auto(id, revision, model) => Event::Auto(
                        id,
                        revision,
                        session
                            .as_ref()
                            .filter(|session| session.id == id)
                            .and_then(|session| session.raw.as_ref())
                            .ok_or_else(|| "AUTO requires an open RAW photograph".to_owned())
                            .and_then(|raw| {
                                raw_core::stages::auto_adjustments::compute_auto_adjustments(
                                    raw, &model,
                                )
                                .map_err(|error| error.to_string())
                            }),
                    ),
                    Command::Export(photo, model, destination) => {
                        let result =
                            crate::export::export(&photo.path, photo.kind, &model, &destination);
                        Event::Exported(destination, result)
                    }
                    Command::Folder(path) => {
                        Event::Folder(Folder::scan(&path).map_err(|e| e.to_string()))
                    }
                    Command::Open(id, photo) => {
                        *detail_source.lock().expect("detail source") = None;
                        drop(session.take());
                        match Session::open(id, photo) {
                            Ok((opened, document)) => {
                                let reference = opened.raw.as_ref().map_or(
                                    Ok(crate::white_balance::WhiteBalance::Display),
                                    |raw| crate::white_balance::WhiteBalance::from_raw(raw),
                                );
                                *detail_source.lock().expect("detail source") =
                                    Some(Arc::new(crate::detail_worker::DetailSource {
                                        id,
                                        raw: opened.raw.clone(),
                                        bytes: opened.bytes.clone(),
                                        ext: opened
                                            .photo
                                            .path
                                            .extension()
                                            .and_then(|v| v.to_str())
                                            .unwrap_or("dng")
                                            .into(),
                                    }));
                                session = Some(opened);
                                Event::Opened(
                                    id,
                                    reference.map(|reference| (Box::new(document), reference)),
                                )
                            }
                            Err(error) => {
                                session = None;
                                Event::Opened(id, Err(error))
                            }
                        }
                    }
                    Command::Render(id, generation, model) => {
                        let cancel = raw_gpu::CancelToken::new();
                        *render_cancel.lock().expect("active GPU render") = Some(cancel.clone());
                        // Check again after publishing cancellation ownership.
                        if ticket != current_render.load(Ordering::Acquire) {
                            continue;
                        }
                        if let (Some(ctx), Some(opened)) =
                            (gpu.as_mut(), session.as_mut().filter(|s| s.id == id))
                        {
                            let supported = crate::gpu_preview::GpuPreview::validate(&model);
                            if let Err(reason) = &supported {
                                let _ = results.send(Event::GpuFallback(
                                    id,
                                    generation,
                                    reason.clone(),
                                ));
                            }
                            if opened.raw.is_some() && !opened.gpu_failed && supported.is_ok() {
                                match opened.render_gpu(ctx, &model, &cancel) {
                                    Ok(Some(frame)) => {
                                        if ticket == current_render.load(Ordering::Acquire) {
                                            let _ = results
                                                .send(Event::GpuRendered(id, generation, frame));
                                            context.request_repaint();
                                        }
                                        continue;
                                    }
                                    Ok(None) => continue,
                                    Err(error) => {
                                        opened.gpu_failed = true;
                                        opened.gpu = None;
                                        let _ =
                                            results.send(Event::GpuFallback(id, generation, error));
                                    }
                                }
                            }
                        }
                        Event::Rendered(
                            id,
                            generation,
                            session
                                .as_ref()
                                .filter(|s| s.id == id)
                                .ok_or_else(|| "Image session is no longer open".into())
                                .and_then(|s| s.render(&model, 1600)),
                        )
                    }
                    Command::Save(id, document) => Event::Saved(
                        id,
                        session
                            .as_mut()
                            .filter(|s| s.id == id)
                            .ok_or_else(|| "Image session is no longer open".into())
                            .and_then(|s| s.store.save(&document).map_err(|e| e.to_string())),
                    ),
                };
                // The CPU reference cannot stop inside a stage. Reject its result if
                // a newer tick or image open arrived while it was developing (#4317).
                if matches!(event, Event::Rendered(..))
                    && ticket != current_render.load(Ordering::Acquire)
                {
                    continue;
                }
                if results.send(event).is_err() {
                    break;
                }
                context.request_repaint();
            }
        });
        Self {
            sender: Some(sender),
            active_cancel,
            latest_render,
            pending_render,
            detail,
            events,
            thread: Some(thread),
        }
    }

    pub fn send(&self, command: Command) {
        let Some(sender) = &self.sender else { return };
        if matches!(command, Command::Render(..) | Command::Open(..)) {
            if let Some(cancel) = self
                .active_cancel
                .lock()
                .expect("active GPU render")
                .as_ref()
            {
                cancel.cancel();
            }
        }
        if let Command::Detail(id, generation, model, rect) = command {
            self.detail.request(id, generation, model, rect);
            return;
        }
        if matches!(command, Command::Render(..) | Command::Open(..)) {
            self.detail.invalidate(matches!(command, Command::Open(..)));
        }
        if let Command::Render(id, generation, model) = command {
            let ticket = self.latest_render.fetch_add(1, Ordering::AcqRel) + 1;
            let wake = {
                let mut pending = self.pending_render.lock().expect("render mailbox");
                pending.replace((ticket, id, generation, model)).is_none()
            };
            // One pending snapshot and one wake-up, regardless of slider frequency.
            if wake {
                let _ = sender.send(Work::Render);
            }
        } else {
            if matches!(command, Command::Open(..)) {
                self.latest_render.fetch_add(1, Ordering::AcqRel);
            }
            let _ = sender.send(Work::Command(Box::new(command)));
        }
    }

    /// Leave native zoom without closing the immutable source or its anchors.
    pub fn cancel_detail(&self) {
        self.detail.invalidate(false);
    }

    pub fn finish(&mut self) {
        self.detail.invalidate(true);
        self.latest_render.fetch_add(1, Ordering::AcqRel);
        if let Some(cancel) = self
            .active_cancel
            .lock()
            .expect("active GPU render")
            .as_ref()
        {
            cancel.cancel();
        }
        self.sender.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.detail.finish();
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.finish();
    }
}

/// A small bounded queue keeps grid discovery from accumulating full decodes.
pub struct ThumbnailWorker {
    sender: Option<mpsc::SyncSender<(u64, Photo)>>,
    pub events: mpsc::Receiver<(u64, PathBuf, Result<egui::ColorImage, String>)>,
    thread: Option<thread::JoinHandle<()>>,
}

impl ThumbnailWorker {
    pub fn new(context: egui::Context) -> Self {
        let (sender, commands) = mpsc::sync_channel::<(u64, Photo)>(2);
        let (results, events) = mpsc::channel();
        let thread = thread::spawn(move || {
            for (generation, photo) in commands {
                let path = photo.path.clone();
                let image = Session::open(0, photo)
                    .and_then(|(session, document)| session.render(&document.model, 256));
                if results.send((generation, path, image)).is_err() {
                    break;
                }
                context.request_repaint();
            }
        });
        Self {
            sender: Some(sender),
            events,
            thread: Some(thread),
        }
    }

    pub fn request(&self, generation: u64, photo: Photo) -> bool {
        self.sender
            .as_ref()
            .is_some_and(|sender| sender.try_send((generation, photo)).is_ok())
    }
}

impl Drop for ThumbnailWorker {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
#[path = "detail_isolation_tests.rs"]
mod detail_isolation_tests;

#[cfg(test)]
#[path = "native_size_tests.rs"]
mod native_size_tests;

#[cfg(test)]
#[path = "curve_capacity_tests.rs"]
mod curve_capacity_tests;
