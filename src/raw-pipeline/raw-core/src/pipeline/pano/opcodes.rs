//! DNG OpcodeList3 parsing for the pano ingest path (#1159).
//!
//! The DJI pano fixtures carry their lens corrections as DNG opcodes in
//! `OpcodeList3` (tag 51022, raw IFD): the L2D-20c writes a `GainMap`
//! (vignette / shading) followed by a `WarpRectilinear` (geometric
//! distortion + lateral CA); the L3D-100c writes `WarpRectilinear` only.
//! Neither body ships `OpcodeList1`/`OpcodeList2`. Uncorrected, the
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
//! ## Error policy
//!
//! Unknown opcode ids are **skipped with a count**, never an error —
//! including ids whose spec `flags` bit 0 (optional) is unset, where the
//! DNG spec says a reader "should not process the image". For pano
//! ingest a slightly-imperfect stitch input beats refusing the frame;
//! the deviation is deliberate and scoped to this path. A structurally
//! truncated / malformed blob parses to `None` and application no-ops —
//! same degrade-to-uncorrected policy as
//! [`crate::color::profile_gain_table_map::ProfileGainTableMap::from_bytes`].

use rawler::decoders::WellKnownIFD;
use rawler::rawsource::RawSource;
use rawler::tags::DngTag;

/// DNG opcode ids this module understands (DNG 1.4 § "Opcode Lists").
const OPCODE_ID_WARP_RECTILINEAR: u32 = 1;
const OPCODE_ID_GAIN_MAP: u32 = 9;

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

/// A parsed opcode this path knows how to apply, in list order.
#[derive(Clone, Debug, PartialEq)]
pub enum PanoOpcode {
    GainMap(GainMapOpcode),
    WarpRectilinear(WarpRectilinearOpcode),
}

/// A parsed `OpcodeList3`: the supported opcodes **in list order** (the
/// DNG spec mandates in-order execution) plus a count of skipped
/// unknown-id opcodes for diagnostics.
#[derive(Clone, Debug, PartialEq)]
pub struct OpcodeList3 {
    pub opcodes: Vec<PanoOpcode>,
    pub skipped_unknown: u32,
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

    fn skip(&mut self, n: usize) -> Option<()> {
        if self.bytes.len() - self.pos < n {
            return None;
        }
        self.pos += n;
        Some(())
    }
}

/// Parse an opcode-list blob (the bytes of tag 51008/51009/51022).
/// Returns `None` only on structural corruption; unknown opcode ids are
/// counted and skipped (see module docs for the policy).
pub fn parse_opcode_list(bytes: &[u8]) -> Option<OpcodeList3> {
    let mut cur = Cursor::new(bytes);
    let count = cur.read_u32()?;
    // A count beyond any plausible list is corruption, not a list — bail
    // before the loop can spin on garbage.
    if count > 1024 {
        return None;
    }
    let mut opcodes = Vec::new();
    let mut skipped_unknown = 0u32;
    for _ in 0..count {
        let id = cur.read_u32()?;
        let _dng_version = cur.read_u32()?;
        let _flags = cur.read_u32()?;
        let param_len = cur.read_u32()? as usize;
        let param_end = cur.pos.checked_add(param_len)?;
        if param_end > cur.bytes.len() {
            return None; // truncated parameter block
        }
        match id {
            OPCODE_ID_GAIN_MAP => {
                opcodes.push(PanoOpcode::GainMap(parse_gain_map(&mut cur, param_len)?));
            }
            OPCODE_ID_WARP_RECTILINEAR => {
                opcodes.push(PanoOpcode::WarpRectilinear(parse_warp_rectilinear(
                    &mut cur, param_len,
                )?));
            }
            _ => {
                skipped_unknown += 1;
                cur.skip(param_len)?;
            }
        }
        if cur.pos != param_end {
            return None; // parameter length disagrees with the payload
        }
    }
    Some(OpcodeList3 {
        opcodes,
        skipped_unknown,
    })
}

