//! Banded pano ingest (#5552, epic #5450): [`super::decode_for_pano`]'s
//! develop chain run over horizontal row bands, so no full-frame f32 buffer
//! is ever resident. Output is bit-identical to `decode_for_pano`.
//!
//! Two passes, one demosaic:
//! 1. per band plus [`P1_HALO`] rows: linearize → demosaic → BaselineExposure
//!    → WB pre-gain. The band's own rows go to the caller's
//!    [`PanoBandScratch`], and the frame's tier-3 highlight scene samples are
//!    gathered in raster order, giving the same median the full frame uses.
//! 2. per band plus the lens warp's row reach plus [`HR_HALO`] (16-aligned):
//!    highlight recovery with that median injected, bundled vignette or
//!    OpcodeList3, DefaultCrop, DCP, then EXIF orientation as a block write
//!    into the caller's [`PanoBlockSink`].
//!
//! X-Trans (Markesteijn has no region entry) and LinearRaw sources fall back
//! to the full-frame chain and write the whole frame as one block;
//! [`PanoBandedIngest::banded`] reports which path ran.

use super::falloff::{self, FalloffCorrection};
use super::opcode_apply::{self, LensCorrectionScales};
use super::opcodes::{self, ActiveAreaRect, OpcodeList3, PanoOpcode, WarpRectilinearOpcode};
use super::{guard_decode_panics, read_pano_metadata_from_parts, PanoSourceMetadata};
use crate::{
    cancel::CancelToken,
    color::dcp,
    demosaic,
    error::Result,
    image::{CfaPattern, ColorSpace, CropRect, ExifOrientation, Image, RawImage},
    lens_profile::model::Calibration,
    linearize,
    pipeline::{
        develop::{default_crop_window, highlight_active_area},
        RenderQuality,
    },
    sensor_gain_maps::ClipGainContext,
    stages::{
        highlight_recovery::{
            apply_in_sensor_space, band_scene_samples, median_of_band_samples, FrameAnchor,
            ScenePrior,
        },
        white_balance,
    },
    types::HighlightRecoveryMode,
};

/// Pass-1 halo. RCD's bilinear ring is 6 rows and its stencil reaches 5; the
/// clip mask behind the scene samples reaches 2. Even, so every band keeps
/// the CFA phase.
const P1_HALO: u32 = 16;
/// Pass-2 highlight halo past the warp reach: three 16-px tier-2 cells (the
/// gather reaches two cells, and a buffer's edge cell has a truncated ripple
/// mask).
const HR_HALO: u32 = 48;
/// Tier-2 cell size. Pass-2 buffers start on this grid so their cells sit
/// where the full frame's do.
const CELL: u32 = 16;

/// Where pass 1 parks post-WB camera RGB until pass 2 reads it back. Rows are
/// full sensor width; pass 2's reads overlap, each band's halo re-reading its
/// neighbours' rows.
pub trait PanoBandScratch {
    /// Called once, before any rows, with the sensor dimensions. The
    /// full-frame fallback never calls it.
    fn begin(&mut self, width: u32, height: u32) -> Result<()>;
    /// Store rows `y0..y0 + rows.len() / width`.
    fn put_rows(&mut self, y0: u32, rows: &[[f32; 3]]) -> Result<()>;
    /// Fill `out` with rows `y0..y0 + out.len() / width`.
    fn read_rows(&mut self, y0: u32, out: &mut [[f32; 3]]) -> Result<()>;
}

/// Receives the developed frame in output (DefaultCrop + oriented)
/// coordinates as rectangular blocks. Each output pixel is written exactly
/// once. A 90° or 270° orientation (or a transpose) turns each band into a
/// full-height column block, so a row-major store gets one short strided
/// write per output row per band.
pub trait PanoBlockSink {
    /// Called once, before any block, with the output dimensions.
    fn begin(&mut self, width: u32, height: u32) -> Result<()>;
    /// A `width`-wide row-major block whose top-left output pixel is `(x0, y0)`.
    fn put_block(&mut self, x0: u32, y0: u32, width: u32, pixels: &[[f32; 3]]) -> Result<()>;
}

