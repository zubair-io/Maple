//! Cloud tiles: up to eight fetches at once, each decoded on the thread that fetched it; results older than the newest epoch are dropped.
use super::{tile_cache::TileCache, worker::Event, CloudEntry, TileFetcher};
use eframe::egui;
use std::{
    panic::{self, AssertUnwindSafe},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, PoisonError,
    },
    thread,
};

pub const FETCH_WIDTH: usize = 8;

pub struct TileJob {
    pub epoch: u64,
    pub entry: CloudEntry,
    pub preview: bool,
}

type Connection = Arc<Mutex<Option<Arc<TileFetcher>>>>;
type Make =
    dyn Fn(Option<&TileFetcher>, &TileJob) -> Result<egui::ColorImage, String> + Send + Sync;

pub struct TilePool {
    jobs: Option<mpsc::SyncSender<TileJob>>,
    newest: Arc<AtomicU64>,
    connection: Connection,
    threads: Vec<thread::JoinHandle<()>>,
}

impl TilePool {
    pub fn new(
        context: egui::Context,
        events: mpsc::Sender<Event>,
        cache: Option<TileCache>,
    ) -> Self {
        Self::spawn(
            context,
            events,
            Arc::new(move |fetcher, job| tile(fetcher, cache.as_ref(), job)),
        )
    }

    pub(super) fn spawn(
        context: egui::Context,
        events: mpsc::Sender<Event>,
        make: Arc<Make>,
    ) -> Self {
        let (jobs, queue) = mpsc::sync_channel::<TileJob>(FETCH_WIDTH);
        let queue = Arc::new(Mutex::new(queue));
        let newest = Arc::new(AtomicU64::new(0));
        let connection: Connection = Arc::default();
        let threads = (0..FETCH_WIDTH)
            .map(|_| {
                let (queue, newest, connection, make, events, context) = (
                    queue.clone(),
                    newest.clone(),
                    connection.clone(),
                    make.clone(),
                    events.clone(),
                    context.clone(),
                );
                thread::spawn(move || loop {
                    let next = queue.lock().unwrap_or_else(PoisonError::into_inner).recv();
                    let Ok(job) = next else { break };
                    if job.epoch < newest.load(Ordering::Acquire) {
                        continue;
                    }
                    let fetcher = connection
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .clone();
                    let tile =
                        panic::catch_unwind(AssertUnwindSafe(|| make(fetcher.as_deref(), &job)))
                            .unwrap_or_else(|_| Err("The tile could not be made".into()));
                    if job.epoch < newest.load(Ordering::Acquire) {
                        continue;
                    }
                    let event = Event::Derivative(job.epoch, job.entry.address, job.preview, tile);
                    if events.send(event).is_err() {
                        break;
                    }
                    context.request_repaint();
                })
            })
            .collect();
        Self {
            jobs: Some(jobs),
            newest,
            connection,
            threads,
        }
    }

    pub fn offer(&self, job: TileJob) -> bool {
        self.newest.fetch_max(job.epoch, Ordering::AcqRel);
        self.jobs
            .as_ref()
            .is_some_and(|jobs| jobs.try_send(job).is_ok())
    }

    pub fn connect(&self, fetcher: Option<TileFetcher>) {
        *self
            .connection
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = fetcher.map(Arc::new);
    }
}

impl Drop for TilePool {
    fn drop(&mut self) {
        self.jobs.take();
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

fn tile(
    fetcher: Option<&TileFetcher>,
    cache: Option<&TileCache>,
    job: &TileJob,
) -> Result<egui::ColorImage, String> {
    let fetcher = fetcher.ok_or("Cloud session is disconnected")?;
    let address = &job.entry.address;
    let (kind, token) = if job.preview {
        ("preview", None)
    } else {
        ("thumb", job.entry.thumb_version.as_deref())
    };
    let cache = cache.filter(|_| !job.preview);
    let server = fetcher.server_url();
    let stored = cache
        .and_then(|cache| cache.load(server, address, token))
        .and_then(|bytes| decode(&bytes).ok());
    if let Some(image) = stored {
        return Ok(image);
    }
    let bytes = fetcher
        .derivative(kind, address, token)
        .map_err(|error| error.to_string())?;
    let image = decode(&bytes)?;
    if let Some(cache) = cache {
        cache.store(server, address, token, &bytes);
    }
    Ok(image)
}

fn decode(bytes: &[u8]) -> Result<egui::ColorImage, String> {
    let image =
        raw_core::raster::decode_raster(bytes, Some("avif")).map_err(|error| error.to_string())?;
    Ok(egui::ColorImage::from_rgb(
        [image.width as usize, image.height as usize],
        &image.to_rgb_bytes(),
    ))
}
