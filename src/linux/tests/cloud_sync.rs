//! Cloud edit synchronization against a scripted Maple server.
use maple_linux::{
    cloud::{
        resume_pending, CloudClient, CloudEntry, DownloadedPhoto, EditJournal, RemoteXmp, Server,
    },
    controls::Control,
    sidecar::{SidecarDocument, SidecarStore},
};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    thread,
};

type Reply = Option<(u16, Vec<(&'static str, String)>, String)>;
type Handler = Box<dyn FnOnce(&str, &str) -> Reply + Send>;

const BASELINE: &str = "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n    <rdf:Description rdf:about=\"\"\n      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"\n      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"\n      crs:Exposure2012=\"0.25\"/>\n  </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>\n";
const FIXTURE: &[u8] =
    include_bytes!("../../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");

fn serve(handlers: Vec<Handler>) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let thread = thread::spawn(move || {
        for handler in handlers {
            let (mut socket, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            let (head, body) = loop {
                let mut chunk = [0; 4096];
                let length = socket.read(&mut chunk).unwrap();
                assert!(length > 0);
                bytes.extend_from_slice(&chunk[..length]);
                let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
                    continue;
                };
                let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
                let content = head
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|value| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + content {
                    break (
                        head,
                        String::from_utf8(bytes[end + 4..end + 4 + content].to_vec()).unwrap(),
                    );
                }
            };
            let Some((status, headers, reply)) = handler(&head.to_ascii_lowercase(), &body) else {
                continue;
            };
            let extra: String = headers
                .iter()
                .map(|(name, value)| format!("{name}: {value}\r\n"))
                .collect();
            write!(
                socket,
                "HTTP/1.1 {status} Status\r\nContent-Type: application/xml\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            )
            .unwrap();
        }
    });
    (url, thread)
}

fn versioned(etag: &str) -> Vec<(&'static str, String)> {
    vec![
        ("ETag", format!("\"{etag}\"")),
        ("X-Maple-Xmp-Preconditions", "content-etag-v1".into()),
    ]
}

fn client(url: &str) -> CloudClient {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    CloudClient::new(Server::parse(url).unwrap()).unwrap()
}

fn entry() -> CloudEntry {
    CloudEntry {
        name: "photo.dng".into(),
        address: "library:photo.dng".into(),
        path: "/library/photo.dng".into(),
        ext: "dng".into(),
        id: None,
        size: FIXTURE.len() as u64,
        mtime: "2026-10-06T00:00:00Z".into(),
        is_video: false,
        is_audio: false,
        is_stub: false,
    }
}

/// A journal whose local edit (exposure 1.0) has not reached the server.
fn pending_edit(base: &Path, server: &str) -> (EditJournal, SidecarDocument) {
    let download = tempfile::tempdir().unwrap();
    let path = download.path().join("photo.dng");
    fs::write(&path, FIXTURE).unwrap();
    let mut journal = EditJournal::open(base, server, &entry()).unwrap();
    journal
        .prepare(
            server,
            &entry(),
            DownloadedPhoto {
                document: SidecarDocument::parse(BASELINE).unwrap(),
                baseline: RemoteXmp {
                    xml: Some(BASELINE.into()),
                    etag: Some("\"e1\"".into()),
                    supports_preconditions: true,
                },
                directory: download,
                path,
            },
        )
        .unwrap();
    let (mut store, mut document) = SidecarStore::open(&journal.path().unwrap()).unwrap();
    Control::Exposure.set(&mut document.model, 1.0).unwrap();
    store.save(&document).unwrap();
    assert!(journal.pending().unwrap());
    (journal, document)
}

fn conditional_save(expected: &'static str, etag: &'static str) -> Handler {
    Box::new(move |head, body| {
        assert!(head.starts_with("post "), "{head}");
        Some(if head.contains(&format!("if-match: \"{expected}\"")) {
            (200, versioned(etag), body.to_owned())
        } else {
            (412, Vec::new(), String::new())
        })
    })
}

#[test]
fn a_lost_response_whose_attempt_the_server_stored_with_its_own_records_is_not_a_conflict() {
    let base = tempfile::tempdir().unwrap();
    let probe = tempfile::tempdir().unwrap();
    let attempt = pending_edit(probe.path(), "https://photos.example/")
        .1
        .serialize()
        .unwrap();
    let stored = attempt.replacen(
        "rdf:about=\"\"",
        "rdf:about=\"\" xmlns:wf=\"urn:maple-workflow\" wf:Retained=\"history\"",
        1,
    );
    let lost: Handler = Box::new(|head, _| {
        assert!(head.starts_with("post "), "{head}");
        None
    });
    let reread: Handler = Box::new(move |head, _| {
        assert!(head.starts_with("get "), "{head}");
        Some((200, versioned("e2"), stored))
    });
    let (url, server) = serve(vec![lost, reread, conditional_save("e2", "e3")]);
    let mut connection = client(&url);
    let (mut journal, document) = pending_edit(base.path(), connection.server_url());
    assert!(journal.synchronize(&mut connection, &document).is_err());
    journal
        .synchronize(&mut connection, &document)
        .expect("the stored attempt becomes the baseline instead of a conflict");
    server.join().unwrap();
    assert!(!journal.pending().unwrap());
}

#[test]
fn edits_left_pending_by_a_quit_are_synchronized_on_the_next_connection() {
    let base = tempfile::tempdir().unwrap();
    let (url, server) = serve(vec![
        libraries(),
        metadata(false),
        conditional_save("e1", "e2"),
    ]);
    let mut connection = client(&url);
    drop(pending_edit(base.path(), connection.server_url()));
    let resumed = resume_pending(base.path(), &mut connection).unwrap();
    server.join().unwrap();
    assert_eq!(resumed.synchronized, ["photo.dng"]);
    assert!(resumed.unsynchronized.is_empty());
    let reopened = EditJournal::open(base.path(), connection.server_url(), &entry()).unwrap();
    assert!(!reopened.pending().unwrap());
    let (url, server) = serve(Vec::new());
    assert!(resume_pending(base.path(), &mut client(&url))
        .unwrap()
        .synchronized
        .is_empty());
    server.join().unwrap();
}

#[test]
fn an_edit_that_cannot_be_resumed_stays_pending_without_blocking_other_photos() {
    let base = tempfile::tempdir().unwrap();
    let (url, server) = serve(vec![
        libraries(),
        metadata(false),
        conditional_save("someone-else", "e2"),
        Box::new(|head, _| {
            assert!(head.starts_with("get /api/xmp?"), "{head}");
            Some((404, versioned("e2"), String::new()))
        }),
        Box::new(|head, _| {
            assert!(head.starts_with("get /api/xmp?"), "{head}");
            Some((200, versioned("e2"), BASELINE.into()))
        }),
    ]);
    let mut connection = client(&url);
    drop(pending_edit(base.path(), connection.server_url()));
    let resumed = resume_pending(base.path(), &mut connection).unwrap();
    assert!(resumed.synchronized.is_empty());
    assert_eq!(resumed.unsynchronized.len(), 1);
    assert!(resumed.unsynchronized[0].starts_with("photo.dng: "));
    let mut reopened = EditJournal::open(base.path(), connection.server_url(), &entry()).unwrap();
    assert!(reopened.pending().unwrap());
    let other = CloudEntry {
        address: "library:other.dng".into(),
        ..entry()
    };
    assert!(EditJournal::open(base.path(), connection.server_url(), &other).is_ok());
    reopened.reload(&mut connection).unwrap();
    server.join().unwrap();
    assert!(!reopened.pending().unwrap());
    assert_eq!(
        SidecarStore::open(&reopened.path().unwrap())
            .unwrap()
            .1
            .model
            .exposure,
        0.25
    );
    assert_eq!(fs::read(reopened.path().unwrap()).unwrap(), FIXTURE);
}

fn libraries() -> Handler {
    Box::new(|head, _| {
        assert!(head.starts_with("get /api/folders "), "{head}");
        Some((
            200,
            vec![],
            r#"[{"id":"library-id","slug":"library","path":"/library"}]"#.into(),
        ))
    })
}

fn metadata(changed: bool) -> Handler {
    Box::new(move |head, _| {
        assert!(
            head.starts_with("get /api/folders/library-id/file-meta?path=photo.dng "),
            "{head}"
        );
        let mut remote = entry();
        if changed {
            remote.size += 1;
        }
        Some((200, vec![], serde_json::to_string(&remote).unwrap()))
    })
}

#[test]
fn startup_never_pushes_pending_edits_onto_a_replaced_original() {
    let base = tempfile::tempdir().unwrap();
    let (url, server) = serve(vec![libraries(), metadata(true)]);
    let mut connection = client(&url);
    let (journal, _) = pending_edit(base.path(), connection.server_url());
    let path = journal.path().unwrap();
    let xml = fs::read(path.with_extension("xmp")).unwrap();
    let record = fs::read(journal.directory().join("remote.json")).unwrap();
    let directory = journal.directory().to_owned();
    drop(journal);
    let resumed = resume_pending(base.path(), &mut connection).unwrap();
    server.join().unwrap();
    assert!(resumed.synchronized.is_empty());
    assert_eq!(resumed.unsynchronized.len(), 1);
    assert!(resumed.unsynchronized[0].contains("remote original changed"));
    assert_eq!(fs::read(path.with_extension("xmp")).unwrap(), xml);
    assert_eq!(fs::read(directory.join("remote.json")).unwrap(), record);
}

fn remote_read(xml: String, etag: &'static str) -> Handler {
    Box::new(move |head, _| {
        assert!(head.starts_with("get /api/xmp?"), "{head}");
        Some((200, versioned(etag), xml))
    })
}

fn remote_vibrance() -> String {
    BASELINE.replace(
        "crs:Exposure2012=\"0.25\"/>",
        "crs:Exposure2012=\"0.25\" crs:Vibrance=\"25\"/>",
    )
}

#[test]
fn a_stale_upload_merges_the_server_change_and_retries_against_its_version() {
    let base = tempfile::tempdir().unwrap();
    let (sent, uploaded) = std::sync::mpsc::channel();
    let (url, server) = serve(vec![
        conditional_save("someone-else", "e2"),
        remote_read(remote_vibrance(), "e2"),
        Box::new(move |head, body| {
            assert!(head.contains("if-match: \"e2\""), "{head}");
            sent.send(body.to_owned()).unwrap();
            Some((200, versioned("e3"), body.to_owned()))
        }),
    ]);
    let mut connection = client(&url);
    let (mut journal, document) = pending_edit(base.path(), connection.server_url());
    let merged = journal
        .synchronize(&mut connection, &document)
        .unwrap()
        .expect("a changed server XMP is merged, not refused")
        .document;
    server.join().unwrap();
    let body = uploaded.recv().unwrap();
    let stored = SidecarDocument::parse(&body).unwrap();
    assert_eq!((stored.model.exposure, stored.model.vibrance), (1.0, 25.0));
    let record = raw_core::workflow::SidecarWorkflow::from_xmp(&body)
        .unwrap()
        .expect("the server's state is recorded");
    assert_eq!(record.history.last().unwrap().action, "external");
    let local = journal.path().unwrap().with_extension("xmp");
    assert_eq!(fs::read_to_string(local).unwrap(), body);
    assert_eq!(merged.serialize().unwrap(), body);
    assert!(!journal.pending().unwrap());
    assert_eq!(fs::read(journal.path().unwrap()).unwrap(), FIXTURE);
}

#[test]
fn a_newer_local_save_supersedes_the_merge_and_a_moving_server_is_bounded() {
    let base = tempfile::tempdir().unwrap();
    let local = std::sync::Arc::new(std::sync::Mutex::new(None::<std::path::PathBuf>));
    let writer = local.clone();
    let (url, server) = serve(vec![
        conditional_save("someone-else", "e2"),
        Box::new(move |head, _| {
            assert!(head.starts_with("get /api/xmp?"), "{head}");
            let path = writer.lock().unwrap().clone().unwrap();
            let (mut store, mut newer) = SidecarStore::open(&path).unwrap();
            Control::Contrast.set(&mut newer.model, 40.0).unwrap();
            store.save(&newer).unwrap();
            Some((200, versioned("e2"), remote_vibrance()))
        }),
    ]);
    let mut connection = client(&url);
    let (mut journal, document) = pending_edit(base.path(), connection.server_url());
    let original = journal.path().unwrap();
    *local.lock().unwrap() = Some(original.clone());
    let newer_local = || SidecarStore::open(&original).unwrap().1;
    assert!(journal
        .synchronize(&mut connection, &document)
        .unwrap()
        .is_none());
    server.join().unwrap();
    assert_eq!(newer_local().model.contrast, 40.0, "the newer save is kept");
    assert!(journal.pending().unwrap());

    let mut moving = Vec::<Handler>::new();
    for etag in ["e3", "e4", "e5"] {
        moving.push(conditional_save("someone-else", "never"));
        moving.push(remote_read(remote_vibrance(), etag));
    }
    let (url, server) = serve(moving);
    let mut connection = client(&url);
    let document = newer_local();
    assert!(journal.synchronize(&mut connection, &document).is_err());
    server.join().unwrap();
    assert!(journal.pending().unwrap());
}
