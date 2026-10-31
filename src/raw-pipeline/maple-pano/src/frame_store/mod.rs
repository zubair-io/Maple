//! Per-stitch disk store of decoded source frames (#5553, epic #5450).
//!
//! Each frame is developed once by [`raw_core::develop_banded_for_pano`]
//! straight into its own file of interleaved scene-linear Rec.2020 `f32`
//! RGB, row-major in output (DefaultCrop + oriented) coordinates, so no
//! full-resolution frame is ever resident. Stages then read row windows
//! back with positional reads into caller-owned buffers; reads take `&self`
//! and run concurrently.
//!
//! Every pixel `decode_for_pano` produces is valid (DefaultCrop has already
//! dropped the sensor margins), so validity is not stored: a window read
//! back as a [`PlanarImage`] carries an all-true mask, exactly what
//! [`PlanarImage::from_scene_linear`] gives the full-frame path.
//!
//! The store lives in its own directory under the caller's parent and is
//! removed when the store drops, whether the stitch finished, failed or was
//! cancelled. A directory left by a process that was killed outright is
//! swept by the next [`FrameStore::create`] in the same parent once its
//! owning process is gone. Source RAWs and sidecars are only ever read.

mod io;
mod rows;
#[cfg(test)]
mod tests;
mod window;

pub use rows::{FrameRect, FrameRows, InMemory, Subset};
pub(crate) use window::{SourceView, SourceWindow, WINDOW_BYTES_PER_PX};

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use raw_core::{PanoBandScratch, PanoBandedIngest, PanoBlockSink};

use crate::error::PanoError;
use crate::ingest::{PlanarImage, ValidityMask};

const BYTES_PER_PIXEL: u64 = 12;
const READ_CHUNK_BYTES: u64 = 8 << 20;
const DIR_PREFIX: &str = "maple-pano-frames-";

/// The pass-1 scratch holds post-WB camera RGB at full *sensor* size, which
/// DefaultCrop trims to the output size. Reserving an eighth over the
/// largest output frame covers every crop margin in the fixture corpus
/// (DJI bodies trim a few dozen pixels) with room to spare.
const SCRATCH_RESERVE_EIGHTHS: u64 = 9;

/// A stitch's decoded frames on disk. Index `i` is input frame `i`.
pub struct FrameStore {
    dir: PathBuf,
    planned: Vec<(u32, u32)>,
    frames: Vec<Option<File>>,
    scratch: Option<File>,
    scratch_path: PathBuf,
    needed_bytes: u64,
}

impl FrameStore {
    /// Create an empty store under `parent` for frames of the given output
    /// dimensions, failing with [`PanoError::InsufficientScratchSpace`]
    /// before anything is written when `parent`'s volume can't hold them.
    pub fn create(parent: &Path, frame_dims: &[(u32, u32)]) -> Result<Self, PanoError> {
        Self::create_with(parent, frame_dims, io::available_bytes)
    }

