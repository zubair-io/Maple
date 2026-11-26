//! Preview proxies kept on disk between previews of the same frames (P12 of
//! the panorama memory review), so a re-preview after an option change
//! reads each frame's proxy back instead of developing the RAW again.
//!
//! One file per frame, named for the source path and proxy edge and
//! checked against the source's size and modification time, so an edited
//! or replaced RAW develops afresh. Values are stored as their bit
//! patterns: a cached proxy is the proxy that was developed. A file that is
//! missing, stale or unreadable is a miss, and a write that fails leaves
//! the preview to develop next time; the cache never fails a preview.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use raw_core::FalloffCorrection;

use crate::ingest::{FrameMeta, FramePriors, GimbalPrior, GpsPrior, PlanarImage, ValidityMask};

const MAGIC: &[u8; 8] = b"MPXY0001";

/// A directory of cached proxies, owned by the caller.
pub(super) struct ProxyCache {
    dir: PathBuf,
}

/// What a cached proxy must still match.
#[derive(PartialEq, Eq, Debug)]
struct SourceKey {
    path: String,
    len: u64,
    modified_ns: u64,
    proxy_long_edge: u32,
}

impl ProxyCache {
    pub(super) fn new(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
        }
    }

    pub(super) fn load(&self, source: &Path, proxy_long_edge: u32) -> Option<FrameMeta> {
        let key = SourceKey::of(source, proxy_long_edge)?;
        let bytes = std::fs::read(self.file_for(source, proxy_long_edge)).ok()?;
        decode(&bytes, &key)
    }

    pub(super) fn store(&self, source: &Path, proxy_long_edge: u32, meta: &FrameMeta) {
        let Some(key) = SourceKey::of(source, proxy_long_edge) else {
            return;
        };
        if !meta.proxy.validity.all_valid() {
            return;
        }
        let file = self.file_for(source, proxy_long_edge);
        let partial = file.with_extension("partial");
        let written = std::fs::create_dir_all(&self.dir)
            .and_then(|()| std::fs::write(&partial, encode(&key, meta)))
            .and_then(|()| std::fs::rename(&partial, &file));
        if let Err(e) = written {
            let _ = std::fs::remove_file(&partial);
            eprintln!("pano preview: proxy cache write failed (non-fatal): {e}");
        }
    }

    /// Remove every cached proxy but `sources`', so the cache never holds
    /// more than the frames last previewed.
    pub(super) fn retain_only(&self, sources: &[PathBuf], proxy_long_edge: u32) {
        let keep: HashSet<PathBuf> = sources
            .iter()
            .map(|s| self.file_for(s, proxy_long_edge))
            .collect();
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            if !keep.contains(&entry.path()) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    fn file_for(&self, source: &Path, proxy_long_edge: u32) -> PathBuf {
        let mut hasher = DefaultHasher::new();
        source.hash(&mut hasher);
        proxy_long_edge.hash(&mut hasher);
        self.dir.join(format!("{:016x}.proxy", hasher.finish()))
    }
}

impl SourceKey {
    fn of(source: &Path, proxy_long_edge: u32) -> Option<Self> {
        let meta = std::fs::metadata(source).ok()?;
        let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
        Some(Self {
            path: source.to_str()?.to_owned(),
            len: meta.len(),
            modified_ns: u64::try_from(modified.as_nanos()).ok()?,
            proxy_long_edge,
        })
    }
}

fn encode(key: &SourceKey, meta: &FrameMeta) -> Vec<u8> {
    let p = &meta.proxy;
    let mut out = Writer(Vec::with_capacity(256 + p.r.len() * 12));
    out.0.extend_from_slice(MAGIC);
    out.str(&key.path);
    out.u64(key.len);
    out.u64(key.modified_ns);
    out.u32(key.proxy_long_edge);
    out.u32(meta.full_width);
    out.u32(meta.full_height);
    out.u64(meta.proxy_scale_x.to_bits());
    out.u64(meta.proxy_scale_y.to_bits());
    let priors = &meta.priors;
    out.opt(priors.focal_mm.map(|v| v.to_bits() as u64));
    out.opt(priors.focal_35mm_equiv.map(|v| v.to_bits() as u64));
    out.opt(priors.focal_px.map(f64::to_bits));
    out.u8(priors.gimbal.is_some() as u8);
    if let Some(g) = priors.gimbal {
        for v in [g.yaw_deg, g.pitch_deg, g.roll_deg] {
            out.u64(v.to_bits());
        }
    }
    out.u8(priors.gps.is_some() as u8);
    if let Some(g) = priors.gps {
        out.u64(g.lat_deg.to_bits());
        out.u64(g.lon_deg.to_bits());
        out.opt(g.relative_altitude_m.map(f64::to_bits));
    }
    out.str(&meta.camera_make);
    out.str(&meta.camera_model);
    out.u32(meta.applied_opcodes.len() as u32);
    meta.applied_opcodes.iter().for_each(|o| out.str(o));
    out.u8(match meta.falloff_correction {
        FalloffCorrection::None => 0,
        FalloffCorrection::Opcode => 1,
        FalloffCorrection::BundledProfile => 2,
    });
    out.u32(p.width());
    out.u32(p.height());
    for plane in [&p.r, &p.g, &p.b] {
        plane.iter().for_each(|v| out.u32(v.to_bits()));
    }
    out.0
}

