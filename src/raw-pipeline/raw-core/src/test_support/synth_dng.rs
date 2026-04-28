//! Synthetic Bayer DNG writer — see Task 2 onward.

const TYPE_BYTE: u16 = 1;
const TYPE_ASCII: u16 = 2;
const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;
const TYPE_RATIONAL: u16 = 5;
const TYPE_SRATIONAL: u16 = 10;

#[derive(Clone)]
pub(crate) enum IfdEntry {
    Short(u16, u16),                       // tag, value (single)
    Shorts(u16, Vec<u16>),                 // tag, values
    Long(u16, u32),                        // tag, value (single)
    Bytes(u16, Vec<u8>),                   // tag, values (count = len)
    Ascii(u16, String),                    // tag, NUL-terminated ASCII
    Rationals(u16, Vec<(u32, u32)>),       // tag, num/den pairs
    SRationals(u16, Vec<(i32, i32)>),      // tag, signed num/den
}

impl IfdEntry {
    fn tag(&self) -> u16 {
        match self {
            Self::Short(t, _)      => *t,
            Self::Shorts(t, _)     => *t,
            Self::Long(t, _)       => *t,
            Self::Bytes(t, _)      => *t,
            Self::Ascii(t, _)      => *t,
            Self::Rationals(t, _)  => *t,
            Self::SRationals(t, _) => *t,
        }
    }

    fn type_id(&self) -> u16 {
        match self {
            Self::Short(_, _) | Self::Shorts(_, _) => TYPE_SHORT,
            Self::Long(_, _)                       => TYPE_LONG,
            Self::Bytes(_, _)                      => TYPE_BYTE,
            Self::Ascii(_, _)                      => TYPE_ASCII,
            Self::Rationals(_, _)                  => TYPE_RATIONAL,
            Self::SRationals(_, _)                 => TYPE_SRATIONAL,
        }
    }

    fn count(&self) -> u32 {
        match self {
            Self::Short(_, _)        => 1,
            Self::Shorts(_, v)       => v.len() as u32,
            Self::Long(_, _)         => 1,
            Self::Bytes(_, v)        => v.len() as u32,
            Self::Ascii(_, s)        => s.len() as u32 + 1, // includes NUL
            Self::Rationals(_, v)    => v.len() as u32,
            Self::SRationals(_, v)   => v.len() as u32,
        }
    }

    /// Serialise the value payload into a fresh buffer (either the full
    /// payload for overflow, or the same bytes that go in the inline value
    /// slot — caller pads to 4 bytes when inline).
    fn payload_bytes_vec(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        match self {
            Self::Short(_, v) => write_u16_le(&mut buf, *v),
            Self::Shorts(_, v) => {
                for &x in v { write_u16_le(&mut buf, x); }
            }
            Self::Long(_, v) => write_u32_le(&mut buf, *v),
            Self::Bytes(_, v) => buf.extend_from_slice(v),
            Self::Ascii(_, s) => {
                buf.extend_from_slice(s.as_bytes());
                buf.push(0); // NUL
            }
            Self::Rationals(_, v) => {
                for (n, d) in v { write_rational(&mut buf, *n, *d); }
            }
            Self::SRationals(_, v) => {
                for (n, d) in v { write_srational(&mut buf, *n, *d); }
            }
        }
        buf
    }
}

pub(crate) struct Ifd {
    entries: Vec<IfdEntry>,
}

impl Ifd {
    pub(crate) fn new() -> Self { Self { entries: Vec::new() } }

    pub(crate) fn add_short(&mut self, tag: u16, value: u16)         { self.entries.push(IfdEntry::Short(tag, value)); }
    pub(crate) fn add_shorts(&mut self, tag: u16, values: Vec<u16>)  { self.entries.push(IfdEntry::Shorts(tag, values)); }
    pub(crate) fn add_long(&mut self, tag: u16, value: u32)          { self.entries.push(IfdEntry::Long(tag, value)); }
    pub(crate) fn add_bytes(&mut self, tag: u16, values: Vec<u8>)    { self.entries.push(IfdEntry::Bytes(tag, values)); }
    pub(crate) fn add_ascii(&mut self, tag: u16, s: &str)            { self.entries.push(IfdEntry::Ascii(tag, s.to_string())); }
    pub(crate) fn add_rationals(&mut self, tag: u16, v: Vec<(u32, u32)>)  { self.entries.push(IfdEntry::Rationals(tag, v)); }
    pub(crate) fn add_srationals(&mut self, tag: u16, v: Vec<(i32, i32)>) { self.entries.push(IfdEntry::SRationals(tag, v)); }

