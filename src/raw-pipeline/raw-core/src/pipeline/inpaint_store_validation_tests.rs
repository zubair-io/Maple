//! Refusal cases for the `.f16` patch codec (#3933). Records are assembled by
//! hand so a corrupt asset can be expressed without going through the encoder.

use super::*;

const HALF_ONE: u16 = 0x3c00;
const HALF_QUIET_NAN: u16 = 0x7e00;
const HALF_INFINITY: u16 = 0x7c00;
const HALF_NEGATIVE_INFINITY: u16 = 0xfc00;

#[derive(Clone)]
struct RawRecord {
    reserved: u16,
    width: u32,
    height: u32,
    origin: [f32; 2],
    extent: [f32; 2],
    rgb: Vec<u16>,
    coverage: Vec<u16>,
}

impl RawRecord {
    fn valid() -> Self {
        Self {
            reserved: 0,
            width: 2,
            height: 1,
            origin: [0.25, 0.25],
            extent: [0.5, 0.5],
            rgb: vec![HALF_ONE; 6],
            coverage: vec![HALF_ONE; 2],
        }
    }

    fn bytes(&self) -> Vec<u8> {
        let placement = [
            self.origin[0],
            self.origin[1],
            self.extent[0],
            self.extent[1],
        ];
        let header = MAGIC
            .iter()
            .copied()
            .chain(VERSION.to_le_bytes())
            .chain(self.reserved.to_le_bytes())
            .chain(self.width.to_le_bytes())
            .chain(self.height.to_le_bytes())
            .chain(placement.iter().flat_map(|value| value.to_le_bytes()));
        let samples = self.rgb.iter().chain(&self.coverage);
        header
            .chain(samples.flat_map(|bits| bits.to_le_bytes()))
            .collect()
    }
}

fn patch_2x1() -> InpaintPatch {
    InpaintPatch {
        width: 2,
        height: 1,
        origin: [0.25, 0.25],
        extent: [0.5, 0.5],
        pixels: vec![[0.18, 0.18, 0.18]; 2],
        coverage: vec![1.0; 2],
    }
}

#[test]
fn hand_assembled_record_matches_the_encoder() {
    let decoded = patch_from_bytes(&RawRecord::valid().bytes()).expect("valid record decodes");
    assert_eq!(decoded.pixels, vec![[1.0, 1.0, 1.0]; 2]);
    assert_eq!(
        patch_to_bytes(&decoded).unwrap(),
        RawRecord::valid().bytes()
    );
}

#[test]
fn non_finite_placement_is_refused() {
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        for axis in 0..2 {
            let mut origin = RawRecord::valid();
            origin.origin[axis] = bad;
            assert!(
                patch_from_bytes(&origin.bytes()).is_err(),
                "origin[{axis}] = {bad}"
            );
            let mut extent = RawRecord::valid();
            extent.extent[axis] = bad;
            assert!(
                patch_from_bytes(&extent.bytes()).is_err(),
                "extent[{axis}] = {bad}"
            );
        }
    }
}

#[test]
fn out_of_frame_placement_is_refused() {
    let cases = [
        ([-0.1, 0.0], [0.5, 0.5]),
        ([0.0, -0.1], [0.5, 0.5]),
        ([0.6, 0.0], [0.5, 0.5]),
        ([0.0, 0.6], [0.5, 0.5]),
        ([0.0, 0.0], [0.0, 0.5]),
        ([0.0, 0.0], [0.5, -0.5]),
        ([1.0, 0.0], [0.5, 0.5]),
    ];
    for (origin, extent) in cases {
        let record = RawRecord {
            origin,
            extent,
            ..RawRecord::valid()
        };
        assert!(
            patch_from_bytes(&record.bytes()).is_err(),
            "origin {origin:?} extent {extent:?}"
        );
    }
}

#[test]
fn edge_aligned_placement_stays_in_frame() {
    // The rounded f32 operands of 1/3 + 2/3 sum past 1 in exact arithmetic; the
    // f32 sum the compositor uses is exactly 1.
    for (origin, extent) in [
        ([1.0 / 3.0, 0.0], [2.0 / 3.0, 1.0]),
        ([0.0, 0.7], [1.0, 0.3]),
        ([0.0, 0.0], [1.0, 1.0]),
    ] {
        let record = RawRecord {
            origin,
            extent,
            ..RawRecord::valid()
        };
        let decoded = patch_from_bytes(&record.bytes()).expect("edge-aligned patch decodes");
        assert!(decoded.is_valid(), "origin {origin:?} extent {extent:?}");
    }
}

