//! Independent, latest-wins CPU detail work; never owns the GPU or XMP store.
use crate::{detail::DetailRenderer, jobs::Event};
use eframe::egui;
use raw_core::{pipeline::TileRect, types::adjustment::AdjustmentModel, RawImage};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex, Weak,
};

pub(crate) struct DetailSource {
    pub id: u64,
    pub raw: Option<Arc<RawImage>>,
    pub bytes: Arc<Vec<u8>>,
    pub ext: String,
}
struct Request {
    ticket: u64,
    cancel: Arc<AtomicBool>,
    id: u64,
    generation: u64,
    model: AdjustmentModel,
    rect: TileRect,
}

pub(crate) struct DetailWorker {
    pub source: Arc<Mutex<Option<Arc<DetailSource>>>>,
    pending: Arc<Mutex<Option<Request>>>,
    revision: Arc<AtomicU64>,
    active_cancel: Mutex<Option<Arc<AtomicBool>>>,
    sender: Option<mpsc::SyncSender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    #[cfg(test)]
    gate: Arc<Mutex<Option<ExecutionGate>>>,
}
impl DetailWorker {
    pub fn new(context: egui::Context, results: mpsc::Sender<Event>) -> Self {
        let source = Arc::new(Mutex::new(None::<Arc<DetailSource>>));
        let pending = Arc::new(Mutex::new(None::<Request>));
        let revision = Arc::new(AtomicU64::new(0));
        let source_slot = source.clone();
        let request_slot = pending.clone();
        let current = revision.clone();
        let (sender, wakes) = mpsc::sync_channel(1);
        #[cfg(test)]
        let gate = Arc::new(Mutex::new(None::<ExecutionGate>));
        #[cfg(test)]
        let test_gate = gate.clone();
        let thread = std::thread::spawn(move || {
            let mut renderer = DetailRenderer::default();
            let mut raster = crate::raster_detail::RasterDetailRenderer::default();
            let mut reference: Weak<DetailSource> = Weak::new();
            for () in wakes {
                let Some(request) = request_slot.lock().expect("detail mailbox").take() else {
                    if reference.upgrade().is_none() {
                        renderer = DetailRenderer::default();
                        raster = crate::raster_detail::RasterDetailRenderer::default();
                    }
                    continue;
                };
                if request.ticket != current.load(Ordering::Acquire) {
                    continue;
                }
                let opened = source_slot.lock().expect("detail source").clone();
                let result = match opened.as_ref().filter(|s| s.id == request.id) {
                    Some(opened) => {
                        if !reference
                            .upgrade()
                            .is_some_and(|cached| Arc::ptr_eq(&cached, opened))
                        {
                            renderer = DetailRenderer::default();
                            raster = crate::raster_detail::RasterDetailRenderer::default();
                            reference = Arc::downgrade(opened);
                        }
                        #[cfg(test)]
                        if let Some(gate) = test_gate.lock().expect("test detail gate").take() {
                            let _ = gate.entered.send(());
                            gate.release
                                .recv_timeout(std::time::Duration::from_secs(30))
                                .expect("release test detail work");
                        }
                        let obsolete = || {
                            request.ticket != current.load(Ordering::Acquire)
                                || !source_slot
                                    .lock()
                                    .expect("detail source")
                                    .as_ref()
                                    .is_some_and(|source| Arc::ptr_eq(source, opened))
                        };
                        let cancel = raw_core::CancelToken::new(&request.cancel);
                        let whole = request.rect.out_w != request.rect.src_w
                            || request.rect.out_h != request.rect.src_h
                            || crate::whole_detail::required(&request.model);
                        let result = if whole {
                            crate::whole_detail::render(
                                opened,
                                &request.model,
                                request.rect,
                                cancel,
                                obsolete,
                            )
                        } else if let Some(raw) = &opened.raw {
                            renderer.render_with_token(
                                raw,
                                &opened.bytes,
                                &opened.ext,
                                &request.model,
                                request.rect,
                                cancel,
                                obsolete,
                            )
                        } else {
                            raster.render(
                                &opened.bytes,
                                &request.model,
                                request.rect,
                                cancel,
                                obsolete,
                            )
                        };
                        let result = match result {
                            Err(error) if !whole => {
                                // Release patch-only anchors/source buffers before whole-frame work.
                                renderer = DetailRenderer::default();
                                raster = crate::raster_detail::RasterDetailRenderer::default();
                                crate::whole_detail::fallback(
                                    opened,
                                    &request.model,
                                    request.rect,
                                    cancel,
                                    obsolete,
                                )
                                .map_err(|fallback| {
                                    format!("{error}; whole-image refinement: {fallback}")
                                })
                            }
                            result => result,
                        };
                        match result {
                            Ok(Some(frame)) => Ok(frame),
                            Ok(None) => continue,
                            Err(error) => Err(error),
                        }
                    }
                    None => Err("The detail image is no longer open".into()),
                };
                // Source identity is checked independently of caller-supplied IDs.
                // Reusing an ID cannot reuse another mosaic's exposure/Auto anchors.
                let same_source = match (&opened, &*source_slot.lock().expect("detail source")) {
                    (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                    (None, None) => true,
                    _ => false,
                };
                if request.ticket != current.load(Ordering::Acquire) || !same_source {
                    continue;
                }
                if results
                    .send(Event::Detail(request.id, request.generation, result))
                    .is_err()
                {
                    break;
                }
                context.request_repaint();
            }
        });
        Self {
            source,
            pending,
            revision,
            active_cancel: Mutex::new(None),
            sender: Some(sender),
            thread: Some(thread),
            #[cfg(test)]
            gate,
        }
    }
    #[cfg(test)]
    pub fn pause_next(&self) -> TestPause {
        let (entered, began) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        *self.gate.lock().expect("test detail gate") = Some(ExecutionGate {
            entered,
            release: wait,
        });
        TestPause { began, release }
    }
    pub fn request(&self, id: u64, generation: u64, model: AdjustmentModel, rect: TileRect) {
        let Some(sender) = &self.sender else { return };
        let cancel = Arc::new(AtomicBool::new(false));
        if let Some(previous) = self
            .active_cancel
            .lock()
            .expect("detail cancellation")
            .replace(cancel.clone())
        {
            previous.store(true, Ordering::Release);
        }
        let ticket = self.revision.fetch_add(1, Ordering::AcqRel) + 1;
        self.pending
            .lock()
            .expect("detail mailbox")
            .replace(Request {
                ticket,
                cancel,
                id,
                generation,
                model,
                rect,
            });
        // A queued wake is enough: it always takes the latest pending snapshot.
        let _ = sender.try_send(());
    }
    pub fn invalidate(&self, close_source: bool) {
        if let Some(cancel) = self
            .active_cancel
            .lock()
            .expect("detail cancellation")
            .take()
        {
            cancel.store(true, Ordering::Release);
        }
        self.revision.fetch_add(1, Ordering::AcqRel);
        self.pending.lock().expect("detail mailbox").take();
        if close_source {
            *self.source.lock().expect("detail source") = None;
        }
        if let Some(sender) = &self.sender {
            let _ = sender.try_send(());
        }
    }
    pub fn finish(&mut self) {
        self.invalidate(true);
        self.sender.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Drop for DetailWorker {
    fn drop(&mut self) {
        self.finish();
    }
}

#[cfg(test)]
pub(crate) struct TestPause {
    pub began: mpsc::Receiver<()>,
    release: mpsc::Sender<()>,
}
#[cfg(test)]
impl TestPause {
    pub fn resume(&self) {
        let _ = self.release.send(());
    }
}
#[cfg(test)]
impl Drop for TestPause {
    fn drop(&mut self) {
        self.resume();
    }
}

#[cfg(test)]
struct ExecutionGate {
    entered: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
}