    /// Serialise: sort entries by tag, then write
    ///   [u16 count][12-byte entry × N][u32 next=0][overflow bytes...]
    /// `file_offset` is the absolute file position where this IFD starts —
    /// needed to compute correct overflow-data offsets.
    pub(crate) fn serialise_into(mut self, buf: &mut Vec<u8>, file_offset: u32) {
        self.entries.sort_by_key(|e| e.tag());
        let n = self.entries.len() as u16;

        // Directory size: 2 (count) + 12 * n + 4 (next-IFD).
        let dir_size = 2 + 12 * (n as u32) + 4;
        let mut overflow_cursor = file_offset + dir_size;
        let mut overflow_buf: Vec<u8> = Vec::new();

        write_u16_le(buf, n);
        for entry in &self.entries {
            write_u16_le(buf, entry.tag());
            write_u16_le(buf, entry.type_id());
            write_u32_le(buf, entry.count());
            let payload = entry.payload_bytes_vec();
            if payload.len() <= 4 {
                // Inline. Pad to 4 bytes with zeros.
                let mut padded = payload.clone();
                padded.resize(4, 0);
                buf.extend_from_slice(&padded);
            } else {
                // Overflow. Value slot holds absolute file offset.
                write_u32_le(buf, overflow_cursor);
                overflow_cursor += payload.len() as u32;
                overflow_buf.extend_from_slice(&payload);
                // Pad overflow to even byte boundary per TIFF spec.
                if overflow_buf.len() % 2 != 0 {
                    overflow_buf.push(0);
                    overflow_cursor += 1;
                }
            }
        }
        // Next-IFD offset (0 = last).
        write_u32_le(buf, 0);
        // Overflow data follows directory.
        buf.extend_from_slice(&overflow_buf);
    }
}

pub(crate) fn write_u16_le(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_le_bytes());
}

