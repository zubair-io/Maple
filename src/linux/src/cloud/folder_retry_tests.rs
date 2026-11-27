use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

const LISTING: &str = r#"{"address":"lib:","parent":null,"path":"/photos","folders":[],"images":[{"name":"a.dng","address":"lib:a.dng","path":"/photos/a.dng"}]}"#;

struct Scripted {
    url: Server,
    requests: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: thread::JoinHandle<Vec<String>>,
}

impl Scripted {
    fn start(statuses: Vec<(u16, &'static str)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = Server::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (served, halted) = (requests.clone(), stop.clone());
        let thread = thread::spawn(move || {
            let mut targets = Vec::new();
            while !halted.load(Ordering::SeqCst) {
                let Ok((mut socket, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                };
                socket.set_nonblocking(false).unwrap();
                let mut request = Vec::new();
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let mut chunk = [0; 2048];
                    let length = socket.read(&mut chunk).unwrap();
                    assert!(length > 0);
                    request.extend_from_slice(&chunk[..length]);
                }
                let request = String::from_utf8(request).unwrap();
                targets.push(request.lines().next().unwrap().to_owned());
                let index = served
                    .fetch_add(1, Ordering::SeqCst)
                    .min(statuses.len() - 1);
                let (status, body) = statuses[index];
                write!(
                    socket,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
            targets
        });
        Self {
            url,
            requests,
            stop,
            thread,
        }
    }

    fn finish(self) -> (usize, Vec<String>) {
        self.stop.store(true, Ordering::SeqCst);
        let targets = self.thread.join().unwrap();
        (self.requests.load(Ordering::SeqCst), targets)
    }
}

fn client(url: Server) -> CloudClient {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    CloudClient::new(url).unwrap()
}

const CONFLICT: &str = r#"{"error":"Folder changed while it was being listed; retry."}"#;

#[test]
fn a_conflict_on_the_first_listing_page_is_asked_again_once_and_the_second_answer_is_used() {
    let server = Scripted::start(vec![(409, CONFLICT), (200, LISTING)]);
    let mut client = client(server.url.clone());

    let page = client.folder("lib:", None).unwrap();
    let (requests, targets) = server.finish();

    assert_eq!(page.images[0].name, "a.dng");
    assert_eq!(requests, 2);
    assert_eq!(targets[0], targets[1]);
    assert!(!targets[0].contains("cursor"), "{}", targets[0]);
}

#[test]
fn a_conflict_on_a_page_with_a_cursor_is_reported_without_asking_again() {
    let server = Scripted::start(vec![(409, CONFLICT), (200, LISTING)]);
    let mut client = client(server.url.clone());

    let error = client.folder("lib:", Some("next")).unwrap_err();
    let (requests, targets) = server.finish();

    assert!(matches!(error, CloudError::Http(409)), "{error:?}");
    assert_eq!(requests, 1);
    assert!(targets[0].contains("cursor=next"), "{}", targets[0]);
}

#[test]
fn a_second_conflict_is_reported_as_a_conflict_after_exactly_two_requests() {
    let server = Scripted::start(vec![(409, CONFLICT)]);
    let mut client = client(server.url.clone());

    let error = client.folder("lib:", None).unwrap_err();
    let (requests, _) = server.finish();

    assert!(matches!(error, CloudError::Http(409)), "{error:?}");
    assert_eq!(requests, 2);
}

#[test]
fn other_failures_on_a_listing_are_not_asked_again() {
    for status in [404, 500] {
        let server = Scripted::start(vec![(status, r#"{"error":"x"}"#), (200, LISTING)]);
        let mut client = client(server.url.clone());

        let error = client.folder("lib:", None).unwrap_err();
        let (requests, _) = server.finish();

        assert!(
            matches!(error, CloudError::Http(code) if code == status),
            "{error:?}"
        );
        assert_eq!(requests, 1, "status {status}");
    }
}
