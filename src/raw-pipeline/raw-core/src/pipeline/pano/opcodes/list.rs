//! Opcode-list framing shared by OpcodeList1/2/3, and the rawler read that
//! locates the blobs plus the `ActiveArea` rect anchoring their coordinates.
use super::{
    map_polynomial, parse_fix_vignette_radial, parse_gain_map, parse_warp_rectilinear,
    ActiveAreaRect, Cursor, MapPolynomialOpcode, OpcodeList3, PanoOpcode,
    OPCODE_ID_FIX_VIGNETTE_RADIAL, OPCODE_ID_GAIN_MAP, OPCODE_ID_MAP_POLYNOMIAL,
    OPCODE_ID_WARP_RECTILINEAR,
};
use rawler::decoders::{Decoder, WellKnownIFD};
use rawler::formats::tiff::IFD;
use rawler::rawsource::RawSource;
use rawler::tags::DngTag;

/// A count beyond any plausible list is corruption, not a list.
const MAXIMUM_ENTRIES: u32 = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OpcodeListKind {
    /// Applied to the raw values before linearisation. Maple executes none.
    List1 = 1,
    /// Applied after black/white normalisation, before demosaic.
    List2 = 2,
    /// Applied to the demosaiced image (lens corrections).
    List3 = 3,
}

impl OpcodeListKind {
    fn tag(self) -> DngTag {
        match self {
            Self::List1 => DngTag::OpcodeList1,
            Self::List2 => DngTag::OpcodeList2,
            Self::List3 => DngTag::OpcodeList3,
        }
    }

    fn executes(self, id: u32) -> bool {
        match self {
            Self::List1 => false,
            Self::List2 => matches!(id, OPCODE_ID_GAIN_MAP | OPCODE_ID_MAP_POLYNOMIAL),
            Self::List3 => matches!(
                id,
                OPCODE_ID_GAIN_MAP | OPCODE_ID_WARP_RECTILINEAR | OPCODE_ID_FIX_VIGNETTE_RADIAL
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SkipReason {
    /// Maple has no implementation of this id in this list.
    Unsupported,
    /// A supported id whose parameters fail validation.
    Malformed,
    /// The list framing broke here; this and every later entry are lost.
    Truncated,
    /// Parsed and valid, but deliberately not executed on this image
    /// (the 8-bit lossy transfer staging, #5081).
    NotApplied,
}

/// One list entry Maple does not execute. `id` is `None` only when the list
/// broke before the entry's id could be read; a framing break is reported as
/// required, since the lost entries may have been.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SkippedOpcode {
    pub list: OpcodeListKind,
    pub id: Option<u32>,
    pub required: bool,
    pub reason: SkipReason,
}

impl SkippedOpcode {
    fn truncated(list: OpcodeListKind, id: Option<u32>) -> Self {
        Self {
            list,
            id,
            required: true,
            reason: SkipReason::Truncated,
        }
    }
}

struct Entry<'a> {
    id: u32,
    required: bool,
    params: &'a [u8],
}

fn read_entry<'a>(cur: &mut Cursor<'a>) -> Result<Entry<'a>, Option<u32>> {
    let id = cur.read_u32().ok_or(None)?;
    let [Some(_dng_version), Some(flags), Some(param_len)] = [(); 3].map(|_| cur.read_u32()) else {
        return Err(Some(id));
    };
    let params = cur
        .pos
        .checked_add(param_len as usize)
        .and_then(|end| cur.bytes.get(cur.pos..end))
        .ok_or(Some(id))?;
    cur.pos += params.len();
    Ok(Entry {
        id,
        required: flags & 1 == 0,
        params,
    })
}

fn parse_entry(id: u32, params: &[u8]) -> Option<PanoOpcode> {
    let cur = &mut Cursor::new(params);
    let len = params.len();
    let opcode = match id {
        OPCODE_ID_GAIN_MAP => PanoOpcode::GainMap(parse_gain_map(cur, len)?),
        OPCODE_ID_WARP_RECTILINEAR => {
            PanoOpcode::WarpRectilinear(parse_warp_rectilinear(cur, len)?)
        }
        OPCODE_ID_FIX_VIGNETTE_RADIAL => {
            PanoOpcode::FixVignetteRadial(parse_fix_vignette_radial(cur, len)?)
        }
        OPCODE_ID_MAP_POLYNOMIAL => PanoOpcode::MapPolynomial(map_polynomial::parse(cur, len)?),
        _ => return None,
    };
    (cur.pos == len).then_some(opcode)
}