#[test]
fn invalid_coverage_is_refused() {
    let half_bits = |value: f32| half::f16::from_f32(value).to_bits();
    for bad in [
        HALF_QUIET_NAN,
        HALF_INFINITY,
        HALF_NEGATIVE_INFINITY,
        half_bits(1.5),
        half_bits(-0.5),
    ] {
        let record = RawRecord {
            coverage: vec![HALF_ONE, bad],
            ..RawRecord::valid()
        };
        assert!(
            patch_from_bytes(&record.bytes()).is_err(),
            "coverage bits {bad:#06x}"
        );
    }
}

#[test]
fn non_finite_rgb_is_refused_on_decode() {
    for bad in [HALF_QUIET_NAN, HALF_INFINITY, HALF_NEGATIVE_INFINITY] {
        let mut record = RawRecord::valid();
        record.rgb[4] = bad;
        assert!(
            patch_from_bytes(&record.bytes()).is_err(),
            "rgb bits {bad:#06x}"
        );
    }
}

#[test]
fn zero_dimensions_are_refused() {
    for (width, height) in [(0, 0), (0, 4), (4, 0)] {
        let record = RawRecord {
            width,
            height,
            rgb: Vec::new(),
            coverage: Vec::new(),
            ..RawRecord::valid()
        };
        assert!(
            patch_from_bytes(&record.bytes()).is_err(),
            "{width}x{height}"
        );
    }
}

#[test]
fn overflowing_dimensions_are_refused() {
    for (width, height) in [(65_536, 65_536), (u32::MAX, u32::MAX), (u32::MAX, 2)] {
        let record = RawRecord {
            width,
            height,
            rgb: Vec::new(),
            coverage: Vec::new(),
            ..RawRecord::valid()
        };
        assert!(
            patch_from_bytes(&record.bytes()).is_err(),
            "{width}x{height}"
        );
        let blob: Vec<u8> = 1u32
            .to_le_bytes()
            .into_iter()
            .chain(record.bytes())
            .collect();
        assert!(patches_from_blob(&blob).is_err(), "blob {width}x{height}");
    }
}

#[test]
fn reserved_header_flags_are_refused() {
    let record = RawRecord {
        reserved: 1,
        ..RawRecord::valid()
    };
    assert!(patch_from_bytes(&record.bytes()).is_err());
}

#[test]
fn one_invalid_record_refuses_the_whole_blob() {
    let bad = RawRecord {
        coverage: vec![HALF_QUIET_NAN, HALF_ONE],
        ..RawRecord::valid()
    };
    let blob: Vec<u8> = 2u32
        .to_le_bytes()
        .into_iter()
        .chain(RawRecord::valid().bytes())
        .chain(bad.bytes())
        .collect();
    let error = patches_from_blob(&blob).unwrap_err();
    assert!(
        matches!(&error, PatchCodecError::BlobPatch { index: 1, source }
            if matches!(**source, PatchCodecError::Coverage { .. })),
        "{error:?}"
    );
    assert!(error.to_string().contains("patch 1"), "{error}");
}

#[test]
fn encode_refuses_values_that_overflow_fp16() {
    for bad in [65_520.0, 1.0e6, -65_520.0, f32::MAX] {
        let mut patch = patch_2x1();
        patch.pixels[1][2] = bad;
        assert!(patch_to_bytes(&patch).is_err(), "rgb {bad}");
        assert!(
            patches_to_blob(&[patch_2x1(), patch]).is_err(),
            "blob rgb {bad}"
        );
    }
}

#[test]
fn encode_refuses_non_finite_rgb() {
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut patch = patch_2x1();
        patch.pixels[0][1] = bad;
        assert!(patch_to_bytes(&patch).is_err(), "rgb {bad}");
    }
}

#[test]
fn encode_refuses_invalid_coverage() {
    for bad in [f32::NAN, f32::INFINITY, 1.5, -0.5] {
        let mut patch = patch_2x1();
        patch.coverage[1] = bad;
        assert!(patch_to_bytes(&patch).is_err(), "coverage {bad}");
    }
}

