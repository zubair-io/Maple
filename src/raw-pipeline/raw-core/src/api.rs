//! Public API surface per spec `docs/spec/12-maple-apps-spec.md` §02.
//!
//! This module is the stable face of `raw-core` that `raw-ffi`, `raw-wasm`,
//! and `maple-cli` consume. It is intentionally shell-agnostic:
//!
//! * No filesystem access — every entry point takes or returns bytes.
//! * No wall-clock dependency, no unseeded RNG, no non-associative parallel
//!   reductions (see `docs/best-practices.md` "Rust core → determinism").
//! * Never panics on bad input: returns [`Error`] instead.
//!
//! Naming uses the spec's shape (`Rendered`, `Rgba`, `Sidecar`, …). The
//! existing internal types (`RawImage`, `AdjustmentModel`, the scene-linear
//! `Image` buffer) remain untouched — this module is a thin façade.

use crate::error::{Error, Result};
use crate::id::MapleId;
use crate::image::{ExifOrientation, RawImage};
use crate::xmp::AdjustmentModel;

use rawler::decoders::RawDecodeParams;
use rawler::formats::tiff::{Rational, SRational};
use rawler::rawsource::RawSource;

// ─── Types ────────────────────────────────────────────────────────────────

/// A rendered display-encoded sRGB 8-bit RGB buffer.
///
/// Produced by [`apply`]; consumed by [`encode`], [`histogram`], [`waveform`].
#[derive(Clone, Debug)]
pub struct Rendered {
    pub width: u32,
    pub height: u32,
    /// Packed RGB u8 (length = 3 × width × height), sRGB primaries + transfer.
    pub rgb: Vec<u8>,
}

/// RGBA8 buffer. Used for thumbnails/previews per spec §02.
#[derive(Clone, Debug)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    /// Packed RGBA u8 (length = 4 × width × height), sRGB primaries + transfer.
    /// Alpha is always 255 — `raw-core` does not produce transparent pixels.
    pub rgba: Vec<u8>,
}

/// Output container formats for [`encode`].
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum OutFmt {
    Jpeg,
    Png,
    Webp,
    Heic,
    Tiff,
}

/// Encoder options. Fields default to safe, spec-aligned values.
#[derive(Clone, Debug)]
pub struct EncodeOpts {
    /// JPEG/WebP quality in [1, 100]. Ignored for PNG/TIFF. Default 92
    /// (matches spec §04 reference JPEG quality).
    pub quality: u8,
    /// Tag the output as sRGB where the container supports it (PNG sRGB
    /// chunk, JPEG APP2 profile). Default `true`.
    pub embed_srgb: bool,
}

impl Default for EncodeOpts {
    fn default() -> Self {
        Self { quality: 92, embed_srgb: true }
    }
}

/// RGB + L histograms of a rendered image, 256 bins each.
#[derive(Clone, Debug)]
pub struct Histogram {
    pub r: [u32; 256],
    pub g: [u32; 256],
    pub b: [u32; 256],
    /// Rec.709 luma (`0.2126 R + 0.7152 G + 0.0722 B`).
    pub l: [u32; 256],
}

/// RGB waveform: for each output column, the per-bin count of pixels whose
/// channel value falls into that bin. Laid out column-major so the UI can
/// memcpy one column at a time.
#[derive(Clone, Debug)]
pub struct Waveform {
    /// Number of output columns (matches the image width unless downsampled).
    pub width: u32,
    /// Number of vertical bins per channel. Default 256.
    pub bins: u32,
    /// Length = `width * bins`. Column `x` occupies `[x*bins .. x*bins+bins)`.
    pub r: Vec<u32>,
    pub g: Vec<u32>,
    pub b: Vec<u32>,
}

/// Flag value per spec §05: `maple:flag = "pick" | "reject"`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Flag {
    Pick,
    Reject,
}

/// Parsed EXIF payload. All fields are `Option` because the tag set a camera
/// emits is vendor-dependent.
#[derive(Clone, Debug, Default)]
pub struct Exif {
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens_make: Option<String>,
    pub lens_model: Option<String>,
    /// ISO speed (EXIF `ISOSpeedRatings` or `ISOSpeed`).
    pub iso: Option<u32>,
    /// Shutter speed in seconds. Derived from EXIF `ExposureTime` (Rational).
    pub shutter_s: Option<f32>,
    /// F-number. Derived from EXIF `FNumber` (Rational).
    pub aperture: Option<f32>,
    /// Focal length in millimetres.
    pub focal_mm: Option<f32>,
    /// Capture time as an EXIF string ("YYYY:MM:DD HH:MM:SS"). Preserved
    /// verbatim — timezone handling is shell-side.
    pub captured_at: Option<String>,
    pub gps: Option<ExifGps>,
    pub orientation: ExifOrientation,
}

/// Decimal GPS coordinates. Spec §07 stores these as GeoJSON Point in
/// MongoDB; the core returns raw degrees.
#[derive(Copy, Clone, Debug)]
pub struct ExifGps {
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub altitude_m: Option<f32>,
}

/// Dublin Core metadata block per spec §05. All fields optional (or empty
/// `Vec` for `subject`) — camera-direct imports rarely populate any of them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DublinCore {
    /// `dc:title`.
    pub title: Option<String>,
    /// `dc:description`.
    pub description: Option<String>,
    /// `dc:subject` — keywords. Written as an `rdf:Bag`. Sorted
    /// alphabetically before emission so XMP output is byte-deterministic
    /// across runs.
    pub subject: Vec<String>,
    /// `dc:rights`.
    pub rights: Option<String>,
    /// `dc:creator`.
    pub creator: Option<String>,
}

/// Typed XMP sidecar per spec §05.
///
/// T9 scope: full `crs:` / `xmp:` / `dc:` / `maple:` merge per spec §05
/// "Write policy". Merge-on-read overlays `maple:*` adjustments on top of
/// `crs:*`; dual-write emits every adjustment in both namespaces so
/// Lightroom round-trips without losing Maple's native fields. Unknown
/// `<rdf:Description>` children are captured in [`Sidecar::raw_xml`] and
/// emitted verbatim on write, so third-party namespaces survive one
/// round-trip.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Sidecar {
    /// `crs:*` adjustments (after merge-on-read overlay of
    /// any `maple:*` duplicates).
    pub adj: AdjustmentModel,
    /// Stable image id per spec §04. Computed via [`crate::id::maple_id`]
    /// from file bytes + EXIF. [`xmp_write`] emits `maple:id="<hex>"` only
    /// when present; [`xmp_read`] parses it back via [`MapleId::from_hex`].
    pub id: Option<MapleId>,
    /// `xmp:Rating`, 0..5. `None` = unrated.
    pub rating: Option<u8>,
    /// `xmp:Label` — the XMP colour word ("red", "blue", …). Not enumerated
    /// at this layer; shells can normalise.
    pub label: Option<String>,
    /// `maple:flag`.
    pub flag: Option<Flag>,
    /// Dublin Core block (`dc:*`).
    pub dc: DublinCore,
    /// Verbatim XML for round-trip preservation of unknown `crs:*` / `lr:*` /
    /// third-party tags. On read, [`xmp_read`] captures unrecognised
    /// `<rdf:Description>` child elements here as their reserialised UTF-8
    /// bytes; on write, [`xmp_write`] drops those bytes back into
    /// `<rdf:RDF>` verbatim. This preserves semantics but *not* namespace
    /// prefix assignment — reserialisation may rebind prefixes to the
    /// declarations on our `<rdf:Description>`.
    pub raw_xml: Option<Vec<u8>>,
}