pub(crate) fn write_u32_le(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

pub(crate) fn write_rational(buf: &mut Vec<u8>, num: u32, den: u32) {
    write_u32_le(buf, num);
    write_u32_le(buf, den);
}

pub(crate) fn write_srational(buf: &mut Vec<u8>, num: i32, den: i32) {
    buf.extend_from_slice(&num.to_le_bytes());
    buf.extend_from_slice(&den.to_le_bytes());
}

/// Compute per-CFA-position 16-bit raw values that decode to a uniform
/// scene-linear neutral `linear_value` after black subtract, dynamic-range
/// normalisation, and WB. `as_shot_neutral` follows DNG semantics
/// (camera reading of a neutral, G-normalised). Returns `(raw_r, raw_g, raw_b)`.
pub(crate) fn compute_raw_values(
    linear_value: f32,
    as_shot_neutral: [f32; 3],
    black_level: u16,
    white_level: u16,
) -> (u16, u16, u16) {
    let bl = black_level as f32;
    let wl = white_level as f32;
    let range = wl - bl;
    let wb = [
        1.0 / as_shot_neutral[0],
        1.0 / as_shot_neutral[1],
        1.0 / as_shot_neutral[2],
    ];
    let raw = |w: f32| -> u16 {
        let v = bl + (linear_value / w) * range;
        v.round().clamp(0.0, u16::MAX as f32) as u16
    };
    (raw(wb[0]), raw(wb[1]), raw(wb[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_values_for_l_018_d65_balance() {
        // L = 0.18, AsShotNeutral = (0.5, 1.0, 0.5) → WB = (2.0, 1.0, 2.0).
        // raw = BL + (L / WB) * (WL - BL) = 0 + (0.18/WB) * 65535.
        //   R: 0.18/2.0 * 65535 = 5898.15 → 5898
        //   G: 0.18/1.0 * 65535 = 11796.30 → 11796
        //   B: 0.18/2.0 * 65535 = 5898.15 → 5898
        let (r, g, b) = compute_raw_values(0.18, [0.5, 1.0, 0.5], 0, 65535);
        assert_eq!(r, 5898);
        assert_eq!(g, 11796);
        assert_eq!(b, 5898);
    }

    #[test]
    fn raw_values_clamp_to_white_level() {
        // Drive L past every channel's saturation point. With WB_G = 1.0
        // scene-linear 1.0 needs raw_G = WL; with WB_R = WB_B = 2.0
        // scene-linear 2.0 needs raw_R = raw_B = WL. Pass L = 3.0 to
        // saturate every channel and confirm the clamp fires.
        let (r, g, b) = compute_raw_values(3.0, [0.5, 1.0, 0.5], 0, 65535);
        assert_eq!(r, 65535);
        assert_eq!(g, 65535);
        assert_eq!(b, 65535);
    }

    #[test]
    fn raw_values_unsaturated_at_l_one() {
        // Sanity check: at L = 1.0, only the channel with WB = 1.0 hits WL;
        // the doubled channels land at WL / 2 (rounded) — no clamp needed.
        let (r, g, b) = compute_raw_values(1.0, [0.5, 1.0, 0.5], 0, 65535);
        assert_eq!(g, 65535);
        // 0 + (1.0 / 2.0) * 65535 = 32767.5 → 32768
        assert_eq!(r, 32768);
        assert_eq!(b, 32768);
    }

    #[test]
    fn raw_values_zero_for_zero_l() {
        let (r, g, b) = compute_raw_values(0.0, [0.5, 1.0, 0.5], 100, 65535);
        assert_eq!(r, 100);
        assert_eq!(g, 100);
        assert_eq!(b, 100);
    }

    #[test]
    fn writes_u16_le() {
        let mut buf = Vec::new();
        write_u16_le(&mut buf, 0x1234);
        assert_eq!(buf, vec![0x34, 0x12]);
    }

    #[test]
    fn writes_u32_le() {
        let mut buf = Vec::new();
        write_u32_le(&mut buf, 0xDEAD_BEEF);
        assert_eq!(buf, vec![0xEF, 0xBE, 0xAD, 0xDE]);
    }

    #[test]
    fn writes_rational_le() {
        let mut buf = Vec::new();
        write_rational(&mut buf, 1, 2);
        assert_eq!(buf, vec![1, 0, 0, 0, 2, 0, 0, 0]);
    }

    #[test]
    fn writes_srational_le() {
        let mut buf = Vec::new();
        write_srational(&mut buf, -1, 2);
        // -1 as i32 little-endian = 0xFFFFFFFF
        assert_eq!(buf, vec![0xFF, 0xFF, 0xFF, 0xFF, 2, 0, 0, 0]);
    }

    #[test]
    fn ifd_with_two_short_entries_serialises_to_expected_bytes() {
        // Build IFD with two SHORT entries (each fits in the 4-byte value
        // slot, no overflow data). ImageWidth = 64, ImageLength = 64.
        // Layout (file_offset = 0 for this test):
        //   [u16 count=2]
        //   [tag=256, type=3 (SHORT), count=1, value=64 (in low 2 bytes)]
        //   [tag=257, type=3 (SHORT), count=1, value=64]
        //   [u32 next=0]
        // = 2 + 12 + 12 + 4 = 30 bytes
        let mut ifd = Ifd::new();
        ifd.add_short(256, 64);
        ifd.add_short(257, 64);
        let mut buf = Vec::new();
        ifd.serialise_into(&mut buf, /*file_offset_of_ifd*/ 0);
        assert_eq!(buf.len(), 30);
        // Count
        assert_eq!(&buf[0..2], &[2, 0]);
        // First entry: tag 256 (0x0100), type 3, count 1, value 64
        assert_eq!(&buf[2..4],  &[0x00, 0x01]);   // tag
        assert_eq!(&buf[4..6],  &[3, 0]);          // type = SHORT
        assert_eq!(&buf[6..10], &[1, 0, 0, 0]);    // count = 1
        assert_eq!(&buf[10..14], &[64, 0, 0, 0]);  // value = 64 (padded)
        // Next-IFD offset = 0
        assert_eq!(&buf[26..30], &[0, 0, 0, 0]);
    }

    #[test]
    fn ifd_with_overflow_entry_emits_data_after_directory() {
        // ColorMatrix1 (tag 50721): 9 SRATIONAL = 72 bytes, overflows.
        // The IFD entry holds an offset; the data bytes follow.
        let mut ifd = Ifd::new();
        ifd.add_srationals(50721, vec![(1, 1); 9]);
        let mut buf = Vec::new();
        let file_offset = 100u32;
        ifd.serialise_into(&mut buf, file_offset);
        // 2 (count) + 12 (entry) + 4 (next) + 72 (overflow data) = 90 bytes
        assert_eq!(buf.len(), 90);
        // Entry's value slot is the absolute file offset of the overflow:
        // file_offset + 2 + 12 + 4 = 118.
        let expected_overflow_offset: u32 = file_offset + 2 + 12 + 4;
        assert_eq!(&buf[10..14], &expected_overflow_offset.to_le_bytes());
    }
}