fn decode(bytes: &[u8], key: &SourceKey) -> Option<FrameMeta> {
    let mut r = Reader(bytes.strip_prefix(MAGIC.as_slice())?);
    let stored = SourceKey {
        path: r.str()?,
        len: r.u64()?,
        modified_ns: r.u64()?,
        proxy_long_edge: r.u32()?,
    };
    if &stored != key {
        return None;
    }
    let (full_width, full_height) = (r.u32()?, r.u32()?);
    let proxy_scale_x = f64::from_bits(r.u64()?);
    let proxy_scale_y = f64::from_bits(r.u64()?);
    let focal_mm = r.opt()?.map(|b| f32::from_bits(b as u32));
    let focal_35mm_equiv = r.opt()?.map(|b| f32::from_bits(b as u32));
    let focal_px = r.opt()?.map(f64::from_bits);
    let gimbal = match r.u8()? {
        0 => None,
        _ => Some(GimbalPrior {
            yaw_deg: f64::from_bits(r.u64()?),
            pitch_deg: f64::from_bits(r.u64()?),
            roll_deg: f64::from_bits(r.u64()?),
        }),
    };
    let gps = match r.u8()? {
        0 => None,
        _ => Some(GpsPrior {
            lat_deg: f64::from_bits(r.u64()?),
            lon_deg: f64::from_bits(r.u64()?),
            relative_altitude_m: r.opt()?.map(f64::from_bits),
        }),
    };
    let camera_make = r.str()?;
    let camera_model = r.str()?;
    let applied_opcodes = (0..r.u32()?).map(|_| r.str()).collect::<Option<Vec<_>>>()?;
    let falloff_correction = match r.u8()? {
        0 => FalloffCorrection::None,
        1 => FalloffCorrection::Opcode,
        2 => FalloffCorrection::BundledProfile,
        _ => return None,
    };
    let (w, h) = (r.u32()?, r.u32()?);
    let n = w as usize * h as usize;
    let mut plane = || {
        (0..n)
            .map(|_| r.u32().map(f32::from_bits))
            .collect::<Option<Vec<_>>>()
    };
    let (pr, pg, pb) = (plane()?, plane()?, plane()?);
    if !r.0.is_empty() {
        return None;
    }
    Some(FrameMeta {
        proxy: PlanarImage::from_planes(w, h, pr, pg, pb, ValidityMask::new_filled(w, h, true)),
        proxy_scale_x,
        proxy_scale_y,
        full_width,
        full_height,
        priors: FramePriors {
            focal_mm,
            focal_35mm_equiv,
            focal_px,
            gimbal,
            gps,
        },
        camera_make,
        camera_model,
        applied_opcodes,
        falloff_correction,
    })
}

struct Writer(Vec<u8>);

impl Writer {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn opt(&mut self, v: Option<u64>) {
        self.u8(v.is_some() as u8);
        if let Some(v) = v {
            self.u64(v);
        }
    }
    fn str(&mut self, s: &str) {
        self.u32(s.len() as u32);
        self.0.extend_from_slice(s.as_bytes());
    }
}

struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let (head, rest) = self.0.split_first_chunk::<N>()?;
        self.0 = rest;
        Some(*head)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take::<1>().map(|[b]| b)
    }
    fn u32(&mut self) -> Option<u32> {
        self.take().map(u32::from_le_bytes)
    }
    fn u64(&mut self) -> Option<u64> {
        self.take().map(u64::from_le_bytes)
    }
    fn opt(&mut self) -> Option<Option<u64>> {
        match self.u8()? {
            0 => Some(None),
            _ => self.u64().map(Some),
        }
    }
    fn str(&mut self) -> Option<String> {
        let len = self.u32()? as usize;
        let bytes = self.0.get(..len)?;
        self.0 = &self.0[len..];
        String::from_utf8(bytes.to_vec()).ok()
    }
}

#[cfg(test)]
#[path = "proxy_cache_tests.rs"]
mod tests;