// ─── Decode / apply ──────────────────────────────────────────────────────

/// Decode a RAW from an in-memory byte slice.
///
/// The `ext` hint is a lowercase file extension (`"dng"`, `"cr2"`, `"arw"`,
/// …). Spec §02 lists this entry as `decode_raw(bytes)`, but rawler's format
/// dispatcher needs the hint when magic is ambiguous; taking it here avoids a
/// fragile sniff. Shells pass through the extension they already have.
pub fn decode_raw(bytes: &[u8], ext: &str) -> Result<RawImage> {
    crate::decode::decode_bytes(bytes, ext)
}

/// Extract EXIF metadata from a RAW byte slice without running the full
/// decode pipeline.
///
/// Reuses rawler's metadata pass (the same path `decode_raw` uses for
/// orientation + baseline exposure). Cheap compared to a full RAW decode.
pub fn read_exif(bytes: &[u8], ext: &str) -> Result<Exif> {
    let hint_path = format!("rawfile.{}", ext);
    let source = RawSource::new_from_slice(bytes)
        .with_path(std::path::Path::new(&hint_path));
    let params = RawDecodeParams::default();
    let decoder = rawler::get_decoder(&source).map_err(|e| Error::Decode {
        path: std::path::PathBuf::from(&hint_path),
        reason: e.to_string(),
    })?;
    let md = decoder.raw_metadata(&source, &params).map_err(|e| Error::Decode {
        path: std::path::PathBuf::from(&hint_path),
        reason: e.to_string(),
    })?;
    let exif = &md.exif;

    // Rawler's Rational is (n, d). Convert to f32 on extract.
    let rat_f32 = |r: &Rational| -> f32 {
        if r.d == 0 { 0.0 } else { r.n as f32 / r.d as f32 }
    };
    let srat_f32 = |r: &SRational| -> f32 {
        if r.d == 0 { 0.0 } else { r.n as f32 / r.d as f32 }
    };

    let iso = exif.iso_speed_ratings.map(|v| v as u32)
        .or(exif.iso_speed);

    // ExposureTime is the canonical shutter-seconds tag. Fallback to
    // ShutterSpeedValue (APEX units: 2^-val = seconds) if absent.
    let shutter_s = exif.exposure_time.as_ref().map(rat_f32)
        .or_else(|| exif.shutter_speed_value.as_ref()
            .map(|s| 2.0_f32.powf(-srat_f32(s))));

    let aperture = exif.fnumber.as_ref().map(rat_f32)
        .or_else(|| exif.aperture_value.as_ref()
            .map(|a| 2.0_f32.powf(rat_f32(a) * 0.5)));

    let focal_mm = exif.focal_length.as_ref().map(rat_f32);

    let captured_at = exif.date_time_original.clone()
        .or_else(|| exif.create_date.clone())
        .or_else(|| exif.modify_date.clone());

    let gps = exif.gps.as_ref().and_then(|g| {
        // rawler's ExifGPS stores lat/lon as [deg, min, sec] rationals with
        // N/S + E/W refs. Convert to decimal degrees.
        let to_decimal = |dms: &[Rational; 3], neg: bool| -> f64 {
            let d = if dms[0].d == 0 { 0.0 } else { dms[0].n as f64 / dms[0].d as f64 };
            let m = if dms[1].d == 0 { 0.0 } else { dms[1].n as f64 / dms[1].d as f64 };
            let s = if dms[2].d == 0 { 0.0 } else { dms[2].n as f64 / dms[2].d as f64 };
            let decimal = d + m / 60.0 + s / 3600.0;
            if neg { -decimal } else { decimal }
        };
        match (g.gps_latitude, g.gps_latitude_ref.as_deref(),
               g.gps_longitude, g.gps_longitude_ref.as_deref()) {
            (Some(lat), Some(lat_ref), Some(lon), Some(lon_ref)) => {
                let lat_deg = to_decimal(&lat, lat_ref.eq_ignore_ascii_case("S"));
                let lon_deg = to_decimal(&lon, lon_ref.eq_ignore_ascii_case("W"));
                let altitude_m = g.gps_altitude.as_ref().map(rat_f32);
                Some(ExifGps { lat_deg, lon_deg, altitude_m })
            }
            _ => None,
        }
    });

    let none_if_empty = |s: String| if s.is_empty() { None } else { Some(s) };

    Ok(Exif {
        camera_make: none_if_empty(md.make.clone()),
        camera_model: none_if_empty(md.model.clone()),
        lens_make: exif.lens_make.clone(),
        lens_model: exif.lens_model.clone(),
        iso,
        shutter_s,
        aperture,
        focal_mm,
        captured_at,
        gps,
        orientation: exif.orientation
            .map(ExifOrientation::from_u16)
            .unwrap_or_default(),
    })
}

/// Run the full develop pipeline on a decoded RAW.
///
/// Wraps [`crate::pipeline::render_from_raw`] in the spec-shaped [`Rendered`]
/// struct.
pub fn apply(image: &RawImage, adj: &AdjustmentModel) -> Result<Rendered> {
    let (w, h, rgb) = crate::pipeline::render_from_raw(image, adj)?;
    Ok(Rendered { width: w, height: h, rgb })
}

// ─── Statistics ──────────────────────────────────────────────────────────

/// Compute per-channel + luma histograms over a rendered image.
///
/// Pure, deterministic, single-threaded: no parallel reduction (would drift
/// on floating-point luma) but luma uses integer Rec.709 weights so it is
/// associative anyway; kept single-threaded for predictable ordering in
/// tests. Runs in `O(pixels)` with no allocation beyond the return struct.
pub fn histogram(r: &Rendered) -> Histogram {
    let mut h = Histogram { r: [0; 256], g: [0; 256], b: [0; 256], l: [0; 256] };
    for px in r.rgb.chunks_exact(3) {
        h.r[px[0] as usize] += 1;
        h.g[px[1] as usize] += 1;
        h.b[px[2] as usize] += 1;
        // Integer Rec.709 luma — approximates (0.2126, 0.7152, 0.0722) × 256.
        // Saturates at 255.
        let l = (54 * px[0] as u32 + 183 * px[1] as u32 + 18 * px[2] as u32 + 128) >> 8;
        h.l[(l.min(255)) as usize] += 1;
    }
    h
}

