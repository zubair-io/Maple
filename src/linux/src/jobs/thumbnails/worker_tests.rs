use super::*;
use std::{
    path::Path,
    sync::mpsc::{channel, Receiver, Sender},
    time::{Duration, SystemTime},
};

fn photo(index: usize) -> Photo {
    Photo {
        path: Path::new("/library").join(format!("IMG_{index}.dng")),
        kind: crate::library::MediaKind::Raw,
        modified: SystemTime::UNIX_EPOCH,
        size: 1,
    }
}

struct Gate {
    started: Receiver<PathBuf>,
    release: Sender<()>,
    worker: ThumbnailWorker,
}

fn gated(workers: usize) -> Gate {
    let (started_tx, started) = channel();
    let (release, release_rx) = channel::<()>();
    let release_rx = Mutex::new(release_rx);
    let render: Arc<Render> = Arc::new(move |photo: &Photo| {
        started_tx.send(photo.path.clone()).unwrap();
        release_rx.lock().unwrap().recv().unwrap();
        Ok(egui::ColorImage::example())
    });
    Gate {
        started,
        release,
        worker: ThumbnailWorker::spawn(egui::Context::default(), workers, render),
    }
}

fn enqueue(worker: &ThumbnailWorker, index: usize) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !worker.request(0, photo(index)) {
        assert!(
            std::time::Instant::now() < deadline,
            "the queue never drained"
        );
        thread::yield_now();
    }
}

#[test]
fn two_requests_from_one_queue_render_at_the_same_time_and_a_third_waits() {
    let gate = gated(WORKERS);
    for index in 0..3 {
        enqueue(&gate.worker, index);
    }

    let simultaneous: Vec<_> = (0..2)
        .map(|_| gate.started.recv_timeout(Duration::from_secs(5)).unwrap())
        .collect();
    assert_eq!(simultaneous.len(), 2, "two renders were running together");
    assert!(
        gate.started
            .recv_timeout(Duration::from_millis(250))
            .is_err(),
        "a third render started while two were still running"
    );

    gate.release.send(()).unwrap();
    gate.started.recv_timeout(Duration::from_secs(5)).unwrap();
    gate.release.send(()).unwrap();
    gate.release.send(()).unwrap();
    let delivered: Vec<_> = (0..3)
        .map(|_| {
            gate.worker
                .events
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
        })
        .collect();
    assert!(delivered
        .iter()
        .all(|(generation, _, tile)| *generation == 0 && tile.is_ok()));
}

#[test]
fn the_app_pool_has_two_workers() {
    assert_eq!(
        ThumbnailWorker::new(egui::Context::default()).threads.len(),
        2
    );
}

#[test]
fn a_render_that_panics_fails_its_tile_and_leaves_the_worker_running() {
    let worker = ThumbnailWorker::spawn(
        egui::Context::default(),
        1,
        Arc::new(|photo: &Photo| {
            assert!(!photo.path.ends_with("IMG_0.dng"), "the decoder panicked");
            Ok(egui::ColorImage::example())
        }),
    );
    enqueue(&worker, 0);
    enqueue(&worker, 1);

    let delivered: Vec<_> = (0..2)
        .map(|_| worker.events.recv_timeout(Duration::from_secs(5)).unwrap())
        .collect();

    assert_eq!(
        delivered
            .iter()
            .map(|(_, path, tile)| (path.ends_with("IMG_0.dng"), tile.is_ok()))
            .collect::<Vec<_>>(),
        [(true, false), (false, true)]
    );
    assert!(worker.threads.iter().all(|thread| !thread.is_finished()));
}

#[test]
fn dropping_the_pool_waits_for_every_worker_to_finish() {
    let gate = gated(WORKERS);
    enqueue(&gate.worker, 0);
    gate.started.recv_timeout(Duration::from_secs(5)).unwrap();
    let Gate {
        release, worker, ..
    } = gate;
    let (dropped, dropping) = channel();
    let dropper = thread::spawn(move || {
        drop(worker);
        dropped.send(()).unwrap();
    });

    assert!(
        dropping.recv_timeout(Duration::from_millis(250)).is_err(),
        "the pool was dropped while a render was still running"
    );
    release.send(()).unwrap();
    dropping.recv_timeout(Duration::from_secs(5)).unwrap();
    dropper.join().unwrap();
}