#[test]
fn encode_refuses_invalid_layout() {
    let zero = InpaintPatch {
        width: 0,
        height: 0,
        pixels: Vec::new(),
        coverage: Vec::new(),
        ..patch_2x1()
    };
    let short = InpaintPatch {
        coverage: vec![1.0],
        ..patch_2x1()
    };
    let outside = InpaintPatch {
        origin: [0.75, 0.25],
        ..patch_2x1()
    };
    let not_finite = InpaintPatch {
        extent: [f32::NAN, 0.5],
        ..patch_2x1()
    };
    for patch in [zero, short, outside, not_finite] {
        assert!(patch_to_bytes(&patch).is_err(), "{patch:?}");
    }
}

#[test]
fn negative_and_hdr_scene_values_round_trip_exactly() {
    let patch = InpaintPatch {
        pixels: vec![[-0.125, 8.0, 65_504.0], [-65_504.0, 0.0, 1.0]],
        coverage: vec![0.0, 1.0],
        ..patch_2x1()
    };
    let bytes = patch_to_bytes(&patch).expect("signed HDR values are valid scene RGB");
    assert_eq!(patch_from_bytes(&bytes).expect("decode"), patch);
    let blob = patches_to_blob(std::slice::from_ref(&patch)).expect("blob encodes");
    assert_eq!(patches_from_blob(&blob).expect("blob decodes"), vec![patch]);
}

#[test]
fn committed_interop_patch_still_decodes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/removal/basic/patch.f16");
    let bytes = std::fs::read(&path).expect("committed removal fixture is readable");
    let patch = patch_from_bytes(&bytes).expect("interop fixture is a valid patch");
    assert_eq!((patch.width, patch.height), (8, 4));
    assert_eq!((patch.origin, patch.extent), ([0.25, 0.25], [0.5, 0.5]));
    assert!(patch
        .pixels
        .iter()
        .all(|px| px[1] == -0.125 && px[2] == 8.0));
    assert!(patch.coverage.iter().all(|&coverage| coverage == 1.0));
    assert_eq!(patch_to_bytes(&patch).expect("fixture re-encodes"), bytes);
}

#[test]
fn refusals_name_their_cause() {
    let decode = |record: RawRecord| patch_from_bytes(&record.bytes()).unwrap_err();
    let layout = |error: InpaintPatchError| PatchCodecError::Layout(error);
    assert_eq!(
        decode(RawRecord {
            reserved: 1,
            ..RawRecord::valid()
        }),
        PatchCodecError::ReservedFlags { found: 1 }
    );
    assert_eq!(
        decode(RawRecord {
            width: 0,
            height: 0,
            rgb: Vec::new(),
            coverage: Vec::new(),
            ..RawRecord::valid()
        }),
        layout(InpaintPatchError::ZeroDimension {
            width: 0,
            height: 0
        })
    );
    assert_eq!(
        decode(RawRecord {
            width: 65_536,
            height: 65_536,
            rgb: Vec::new(),
            coverage: Vec::new(),
            ..RawRecord::valid()
        }),
        layout(InpaintPatchError::DimensionOverflow {
            width: 65_536,
            height: 65_536
        })
    );
    assert_eq!(
        decode(RawRecord {
            origin: [0.75, 0.25],
            ..RawRecord::valid()
        }),
        layout(InpaintPatchError::Placement {
            origin: [0.75, 0.25],
            extent: [0.5, 0.5]
        })
    );
    assert_eq!(
        decode(RawRecord {
            coverage: vec![HALF_ONE, HALF_INFINITY],
            ..RawRecord::valid()
        }),
        PatchCodecError::Coverage {
            index: 1,
            value: f32::INFINITY
        }
    );
    let mut nan_rgb = RawRecord::valid();
    nan_rgb.rgb[4] = HALF_QUIET_NAN;
    assert_eq!(decode(nan_rgb), PatchCodecError::NonFiniteRgb { index: 1 });

    let mut hot = patch_2x1();
    hot.pixels[1][2] = 65_520.0;
    assert_eq!(
        patch_to_bytes(&hot),
        Err(PatchCodecError::Fp16Overflow {
            index: 1,
            value: 65_520.0
        })
    );
    let mut infinite = patch_2x1();
    infinite.pixels[0][0] = f32::INFINITY;
    assert_eq!(
        patch_to_bytes(&infinite),
        Err(PatchCodecError::NonFiniteRgb { index: 0 })
    );
}
