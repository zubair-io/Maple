//! DNG opcode-list parsing (OpcodeList1/2/3) for every decode, first written
//! for the pano ingest path (#1159).
//!
//! The DJI pano fixtures carry their lens corrections as DNG opcodes in
//! `OpcodeList3` (tag 51022, raw IFD): the L2D-20c writes a `GainMap`
//! (vignette / shading) followed by a `WarpRectilinear` (geometric
//! distortion + lateral CA); the L3D-100c writes `WarpRectilinear` only.
//! Neither body ships `OpcodeList1`/`OpcodeList2` (lossy and Pixel DNGs do:
//! see `crate::sensor_gain_maps`). Uncorrected, the
//! distortion inflates pano reprojection residuals far past the spec
//! §5.3 gates and the vignette bands at stitch seams (stitching spec
//! §5.1 requires vignette correction *before* matching).
//!
//! This module is the **parser**: opcode-list blob → typed opcodes, plus
//! the rawler read that locates the blob and the `ActiveArea` rect that
//! anchors the opcode coordinate system. The pixel-domain application
//! lives in [`super::opcode_apply`].
//!
//! ## Binary layout (DNG 1.4 spec, "Opcode Lists")
//!
//! The blob is **big-endian regardless of the container byte order**
//! (verified against the little-endian DJI files — their opcode blobs
//! are big-endian):
//!
//! ```text
//! u32 count
//! count × {
//!   u32 OpcodeID, u32 DNG version, u32 flags, u32 parameter byte length,
//!   [parameter bytes]
//! }
//! ```
//!
//! `GainMap` (id 9) parameters: `u32 Top, Left, Bottom, Right, Plane,
//! Planes, RowPitch, ColPitch, MapPointsV, MapPointsH`, `f64 MapSpacingV,
//! MapSpacingH, MapOriginV, MapOriginH`, `u32 MapPlanes`, then
//! `MapPointsV × MapPointsH × MapPlanes` f32 gains (row-major, plane
//! innermost).
//!
//! `WarpRectilinear` (id 1) parameters: `u32 N` (per-plane coefficient
//! sets), `N × 6 f64` (kr0, kr1, kr2, kr3, kt0, kt1), then `2 × f64`
//! optical center (cx, cy) in normalized image coordinates.
//!
//! `FixVignetteRadial` (id 3) parameters: `5 × f64` (k0…k4), then `2 × f64`
//! optical center (cx, cy) in normalized image coordinates — a fixed
//! 56-byte block (dng_sdk `dng_vignette_radial_params::kNumTerms * 8 + 16`).
//!
//! ## Error policy (#4647)
//!
//! A list never fails as a whole. Each entry this list kind does not
//! execute — an unsupported id, an id that is not valid in this list, or a
//! supported id whose parameters are malformed — is recorded as a
//! [`SkippedOpcode`] and parsing resumes at the next entry, so one bad entry
//! cannot drop the lens corrections around it. Only broken framing (a
//! truncated header or parameter block, an implausible count) stops the
//! walk, keeping the entries already parsed and recording the break. The
//! DNG spec says a reader should not process an image with a required
//! (`flags` bit 0 clear) opcode it cannot apply; Maple renders it anyway and
//! surfaces those entries on `RawImage::skipped_required_opcodes`.

mod list;
mod map_polynomial;
#[cfg(test)]
pub use list::parse_opcode_list;
pub use list::{read_opcode_list3, read_opcode_lists, OpcodeListKind, SkipReason, SkippedOpcode};
pub use map_polynomial::MapPolynomialOpcode;

/// DNG opcode ids this module understands (DNG 1.4 § "Opcode Lists").
const OPCODE_ID_WARP_RECTILINEAR: u32 = 1;
const OPCODE_ID_FIX_VIGNETTE_RADIAL: u32 = 3;
pub(crate) const OPCODE_ID_MAP_POLYNOMIAL: u32 = 8;
const OPCODE_ID_GAIN_MAP: u32 = 9;

/// Number of radial coefficients in a `FixVignetteRadial` opcode
/// (dng_sdk `dng_vignette_radial_params::kNumTerms`).
const VIGNETTE_RADIAL_TERMS: usize = 5;

