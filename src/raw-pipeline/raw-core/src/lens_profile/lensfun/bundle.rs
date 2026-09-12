//! Reader for the converted Lensfun table (`db.bin`), written by
//! `src/scripts/convert_lensfun_db.py`. Little-endian throughout; the layout
//! is the "Interfaces" block of Task 3 in
//! `docs/superpowers/plans/2026-09-12-lensfun-slices-1-2.md`. Reader and
//! writer move together: bump `VERSION` when the layout changes.

pub const MAGIC: &[u8; 4] = b"MLFN";
pub const VERSION: u16 = 1;

#[derive(Clone, Debug, PartialEq)]
pub struct DatabaseVersion {
    pub commit: String,
    pub date: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Database {
    pub version: DatabaseVersion,
    pub mounts: Vec<Mount>,
    pub cameras: Vec<Camera>,
    pub lenses: Vec<Lens>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Mount {
    pub name: String,
    pub compat: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Camera {
    pub maker: String,
    pub model: String,
    pub variants: Vec<String>,
    pub mount: usize,
    pub crop: f64,
    /// `canonical_camera` of `model` and every variant, computed once at
    /// parse time so a lookup compares without allocating.
    pub canonical: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Lens {
    pub maker: String,
    pub model: String,
    pub names: Vec<String>,
    pub mounts: Vec<usize>,
    pub crop: f64,
    pub aspect: f64,
    pub rectilinear: bool,
    /// `canonical` of `model` and every name, computed once at parse time.
    pub canonical: Vec<String>,
    pub distortion: Vec<DistortionSample>,
    pub tca: Vec<TcaSample>,
    pub vignetting: Vec<VignettingSample>,
}

/// Radial polynomial already rescaled into the focal-normalised frame:
/// `scale · (1 + odd[0]·r + even[0]·r² + odd[1]·r³ + even[1]·r⁴ + even[2]·r⁶)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RadialTerms {
    pub scale: f64,
    pub even: [f64; 3],
    pub odd: [f64; 2],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DistortionSample {
    pub focal: f64,
    pub real_focal: f64,
    pub terms: RadialTerms,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TcaSample {
    pub focal: f64,
    pub real_focal: f64,
    pub red: RadialTerms,
    pub blue: RadialTerms,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VignettingSample {
    pub focal: f64,
    pub aperture: f64,
    pub distance: f64,
    pub k: [f64; 3],
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| format!("Lensfun bundle truncated at byte {}", self.at))?;
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn f32(&mut self) -> Result<f64, String> {
        Ok(f64::from(f32::from_le_bytes(
            self.take(4)?.try_into().unwrap(),
        )))
    }
    fn f32s<const N: usize>(&mut self) -> Result<[f64; N], String> {
        let mut out = [0.0; N];
        for v in &mut out {
            *v = self.f32()?;
        }
        Ok(out)
    }
    fn ascii(&mut self, n: usize) -> Result<String, String> {
        let raw = self.take(n)?;
        let end = raw.iter().position(|b| *b == 0).unwrap_or(raw.len());
        String::from_utf8(raw[..end].to_vec()).map_err(|e| e.to_string())
    }
    fn string_ref(&mut self, strings: &[String]) -> Result<String, String> {
        let index = self.u32()? as usize;
        strings
            .get(index)
            .cloned()
            .ok_or_else(|| format!("Lensfun bundle string index {index} out of range"))
    }
    fn string_list(&mut self, strings: &[String]) -> Result<Vec<String>, String> {
        let n = self.u16()? as usize;
        (0..n).map(|_| self.string_ref(strings)).collect()
    }
    fn index_list(&mut self, limit: usize, what: &str) -> Result<Vec<usize>, String> {
        let n = self.u16()? as usize;
        (0..n).map(|_| self.index(limit, what)).collect()
    }
    fn index(&mut self, limit: usize, what: &str) -> Result<usize, String> {
        let index = self.u32()? as usize;
        (index < limit)
            .then_some(index)
            .ok_or_else(|| format!("Lensfun bundle {what} index {index} out of range"))
    }
    fn terms(&mut self) -> Result<RadialTerms, String> {
        Ok(RadialTerms {
            scale: self.f32()?,
            even: self.f32s()?,
            odd: self.f32s()?,
        })
    }
}

pub fn parse(bytes: &[u8]) -> Result<Database, String> {
    let mut c = Cursor { bytes, at: 0 };
    if c.take(4)? != MAGIC {
        return Err("Lensfun bundle magic mismatch".into());
    }
    let version = c.u16()?;
    if version != VERSION {
        return Err(format!(
            "Lensfun bundle version {version}, reader expects {VERSION}"
        ));
    }
    c.u16()?; // reserved
    let (n_strings, n_mounts, n_cameras, n_lenses) = (c.u32()?, c.u32()?, c.u32()?, c.u32()?);
    let commit = c.ascii(12)?;
    let date = c.ascii(10)?;
    let strings = (0..n_strings)
        .map(|_| {
            let len = c.u16()? as usize;
            String::from_utf8(c.take(len)?.to_vec()).map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mounts = (0..n_mounts)
        .map(|_| {
            Ok(Mount {
                name: c.string_ref(&strings)?,
                compat: c.string_list(&strings)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let cameras = (0..n_cameras)
        .map(|_| {
            let maker = c.string_ref(&strings)?;
            let model = c.string_ref(&strings)?;
            let variants = c.string_list(&strings)?;
            let canonical = std::iter::once(&model)
                .chain(&variants)
                .map(|name| super::names::canonical_camera(&maker, name))
                .collect();
            Ok(Camera {
                maker,
                model,
                variants,
                mount: c.index(mounts.len(), "mount")?,
                crop: c.f32()?,
                canonical,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let lenses = (0..n_lenses)
        .map(|_| lens(&mut c, &strings, mounts.len()))
        .collect::<Result<Vec<_>, String>>()?;
    if c.at != bytes.len() {
        return Err(format!(
            "Lensfun bundle has {} trailing bytes",
            bytes.len() - c.at
        ));
    }
    Ok(Database {
        version: DatabaseVersion { commit, date },
        mounts,
        cameras,
        lenses,
    })
}

fn lens(c: &mut Cursor<'_>, strings: &[String], n_mounts: usize) -> Result<Lens, String> {
    let maker = c.string_ref(strings)?;
    let model = c.string_ref(strings)?;
    let names = c.string_list(strings)?;
    let mounts = c.index_list(n_mounts, "lens mount")?;
    let crop = c.f32()?;
    let aspect = c.f32()?;
    let rectilinear = c.u8()? == 0;
    let n_dist = c.u16()?;
    let distortion = (0..n_dist)
        .map(|_| {
            Ok(DistortionSample {
                focal: c.f32()?,
                real_focal: c.f32()?,
                terms: c.terms()?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let n_tca = c.u16()?;
    let tca = (0..n_tca)
        .map(|_| {
            Ok(TcaSample {
                focal: c.f32()?,
                real_focal: c.f32()?,
                red: c.terms()?,
                blue: c.terms()?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let n_vig = c.u16()?;
    let vignetting = (0..n_vig)
        .map(|_| {
            Ok(VignettingSample {
                focal: c.f32()?,
                aperture: c.f32()?,
                distance: c.f32()?,
                k: c.f32s()?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let canonical = std::iter::once(&model)
        .chain(&names)
        .map(|name| super::names::canonical(&maker, name))
        .collect();
    Ok(Lens {
        maker,
        model,
        names,
        mounts,
        crop,
        aspect,
        rectilinear,
        canonical,
        distortion,
        tca,
        vignetting,
    })
}
