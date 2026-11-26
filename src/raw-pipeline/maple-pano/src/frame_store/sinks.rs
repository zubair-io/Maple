//! The develop's two outputs into the store: the pass-1 scratch and the
//! frame file, plus the frame's mip.

use std::fs::File;
use std::path::Path;

use raw_core::{PanoBandScratch, PanoBlockSink};

use super::mip::MipBuilder;
use super::{half_rows, io, raw_io, SCRATCH_BYTES_PER_PIXEL, STORED_BYTES_PER_PIXEL};

pub(super) struct FileScratch<'a> {
    pub(super) file: &'a File,
    pub(super) path: &'a Path,
    pub(super) width: u64,
}

impl PanoBandScratch for FileScratch<'_> {
    fn begin(&mut self, width: u32, _height: u32) -> raw_core::Result<()> {
        self.width = width as u64;
        Ok(())
    }

    fn put_rows(&mut self, y0: u32, rows: &[[f32; 3]]) -> raw_core::Result<()> {
        let offset = y0 as u64 * self.width * SCRATCH_BYTES_PER_PIXEL;
        io::write_all_at(self.file, io::pixels_as_bytes(rows), offset)
            .map_err(|e| raw_io(self.path, e))
    }

    fn read_rows(&mut self, y0: u32, out: &mut [[f32; 3]]) -> raw_core::Result<()> {
        let offset = y0 as u64 * self.width * SCRATCH_BYTES_PER_PIXEL;
        io::read_exact_at(self.file, io::pixels_as_bytes_mut(out), offset)
            .map_err(|e| raw_io(self.path, e))
    }
}

pub(super) struct FileSink<'a> {
    pub(super) file: &'a File,
    pub(super) path: &'a Path,
    pub(super) planned: (u32, u32),
    pub(super) developed: Option<(u32, u32)>,
    pub(super) width: u64,
    /// The frame's box-filtered mip, built as blocks arrive.
    pub(super) mip: Option<MipBuilder>,
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
        if let Some(mip) = self.mip.as_mut() {
            mip.add_block(x0, y0, width, pixels);
        }
        if width as u64 == self.width && x0 == 0 {
            let offset = y0 as u64 * self.width * STORED_BYTES_PER_PIXEL;
            return io::write_all_at(self.file, &half_rows::encode(pixels), offset)
                .map_err(|e| raw_io(self.path, e));
        }
        pixels
            .chunks(width as usize)
            .enumerate()
            .try_for_each(|(k, row)| {
                let offset =
                    ((y0 as u64 + k as u64) * self.width + x0 as u64) * STORED_BYTES_PER_PIXEL;
                io::write_all_at(self.file, &half_rows::encode(row), offset)
            })
            .map_err(|e| raw_io(self.path, e))
    }
}
