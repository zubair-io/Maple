//! Minimal ICC v2 matrix/TRC profile writer for the export color spaces (#943).
//!
//! Export writes real files that leave Maple, so the bytes have to say which
//! primaries they carry. An untagged file is interpreted as sRGB by every
//! color-managed viewer, so shipping Display P3 pixels untagged reproduces
//! exactly the over-saturation defect #1913 fixed on the live canvas — the
//! wider-gamut numbers get stretched a second time through the narrower
//! space. Tagging is therefore not decoration; it is what makes the
//! `TargetPrimaries::P3` export option mean anything.
//!
//! There is no ICC-writing crate in the dependency tree and the profiles we
//! need are the simplest kind the spec defines — a matrix/TRC display
//! profile — so we emit them directly. Both profiles share the IEC 61966-2-1
//! transfer function (which is what [`crate::view::encode::srgb_gamma_encode`]
//! applies for both targets) and differ only in primaries.
//!
//! The colorant tags are DERIVED from the chromaticities below rather than
//! copied out of an existing profile: the derivation is checked against the
//! canonical published colorants in the tests at the bottom, so a typo
//! surfaces as a failing assert instead of a subtly wrong export.

use crate::math::Matrix3;
use crate::view::encode::TargetPrimaries;

/// CIE xy chromaticities of a set of RGB primaries plus its white point.
struct Chromaticities {
    red: (f32, f32),
    green: (f32, f32),
    blue: (f32, f32),
    white: (f32, f32),
}

/// sRGB / Rec.709 primaries, D65 white (IEC 61966-2-1).
const SRGB: Chromaticities = Chromaticities {
    red: (0.6400, 0.3300),
    green: (0.3000, 0.6000),
    blue: (0.1500, 0.0600),
    white: (0.3127, 0.3290),
};

/// Display P3 — SMPTE RP 431-2 primaries with a D65 white and the sRGB TRC.
const DISPLAY_P3: Chromaticities = Chromaticities {
    red: (0.6800, 0.3200),
    green: (0.2650, 0.6900),
    blue: (0.1500, 0.0600),
    white: (0.3127, 0.3290),
};

/// The ICC PCS illuminant: D50, as fixed by the spec (not a choice).
const PCS_D50: [f32; 3] = [0.9642, 1.0, 0.8249];

/// Bradford cone-response matrix — the chromatic-adaptation transform ICC
/// display profiles conventionally use to carry D65-native colorants into the
/// D50 PCS.
const BRADFORD: Matrix3 = Matrix3([
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
]);

/// Entries in the `curv` TRC tables. 1024 is what the reference sRGB profile
/// ships and is far finer than the 8-/16-bit data it describes.
const TRC_ENTRIES: usize = 1024;

/// The ICC profile describing the bytes a `target`-primaries export carries.
///
/// Embed the result via `image`'s `ImageEncoder::set_icc_profile` (JPEG, PNG
/// and TIFF all accept one).
pub fn profile_for(target: TargetPrimaries) -> Vec<u8> {
    let (chroma, description) = match target {
        TargetPrimaries::Srgb => (&SRGB, "Maple sRGB"),
        TargetPrimaries::P3 => (&DISPLAY_P3, "Maple Display P3"),
    };
    build(chroma, description)
}

/// XYZ of an xy chromaticity at unit luminance.
fn xy_to_xyz(xy: (f32, f32)) -> [f32; 3] {
    let (x, y) = xy;
    [x / y, 1.0, (1.0 - x - y) / y]
}

/// RGB → XYZ for `chroma`, in the chromaticities' own (D65) white.
///
/// Standard construction: scale each primary's unit-luminance XYZ so the
/// three together sum to the white point.
fn rgb_to_xyz(chroma: &Chromaticities) -> Matrix3 {
    let r = xy_to_xyz(chroma.red);
    let g = xy_to_xyz(chroma.green);
    let b = xy_to_xyz(chroma.blue);
    let primaries = Matrix3([[r[0], g[0], b[0]], [r[1], g[1], b[1]], [r[2], g[2], b[2]]]);
    let white = xy_to_xyz(chroma.white);
    let scale = primaries
        .inverse()
        .expect("RGB primaries are linearly independent by construction")
        .mul_vec(white);
    Matrix3([
        [r[0] * scale[0], g[0] * scale[1], b[0] * scale[2]],
        [r[1] * scale[0], g[1] * scale[1], b[1] * scale[2]],
        [r[2] * scale[0], g[2] * scale[1], b[2] * scale[2]],
    ])
}

