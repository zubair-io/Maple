use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

fn serve(stop: Arc<AtomicBool>) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let thread = thread::spawn(move || {
        while !stop.load(Ordering::Acquire) {
            let Ok((mut socket, _)) = listener.accept() else {
                thread::sleep(Duration::from_millis(1));
                continue;
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut expected = usize::MAX;
            while bytes.len() < expected {
                let mut chunk = [0; 2048];
                match socket.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(length) => bytes.extend_from_slice(&chunk[..length]),
                }
                if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length = header
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:")?.trim().parse().ok())
                        .unwrap_or(0);
                    expected = end + 4 + length;
                }
            }
            let request = String::from_utf8_lossy(&bytes).into_owned();
            let path = request.split_whitespace().nth(1).unwrap_or("").to_owned();
            let body = if path.starts_with("/api/health") {
                r#"{"ok":true,"product":"maple","db_connected":true}"#.to_owned()
            } else if path.starts_with("/api/auth/native-code/claim") {
                let state = request
                    .split("\"state\":\"")
                    .nth(1)
                    .and_then(|rest| rest.split('"').next())
                    .unwrap_or("");
                format!(
                    r#"{{"access_token":"access","refresh_token":"refresh","state":"{state}"}}"#
                )
            } else if path.starts_with("/api/folders") {
                r#"[{"id":"library-1","slug":"photos","path":"/photos","label":null}]"#.to_owned()
            } else {
                "not an image".to_owned()
            };
            let _ = write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
        }
    });
    (origin, thread)
}

fn entry(index: usize) -> CloudEntry {
    CloudEntry {
        name: format!("IMG_{index}.dng"),
        address: format!("photos:IMG_{index}.dng"),
        path: format!("/photos/IMG_{index}.dng"),
        id: None,
        ext: "dng".into(),
        size: 1,
        mtime: String::new(),
        is_video: false,
        is_stub: false,
        is_audio: false,
        thumb_version: None,
    }
}

const THUMBNAILS: usize = 40;

fn time_queued_thumbnails(worker: &Worker, first: usize) -> Duration {
    let started = Instant::now();
    let mut requested = 0;
    let mut received = 0;
    while received < THUMBNAILS {
        if requested < THUMBNAILS && worker.image(0, entry(first + requested), false) {
            requested += 1;
        }
        while let Ok(event) = worker.events.try_recv() {
            if matches!(event, Event::Derivative(..)) {
                received += 1;
            }
        }
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "thumbnails stalled"
        );
    }
    started.elapsed()
}

#[test]
fn queued_thumbnails_are_not_delayed_by_the_command_poll() {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let stop = Arc::new(AtomicBool::new(false));
    let (origin, server) = serve(stop.clone());
    let cache = tempfile::tempdir().unwrap();
    let worker = Worker::with_tile_cache(
        eframe::egui::Context::default(),
        Some(TileCache::new(cache.path().to_owned(), 1 << 20)),
    );
    worker.send(Command::Connect(origin));
    loop {
        match worker.events.recv_timeout(Duration::from_secs(10)).unwrap() {
            Event::SignIn(_) => worker.send(Command::Claim("0123456789abcdef0123".into())),
            Event::Connected(_) => break,
            Event::Error(error) => panic!("connect failed: {error}"),
            _ => {}
        }
    }

    let fastest = (0..3)
        .map(|round| time_queued_thumbnails(&worker, round * THUMBNAILS))
        .min()
        .unwrap();

    stop.store(true, Ordering::Release);
    drop(worker);
    server.join().unwrap();
    assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0);
    assert!(
        fastest < Duration::from_millis(1000),
        "40 queued thumbnails took {fastest:?} at best; each one waited out the 30 ms command poll"
    );
}
