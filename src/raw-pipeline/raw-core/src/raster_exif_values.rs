//! EXIF tag-name vocabulary and TIFF value encoding for IFD objects (#3588).
use super::ByteOrder;
use crate::{error::Result, raster_recipe::bad};

fn invalid(name: &str) -> crate::error::Error {
    bad(format!("metadata.exifTags: invalid value for {name}"))
}

fn definition(name: &str) -> Result<(u16, u16, usize)> {
    include_str!("raster_exif_tag_catalog.csv")
        .lines()
        .find_map(|line| {
            let mut fields = line.split(',');
            (fields.next()? == name)
                .then(|| {
                    Some((
                        fields.next()?.parse().ok()?,
                        fields.next()?.parse().ok()?,
                        fields.next()?.parse().ok()?,
                    ))
                })
                .flatten()
        })
        .ok_or_else(|| bad(format!("metadata.exifTags: unknown tag {name}")))
}

fn rational(name: &str, text: &str) -> Result<(i64, i64)> {
    if let Some((n, d)) = text.split_once('/') {
        return Ok((
            n.parse().map_err(|_| invalid(name))?,
            d.parse().map_err(|_| invalid(name))?,
        ));
    }
    if let Ok(integer) = text.parse::<i64>() {
        return Ok((integer, 1));
    }
    let value: f64 = text.parse().map_err(|_| invalid(name))?;
    if !value.is_finite() {
        return Err(invalid(name));
    }
    let denominator = 1_000_000i64;
    let numerator = (value * denominator as f64).round();
    if numerator < i64::MIN as f64 || numerator >= i64::MAX as f64 {
        return Err(invalid(name));
    }
    let numerator = numerator as i64;
    let mut a = numerator.unsigned_abs();
    let mut b = denominator as u64;
    while b != 0 {
        let remainder = a % b;
        a = b;
        b = remainder;
    }
    let divisor = a.max(1) as i64;
    Ok((numerator / divisor, denominator / divisor))
}

fn unsigned(name: &str, text: &str, max: u64) -> Result<u64> {
    let value: u64 = text.parse().map_err(|_| invalid(name))?;
    if value > max {
        return Err(invalid(name));
    }
    Ok(value)
}

fn signed(name: &str, text: &str, min: i64, max: i64) -> Result<i64> {
    let value: i64 = text.parse().map_err(|_| invalid(name))?;
    if value < min || value > max {
        return Err(invalid(name));
    }
    Ok(value)
}

fn numeric(name: &str, text: &str, format: u16, count: usize, order: ByteOrder) -> Result<Vec<u8>> {
    let components: Vec<&str> = text.split_whitespace().collect();
    if components.is_empty() || (count != 0 && components.len() != count) {
        return Err(invalid(name));
    }
    let mut bytes = Vec::new();
    for component in components {
        match format {
            1 => bytes.push(unsigned(name, component, u8::MAX as u64)? as u8),
            3 => bytes.extend(order.u16(unsigned(name, component, u16::MAX as u64)? as u16)),
            4 => bytes.extend(order.u32(unsigned(name, component, u32::MAX as u64)? as u32)),
            5 | 10 => {
                let (numerator, denominator) = rational(name, component)?;
                if format == 5 {
                    bytes.extend(order.u32(u32::try_from(numerator).map_err(|_| invalid(name))?));
                    bytes.extend(order.u32(u32::try_from(denominator).map_err(|_| invalid(name))?));
                } else {
                    bytes.extend(
                        order.u32(i32::try_from(numerator).map_err(|_| invalid(name))? as u32),
                    );
                    bytes.extend(
                        order.u32(i32::try_from(denominator).map_err(|_| invalid(name))? as u32),
                    );
                }
            }
            6 => bytes.push(signed(name, component, i8::MIN as i64, i8::MAX as i64)? as u8),
            8 => bytes.extend(
                order.u16(signed(name, component, i16::MIN as i64, i16::MAX as i64)? as u16),
            ),
            9 => bytes.extend(
                order.u32(signed(name, component, i32::MIN as i64, i32::MAX as i64)? as u32),
            ),
            _ => return Err(invalid(name)),
        }
    }
    Ok(bytes)
}

pub(super) fn encode(name: &str, text: &str, order: ByteOrder) -> Result<(u16, u16, u32, Vec<u8>)> {
    if text.contains('\0') {
        return Err(invalid(name));
    }
    let (tag, format, expected) = definition(name)?;
    let (format, bytes) = if (40091..=40095).contains(&tag) {
        // Windows XP tags always contain UTF-16LE, independently of TIFF byte order.
        (
            1,
            text.encode_utf16()
                .chain(std::iter::once(0))
                .flat_map(u16::to_le_bytes)
                .collect(),
        )
    } else if tag == 0x9286 {
        let mut bytes = if text.is_ascii() {
            b"ASCII\0\0\0".to_vec()
        } else {
            b"UNICODE\0".to_vec()
        };
        if text.is_ascii() {
            bytes.extend(text.as_bytes());
        } else {
            bytes.extend(text.encode_utf16().flat_map(|value| order.u16(value)));
        }
        (7, bytes)
    } else if format == 2 {
        (
            2,
            text.as_bytes()
                .iter()
                .copied()
                .chain(std::iter::once(0))
                .collect(),
        )
    } else if format == 7 {
        let numbers: Option<Vec<u8>> = text
            .split_whitespace()
            .map(|part| part.parse().ok())
            .collect();
        let bytes = match numbers {
            Some(numbers) if expected != 0 && numbers.len() == expected => numbers,
            _ => text.as_bytes().to_vec(),
        };
        if expected != 0 && bytes.len() != expected {
            return Err(invalid(name));
        }
        (7, bytes)
    } else {
        (format, numeric(name, text, format, expected, order)?)
    };
    let width = match format {
        3 | 8 => 2,
        4 | 9 => 4,
        5 | 10 => 8,
        _ => 1,
    };
    let count = u32::try_from(bytes.len() / width).map_err(|_| invalid(name))?;
    Ok((tag, format, count, bytes))
}