/// Compute an RGB waveform over a rendered image.
///
/// One output column per image column. `bins` = 256. Each bin counts the
/// number of pixels in that column whose channel value rounds into the bin.
pub fn waveform(r: &Rendered) -> Waveform {
    const BINS: u32 = 256;
    let w = r.width as usize;
    let h = r.height as usize;
    let mut wf = Waveform {
        width: r.width,
        bins: BINS,
        r: vec![0; w * BINS as usize],
        g: vec![0; w * BINS as usize],
        b: vec![0; w * BINS as usize],
    };
    let stride = BINS as usize;
    for y in 0..h {
        let row = &r.rgb[y * w * 3..(y + 1) * w * 3];
        for x in 0..w {
            let px = &row[x * 3..x * 3 + 3];
            wf.r[x * stride + px[0] as usize] += 1;
            wf.g[x * stride + px[1] as usize] += 1;
            wf.b[x * stride + px[2] as usize] += 1;
        }
    }
    wf
}

// ─── Thumbnail / preview ─────────────────────────────────────────────────

/// Render an RGBA thumbnail constrained to `max_px` on the long edge.
///
/// Uses [`AdjustmentModel::default`] — thumbnails ignore user adjustments by
/// design (spec §03: "Thumbs are identical across shells"). For a preview
/// that honours adjustments, use [`preview`].
///
/// Spec §03 pins the cache encoding as 256 px / 512 px / 1600 px @ sRGB; the
/// core returns an uncompressed RGBA buffer and the shell JPEG-encodes with
/// [`encode`] at the spec-pinned quality (82 for thumbs, 90 for previews).
pub fn thumbnail(image: &RawImage, max_px: u32) -> Result<Rgba> {
    if max_px == 0 {
        return Err(Error::Pipeline("thumbnail: max_px must be > 0".into()));
    }
    let adj = AdjustmentModel::default();
    let rendered = apply(image, &adj)?;
    downsample_to_rgba(&rendered, max_px)
}

/// Render an RGBA preview constrained to `max_px` on the long edge, honouring
/// user adjustments.
pub fn preview(image: &RawImage, max_px: u32, adj: &AdjustmentModel) -> Result<Rgba> {
    if max_px == 0 {
        return Err(Error::Pipeline("preview: max_px must be > 0".into()));
    }
    let rendered = apply(image, adj)?;
    downsample_to_rgba(&rendered, max_px)
}

/// Box-filter downsample `rendered` to `max_px` on its long edge, returning
/// RGBA8 with alpha=255.
///
/// Box filter is deterministic and cheap; a high-quality Lanczos/Mitchell
/// path will land with the thumbnail encoder cleanup (T5).
fn downsample_to_rgba(rendered: &Rendered, max_px: u32) -> Result<Rgba> {
    let (sw, sh) = (rendered.width, rendered.height);
    if sw == 0 || sh == 0 {
        return Err(Error::Pipeline("downsample: source is empty".into()));
    }
    let long_edge = sw.max(sh);
    let (dw, dh) = if long_edge <= max_px {
        (sw, sh)
    } else if sw >= sh {
        let scale = max_px as f64 / sw as f64;
        (max_px, ((sh as f64 * scale).round() as u32).max(1))
    } else {
        let scale = max_px as f64 / sh as f64;
        (((sw as f64 * scale).round() as u32).max(1), max_px)
    };

    let mut out = vec![0u8; (dw as usize) * (dh as usize) * 4];
    let src = &rendered.rgb;
    let sw_u = sw as usize;

    for y in 0..dh {
        // Integer source row range for this destination row.
        let y0 = ((y as u64) * (sh as u64) / (dh as u64)) as usize;
        let y1 = (((y + 1) as u64) * (sh as u64) / (dh as u64)).max((y0 + 1) as u64) as usize;
        let y1 = y1.min(sh as usize);
        for x in 0..dw {
            let x0 = ((x as u64) * (sw as u64) / (dw as u64)) as usize;
            let x1 = (((x + 1) as u64) * (sw as u64) / (dw as u64)).max((x0 + 1) as u64) as usize;
            let x1 = x1.min(sw as usize);
            let (mut sr, mut sg, mut sb, mut n) = (0u64, 0u64, 0u64, 0u64);
            for sy in y0..y1 {
                let row_off = sy * sw_u * 3;
                for sx in x0..x1 {
                    let o = row_off + sx * 3;
                    sr += src[o] as u64;
                    sg += src[o + 1] as u64;
                    sb += src[o + 2] as u64;
                    n += 1;
                }
            }
            let n = n.max(1);
            let di = ((y as usize) * (dw as usize) + (x as usize)) * 4;
            out[di]     = (sr / n) as u8;
            out[di + 1] = (sg / n) as u8;
            out[di + 2] = (sb / n) as u8;
            out[di + 3] = 255;
        }
    }
    Ok(Rgba { width: dw, height: dh, rgba: out })
}

// ─── Encode ──────────────────────────────────────────────────────────────

/// Encode a [`Rendered`] into a container format in memory.
///
/// Supported formats (T1): `Jpeg`, `Png`, `Tiff`. `Webp` / `Heic` require
/// third-party encoders not yet wired up and return [`Error::Pipeline`]
/// with `"unsupported"` — shells can feature-detect via this error and fall
/// back to PNG.
pub fn encode(r: &Rendered, fmt: OutFmt, opts: &EncodeOpts) -> Result<Vec<u8>> {
    match fmt {
        OutFmt::Jpeg => crate::jpeg::encode(r.width, r.height, &r.rgb, opts.quality),
        OutFmt::Png  => crate::png::encode(r.width, r.height, &r.rgb),
        OutFmt::Tiff => crate::tiff::encode_from_u8(r.width, r.height, &r.rgb),
        OutFmt::Webp => Err(Error::Pipeline("encode: WebP unsupported (T-future)".into())),
        OutFmt::Heic => Err(Error::Pipeline("encode: HEIC unsupported (T-future)".into())),
    }
}

// ─── XMP ─────────────────────────────────────────────────────────────────