/// Parse an opcode-list blob (the bytes of tag 51008/51009/51022) as the
/// given list kind. Never fails: see the module-level error policy.
pub fn parse_opcode_list(bytes: &[u8], kind: OpcodeListKind) -> OpcodeList3 {
    let mut list = OpcodeList3 {
        opcodes: Vec::new(),
        skipped: Vec::new(),
    };
    let mut cur = Cursor::new(bytes);
    let Some(count) = cur.read_u32().filter(|&n| n <= MAXIMUM_ENTRIES) else {
        list.skipped.push(SkippedOpcode::truncated(kind, None));
        return list;
    };
    for _ in 0..count {
        let entry = match read_entry(&mut cur) {
            Ok(entry) => entry,
            Err(id) => {
                list.skipped.push(SkippedOpcode::truncated(kind, id));
                break;
            }
        };
        let parsed = if kind.executes(entry.id) {
            parse_entry(entry.id, entry.params).ok_or(SkipReason::Malformed)
        } else {
            Err(SkipReason::Unsupported)
        };
        match parsed {
            Ok(PanoOpcode::MapPolynomial(polynomial)) => {
                list.opcodes
                    .push(PanoOpcode::MapPolynomial(MapPolynomialOpcode {
                        required: entry.required,
                        ..polynomial
                    }))
            }
            Ok(opcode) => list.opcodes.push(opcode),
            Err(reason) => list.skipped.push(SkippedOpcode {
                list: kind,
                id: Some(entry.id),
                required: entry.required,
                reason,
            }),
        }
    }
    list
}

/// Every opcode list a RAW source carries, each with the `ActiveArea` rect
/// of the IFD it came from. A list is `None` only when its tag is absent.
#[derive(Clone, Debug, Default)]
pub struct OpcodeLists {
    pub list1: Option<(OpcodeList3, ActiveAreaRect)>,
    pub list2: Option<(OpcodeList3, ActiveAreaRect)>,
    pub list3: Option<(OpcodeList3, ActiveAreaRect)>,
}

/// Locate and parse OpcodeList1/2/3 through one rawler decoder, reading the
/// raw IFD (`WellKnownIFD::Raw`, falling back to a recursive walk from Root
/// for decoders that don't expose it). No decoder or no tag leaves that
/// list `None`.
///
/// `raw_width` / `raw_height` are the decoded raw buffer dims; each
/// [`ActiveAreaRect`] is clamped against them and falls back to full-frame
/// when the tag is absent (the DNG default).
pub fn read_opcode_lists(bytes: &[u8], ext: &str, raw_width: u32, raw_height: u32) -> OpcodeLists {
    let hint_path = format!("rawfile.{}", ext);
    let source = RawSource::new_from_slice(bytes).with_path(std::path::Path::new(&hint_path));
    let Ok(decoder) = rawler::get_decoder(&source) else {
        return OpcodeLists::default();
    };
    let read = |kind| read_list(decoder.as_ref(), kind, raw_width, raw_height);
    OpcodeLists {
        list1: read(OpcodeListKind::List1),
        list2: read(OpcodeListKind::List2),
        list3: read(OpcodeListKind::List3),
    }
}

/// `OpcodeList3` for the pano ingest path: `None` unless at least one lens
/// correction parsed.
pub fn read_opcode_list3(
    bytes: &[u8],
    ext: &str,
    raw_width: u32,
    raw_height: u32,
) -> Option<(OpcodeList3, ActiveAreaRect)> {
    read_opcode_lists(bytes, ext, raw_width, raw_height)
        .list3
        .filter(|(list, _)| !list.opcodes.is_empty())
}

fn read_list(
    decoder: &dyn Decoder,
    kind: OpcodeListKind,
    raw_width: u32,
    raw_height: u32,
) -> Option<(OpcodeList3, ActiveAreaRect)> {
    let tag = kind.tag();
    let raw_ifd = decoder.ifd(WellKnownIFD::Raw).ok().flatten();
    let root_ifd = decoder.ifd(WellKnownIFD::Root).ok().flatten();
    let (entry, ifd) = match raw_ifd
        .as_ref()
        .and_then(|ifd| ifd.get_entry(tag).map(|e| (e, ifd.as_ref())))
    {
        Some(found) => found,
        None => {
            let root = root_ifd.as_ref()?;
            let ifd = crate::dng_ifd_walker::find_ifd_with_tag(
                root.as_ref(),
                tag,
                crate::dng_ifd_walker::DEFAULT_MAX_DEPTH,
            )?;
            (ifd.get_entry(tag)?, ifd)
        }
    };
    let blob: &[u8] = match &entry.value {
        rawler::formats::tiff::Value::Undefined(v) => v.as_slice(),
        rawler::formats::tiff::Value::Byte(v) => v.as_slice(),
        _ => return None,
    };
    Some((
        parse_opcode_list(blob, kind),
        active_area(ifd, raw_width, raw_height),
    ))
}

/// ActiveArea (tag 50829: top, left, bottom, right) clamped to the decoded
/// buffer; absent ⇒ full frame (DNG default).
fn active_area(ifd: &IFD, raw_width: u32, raw_height: u32) -> ActiveAreaRect {
    ifd.get_entry(DngTag::ActiveArea)
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
        .unwrap_or_else(|| ActiveAreaRect::full(raw_width, raw_height))
}