/// `GainMap` opcode (id 9): a bilinearly-interpolated gain lattice
/// multiplied over a pixel-area rectangle. All rectangle coordinates are
/// relative to the **ActiveArea** origin; the lattice positions are in
/// normalized coordinates over the full ActiveArea (see
/// [`super::opcode_apply`] for the exact dng_sdk-matched sampling).
#[derive(Clone, Debug, PartialEq)]
pub struct GainMapOpcode {
    /// Area rows `[top, bottom)`, ActiveArea-relative.
    pub top: u32,
    pub bottom: u32,
    /// Area cols `[left, right)`, ActiveArea-relative.
    pub left: u32,
    pub right: u32,
    /// First image plane the gain applies to, and how many.
    pub plane: u32,
    pub planes: u32,
    /// Row / column step inside the area (1 = every pixel).
    pub row_pitch: u32,
    pub col_pitch: u32,
    /// Lattice dimensions (vertical × horizontal point counts).
    pub points_v: u32,
    pub points_h: u32,
    /// Lattice spacing in normalized image coordinates.
    pub spacing_v: f64,
    pub spacing_h: f64,
    /// Lattice origin in normalized image coordinates.
    pub origin_v: f64,
    pub origin_h: f64,
    /// Gains per lattice point (1 = broadcast, or per-plane).
    pub map_planes: u32,
    /// `points_v × points_h × map_planes` gains, row-major, plane innermost.
    pub gains: Vec<f32>,
}

/// One plane's `WarpRectilinear` coefficient set.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WarpPlaneParams {
    /// Radial terms: `f(r) = kr0 + kr1·r² + kr2·r⁴ + kr3·r⁶`.
    pub kr: [f64; 4],
    /// Tangential terms (kt0, kt1).
    pub kt: [f64; 2],
}

/// `WarpRectilinear` opcode (id 1): per-output-pixel resample where the
/// model maps **corrected (output) positions to uncorrected (input)
/// positions** (DNG 1.4; matches dng_sdk `GetSrcPixelPosition`).
#[derive(Clone, Debug, PartialEq)]
pub struct WarpRectilinearOpcode {
    /// One entry per coefficient set; when fewer sets than image planes,
    /// plane `p` uses set `min(p, len - 1)` (N = 1 means "common").
    pub planes: Vec<WarpPlaneParams>,
    /// Optical center in normalized ActiveArea coordinates.
    pub center_x: f64,
    pub center_y: f64,
}

/// `FixVignetteRadial` opcode (id 3): a radial gain applied about the
/// optical center, `g(t) = 1 + k0·t + k1·t² + k2·t³ + k3·t⁴ + k4·t⁵` where
/// `t` is the squared distance from the center normalized so `t = 1` at
/// the farthest corner of the active area (dng_sdk
/// `dng_vignette_radial_function::Evaluate`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FixVignetteRadialOpcode {
    /// Radial gain coefficients k0…k4.
    pub k: [f64; VIGNETTE_RADIAL_TERMS],
    /// Optical center in normalized ActiveArea coordinates.
    pub center_x: f64,
    pub center_y: f64,
}

/// A parsed opcode this path knows how to apply, in list order.
#[derive(Clone, Debug, PartialEq)]
pub enum PanoOpcode {
    GainMap(GainMapOpcode),
    WarpRectilinear(WarpRectilinearOpcode),
    FixVignetteRadial(FixVignetteRadialOpcode),
    MapPolynomial(MapPolynomialOpcode),
}

/// A parsed opcode list (any of OpcodeList1/2/3, despite the name): the
/// opcodes this list kind executes **in list order** (the DNG spec mandates
/// in-order execution), plus every entry it does not, in list order.
#[derive(Clone, Debug, PartialEq)]
pub struct OpcodeList3 {
    pub opcodes: Vec<PanoOpcode>,
    pub skipped: Vec<SkippedOpcode>,
}

/// The `ActiveArea` rectangle (tag 50829) expressed against the decoded
/// raw buffer: opcode coordinates are ActiveArea-relative (dng_sdk
/// applies List3 to its stage-3 image, which *is* the active-area crop;
/// raw-core demosaics the full sensor and crops later, so the apply step
/// offsets into this rect instead).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ActiveAreaRect {
    pub top: u32,
    pub left: u32,
    pub width: u32,
    pub height: u32,
}

impl ActiveAreaRect {
    /// Whole-image fallback for sources without an `ActiveArea` tag.
    pub fn full(width: u32, height: u32) -> Self {
        Self {
            top: 0,
            left: 0,
            width,
            height,
        }
    }
}

/// Big-endian cursor over the opcode blob. Every read is bounds-checked;
/// `None` means the blob is truncated / malformed.
struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn read_u32(&mut self) -> Option<u32> {
        let b = self.bytes.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(u32::from_be_bytes(b.try_into().expect("4-byte slice")))
    }

    fn read_f32(&mut self) -> Option<f32> {
        self.read_u32().map(f32::from_bits)
    }

    fn read_f64(&mut self) -> Option<f64> {
        let b = self.bytes.get(self.pos..self.pos + 8)?;
        self.pos += 8;
        Some(f64::from_be_bytes(b.try_into().expect("8-byte slice")))
    }
}

