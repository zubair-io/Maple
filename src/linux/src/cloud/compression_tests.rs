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
