//! Serialized authenticated requests; control messages precede thumbnail work.
use super::{CloudClient, CloudEntry, CloudFolder, CloudLibrary, PendingSignIn, Server};
use eframe::egui;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
};

pub enum Command {
    Connect(String),
    Claim,
    Folder(u64, String, Option<String>),
    Disconnect,
    Download(u64, CloudEntry),
    Reload(u64, std::path::PathBuf),
    Sync(
        u64,
        std::path::PathBuf,
        Box<crate::sidecar::SidecarDocument>,
    ),
}
pub enum Event {
    SignIn(String),
    Connected(Vec<CloudLibrary>),
    Folder(u64, Box<CloudFolder>),
    Derivative(u64, String, bool, Result<egui::ColorImage, String>),
    EditReady(u64, crate::library::Photo, CloudEntry),
    Reloaded(u64, crate::library::Photo),
    Synced(u64, Result<(), String>),
    Waiting,
    Disconnected,
    Error(String),
}
pub struct Worker {
    control: mpsc::Sender<Command>,
    media: mpsc::SyncSender<(u64, CloudEntry, bool)>,
    pub events: mpsc::Receiver<Event>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Worker {
    pub fn new(context: egui::Context) -> Self {
        let (control, commands) = mpsc::channel();
        let (media, images) = mpsc::sync_channel::<(u64, CloudEntry, bool)>(2);
        let (sender, events) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = thread::spawn(move || {
            let mut client: Option<CloudClient> = None;
            let mut journal: Option<super::EditJournal> = None;
            let mut pending: Option<PendingSignIn> = None;
            while !stopped.load(Ordering::Acquire) {
                let command = match commands.recv_timeout(std::time::Duration::from_millis(30)) {
                    Ok(command) => Some(command),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                let result: Result<Option<Event>, String> = (|| {
                    if let Some(command) = command {
                        match command {
                            Command::Download(epoch, entry) => {
                                let connection =
                                    client.as_mut().ok_or("Connect to a Maple server first")?;
                                let server = connection.server_url().to_owned();
                                let base = dirs::data_local_dir()
                                    .ok_or("No local data directory is available")?
                                    .join("maple/cloud-edits");
                                let same = journal
                                    .as_ref()
                                    .is_some_and(|edit| edit.matches(&server, &entry));
                                if !same {
                                    if let Some(edit) = &journal {
                                        if edit.pending().map_err(|error| error.to_string())? {
                                            return Err("Synchronize pending cloud edits before changing images".into());
                                        }
                                    }
                                    let mut candidate =
                                        super::EditJournal::open(&base, &server, &entry)
                                            .map_err(|error| error.to_string())?;
                                    if !candidate.pending().map_err(|error| error.to_string())? {
                                        let download = connection
                                            .download_for_edit(&entry)
                                            .map_err(|error| error.to_string())?;
                                        candidate
                                            .prepare(&server, &entry, download)
                                            .map_err(|error| error.to_string())?;
                                    }
                                    journal = Some(candidate);
                                } else {
                                    let edit = journal.as_mut().expect("matching journal");
                                    if !edit.pending().map_err(|error| error.to_string())? {
                                        let download = connection
                                            .download_for_edit(&entry)
                                            .map_err(|error| error.to_string())?;
                                        edit.prepare(&server, &entry, download)
                                            .map_err(|error| error.to_string())?;
                                    }
                                }
                                let edit = journal.as_ref().expect("opened journal");
                                return Ok(Some(Event::EditReady(
                                    epoch,
                                    photo_at(edit.path().map_err(|error| error.to_string())?)?,
                                    entry,
                                )));
                            }
                            Command::Reload(id, path) => {
                                let connection =
                                    client.as_mut().ok_or("Cloud session is disconnected")?;
                                let edit = journal.as_mut().ok_or("No cloud editor is open")?;
                                if edit.path().map_err(|e| e.to_string())? != path {
                                    return Err("Cloud image changed before reload".into());
                                }
                                edit.reload(connection).map_err(|e| e.to_string())?;
                                return Ok(Some(Event::Reloaded(id, photo_at(path)?)));
                            }
                            Command::Sync(id, path, document) => {
                                let result = (|| {
                                    let connection =
                                        client.as_mut().ok_or("Cloud session is disconnected")?;
                                    let edit = journal
                                        .as_mut()
                                        .ok_or("No cloud editor session is open")?;
                                    if edit.path().map_err(|e| e.to_string())? != path {
                                        return Err("Cloud image changed before this save".into());
                                    }
                                    edit.synchronize(connection, &document)
                                        .map_err(|e| e.to_string())
                                })();
                                return Ok(Some(Event::Synced(id, result)));
                            }
                            Command::Connect(url) => {
                                journal = None;
                                pending = None;
                                client = None;
                                let mut connection = CloudClient::new(
                                    Server::parse(&url).map_err(|e| e.to_string())?,
                                )
                                .map_err(|e| e.to_string())?;
                                connection.probe().map_err(|e| e.to_string())?;
                                let restored = match connection.restore() {
                                    Ok(restored) => restored,
                                    Err(super::CloudError::Http(400 | 401)) => false,
                                    Err(error) => return Err(error.to_string()),
                                };
                                let event = if restored {
                                    Event::Connected(
                                        connection.libraries().map_err(|e| e.to_string())?,
                                    )
                                } else {
                                    let (ceremony, url) =
                                        connection.begin_sign_in().map_err(|e| e.to_string())?;
                                    pending = Some(ceremony);
                                    Event::SignIn(url)
                                };
                                client = Some(connection);
                                return Ok(Some(event));
                            }
                            Command::Claim => {
                                let connection =
                                    client.as_mut().ok_or("Connect to a Maple server first")?;
                                let ceremony =
                                    pending.as_ref().ok_or("No sign-in ceremony is pending")?;
                                match connection.claim(ceremony) {
                                    Ok(true) => {
                                        pending = None;
                                        return Ok(Some(Event::Connected(
                                            connection.libraries().map_err(|e| e.to_string())?,
                                        )));
                                    }
                                    Ok(false) | Err(super::CloudError::Network(_)) => {
                                        return Ok(Some(Event::Waiting))
                                    }
                                    Err(error) => return Err(error.to_string()),
                                }
                            }
                            Command::Folder(epoch, address, cursor) => {
                                let connection =
                                    client.as_mut().ok_or("Connect to a Maple server first")?;
                                return connection
                                    .folder(&address, cursor.as_deref())
                                    .map(|folder| Some(Event::Folder(epoch, Box::new(folder))))
                                    .map_err(|e| e.to_string());
                            }
                            Command::Disconnect => {
                                if let Some(connection) = &mut client {
                                    connection.disconnect().map_err(|e| e.to_string())?;
                                }
                                client = None;
                                journal = None;
                                pending = None;
                                return Ok(Some(Event::Disconnected));
                            }
                        }
                    }
                    if let Ok((epoch, entry, preview)) = images.try_recv() {
                        let image = client
                            .as_mut()
                            .ok_or_else(|| "Cloud session is disconnected".to_owned())
                            .and_then(|connection| {
                                let bytes = connection
                                    .derivative(
                                        if preview { "preview" } else { "thumb" },
                                        &entry.address,
                                    )
                                    .map_err(|e| e.to_string())?;
                                let image = raw_core::raster::decode_raster(&bytes, Some("avif"))
                                    .map_err(|e| e.to_string())?;
                                Ok(egui::ColorImage::from_rgb(
                                    [image.width as usize, image.height as usize],
                                    &image.to_rgb_bytes(),
                                ))
                            });
                        return Ok(Some(Event::Derivative(
                            epoch,
                            entry.address,
                            preview,
                            image,
                        )));
                    }
                    Ok(None)
                })();
                let event = match result {
                    Ok(Some(event)) => event,
                    Ok(None) => continue,
                    Err(error) => Event::Error(error),
                };
                if sender.send(event).is_err() {
                    break;
                }
                context.request_repaint();
            }
        });
        Self {
            control,
            media,
            events,
            stop,
            thread: Some(thread),
        }
    }
    pub fn send(&self, command: Command) {
        let _ = self.control.send(command);
    }
    pub fn image(&self, epoch: u64, entry: CloudEntry, preview: bool) -> bool {
        self.media.try_send((epoch, entry, preview)).is_ok()
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn photo_at(path: std::path::PathBuf) -> Result<crate::library::Photo, String> {
    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    let kind = crate::library::media_kind(&path)
        .ok_or("This cloud photograph's format is not supported")?;
    Ok(crate::library::Photo {
        path,
        kind,
        modified: metadata.modified().map_err(|error| error.to_string())?,
        size: metadata.len(),
    })
}
