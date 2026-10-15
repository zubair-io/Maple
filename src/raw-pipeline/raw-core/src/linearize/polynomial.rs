//! DNG OpcodeList2 MapPolynomial transfer for 8-bit LinearRaw (#4629).
//!
//! Adobe's lossy DNG stores the inverse encoding as required per-plane
//! polynomials. These operate on black/white-normalized camera samples,
//! before WB or DCP. A guessed display gamma is not this transfer.
//! Layout/evaluation: Adobe DNG SDK `dng_misc_opcodes.cpp`, MapPolynomial.

use crate::image::Image;
use rayon::prelude::*;

#[derive(Clone, Debug)]
pub struct PolynomialTransfer {
    operations: Vec<Polynomial>,
}

#[derive(Clone, Debug)]
struct Polynomial {
    area: [i32; 4], // top, left, bottom, right; empty means whole image
    plane: u32,
    planes: u32,
    row_pitch: u32,
    col_pitch: u32,
    coefficients: Vec<f32>, // constant first
}

impl PolynomialTransfer {
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

    /// Parse a big-endian OpcodeList2. Unknown optional operations may be
    /// skipped; unknown required operations and malformed data fail closed.
    pub(crate) fn parse(bytes: &[u8]) -> Result<Option<Self>, String> {
        let mut cursor = Cursor(bytes);
        let count = cursor.u32()? as usize;
        if count > cursor.0.len() / 16 {
            return Err("truncated opcode headers".into());
        }
        let mut operations = Vec::new();
        for _ in 0..count {
            let id = cursor.u32()?;
            let version = cursor.u32()?;
            let flags = cursor.u32()?;
            let length = cursor.u32()? as usize;
            let data = cursor.take(length)?;
            if id != 8 || version > 0x0107_0100 {
                if flags & 1 != 0 {
                    continue;
                }
                return Err(format!(
                    "unsupported required opcode {id} version {version:#x}"
                ));
            }
            operations.push(Polynomial::parse(data)?);
        }
        if !cursor.0.is_empty() {
            return Err("trailing OpcodeList2 bytes".into());
        }
        Ok((!operations.is_empty()).then_some(Self { operations }))
    }

    pub(crate) fn apply(&self, image: &mut Image) {
        // Operations can overlap and must retain their declared order.
        // Each operation is independent across rows; no extra image buffer.
        for operation in &self.operations {
            operation.apply(image);
        }
    }
}

impl Polynomial {
    fn parse(bytes: &[u8]) -> Result<Self, String> {
        let mut cursor = Cursor(bytes);
        let area = [
            cursor.u32()? as i32,
            cursor.u32()? as i32,
            cursor.u32()? as i32,
            cursor.u32()? as i32,
        ];
        let plane = cursor.u32()?;
        let planes = cursor.u32()?;
        let row_pitch = cursor.u32()?;
        let col_pitch = cursor.u32()?;
        let degree = cursor.u32()?;
        if degree > 8 || planes == 0 || plane.checked_add(planes).is_none() {
            return Err("invalid polynomial degree or planes".into());
        }
        let empty = area[2] <= area[0] || area[3] <= area[1];
        let valid_pitch = row_pitch > 0
            && col_pitch > 0
            && if empty {
                row_pitch == 1 && col_pitch == 1
            } else {
                i64::from(row_pitch) <= i64::from(area[2]) - i64::from(area[0])
                    && i64::from(col_pitch) <= i64::from(area[3]) - i64::from(area[1])
            };
        if !valid_pitch {
            return Err("invalid polynomial area pitch".into());
        }
        let mut coefficients = Vec::with_capacity(degree as usize + 1);
        for _ in 0..=degree {
            let c = f64::from_be_bytes(cursor.take(8)?.try_into().unwrap()) as f32;
            if !c.is_finite() {
                return Err("nonfinite polynomial coefficient".into());
            }
            coefficients.push(c);
        }
        if !cursor.0.is_empty() {
            return Err("incorrect polynomial payload size".into());
        }
        Ok(Self {
            area,
            plane,
            planes,
            row_pitch,
            col_pitch,
            coefficients,
        })
    }

    fn apply(&self, image: &mut Image) {
        if image.width == 0 {
            return;
        }
        let all = self.area[2] <= self.area[0] || self.area[3] <= self.area[1];
        let [top, left, bottom, right] = if all {
            [0, 0, i64::from(image.height), i64::from(image.width)]
        } else {
            self.area.map(i64::from)
        };
        let start_col = left.max(0);
        let start_col = start_col + (left - start_col).rem_euclid(i64::from(self.col_pitch));
        let end_col = right.min(i64::from(image.width)).max(0);
        let plane_end = (self.plane + self.planes).min(3) as usize;
        let plane_start = self.plane.min(3) as usize;
        image
            .pixels
            .par_chunks_mut(image.width as usize)
            .enumerate()
            .for_each(|(y, row)| {
                let y = y as i64;
                if y < top || y >= bottom || (y - top) % i64::from(self.row_pitch) != 0 {
                    return;
                }
                for x in (start_col..end_col).step_by(self.col_pitch as usize) {
                    for value in &mut row[x as usize][plane_start..plane_end] {
                        let input = *value;
                        *value = self
                            .coefficients
                            .iter()
                            .rev()
                            .fold(0.0, |v, c| c + input * v);
                    }
                }
            });
    }
}

struct Cursor<'a>(&'a [u8]);
impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if n > self.0.len() {
            return Err("truncated polynomial opcode".into());
        }
        let (result, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(result)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
}

#[cfg(test)]
#[path = "polynomial_tests.rs"]
mod tests;
