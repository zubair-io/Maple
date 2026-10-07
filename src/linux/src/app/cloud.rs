//! Native cloud browsing and durable original-edit handoff (#4317).
#[path = "cloud_views.rs"]
mod views;
use super::*;
use crate::cloud::{
    worker::{self, Command, Event},
    CloudEntry, CloudFolder, CloudLibrary,
};
use std::collections::{HashMap, HashSet, VecDeque};

pub(super) struct CloudState {
    worker: worker::Worker,
    pub downloading: bool,
    pub edit_error: Option<String>,
    pub ready: Option<(crate::library::Photo, CloudEntry)>,
    pub reloaded: Option<(u64, crate::library::Photo)>,
    pub synchronized: std::collections::VecDeque<(u64, Result<(), String>)>,
    pub edit_request: Option<CloudEntry>,
    connecting: bool,
    loading: bool,
    pub dialog: bool,
    server: String,
    pub active: bool,
    libraries: Vec<CloudLibrary>,
    folder: Option<CloudFolder>,
    epoch: u64,
    selected: Option<CloudEntry>,
    texture: Option<egui::TextureHandle>,
    cache: HashMap<String, Result<egui::TextureHandle, String>>,
    pending: HashSet<String>,
    order: VecDeque<String>,
    sign_in: Option<String>,
    claim_inflight: bool,
    next_claim: Instant,
    sign_in_started: Instant,
    message: String,
    error: Option<String>,
}
impl CloudState {
    pub fn new(context: egui::Context) -> Self {
        Self {
            worker: worker::Worker::new(context),
            downloading: false,
            edit_error: None,
            ready: None,
            reloaded: None,
            synchronized: Default::default(),
            edit_request: None,
            connecting: false,
            loading: false,
            dialog: false,
            server: String::new(),
            active: false,
            libraries: Vec::new(),
            folder: None,
            epoch: 0,
            selected: None,
            texture: None,
            cache: HashMap::new(),
            pending: HashSet::new(),
            order: VecDeque::new(),
            sign_in: None,
            claim_inflight: false,
            next_claim: Instant::now(),
            sign_in_started: Instant::now(),
            message: "Enter your Maple server address".into(),
            error: None,
        }
    }
    fn navigate(&mut self, address: String, cursor: Option<String>) {
        if cursor.is_some() && self.loading {
            return;
        }
        self.loading = true;
        if cursor.is_none() {
            self.epoch += 1;
            self.folder = None;
            self.cache.clear();
            self.pending.clear();
            self.order.clear();
            self.texture = None;
            self.selected = None;
        }
        self.worker
            .send(Command::Folder(self.epoch, address, cursor));
        self.message = "Loading cloud folder…".into();
    }
    pub fn request_edit(&mut self, entry: CloudEntry) {
        self.downloading = true;
        self.message = "Downloading original for editing…".into();
        self.worker.send(Command::Download(self.epoch, entry));
    }
    pub fn synchronize(&self, id: u64, photo: &crate::library::Photo, document: SidecarDocument) {
        self.worker
            .send(Command::Sync(id, photo.path.clone(), Box::new(document)));
    }
    pub fn reload(&mut self, id: u64, photo: &crate::library::Photo) {
        self.downloading = true;
        self.worker.send(Command::Reload(id, photo.path.clone()));
    }
    pub fn photos(&self) -> Vec<CloudEntry> {
        self.folder
            .as_ref()
            .map_or_else(Vec::new, |folder| folder.images.clone())
    }

