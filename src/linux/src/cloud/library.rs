use super::{bytes, json, CloudClient, CloudError};
use reqwest::{Method, StatusCode};
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
pub struct CloudLibrary {
    pub id: String,
    pub slug: String,
    pub path: String,
    pub label: Option<String>,
}
#[derive(Clone, Debug, Deserialize, serde::Serialize)]
pub struct CloudEntry {
    pub name: String,
    pub address: String,
    pub path: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub ext: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub mtime: String,
    #[serde(rename = "isVideo", default)]
    pub is_video: bool,
    #[serde(rename = "isStub", default)]
    pub is_stub: bool,
    #[serde(rename = "isAudio", default)]
    pub is_audio: bool,
    /// The server's name for this file's current thumbnail; absent while that thumbnail is stale or not yet made.
    #[serde(
        rename = "thumbVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub thumb_version: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct CloudSidecar {
    pub path: String,
    pub mtime: String,
    pub asset_id: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct CloudFolder {
    pub address: String,
    pub parent: Option<String>,
    pub path: String,
    pub folders: Vec<CloudEntry>,
    pub images: Vec<CloudEntry>,
    #[serde(default)]
    pub sidecars: Vec<CloudSidecar>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}
impl CloudClient {
    pub fn libraries(&mut self) -> Result<Vec<CloudLibrary>, CloudError> {
        let endpoint = self.server.endpoint("api/folders")?;
        json(self.request(Method::GET, endpoint, None, &[])?)
    }
    pub fn folder(
        &mut self,
        address: &str,
        cursor: Option<&str>,
    ) -> Result<CloudFolder, CloudError> {
        let mut endpoint = self.server.address("folder", address)?;
        endpoint.query_pairs_mut().append_pair("limit", "500");
        if let Some(cursor) = cursor {
            endpoint.query_pairs_mut().append_pair("cursor", cursor);
        }
        let response = self.request(Method::GET, endpoint.clone(), None, &[])?;
        // First page only: a retried later page could join two different folders.
        let response = if cursor.is_none() && response.status() == StatusCode::CONFLICT {
            drop(response);
            self.request(Method::GET, endpoint, None, &[])?
        } else {
            response
        };
        json(response)
    }
    pub fn stat_entry(&mut self, entry: &CloudEntry) -> Result<CloudEntry, CloudError> {
        #[derive(Deserialize)]
        struct Metadata {
            size: u64,
            mtime: String,
        }
        let (slug, path) = entry
            .address
            .split_once(':')
            .ok_or_else(|| CloudError::Protocol("Missing library address".into()))?;
        let library = self
            .libraries()?
            .into_iter()
            .find(|library| library.slug == slug)
            .ok_or_else(|| CloudError::Protocol("Cloud library no longer exists".into()))?;
        let mut endpoint = self.server.endpoint("api/folders")?;
        endpoint
            .path_segments_mut()
            .map_err(|_| CloudError::Protocol("Invalid server URL".into()))?
            .push(&library.id)
            .push("file-meta");
        endpoint.query_pairs_mut().append_pair("path", path);
        let metadata: Metadata = json(self.request(Method::GET, endpoint, None, &[])?)?;
        Ok(CloudEntry {
            size: metadata.size,
            mtime: metadata.mtime,
            ..entry.clone()
        })
    }
    pub fn read_xmp(&mut self, path: &str) -> Result<Option<String>, CloudError> {
        let endpoint = self.server.xmp(path)?;
        let response = self.request(Method::GET, endpoint, None, &[])?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        String::from_utf8(bytes(response, 4 * 1024 * 1024)?)
            .map(Some)
            .map_err(|_| CloudError::Protocol("XMP response is not UTF-8".into()))
    }
}
