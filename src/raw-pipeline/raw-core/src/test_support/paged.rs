//! Opens a fixture the way the native layer does before paging it (#6033).

use crate::paged_file::PagedFile;
use std::fs::File;
use std::num::NonZeroUsize;
use std::path::Path;

pub fn paged(path: &Path) -> PagedFile<File> {
    let file = File::open(path).unwrap();
    let len = usize::try_from(file.metadata().unwrap().len()).unwrap();
    PagedFile::new(file, NonZeroUsize::new(len).expect("a non-empty file"))
}
