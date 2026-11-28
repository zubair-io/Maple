use super::*;
use crate::cloud::{
    tile_cache::TileCache,
    tiles::{TileJob, TilePool, FETCH_WIDTH},
    worker::{Command, Event, Worker},
};
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{channel, Receiver, Sender},
        Arc, Barrier, Mutex,
    },
    thread,
    time::Duration,
};

struct Request {
    method: String,
    target: String,
    authorization: Option<String>,
    body: String,
}

struct Reply {
    status: u16,
    body: Vec<u8>,
}

fn ok(body: Vec<u8>) -> Reply {
    Reply { status: 200, body }
}

struct Origin {
    address: String,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Drop for Origin {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn read_request(socket: &mut std::net::TcpStream) -> Request {
    let mut bytes = Vec::new();
    let head_end = loop {
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break end + 4;
        }
        let mut chunk = [0; 2048];
        let length = socket.read(&mut chunk).unwrap();
        assert!(length > 0, "the client closed before finishing its request");
        bytes.extend_from_slice(&chunk[..length]);
    };
    let head = String::from_utf8_lossy(&bytes[..head_end]).into_owned();
    let header = |name: &str| {
        head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    };
    let body_length: usize = header("content-length").map_or(0, |length| length.parse().unwrap());
    while bytes.len() < head_end + body_length {
        let mut chunk = [0; 2048];
        let length = socket.read(&mut chunk).unwrap();
        assert!(length > 0);
        bytes.extend_from_slice(&chunk[..length]);
    }
    let mut first = head.lines().next().unwrap().split_whitespace();
    Request {
        body: String::from_utf8_lossy(&bytes[head_end..head_end + body_length]).into_owned(),
        method: first.next().unwrap().to_owned(),
        target: first.next().unwrap().to_owned(),
        authorization: header("authorization"),
    }
}

fn serve(handler: impl Fn(Request) -> Reply + Send + Sync + 'static) -> Origin {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let handler = Arc::new(handler);
    let thread = thread::spawn(move || {
        while !stopped.load(Ordering::Acquire) {
            let Ok((mut socket, _)) = listener.accept() else {
                thread::sleep(Duration::from_millis(1));
                continue;
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let handler = handler.clone();
            thread::spawn(move || {
                let reply = handler(read_request(&mut socket));
                let _ = write!(
                    socket,
                    "HTTP/1.1 {} Status\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    reply.status,
                    reply.body.len()
                );
                let _ = socket.write_all(&reply.body);
            });
        }
    });
    Origin {
        address,
        stop,
        thread: Some(thread),
    }
}

fn avif(shade: u8) -> Vec<u8> {
    raw_core::avif::encode(8, 8, &[shade; 8 * 8 * 3], 55).unwrap()
}

fn entry(name: &str, token: Option<&str>) -> CloudEntry {
    serde_json::from_value(serde_json::json!({
        "name": name,
        "address": format!("photos:{name}"),
        "path": format!("/photos/{name}"),
        "thumbVersion": token,
    }))
    .unwrap()
}

fn fetcher(origin: &Origin) -> TileFetcher {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    CloudClient::new(Server::parse(&origin.address).unwrap())
        .unwrap()
        .tile_fetcher()
}

fn pool(origin: &Origin, cache: Option<TileCache>) -> (TilePool, Receiver<Event>) {
    let (events, received) = channel();
    let pool = TilePool::new(eframe::egui::Context::default(), events, cache);
    pool.connect(Some(fetcher(origin)));
    (pool, received)
}

fn offer(pool: &TilePool, epoch: u64, entry: &CloudEntry, preview: bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !pool.offer(TileJob {
        epoch,
        entry: entry.clone(),
        preview,
    }) {
        assert!(
            std::time::Instant::now() < deadline,
            "the queue never drained"
        );
        thread::yield_now();
    }
}

fn arrived(
    events: &Receiver<Event>,
) -> (u64, String, bool, Result<eframe::egui::ColorImage, String>) {
    match events.recv_timeout(Duration::from_secs(10)).unwrap() {
        Event::Derivative(epoch, address, preview, image) => (epoch, address, preview, image),
        _ => panic!("expected a tile"),
    }
}

fn names(directory: &Path) -> BTreeSet<String> {
    std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect()
}

type Log = Arc<Mutex<Vec<String>>>;

fn requests_log() -> (Log, Log) {
    let log = Arc::new(Mutex::new(Vec::new()));
    (log.clone(), log)
}

#[test]
fn the_listings_token_is_sent_on_the_thumbnail_request_and_not_on_the_preview() {
    let (log, seen) = requests_log();
    let origin = serve(move |request| {
        seen.lock().unwrap().push(request.target);
        ok(avif(90))
    });
    let (pool, events) = pool(&origin, None);

    offer(&pool, 0, &entry("IMG_1.dng", Some("k1-a")), false);
    assert!(arrived(&events).3.is_ok());
    offer(&pool, 0, &entry("IMG_1.dng", Some("k1-a")), true);
    assert!(arrived(&events).3.is_ok());

    assert_eq!(
        *log.lock().unwrap(),
        [
            "/api/thumb/photos/IMG_1.dng?v=k1-a",
            "/api/preview/photos/IMG_1.dng"
        ]
    );
}

#[test]
fn a_cached_tile_with_the_listings_token_makes_no_request() {
    let cache = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let counted = requests.clone();
    let origin = serve(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        ok(avif(90))
    });
    let (pool, events) = pool(
        &origin,
        Some(TileCache::new(cache.path().to_owned(), 1 << 20)),
    );

    offer(&pool, 0, &entry("IMG_1.dng", Some("k1-a")), false);
    arrived(&events).3.unwrap();
    offer(&pool, 0, &entry("IMG_1.dng", Some("k1-a")), false);
    arrived(&events).3.unwrap();

    assert_eq!(requests.load(Ordering::SeqCst), 1);
}

#[test]
fn a_changed_token_fetches_again_and_replaces_the_tile_under_the_same_name() {
    let cache = tempfile::tempdir().unwrap();
    let origin = serve(|request| {
        ok(avif(if request.target.ends_with("v=k1-b") {
            200
        } else {
            40
        }))
    });
    let (pool, events) = pool(
        &origin,
        Some(TileCache::new(cache.path().to_owned(), 1 << 20)),
    );

    offer(&pool, 0, &entry("IMG_1.dng", Some("k1-a")), false);
    arrived(&events).3.unwrap();
    let before = names(cache.path());
    offer(&pool, 0, &entry("IMG_1.dng", Some("k1-b")), false);
    arrived(&events).3.unwrap();

    let after = names(cache.path());
    assert_eq!(after, before);
    assert_eq!(after.len(), 2);
    assert!(
        after.iter().all(|name| !name.contains("k1-")),
        "a token in a file name: {after:?}"
    );
    let stored = after.iter().find(|name| name.ends_with(".avif")).unwrap();
    assert_eq!(std::fs::read(cache.path().join(stored)).unwrap(), avif(200));
    let index = after.iter().find(|name| name.ends_with(".json")).unwrap();
    let index = std::fs::read_to_string(cache.path().join(index)).unwrap();
    assert!(index.contains("k1-b") && !index.contains("k1-a"), "{index}");
}

#[test]
fn a_listing_without_a_token_asks_the_server_every_time() {
    let cache = tempfile::tempdir().unwrap();
    let (log, seen) = requests_log();
    let origin = serve(move |request| {
        seen.lock().unwrap().push(request.target);
        ok(avif(90))
    });
    let (pool, events) = pool(
        &origin,
        Some(TileCache::new(cache.path().to_owned(), 1 << 20)),
    );

    offer(&pool, 0, &entry("IMG_1.dng", None), false);
    arrived(&events).3.unwrap();
    offer(&pool, 0, &entry("IMG_1.dng", None), false);
    arrived(&events).3.unwrap();

    assert_eq!(
        *log.lock().unwrap(),
        ["/api/thumb/photos/IMG_1.dng", "/api/thumb/photos/IMG_1.dng"]
    );
}

fn connect(worker: &Worker, origin: &Origin) {
    worker.send(Command::Connect(origin.address.clone()));
    loop {
        match worker.events.recv_timeout(Duration::from_secs(10)).unwrap() {
            Event::SignIn(_) => worker.send(Command::Claim("0123456789abcdef0123".into())),
            Event::Connected(_) => return,
            Event::Error(error) => panic!("connect failed: {error}"),
            _ => {}
        }
    }
}

fn session_reply(request: &Request) -> Option<Reply> {
    let path = request.target.as_str();
    let body = if path.starts_with("/api/health") {
        r#"{"ok":true,"product":"maple","db_connected":true}"#.to_owned()
    } else if path.starts_with("/api/auth/native-code/claim") {
        let state = request
            .body
            .split("\"state\":\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or("");
        format!(r#"{{"access_token":"access","refresh_token":"refresh","state":"{state}"}}"#)
    } else if path.starts_with("/api/folders") {
        "[]".to_owned()
    } else {
        return None;
    };
    Some(ok(body.into_bytes()))
}

#[test]
fn a_listing_without_a_token_writes_no_cache_file() {
    let cache = tempfile::tempdir().unwrap();
    let origin = serve(|_| ok(avif(90)));
    let (pool, events) = pool(
        &origin,
        Some(TileCache::new(cache.path().to_owned(), 1 << 20)),
    );

    offer(&pool, 0, &entry("IMG_1.dng", None), false);
    arrived(&events).3.unwrap();

    assert!(names(cache.path()).is_empty());
}

#[test]
fn a_worker_stores_its_tiles_in_the_cache_it_was_given() {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let cache = tempfile::tempdir().unwrap();
    let origin = serve(|request| session_reply(&request).unwrap_or_else(|| ok(avif(90))));
    let worker = Worker::with_tile_cache(
        eframe::egui::Context::default(),
        Some(TileCache::new(cache.path().to_owned(), 1 << 20)),
    );
    connect(&worker, &origin);

    assert!(worker.image(0, entry("IMG_1.dng", Some("k1-a")), false));
    loop {
        if let Event::Derivative(_, _, _, tile) =
            worker.events.recv_timeout(Duration::from_secs(10)).unwrap()
        {
            tile.unwrap();
            break;
        }
    }

    assert_eq!(names(cache.path()).len(), 2);
}

#[test]
fn a_damaged_cached_tile_is_fetched_again() {
    let cache = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let counted = requests.clone();
    let origin = serve(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        ok(avif(90))
    });
    let (pool, events) = pool(
        &origin,
        Some(TileCache::new(cache.path().to_owned(), 1 << 20)),
    );
    offer(&pool, 0, &entry("IMG_1.dng", Some("k1-a")), false);
    arrived(&events).3.unwrap();
    let stored = names(cache.path())
        .into_iter()
        .find(|name| name.ends_with(".avif"))
        .unwrap();
    std::fs::write(cache.path().join(&stored), b"not an avif").unwrap();

    offer(&pool, 0, &entry("IMG_1.dng", Some("k1-a")), false);
    arrived(&events).3.unwrap();

    assert_eq!(requests.load(Ordering::SeqCst), 2);
    assert_eq!(std::fs::read(cache.path().join(stored)).unwrap(), avif(90));
}

struct Held {
    started: Receiver<String>,
    release: Sender<()>,
    origin: Origin,
}

fn holding_every_thumbnail() -> Held {
    let (started_tx, started) = channel();
    let (release, release_rx) = channel::<()>();
    let started_tx = Mutex::new(started_tx);
    let release_rx = Mutex::new(release_rx);
    let origin = serve(move |request| {
        started_tx.lock().unwrap().send(request.target).unwrap();
        release_rx
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(20))
            .unwrap();
        ok(avif(90))
    });
    Held {
        started,
        release,
        origin,
    }
}

#[test]
fn eight_fetches_are_in_flight_and_the_ninth_waits_for_one_to_finish() {
    let held = holding_every_thumbnail();
    let (pool, events) = pool(&held.origin, None);
    for index in 0..10 {
        offer(&pool, 0, &entry(&format!("IMG_{index}.dng"), None), false);
    }

    let in_flight: BTreeSet<_> = (0..8)
        .map(|_| held.started.recv_timeout(Duration::from_secs(10)).unwrap())
        .collect();
    assert_eq!(in_flight.len(), 8);
    assert_eq!(FETCH_WIDTH, 8);
    assert!(
        held.started
            .recv_timeout(Duration::from_millis(250))
            .is_err(),
        "a ninth request started while eight were in flight"
    );

    held.release.send(()).unwrap();
    held.started.recv_timeout(Duration::from_secs(10)).unwrap();
    for _ in 0..9 {
        held.release.send(()).unwrap();
    }
    for _ in 0..10 {
        arrived(&events).3.unwrap();
    }
}

#[test]
fn a_tile_from_an_older_epoch_is_dropped_before_and_after_its_fetch() {
    let held = holding_every_thumbnail();
    let (pool, events) = pool(&held.origin, None);
    for index in 0..FETCH_WIDTH {
        offer(&pool, 1, &entry(&format!("OLD_{index}.dng"), None), false);
    }
    for _ in 0..FETCH_WIDTH {
        held.started.recv_timeout(Duration::from_secs(10)).unwrap();
    }
    offer(&pool, 1, &entry("QUEUED_BEFORE_THE_JUMP.dng", None), false);
    offer(&pool, 2, &entry("NEW.dng", None), false);

    for _ in 0..FETCH_WIDTH + 1 {
        held.release.send(()).unwrap();
    }

    let (epoch, address, _, image) = arrived(&events);
    assert_eq!((epoch, address.as_str()), (2, "photos:NEW.dng"));
    assert!(image.is_ok());
    assert!(
        events.recv_timeout(Duration::from_millis(300)).is_err(),
        "a tile from the old epoch was delivered"
    );
    let mut requested = vec![];
    while let Ok(target) = held.started.try_recv() {
        requested.push(target);
    }
    assert_eq!(requested, ["/api/thumb/photos/NEW.dng"]);
}

#[test]
fn a_panicking_fetch_fails_its_tile_and_leaves_the_pool_at_full_size() {
    let (events, received) = channel();
    let pool = TilePool::spawn(
        eframe::egui::Context::default(),
        events,
        Arc::new(|_: Option<&TileFetcher>, job: &TileJob| {
            assert!(!job.entry.name.starts_with("boom"), "the decoder panicked");
            Ok(eframe::egui::ColorImage::example())
        }),
    );

    (0..=FETCH_WIDTH)
        .for_each(|index| offer(&pool, 0, &entry(&format!("boom{index}.dng"), None), false));
    (0..=FETCH_WIDTH).for_each(|_| assert!(arrived(&received).3.is_err()));
    offer(&pool, 0, &entry("fine.dng", None), false);

    assert!(arrived(&received).3.is_ok());
}

#[test]
fn the_cache_stays_within_its_budget_and_drops_the_least_recently_used_tiles() {
    let directory = tempfile::tempdir().unwrap();
    let cache = TileCache::new(directory.path().to_owned(), 10_000);
    let started = std::time::SystemTime::now() - Duration::from_secs(3600);
    let stamped = std::cell::RefCell::new(BTreeSet::new());
    let store = |index: usize| {
        cache.store(
            "https://maple",
            &format!("photos:{index}.dng"),
            Some("t"),
            &vec![7; 1_000],
        );
        names(directory.path())
            .into_iter()
            .filter(|name| stamped.borrow_mut().insert(name.clone()))
            .for_each(|name| {
                std::fs::File::options()
                    .append(true)
                    .open(directory.path().join(name))
                    .unwrap()
                    .set_modified(started + Duration::from_secs(index as u64))
                    .unwrap()
            });
    };
    let present = |index: usize| {
        cache
            .load("https://maple", &format!("photos:{index}.dng"), Some("t"))
            .is_some()
    };
    (0..9).for_each(store);
    assert!(present(0));
    store(9);

    let stored: u64 = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().metadata().unwrap().len())
        .sum();
    assert!(
        stored <= 9_000,
        "{stored} bytes kept of a 10,000 byte budget"
    );
    assert!(present(0), "the tile used last was dropped");
    assert!(!present(1), "the least recently used tile was kept");
    assert!(present(9));
}

#[test]
fn an_unwritable_cache_never_stops_a_tile() {
    let directory = tempfile::tempdir().unwrap();
    let blocked = directory.path().join("cloud-tiles");
    std::fs::write(&blocked, b"a file where the folder belongs").unwrap();
    let origin = serve(|_| ok(avif(90)));
    let (pool, events) = pool(&origin, Some(TileCache::new(blocked, 1 << 20)));

    offer(&pool, 0, &entry("IMG_1.dng", Some("k1-a")), false);

    assert!(arrived(&events).3.is_ok());
}

#[path = "tile_session_tests.rs"]
mod session_tests;
