use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
};

struct Reply {
    path: &'static str,
    status: u16,
    body: String,
}
fn server(replies: Vec<Reply>) -> (super::super::Server, thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url =
        super::super::Server::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let thread = thread::spawn(move || {
        let mut requests = Vec::new();
        for reply in replies {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 2048];
                let length = socket.read(&mut chunk).unwrap();
                assert!(length > 0);
                bytes.extend_from_slice(&chunk[..length]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]);
                    let content = header
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|s| s.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + content {
                        break;
                    }
                }
            }
            let request = String::from_utf8(bytes).unwrap();
            assert!(request.lines().next().unwrap().contains(reply.path));
            requests.push(request);
            write!(socket, "HTTP/1.1 {} Status\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", reply.status, reply.body.len(), reply.body).unwrap();
        }
        requests
    });
    (url, thread)
}

#[test]
fn pkce_uses_rfc_s256_and_never_puts_verifier_in_browser_url() {
    let pending = PendingSignIn {
        verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into(),
        state: "opaque-state".into(),
    };
    assert_eq!(
        pending.challenge(),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    let url = super::super::Server::parse("https://photos.example")
        .unwrap()
        .sign_in(&pending.challenge(), &pending.state);
    assert!(!url.as_str().contains(&pending.verifier));
    assert_eq!(
        url.query_pairs().find(|(key, _)| key == "state").unwrap().1,
        "opaque-state"
    );
    let first = PendingSignIn::new().unwrap();
    let second = PendingSignIn::new().unwrap();
    assert_eq!(first.verifier.len(), 64);
    assert_eq!(first.state.len(), 32);
    assert_ne!(first.verifier, second.verifier);
}

#[test]
fn refresh_retains_transient_credentials_rotates_and_retries_bearer_once() {
    // Authentication storage can be mocked; sidecar tests always use real files.
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let replies = vec![
        Reply {
            path: "/api/health",
            status: 200,
            body: r#"{"ok":true,"product":"maple","db_connected":true}"#.into(),
        },
        Reply {
            path: "/api/auth/refresh",
            status: 503,
            body: "{}".into(),
        },
        Reply {
            path: "/api/auth/refresh",
            status: 200,
            body: r#"{"access_token":"access-1","refresh_token":"refresh-2"}"#.into(),
        },
        Reply {
            path: "/api/folders",
            status: 401,
            body: "{}".into(),
        },
        Reply {
            path: "/api/auth/refresh",
            status: 200,
            body: r#"{"access_token":"access-2","refresh_token":"refresh-3"}"#.into(),
        },
        Reply {
            path: "/api/folders",
            status: 200,
            body: r#"[{"id":"library-1","slug":"photos","path":"/photos","label":"Photographs"}]"#
                .into(),
        },
        Reply {
            path: "/api/auth/refresh",
            status: 401,
            body: "{}".into(),
        },
    ];
    let (url, server) = server(replies);
    let mut client = CloudClient::new(url).unwrap();
    client.probe().unwrap();
    client.credential.set_password("refresh-1").unwrap();
    assert!(matches!(client.restore(), Err(CloudError::Http(503))));
    assert_eq!(client.credential.get_password().unwrap(), "refresh-1");
    assert!(client.restore().unwrap());
    assert_eq!(client.credential.get_password().unwrap(), "refresh-2");
    assert_eq!(client.libraries().unwrap()[0].slug, "photos");
    assert_eq!(client.credential.get_password().unwrap(), "refresh-3");
    assert!(matches!(
        client.refresh_session(),
        Err(CloudError::Http(401))
    ));
    assert!(matches!(
        client.credential.get_password(),
        Err(keyring::Error::NoEntry)
    ));
    let requests = server.join().unwrap();
    assert!(requests[3]
        .to_ascii_lowercase()
        .contains("authorization: bearer access-1"));
    assert!(requests[5]
        .to_ascii_lowercase()
        .contains("authorization: bearer access-2"));
    assert!(requests[4].contains("refresh-2"));
}

#[test]
fn native_claim_checks_state_and_securely_persists_its_device_token() {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let (url, server) = server(vec![
        Reply { path: "/api/auth/native-code/claim", status: 404, body: "{}".into() },
        Reply { path: "/api/auth/native-code/claim", status: 200, body: r#"{"access_token":"wrong","refresh_token":"wrong","state":"different-state"}"#.into() },
        Reply { path: "/api/auth/native-code/claim", status: 200, body: r#"{"access_token":"access-device","refresh_token":"refresh-device","state":"expected-state"}"#.into() },
    ]);
    let mut client = CloudClient::new(url).unwrap();
    let pending = PendingSignIn {
        verifier: "a".repeat(64),
        state: "expected-state".into(),
    };
    assert!(!client.claim(&pending).unwrap());
    assert!(client.claim(&pending).is_err());
    assert!(client.access.is_none());
    assert!(matches!(
        client.credential.get_password(),
        Err(keyring::Error::NoEntry)
    ));
    assert!(client.claim(&pending).unwrap());
    assert_eq!(client.credential.get_password().unwrap(), "refresh-device");
    let requests = server.join().unwrap();
    assert!(requests
        .iter()
        .all(|request| request.contains("expected-state") && request.contains(&pending.verifier)));
}
