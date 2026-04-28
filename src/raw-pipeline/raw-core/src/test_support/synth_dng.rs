//! Synthetic Bayer DNG writer — see Task 2 onward.

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
}