    fn create_with(
        parent: &Path,
        frame_dims: &[(u32, u32)],
        available_bytes: impl Fn(&Path) -> std::io::Result<u64>,
    ) -> Result<Self, PanoError> {
        io::sweep_orphans(parent, DIR_PREFIX);
        let needed_bytes = required_bytes(frame_dims).ok_or_else(|| {
            PanoError::InvalidOptions(format!(
                "frame store: {} planned frames need more than u64::MAX bytes",
                frame_dims.len()
            ))
        })?;
        let available = available_bytes(parent).map_err(|e| PanoError::io(parent, e))?;
        if available < needed_bytes {
            return Err(PanoError::InsufficientScratchSpace {
                path: parent.to_path_buf(),
                needed: needed_bytes,
                available,
            });
        }
        let dir = io::create_unique_dir(parent, DIR_PREFIX)?;
        let scratch_path = dir.join("scratch.rgbf32");
        let scratch = match create_file(&scratch_path) {
            Ok(file) => file,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(e);
            }
        };
        Ok(Self {
            dir,
            planned: frame_dims.to_vec(),
            frames: frame_dims.iter().map(|_| None).collect(),
            scratch: Some(scratch),
            scratch_path,
            needed_bytes,
        })
    }

    /// Test-only: a store under `parent` holding each of `paths` developed
    /// as the frame of the same index, sized from their headers.
    #[cfg(test)]
    pub(crate) fn of_files(parent: &Path, paths: &[PathBuf]) -> Self {
        let dims: Vec<(u32, u32)> = paths
            .iter()
            .map(|p| {
                let [w, h] = raw_core::raw_dimensions::from_file(p).expect("dimensions");
                (w, h)
            })
            .collect();
        let mut store = Self::create(parent, &dims).expect("frame store");
        for (idx, path) in paths.iter().enumerate() {
            store.ingest_file(idx, path, 64).expect("develop");
        }
        store
    }

    /// Output dimensions of frame `idx`, once it has been stored.
    pub fn dims(&self, idx: usize) -> Option<(u32, u32)> {
        self.stored(idx).ok().map(|(_, dims)| dims)
    }

    /// Develop `path` as frame `idx` in `band_rows`-row bands. Each frame is
    /// stored once; its developed size must match the size planned at
    /// [`Self::create`]. A failed ingest leaves nothing behind, so the same
    /// index can be ingested again.
    pub fn ingest_file(
        &mut self,
        idx: usize,
        path: &Path,
        band_rows: u32,
    ) -> Result<PanoBandedIngest, PanoError> {
        let bytes = std::fs::read(path).map_err(|e| PanoError::io(path, e))?;
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        self.ingest_bytes(idx, &bytes, &ext, band_rows, &path.display().to_string())
    }

    fn ingest_bytes(
        &mut self,
        idx: usize,
        bytes: &[u8],
        ext: &str,
        band_rows: u32,
        context: &str,
    ) -> Result<PanoBandedIngest, PanoError> {
        let planned = *self.planned.get(idx).ok_or_else(|| {
            PanoError::InvalidOptions(format!(
                "frame store: index {idx} out of range for {} frames",
                self.planned.len()
            ))
        })?;
        if self.frames[idx].is_some() {
            return Err(PanoError::InvalidOptions(format!(
                "frame store: frame {idx} already stored"
            )));
        }
        let path = self.frame_path(idx);
        let file = create_file(&path)?;
        let developed = self.develop_into(&file, &path, planned, bytes, ext, band_rows, context);
        match developed {
            Ok(developed) => {
                self.frames[idx] = Some(file);
                Ok(developed)
            }
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&path);
                Err(e)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn develop_into(
        &self,
        file: &File,
        path: &Path,
        planned: (u32, u32),
        bytes: &[u8],
        ext: &str,
        band_rows: u32,
        context: &str,
    ) -> Result<PanoBandedIngest, PanoError> {
        let scratch_file = self.scratch.as_ref().expect("scratch lives until drop");
        let mut scratch = FileScratch {
            file: scratch_file,
            path: &self.scratch_path,
            width: 0,
        };
        let mut sink = FileSink {
            file,
            path,
            planned,
            developed: None,
            width: 0,
        };
        let result =
            raw_core::develop_banded_for_pano(bytes, ext, band_rows, &mut scratch, &mut sink);
        let developed_dims = sink.developed.unwrap_or(planned);
        if developed_dims != planned {
            return Err(PanoError::InvalidOptions(format!(
                "frame store: {context} developed to {developed_dims:?}, planned {planned:?}"
            )));
        }
        result.map_err(|source| self.decode_error(context, source))
    }

    fn decode_error(&self, context: &str, source: raw_core::Error) -> PanoError {
        let out_of_space = matches!(
            &source,
            raw_core::Error::Io { source, .. } if matches!(
                source.kind(),
                std::io::ErrorKind::StorageFull | std::io::ErrorKind::FileTooLarge
            )
        );
        if out_of_space {
            let parent = self.dir.parent().unwrap_or(&self.dir);
            return PanoError::InsufficientScratchSpace {
                path: parent.to_path_buf(),
                needed: self.needed_bytes,
                available: io::available_bytes(parent).unwrap_or(0),
            };
        }
        PanoError::RawDecode {
            context: context.to_string(),
            source,
        }
    }

    fn read_rows(&self, idx: usize, y0: u32, out: &mut [[f32; 3]]) -> Result<(), PanoError> {
        let (file, (width, height)) = self.stored(idx)?;
        let rows = out.len() / (width as usize).max(1);
        if out.len() % (width as usize).max(1) != 0 || y0 as usize + rows > height as usize {
            return Err(PanoError::InvalidOptions(format!(
                "frame store: {} pixels from row {y0} is not whole rows of frame {idx} ({width}x{height})",
                out.len(),
            )));
        }
        let offset = y0 as u64 * width as u64 * BYTES_PER_PIXEL;
        io::read_exact_at(file, io::pixels_as_bytes_mut(out), offset)
            .map_err(|e| PanoError::io(&self.frame_path(idx), e))
    }

    /// Frame `idx`'s rows `y0..y0 + rows` as a planar window with an
    /// all-true validity mask. Reads go through a buffer of at most
    /// [`READ_CHUNK_BYTES`], so only the planes themselves are resident.
    pub fn read_planar_rows(
        &self,
        idx: usize,
        y0: u32,
        rows: u32,
    ) -> Result<PlanarImage, PanoError> {
        self.read_planar_rows_chunked(idx, y0, rows, READ_CHUNK_BYTES)
    }

    fn read_planar_rows_chunked(
        &self,
        idx: usize,
        y0: u32,
        rows: u32,
        chunk_bytes: u64,
    ) -> Result<PlanarImage, PanoError> {
        let (_, (width, height)) = self.stored(idx)?;
        let end = y0
            .checked_add(rows)
            .filter(|&end| end <= height)
            .ok_or_else(|| {
                PanoError::InvalidOptions(format!(
                    "frame store: rows {y0}+{rows} past the {height} rows of frame {idx}"
                ))
            })?;
        let row_px = width as usize;
        let n = row_px * rows as usize;
        let (mut r, mut g, mut b) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        let chunk_rows = (chunk_bytes / (row_px as u64 * BYTES_PER_PIXEL).max(1))
            .clamp(1, rows.max(1) as u64) as u32;
        let mut chunk = vec![[0.0f32; 3]; row_px * chunk_rows as usize];
        for start in (y0..end).step_by(chunk_rows as usize) {
            let take = chunk_rows.min(end - start) as usize;
            let part = &mut chunk[..row_px * take];
            self.read_rows(idx, start, part)?;
            r.extend(part.iter().map(|p| p[0]));
            g.extend(part.iter().map(|p| p[1]));
            b.extend(part.iter().map(|p| p[2]));
        }
        Ok(PlanarImage::from_planes(
            width,
            rows,
            r,
            g,
            b,
            ValidityMask::new_filled(width, rows, true),
        ))
    }

    /// Frame `idx`'s pixels inside `rect` as a planar image with an
    /// all-true validity mask: one positional read per row of the rect.
    pub fn read_planar_rect(&self, idx: usize, rect: FrameRect) -> Result<PlanarImage, PanoError> {
        let (file, (width, height)) = self.stored(idx)?;
        if !rect.fits(width, height) {
            return Err(PanoError::InvalidOptions(format!(
                "frame store: {rect:?} past the {width}x{height} frame {idx}"
            )));
        }
        if rect.x0 == 0 && rect.width == width {
            return self.read_planar_rows(idx, rect.y0, rect.height);
        }
        let row_px = rect.width as usize;
        let n = row_px * rect.height as usize;
        let (mut r, mut g, mut b) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        let mut row = vec![[0.0f32; 3]; row_px];
        for y in rect.y0..rect.y0 + rect.height {
            let offset = (y as u64 * width as u64 + rect.x0 as u64) * BYTES_PER_PIXEL;
            io::read_exact_at(file, io::pixels_as_bytes_mut(&mut row), offset)
                .map_err(|e| PanoError::io(&self.frame_path(idx), e))?;
            r.extend(row.iter().map(|p| p[0]));
            g.extend(row.iter().map(|p| p[1]));
            b.extend(row.iter().map(|p| p[2]));
        }
        Ok(PlanarImage::from_planes(
            rect.width,
            rect.height,
            r,
            g,
            b,
            ValidityMask::new_filled(rect.width, rect.height, true),
        ))
    }

    fn stored(&self, idx: usize) -> Result<(&File, (u32, u32)), PanoError> {
        self.frames
            .get(idx)
            .and_then(Option::as_ref)
            .map(|file| (file, self.planned[idx]))
            .ok_or_else(|| {
                PanoError::InvalidOptions(format!("frame store: frame {idx} not stored"))
            })
    }

    fn frame_path(&self, idx: usize) -> PathBuf {
        self.dir.join(format!("frame-{idx:04}.rgbf32"))
    }
}

