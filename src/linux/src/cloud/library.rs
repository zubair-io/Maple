use super::{bytes, json, CloudClient, CloudError};
use reqwest::Method;
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
        json(self.request(Method::GET, endpoint, None, &[])?)
    }
    pub fn derivative(&mut self, kind: &str, address: &str) -> Result<Vec<u8>, CloudError> {
        if !["thumb", "preview"].contains(&kind) {
            return Err(CloudError::Protocol("Invalid derivative kind".into()));
        }
        let endpoint = self.server.address(kind, address)?;
        let response = self.request(Method::GET, endpoint, None, &[])?;
        // 202 means indexing is still pending, not an image response.
        if response.status().as_u16() == 202 {
            return Err(CloudError::Protocol(
                "Preview is still being indexed; retry shortly".into(),
            ));
        }
        bytes(response, 16 * 1024 * 1024)
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
