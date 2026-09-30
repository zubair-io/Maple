//! #3591: JPEG-in-TIFF YCbCr strips/tiles, using the shared zune JPEG decoder.
//! `image` rejects this photometric before its TIFF decoder can read pixels.

use std::io::Cursor;

use tiff::decoder::{ChunkType, Decoder};
use tiff::tags::Tag;
use zune_jpeg::zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions};
use zune_jpeg::JpegDecoder;

use crate::error::{Error, Result};
use crate::image::ExifOrientation;
use crate::raster::{
    container_orientation, RasterImage, MAX_BITMAP_DECODE_BYTES, MAX_RASTER_PIXELS,
};

fn bad(reason: impl std::fmt::Display) -> Error {
    Error::Decode {
        path: "<memory>".into(),
        reason: format!("JPEG-compressed TIFF decode failed: {reason}"),
    }
}

/// Return None for TIFFs handled by the existing image decoder.
pub(super) fn decode_jpeg_tiff(bytes: &[u8]) -> Result<Option<RasterImage>> {
    // TIFF's default limits also bound IFD arrays and JPEGTables while parsing.
    let mut decoder = Decoder::new(Cursor::new(bytes)).map_err(bad)?;
    if decoder
        .get_tag_u16_vec(Tag::PhotometricInterpretation)
        .map_err(bad)?
        != [6]
        || decoder
            .get_tag_u16_vec(Tag::Compression)
            .unwrap_or_else(|_| vec![1])
            != [7]
    {
        return Ok(None);
    }
    let bits = decoder.get_tag_u16_vec(Tag::BitsPerSample).map_err(bad)?;
    if !matches!(bits.len(), 1 | 3)
        || bits.iter().any(|&bit| bit != 8)
        || decoder.get_tag_u16_vec(Tag::SamplesPerPixel).map_err(bad)? != [3]
        || decoder
            .get_tag_u16_vec(Tag::PlanarConfiguration)
            .unwrap_or_else(|_| vec![1])
            != [1]
    {
        return Err(bad("expected chunky 8-bit YCbCr samples"));
    }
    let (width, height) = decoder.dimensions().map_err(bad)?;
    let pixel_count = u64::from(width) * u64::from(height);
    if pixel_count > u64::from(MAX_RASTER_PIXELS) {
        return Err(bad(format!(
            "dimensions {width}x{height} exceed the {MAX_RASTER_PIXELS} pixel limit"
        )));
    }
    let output_bytes = pixel_count * 3;
    let (chunk_width, chunk_height) = decoder.chunk_dimensions();
    if chunk_width == 0 || chunk_height == 0 {
        return Err(bad("zero-sized strip or tile"));
    }
    let (offset_tag, count_tag) = match decoder.get_chunk_type() {
        ChunkType::Strip => (Tag::StripOffsets, Tag::StripByteCounts),
        ChunkType::Tile => (Tag::TileOffsets, Tag::TileByteCounts),
    };
    let offsets = decoder.get_tag_u64_vec(offset_tag).map_err(bad)?;
    let counts = decoder.get_tag_u64_vec(count_tag).map_err(bad)?;
    let columns = width.div_ceil(chunk_width);
    let rows = height.div_ceil(chunk_height);
    let chunks = u64::from(columns) * u64::from(rows);
    if offsets.len() as u64 != chunks || counts.len() != offsets.len() {
        return Err(bad("strip/tile count does not match image dimensions"));
    }
    let tables = match decoder.find_tag(Tag::JPEGTables).map_err(bad)? {
        Some(value) => value.into_u8_vec().map_err(bad)?,
        None => Vec::new(),
    };
    if !tables.is_empty()
        && (tables.len() < 4 || !tables.starts_with(&[255, 216]) || !tables.ends_with(&[255, 217]))
    {
        return Err(bad("invalid JPEGTables markers"));
    }
    // Account for the final RGB image, compressed chunk copy, and a conservative
    // JPEG working allowance (coefficients/upsampling with 32-pixel MCU padding).
    let working_bytes = (u64::from(chunk_width.div_ceil(32)) * 32)
        .saturating_mul(u64::from(chunk_height.div_ceil(32)) * 32)
        .saturating_mul(64);
    let largest_encoded = counts.iter().copied().max().unwrap_or(0);
    if output_bytes
        .saturating_add(working_bytes)
        // JPEG ancillary metadata can also be copied from the encoded chunk.
        .saturating_add(largest_encoded.saturating_mul(3))
        .saturating_add((tables.len() as u64).saturating_mul(3))
        // TIFF's independently bounded IFD values and offset/count arrays.
        .saturating_add(8 * 1024 * 1024)
        > MAX_BITMAP_DECODE_BYTES
    {
        return Err(bad(
            "strip/tile allocations exceed the bitmap decode budget",
        ));
    }
    let mut output = vec![0; output_bytes as usize];
    for (index, (&offset, &count)) in offsets.iter().zip(&counts).enumerate() {
        let end = offset
            .checked_add(count)
            .ok_or_else(|| bad("chunk extent overflow"))?;
        let chunk = bytes
            .get(usize::try_from(offset).map_err(bad)?..usize::try_from(end).map_err(bad)?)
            .ok_or_else(|| bad("strip/tile lies outside the TIFF"))?;
        let jpeg = join_tables(&tables, chunk)?;
        let x = index as u32 % columns * chunk_width;
        let y = index as u32 / columns * chunk_height;
        let visible_width = chunk_width.min(width - x);
        let visible_height = chunk_height.min(height - y);
        let (rgb, jpeg_width) = decode_chunk(
            &jpeg,
            chunk_width,
            chunk_height,
            visible_width,
            visible_height,
        )?;
        for row in 0..visible_height as usize {
            let source_start = row * jpeg_width * 3;
            let target_start = ((y as usize + row) * width as usize + x as usize) * 3;
            let len = visible_width as usize * 3;
            output[target_start..target_start + len]
                .copy_from_slice(&rgb[source_start..source_start + len]);
        }
    }
    Ok(Some(RasterImage {
        width,
        height,
        channels: 3,
        data: output,
        orientation: ExifOrientation::from_u16(container_orientation(bytes).unwrap_or(1)),
    }))
}

