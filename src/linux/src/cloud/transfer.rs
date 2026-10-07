//! Complete transfer primitives for the cloud edit transaction (#4317).
use super::{bytes, CloudClient, CloudEntry, CloudError};
use crate::sidecar::{sidecar_path, SidecarDocument};
use reqwest::Method;
use std::{
    io::{Read, Write},
    path::PathBuf,
};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct RemoteXmp {
    pub xml: Option<String>,
    pub etag: Option<String>,
    pub supports_preconditions: bool,
}

/// Owns the private downloaded original until the editing session releases it.
pub struct DownloadedPhoto {
    pub directory: tempfile::TempDir,
    pub path: PathBuf,
    pub document: SidecarDocument,
    pub baseline: RemoteXmp,
}

impl CloudClient {
    pub fn read_versioned_xmp(&mut self, path: &str) -> Result<RemoteXmp, CloudError> {
        let endpoint = self.server.xmp(path)?;
        let response = self.request(Method::GET, endpoint, None, &[])?;
        let supports_preconditions = response
            .headers()
            .get("X-Maple-Xmp-Preconditions")
            .and_then(|h| h.to_str().ok())
            == Some("content-etag-v1");
        let etag = response
            .headers()
            .get("ETag")
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        let xml = if response.status().as_u16() == 404 {
            None
        } else {
            Some(
                String::from_utf8(bytes(response, 4 * 1024 * 1024)?)
                    .map_err(|_| CloudError::Protocol("XMP is not UTF-8".into()))?,
            )
        };
        Ok(RemoteXmp {
            xml,
            etag,
            supports_preconditions,
        })
    }

    pub fn save_versioned_xmp(
        &mut self,
        path: &str,
        document: &SidecarDocument,
        baseline: &RemoteXmp,
    ) -> Result<RemoteXmp, CloudError> {
        if !baseline.supports_preconditions || (baseline.xml.is_some() && baseline.etag.is_none()) {
            return Err(CloudError::Protocol(
                "Upgrade the Maple server to support conditional XMP writes before cloud editing."
                    .into(),
            ));
        }
        let xml = document
            .serialize()
            .map_err(|e| CloudError::Protocol(e.to_string()))?;
        let precondition = if baseline.xml.is_some() {
            ("If-Match", baseline.etag.clone().expect("checked ETag"))
        } else {
            ("If-None-Match", "*".into())
        };
        let response = self.request(
            Method::POST,
            self.server.xmp(path)?,
            Some(&xml),
            &[precondition],
        )?;
        if response.status().as_u16() == 412 {
            return Err(CloudError::Conflict);
        }
        if !response.status().is_success() {
            return Err(CloudError::Http(response.status().as_u16()));
        }
        let etag = response
            .headers()
            .get("ETag")
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| {
                CloudError::Protocol(
                    "Server omitted the saved XMP version; reload before retrying.".into(),
                )
            })?;
        let xml = String::from_utf8(bytes(response, 4 * 1024 * 1024)?)
            .map_err(|_| CloudError::Protocol("Saved XMP is not UTF-8".into()))?;
        SidecarDocument::parse(&xml).map_err(|e| CloudError::Protocol(e.to_string()))?;
        Ok(RemoteXmp {
            xml: Some(xml),
            etag: Some(etag),
            supports_preconditions: true,
        })
    }

    pub fn download_for_edit(&mut self, entry: &CloudEntry) -> Result<DownloadedPhoto, CloudError> {
        if entry.is_video
            || entry.is_audio
            || entry.is_stub
            || entry.name.contains(['/', '\\'])
            || entry.name == "."
            || entry.name == ".."
            || entry.name.is_empty()
        {
            return Err(CloudError::Protocol(
                "This entry is not a supported photograph".into(),
            ));
        }
        let baseline = self.read_versioned_xmp(&entry.path)?;
        if !baseline.supports_preconditions || (baseline.xml.is_some() && baseline.etag.is_none()) {
            return Err(CloudError::Protocol(
                "The server must support content-precondition XMP saves before cloud editing."
                    .into(),
            ));
        }
        let document = match &baseline.xml {
            Some(xml) => {
                SidecarDocument::parse(xml).map_err(|e| CloudError::Protocol(e.to_string()))?
            }
            None => SidecarDocument::default(),
        };
        let directory = tempfile::Builder::new()
            .prefix("maple-cloud-edit-")
            .tempdir()?;
        let path = directory.path().join(&entry.name);
        let mut response = self.request(
            Method::GET,
            self.server.address("image", &entry.address)?,
            None,
            &[],
        )?;
        if response.status().as_u16() != 200 {
            return Err(CloudError::Http(response.status().as_u16()));
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        let max_size = 2 * 1024 * 1024 * 1024;
        let size = std::io::copy(&mut response.by_ref().take(max_size + 1), &mut file)?;
        if size > max_size || (entry.size > 0 && size != entry.size) {
            return Err(CloudError::Protocol(
                "Original download is truncated, changed, or exceeds the 2 GiB limit".into(),
            ));
        }
        file.sync_all()?;
        if let Some(xml) = &baseline.xml {
            let sidecar = sidecar_path(&path).map_err(|e| CloudError::Protocol(e.to_string()))?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(sidecar)?;
            file.write_all(xml.as_bytes())?;
            file.sync_all()?;
        }
        Ok(DownloadedPhoto {
            directory,
            path,
            document,
            baseline,
        })
    }
}
