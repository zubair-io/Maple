//! Durable pending cloud edits. Credentials never enter this journal (#4317).
use super::{CloudClient, CloudEntry, CloudError, DownloadedPhoto, RemoteXmp};
use crate::sidecar::{sidecar_path, SidecarDocument};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

#[derive(serde::Serialize, serde::Deserialize)]
struct Record {
    server: String,
    entry: CloudEntry,
    baseline: RemoteXmp,
    acknowledged_local: Option<String>,
    attempt: Option<String>,
}

pub struct EditJournal {
    directory: PathBuf,
    lock: fs::File,
    record: Option<Record>,
}
impl EditJournal {
    pub fn open(base: &Path, server: &str, entry: &CloudEntry) -> Result<Self, CloudError> {
        let key = Sha256::digest(format!("{server}\0{}", entry.address).as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let directory = base.join(key);
        fs::create_dir_all(&directory)?;
        let metadata = fs::symlink_metadata(&directory)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(CloudError::Protocol(
                "Cloud edit journal must be a real directory".into(),
            ));
        }
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        let lock_path = directory.join(".lock");
        reject_symlink(&lock_path)?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        lock.try_lock().map_err(|_| {
            CloudError::Protocol(
                "This photograph's pending edits are open in another Maple process".into(),
            )
        })?;
        let record_path = directory.join("remote.json");
        reject_symlink(&record_path)?;
        let record: Option<Record> =
            match fs::File::open(record_path) {
                Ok(file) => {
                    let mut bytes = Vec::new();
                    file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
                    if bytes.len() > 16 * 1024 * 1024 {
                        return Err(CloudError::Protocol("Cloud journal is too large".into()));
                    }
                    Some(serde_json::from_slice(&bytes).map_err(|e| {
                        CloudError::Protocol(format!("Cloud journal is invalid: {e}"))
                    })?)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
        let journal = Self {
            directory,
            lock,
            record,
        };
        if let Some(record) = &journal.record {
            if record.server != server || record.entry.address != entry.address {
                return Err(CloudError::Protocol(
                    "Cloud journal identity did not match the requested photograph".into(),
                ));
            }
            if journal.pending()?
                && (record.entry.mtime != entry.mtime || record.entry.size != entry.size)
            {
                return Err(CloudError::Protocol(format!(
                    "The remote original changed. Pending edits are preserved at {}",
                    journal.directory.display()
                )));
            }
        }
        Ok(journal)
    }
    pub fn path(&self) -> Result<PathBuf, CloudError> {
        let record = self
            .record
            .as_ref()
            .ok_or_else(|| CloudError::Protocol("Cloud journal has no photograph".into()))?;
        original_path(&self.directory, &record.entry)
    }
    pub fn pending(&self) -> Result<bool, CloudError> {
        let Some(record) = &self.record else {
            return Ok(false);
        };
        let path = self.path()?;
        reject_symlink(&path)?;
        if !path.is_file() {
            return Err(CloudError::Protocol(
                "Pending cloud original is missing".into(),
            ));
        }
        let sidecar = sidecar_path(&path).map_err(|e| CloudError::Protocol(e.to_string()))?;
        reject_symlink(&sidecar)?;
        let xml = match fs::read_to_string(sidecar) {
            Ok(xml) => Some(xml),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        Ok(xml != record.acknowledged_local)
    }
    pub fn prepare(
        &mut self,
        server: &str,
        entry: &CloudEntry,
        download: DownloadedPhoto,
    ) -> Result<(), CloudError> {
        if self.pending()? {
            return Err(CloudError::Protocol(
                "Pending cloud edits must be synchronized or explicitly reloaded first".into(),
            ));
        }
        let path = original_path(&self.directory, entry)?;
        reject_symlink(&path)?;
        let mut source = fs::File::open(&download.path)?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)?;
        std::io::copy(&mut source, temporary.as_file_mut())?;
        temporary.as_file().sync_all()?;
        reject_symlink(&path)?;
        temporary.persist(&path).map_err(|error| error.error)?;
        let sidecar = sidecar_path(&path).map_err(|e| CloudError::Protocol(e.to_string()))?;
        reject_symlink(&sidecar)?;
        if let Some(xml) = &download.baseline.xml {
            publish(&sidecar, xml.as_bytes())?;
        } else {
            match fs::remove_file(sidecar) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let record = Record {
            server: server.to_owned(),
            entry: entry.clone(),
            acknowledged_local: download.baseline.xml.clone(),
            attempt: None,
            baseline: download.baseline,
        };
        publish(
            &self.directory.join("remote.json"),
            &serde_json::to_vec(&record).map_err(|e| CloudError::Protocol(e.to_string()))?,
        )?;
        self.record = Some(record);
        Ok(())
    }
    pub fn matches(&self, server: &str, entry: &CloudEntry) -> bool {
        self.record
            .as_ref()
            .is_some_and(|record| record.server == server && record.entry.address == entry.address)
    }

    pub fn synchronize(
        &mut self,
        client: &mut CloudClient,
        document: &SidecarDocument,
    ) -> Result<(), CloudError> {
        let mut record = self
            .record
            .take()
            .ok_or_else(|| CloudError::Protocol("No cloud edit is open".into()))?;
        let result = (|| {
            // Reconcile a response lost after the server committed the last attempt.
            if let Some(attempt) = &record.attempt {
                let remote = client.read_versioned_xmp(&record.entry.path)?;
                if remote.xml.as_deref() == Some(attempt) {
                    record.baseline = remote;
                }
            }
            let xml = document
                .serialize()
                .map_err(|error| CloudError::Protocol(error.to_string()))?;
            record.attempt = Some(xml.clone());
            publish(
                &self.directory.join("remote.json"),
                &serde_json::to_vec(&record)
                    .map_err(|error| CloudError::Protocol(error.to_string()))?,
            )?;
            let baseline =
                client.save_versioned_xmp(&record.entry.path, document, &record.baseline)?;
            record.baseline = baseline;
            record.acknowledged_local = Some(xml);
            record.attempt = None;
            publish(
                &self.directory.join("remote.json"),
                &serde_json::to_vec(&record)
                    .map_err(|error| CloudError::Protocol(error.to_string()))?,
            )?;
            Ok(())
        })();
        self.record = Some(record);
        result
    }

    pub fn reload(&mut self, client: &mut CloudClient) -> Result<(), CloudError> {
        let record = self
            .record
            .as_ref()
            .ok_or_else(|| CloudError::Protocol("No cloud editor is open".into()))?;
        let baseline = client.read_versioned_xmp(&record.entry.path)?;
        if !baseline.supports_preconditions {
            return Err(CloudError::Protocol(
                "Server does not support conditional cloud editing".into(),
            ));
        }
        if let Some(xml) = &baseline.xml {
            SidecarDocument::parse(xml).map_err(|error| CloudError::Protocol(error.to_string()))?;
        }
        let path =
            sidecar_path(&self.path()?).map_err(|error| CloudError::Protocol(error.to_string()))?;
        reject_symlink(&path)?;
        if let Some(xml) = &baseline.xml {
            publish(&path, xml.as_bytes())?;
        } else {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let record = Record {
            server: record.server.clone(),
            entry: record.entry.clone(),
            acknowledged_local: baseline.xml.clone(),
            baseline,
            attempt: None,
        };
        publish(
            &self.directory.join("remote.json"),
            &serde_json::to_vec(&record)
                .map_err(|error| CloudError::Protocol(error.to_string()))?,
        )?;
        self.record = Some(record);
        Ok(())
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }
}
impl Drop for EditJournal {
    fn drop(&mut self) {
        let _ = self.lock.unlock();
    }
}
fn original_path(directory: &Path, entry: &CloudEntry) -> Result<PathBuf, CloudError> {
    if entry.ext.is_empty() || !entry.ext.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(CloudError::Protocol("Invalid photograph extension".into()));
    }
    Ok(directory.join(format!("original.{}", entry.ext.to_ascii_lowercase())))
}
fn reject_symlink(path: &Path) -> Result<(), CloudError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(CloudError::Protocol(
            "Cloud journal refuses symlinks".into(),
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
fn publish(path: &Path, bytes: &[u8]) -> Result<(), CloudError> {
    reject_symlink(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| CloudError::Protocol("Journal has no directory".into()))?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    reject_symlink(path)?;
    file.persist(path).map_err(|error| error.error)?;
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}
