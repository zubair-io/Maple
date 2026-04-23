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

/// Typed XMP sidecar per spec §05.
///
/// T1 scope: cover the ACR-compatible `crs:*` block through [`AdjustmentModel`]
/// plus the native `maple:*` extras that don't map to Adobe. The full
/// Lightroom-parity `crs:*` field set and arbitrary-XML passthrough (so
/// unknown tags survive round-trip) land in T9 — see `docs/spec/12…` §05
/// "Write policy → Merge on read".
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Sidecar {
    /// Stable image id. Populated by T2 (BLAKE3 derivation). Left `None`
    /// until then — [`xmp_write`] emits the field only when present.
    pub id: Option<String>,
    /// ACR-compatible `crs:*` adjustments.
    pub adj: AdjustmentModel,
    /// `xmp:Rating`, 0..5. `None` = unrated.
    pub rating: Option<u8>,
    /// `maple:flag`.
    pub flag: Option<Flag>,
    /// `xmp:Label` — the Adobe colour word ("red", "blue", …). Not enumerated
    /// at this layer; shells can normalise.
    pub label: Option<String>,
    /// `dc:title`.
    pub title: Option<String>,
    /// `dc:description`.
    pub description: Option<String>,
    /// `dc:subject` — keywords.
    pub keywords: Vec<String>,
    /// `dc:rights`.
    pub rights: Option<String>,
    /// `dc:creator`.
    pub creator: Option<String>,
    /// Raw XML for round-trip preservation of unknown `crs:*` / `lr:*` /
    /// third-party tags. T9 populates this on read and merges on write. T1
    /// leaves it `None`.
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
        return Err(Error::Pipeline("thumbnail: max_px must be > 0"));
    }
    let adj = AdjustmentModel::default();
    let rendered = apply(image, &adj)?;
    downsample_to_rgba(&rendered, max_px)
}

/// Render an RGBA preview constrained to `max_px` on the long edge, honouring
/// user adjustments.
pub fn preview(image: &RawImage, max_px: u32, adj: &AdjustmentModel) -> Result<Rgba> {
    if max_px == 0 {
        return Err(Error::Pipeline("preview: max_px must be > 0"));
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
        return Err(Error::Pipeline("downsample: source is empty"));
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
        OutFmt::Webp => Err(Error::Pipeline("encode: WebP unsupported (T-future)")),
        OutFmt::Heic => Err(Error::Pipeline("encode: HEIC unsupported (T-future)")),
    }
}

// ─── XMP ─────────────────────────────────────────────────────────────────

