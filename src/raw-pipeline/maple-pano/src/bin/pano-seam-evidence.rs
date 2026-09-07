//! Export fixed motion-ROI evidence using the production solve and warp (#3243).
//!
//! Regions are authored before comparing seam candidates. Re-run the unchanged
//! default stitch, verify its ROI pixels exactly match the supplied scene-linear
//! candidate, then export fully covering source crops before any seam blending.
//! This avoids a second, subtly different projection/colour implementation in
//! Python. Only the diagnostic output directory is written; originals and their
//! sidecars are read-only. The app/FFI pipeline does not invoke this executable.

use std::error::Error;
use std::path::{Path, PathBuf};

use clap::Parser;
use maple_pano::ingest::{ingest_file, PlanarImage, ValidityMask};
use maple_pano::stitch::{quantize_to_u16, stitch, StitchOptions, StitchSuccess};
use maple_pano::warp::warp_to_canvas_strip;
use serde::{Deserialize, Serialize};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Parser)]
#[command(about = "Export coherent-source panorama ghosting evidence (#3243)")]
struct Args {
    /// Same ordered RAW paths used for the panorama comparison.
    #[arg(required = true)]
    inputs: Vec<PathBuf>,
    /// Existing scene-linear PNG from the default Voronoi stitch.
    #[arg(long)]
    candidate: PathBuf,
    /// JSON array of {name, subject, rect:[x,y,width,height]} in native pixels.
    #[arg(long)]
    regions: PathBuf,
    /// A new directory; existing paths are rejected to preserve prior evidence.
    #[arg(long)]
    out_dir: PathBuf,
}

#[derive(Deserialize, Serialize)]
struct Region {
    name: String,
    subject: String,
    rect: [u32; 4],
}

#[derive(Serialize)]
struct Source {
    name: String,
    path: String,
}

#[derive(Serialize)]
struct EvidenceRoi {
    #[serde(flatten)]
    region: Region,
    sources: Vec<Source>,
}

fn main() -> Result<()> {
    let args = Args::parse();
    if args.out_dir.exists() {
        return Err("output directory already exists".into());
    }
    let regions: Vec<Region> = serde_json::from_slice(&std::fs::read(&args.regions)?)?;
    let (dimensions, expected) = candidate_crops(&args.candidate, &regions)?;
    let mut last_stage = None;
    let result = stitch(
        &args.inputs,
        &StitchOptions::default(),
        |stage, _| {
            if last_stage != Some(stage) {
                eprintln!("seam evidence: stage {stage}");
                last_stage = Some(stage);
            }
        },
        || false,
    )
    .map_err(|error| error.to_string())?;
    let StitchSuccess::Rotation(outcome) = result else {
        return Err("tile strategy does not exercise graph-cut seams".into());
    };
    let canvas = &outcome.comp_report.canvas;
    if dimensions != (canvas.width, canvas.height) {
        return Err("candidate canvas differs from the current production solve".into());
    }
    // Match all measured candidate pixels exactly, including quantization. A
    // stale candidate or differing calibration/geometry cannot furnish evidence.
    for (region, previous) in regions.iter().zip(&expected) {
        let crop = crop(&outcome.image, region.rect).ok_or("candidate ROI has holes")?;
        let actual = quantize_to_u16(&crop, false);
        if &actual != previous {
            return Err(format!("ROI {} differs from the supplied candidate", region.name).into());
        }
    }
    drop(expected);
    drop(outcome.image);
    std::fs::create_dir_all(&args.out_dir)?;
    let mut evidence: Vec<EvidenceRoi> = regions
        .into_iter()
        .map(|region| EvidenceRoi {
            region,
            sources: Vec::new(),
        })
        .collect();
    let mut kept_index = 0;
    for (input_index, camera) in outcome.solution.cameras.iter().enumerate() {
        let Some(camera) = camera else { continue };
        let frame = ingest_file(&args.inputs[input_index])?;
        let gain = outcome.comp_report.gains[kept_index];
        kept_index += 1;
        for (roi_index, entry) in evidence.iter_mut().enumerate() {
            let [x, y, w, h] = entry.region.rect;
            let strip = warp_to_canvas_strip(
                &frame.image,
                camera,
                canvas,
                gain,
                outcome.local_corrections[input_index].as_ref(),
                y,
                y + h,
            );
            let Some(source) = crop(&strip, [x, 0, w, h]) else {
                continue; // Only complete subject crops may be coherent sources.
            };
            let name = format!("source-{input_index:03}");
            let path = format!("roi-{roi_index:03}-{name}.png");
            write_png(&args.out_dir.join(&path), &source)?;
            entry.sources.push(Source { name, path });
        }
        eprintln!("seam evidence: source {} complete", input_index + 1);
    }
    for entry in &evidence {
        if entry.sources.len() < 2 {
            return Err(format!(
                "ROI {} has fewer than two fully covering source frames",
                entry.region.name
            )
            .into());
        }
    }
    let manifest = serde_json::json!({
        "version": 1,
        "canvas_size": [canvas.width, canvas.height],
        "encoding": "scene-linear Rec.2020, clamped RGB16 PNG",
        "candidate_roi_pixels_verified_exact": true,
        "motion_affected": outcome.solution.motion_affected,
        "inputs": args.inputs,
        "rois": evidence,
    });
    std::fs::write(
        args.out_dir.join("evidence.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    Ok(())
}

/// Read only the requested RGB16 rectangles from the candidate's PNG row stream.
/// A 256MP full canvas would otherwise allocate >1.5 GB before the solve starts.
fn candidate_crops(path: &Path, regions: &[Region]) -> Result<((u32, u32), Vec<Vec<u16>>)> {
    let decoder = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path)?));
    let mut reader = decoder.read_info()?;
    let info = reader.info();
    let dimensions = (info.width, info.height);
    if info.color_type != png::ColorType::Rgb
        || info.bit_depth != png::BitDepth::Sixteen
        || info.interlaced
    {
        return Err("candidate must be the non-interlaced RGB16 scene-linear PNG".into());
    }
    validate_regions(regions, dimensions)?;
    let mut crops = vec![Vec::new(); regions.len()];
    let mut row_index = 0;
    while let Some(row) = reader.next_row()? {
        for (region, pixels) in regions.iter().zip(&mut crops) {
            let [x, y, w, h] = region.rect;
            if row_index >= y && row_index < y + h {
                let start = x as usize * 6;
                let end = (x + w) as usize * 6;
                pixels.extend(
                    row.data()[start..end]
                        .chunks_exact(2)
                        .map(|value| u16::from_be_bytes([value[0], value[1]])),
                );
            }
        }
        row_index += 1;
    }
    if row_index != dimensions.1 {
        return Err("candidate PNG is incomplete".into());
    }
    Ok((dimensions, crops))
}

