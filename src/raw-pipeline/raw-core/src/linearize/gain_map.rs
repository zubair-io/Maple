//! Required pre-demosaic DNG GainMap operations (#4647).
//! Coordinates are relative to the black-normalized ActiveArea (SDK stage 2),
//! with pixel-center bilinear sampling. The scene-linear result is unbounded.

#[derive(Clone, Debug)]
pub struct GainMaps {
    maps: Vec<GainMap>,
}

#[derive(Clone, Debug)]
struct GainMap {
    area: [i32; 4],
    pitch: [u32; 2],
    plane: u32,
    points: [usize; 2],
    spacing: [f64; 2],
    origin: [f64; 2],
    planes: usize,
    values: Vec<f32>,
}

impl GainMaps {
    pub(crate) fn from_ifd(ifd: &rawler::formats::tiff::IFD) -> Result<Option<Self>, String> {
        use rawler::{formats::tiff::Value, tags::DngTag};
        let Some(entry) = ifd.get_entry(DngTag::OpcodeList2) else {
            return Ok(None);
        };
        match &entry.value {
            Value::Undefined(bytes) | Value::Byte(bytes) => Self::parse(bytes),
            _ => Err("OpcodeList2 is not a byte array".into()),
        }
    }

    pub(crate) fn parse(bytes: &[u8]) -> Result<Option<Self>, String> {
        let mut input = Cursor(bytes);
        let count = input.u32()? as usize;
        if count > input.0.len() / 16 {
            return Err("truncated OpcodeList2 headers".into());
        }
        let mut maps = Vec::new();
        for _ in 0..count {
            let id = input.u32()?;
            let version = input.u32()?;
            let flags = input.u32()?;
            let length = input.u32()? as usize;
            let payload = input.take(length)?;
            if id != 9 || version > 0x0107_0100 {
                if flags & 1 != 0 {
                    continue;
                }
                return Err(format!(
                    "unsupported required mosaic opcode {id} version {version:#x}"
                ));
            }
            maps.push(GainMap::parse(payload)?);
        }
        if !input.0.is_empty() {
            return Err("trailing OpcodeList2 bytes".into());
        }
        Ok((!maps.is_empty()).then_some(Self { maps }))
    }

    /// Evaluate operations in file order on the single mosaic plane. Pixel
    /// coordinates and dimensions describe stage 2, before DefaultCrop.
    pub(crate) fn gain(&self, x: i32, y: i32, width: u32, height: u32) -> f32 {
        self.maps.iter().fold(1.0, |gain, map| {
            if map.covers(x, y) {
                gain * map.interpolate(x, y, width, height)
            } else {
                gain
            }
        })
    }
}

impl GainMap {
    fn parse(bytes: &[u8]) -> Result<Self, String> {
        let mut input = Cursor(bytes);
        let area = [
            input.u32()? as i32,
            input.u32()? as i32,
            input.u32()? as i32,
            input.u32()? as i32,
        ];
        let plane = input.u32()?;
        let plane_count = input.u32()?;
        let pitch = [input.u32()?, input.u32()?];
        if plane_count == 0 || plane.checked_add(plane_count).is_none() {
            return Err("invalid GainMap plane range".into());
        }
        let empty = area[2] <= area[0] || area[3] <= area[1];
        if pitch.contains(&0)
            || (empty && pitch != [1, 1])
            || (!empty
                && (i64::from(pitch[0]) > i64::from(area[2]) - i64::from(area[0])
                    || i64::from(pitch[1]) > i64::from(area[3]) - i64::from(area[1])))
        {
            return Err("invalid GainMap area pitch".into());
        }
        let points = [input.u32()? as usize, input.u32()? as usize];
        let declared_spacing = [input.f64()?, input.f64()?];
        let declared_origin = [input.f64()?, input.f64()?];
        let planes = input.u32()? as usize;
        let spacing = std::array::from_fn(|a| {
            if points[a] == 1 {
                1.0
            } else {
                declared_spacing[a]
            }
        });
        let origin = std::array::from_fn(|a| {
            if points[a] == 1 {
                0.0
            } else {
                declared_origin[a]
            }
        });
        if points.contains(&0)
            || planes == 0
            || spacing.iter().any(|v| !v.is_finite() || *v <= 0.0)
            || origin.iter().any(|v| !v.is_finite())
        {
            return Err("invalid GainMap grid".into());
        }
        let length = points[0]
            .checked_mul(points[1])
            .and_then(|v| v.checked_mul(planes))
            .ok_or("GainMap size overflow")?;
        if length.checked_mul(4) != Some(input.0.len()) {
            return Err("incorrect GainMap payload size".into());
        }
        let mut values = Vec::with_capacity(length);
        for _ in 0..length {
            let v = f32::from_be_bytes(input.take(4)?.try_into().unwrap());
            if !v.is_finite() || v <= 0.0 {
                return Err("GainMap requires finite positive gains".into());
            }
            values.push(v);
        }
        Ok(Self {
            area,
            pitch,
            plane,
            points,
            spacing,
            origin,
            planes,
            values,
        })
    }

    fn covers(&self, x: i32, y: i32) -> bool {
        if self.plane != 0 {
            return false;
        }
        let [top, left, bottom, right] = self.area;
        if bottom <= top || right <= left {
            return true;
        }
        x >= left
            && x < right
            && y >= top
            && y < bottom
            && (i64::from(y) - i64::from(top)) % i64::from(self.pitch[0]) == 0
            && (i64::from(x) - i64::from(left)) % i64::from(self.pitch[1]) == 0
    }

    fn interpolate(&self, x: i32, y: i32, width: u32, height: u32) -> f32 {
        let coordinate = [f64::from(y) + 0.5, f64::from(x) + 0.5];
        let bounds = [f64::from(height), f64::from(width)];
        let grid: [f64; 2] = std::array::from_fn(|a| {
            ((coordinate[a] / bounds[a] - self.origin[a]) / self.spacing[a])
                .clamp(0.0, (self.points[a] - 1) as f64)
        });
        let lo = grid.map(|v| v.floor() as usize);
        let hi: [usize; 2] = std::array::from_fn(|a| (lo[a] + 1).min(self.points[a] - 1));
        let f: [f32; 2] = std::array::from_fn(|a| (grid[a] - lo[a] as f64) as f32);
        let value = |row, col| self.values[(row * self.points[1] + col) * self.planes];
        let left = value(lo[0], lo[1]) * (1.0 - f[0]) + value(hi[0], lo[1]) * f[0];
        let right = value(lo[0], hi[1]) * (1.0 - f[0]) + value(hi[0], hi[1]) * f[0];
        // SDK's row blend is f32; the column base/delta accumulation is f64.
        (f64::from(left) + (f64::from(right) - f64::from(left)) * (grid[1] - lo[1] as f64)) as f32
    }
}

struct Cursor<'a>(&'a [u8]);
impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if n > self.0.len() {
            return Err("truncated GainMap opcode".into());
        }
        let (out, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(out)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
}