/// Bradford chromatic adaptation from `src_white` to `dst_white` (both XYZ).
fn bradford_adaptation(src_white: [f32; 3], dst_white: [f32; 3]) -> Matrix3 {
    let src_cone = BRADFORD.mul_vec(src_white);
    let dst_cone = BRADFORD.mul_vec(dst_white);
    let ratio = Matrix3([
        [dst_cone[0] / src_cone[0], 0.0, 0.0],
        [0.0, dst_cone[1] / src_cone[1], 0.0],
        [0.0, 0.0, dst_cone[2] / src_cone[2]],
    ]);
    let inverse = BRADFORD
        .inverse()
        .expect("the Bradford cone-response matrix is invertible");
    inverse.mul_mat(&ratio).mul_mat(&BRADFORD)
}

/// The colorant columns an ICC profile stores: RGB → XYZ adapted into the D50 PCS.
fn d50_colorants(chroma: &Chromaticities) -> Matrix3 {
    let adaptation = bradford_adaptation(xy_to_xyz(chroma.white), PCS_D50);
    adaptation.mul_mat(&rgb_to_xyz(chroma))
}

/// s15Fixed16Number — the ICC fixed-point encoding used by XYZ and sf32 tags.
fn s15_fixed16(value: f32) -> [u8; 4] {
    ((value * 65536.0).round() as i32).to_be_bytes()
}

/// An `XYZType` tag body carrying one tristimulus triple.
fn xyz_tag(xyz: [f32; 3]) -> Vec<u8> {
    let mut out = Vec::with_capacity(20);
    out.extend_from_slice(b"XYZ ");
    out.extend_from_slice(&[0; 4]);
    for channel in xyz {
        out.extend_from_slice(&s15_fixed16(channel));
    }
    out
}

/// An `s15Fixed16ArrayType` tag body carrying the chromatic-adaptation matrix.
fn chad_tag(matrix: &Matrix3) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + 36);
    out.extend_from_slice(b"sf32");
    out.extend_from_slice(&[0; 4]);
    for row in matrix.0 {
        for value in row {
            out.extend_from_slice(&s15_fixed16(value));
        }
    }
    out
}

/// A `curveType` tag body sampling the IEC 61966-2-1 transfer function.
///
/// The same curve serves both targets: Display P3 is defined with the sRGB
/// TRC, and [`crate::view::encode::srgb_gamma_encode`] applies it unchanged
/// for either set of primaries.
fn trc_tag() -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + TRC_ENTRIES * 2);
    out.extend_from_slice(b"curv");
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(TRC_ENTRIES as u32).to_be_bytes());
    for i in 0..TRC_ENTRIES {
        let linear = i as f32 / (TRC_ENTRIES - 1) as f32;
        let encoded = crate::view::encode::srgb_gamma(linear);
        out.extend_from_slice(&((encoded * 65535.0).round() as u16).to_be_bytes());
    }
    out
}

/// A v2 `textDescriptionType` tag body (the `desc` tag ICC v2 requires).
fn desc_tag(text: &str) -> Vec<u8> {
    let ascii = text.as_bytes();
    let mut out = Vec::with_capacity(12 + ascii.len() + 1 + 78);
    out.extend_from_slice(b"desc");
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(ascii.len() as u32 + 1).to_be_bytes());
    out.extend_from_slice(ascii);
    out.push(0);
    // Unicode language code + count, then the legacy ScriptCode block: all
    // empty, but the fixed-size Macintosh description field is not optional.
    out.extend_from_slice(&[0; 8]);
    out.extend_from_slice(&[0; 3]);
    out.extend_from_slice(&[0; 67]);
    out
}