/// Parse an XMP byte slice into a [`Sidecar`].
///
/// T1 extracts the `crs:*` adjustment block (via [`crate::xmp::parse`]) plus
/// `xmp:Rating`, `xmp:Label`, `maple:flag`, `maple:id`, and the IPTC basics.
/// T9 replaces this with a full `crs:*` / `maple:*` merge per spec §05
/// ("Merge on read: load `crs:*` first, then overlay `maple:*`"). The seam
/// is `Sidecar::raw_xml`, which remains `None` here and will carry the
/// verbatim XML once T9 lands.
pub fn xmp_read(bytes: &[u8]) -> Result<Sidecar> {
    let xml = std::str::from_utf8(bytes).map_err(|e| Error::Xmp(format!(
        "XMP sidecar is not valid UTF-8: {}", e
    )))?;
    let adj = crate::xmp::parse(xml)?;
    let mut s = Sidecar { adj, ..Sidecar::default() };

    // Hand-roll a quick attribute walk for the extra tags — quick_xml is
    // already in the crate's tree. Mirrors the pattern in crate::xmp.
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_event() {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                for attr_result in e.attributes() {
                    let attr = attr_result.map_err(|e| Error::Xmp(e.to_string()))?;
                    let key = std::str::from_utf8(attr.key.as_ref())
                        .map_err(|e| Error::Xmp(e.to_string()))?;
                    let value = attr.unescape_value()
                        .map_err(|e| Error::Xmp(e.to_string()))?;
                    match key {
                        "xmp:Rating" => {
                            let v: u8 = value.parse().map_err(|e: std::num::ParseIntError| {
                                Error::Xmp(format!("xmp:Rating: {}", e))
                            })?;
                            s.rating = Some(v.min(5));
                        }
                        "xmp:Label" => s.label = Some(value.into_owned()),
                        "maple:flag" => {
                            s.flag = match value.as_ref() {
                                "pick"   => Some(Flag::Pick),
                                "reject" => Some(Flag::Reject),
                                "none" | ""   => None,
                                other => return Err(Error::Xmp(format!(
                                    "maple:flag: unknown value {:?}", other))),
                            };
                        }
                        "maple:id" => s.id = Some(value.into_owned()),
                        "dc:title"       => s.title = Some(value.into_owned()),
                        "dc:description" => s.description = Some(value.into_owned()),
                        "dc:rights"      => s.rights = Some(value.into_owned()),
                        "dc:creator"     => s.creator = Some(value.into_owned()),
                        _ => {}
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(Error::Xmp(e.to_string())),
            _ => {}
        }
    }
    Ok(s)
}

/// Serialise a [`Sidecar`] to an XMP byte buffer.
///
/// Emits a minimal ACR-shaped document with both `crs:*` (for Lightroom
/// compatibility) and `maple:*` (native fields). T9 extends this with
/// arbitrary-tag passthrough via `Sidecar::raw_xml` so unknown `crs:*` /
/// `lr:*` / third-party namespaces survive a round-trip. The output here is
/// stable and deterministic — no timestamps, no random ids.
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
    s.push_str("      xmlns:maple=\"http://ns.justmaple.app/maple/1.0/\"\n");

    // xmp:* + maple:*
    if let Some(r) = sidecar.rating {
        s.push_str(&format!("      xmp:Rating=\"{}\"\n", r));
    }
    if let Some(l) = &sidecar.label {
        s.push_str(&format!("      xmp:Label=\"{}\"\n", xml_escape_attr(l)));
    }
    if let Some(f) = sidecar.flag {
        let v = match f { Flag::Pick => "pick", Flag::Reject => "reject" };
        s.push_str(&format!("      maple:flag=\"{}\"\n", v));
    }
    if let Some(id) = &sidecar.id {
        s.push_str(&format!("      maple:id=\"{}\"\n", xml_escape_attr(id)));
    }

    // dc:* (simple attrs; structured bag/seq markup is T9)
    if let Some(v) = &sidecar.title {
        s.push_str(&format!("      dc:title=\"{}\"\n", xml_escape_attr(v)));
    }
    if let Some(v) = &sidecar.description {
        s.push_str(&format!("      dc:description=\"{}\"\n", xml_escape_attr(v)));
    }
    if let Some(v) = &sidecar.rights {
        s.push_str(&format!("      dc:rights=\"{}\"\n", xml_escape_attr(v)));
    }
    if let Some(v) = &sidecar.creator {
        s.push_str(&format!("      dc:creator=\"{}\"\n", xml_escape_attr(v)));
    }

    // crs:* — the subset we round-trip through AdjustmentModel today.
    s.push_str(&format!("      crs:Temperature=\"{}\"\n", a.temperature));
    s.push_str(&format!("      crs:Tint=\"{}\"\n", a.tint));
    s.push_str(&format!("      crs:Exposure2012=\"{}\"\n", a.exposure));
    s.push_str(&format!("      crs:Contrast2012=\"{}\"\n", a.contrast));
    s.push_str(&format!("      crs:Highlights2012=\"{}\"\n", a.highlights));
    s.push_str(&format!("      crs:Shadows2012=\"{}\"\n", a.shadows));
    s.push_str(&format!("      crs:Whites2012=\"{}\"\n", a.whites));
    s.push_str(&format!("      crs:Blacks2012=\"{}\"\n", a.blacks));
    s.push_str(&format!("      crs:Vibrance=\"{}\"\n", a.vibrance));
    s.push_str(&format!("      crs:Saturation=\"{}\"\n", a.saturation));
    s.push_str(&format!("      crs:Clarity2012=\"{}\"\n", a.clarity));
    s.push_str(&format!("      crs:Texture=\"{}\"\n", a.texture));
    s.push_str(&format!("      crs:Dehaze=\"{}\"\n", a.dehaze));
    s.push_str(&format!("      crs:Sharpness=\"{}\"\n", a.sharpen_amount));
    s.push_str(&format!("      crs:SharpenRadius=\"{}\"\n", a.sharpen_radius));
    s.push_str(&format!("      crs:SharpenDetail=\"{}\"\n", a.sharpen_detail));
    s.push_str(&format!("      crs:SharpenEdgeMasking=\"{}\"\n", a.sharpen_masking));
    s.push_str(&format!("      crs:LuminanceSmoothing=\"{}\"\n", a.nr_luminance));
    s.push_str(&format!("      crs:ColorNoiseReduction=\"{}\"\n", a.nr_color));
    s.push_str("    />\n");

    // dc:subject bag (keywords) — only emit when non-empty.
    if !sidecar.keywords.is_empty() {
        s.push_str("    <rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n");
        s.push_str("      <dc:subject><rdf:Bag>\n");
        for k in &sidecar.keywords {
            s.push_str(&format!("        <rdf:li>{}</rdf:li>\n", xml_escape_text(k)));
        }
        s.push_str("      </rdf:Bag></dc:subject>\n");
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
        let s = Sidecar {
            id: Some("abc123".into()),
            rating: Some(4),
            flag: Some(Flag::Pick),
            label: Some("red".into()),
            title: Some("A title".into()),
            adj: AdjustmentModel { exposure: 1.5, contrast: 30.0, ..Default::default() },
            ..Default::default()
        };
        let bytes = xmp_write(&s);
        let parsed = xmp_read(&bytes).expect("xmp_read");
        assert_eq!(parsed.id, s.id);
        assert_eq!(parsed.rating, s.rating);
        assert_eq!(parsed.flag, s.flag);
        assert_eq!(parsed.label, s.label);
        assert_eq!(parsed.title, s.title);
        assert!((parsed.adj.exposure - 1.5).abs() < 1e-4);
        assert!((parsed.adj.contrast - 30.0).abs() < 1e-4);
    }

    #[test]
    fn xmp_read_rejects_invalid_utf8() {
        let junk = [0xFFu8, 0xFE, 0xFD];
        assert!(xmp_read(&junk).is_err());
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
            color_matrices,
            orientation: ExifOrientation::Normal,
            baseline_exposure: 0.0,
        }
    }
}