impl Drop for FrameStore {
    fn drop(&mut self) {
        // Windows can't remove a directory whose files are still open
        // (outside NTFS POSIX-delete semantics), so close them first.
        self.frames.clear();
        self.scratch = None;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn required_bytes(frame_dims: &[(u32, u32)]) -> Option<u64> {
    let pixels = |&(w, h): &(u32, u32)| w as u128 * h as u128;
    let frames: u128 = frame_dims.iter().map(pixels).sum();
    let largest = frame_dims.iter().map(pixels).max().unwrap_or(0);
    let reserve = largest * SCRATCH_RESERVE_EIGHTHS as u128 / 8;
    u64::try_from((frames + reserve) * BYTES_PER_PIXEL as u128).ok()
}

fn create_file(path: &Path) -> Result<File, PanoError> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| PanoError::io(path, e))
}

fn raw_io(path: &Path, source: std::io::Error) -> raw_core::Error {
    raw_core::Error::Io {
        path: path.to_path_buf(),
        source,
    }
}

struct FileScratch<'a> {
    file: &'a File,
    path: &'a Path,
    width: u64,
}

impl PanoBandScratch for FileScratch<'_> {
    fn begin(&mut self, width: u32, _height: u32) -> raw_core::Result<()> {
        self.width = width as u64;
        Ok(())
    }

    fn put_rows(&mut self, y0: u32, rows: &[[f32; 3]]) -> raw_core::Result<()> {
        let offset = y0 as u64 * self.width * BYTES_PER_PIXEL;
        io::write_all_at(self.file, io::pixels_as_bytes(rows), offset)
            .map_err(|e| raw_io(self.path, e))
    }

    fn read_rows(&mut self, y0: u32, out: &mut [[f32; 3]]) -> raw_core::Result<()> {
        let offset = y0 as u64 * self.width * BYTES_PER_PIXEL;
        io::read_exact_at(self.file, io::pixels_as_bytes_mut(out), offset)
            .map_err(|e| raw_io(self.path, e))
    }
}