/// What [`develop_banded_for_pano`] reports besides the pixels it wrote.
#[derive(Clone, Debug)]
pub struct PanoBandedIngest {
    /// `output_dims` is the size the sink was given.
    pub metadata: PanoSourceMetadata,
    pub applied_opcodes: Vec<String>,
    pub falloff_correction: FalloffCorrection,
    /// `false` when the source took the full-frame fallback.
    pub banded: bool,
}

/// [`super::decode_for_pano`] written band by band into `sink`. `band_rows`
/// is capped at the frame height and rounded up to a multiple of 16.
pub fn develop_banded_for_pano(
    bytes: &[u8],
    ext: &str,
    band_rows: u32,
    scratch: &mut dyn PanoBandScratch,
    sink: &mut dyn PanoBlockSink,
) -> Result<PanoBandedIngest> {
    guard_decode_panics("develop_banded_for_pano", ext, || {
        let raw = crate::decode::decode_bytes(bytes, ext)?;
        let list3 = opcodes::read_opcode_list3(bytes, ext, raw.width, raw.height);
        let developed = develop_raw_banded(&raw, list3.as_ref(), band_rows, scratch, sink)?;
        Ok(PanoBandedIngest {
            metadata: read_pano_metadata_from_parts(bytes, ext, &raw),
            applied_opcodes: developed.applied_opcodes,
            falloff_correction: developed.falloff_correction,
            banded: developed.banded,
        })
    })
}

pub(super) struct BandedDevelop {
    pub applied_opcodes: Vec<String>,
    pub falloff_correction: FalloffCorrection,
    pub banded: bool,
}

pub(super) fn develop_raw_banded(
    raw: &RawImage,
    list3: Option<&(OpcodeList3, ActiveAreaRect)>,
    band_rows: u32,
    scratch: &mut dyn PanoBandScratch,
    sink: &mut dyn PanoBlockSink,
) -> Result<BandedDevelop> {
    if matches!(raw.cfa, CfaPattern::LinearRgb | CfaPattern::XTrans(_)) {
        return develop_full_frame(raw, list3, sink);
    }
    let frame = Frame::new(raw, list3)?;
    let bands = bands(
        raw.height,
        band_rows.clamp(1, raw.height.max(1)).div_ceil(CELL) * CELL,
    );
    scratch.begin(raw.width, raw.height)?;
    let median = pass1(&frame, &bands, scratch)?;
    sink.begin(frame.out_dims.0, frame.out_dims.1)?;
    pass2(&frame, &bands, median, scratch, sink)
}

fn develop_full_frame(
    raw: &RawImage,
    list3: Option<&(OpcodeList3, ActiveAreaRect)>,
    sink: &mut dyn PanoBlockSink,
) -> Result<BandedDevelop> {
    let (scene, applied_opcodes, falloff_correction) =
        super::develop_scene_linear_for_pano(raw, list3)?;
    let image = super::orient_scene_linear(scene, raw.orientation);
    sink.begin(image.width, image.height)?;
    sink.put_block(0, 0, image.width, &image.pixels)?;
    Ok(BandedDevelop {
        applied_opcodes,
        falloff_correction,
        banded: false,
    })
}

/// Per-frame inputs both passes share.
struct Frame<'a> {
    raw: &'a RawImage,
    list3: Option<&'a (OpcodeList3, ActiveAreaRect)>,
    list_corrects_falloff: bool,
    /// The bundled vignette, resolved once; `None` when the list corrects
    /// falloff itself or nothing matched.
    bundled_vignette: Option<Calibration>,
    hr_area: Option<CropRect>,
    region_top: i32,
    warp_rows: u32,
    crop: CropRect,
    out_dims: (u32, u32),
    profile: dcp::DcpProfile,
}

