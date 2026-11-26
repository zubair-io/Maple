use std::{
  fmt::Debug,
  fs::File,
  io::{Cursor, Read, Seek, SeekFrom},
  iter::repeat,
  ops::Deref,
  path::{Path, PathBuf},
  sync::Arc,
};

use md5::Digest;
use memmap2::MmapOptions;

use crate::buffer::PaddedBuf;

pub struct RawSource<'a> {
  path: PathBuf,
  inner: RawSourceImpl<'a>,
}

/// Source bytes fetched on demand instead of held up front.
pub trait LazyBytes: Send + Sync {
  fn len(&self) -> usize;

  /// The `size` bytes at `offset`; the caller has checked they end within `len`.
  fn range(&self, offset: usize, size: usize) -> std::io::Result<&[u8]>;

  /// Every byte of the source; empty when fetching failed, which `failure` reports.
  fn all(&self) -> &[u8];

  /// The first fetch error. Bytes handed out after it are not the source's.
  fn failure(&self) -> Option<std::io::Error>;
}

enum RawSourceImpl<'a> {
  Borrowed(&'a [u8]),
  Memmap(memmap2::Mmap),
  Memory(Arc<Vec<u8>>),
  Lazy(&'a dyn LazyBytes),
}

impl<'a> RawSource<'a> {
  pub fn new(path: &Path) -> std::io::Result<Self> {
    let file = File::open(path)?;
    let mmap = unsafe { MmapOptions::new().populate().map(&file)? };
    #[cfg(unix)]
    {
      mmap.advise(memmap2::Advice::WillNeed)?;
      mmap.advise(memmap2::Advice::Sequential)?;
    }
    Ok(Self {
      path: path.canonicalize().unwrap_or_else(|_| path.to_owned()),
      inner: RawSourceImpl::Memmap(mmap),
    })
  }

  /// Map only the pages demanded by metadata readers, without populating or
  /// prefetching the compressed sensor payload.
  pub fn new_metadata(path: &Path) -> std::io::Result<Self> {
    let file = File::open(path)?;
    let mmap = unsafe { MmapOptions::new().map(&file)? };
    Ok(Self {
      path: path.canonicalize().unwrap_or_else(|_| path.to_owned()),
      inner: RawSourceImpl::Memmap(mmap),
    })
  }

  /// Borrow existing bytes. Rust ties the source to the buffer's lifetime;
  /// no source-sized allocation or copy is needed for a metadata query.
  pub fn new_from_borrowed_slice(buf: &'a [u8]) -> Self {
    Self { path: PathBuf::default(), inner: RawSourceImpl::Borrowed(buf) }
  }

  /// Fetch only the ranges a reader asks for. Whole-buffer access still
  /// works: it makes the source fetch everything.
  pub fn new_lazy(bytes: &'a dyn LazyBytes) -> Self {
    Self { path: PathBuf::default(), inner: RawSourceImpl::Lazy(bytes) }
  }

  pub fn new_from_shared_vec(buf: Arc<Vec<u8>>) -> Self {
    Self {
      path: PathBuf::default(),
      inner: RawSourceImpl::Memory(buf),
    }
  }

  pub fn with_path(self, path: impl AsRef<Path>) -> Self {
    Self {
      path: path.as_ref().to_owned(),
      inner: self.inner,
    }
  }

  pub fn new_from_slice(buf: &[u8]) -> Self {
    Self::new_from_shared_vec(Arc::new(Vec::from(buf)))
  }

  /// Calculate digest for file
  pub fn digest(&self) -> Digest {
    md5::compute(self.buf())
  }

  pub fn path(&self) -> &Path {
    &self.path
  }

  pub fn buf(&self) -> &[u8] {
    self.deref()
  }

  /// The first fetch error of a lazy source; whatever was decoded from it
  /// after that must be discarded.
  pub fn failure(&self) -> Option<std::io::Error> {
    match &self.inner {
      RawSourceImpl::Lazy(bytes) => bytes.failure(),
      _ => None,
    }
  }

  /// Length without fetching a lazy source.
  pub fn len(&self) -> usize {
    match &self.inner {
      RawSourceImpl::Lazy(bytes) => bytes.len(),
      _ => self.buf().len(),
    }
  }

  pub fn subview(&self, offset: u64, size: u64) -> std::io::Result<&[u8]> {
    if let RawSourceImpl::Lazy(bytes) = &self.inner {
      if offset.checked_add(size).is_some_and(|end| end <= bytes.len() as u64) {
        return bytes.range(offset as usize, size as usize);
      }
      return Err(std::io::Error::new(
        std::io::ErrorKind::UnexpectedEof,
        format!("subview(): Offset {}+{} is behind EOF", offset, size),
      ));
    }
    self.buf().get(offset as usize..(offset + size) as usize).ok_or(std::io::Error::new(
      std::io::ErrorKind::UnexpectedEof,
      format!("subview(): Offset {}+{} is behind EOF", offset, size),
    ))
  }

  pub fn subview_padded(&self, offset: u64, size: u64) -> std::io::Result<PaddedBuf<'_>> {
    if offset + size <= self.len() as u64 {
      if offset + size + 16 <= self.len() as u64 {
        self.subview(offset, size + 16).map(|buf| PaddedBuf::new_ref(buf, size as usize))
      } else {
        let mut buf = Vec::with_capacity((size + 16) as usize);
        buf.extend_from_slice(self.subview(offset, size)?);
        buf.extend(repeat(0).take(16));
        Ok(PaddedBuf::new_owned(buf, size as usize))
      }
    } else {
      Err(std::io::Error::new(
        std::io::ErrorKind::UnexpectedEof,
        format!("subview_padded(): Offset {}+{} is behind EOF", offset, size),
      ))
    }
  }

  pub fn subview_until_eof(&self, offset: u64) -> std::io::Result<&[u8]> {
    if let RawSourceImpl::Lazy(bytes) = &self.inner {
      if offset <= bytes.len() as u64 {
        return bytes.range(offset as usize, bytes.len() - offset as usize);
      }
      return Err(std::io::Error::new(
        std::io::ErrorKind::UnexpectedEof,
        format!("subview_until_eof(): Offset {} is behind EOF", offset),
      ));
    }
    self.buf().get(offset as usize..).ok_or(std::io::Error::new(
      std::io::ErrorKind::UnexpectedEof,
      format!("subview_until_eof(): Offset {} is behind EOF", offset),
    ))
  }

  pub fn subview_until_eof_padded(&self, offset: u64) -> std::io::Result<PaddedBuf<'_>> {
    if offset < self.len() as u64 {
      let mut buf = Vec::with_capacity((self.len() - offset as usize + 16) as usize);
      buf.extend_from_slice(self.subview_until_eof(offset)?);
      buf.extend(repeat(0).take(16));
      Ok(PaddedBuf::new_owned(buf, self.len() - offset as usize))
    } else {
      Err(std::io::Error::new(
        std::io::ErrorKind::UnexpectedEof,
        format!("subview_until_eof_padded(): Offset {} is behind EOF", offset),
      ))
    }
  }

  pub fn reader(&self) -> SourceReader<'_> {
    match &self.inner {
      RawSourceImpl::Lazy(bytes) => SourceReader::Lazy { bytes: *bytes, position: 0 },
      _ => SourceReader::Whole(Cursor::new(self.buf())),
    }
  }

  pub fn as_vec(&self) -> std::io::Result<Vec<u8>> {
    Ok(self.buf().to_vec())
  }

  pub fn stream_len(&mut self) -> u64 {
    self.len() as u64
  }
}