struct FileSink<'a> {
    file: &'a File,
    path: &'a Path,
    planned: (u32, u32),
    developed: Option<(u32, u32)>,
    width: u64,
}

impl PanoBlockSink for FileSink<'_> {
    fn begin(&mut self, width: u32, height: u32) -> raw_core::Result<()> {
        self.developed = Some((width, height));
        if (width, height) != self.planned {
            return Err(raw_io(
                self.path,
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("frame is {width}x{height}, planned {:?}", self.planned),
                ),
            ));
        }
        self.width = width as u64;
        Ok(())
    }

    fn put_block(
        &mut self,
        x0: u32,
        y0: u32,
        width: u32,
        pixels: &[[f32; 3]],
    ) -> raw_core::Result<()> {
        if width as u64 == self.width && x0 == 0 {
            let offset = y0 as u64 * self.width * BYTES_PER_PIXEL;
            return io::write_all_at(self.file, io::pixels_as_bytes(pixels), offset)
                .map_err(|e| raw_io(self.path, e));
        }
        pixels
            .chunks(width as usize)
            .enumerate()
            .try_for_each(|(k, row)| {
                let offset = ((y0 as u64 + k as u64) * self.width + x0 as u64) * BYTES_PER_PIXEL;
                io::write_all_at(self.file, io::pixels_as_bytes(row), offset)
            })
            .map_err(|e| raw_io(self.path, e))
    }
}
