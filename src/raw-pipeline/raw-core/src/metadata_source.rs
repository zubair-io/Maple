//! Random-access metadata bytes, borrowed from memory or read from a seekable
//! stream (#3620). Container walkers share their parsing and bounds checks;
//! the file adapter only reads the spans those walkers actually inspect.

use std::borrow::Cow;
use std::cell::RefCell;
use std::io::{self, Read, Seek, SeekFrom};
use std::ops::Range;

pub(crate) trait MetadataSource {
    fn len(&self) -> usize;
    fn get(&self, range: Range<usize>) -> Option<Cow<'_, [u8]>>;

    fn contains(&self, range: Range<usize>) -> bool {
        range.start <= range.end && range.end <= self.len()
    }

    fn byte(&self, at: usize) -> Option<u8> {
        self.get(at..at.checked_add(1)?).map(|bytes| bytes[0])
    }

    fn starts_with(&self, prefix: &[u8]) -> bool {
        self.get(0..prefix.len())
            .is_some_and(|bytes| bytes.as_ref() == prefix)
    }
}

impl MetadataSource for [u8] {
    fn len(&self) -> usize {
        <[u8]>::len(self)
    }

    fn get(&self, range: Range<usize>) -> Option<Cow<'_, [u8]>> {
        <[u8]>::get(self, range).map(Cow::Borrowed)
    }
}

pub(crate) struct SeekableSource<'a, R> {
    reader: RefCell<&'a mut R>,
    length: usize,
    error: RefCell<Option<io::Error>>,
}

impl<'a, R: Read + Seek> SeekableSource<'a, R> {
    pub(crate) fn new(reader: &'a mut R) -> io::Result<Self> {
        let length = usize::try_from(reader.seek(SeekFrom::End(0))?)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "image file is too large"))?;
        Ok(Self {
            reader: RefCell::new(reader),
            length,
            error: RefCell::new(None),
        })
    }

    // A malformed span is absent just as slice.get() is. A real I/O failure
    // remains an error, rather than masquerading as missing metadata.
    pub(crate) fn finish<T>(self, value: T) -> io::Result<T> {
        match self.error.into_inner() {
            Some(error) => Err(error),
            None => Ok(value),
        }
    }
}

impl<R: Read + Seek> MetadataSource for SeekableSource<'_, R> {
    fn len(&self) -> usize {
        self.length
    }

    fn get(&self, range: Range<usize>) -> Option<Cow<'_, [u8]>> {
        if !self.contains(range.clone()) || self.error.borrow().is_some() {
            return None;
        }
        let read = || -> io::Result<Vec<u8>> {
            let mut bytes = Vec::new();
            bytes
                .try_reserve_exact(range.len())
                .map_err(io::Error::other)?;
            bytes.resize(range.len(), 0);
            let mut reader = self.reader.borrow_mut();
            // BufReader::seek_relative retains its buffer when the target
            // is in the same page; repeated small IFD fields then cost one
            // buffered read rather than refilling the page for every tag.
            let current = reader.stream_position()?;
            let delta = i128::from(range.start as u64) - i128::from(current);
            match i64::try_from(delta) {
                Ok(delta) => reader.seek_relative(delta)?,
                Err(_) => {
                    reader.seek(SeekFrom::Start(range.start as u64))?;
                }
            }
            reader.read_exact(&mut bytes)?;
            Ok(bytes)
        };
        match read() {
            Ok(bytes) => Some(Cow::Owned(bytes)),
            Err(error) => {
                *self.error.borrow_mut() = Some(error);
                None
            }
        }
    }
}