impl<'a> Frame<'a> {
    fn new(raw: &'a RawImage, list3: Option<&'a (OpcodeList3, ActiveAreaRect)>) -> Result<Self> {
        let (w, h) = (raw.width, raw.height);
        let crop = raw
            .crop_rect
            .and_then(|c| default_crop_window(w, h, c, 1))
            .unwrap_or(CropRect { x: 0, y: 0, w, h });
        let hr_area = highlight_active_area(raw, 1);
        let list_corrects_falloff = list3.is_some_and(|(l, _)| falloff::list_corrects_falloff(l));
        Ok(Self {
            raw,
            list3,
            list_corrects_falloff,
            bundled_vignette: (!list_corrects_falloff)
                .then(|| falloff::bundled_vignette(raw))
                .flatten(),
            hr_area,
            region_top: hr_area.map_or(0, |a| a.y.min(h)) as i32,
            warp_rows: list3.map_or(0, |(list, aa)| list_warp_rows(list, *aa)),
            crop,
            out_dims: if raw.orientation.swaps_wh() {
                (crop.h, crop.w)
            } else {
                (crop.w, crop.h)
            },
            profile: dcp::profile_for(raw)?,
        })
    }

    fn band_area(&self, y0: u32, y1: u32) -> Option<CropRect> {
        self.hr_area.map(|a| {
            let top = a.y.clamp(y0, y1);
            let bottom = a.y.saturating_add(a.h).min(y1).max(top);
            CropRect {
                x: a.x,
                y: top - y0,
                w: a.w,
                h: bottom - top,
            }
        })
    }
}

fn bands(height: u32, band_rows: u32) -> Vec<(u32, u32)> {
    (0..height)
        .step_by(band_rows as usize)
        .map(|y0| (y0, (y0 + band_rows).min(height)))
        .collect()
}

/// Rows `y0..y1` of the frame linearized, demosaiced, BaselineExposure-gained
/// and WB pre-gained — the full chain's calls on a sensor region.
fn develop_rows(raw: &RawImage, y0: u32, y1: u32) -> Image {
    let algo = crate::pipeline::bayer_kernel(
        RenderQuality::Full,
        &crate::types::AdjustmentModel::default(),
        raw,
    );
    let mosaic = linearize::sensor_linearize_region(raw, 0, y0, raw.width, y1 - y0);
    let mut img = demosaic::camera_demosaic_cancellable(
        algo,
        &mosaic,
        raw.cfa,
        raw.as_shot_neutral,
        ClipGainContext::new(raw, (0, y0), 1),
        CancelToken::never(),
    );
    if raw.baseline_exposure.abs() > 1e-4 {
        let gain = raw.baseline_exposure.exp2();
        for p in &mut img.pixels {
            p[0] *= gain;
            p[1] *= gain;
            p[2] *= gain;
        }
    }
    white_balance::apply_pre_gain(&mut img, raw.as_shot_neutral);
    img
}

fn pass1(
    frame: &Frame<'_>,
    bands: &[(u32, u32)],
    scratch: &mut dyn PanoBandScratch,
) -> Result<Option<[f32; 3]>> {
    let raw = frame.raw;
    let width = raw.width as usize;
    let mut samples = Vec::new();
    for &(y0, y1) in bands {
        let b0 = y0.saturating_sub(P1_HALO);
        let b1 = (y1 + P1_HALO).min(raw.height);
        let band = develop_rows(raw, b0, b1);
        samples.extend(band_scene_samples(
            &band,
            raw.as_shot_neutral,
            raw.baseline_exposure,
            frame.band_area(b0, b1),
            ClipGainContext::new(raw, (0, b0), 1),
            ((y0 - b0) as i32, (y1 - b0) as i32),
            b0 as i32,
            frame.region_top,
        ));
        let own = (y0 - b0) as usize * width..(y1 - b0) as usize * width;
        scratch.put_rows(y0, &band.pixels[own])?;
    }
    Ok(median_of_band_samples(samples))
}

struct FramePrior(Option<[f32; 3]>);

impl ScenePrior for FramePrior {
    fn scene(&self) -> Option<[f32; 3]> {
        self.0
    }
}

