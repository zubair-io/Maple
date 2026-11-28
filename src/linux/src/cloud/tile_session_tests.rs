use super::*;

fn refreshing_origin(
    refreshes: Arc<AtomicUsize>,
    on_get: impl Fn(&Request) -> Reply + Send + Sync + 'static,
) -> Origin {
    serve(move |request| {
        if request.method != "POST" {
            return on_get(&request);
        }
        let issued = refreshes.fetch_add(1, Ordering::SeqCst) + 1;
        ok(
            format!(r#"{{"access_token":"access-{issued}","refresh_token":"refresh-{issued}"}}"#)
                .into_bytes(),
        )
    })
}

fn rejected() -> Reply {
    Reply {
        status: 401,
        body: Vec::new(),
    }
}

#[test]
fn eight_rejections_of_the_same_token_refresh_the_session_once() {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let refreshes = Arc::new(AtomicUsize::new(0));
    let all_stale = Arc::new(Barrier::new(FETCH_WIDTH));
    let origin = refreshing_origin(refreshes.clone(), move |request| {
        if request.authorization.as_deref() == Some("Bearer access-1") {
            all_stale.wait();
            return rejected();
        }
        ok(avif(90))
    });
    let mut client = CloudClient::new(Server::parse(&origin.address).unwrap()).unwrap();
    client.credential.set_password("refresh-0").unwrap();
    assert!(client.restore().unwrap());
    let fetcher = Arc::new(client.tile_fetcher());

    let fetches: Vec<_> = (0..FETCH_WIDTH)
        .map(|index| {
            let fetcher = fetcher.clone();
            thread::spawn(move || fetcher.derivative("thumb", &format!("photos:{index}.dng"), None))
        })
        .collect();

    for fetch in fetches {
        assert_eq!(fetch.join().unwrap().unwrap(), avif(90));
    }
    assert_eq!(
        refreshes.load(Ordering::SeqCst),
        2,
        "one restore, one refresh"
    );
}

#[test]
fn a_request_sent_before_sign_in_finished_does_not_rotate_the_token_just_issued() {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let (arrived_tx, request_sent) = channel();
    let (release, release_rx) = channel::<()>();
    let (arrived_tx, release_rx) = (Mutex::new(arrived_tx), Mutex::new(release_rx));
    let refreshes = Arc::new(AtomicUsize::new(0));
    let origin = refreshing_origin(refreshes.clone(), move |request| {
        if request.authorization.is_some() {
            return ok(avif(90));
        }
        arrived_tx.lock().unwrap().send(()).unwrap();
        release_rx
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        rejected()
    });
    let mut client = CloudClient::new(Server::parse(&origin.address).unwrap()).unwrap();
    let fetcher = client.tile_fetcher();
    let fetch = thread::spawn(move || fetcher.derivative("thumb", "photos:a.dng", None));
    request_sent.recv_timeout(Duration::from_secs(10)).unwrap();
    client.credential.set_password("refresh-0").unwrap();
    assert!(client.restore().unwrap());

    release.send(()).unwrap();

    assert_eq!(fetch.join().unwrap().unwrap(), avif(90));
    assert_eq!(
        refreshes.load(Ordering::SeqCst),
        1,
        "only the restore rotated the token"
    );
}

fn fetch_after_the_session_ended(
    end: impl FnOnce(&mut CloudClient),
) -> (Result<Vec<u8>, CloudError>, usize, Option<String>) {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let refreshes = Arc::new(AtomicUsize::new(0));
    let origin = serve({
        let refreshes = refreshes.clone();
        move |request| {
            if request.method == "POST" && refreshes.fetch_add(1, Ordering::SeqCst) == 0 {
                return ok(br#"{"access_token":"access-1","refresh_token":"refresh-1"}"#.to_vec());
            }
            rejected()
        }
    });
    let mut client = CloudClient::new(Server::parse(&origin.address).unwrap()).unwrap();
    client.credential.set_password("refresh-0").unwrap();
    assert!(client.restore().unwrap());
    let fetcher = client.tile_fetcher();
    end(&mut client);
    client.credential.set_password("refresh-2").unwrap();

    let fetched = fetcher.derivative("thumb", "photos:a.dng", None);

    (
        fetched,
        refreshes.load(Ordering::SeqCst),
        client.credential.get_password().ok(),
    )
}

#[test]
fn a_retired_session_never_refreshes_or_signs_out_the_session_that_replaced_it() {
    let (fetched, refreshes, entry) = fetch_after_the_session_ended(|client| client.retire());

    assert!(matches!(fetched, Err(CloudError::Http(401))));
    assert_eq!(refreshes, 1, "only the restore rotated the token");
    assert_eq!(entry.as_deref(), Some("refresh-2"));
}

#[test]
fn a_disconnected_session_never_refreshes_or_signs_out_the_session_that_replaced_it() {
    let (fetched, refreshes, entry) =
        fetch_after_the_session_ended(|client| client.disconnect().unwrap());

    assert!(matches!(fetched, Err(CloudError::Http(401))));
    assert_eq!(refreshes, 1, "only the restore rotated the token");
    assert_eq!(entry.as_deref(), Some("refresh-2"));
}

#[test]
fn connecting_again_retires_the_session_that_a_slow_tile_still_holds() {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let (started_tx, started) = channel();
    let (release, release_rx) = channel::<()>();
    let (started_tx, release_rx) = (Mutex::new(started_tx), Mutex::new(release_rx));
    let refreshes = Arc::new(AtomicUsize::new(0));
    let counted = refreshes.clone();
    let origin = serve(move |request| {
        if request.method == "POST" && request.target.starts_with("/api/auth/refresh") {
            counted.fetch_add(1, Ordering::SeqCst);
            return rejected();
        }
        if let Some(reply) = session_reply(&request) {
            return reply;
        }
        started_tx.lock().unwrap().send(()).unwrap();
        release_rx
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        rejected()
    });
    let worker = Worker::with_tile_cache(eframe::egui::Context::default(), None);
    connect(&worker, &origin);
    assert!(worker.image(0, entry("IMG_1.dng", Some("k1")), false));
    started.recv_timeout(Duration::from_secs(10)).unwrap();

    worker.send(Command::Connect(origin.address.clone()));
    while !matches!(
        worker.events.recv_timeout(Duration::from_secs(10)).unwrap(),
        Event::SignIn(_)
    ) {}
    release.send(()).unwrap();

    loop {
        if let Event::Derivative(_, _, _, tile) =
            worker.events.recv_timeout(Duration::from_secs(10)).unwrap()
        {
            break assert!(tile.is_err());
        }
    }
    assert_eq!(refreshes.load(Ordering::SeqCst), 0);
}
