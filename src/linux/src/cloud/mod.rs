//! Linux client for Maple's existing native-auth and unified library APIs.
mod auth;
mod journal;
mod library;
mod transfer;
pub use journal::EditJournal;
mod url;
pub use auth::PendingSignIn;
pub use library::{CloudEntry, CloudFolder, CloudLibrary, CloudSidecar};
pub use transfer::{DownloadedPhoto, RemoteXmp};
pub use url::Server;

use reqwest::{
    blocking::{Client, Response},
    Method, StatusCode,
};
use serde::de::DeserializeOwned;
use std::{io::Read, time::Duration};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CloudError {
    #[error("{0}")]
    Protocol(String),
    #[error("Server returned HTTP {0}")]
    Http(u16),
    #[error("The server XMP changed. Reload it before saving; your local edits are retained.")]
    Conflict,
    #[error("Network request failed: {0}")]
    Network(#[from] reqwest::Error),
    #[error("Secure credential storage failed: {0}")]
    Credential(#[from] keyring::Error),
    #[error("Download failed: {0}")]
    Io(#[from] std::io::Error),
}

pub struct CloudClient {
    server: Server,
    http: Client,
    credential: keyring::Entry,
    access: Option<String>,
    refresh: Option<String>,
}

impl CloudClient {
    pub fn new(server: Server) -> Result<Self, CloudError> {
        let credential = keyring::Entry::new("app.justmaple.aperture.linux", server.as_str())?;
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent("Maple-Linux/0.1")
            .build()?;
        Ok(Self {
            server,
            http,
            credential,
            access: None,
            refresh: None,
        })
    }

    pub fn server_url(&self) -> &str {
        self.server.as_str()
    }

    pub fn probe(&self) -> Result<(), CloudError> {
        #[derive(serde::Deserialize)]
        struct Health {
            ok: bool,
            product: String,
            db_connected: bool,
        }
        let response = self.http.get(self.server.endpoint("api/health")?).send()?;
        let health: Health = json(response)?;
        if !health.ok || health.product != "maple" || !health.db_connected {
            return Err(CloudError::Protocol(
                "This is not a healthy Maple server".into(),
            ));
        }
        Ok(())
    }

    fn request(
        &mut self,
        method: Method,
        endpoint: reqwest::Url,
        body: Option<&str>,
        headers: &[(&str, String)],
    ) -> Result<Response, CloudError> {
        for attempt in 0..2 {
            let mut request = self.http.request(method.clone(), endpoint.clone());
            if let Some(access) = &self.access {
                request = request.bearer_auth(access);
            }
            if let Some(body) = body {
                request = request
                    .header("Content-Type", "application/xml")
                    .body(body.to_owned());
            }
            for (key, value) in headers {
                request = request.header(*key, value);
            }
            let response = request.send()?;
            if response.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
                self.refresh_session()?;
                continue;
            }
            return Ok(response);
        }
        Err(CloudError::Http(401))
    }
}

fn bytes(mut response: Response, limit: u64) -> Result<Vec<u8>, CloudError> {
    if !response.status().is_success() {
        return Err(CloudError::Http(response.status().as_u16()));
    }
    let mut bytes = Vec::new();
    response.by_ref().take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(CloudError::Protocol(
            "Server response exceeds its size limit".into(),
        ));
    }
    Ok(bytes)
}

fn json<T: DeserializeOwned>(response: Response) -> Result<T, CloudError> {
    serde_json::from_slice(&bytes(response, 4 * 1024 * 1024)?)
        .map_err(|e| CloudError::Protocol(format!("Invalid server response: {e}")))
}

pub mod worker;