fn pass2(
    frame: &Frame<'_>,
    bands: &[(u32, u32)],
    median: Option<[f32; 3]>,
    scratch: &mut dyn PanoBandScratch,
    sink: &mut dyn PanoBlockSink,
) -> Result<BandedDevelop> {
    let raw = frame.raw;
    let prior = FramePrior(median);
    let mut applied_opcodes = Vec::new();
    let mut bundled_corrected = frame.bundled_vignette.is_some();
    let reach = frame.warp_rows.saturating_add(HR_HALO);
    for &(y0, y1) in bands {
        let h0 = y0.saturating_sub(reach) / CELL * CELL;
        let h1 = y1
            .saturating_add(reach)
            .div_ceil(CELL)
            .saturating_mul(CELL)
            .min(raw.height);
        let mut band = Image::new(raw.width, h1 - h0, ColorSpace::CameraNativeLinearRgb);
        scratch.read_rows(h0, &mut band.pixels)?;
        apply_in_sensor_space(
            &mut band,
            HighlightRecoveryMode::default(),
            raw.as_shot_neutral,
            raw.baseline_exposure,
            frame.band_area(h0, h1),
            Some(FrameAnchor {
                prior: &prior,
                origin: (0, h0 as i32),
                active_origin: frame.hr_area.map_or((0, 0), |a| (a.x as i32, a.y as i32)),
            }),
            ClipGainContext::new(raw, (0, h0), 1),
        );
        if let Some(calibration) = &frame.bundled_vignette {
            bundled_corrected &=
                falloff::apply_vignette_windowed(raw, calibration, &mut band, h0, raw.height);
        }
        if let Some((list, aa)) = frame.list3 {
            applied_opcodes = opcode_apply::apply_opcode_list3_windowed(
                &mut band,
                list,
                *aa,
                LensCorrectionScales::FULL,
                h0,
            );
        }
        write_cropped_rows(frame, &band, h0, (y0, y1), sink)?;
    }
    Ok(BandedDevelop {
        applied_opcodes,
        falloff_correction: if frame.list_corrects_falloff {
            FalloffCorrection::Opcode
        } else if bundled_corrected {
            FalloffCorrection::BundledProfile
        } else {
            FalloffCorrection::None
        },
        banded: true,
    })
}

/// DefaultCrop, DCP and orientation for the band's own rows `rows` of a
/// pass-2 buffer whose top row is absolute `h0`.
fn write_cropped_rows(
    frame: &Frame<'_>,
    band: &Image,
    h0: u32,
    rows: (u32, u32),
    sink: &mut dyn PanoBlockSink,
) -> Result<()> {
    let CropRect { x, y, w, h } = frame.crop;
    let (r0, r1) = (rows.0.max(y), rows.1.min(y + h));
    if r0 >= r1 {
        return Ok(());
    }
    let (src_w, crop_w) = (band.width as usize, w as usize);
    let mut cropped = Image::new(w, r1 - r0, ColorSpace::CameraNativeLinearRgb);
    for (dst, row) in cropped.pixels.chunks_mut(crop_w).zip(r0..r1) {
        let start = (row - h0) as usize * src_w + x as usize;
        dst.copy_from_slice(&band.pixels[start..start + crop_w]);
    }
    dcp::apply_colorimetry_in_place(&mut cropped, &frame.profile)?;
    if frame.raw.orientation == ExifOrientation::Normal {
        return sink.put_block(0, r0 - y, w, &cropped.pixels);
    }
    let block = orient_block(&cropped, frame.raw.orientation, r0 - y, (w, h));
    sink.put_block(block.x0, block.y0, block.width, &block.pixels)
}

struct OrientedBlock {
    x0: u32,
    y0: u32,
    width: u32,
    pixels: Vec<[f32; 3]>,
}

/// `rows` holds source rows `sy0..` of a `crop.0 × crop.1` image; returns
/// the same pixels as the output block EXIF orientation `orient` maps them to.
fn orient_block(
    rows: &Image,
    orient: ExifOrientation,
    sy0: u32,
    crop: (u32, u32),
) -> OrientedBlock {
    let (sw, n) = (rows.width, rows.height);
    let corners = [(0, sy0), (sw - 1, sy0 + n - 1)].map(|(sx, sy)| dest_of(orient, sx, sy, crop));
    let x0 = corners[0].0.min(corners[1].0);
    let y0 = corners[0].1.min(corners[1].1);
    let width = if orient.swaps_wh() { n } else { sw };
    let mut pixels = vec![[0.0; 3]; rows.pixels.len()];
    for (k, row) in rows.pixels.chunks(sw as usize).enumerate() {
        for (sx, p) in row.iter().enumerate() {
            let (xp, yp) = dest_of(orient, sx as u32, sy0 + k as u32, crop);
            pixels[((yp - y0) * width + (xp - x0)) as usize] = *p;
        }
    }
    OrientedBlock {
        x0,
        y0,
        width,
        pixels,
    }
}