/// A `textType` tag body (used for the copyright tag).
fn text_tag(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + text.len() + 1);
    out.extend_from_slice(b"text");
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(text.as_bytes());
    out.push(0);
    out
}

/// Assemble the header, tag table and tag data into a complete profile.
fn build(chroma: &Chromaticities, description: &str) -> Vec<u8> {
    let colorants = d50_colorants(chroma);
    let column = |i: usize| [colorants.0[0][i], colorants.0[1][i], colorants.0[2][i]];
    let adaptation = bradford_adaptation(xy_to_xyz(chroma.white), PCS_D50);

    // Sorted by signature, as the spec asks for.
    let tags: Vec<(&[u8; 4], Vec<u8>)> = vec![
        (b"bTRC", trc_tag()),
        (b"bXYZ", xyz_tag(column(2))),
        (b"chad", chad_tag(&adaptation)),
        (b"cprt", text_tag("Public Domain")),
        (b"desc", desc_tag(description)),
        (b"gTRC", trc_tag()),
        (b"gXYZ", xyz_tag(column(1))),
        (b"rTRC", trc_tag()),
        (b"rXYZ", xyz_tag(column(0))),
        (b"wtpt", xyz_tag(PCS_D50)),
    ];

    let table_size = 4 + tags.len() * 12;
    let data_start = 128 + table_size;

    // Lay the tag bodies out back to back, each starting 4-byte aligned.
    let mut table = Vec::with_capacity(table_size);
    let mut data: Vec<u8> = Vec::new();
    table.extend_from_slice(&(tags.len() as u32).to_be_bytes());
    for (signature, body) in &tags {
        let offset = data_start + data.len();
        table.extend_from_slice(*signature);
        table.extend_from_slice(&(offset as u32).to_be_bytes());
        table.extend_from_slice(&(body.len() as u32).to_be_bytes());
        data.extend_from_slice(body);
        while data.len() % 4 != 0 {
            data.push(0);
        }
    }

    let total = data_start + data.len();
    let mut header = vec![0u8; 128];
    header[0..4].copy_from_slice(&(total as u32).to_be_bytes());
    header[8..12].copy_from_slice(&0x0210_0000u32.to_be_bytes()); // v2.1
    header[12..16].copy_from_slice(b"mntr"); // display device class
    header[16..20].copy_from_slice(b"RGB ");
    header[20..24].copy_from_slice(b"XYZ ");
    header[36..40].copy_from_slice(b"acsp");
    header[64..68].copy_from_slice(&0u32.to_be_bytes()); // perceptual intent
    for (i, channel) in PCS_D50.iter().enumerate() {
        let at = 68 + i * 4;
        header[at..at + 4].copy_from_slice(&s15_fixed16(*channel));
    }

    let mut profile = Vec::with_capacity(total);
    profile.extend_from_slice(&header);
    profile.extend_from_slice(&table);
    profile.extend_from_slice(&data);
    profile
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read an s15Fixed16 triple back out of an `XYZType` tag body.
    fn read_xyz(profile: &[u8], signature: &[u8; 4]) -> [f32; 3] {
        let count = u32::from_be_bytes(profile[128..132].try_into().unwrap()) as usize;
        for i in 0..count {
            let entry = 132 + i * 12;
            if &profile[entry..entry + 4] == signature {
                let offset =
                    u32::from_be_bytes(profile[entry + 4..entry + 8].try_into().unwrap()) as usize;
                let value = |lane: usize| {
                    let at = offset + 8 + lane * 4;
                    i32::from_be_bytes(profile[at..at + 4].try_into().unwrap()) as f32 / 65536.0
                };
                return [value(0), value(1), value(2)];
            }
        }
        panic!("tag {:?} missing", std::str::from_utf8(signature));
    }

    fn assert_close(actual: [f32; 3], expected: [f32; 3], tolerance: f32, what: &str) {
        for lane in 0..3 {
            assert!(
                (actual[lane] - expected[lane]).abs() < tolerance,
                "{what} lane {lane}: got {}, expected {}",
                actual[lane],
                expected[lane]
            );
        }
    }

    /// The derived colorants must reproduce the published sRGB ICC profile's
    /// D50-adapted rXYZ/gXYZ/bXYZ. This is the guard that makes the
    /// from-chromaticities derivation trustworthy.
    #[test]
    fn srgb_colorants_match_the_published_profile() {
        let profile = profile_for(TargetPrimaries::Srgb);
        assert_close(
            read_xyz(&profile, b"rXYZ"),
            [0.4360, 0.2225, 0.0139],
            5e-4,
            "sRGB red",
        );
        assert_close(
            read_xyz(&profile, b"gXYZ"),
            [0.3851, 0.7169, 0.0971],
            5e-4,
            "sRGB green",
        );
        assert_close(
            read_xyz(&profile, b"bXYZ"),
            [0.1431, 0.0606, 0.7141],
            5e-4,
            "sRGB blue",
        );
    }

    /// Same guard for Display P3, against Apple's shipped profile.
    #[test]
    fn display_p3_colorants_match_the_published_profile() {
        let profile = profile_for(TargetPrimaries::P3);
        assert_close(
            read_xyz(&profile, b"rXYZ"),
            [0.5151, 0.2412, -0.0011],
            1e-3,
            "P3 red",
        );
        assert_close(
            read_xyz(&profile, b"gXYZ"),
            [0.2920, 0.6922, 0.0419],
            1e-3,
            "P3 green",
        );
        assert_close(
            read_xyz(&profile, b"bXYZ"),
            [0.1571, 0.0666, 0.7841],
            1e-3,
            "P3 blue",
        );
    }

    /// The two profiles must actually differ — a bug that returned sRGB for
    /// both would otherwise pass every other assertion here.
    #[test]
    fn the_two_profiles_are_not_the_same_bytes() {
        assert_ne!(
            profile_for(TargetPrimaries::Srgb),
            profile_for(TargetPrimaries::P3)
        );
    }

    #[test]
    fn header_is_well_formed_and_size_is_self_consistent() {
        for target in [TargetPrimaries::Srgb, TargetPrimaries::P3] {
            let profile = profile_for(target);
            let declared = u32::from_be_bytes(profile[0..4].try_into().unwrap()) as usize;
            assert_eq!(declared, profile.len(), "declared size must match actual");
            assert_eq!(&profile[36..40], b"acsp", "missing ICC signature");
            assert_eq!(&profile[16..20], b"RGB ");
            assert_eq!(&profile[20..24], b"XYZ ");
        }
    }

    /// White in, white out: the colorants must sum to the PCS illuminant, which
    /// is what makes a neutral render stay neutral through a tagged export.
    #[test]
    fn colorants_sum_to_the_pcs_white_point() {
        for target in [TargetPrimaries::Srgb, TargetPrimaries::P3] {
            let profile = profile_for(target);
            let red = read_xyz(&profile, b"rXYZ");
            let green = read_xyz(&profile, b"gXYZ");
            let blue = read_xyz(&profile, b"bXYZ");
            let sum = [
                red[0] + green[0] + blue[0],
                red[1] + green[1] + blue[1],
                red[2] + green[2] + blue[2],
            ];
            assert_close(sum, PCS_D50, 1e-3, "colorant sum");
        }
    }

    /// The TRC must be the transfer function the pipeline actually applied.
    #[test]
    fn trc_table_samples_the_srgb_transfer_function() {
        let tag = trc_tag();
        let count = u32::from_be_bytes(tag[8..12].try_into().unwrap()) as usize;
        assert_eq!(count, TRC_ENTRIES);
        let entry = |i: usize| {
            let at = 12 + i * 2;
            u16::from_be_bytes(tag[at..at + 2].try_into().unwrap()) as f32 / 65535.0
        };
        assert!(entry(0).abs() < 1e-4, "0 must map to 0");
        assert!(
            (entry(TRC_ENTRIES - 1) - 1.0).abs() < 1e-4,
            "1 must map to 1"
        );
        // Mid-scale linear light encodes to roughly 0.735 through the sRGB OETF.
        let mid = TRC_ENTRIES / 2;
        let expected = crate::view::encode::srgb_gamma(mid as f32 / (TRC_ENTRIES - 1) as f32);
        assert!((entry(mid) - expected).abs() < 1e-3);
    }
}