fn parse_gain_map(cur: &mut Cursor<'_>, param_len: usize) -> Option<GainMapOpcode> {
    let top = cur.read_u32()?;
    let left = cur.read_u32()?;
    let bottom = cur.read_u32()?;
    let right = cur.read_u32()?;
    let plane = cur.read_u32()?;
    let planes = cur.read_u32()?;
    let row_pitch = cur.read_u32()?;
    let col_pitch = cur.read_u32()?;
    let points_v = cur.read_u32()?;
    let points_h = cur.read_u32()?;
    let spacing_v = cur.read_f64()?;
    let spacing_h = cur.read_f64()?;
    let origin_v = cur.read_f64()?;
    let origin_h = cur.read_f64()?;
    let map_planes = cur.read_u32()?;
    let n_gains = (points_v as usize)
        .checked_mul(points_h as usize)?
        .checked_mul(map_planes as usize)?;
    // Header (76 bytes) + gains must exactly fill the parameter block.
    if param_len != 76 + n_gains * 4 {
        return None;
    }
    // Degenerate lattices / zero strides can't be sampled or stepped.
    if points_v == 0
        || points_h == 0
        || map_planes == 0
        || planes == 0
        || row_pitch == 0
        || col_pitch == 0
        || bottom <= top
        || right <= left
        || !(spacing_v.is_finite() && spacing_h.is_finite())
        || !(origin_v.is_finite() && origin_h.is_finite())
        || spacing_v <= 0.0
        || spacing_h <= 0.0
    {
        return None;
    }
    let mut gains = Vec::with_capacity(n_gains);
    for _ in 0..n_gains {
        let g = cur.read_f32()?;
        if !g.is_finite() {
            return None;
        }
        gains.push(g);
    }
    Some(GainMapOpcode {
        top,
        bottom,
        left,
        right,
        plane,
        planes,
        row_pitch,
        col_pitch,
        points_v,
        points_h,
        spacing_v,
        spacing_h,
        origin_v,
        origin_h,
        map_planes,
        gains,
    })
}

fn parse_warp_rectilinear(cur: &mut Cursor<'_>, param_len: usize) -> Option<WarpRectilinearOpcode> {
    let n = cur.read_u32()? as usize;
    // u32 N + N×6×f64 + 2×f64 center must exactly fill the block.
    if n == 0 || param_len != 4 + n * 48 + 16 {
        return None;
    }
    let mut planes = Vec::with_capacity(n);
    for _ in 0..n {
        let kr = [
            cur.read_f64()?,
            cur.read_f64()?,
            cur.read_f64()?,
            cur.read_f64()?,
        ];
        let kt = [cur.read_f64()?, cur.read_f64()?];
        if !(kr.iter().all(|v| v.is_finite()) && kt.iter().all(|v| v.is_finite())) {
            return None;
        }
        planes.push(WarpPlaneParams { kr, kt });
    }
    let center_x = cur.read_f64()?;
    let center_y = cur.read_f64()?;
    if !(center_x.is_finite() && center_y.is_finite()) {
        return None;
    }
    Some(WarpRectilinearOpcode {
        planes,
        center_x,
        center_y,
    })
}

/// `FixVignetteRadial` (id 3): five radial gain coefficients plus the
/// optical center, in a fixed-size block. dng_sdk rejects any other
/// parameter length outright (`ThrowBadFormat`); we degrade to `None`,
/// which the caller treats as a malformed list (module-level error policy).
fn parse_fix_vignette_radial(
    cur: &mut Cursor<'_>,
    param_len: usize,
) -> Option<FixVignetteRadialOpcode> {
    // 5×f64 coefficients + 2×f64 center must exactly fill the block.
    if param_len != VIGNETTE_RADIAL_TERMS * 8 + 16 {
        return None;
    }
    let mut k = [0.0f64; VIGNETTE_RADIAL_TERMS];
    for slot in k.iter_mut() {
        *slot = cur.read_f64()?;
    }
    // dng_sdk reads the horizontal center first, then the vertical one —
    // same order as `WarpRectilinear` above.
    let center_x = cur.read_f64()?;
    let center_y = cur.read_f64()?;
    if !(k.iter().all(|v| v.is_finite()) && center_x.is_finite() && center_y.is_finite()) {
        return None;
    }
    Some(FixVignetteRadialOpcode {
        k,
        center_x,
        center_y,
    })
}

#[cfg(test)]
mod tests;
