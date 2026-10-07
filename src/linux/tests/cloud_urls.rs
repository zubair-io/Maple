use maple_linux::cloud::{PendingSignIn, Server};

#[test]
fn server_and_address_encoding_preserve_reverse_proxy_prefix_and_reserved_characters() {
    let server = Server::parse("https://photos.example/maple").unwrap();
    assert_eq!(server.as_str(), "https://photos.example/maple/");
    assert_eq!(
        server.address("folder", "travel:").unwrap().as_str(),
        "https://photos.example/maple/api/folder/travel"
    );
    let endpoint = server
        .address("preview", "travel:2026/A & B/#1?.dng")
        .unwrap();
    assert_eq!(endpoint.query(), None);
    assert_eq!(endpoint.fragment(), None);
    assert!(endpoint
        .as_str()
        .ends_with("/travel/2026/A%20&%20B/%231%3F.dng"));
    assert!(server.address("image", "travel:../escape.dng").is_err());
    assert!(server.address("image", ".:file.dng").is_err());
}

#[test]
fn public_http_and_credentials_in_server_urls_are_rejected() {
    for url in [
        "http://photos.example",
        "https://user:password@photos.example",
        "https://photos.example/?token=x",
        "https://photos.example/#x",
        "file:///tmp",
    ] {
        assert!(Server::parse(url).is_err(), "{url}");
    }
    for url in [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://192.168.1.10:3000",
        "https://photos.example",
    ] {
        assert!(Server::parse(url).is_ok(), "{url}");
    }
    assert!(PendingSignIn::new().is_ok());
}

#[test]
fn native_cloud_derivative_decoder_handles_real_avif_bytes() {
    let pixels = vec![96; 8 * 8 * 3];
    let bytes = raw_core::export::encode_avif(8, 8, &pixels, 90).unwrap();
    let decoded = raw_core::raster::decode_raster(&bytes, Some("avif")).unwrap();
    assert_eq!((decoded.width, decoded.height), (8, 8));
    assert_eq!(decoded.to_rgb_bytes().len(), pixels.len());
}