fn validate_regions(regions: &[Region], (width, height): (u32, u32)) -> Result<()> {
    let mut names = std::collections::HashSet::new();
    if regions.is_empty() {
        return Err("at least one fixed motion ROI is required".into());
    }
    for region in regions {
        let [x, y, w, h] = region.rect;
        if region.name.trim().is_empty()
            || !names.insert(&region.name)
            || region.subject.trim().is_empty()
            || w < 2
            || h < 2
            || x.checked_add(w).is_none_or(|end| end > width)
            || y.checked_add(h).is_none_or(|end| end > height)
        {
            return Err("regions need unique names, subjects, and in-bounds rectangles".into());
        }
    }
    Ok(())
}

fn crop(image: &PlanarImage, [x0, y0, w, h]: [u32; 4]) -> Option<PlanarImage> {
    if x0.checked_add(w)? > image.width() || y0.checked_add(h)? > image.height() {
        return None;
    }
    let mut r = Vec::with_capacity((w * h) as usize);
    let mut g = Vec::with_capacity(r.capacity());
    let mut b = Vec::with_capacity(r.capacity());
    for y in y0..y0 + h {
        for x in x0..x0 + w {
            if !image.validity.get(x, y) {
                return None;
            }
            let i = (y * image.width() + x) as usize;
            r.push(image.r[i]);
            g.push(image.g[i]);
            b.push(image.b[i]);
        }
    }
    Some(PlanarImage::from_planes(
        w,
        h,
        r,
        g,
        b,
        ValidityMask::new_filled(w, h, true),
    ))
}

fn write_png(path: &Path, image: &PlanarImage) -> Result<()> {
    let pixels = quantize_to_u16(image, false);
    // `crop` rejected any invalid source sample. Alpha retains that coverage
    // contract instead of silently flattening an uncovered warp to RGB black.
    let rgba: Vec<u16> = pixels
        .chunks_exact(3)
        .flat_map(|rgb| [rgb[0], rgb[1], rgb[2], u16::MAX])
        .collect();
    let buffer: image::ImageBuffer<image::Rgba<u16>, _> =
        image::ImageBuffer::from_raw(image.width(), image.height(), rgba)
            .ok_or("invalid crop buffer")?;
    buffer.save(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_preserves_coordinates_and_rejects_incomplete_source_subjects() {
        let mut image = PlanarImage::from_planes(
            4,
            3,
            (0..12).map(|value| value as f32).collect(),
            vec![0.0; 12],
            vec![0.0; 12],
            ValidityMask::new_filled(4, 3, true),
        );
        assert_eq!(crop(&image, [1, 1, 2, 2]).unwrap().r, [5.0, 6.0, 9.0, 10.0]);
        image.validity.set(2, 2, false);
        assert!(crop(&image, [1, 1, 2, 2]).is_none());
        assert!(crop(&image, [u32::MAX, 0, 2, 2]).is_none());
    }
}