    pub fn poll(&mut self, context: &egui::Context) {
        while let Ok(event) = self.worker.events.try_recv() {
            match event {
                Event::EditReady(epoch, photo, entry) => {
                    self.downloading = false;
                    if epoch == self.epoch {
                        self.ready = Some((photo, entry));
                    }
                }
                Event::Reloaded(id, photo) => {
                    self.downloading = false;
                    self.reloaded = Some((id, photo));
                }
                Event::Synced(id, result) => {
                    self.synchronized.push_back((id, result));
                }

                Event::SignIn(url) => {
                    self.sign_in = Some(url.clone());
                    self.claim_inflight = false;
                    self.sign_in_started = Instant::now();
                    self.next_claim = Instant::now();
                    self.message = "Complete sign-in in your browser".into();
                    if let Err(error) = webbrowser::open(&url) {
                        self.error = Some(format!(
                            "Browser did not open: {error}. Use the sign-in link below."
                        ));
                    }
                }
                Event::Connected(libraries) => {
                    self.connecting = false;
                    self.libraries = libraries;
                    self.sign_in = None;
                    self.claim_inflight = false;
                    self.message = "Connected to Maple".into();
                    self.error = None;
                    self.active = true;
                    self.dialog = false;
                }
                Event::Waiting => {
                    self.claim_inflight = false;
                    self.next_claim = Instant::now() + Duration::from_secs(2);
                }
                Event::Folder(epoch, folder) if epoch == self.epoch => {
                    self.loading = false;
                    if let Some(current) = &mut self.folder {
                        current.images.extend(folder.images);
                        current.folders.extend(folder.folders);
                        current.sidecars.extend(folder.sidecars);
                        current.next_cursor = folder.next_cursor;
                    } else {
                        self.folder = Some(*folder);
                    }
                    self.message = format!(
                        "{} cloud photographs",
                        self.folder.as_ref().map_or(0, |folder| folder.images.len())
                    );
                }
                Event::Derivative(epoch, address, preview, result) if epoch == self.epoch => {
                    let image = result.map(|image| {
                        context.load_texture(&address, image, egui::TextureOptions::LINEAR)
                    });
                    if preview {
                        if self
                            .selected
                            .as_ref()
                            .is_some_and(|entry| entry.address == address)
                        {
                            match image {
                                Ok(texture) => {
                                    self.texture = Some(texture);
                                    self.message = "Cloud preview ready".into();
                                }
                                Err(error) => self.error = Some(error),
                            }
                        }
                    } else {
                        self.pending.remove(&address);
                        self.cache.insert(address.clone(), image);
                        self.order.push_back(address);
                        while self.order.len() > 128 {
                            if let Some(address) = self.order.pop_front() {
                                self.cache.remove(&address);
                            }
                        }
                    }
                }
                Event::Disconnected => {
                    self.connecting = false;
                    self.loading = false;
                    self.epoch += 1;
                    self.pending.clear();
                    self.order.clear();
                    self.active = false;
                    self.libraries.clear();
                    self.folder = None;
                    self.selected = None;
                    self.texture = None;
                    self.cache.clear();
                    self.sign_in = None;
                    self.message = "Disconnected".into();
                }
                Event::Error(error) => {
                    if self.downloading {
                        self.edit_error = Some(error.clone());
                    }
                    self.downloading = false;
                    self.connecting = false;
                    self.loading = false;
                    self.error = Some(error);
                    self.sign_in = None;
                    self.claim_inflight = false;
                }
                _ => {}
            }
        }
        if self.sign_in.is_some() {
            if self.sign_in_started.elapsed() > Duration::from_secs(300) {
                self.sign_in = None;
                self.connecting = false;
                self.error = Some("Browser sign-in timed out. Connect again to retry.".into());
            } else if !self.claim_inflight && Instant::now() >= self.next_claim {
                self.claim_inflight = true;
                self.worker.send(Command::Claim);
            }
            context.request_repaint_after(Duration::from_millis(250));
        }
    }
    fn select(&mut self, entry: CloudEntry) {
        if self.worker.image(self.epoch, entry.clone(), true) {
            self.selected = Some(entry);
            self.texture = None;
            self.message = "Loading cloud preview…".into();
            self.error = None;
        } else {
            self.error = Some("Preview queue is busy. Select the image again shortly.".into());
        }
    }
}
