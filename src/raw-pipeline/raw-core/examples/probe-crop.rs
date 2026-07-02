//! Probe per-fixture crop metadata as seen by rawler + our DNG-tag fallback.
//!
//! Run via:
//!   cargo run --release -p raw-core --example probe-crop -- <path/to.raw> [...]
//!
//! Prints rawler's reported `width × height`, `active_area`, `crop_area`,
//! plus the EXIF orientation that survives the metadata pass. Used as a
//! sanity check while wiring up #375 (output-crop / orientation).

use rawler::decoders::{RawDecodeParams, WellKnownIFD};
use rawler::rawsource::RawSource;
use rawler::tags::DngTag;
use std::path::Path;

fn main() {
    for arg in std::env::args().skip(1) {
        let path = Path::new(&arg);
        let bytes =
            std::fs::read(path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
        // Lowercase: rawler's format detection uses the extension on the
        // hint path; some decoders disambiguate by case-folded suffix.
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_else(|| "dng".to_string());
        let source =
            RawSource::new_from_slice(&bytes).with_path(Path::new(&format!("rawfile.{}", ext)));
        let params = RawDecodeParams::default();
        let raw = match rawler::decode(&source, &params) {
            Ok(r) => r,
            Err(e) => {
                println!(
                    "\n=== {} ===\n  rawler decode FAILED: {:?}",
                    path.display(),
                    e
                );
                continue;
            }
        };
        let decoder = rawler::get_decoder(&source).ok();
        let exif_orient = decoder
            .as_ref()
            .and_then(|d| d.raw_metadata(&source, &params).ok())
            .and_then(|md| md.exif.orientation);
        let root_ifd = decoder
            .as_ref()
            .and_then(|d| d.ifd(WellKnownIFD::Root).ok().flatten());
        let (dco, dcs, aa, orient_tag) = if let Some(ifd) = root_ifd.as_ref() {
            let dco = ifd
                .get_entry(DngTag::DefaultCropOrigin)
                .map(|e| (e.value.force_f32(0), e.value.force_f32(1)));
            let dcs = ifd
                .get_entry(DngTag::DefaultCropSize)
                .map(|e| (e.value.force_f32(0), e.value.force_f32(1)));
            let aa = ifd.get_entry(DngTag::ActiveArea).map(|e| {
                [
                    e.value.force_u32(0),
                    e.value.force_u32(1),
                    e.value.force_u32(2),
                    e.value.force_u32(3),
                ]
            });
            let orient_tag = ifd
                .get_entry(rawler::tags::ExifTag::Orientation)
                .map(|e| e.value.force_u16(0));
            (dco, dcs, aa, orient_tag)
        } else {
            (None, None, None, None)
        };
        println!("=== {} ===", path.display());
        println!("  rawler width×height : {} × {}", raw.width, raw.height);
        println!("  rawler active_area  : {:?}", raw.active_area);
        println!("  rawler crop_area    : {:?}", raw.crop_area);
        println!("  rawler orientation  : {:?}", raw.orientation);
        println!(
            "  exif orientation    : {:?}  ifd tag={:?}",
            exif_orient, orient_tag
        );
        println!("  DNG ActiveArea       : {:?}", aa);
        println!("  DNG DefaultCropOrigin: {:?}", dco);
        println!("  DNG DefaultCropSize  : {:?}", dcs);
    }
}