fn join_tables(tables: &[u8], chunk: &[u8]) -> Result<Vec<u8>> {
    if !chunk.starts_with(&[255, 216]) {
        return Err(bad("strip/tile is missing JPEG SOI"));
    }
    if tables.is_empty() {
        return Ok(chunk.to_vec());
    }
    let mut jpeg = Vec::with_capacity(tables.len() + chunk.len() - 4);
    jpeg.extend_from_slice(&tables[..tables.len() - 2]);
    jpeg.extend_from_slice(&chunk[2..]);
    Ok(jpeg)
}

fn decode_chunk(
    bytes: &[u8],
    max_width: u32,
    max_height: u32,
    visible_width: u32,
    visible_height: u32,
) -> Result<(Vec<u8>, usize)> {
    let options = DecoderOptions::default()
        .set_strict_mode(false)
        .set_max_width(max_width as usize)
        .set_max_height(max_height as usize)
        .jpeg_set_out_colorspace(ColorSpace::RGB);
    let mut decoder = JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    decoder.decode_headers().map_err(bad)?;
    let info = decoder
        .info()
        .ok_or_else(|| bad("missing JPEG frame header"))?;
    let (width, height) = (u32::from(info.width), u32::from(info.height));
    if info.components != 3
        || width < visible_width
        || height < visible_height
        || width > max_width
        || height > max_height
    {
        return Err(bad(
            "JPEG frame dimensions/components do not match the TIFF chunk",
        ));
    }
    let rgb = decoder.decode().map_err(bad)?;
    if rgb.len() != width as usize * height as usize * 3 {
        return Err(bad("unexpected decoded JPEG RGB length"));
    }
    Ok((rgb, width as usize))
}

#[cfg(test)]
#[path = "raster_tiff_tests.rs"]
mod tests;
