use super::*;
use flate2::{write::GzEncoder, Compression};
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
};

#[test]
fn compressed_listings_are_requested_and_decoded() {
    let listing = format!(
        "[{}]",
        (0..200)
            .map(|index| format!(
                r#"{{"id":"library-{index}","slug":"slug-{index}","path":"/photos/{index}","label":null}}"#
            ))
            .collect::<Vec<_>>()
            .join(",")
    );
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(listing.as_bytes()).unwrap();
    let compressed = encoder.finish().unwrap();
    assert!(compressed.len() < listing.len() / 3);

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Server::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = Vec::new();
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let mut chunk = [0; 2048];
            let length = socket.read(&mut chunk).unwrap();
            assert!(length > 0);
            request.extend_from_slice(&chunk[..length]);
        }
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            compressed.len()
        )
        .unwrap();
        socket.write_all(&compressed).unwrap();
        String::from_utf8(request).unwrap().to_ascii_lowercase()
    });

    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let mut client = CloudClient::new(url).unwrap();
    let libraries = client.libraries().unwrap();
    let request = server.join().unwrap();

    assert_eq!(libraries.len(), 200);
    assert_eq!(libraries[199].slug, "slug-199");
    let accepted = request
        .lines()
        .find_map(|line| line.strip_prefix("accept-encoding:"))
        .expect("the client sends Accept-Encoding");
    assert!(
        accepted.contains("gzip") && accepted.contains("br"),
        "{accepted}"
    );
}

fn read_request(socket: &mut std::net::TcpStream) -> String {
    let mut request = Vec::new();
    let body_start = loop {
        if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break end + 4;
        }
        let mut chunk = [0; 2048];
        let length = socket.read(&mut chunk).unwrap();
        assert!(length > 0);
        request.extend_from_slice(&chunk[..length]);
    };
    let head = String::from_utf8(request[..body_start].to_vec()).unwrap();
    let body_length = header(&head, "content-length").map_or(0, |length| length.parse().unwrap());
    while request.len() < body_start + body_length {
        let mut chunk = [0; 2048];
        let length = socket.read(&mut chunk).unwrap();
        assert!(length > 0);
        request.extend_from_slice(&chunk[..length]);
    }
    head
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn respond_gzipped(socket: &mut std::net::TcpStream, weak_tag: &str, xml: &str) {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(xml.as_bytes()).unwrap();
    let compressed = encoder.finish().unwrap();
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Encoding: gzip\r\nETag: {weak_tag}\r\nX-Maple-Xmp-Preconditions: content-etag-v1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        compressed.len()
    )
    .unwrap();
    socket.write_all(&compressed).unwrap();
}

#[test]
fn a_sidecar_tag_weakened_by_a_compressing_proxy_is_sent_back_strong() {
    let document = crate::sidecar::SidecarDocument::default();
    let xml = document.serialize().unwrap();
    let read_tag = format!("\"{}\"", "a1".repeat(20));
    let saved_tag = format!("\"{}\"", "b2".repeat(20));

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Server::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let (served_xml, served_read, served_saved) =
        (xml.clone(), read_tag.clone(), saved_tag.clone());
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        read_request(&mut socket);
        respond_gzipped(&mut socket, &format!("W/{served_read}"), &served_xml);
        let (mut socket, _) = listener.accept().unwrap();
        let save = read_request(&mut socket);
        respond_gzipped(&mut socket, &format!("W/{served_saved}"), &served_xml);
        save
    });

    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let mut client = CloudClient::new(url).unwrap();
    let remote = client.read_versioned_xmp("photos/a.dng").unwrap();
    assert_eq!(remote.xml.as_deref(), Some(xml.as_str()));
    assert!(remote.supports_preconditions);
    assert_eq!(remote.etag.as_deref(), Some(read_tag.as_str()));

    let saved = client
        .save_versioned_xmp("photos/a.dng", &document, &remote)
        .unwrap();
    let save = server.join().unwrap();
    let precondition = header(&save, "if-match").expect("the save is conditional");
    assert_eq!(precondition, read_tag);
    assert_eq!(saved.etag, Some(saved_tag));
}