/// Where source pixel `(sx, sy)` of a `sw × sh` image lands under `orient`:
/// the inverse of [`super::orient_scene_linear`]'s destination → source map.
fn dest_of(orient: ExifOrientation, sx: u32, sy: u32, (sw, sh): (u32, u32)) -> (u32, u32) {
    match orient {
        ExifOrientation::Normal => (sx, sy),
        ExifOrientation::HorizontalFlip => (sw - 1 - sx, sy),
        ExifOrientation::Rotate180 => (sw - 1 - sx, sh - 1 - sy),
        ExifOrientation::VerticalFlip => (sx, sh - 1 - sy),
        ExifOrientation::Transpose => (sy, sx),
        ExifOrientation::Rotate90 => (sh - 1 - sy, sx),
        ExifOrientation::Transverse => (sh - 1 - sy, sw - 1 - sx),
        ExifOrientation::Rotate270 => (sy, sw - 1 - sx),
    }
}

/// Rows the list's warps read above or below each output row, summed because
/// each warp resamples the previous one's result.
fn list_warp_rows(list: &OpcodeList3, aa: ActiveAreaRect) -> u32 {
    list.opcodes
        .iter()
        .filter_map(|op| match op {
            PanoOpcode::WarpRectilinear(warp) => Some(warp_row_reach(warp, aa)),
            _ => None,
        })
        .fold(0, u32::saturating_add)
}

/// A bound on |source row − output row| over the active area for every plane
/// of `warp` at full strength, plus the cubic gather's two rows. Unlike
/// [`opcode_apply::warp_rectilinear_reach_px`]'s sampled plane-0 radial
/// estimate, band edges need a true bound including the tangential terms. R is the
/// farthest-corner distance, so every active pixel has `u = |d|/R ≤ 1` (the
/// `min(rr, 1)` clamp never engages), `|dy| ≤ R·u`, `rr + 2dny² ≤ 3` and
/// `2|dnx·dny| ≤ 1`. Hence
/// `|sy − y| ≤ R·max_u |f(u)| + R(3|kt0| + |kt1|)` with
/// `f(u) = u(ratio(u²) − 1) = c0·u + c1·u³ + c2·u⁵ + c3·u⁷`. The max is
/// taken on a dense grid plus the Lipschitz slack `L·h/2`,
/// `L = |c0| + 3|c1| + 5|c2| + 7|c3|`, so it bounds rather than estimates.
fn warp_row_reach(warp: &WarpRectilinearOpcode, aa: ActiveAreaRect) -> u32 {
    const STEPS: usize = 1 << 16;
    let (aw, ah) = (aa.width as f64, aa.height as f64);
    let (cx, cy) = (warp.center_x * aw, warp.center_y * ah);
    let radius = f64::hypot(cx.abs().max((aw - cx).abs()), cy.abs().max((ah - cy).abs()));
    let set_for = |p: usize| warp.planes[p.min(warp.planes.len() - 1)];
    let green = set_for(1);
    let reach = (0..3)
        .map(|p| {
            let s = opcode_apply::blend_warp_toward_identity(&set_for(p), &green, 1.0, 1.0);
            let c = [s.kr[0] - 1.0, s.kr[1], s.kr[2], s.kr[3]];
            let f = |u: f64| {
                let uu = u * u;
                u * (c[0] + uu * (c[1] + uu * (c[2] + uu * c[3])))
            };
            let lipschitz = c[0].abs() + 3.0 * c[1].abs() + 5.0 * c[2].abs() + 7.0 * c[3].abs();
            let sampled = (0..=STEPS)
                .map(|i| f(i as f64 / STEPS as f64).abs())
                .fold(0.0, f64::max);
            let radial = sampled + lipschitz * 0.5 / STEPS as f64;
            radius * (radial + 3.0 * s.kt[0].abs() + s.kt[1].abs())
        })
        .fold(0.0, f64::max);
    (reach.ceil() as u32).saturating_add(2)
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_fixtures;
