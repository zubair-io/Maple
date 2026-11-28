//! On-disk cloud tiles in the user's cache folder; the listing's token lives in an index record beside the bytes, never in a name.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
    time::SystemTime,
};

const BUDGET_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct Record {
    token: String,
}

pub struct TileCache {
    directory: PathBuf,
    budget: u64,
    stored: Mutex<Option<u64>>,
    entries: Mutex<()>,
}

impl TileCache {
    pub fn new(directory: PathBuf, budget: u64) -> Self {
        Self {
            directory,
            budget,
            stored: Mutex::new(None),
            entries: Mutex::new(()),
        }
    }

    pub fn in_user_cache() -> Option<Self> {
        dirs::cache_dir().map(|root| Self::new(root.join("maple/cloud-tiles"), BUDGET_BYTES))
    }

    fn key(server: &str, address: &str) -> String {
        format!(
            "{:x}",
            Sha256::digest(format!("{server}\0{address}").as_bytes())
        )
    }

    fn bytes_path(&self, key: &str) -> PathBuf {
        self.directory.join(format!("{key}.avif"))
    }

    fn index_path(&self, key: &str) -> PathBuf {
        self.directory.join(format!("{key}.json"))
    }

    /// Bytes and token are two files, so one lock keeps a reader and a concurrent publish from pairing bytes with the other's token.
    /// The stored tile, only when its token is the listing's. A listing without a token proves nothing, so it never hits.
    pub fn load(&self, server: &str, address: &str, token: Option<&str>) -> Option<Vec<u8>> {
        let token = token.filter(|token| !token.is_empty())?;
        let key = Self::key(server, address);
        let _entry = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let record: Record = serde_json::from_slice(&fs::read(self.index_path(&key)).ok()?).ok()?;
        if record.token != token {
            return None;
        }
        let bytes = fs::read(self.bytes_path(&key))
            .ok()
            .filter(|bytes| !bytes.is_empty())?;
        touch(&self.bytes_path(&key));
        touch(&self.index_path(&key));
        Some(bytes)
    }

    pub fn store(&self, server: &str, address: &str, token: Option<&str>, bytes: &[u8]) {
        if let Some(token) = token.filter(|token| !token.is_empty()) {
            let _ = self.publish(&Self::key(server, address), token, bytes);
        }
    }

    fn publish(&self, key: &str, token: &str, bytes: &[u8]) -> io::Result<()> {
        let _entry = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        fs::create_dir_all(&self.directory)?;
        let record = serde_json::to_vec(&Record {
            token: token.to_owned(),
        })
        .map_err(io::Error::other)?;
        let replaced = [self.bytes_path(key), self.index_path(key)]
            .iter()
            .filter_map(|path| fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .sum::<u64>();
        self.write_atomically(&self.bytes_path(key), bytes)?;
        self.write_atomically(&self.index_path(key), &record)?;
        self.account((bytes.len() + record.len()) as u64, replaced);
        Ok(())
    }

    fn write_atomically(&self, target: &Path, bytes: &[u8]) -> io::Result<()> {
        let mut staging = tempfile::NamedTempFile::new_in(&self.directory)?;
        staging.write_all(bytes)?;
        staging.persist(target).map_err(|error| error.error)?;
        Ok(())
    }

    fn account(&self, added: u64, replaced: u64) {
        let mut stored = self.stored.lock().unwrap_or_else(PoisonError::into_inner);
        let total = match *stored {
            Some(known) => known.saturating_add(added).saturating_sub(replaced),
            None => self.scan().iter().map(|file| file.length).sum(),
        };
        *stored = Some(if total > self.budget {
            self.evict()
        } else {
            total
        });
    }

    fn scan(&self) -> Vec<Stored> {
        let Ok(entries) = fs::read_dir(&self.directory) else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let metadata = entry.metadata().ok().filter(fs::Metadata::is_file)?;
                Some(Stored {
                    path: entry.path(),
                    length: metadata.len(),
                    used: metadata.modified().ok()?,
                })
            })
            .collect()
    }

    /// Drops the least recently used files until 90% of the budget remains, so the next inserts do not scan again.
    fn evict(&self) -> u64 {
        let mut files = self.scan();
        files.sort_by_key(|file| file.used);
        let target = self.budget / 10 * 9;
        let mut remaining: u64 = files.iter().map(|file| file.length).sum();
        for file in files {
            if remaining <= target {
                break;
            }
            if fs::remove_file(&file.path).is_ok() {
                remaining -= file.length;
            }
        }
        remaining
    }
}

struct Stored {
    path: PathBuf,
    length: u64,
    used: SystemTime,
}

fn touch(path: &Path) {
    if let Ok(file) = fs::OpenOptions::new().append(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}
