use std::borrow::Cow;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::error::PanoError;
use crate::render::PngMetadata;

pub fn write_owner_png(
    path: &Path,
    width: u32,
    height: u32,
    owner: &[u16],
) -> Result<(), PanoError> {
    debug_assert_eq!(owner.len(), width as usize * height as usize);
    let file = std::fs::File::create(path).map_err(|e| PanoError::io(path, e))?;
    let mut info = png::Info::with_size(width, height);
    info.color_type = png::ColorType::Grayscale;
    info.bit_depth = png::BitDepth::Sixteen;
    let enc = png::Encoder::with_info(std::io::BufWriter::new(file), info)?;
    let mut writer = enc.write_header()?;
    let mut bytes = Vec::with_capacity(owner.len() * 2);
    for &v in owner {
        bytes.extend_from_slice(&v.to_be_bytes());
    }
    writer.write_image_data(&bytes)?;
    Ok(())
}

/// Incremental 16-bit RGB PNG encoder: rows go in as they are produced, so
/// no whole-image sample buffer exists (#5451). Decoded pixels do not depend
/// on how the rows are split across `write_rows` calls.
///
/// The file is written as `<path>.partial` and renamed into place only once
/// every byte reached the disk, so a failed or abandoned save never leaves a
/// truncated PNG at `path` (the Apple app writes straight into a watched
/// library folder).
pub(crate) struct PngRowWriter {
    stream: Option<png::StreamWriter<'static, BufWriter<LatchedFile>>>,
    write_error: Arc<Mutex<Option<std::io::Error>>>,
    partial: PathBuf,
    path: PathBuf,
    row_samples: usize,
    rows_left: u32,
    be: Vec<u8>,
}

/// png 0.17 writes the zlib trailer and `IEND` from `Drop` impls that discard
/// errors, so every byte goes through this writer, which keeps the first
/// failure for [`PngRowWriter::finish`] to report.
struct Latched<W> {
    file: W,
    error: Arc<Mutex<Option<std::io::Error>>>,
}

type LatchedFile = Latched<File>;

impl<W: Write> Write for Latched<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.file.write(buf).inspect_err(|e| self.latch(e))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush().inspect_err(|e| self.latch(e))
    }
}

impl<W> Latched<W> {
    fn latch(&self, e: &std::io::Error) {
        let mut slot = self.error.lock().unwrap_or_else(|p| p.into_inner());
        slot.get_or_insert_with(|| std::io::Error::new(e.kind(), e.to_string()));
    }
}

/// IDAT chunk size: large chunks keep a 256 MP pano to a few hundred chunks.
const IDAT_CHUNK_BYTES: usize = 1 << 20;

impl PngRowWriter {
    /// Pass `meta.tag_srgb = true` and/or `meta.exif_blob = Some(blob)` for
    /// the sRGB-display-encoded pano output; leave both unset for the
    /// scene-linear carrier.
    pub(crate) fn create(
        path: &Path,
        width: u32,
        height: u32,
        meta: &PngMetadata,
    ) -> Result<Self, PanoError> {
        let partial = partial_path(path);
        let file = File::create(&partial).map_err(|e| PanoError::io(&partial, e))?;
        let write_error = Arc::new(Mutex::new(None));
        let latched = Latched {
            file,
            error: Arc::clone(&write_error),
        };
        let mut info = png::Info::with_size(width, height);
        info.color_type = png::ColorType::Rgb;
        info.bit_depth = png::BitDepth::Sixteen;
        if meta.tag_srgb {
            // The `sRGB` chunk alone is enough for Apple ImageIO /
            // CGImageSource to identify the colour space as sRGB.
            info.srgb = Some(png::SrgbRenderingIntent::Perceptual);
        }
        if let Some(blob) = &meta.exif_blob {
            info.exif_metadata = Some(Cow::Owned(blob.clone()));
        }
        let mut writer = Self {
            stream: None,
            write_error,
            partial,
            path: path.to_path_buf(),
            row_samples: width as usize * 3,
            rows_left: height,
            be: Vec::new(),
        };
        writer.stream = Some(
            png::Encoder::with_info(BufWriter::new(latched), info)?
                .write_header()?
                .into_stream_writer_with_size(IDAT_CHUNK_BYTES)?,
        );
        Ok(writer)
    }

    /// Append whole rows of interleaved RGB samples, top to bottom.
    pub(crate) fn write_rows(&mut self, samples: &[u16]) -> Result<(), PanoError> {
        let rows = samples.len() / self.row_samples;
        if samples.len() % self.row_samples != 0 || rows > self.rows_left as usize {
            return Err(PanoError::InvalidOptions(format!(
                "PNG rows: {} samples is not whole rows of {} within the {} rows left",
                samples.len(),
                self.row_samples,
                self.rows_left
            )));
        }
        self.rows_left -= rows as u32;
        let stream = self.stream.as_mut().expect("stream lives until finish");
        // PNG 16-bit samples are big-endian; convert a bounded chunk at a time.
        for chunk in samples.chunks(self.row_samples * 64) {
            self.be.clear();
            self.be.extend(chunk.iter().flat_map(|v| v.to_be_bytes()));
            stream
                .write_all(&self.be)
                .map_err(|e| PanoError::io(&self.partial, e))?;
        }
        Ok(())
    }