/// `Read + Seek` over a source, with `Cursor` semantics; a lazy source is
/// fetched only where it is read.
pub enum SourceReader<'s> {
  Whole(Cursor<&'s [u8]>),
  Lazy { bytes: &'s dyn LazyBytes, position: u64 },
}

impl Read for SourceReader<'_> {
  fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
    match self {
      Self::Whole(cursor) => cursor.read(buf),
      Self::Lazy { bytes, position } => {
        let remaining = (bytes.len() as u64).saturating_sub(*position);
        let count = remaining.min(buf.len() as u64) as usize;
        if count == 0 {
          return Ok(0);
        }
        buf[..count].copy_from_slice(bytes.range(*position as usize, count)?);
        *position += count as u64;
        Ok(count)
      }
    }
  }

  fn read_exact(&mut self, buf: &mut [u8]) -> std::io::Result<()> {
    match self {
      Self::Whole(cursor) => cursor.read_exact(buf),
      Self::Lazy { bytes, position } => {
        let len = bytes.len() as u64;
        if !position.checked_add(buf.len() as u64).is_some_and(|end| end <= len) {
          *position = len;
          return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "failed to fill whole buffer"));
        }
        buf.copy_from_slice(bytes.range(*position as usize, buf.len())?);
        *position += buf.len() as u64;
        Ok(())
      }
    }
  }
}

impl Seek for SourceReader<'_> {
  fn seek(&mut self, target: SeekFrom) -> std::io::Result<u64> {
    match self {
      Self::Whole(cursor) => cursor.seek(target),
      Self::Lazy { bytes, position } => {
        let moved = match target {
          SeekFrom::Start(offset) => Some(offset),
          SeekFrom::End(delta) => (bytes.len() as u64).checked_add_signed(delta),
          SeekFrom::Current(delta) => position.checked_add_signed(delta),
        };
        *position = moved.ok_or_else(|| {
          std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid seek to a negative or overflowing position")
        })?;
        Ok(*position)
      }
    }
  }
}

impl Deref for RawSource<'_> {
  type Target = [u8];

  fn deref(&self) -> &Self::Target {
    match &self.inner {
      RawSourceImpl::Borrowed(bytes) => bytes,
      RawSourceImpl::Memmap(mmap) => mmap.deref(),
      RawSourceImpl::Memory(mem) => mem.deref(),
      RawSourceImpl::Lazy(bytes) => bytes.all(),
    }
  }
}

impl Debug for RawSource<'_> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("RawSource").field("path", &self.path).finish()
  }
}

