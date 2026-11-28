//! A source fetched on demand in a few large reads (#6033), each a seek and a
//! read on the reader the caller hands over. raw-core opens nothing itself: the
//! native layer opens the file and says how long it is. Reads are never memory
//! mapped: a file truncated or unreachable mid-read must be an error value,
//! where a mapped page faults.

use std::collections::BTreeSet;
use std::io::{self, Read, Seek, SeekFrom};
use std::num::NonZeroUsize;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

/// A megabyte per request amortises a network round trip and stays clear of the sensor data.
pub(crate) const EXTENT_ALIGN: usize = 1 << 20;
/// Many seeks over a share cost more than one sequential read, so piecewise reads are capped.
pub(crate) const MAX_EXTENTS: usize = 8;
/// Once the pieces would reach half the file, paging has little left to save.
const PIECEWISE_LIMIT_DIVISOR: u64 = 2;

struct Extent {
    start: usize,
    bytes: Vec<u8>,
}

impl Extent {
    fn end(&self) -> usize {
        self.start + self.bytes.len()
    }

    fn slice(&self, offset: usize, size: usize) -> Option<&[u8]> {
        let begin = offset.checked_sub(self.start)?;
        self.bytes.get(begin..begin.checked_add(size)?)
    }
}

struct Progress<R> {
    reader: R,
    extents: usize,
    read_calls: u32,
    bytes_read: u64,
    failure: Option<io::Error>,
}

fn same_error(error: &io::Error) -> io::Error {
    io::Error::new(error.kind(), error.to_string())
}

pub struct PagedFile<R> {
    len: usize,
    /// Filled in order and never replaced, so a slice handed out stays valid;
    /// the last slot holds the whole file.
    extents: [OnceLock<Extent>; MAX_EXTENTS + 1],
    progress: Mutex<Progress<R>>,
}

impl<R: Read + Seek> PagedFile<R> {
    /// `len` is the source's length in bytes, which every read is checked against.
    pub fn new(reader: R, len: NonZeroUsize) -> Self {
        Self {
            len: len.get(),
            extents: std::array::from_fn(|_| OnceLock::new()),
            progress: Mutex::new(Progress {
                reader,
                extents: 0,
                read_calls: 0,
                bytes_read: 0,
                failure: None,
            }),
        }
    }

    pub fn read_calls(&self) -> u32 {
        self.progress().read_calls
    }

    pub fn bytes_read(&self) -> u64 {
        self.progress().bytes_read
    }

    fn progress(&self) -> MutexGuard<'_, Progress<R>> {
        self.progress.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn loaded_extents(&self) -> impl Iterator<Item = &Extent> {
        self.extents.iter().filter_map(OnceLock::get)
    }

    fn loaded(&self, offset: usize, size: usize) -> Option<&[u8]> {
        self.loaded_extents()
            .find_map(|extent| extent.slice(offset, size))
    }

    fn gaps(&self, start: usize, end: usize) -> Vec<(usize, usize)> {
        let held = self
            .loaded_extents()
            .map(|extent| (extent.start.max(start), extent.end().min(end)))
            .filter(|(from, to)| from < to)
            .collect::<BTreeSet<_>>();
        let (gaps, covered) =
            held.into_iter()
                .fold((Vec::new(), start), |(mut gaps, covered), (from, to)| {
                    if from > covered {
                        gaps.push((covered, from));
                    }
                    (gaps, covered.max(to))
                });
        gaps.into_iter()
            .chain((covered < end).then_some((covered, end)))
            .collect()
    }

    fn read_into(
        &self,
        progress: &mut Progress<R>,
        start: usize,
        buffer: &mut [u8],
    ) -> io::Result<()> {
        let read = progress
            .reader
            .seek(SeekFrom::Start(start as u64))
            .and_then(|_| progress.reader.read_exact(buffer));
        progress.read_calls += 1;
        progress.bytes_read += buffer.len() as u64;
        read.map_err(|error| {
            progress.failure = Some(same_error(&error));
            error
        })
    }

    fn load(
        &self,
        progress: &mut Progress<R>,
        slot: usize,
        (start, end): (usize, usize),
        gaps: &[(usize, usize)],
    ) -> io::Result<&Extent> {
        // A dead share costs one failed request, not one per decoder retry.
        if let Some(failure) = &progress.failure {
            return Err(same_error(failure));
        }
        let mut bytes = vec![0u8; end - start];
        self.loaded_extents().for_each(|extent| {
            let (from, to) = (extent.start.max(start), extent.end().min(end));
            if from < to {
                bytes[from - start..to - start]
                    .copy_from_slice(&extent.bytes[from - extent.start..to - extent.start]);
            }
        });
        gaps.iter().try_for_each(|&(from, to)| {
            self.read_into(progress, from, &mut bytes[from - start..to - start])
        })?;
        progress.extents = slot + 1;
        Ok(self.extents[slot].get_or_init(|| Extent { start, bytes }))
    }

    fn load_whole(&self, progress: &mut Progress<R>) -> io::Result<&[u8]> {
        if let Some(whole) = self.loaded(0, self.len) {
            return Ok(whole);
        }
        self.load(
            progress,
            MAX_EXTENTS,
            (0, self.len),
            &self.gaps(0, self.len),
        )
        .map(|extent| extent.bytes.as_slice())
    }
}

impl<R: Read + Seek + Send> rawler::rawsource::LazyBytes for PagedFile<R> {
    fn len(&self) -> usize {
        self.len
    }

    fn range(&self, offset: usize, size: usize) -> io::Result<&[u8]> {
        let end = offset
            .checked_add(size)
            .filter(|&end| end <= self.len)
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "range is behind EOF"))?;
        if size == 0 {
            return Ok(&[]);
        }
        if let Some(bytes) = self.loaded(offset, size) {
            return Ok(bytes);
        }
        let mut progress = self.progress();
        if let Some(bytes) = self.loaded(offset, size) {
            return Ok(bytes);
        }
        let start = offset / EXTENT_ALIGN * EXTENT_ALIGN;
        let extent_end = end
            .div_ceil(EXTENT_ALIGN)
            .saturating_mul(EXTENT_ALIGN)
            .min(self.len);
        let gaps = self.gaps(start, extent_end);
        let unread: u64 = gaps.iter().map(|(from, to)| (to - from) as u64).sum();
        let affordable = progress.extents < MAX_EXTENTS
            && progress.read_calls as usize + gaps.len() <= MAX_EXTENTS
            && progress.bytes_read + unread <= self.len as u64 / PIECEWISE_LIMIT_DIVISOR;
        if !affordable {
            return self
                .load_whole(&mut progress)
                .map(|whole| &whole[offset..end]);
        }
        let slot = progress.extents;
        self.load(&mut progress, slot, (start, extent_end), &gaps)
            .map(|extent| &extent.bytes[offset - start..end - start])
    }

    fn all(&self) -> &[u8] {
        let mut progress = self.progress();
        self.load_whole(&mut progress).unwrap_or(&[])
    }

    fn failure(&self) -> Option<io::Error> {
        self.progress().failure.as_ref().map(same_error)
    }
}

#[cfg(test)]
#[path = "paged_file_tests.rs"]
mod tests;