fn parse_gain_map(cur: &mut Cursor, param_len: usize) -> Option<GainMapOpcode> {
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

fn parse_warp_rectilinear(cur: &mut Cursor, param_len: usize) -> Option<WarpRectilinearOpcode> {
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

/// Locate and parse `OpcodeList3` for a RAW source, plus the
/// `ActiveArea` rect that anchors the opcode coordinate system.
///
/// Reads the raw IFD via rawler (`WellKnownIFD::Raw`, falling back to a
/// recursive walk from Root for decoders that don't expose it).
/// Best-effort like the pano metadata pass: any miss — no decoder, no
/// tag, malformed blob — degrades to `None` (frame develops
/// uncorrected) rather than failing the decode.
///
/// `raw_width` / `raw_height` are the decoded raw buffer dims; the
/// returned [`ActiveAreaRect`] is clamped against them and falls back to
/// full-frame when the tag is absent (the DNG default).
pub fn read_opcode_list3(
    bytes: &[u8],
    ext: &str,
    raw_width: u32,
    raw_height: u32,
) -> Option<(OpcodeList3, ActiveAreaRect)> {
    let hint_path = format!("rawfile.{}", ext);
    let source = RawSource::new_from_slice(bytes).with_path(std::path::Path::new(&hint_path));
    let decoder = rawler::get_decoder(&source).ok()?;

    // The raw image's IFD is the one that carries OpcodeList3 + ActiveArea.
    let raw_ifd = decoder.ifd(WellKnownIFD::Raw).ok().flatten();
    let root_ifd = decoder.ifd(WellKnownIFD::Root).ok().flatten();
    let (entry, ifd) = match raw_ifd
        .as_ref()
        .and_then(|ifd| ifd.get_entry(DngTag::OpcodeList3).map(|e| (e, ifd.as_ref())))
    {
        Some(found) => found,
        None => {
            let root = root_ifd.as_ref()?;
            let ifd = crate::dng_ifd_walker::find_ifd_with_tag(
                root.as_ref(),
                DngTag::OpcodeList3,
                crate::dng_ifd_walker::DEFAULT_MAX_DEPTH,
            )?;
            (ifd.get_entry(DngTag::OpcodeList3)?, ifd)
        }
    };
    let blob: &[u8] = match &entry.value {
        rawler::formats::tiff::Value::Undefined(v) => v.as_slice(),
        rawler::formats::tiff::Value::Byte(v) => v.as_slice(),
        _ => return None,
    };
    let list = parse_opcode_list(blob)?;
    if list.opcodes.is_empty() {
        return None;
    }

    // ActiveArea (tag 50829: top, left, bottom, right) from the same IFD,
    // clamped to the decoded buffer; absent ⇒ full frame (DNG default).
    let aa = ifd
        .get_entry(DngTag::ActiveArea)
        .and_then(|e| {
            if e.value.count() < 4 {
                return None;
            }
            let top = e.value.force_u32(0).min(raw_height);
            let left = e.value.force_u32(1).min(raw_width);
            let bottom = e.value.force_u32(2).clamp(top, raw_height);
            let right = e.value.force_u32(3).clamp(left, raw_width);
            if bottom <= top || right <= left {
                return None;
            }
            Some(ActiveAreaRect {
                top,
                left,
                width: right - left,
                height: bottom - top,
            })
        })
        .unwrap_or_else(|| ActiveAreaRect::full(raw_width, raw_height));
    Some((list, aa))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialize a GainMap opcode body (big-endian) for blob-building.
    fn gain_map_params(points_v: u32, points_h: u32, map_planes: u32, gains: &[f32]) -> Vec<u8> {
        let mut p = Vec::new();
        for v in [0u32, 0, 24, 32, 0, 3, 1, 1, points_v, points_h] {
            p.extend_from_slice(&v.to_be_bytes());
        }
        for v in [0.5f64, 0.25, 0.0, 0.0] {
            p.extend_from_slice(&v.to_be_bytes());
        }
        p.extend_from_slice(&map_planes.to_be_bytes());
        for g in gains {
            p.extend_from_slice(&g.to_be_bytes());
        }
        p
    }

    fn opcode_entry(id: u32, params: &[u8]) -> Vec<u8> {
        let mut e = Vec::new();
        e.extend_from_slice(&id.to_be_bytes());
        e.extend_from_slice(&0x0104_0000u32.to_be_bytes()); // DNG version
        e.extend_from_slice(&1u32.to_be_bytes()); // flags: optional
        e.extend_from_slice(&(params.len() as u32).to_be_bytes());
        e.extend_from_slice(params);
        e
    }

    fn blob(entries: &[Vec<u8>]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&(entries.len() as u32).to_be_bytes());
        for e in entries {
            b.extend_from_slice(e);
        }
        b
    }

    fn warp_params(sets: &[[f64; 6]], cx: f64, cy: f64) -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&(sets.len() as u32).to_be_bytes());
        for s in sets {
            for v in s {
                p.extend_from_slice(&v.to_be_bytes());
            }
        }
        p.extend_from_slice(&cx.to_be_bytes());
        p.extend_from_slice(&cy.to_be_bytes());
        p
    }

    #[test]
    fn parses_gain_map_fields_exactly() {
        let gains: Vec<f32> = (0..2 * 3 * 1).map(|i| 1.0 + i as f32 * 0.1).collect();
        let b = blob(&[opcode_entry(9, &gain_map_params(2, 3, 1, &gains))]);
        let list = parse_opcode_list(&b).expect("parses");
        assert_eq!(list.skipped_unknown, 0);
        assert_eq!(list.opcodes.len(), 1);
        let PanoOpcode::GainMap(gm) = &list.opcodes[0] else {
            panic!("expected GainMap, got {:?}", list.opcodes[0]);
        };
        assert_eq!((gm.top, gm.left, gm.bottom, gm.right), (0, 0, 24, 32));
        assert_eq!((gm.plane, gm.planes), (0, 3));
        assert_eq!((gm.row_pitch, gm.col_pitch), (1, 1));
        assert_eq!((gm.points_v, gm.points_h, gm.map_planes), (2, 3, 1));
        assert_eq!((gm.spacing_v, gm.spacing_h), (0.5, 0.25));
        assert_eq!((gm.origin_v, gm.origin_h), (0.0, 0.0));
        assert_eq!(gm.gains, gains);
    }

    #[test]
    fn parses_warp_rectilinear_multi_plane_and_center() {
        let sets = [
            [1.0, -0.06, 0.03, -0.05, 0.001, -0.002],
            [1.001, -0.061, 0.031, -0.051, 0.0, 0.0],
            [1.002, -0.062, 0.032, -0.052, 0.0, 0.0],
        ];
        let b = blob(&[opcode_entry(1, &warp_params(&sets, 0.5, 0.45))]);
        let list = parse_opcode_list(&b).expect("parses");
        let PanoOpcode::WarpRectilinear(w) = &list.opcodes[0] else {
            panic!("expected WarpRectilinear");
        };
        assert_eq!(w.planes.len(), 3);
        assert_eq!(w.planes[0].kr, [1.0, -0.06, 0.03, -0.05]);
        assert_eq!(w.planes[0].kt, [0.001, -0.002]);
        assert_eq!(w.planes[2].kr, [1.002, -0.062, 0.032, -0.052]);
        assert_eq!((w.center_x, w.center_y), (0.5, 0.45));
    }

    #[test]
    fn unknown_opcode_ids_are_skipped_with_count_in_list_order() {
        let gains = vec![1.0f32; 4];
        let unknown = opcode_entry(42, &[0u8; 12]);
        let b = blob(&[
            opcode_entry(9, &gain_map_params(2, 2, 1, &gains)),
            unknown,
            opcode_entry(1, &warp_params(&[[1.0, 0.0, 0.0, 0.0, 0.0, 0.0]], 0.5, 0.5)),
        ]);
        let list = parse_opcode_list(&b).expect("parses around unknown id");
        assert_eq!(list.skipped_unknown, 1);
        assert_eq!(list.opcodes.len(), 2);
        assert!(matches!(list.opcodes[0], PanoOpcode::GainMap(_)));
        assert!(matches!(list.opcodes[1], PanoOpcode::WarpRectilinear(_)));
    }

    #[test]
    fn truncated_or_malformed_blobs_parse_to_none() {
        let gains = vec![1.0f32; 4];
        let good = blob(&[opcode_entry(9, &gain_map_params(2, 2, 1, &gains))]);
        assert!(parse_opcode_list(&good[..good.len() - 2]).is_none(), "truncated gains");
        assert!(parse_opcode_list(&good[..7]).is_none(), "truncated header");
        assert!(parse_opcode_list(&[]).is_none(), "empty blob");
        // Parameter length lies about the payload size.
        let mut bad_len = good.clone();
        bad_len[4 + 12..4 + 16].copy_from_slice(&9999u32.to_be_bytes());
        assert!(parse_opcode_list(&bad_len).is_none(), "param length overrun");
        // Gain count disagrees with the parameter block size.
        let short_gains = blob(&[opcode_entry(9, &gain_map_params(4, 4, 3, &gains))]);
        assert!(parse_opcode_list(&short_gains).is_none(), "lattice/len mismatch");
        // Warp with a zero coefficient-set count.
        let zero_sets = blob(&[opcode_entry(1, &warp_params(&[], 0.5, 0.5))]);
        assert!(parse_opcode_list(&zero_sets).is_none(), "warp N=0");
    }

    #[test]
    fn implausible_opcode_count_rejected() {
        let mut b = Vec::new();
        b.extend_from_slice(&u32::MAX.to_be_bytes());
        assert!(parse_opcode_list(&b).is_none());
    }

    /// Fixture-gated: the real DJI blobs parse to the documented shapes.
    /// This is the parse-level evidence for #1159 — the L2D-20c carries
    /// GainMap + WarpRectilinear (in that order), the L3D-100c
    /// WarpRectilinear only, and neither ships OpcodeList1/2.
    #[test]
    fn parses_real_dji_opcode_lists() {
        for (rel, expect_gain_map) in [
            ("../../../test-fixtures/raws/pano_01/PANO0001.DNG", true),
            ("../../../test-fixtures/raws/pano_00/0000.DNG", false),
        ] {
            let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
            if !path.exists() {
                eprintln!("skip: {} (pano fixtures not present)", path.display());
                continue;
            }
            let bytes = std::fs::read(&path).expect("read fixture");
            let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
            let (list, aa) =
                read_opcode_list3(&bytes, "dng", raw.width, raw.height).expect("OpcodeList3");
            assert_eq!(list.skipped_unknown, 0, "{}", path.display());
            if expect_gain_map {
                assert_eq!(list.opcodes.len(), 2);
                let PanoOpcode::GainMap(gm) = &list.opcodes[0] else {
                    panic!("L2D-20c list order: GainMap first");
                };
                assert_eq!((gm.points_v, gm.points_h, gm.map_planes), (32, 32, 3));
                assert_eq!((aa.width, aa.height), (5280, 3956));
                assert_eq!((gm.right, gm.bottom), (aa.width, aa.height));
                // Vignette shape: every gain ≥ 1, corners gain more than
                // the lattice center.
                assert!(gm.gains.iter().all(|&g| (1.0..4.0).contains(&g)));
                let at = |v: u32, h: u32| {
                    gm.gains[((v * gm.points_h + h) * gm.map_planes) as usize]
                };
                let center = at(gm.points_v / 2, gm.points_h / 2);
                for (cv, ch) in [(0, 0), (0, 31), (31, 0), (31, 31)] {
                    assert!(
                        at(cv, ch) > center,
                        "corner ({cv},{ch}) gain {} must exceed center {}",
                        at(cv, ch),
                        center
                    );
                }
                let PanoOpcode::WarpRectilinear(_) = &list.opcodes[1] else {
                    panic!("L2D-20c list order: WarpRectilinear second");
                };
            } else {
                assert_eq!(list.opcodes.len(), 1);
            }
            let PanoOpcode::WarpRectilinear(w) = &list.opcodes[list.opcodes.len() - 1] else {
                panic!("WarpRectilinear expected last in both fixtures");
            };
            assert_eq!(w.planes.len(), 3);
            for p in &w.planes {
                assert!((p.kr[0] - 1.0).abs() < 0.05, "kr0 ≈ 1, got {}", p.kr[0]);
                assert!(p.kr[1].abs() < 0.1, "|kr1| small, got {}", p.kr[1]);
                assert_eq!(p.kt, [0.0, 0.0], "DJI ships no tangential terms");
            }
            assert_eq!((w.center_x, w.center_y), (0.5, 0.5));
        }
    }
}