/// Parse an XMP byte slice into a [`Sidecar`], applying the spec §05 merge
/// policy: `crs:*` is parsed first via [`crate::xmp::parse`], then any
/// `maple:*` adjustment duplicates overlay on top (Maple wins on conflict).
/// Dublin Core simple fields and `dc:subject` (via `rdf:Bag`/`rdf:li`) are
/// pulled into [`Sidecar::dc`]. Unknown child elements under
/// `<rdf:Description>` are reserialised into [`Sidecar::raw_xml`] for
/// verbatim emission by [`xmp_write`].
pub fn xmp_read(bytes: &[u8]) -> Result<Sidecar> {
    let xml = std::str::from_utf8(bytes).map_err(|e| Error::Xmp(format!(
        "XMP sidecar is not valid UTF-8: {}", e
    )))?;
    // Stage 1: parse the crs:* adjustment block.
    let adj = crate::xmp::parse(xml)?;
    let mut s = Sidecar { adj, ..Sidecar::default() };

    use quick_xml::events::Event;
    use quick_xml::reader::Reader;

    // Known rdf:Description child element names we already handle structurally
    // (outside of raw_xml passthrough). dc:subject is a Bag; everything else
    // here is a simple text element we recognise.
    const KNOWN_CHILD_ELEMENTS: &[&str] = &[
        "dc:subject",
        "dc:title", "dc:description", "dc:rights", "dc:creator",
    ];

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    // Track unknown child elements inside <rdf:Description> for passthrough.
    // When depth == 1 (i.e. we are *inside* an rdf:Description but not inside
    // a child), a Start/Empty event for an unknown element opens a capture
    // window until its matching End. Nested structure inside the captured
    // element is preserved.
    let mut in_desc_depth: i32 = 0;
    let mut capture: Option<(String, Vec<u8>, i32)> = None; // (tag, buf, open_depth)
    let mut raw_buf: Vec<u8> = Vec::new();

    loop {
        let ev = reader.read_event().map_err(|e| Error::Xmp(e.to_string()))?;
        match ev {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let is_empty = matches!(ev, Event::Empty(_));
                let name_bytes = e.name().as_ref().to_vec();
                let name = std::str::from_utf8(&name_bytes)
                    .map_err(|e| Error::Xmp(e.to_string()))?
                    .to_string();

                // Parse attributes on every element (matches old behaviour —
                // most Maple/`crs:` fields land as attributes on rdf:Description).
                for attr_result in e.attributes() {
                    let attr = attr_result.map_err(|e| Error::Xmp(e.to_string()))?;
                    let key = std::str::from_utf8(attr.key.as_ref())
                        .map_err(|e| Error::Xmp(e.to_string()))?;
                    let value = attr.unescape_value()
                        .map_err(|e| Error::Xmp(e.to_string()))?;
                    apply_attr(&mut s, key, value.as_ref())?;
                }

                // Track rdf:Description nesting for the raw-xml passthrough
                // sweep. Only elements that sit directly under an
                // rdf:Description can be "unknown children" — attributes and
                // their host element are handled by the attribute loop above.
                if name == "rdf:Description" {
                    if !is_empty {
                        in_desc_depth += 1;
                    }
                } else if let Some((_tag, buf, _od)) = capture.as_mut() {
                    // Already capturing — reserialise this element into the
                    // capture buffer.
                    write_start(buf, e, is_empty);
                } else if in_desc_depth > 0
                    && !KNOWN_CHILD_ELEMENTS.contains(&name.as_str())
                {
                    // Begin capturing an unknown rdf:Description child.
                    let mut buf = Vec::new();
                    write_start(&mut buf, e, is_empty);
                    if is_empty {
                        raw_buf.extend_from_slice(&buf);
                        raw_buf.push(b'\n');
                    } else {
                        capture = Some((name, buf, in_desc_depth));
                    }
                }
            }
            Event::End(ref e) => {
                let name_bytes = e.name().as_ref().to_vec();
                let name = std::str::from_utf8(&name_bytes)
                    .map_err(|e| Error::Xmp(e.to_string()))?
                    .to_string();

                if let Some((tag, mut buf, open_depth)) = capture.take() {
                    if name == tag && in_desc_depth == open_depth {
                        // End of the captured unknown subtree.
                        buf.extend_from_slice(b"</");
                        buf.extend_from_slice(tag.as_bytes());
                        buf.push(b'>');
                        raw_buf.extend_from_slice(&buf);
                        raw_buf.push(b'\n');
                    } else {
                        // End of a nested element inside the capture.
                        buf.extend_from_slice(b"</");
                        buf.extend_from_slice(&name_bytes);
                        buf.push(b'>');
                        capture = Some((tag, buf, open_depth));
                    }
                }

                if name == "rdf:Description" && in_desc_depth > 0 {
                    in_desc_depth -= 1;
                }
            }
            Event::Text(ref t) => {
                // dc:subject/rdf:Bag/rdf:li text nodes are parsed via the
                // dedicated Bag sweep below; here we only capture text inside
                // an unknown element.
                if let Some((_tag, buf, _od)) = capture.as_mut() {
                    let bytes = t.as_ref();
                    buf.extend_from_slice(xml_escape_text_bytes(bytes).as_slice());
                }
            }
            Event::CData(ref c) => {
                if let Some((_tag, buf, _od)) = capture.as_mut() {
                    buf.extend_from_slice(b"<![CDATA[");
                    buf.extend_from_slice(c.as_ref());
                    buf.extend_from_slice(b"]]>");
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    if !raw_buf.is_empty() {
        s.raw_xml = Some(raw_buf);
    }

    // Stage 2: dc:subject/rdf:Bag/rdf:li sweep. Separate pass because the
    // nesting is independent of the attribute walk above and we want each
    // pass to be easy to read.
    s.dc.subject = parse_dc_subject(xml)?;

    Ok(s)
}

/// Apply a single XMP attribute to `s`. Split out so both the crs-first pass
/// and the maple-overlay pass share the same table. Returns an error only
/// for syntactically bad values (e.g. a non-numeric rating) so the caller
/// doesn't silently paper over malformed sidecars.
fn apply_attr(s: &mut Sidecar, key: &str, value: &str) -> Result<()> {
    match key {
        "xmp:Rating" => {
            let v: u8 = value.parse().map_err(|e: std::num::ParseIntError| {
                Error::Xmp(format!("xmp:Rating: {}", e))
            })?;
            s.rating = Some(v.min(5));
        }
        "xmp:Label" => s.label = Some(value.to_string()),
        "maple:flag" => {
            s.flag = match value {
                "pick"   => Some(Flag::Pick),
                "reject" => Some(Flag::Reject),
                "none" | "" => None,
                other => return Err(Error::Xmp(format!(
                    "maple:flag: unknown value {:?}", other))),
            };
        }
        "maple:id" => { s.id = Some(MapleId::from_hex(value)?); }
        "dc:title"       => s.dc.title       = Some(value.to_string()),
        "dc:description" => s.dc.description = Some(value.to_string()),
        "dc:rights"      => s.dc.rights      = Some(value.to_string()),
        "dc:creator"     => s.dc.creator     = Some(value.to_string()),

        // Merge-on-read: maple:* overlays crs:* for adjustment fields.
        // Names mirror the crs:* spelling (so sidecars stay readable).
        "maple:Temperature"    => s.adj.temperature = parse_f32(key, value)?,
        "maple:Tint"           => s.adj.tint = parse_f32(key, value)?,
        "maple:Exposure2012"   => s.adj.exposure = parse_f32(key, value)?,
        "maple:Contrast2012"   => s.adj.contrast = parse_f32(key, value)?,
        "maple:Highlights2012" => s.adj.highlights = parse_f32(key, value)?,
        "maple:Shadows2012"    => s.adj.shadows = parse_f32(key, value)?,
        "maple:Whites2012"     => s.adj.whites = parse_f32(key, value)?,
        "maple:Blacks2012"     => s.adj.blacks = parse_f32(key, value)?,
        "maple:Vibrance"       => s.adj.vibrance = parse_f32(key, value)?,
        "maple:Saturation"     => s.adj.saturation = parse_f32(key, value)?,
        "maple:Clarity2012"    => s.adj.clarity = parse_f32(key, value)?,
        "maple:Texture"        => s.adj.texture = parse_f32(key, value)?,
        "maple:Dehaze"         => s.adj.dehaze = parse_f32(key, value)?,
        "maple:Sharpness"          => s.adj.sharpen_amount = parse_f32(key, value)?,
        "maple:SharpenRadius"      => s.adj.sharpen_radius = parse_f32(key, value)?,
        "maple:SharpenDetail"      => s.adj.sharpen_detail = parse_f32(key, value)?,
        "maple:SharpenEdgeMasking" => s.adj.sharpen_masking = parse_f32(key, value)?,
        "maple:LuminanceSmoothing" => s.adj.nr_luminance = parse_f32(key, value)?,
        "maple:ColorNoiseReduction"=> s.adj.nr_color = parse_f32(key, value)?,
        _ => {}
    }
    Ok(())
}

fn parse_f32(key: &str, value: &str) -> Result<f32> {
    value.parse::<f32>().map_err(|e| Error::Xmp(format!(
        "field {} has non-numeric value {}: {}", key, value, e
    )))
}

/// Pull `dc:subject` keywords out of an `<rdf:Bag>` block. Returns keywords
/// in source order (we sort on write, not on read, so a read-modify-write
/// cycle with no semantic change still produces the same bytes).
fn parse_dc_subject(xml: &str) -> Result<Vec<String>> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut out = Vec::new();
    let mut in_subject = false;
    let mut in_li = false;
    let mut current = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = std::str::from_utf8(e.name().as_ref())
                    .map_err(|e| Error::Xmp(e.to_string()))?
                    .to_string();
                if name == "dc:subject" {
                    in_subject = true;
                } else if in_subject && name == "rdf:li" {
                    in_li = true;
                    current.clear();
                }
            }
            Ok(Event::End(e)) => {
                let name = std::str::from_utf8(e.name().as_ref())
                    .map_err(|e| Error::Xmp(e.to_string()))?
                    .to_string();
                if name == "rdf:li" && in_li {
                    out.push(std::mem::take(&mut current));
                    in_li = false;
                } else if name == "dc:subject" {
                    in_subject = false;
                }
            }
            Ok(Event::Text(t)) => {
                if in_li {
                    let s = t.unescape().map_err(|e| Error::Xmp(e.to_string()))?;
                    current.push_str(&s);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(Error::Xmp(e.to_string())),
            _ => {}
        }
    }
    Ok(out)
}

/// Reserialise a Start/Empty event's opening tag (name + attributes) into
/// `buf`. Used by the raw_xml passthrough capture. Attribute values are
/// re-escaped from the raw (already-escaped) source bytes — we preserve the
/// original escape sequences unchanged.
fn write_start(buf: &mut Vec<u8>, e: &quick_xml::events::BytesStart<'_>, is_empty: bool) {
    buf.push(b'<');
    buf.extend_from_slice(e.name().as_ref());
    for attr in e.attributes().with_checks(false).flatten() {
        buf.push(b' ');
        buf.extend_from_slice(attr.key.as_ref());
        buf.extend_from_slice(b"=\"");
        buf.extend_from_slice(&attr.value);
        buf.push(b'"');
    }
    if is_empty { buf.extend_from_slice(b"/>"); } else { buf.push(b'>'); }
}

fn xml_escape_text_bytes(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    for &b in input {
        match b {
            b'&' => out.extend_from_slice(b"&amp;"),
            b'<' => out.extend_from_slice(b"&lt;"),
            b'>' => out.extend_from_slice(b"&gt;"),
            _ => out.push(b),
        }
    }
    out
}

/// Serialise a [`Sidecar`] to an XMP byte buffer.
///
/// Dual-write policy per spec §05: every adjustment is emitted in **both**
/// `crs:*` (so Lightroom / darktable / Capture One pick it up) and
/// `maple:*` (so the next Maple read overlays them on top — Maple wins on
/// conflict). `xmp:Rating`, `xmp:Label`, `dc:*`, `maple:flag`, `maple:id`
/// land once. `dc:subject` is emitted as an `rdf:Bag`, keywords sorted
/// alphabetically for determinism. `raw_xml`, if present, is dropped into
/// `<rdf:RDF>` verbatim so unknown third-party namespaces survive the
/// round-trip.
///
/// Namespace declarations live once at the top `<rdf:Description>` so we
/// don't spray `xmlns:*` duplicates across every Description element.
///
/// Deterministic: no timestamps, no random ids. Given equal input, produces
/// equal bytes on any platform.
pub fn xmp_write(sidecar: &Sidecar) -> Vec<u8> {
    let a = &sidecar.adj;
    let mut s = String::new();
    s.push_str("<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n");
    s.push_str("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n");
    s.push_str("  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n");
    s.push_str("    <rdf:Description rdf:about=\"\"\n");
    s.push_str("      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n");
    s.push_str("      xmlns:dc=\"http://purl.org/dc/elements/1.1/\"\n");
    s.push_str("      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"\n");
    s.push_str("      xmlns:maple=\"http://ns.justmaple.app/maple/1.0/\"");

    // xmp:* attributes.
    if let Some(r) = sidecar.rating {
        s.push_str(&format!("\n      xmp:Rating=\"{}\"", r));
    }
    if let Some(l) = &sidecar.label {
        s.push_str(&format!("\n      xmp:Label=\"{}\"", xml_escape_attr(l)));
    }

    // maple:* non-adjustment attributes.
    if let Some(f) = sidecar.flag {
        let v = match f { Flag::Pick => "pick", Flag::Reject => "reject" };
        s.push_str(&format!("\n      maple:flag=\"{}\"", v));
    }
    if let Some(id) = &sidecar.id {
        s.push_str(&format!("\n      maple:id=\"{}\"", id.to_hex()));
    }

    // dc:* simple fields. dc:subject is emitted as a child rdf:Bag below —
    // it can't live as an attribute because its value is a multi-item list.
    if let Some(v) = &sidecar.dc.title {
        s.push_str(&format!("\n      dc:title=\"{}\"", xml_escape_attr(v)));
    }
    if let Some(v) = &sidecar.dc.description {
        s.push_str(&format!("\n      dc:description=\"{}\"", xml_escape_attr(v)));
    }
    if let Some(v) = &sidecar.dc.rights {
        s.push_str(&format!("\n      dc:rights=\"{}\"", xml_escape_attr(v)));
    }
    if let Some(v) = &sidecar.dc.creator {
        s.push_str(&format!("\n      dc:creator=\"{}\"", xml_escape_attr(v)));
    }

    // Dual-write adjustments: crs:* first (Lightroom-visible), then maple:*
    // (Maple wins on next read). Every adjustment is written to both
    // namespaces — the round-trip invariant is "what we wrote into maple:*
    // is what we read back as the source of truth".
    let write_adj = |s: &mut String, prefix: &str| {
        s.push_str(&format!("\n      {}:Temperature=\"{}\"", prefix, a.temperature));
        s.push_str(&format!("\n      {}:Tint=\"{}\"", prefix, a.tint));
        s.push_str(&format!("\n      {}:Exposure2012=\"{}\"", prefix, a.exposure));
        s.push_str(&format!("\n      {}:Contrast2012=\"{}\"", prefix, a.contrast));
        s.push_str(&format!("\n      {}:Highlights2012=\"{}\"", prefix, a.highlights));
        s.push_str(&format!("\n      {}:Shadows2012=\"{}\"", prefix, a.shadows));
        s.push_str(&format!("\n      {}:Whites2012=\"{}\"", prefix, a.whites));
        s.push_str(&format!("\n      {}:Blacks2012=\"{}\"", prefix, a.blacks));
        s.push_str(&format!("\n      {}:Vibrance=\"{}\"", prefix, a.vibrance));
        s.push_str(&format!("\n      {}:Saturation=\"{}\"", prefix, a.saturation));
        s.push_str(&format!("\n      {}:Clarity2012=\"{}\"", prefix, a.clarity));
        s.push_str(&format!("\n      {}:Texture=\"{}\"", prefix, a.texture));
        s.push_str(&format!("\n      {}:Dehaze=\"{}\"", prefix, a.dehaze));
        s.push_str(&format!("\n      {}:Sharpness=\"{}\"", prefix, a.sharpen_amount));
        s.push_str(&format!("\n      {}:SharpenRadius=\"{}\"", prefix, a.sharpen_radius));
        s.push_str(&format!("\n      {}:SharpenDetail=\"{}\"", prefix, a.sharpen_detail));
        s.push_str(&format!("\n      {}:SharpenEdgeMasking=\"{}\"", prefix, a.sharpen_masking));
        s.push_str(&format!("\n      {}:LuminanceSmoothing=\"{}\"", prefix, a.nr_luminance));
        s.push_str(&format!("\n      {}:ColorNoiseReduction=\"{}\"", prefix, a.nr_color));
    };
    write_adj(&mut s, "crs");
    write_adj(&mut s, "maple");

    s.push_str(">\n");

    // dc:subject bag (keywords). Sort on emit for stable byte-identical
    // output across runs regardless of insertion order.
    if !sidecar.dc.subject.is_empty() {
        let mut sorted = sidecar.dc.subject.clone();
        sorted.sort();
        s.push_str("      <dc:subject>\n");
        s.push_str("        <rdf:Bag>\n");
        for k in &sorted {
            s.push_str(&format!("          <rdf:li>{}</rdf:li>\n", xml_escape_text(k)));
        }
        s.push_str("        </rdf:Bag>\n");
        s.push_str("      </dc:subject>\n");
    }

    s.push_str("    </rdf:Description>\n");

    // raw_xml passthrough: verbatim emission inside <rdf:RDF>. We do not
    // parse or validate — that's the point. Namespace prefixes the
    // passthrough XML references should be declared on the Description
    // above or inline on the passthrough element itself (we don't
    // re-bind).
    if let Some(raw) = &sidecar.raw_xml {
        // Wrap the passthrough in its own rdf:Description so stray
        // namespace declarations inside `raw` don't pollute our primary
        // block. Callers' unknown-element bytes were captured from inside
        // a Description already, so this is the symmetric container.
        s.push_str("    <rdf:Description rdf:about=\"\">\n");
        // `raw` is UTF-8 XML fragments separated by newlines (see
        // xmp_read).
        if let Ok(txt) = std::str::from_utf8(raw) {
            for line in txt.lines() {
                if line.is_empty() { continue; }
                s.push_str("      ");
                s.push_str(line);
                s.push('\n');
            }
        }
        s.push_str("    </rdf:Description>\n");
    }

    s.push_str("  </rdf:RDF>\n");
    s.push_str("</x:xmpmeta>\n");
    s.push_str("<?xpacket end=\"w\"?>\n");
    s.into_bytes()
}

fn xml_escape_attr(v: &str) -> String {
    v.replace('&',  "&amp;")
     .replace('<',  "&lt;")
     .replace('>',  "&gt;")
     .replace('"',  "&quot;")
     .replace('\'', "&apos;")
}

fn xml_escape_text(v: &str) -> String {
    v.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws")
    }

    fn small_rendered() -> Rendered {
        // 4×2 solid-grey sRGB.
        let rgb = vec![128u8; 4 * 2 * 3];
        Rendered { width: 4, height: 2, rgb }
    }

    // ─── decode_raw ────────────────────────────────────────────────────

    #[test]
    fn decode_raw_happy_path_for_test_0002() {
        let path = fixture_root().join("test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).unwrap();
        let raw = decode_raw(&bytes, "dng").expect("decode_raw");
        assert!(raw.width > 0 && raw.height > 0);
    }

    #[test]
    fn decode_raw_errors_on_garbage() {
        let junk = vec![0u8; 128];
        assert!(decode_raw(&junk, "dng").is_err());
    }

    // ─── read_exif ─────────────────────────────────────────────────────

    #[test]
    fn read_exif_returns_camera_for_test_0002() {
        let path = fixture_root().join("test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).unwrap();
        let exif = read_exif(&bytes, "dng").expect("read_exif");
        assert!(exif.camera_make.is_some() || exif.camera_model.is_some(),
            "expected camera metadata, got {:?}", exif);
    }

    #[test]
    fn read_exif_errors_on_garbage() {
        let junk = vec![0u8; 128];
        assert!(read_exif(&junk, "dng").is_err());
    }

    // ─── apply ─────────────────────────────────────────────────────────

    #[test]
    fn apply_happy_path_for_test_0002() {
        let path = fixture_root().join("test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).unwrap();
        let raw = decode_raw(&bytes, "dng").unwrap();
        let r = apply(&raw, &AdjustmentModel::default()).expect("apply");
        assert_eq!(r.rgb.len() as u32, r.width * r.height * 3);
    }

    // ─── histogram ─────────────────────────────────────────────────────

    #[test]
    fn histogram_total_matches_pixel_count() {
        let r = small_rendered();
        let h = histogram(&r);
        let total: u32 = h.r.iter().sum();
        assert_eq!(total, r.width * r.height);
        // All pixels are grey 128, so bin 128 should hold everything.
        assert_eq!(h.r[128], r.width * r.height);
        assert_eq!(h.g[128], r.width * r.height);
        assert_eq!(h.b[128], r.width * r.height);
    }

    #[test]
    fn histogram_of_black_lands_in_bin_zero() {
        let r = Rendered { width: 2, height: 2, rgb: vec![0u8; 12] };
        let h = histogram(&r);
        assert_eq!(h.r[0], 4);
        assert_eq!(h.l[0], 4);
        assert_eq!(h.r[1..].iter().sum::<u32>(), 0);
    }

    // ─── waveform ──────────────────────────────────────────────────────

    #[test]
    fn waveform_column_counts_match_height() {
        let r = small_rendered();
        let wf = waveform(&r);
        assert_eq!(wf.width, r.width);
        assert_eq!(wf.bins, 256);
        // Each column has `height` pixels.
        let stride = wf.bins as usize;
        for x in 0..(r.width as usize) {
            let col_total: u32 = wf.r[x * stride..(x + 1) * stride].iter().sum();
            assert_eq!(col_total, r.height);
        }
    }

    #[test]
    fn waveform_of_1x1_has_one_pixel_in_one_bin() {
        let r = Rendered { width: 1, height: 1, rgb: vec![200, 100, 50] };
        let wf = waveform(&r);
        assert_eq!(wf.r[200], 1);
        assert_eq!(wf.g[100], 1);
        assert_eq!(wf.b[50], 1);
    }

    // ─── thumbnail / preview ───────────────────────────────────────────

    #[test]
    fn thumbnail_zero_px_errors() {
        let raw = synthetic_tiny_raw();
        assert!(thumbnail(&raw, 0).is_err());
    }

    #[test]
    fn preview_zero_px_errors() {
        let raw = synthetic_tiny_raw();
        assert!(preview(&raw, 0, &AdjustmentModel::default()).is_err());
    }

    #[test]
    fn thumbnail_bounds_long_edge_for_test_0002() {
        let path = fixture_root().join("test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).unwrap();
        let raw = decode_raw(&bytes, "dng").unwrap();
        let t = thumbnail(&raw, 256).expect("thumbnail");
        assert!(t.width.max(t.height) <= 256);
        assert_eq!(t.rgba.len() as u32, t.width * t.height * 4);
        // Alpha is always 255.
        assert!(t.rgba.chunks_exact(4).all(|p| p[3] == 255));
    }

    #[test]
    fn preview_honours_adj_larger_than_thumb() {
        let path = fixture_root().join("test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).unwrap();
        let raw = decode_raw(&bytes, "dng").unwrap();
        let adj = AdjustmentModel { exposure: 2.0, ..Default::default() };
        let p = preview(&raw, 512, &adj).expect("preview");
        assert!(p.width.max(p.height) <= 512);
    }

    // ─── encode ────────────────────────────────────────────────────────

    #[test]
    fn encode_png_round_trips() {
        let r = small_rendered();
        let bytes = encode(&r, OutFmt::Png, &EncodeOpts::default()).unwrap();
        assert_eq!(&bytes[..8], &[137, 80, 78, 71, 13, 10, 26, 10], "PNG magic");
    }

    #[test]
    fn encode_jpeg_produces_jpeg_soi() {
        let r = small_rendered();
        let bytes = encode(&r, OutFmt::Jpeg, &EncodeOpts::default()).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
    }

    #[test]
    fn encode_webp_unsupported() {
        let r = small_rendered();
        let err = encode(&r, OutFmt::Webp, &EncodeOpts::default()).unwrap_err();
        match err { Error::Pipeline(_) => {}, _ => panic!("expected Pipeline error") }
    }

    #[test]
    fn encode_heic_unsupported() {
        let r = small_rendered();
        assert!(encode(&r, OutFmt::Heic, &EncodeOpts::default()).is_err());
    }

    // ─── xmp_read / xmp_write ──────────────────────────────────────────

    #[test]
    fn xmp_roundtrip_preserves_adj_rating_flag_id() {
        let id = crate::id::MapleId::primary(b"abc", "2024:01:01 00:00:00", None, None);
        let s = Sidecar {
            id: Some(id),
            rating: Some(4),
            flag: Some(Flag::Pick),
            label: Some("red".into()),
            dc: DublinCore { title: Some("A title".into()), ..Default::default() },
            adj: AdjustmentModel { exposure: 1.5, contrast: 30.0, ..Default::default() },
            ..Default::default()
        };
        let bytes = xmp_write(&s);
        let parsed = xmp_read(&bytes).expect("xmp_read");
        assert_eq!(parsed.id, s.id);
        assert_eq!(parsed.rating, s.rating);
        assert_eq!(parsed.flag, s.flag);
        assert_eq!(parsed.label, s.label);
        assert_eq!(parsed.dc.title, s.dc.title);
        assert!((parsed.adj.exposure - 1.5).abs() < 1e-4);
        assert!((parsed.adj.contrast - 30.0).abs() < 1e-4);
    }

    // ─── T9: merge-on-read + dual-write ────────────────────────────────

    #[test]
    fn maple_wins_over_crs_on_merge() {
        // When a sidecar contains the same adjustment in both namespaces,
        // maple:* overlays crs:* per spec §05 "Merge on read".
        let xml = br#"<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:maple="http://ns.justmaple.app/maple/1.0/"
      crs:Exposure2012="0.5"
      maple:Exposure2012="1.0"/>
  </rdf:RDF>
</x:xmpmeta>"#;
        let s = xmp_read(xml).expect("xmp_read");
        assert!((s.adj.exposure - 1.0).abs() < 1e-4,
            "expected maple:Exposure2012=1.0 to win, got {}", s.adj.exposure);
    }

    #[test]
    fn dc_roundtrip() {
        let s = Sidecar {
            dc: DublinCore {
                title: Some("Sunset over the bay".into()),
                description: Some("Two-line caption & quotes \"here\"".into()),
                subject: vec!["travel".into(), "sunset".into(), "coast".into()],
                rights: Some("(c) 2026 Jane Photographer".into()),
                creator: Some("Jane Photographer".into()),
            },
            ..Default::default()
        };
        let bytes = xmp_write(&s);
        let parsed = xmp_read(&bytes).expect("xmp_read");
        assert_eq!(parsed.dc.title, s.dc.title);
        assert_eq!(parsed.dc.description, s.dc.description);
        assert_eq!(parsed.dc.rights, s.dc.rights);
        assert_eq!(parsed.dc.creator, s.dc.creator);
        // Keywords come back sorted (we sort on write).
        let mut expected = s.dc.subject.clone();
        expected.sort();
        assert_eq!(parsed.dc.subject, expected);
        assert!(parsed.dc.subject.len() >= 3);
    }

    #[test]
    fn rating_label_roundtrip() {
        let s = Sidecar {
            rating: Some(3),
            label: Some("Red".into()),
            ..Default::default()
        };
        let bytes = xmp_write(&s);
        let parsed = xmp_read(&bytes).expect("xmp_read");
        assert_eq!(parsed.rating, Some(3));
        assert_eq!(parsed.label.as_deref(), Some("Red"));
    }

    #[test]
    fn flag_roundtrip() {
        for flag in [Some(Flag::Pick), Some(Flag::Reject), None] {
            let s = Sidecar { flag, ..Default::default() };
            let bytes = xmp_write(&s);
            let parsed = xmp_read(&bytes).expect("xmp_read");
            assert_eq!(parsed.flag, flag, "flag {:?} did not round-trip", flag);
        }
    }

    #[test]
    fn unknown_xml_passthrough() {
        // A sidecar with a custom third-party element under rdf:Description
        // should come back through xmp_read -> xmp_write with the custom
        // element intact.
        let xml = br#"<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:myvendor="http://example.com/myvendor/1.0/"
      crs:Exposure2012="0.25">
      <myvendor:customField>X</myvendor:customField>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>"#;
        let s = xmp_read(xml).expect("xmp_read");
        assert!(s.raw_xml.is_some(), "expected raw_xml to be populated");
        let raw = s.raw_xml.as_ref().unwrap();
        let raw_str = std::str::from_utf8(raw).unwrap();
        assert!(raw_str.contains("myvendor:customField"),
            "expected custom element in raw_xml, got {:?}", raw_str);
        assert!(raw_str.contains('X'), "expected custom text in raw_xml");

        // Read-modify-write: emitted bytes must still contain the custom
        // element.
        let out = xmp_write(&s);
        let out_str = std::str::from_utf8(&out).unwrap();
        assert!(out_str.contains("myvendor:customField"),
            "passthrough element lost on write");
        assert!(out_str.contains('X'), "passthrough text lost on write");
    }

    #[test]
    fn lightroom_compatibility() {
        // A Lightroom-style XMP snippet — the structure third-party tools
        // actually emit (attributes on rdf:Description). xmp_read must pick
        // up crs:Exposure2012 and xmp_write must still emit a crs: block so
        // Lightroom sees our edits.
        let lr_xml = br#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 7.0-c000">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmp:Rating="5"
      crs:Exposure2012="+0.75"
      crs:Contrast2012="+15"
      crs:Saturation="-10"/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#;
        let s = xmp_read(lr_xml).expect("xmp_read on Lightroom snippet");
        assert!((s.adj.exposure - 0.75).abs() < 1e-4,
            "expected crs:Exposure2012=0.75, got {}", s.adj.exposure);
        assert!((s.adj.contrast - 15.0).abs() < 1e-4);
        assert!((s.adj.saturation - -10.0).abs() < 1e-4);
        assert_eq!(s.rating, Some(5));

        // Write back — crs: must still be present so Lightroom picks up
        // any further edits made here.
        let out = xmp_write(&s);
        let out_str = std::str::from_utf8(&out).unwrap();
        assert!(out_str.contains("crs:Exposure2012"),
            "crs: block missing from xmp_write output");
        assert!(out_str.contains("maple:Exposure2012"),
            "maple: dual-write block missing from xmp_write output");
    }

    #[test]
    fn dc_subject_emit_is_sorted() {
        // Insertion order is reversed; emitted order must be alphabetical
        // so byte-identical output is guaranteed across runs.
        let s = Sidecar {
            dc: DublinCore {
                subject: vec!["zebra".into(), "apple".into(), "mango".into()],
                ..Default::default()
            },
            ..Default::default()
        };
        let out = xmp_write(&s);
        let out_str = std::str::from_utf8(&out).unwrap();
        let apple = out_str.find("apple").expect("apple present");
        let mango = out_str.find("mango").expect("mango present");
        let zebra = out_str.find("zebra").expect("zebra present");
        assert!(apple < mango, "apple should come before mango");
        assert!(mango < zebra, "mango should come before zebra");

        // And byte-identical on a second call with permuted input.
        let s2 = Sidecar {
            dc: DublinCore {
                subject: vec!["apple".into(), "mango".into(), "zebra".into()],
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(out, xmp_write(&s2),
            "sort should make output insensitive to input order");
    }

    #[test]
    fn xmp_read_rejects_invalid_utf8() {
        let junk = [0xFFu8, 0xFE, 0xFD];
        assert!(xmp_read(&junk).is_err());
    }

    // ─── maple_id ──────────────────────────────────────────────────────

    fn exif_with_capture(ts: &str) -> Exif {
        Exif { captured_at: Some(ts.into()), ..Default::default() }
    }

    #[test]
    fn maple_id_primary_is_deterministic() {
        let bytes = b"the quick brown fox jumps over the lazy dog".repeat(4000);
        let exif = exif_with_capture("2025:06:01 12:34:56");
        let a = crate::id::maple_id(&bytes, &exif, Some("SERIAL42"), Some(1234));
        let b = crate::id::maple_id(&bytes, &exif, Some("SERIAL42"), Some(1234));
        assert_eq!(a, b);
        assert_eq!(a.kind(), crate::id::IdKind::Primary);
    }

    #[test]
    fn maple_id_primary_changes_with_capture_time() {
        let bytes = vec![7u8; 4096];
        let e1 = exif_with_capture("2025:06:01 12:34:56");
        let e2 = exif_with_capture("2025:06:01 12:34:57"); // +1 second
        let id1 = crate::id::maple_id(&bytes, &e1, None, None);
        let id2 = crate::id::maple_id(&bytes, &e2, None, None);
        assert_ne!(id1, id2);
    }

    #[test]
    fn maple_id_fallback_when_exif_missing() {
        let bytes = vec![42u8; 1024];
        let exif = Exif::default(); // captured_at = None
        let id = crate::id::maple_id(&bytes, &exif, None, None);
        assert_eq!(id.kind(), crate::id::IdKind::Fallback);
    }

    #[test]
    fn maple_id_tag_byte_distinguishes_forms() {
        let bytes = vec![0xA5u8; 2048];
        let primary = crate::id::MapleId::primary(&bytes, "2025:06:01 00:00:00", None, None);
        let fallback = crate::id::MapleId::fallback(&bytes, bytes.len() as u64);
        assert_ne!(primary.0[0], fallback.0[0]);
        assert_eq!(primary.0[0], crate::id::TAG_PRIMARY);
        assert_eq!(fallback.0[0], crate::id::TAG_FALLBACK);
        // And thus the full ids cannot alias.
        assert_ne!(primary, fallback);
    }

    #[test]
    fn maple_id_roundtrips_through_xmp() {
        let bytes = b"fixture-ish bytes for id".repeat(500);
        let exif = exif_with_capture("2024:12:31 23:59:59");
        let id = crate::id::maple_id(&bytes, &exif, Some("XYZ"), Some(99));
        let s = Sidecar { id: Some(id), ..Default::default() };
        let xml = xmp_write(&s);
        let parsed = xmp_read(&xml).expect("xmp_read");
        assert_eq!(parsed.id, Some(id));
    }

    #[test]
    fn maple_id_hex_roundtrip() {
        let bytes = vec![1u8, 2, 3, 4, 5];
        let id = crate::id::MapleId::fallback(&bytes, 5);
        let hex = id.to_hex();
        assert_eq!(hex.len(), 32);
        let back = crate::id::MapleId::from_hex(&hex).expect("from_hex");
        assert_eq!(back, id);
    }

    #[test]
    fn xmp_read_errors_on_unknown_flag_value() {
        let xml = br#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:maple="x"
            maple:flag="bogus"/></x>"#;
        assert!(xmp_read(xml).is_err());
    }

    // ─── helpers ───────────────────────────────────────────────────────

    /// Build a 4×4 synthetic RawImage sufficient for guard-path tests. We
    /// never actually run `apply` on this.
    fn synthetic_tiny_raw() -> RawImage {
        use crate::color::illuminant::Illuminant;
        use crate::image::CfaPattern;
        let mut color_matrices = std::collections::HashMap::new();
        color_matrices.insert(Illuminant::D65, crate::math::Matrix3([
            [0.4124, 0.3576, 0.1805],
            [0.2126, 0.7152, 0.0722],
            [0.0193, 0.1192, 0.9505],
        ]));
        RawImage {
            width: 4, height: 4,
            cfa: CfaPattern::Rggb,
            black_level: [0; 4],
            white_level: 65535,
            raw_data: vec![32768u16; 16],
            as_shot_neutral: [1.0, 1.0, 1.0],
            as_shot_cct: None,
            camera_make: "test".into(),
            camera_model: "test".into(),
            unique_camera_model: None,
            is_dng: false,
            color_matrices,
            forward_matrices: std::collections::HashMap::new(),
            orientation: ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
            crop_rect: None,
        }
    }
}
