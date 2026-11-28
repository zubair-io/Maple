use super::{auth::Credentials, bytes, send_authorized, CloudClient, CloudError, Server};
use reqwest::{blocking::Client, Method};
use std::sync::Arc;

pub(super) struct TileFetcher {
    http: Client,
    server: Server,
    credentials: Arc<Credentials>,
}

impl CloudClient {
    pub(super) fn tile_fetcher(&self) -> TileFetcher {
        TileFetcher {
            http: self.http.clone(),
            server: self.server.clone(),
            credentials: self.credentials.clone(),
        }
    }
}

impl TileFetcher {
    pub fn server_url(&self) -> &str {
        self.server.as_str()
    }

    /// `version` is the listing's thumbnail token: it makes a current thumbnail cacheable without revalidation.
    pub fn derivative(
        &self,
        kind: &str,
        address: &str,
        version: Option<&str>,
    ) -> Result<Vec<u8>, CloudError> {
        if !["thumb", "preview"].contains(&kind) {
            return Err(CloudError::Protocol("Invalid derivative kind".into()));
        }
        let mut endpoint = self.server.address(kind, address)?;
        if let Some(version) = version.filter(|version| !version.is_empty()) {
            endpoint.query_pairs_mut().append_pair("v", version);
        }
        let response = send_authorized(
            &self.http,
            &self.server,
            &self.credentials,
            Method::GET,
            endpoint,
            None,
            &[],
        )?;
        // 202 means indexing is still pending, not an image response.
        if response.status().as_u16() == 202 {
            return Err(CloudError::Protocol(
                "Preview is still being indexed; retry shortly".into(),
            ));
        }
        bytes(response, 16 * 1024 * 1024)
    }
}