    /// Finish the PNG and move it into place. Fails, leaving nothing at the
    /// destination, if any row is missing or any byte failed to write.
    pub(crate) fn finish(mut self) -> Result<(), PanoError> {
        if self.rows_left != 0 {
            return Err(PanoError::InvalidOptions(format!(
                "PNG finished with {} rows still unwritten",
                self.rows_left
            )));
        }
        // Dropping the stream writes the zlib trailer and IEND and flushes
        // the buffer; their errors surface only through the latch.
        self.stream
            .take()
            .expect("stream lives until finish")
            .finish()?;
        if let Some(e) = self
            .write_error
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            return Err(PanoError::io(&self.partial, e));
        }
        std::fs::rename(&self.partial, &self.path).map_err(|e| PanoError::io(&self.path, e))
    }
}

impl Drop for PngRowWriter {
    fn drop(&mut self) {
        // Only an unfinished or failed save still owns its `.partial` file.
        drop(self.stream.take());
        let _ = std::fs::remove_file(&self.partial);
    }
}

pub(crate) fn partial_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".partial");
    path.with_file_name(name)
}

/// Write an interleaved 16-bit RGB buffer as a PNG in one call; see
/// [`PngRowWriter::create`] for `meta`.
pub fn write_frame_png(
    path: &Path,
    width: u32,
    height: u32,
    data: &[u16],
    meta: &PngMetadata,
) -> Result<(), PanoError> {
    debug_assert_eq!(data.len(), width as usize * height as usize * 3);
    let mut writer = PngRowWriter::create(path, width, height, meta)?;
    writer.write_rows(data)?;
    writer.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Accepts `budget` bytes, then fails every write; counts what it took.
    struct FailAfter {
        budget: usize,
        written: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Write for FailAfter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.budget < buf.len() {
                return Err(std::io::Error::other("disk full"));
            }
            self.budget -= buf.len();
            self.written
                .fetch_add(buf.len(), std::sync::atomic::Ordering::Relaxed);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn tmp(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "maple_png_rows_{label}_{}_{n}.png",
            std::process::id()
        ))
    }

    /// png 0.17 writes the stream's tail from `Drop` and swallows the error;
    /// the latch is what lets `finish` see a failure in those last bytes.
    #[test]
    fn latch_catches_a_failure_in_the_png_tail() {
        let pixels: Vec<u8> = (0..64 * 64 * 6).map(|i| (i * 31 % 251) as u8).collect();
        let encode = |budget: usize| {
            let written = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let error = Arc::new(Mutex::new(None));
            let sink = Latched {
                file: FailAfter {
                    budget,
                    written: Arc::clone(&written),
                },
                error: Arc::clone(&error),
            };
            let mut enc = png::Encoder::new(BufWriter::new(sink), 64, 64);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Sixteen);
            let mut stream = enc.write_header().unwrap().into_stream_writer().unwrap();
            stream.write_all(&pixels).unwrap();
            let finished = stream.finish().is_ok();
            let latched = error.lock().unwrap().is_some();
            (
                finished,
                latched,
                written.load(std::sync::atomic::Ordering::Relaxed),
            )
        };
        let (_, latched, complete) = encode(usize::MAX);
        assert!(!latched);
        let (finished, latched, _) = encode(complete - 4);
        assert!(finished, "png reports success despite the lost tail");
        assert!(latched, "latch must record the failed tail write");
    }

    #[test]
    fn finished_png_lands_at_its_path_and_leaves_no_partial() {
        let path = tmp("ok");
        let mut w = PngRowWriter::create(&path, 3, 2, &PngMetadata::default()).unwrap();
        w.write_rows(&[1u16; 9]).unwrap();
        w.write_rows(&[2u16; 9]).unwrap();
        w.finish().unwrap();
        assert!(path.exists());
        assert!(!partial_path(&path).exists());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn abandoned_or_short_png_leaves_nothing_behind() {
        let abandoned = tmp("abandoned");
        let mut w = PngRowWriter::create(&abandoned, 3, 2, &PngMetadata::default()).unwrap();
        w.write_rows(&[1u16; 9]).unwrap();
        drop(w);
        assert!(!abandoned.exists() && !partial_path(&abandoned).exists());

        let short = tmp("short");
        let mut w = PngRowWriter::create(&short, 3, 2, &PngMetadata::default()).unwrap();
        w.write_rows(&[1u16; 9]).unwrap();
        assert!(w.finish().is_err());
        assert!(!short.exists() && !partial_path(&short).exists());
    }

    #[test]
    fn rows_must_be_whole_and_within_the_image() {
        let path = tmp("rows");
        let mut w = PngRowWriter::create(&path, 3, 2, &PngMetadata::default()).unwrap();
        assert!(w.write_rows(&[0u16; 10]).is_err(), "partial row");
        assert!(
            w.write_rows(&[0u16; 27]).is_err(),
            "more rows than the image"
        );
    }
}
