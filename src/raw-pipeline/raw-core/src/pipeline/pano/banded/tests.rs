use super::*;
use crate::pipeline::pano::opcodes::{FixVignetteRadialOpcode, GainMapOpcode, WarpPlaneParams};
use crate::test_support::synth_dng::SyntheticGreyDng;

/// Not a multiple of 16, so the last pass-2 buffer ends off the cell grid.
const FRAME: (u32, u32) = (160, 250);

const ORIENTATIONS: [ExifOrientation; 8] = [
    ExifOrientation::Normal,
    ExifOrientation::HorizontalFlip,
    ExifOrientation::Rotate180,
    ExifOrientation::VerticalFlip,
    ExifOrientation::Transpose,
    ExifOrientation::Rotate90,
    ExifOrientation::Transverse,
    ExifOrientation::Rotate270,
];

#[derive(Default)]
pub(super) struct MemScratch {
    width: usize,
    pixels: Vec<[f32; 3]>,
}

impl PanoBandScratch for MemScratch {
    fn begin(&mut self, width: u32, height: u32) -> Result<()> {
        self.width = width as usize;
        self.pixels = vec![[f32::NAN; 3]; width as usize * height as usize];
        Ok(())
    }
    fn put_rows(&mut self, y0: u32, rows: &[[f32; 3]]) -> Result<()> {
        let start = y0 as usize * self.width;
        self.pixels[start..start + rows.len()].copy_from_slice(rows);
        Ok(())
    }
    fn read_rows(&mut self, y0: u32, out: &mut [[f32; 3]]) -> Result<()> {
        let start = y0 as usize * self.width;
        out.copy_from_slice(&self.pixels[start..start + out.len()]);
        Ok(())
    }
}

/// Collects the blocks into one image and fails on any pixel written twice.
#[derive(Default)]
pub(super) struct MemSink {
    pub image: Option<Image>,
    written: Vec<bool>,
}

impl PanoBlockSink for MemSink {
    fn begin(&mut self, width: u32, height: u32) -> Result<()> {
        self.image = Some(Image::new(width, height, ColorSpace::SceneLinearRec2020));
        self.written = vec![false; width as usize * height as usize];
        Ok(())
    }
    fn put_block(&mut self, x0: u32, y0: u32, width: u32, pixels: &[[f32; 3]]) -> Result<()> {
        let image = self.image.as_mut().expect("begin before put_block");
        let stride = image.width as usize;
        for (k, row) in pixels.chunks(width as usize).enumerate() {
            let start = (y0 as usize + k) * stride + x0 as usize;
            assert!(
                self.written[start..start + row.len()].iter().all(|w| !w),
                "pixel written twice"
            );
            self.written[start..start + row.len()].fill(true);
            image.pixels[start..start + row.len()].copy_from_slice(row);
        }
        Ok(())
    }
}

impl MemSink {
    pub(super) fn into_complete(self) -> Image {
        assert!(
            self.written.iter().all(|w| *w),
            "output pixel never written"
        );
        self.image.expect("sink began")
    }
}

/// A `width × height` frame with sensor noise, a green-only clipped field too large
/// for local witnesses (so recovery falls back to the frame-wide scene
/// prior), a fully clipped core, scattered clipped speculars, an inset
/// ActiveArea and a DefaultCrop.
fn textured_raw(cfa: CfaPattern, (width, height): (u32, u32)) -> RawImage {
    let bytes = SyntheticGreyDng {
        linear_value: 0.3,
        width,
        height,
        cfa,
        ..SyntheticGreyDng::default()
    }
    .with_hasselblad_dcp()
    .write_to_bytes();
    let mut raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode synthetic DNG");
    let (black, white) = (raw.black_level[0], raw.white_level);
    let span = (white - black) as u64;
    let stride = raw.width as usize;
    let mut state = 0x5552_u64;
    for (i, value) in raw.raw_data.iter_mut().enumerate() {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let (x, y) = (i % stride, i / stride);
        let green_field = (30..130).contains(&x) && (60..190).contains(&y) && is_green(cfa, x, y);
        let core = (70..90).contains(&x) && (110..130).contains(&y);
        let specular = (state >> 60) == 0;
        *value = if green_field || core || specular {
            white as u16
        } else {
            (black as u64 + span / 20 + (state >> 33) % (span * 3 / 4)) as u16
        };
    }
    raw.lens_metadata.active_area = Some(ActiveAreaRect {
        top: 4,
        left: 6,
        width: width - 12,
        height: height - 10,
    });
    raw.crop_rect = Some(CropRect {
        x: 9,
        y: 7,
        w: width - 29,
        h: height - 25,
    });
    raw
}

fn is_green(cfa: CfaPattern, x: usize, y: usize) -> bool {
    match cfa {
        CfaPattern::Rggb | CfaPattern::Bggr => (x + y) % 2 == 1,
        CfaPattern::Grbg | CfaPattern::Gbrg => (x + y) % 2 == 0,
        CfaPattern::XTrans(pattern) => pattern[(y % 6) * 6 + x % 6] == 1,
        CfaPattern::LinearRgb => false,
    }
}

fn lens_list(aa: ActiveAreaRect) -> (OpcodeList3, ActiveAreaRect) {
    // A strong zoom (kr0 = 1.8) moves interior rows past the highlight halo,
    // so only the warp's own row reach keeps band edges exact.
    let plane = |k1: f64| WarpPlaneParams {
        kr: [1.8, k1, -0.004, 0.0],
        kt: [0.0004, -0.0003],
    };
    let gain_map = GainMapOpcode {
        top: 10,
        bottom: 230,
        left: 3,
        right: 140,
        plane: 0,
        planes: 3,
        row_pitch: 2,
        col_pitch: 1,
        points_v: 4,
        points_h: 3,
        spacing_v: 1.0 / 3.0,
        spacing_h: 0.5,
        origin_v: 0.0,
        origin_h: 0.0,
        map_planes: 1,
        gains: vec![
            1.3, 1.1, 1.25, 1.05, 1.0, 1.08, 1.12, 1.02, 1.2, 1.4, 1.15, 1.35,
        ],
    };
    let list = OpcodeList3 {
        opcodes: vec![
            PanoOpcode::GainMap(gain_map),
            PanoOpcode::WarpRectilinear(WarpRectilinearOpcode {
                planes: vec![plane(0.031), plane(0.03), plane(0.029)],
                center_x: 0.48,
                center_y: 0.53,
            }),
            PanoOpcode::FixVignetteRadial(FixVignetteRadialOpcode {
                k: [0.21, -0.05, 0.02, 0.0, 0.0],
                center_x: 0.5,
                center_y: 0.47,
            }),
        ],
        skipped: Vec::new(),
    };
    (list, aa)
}

pub(super) fn full_frame(
    raw: &RawImage,
    list3: Option<&(OpcodeList3, ActiveAreaRect)>,
) -> (Image, Vec<String>) {
    let (scene, applied, _) =
        super::super::develop_scene_linear_for_pano(raw, list3).expect("full-frame develop");
    (
        super::super::orient_scene_linear(scene, raw.orientation),
        applied,
    )
}

pub(super) fn banded(
    raw: &RawImage,
    list3: Option<&(OpcodeList3, ActiveAreaRect)>,
    band_rows: u32,
) -> (Image, BandedDevelop) {
    let mut sink = MemSink::default();
    let developed =
        develop_raw_banded(raw, list3, band_rows, &mut MemScratch::default(), &mut sink)
            .expect("banded develop");
    (sink.into_complete(), developed)
}

pub(super) fn first_mismatch(got: &Image, want: &Image) -> Option<usize> {
    assert_eq!(
        (got.width, got.height),
        (want.width, want.height),
        "output dims"
    );
    got.pixels
        .iter()
        .zip(&want.pixels)
        .position(|(a, b)| a.map(f32::to_bits) != b.map(f32::to_bits))
}

#[test]
fn banded_matches_full_frame_bit_for_bit_in_every_orientation() {
    let base = textured_raw(CfaPattern::Rggb, FRAME);
    let list = lens_list(base.lens_metadata.active_area.expect("active area"));
    for orientation in ORIENTATIONS {
        let raw = RawImage {
            orientation,
            ..base.clone()
        };
        let (want, want_applied) = full_frame(&raw, Some(&list));
        for band_rows in [16, 32, 40, 1000] {
            let (got, developed) = banded(&raw, Some(&list), band_rows);
            assert!(developed.banded);
            assert_eq!(developed.applied_opcodes, want_applied);
            assert_eq!(developed.falloff_correction, FalloffCorrection::Opcode);
            assert_eq!(
                first_mismatch(&got, &want),
                None,
                "{orientation:?} at {band_rows}-row bands"
            );
        }
    }
}

#[test]
fn banded_matches_full_frame_without_opcodes_or_crop() {
    let raw = RawImage {
        crop_rect: None,
        ..textured_raw(CfaPattern::Gbrg, FRAME)
    };
    let (want, _) = full_frame(&raw, None);
    let (got, developed) = banded(&raw, None, 16);
    assert!(developed.banded);
    assert!(developed.applied_opcodes.is_empty());
    assert_eq!(first_mismatch(&got, &want), None);
}

/// Enough scene samples (over 4096) that the median decimates, so the bands'
/// samples must arrive in the full frame's raster order.
#[test]
fn banded_matches_full_frame_when_the_scene_median_decimates() {
    let raw = RawImage {
        crop_rect: None,
        ..textured_raw(CfaPattern::Rggb, (1280, 1200))
    };
    let (want, _) = full_frame(&raw, None);
    for band_rows in [16, 112] {
        let (got, _) = banded(&raw, None, band_rows);
        assert_eq!(first_mismatch(&got, &want), None, "{band_rows}-row bands");
    }
}

/// No gain opcode and a lens the bundled database matches, so the windowed
/// bundled vignette (#4516) runs band by band.
#[test]
fn banded_matches_full_frame_with_the_bundled_vignette() {
    let base = textured_raw(CfaPattern::Rggb, FRAME);
    let raw = RawImage {
        camera_make: "Canon".into(),
        camera_model: "EOS 5D Mark III".into(),
        focal_length: Some(70.0),
        aperture: Some(2.8),
        lens_metadata: crate::lens_profile::LensMetadata {
            camera_make: None,
            camera_model: None,
            lens_model: Some("EF70-200mm f/2.8L IS II USM".into()),
            ..base.lens_metadata.clone()
        },
        ..base
    };
    let (want, _) = full_frame(&raw, None);
    for band_rows in [16, 48] {
        let (got, developed) = banded(&raw, None, band_rows);
        assert_eq!(
            developed.falloff_correction,
            FalloffCorrection::BundledProfile
        );
        assert_eq!(first_mismatch(&got, &want), None, "{band_rows}-row bands");
    }
}

#[test]
fn xtrans_takes_the_full_frame_fallback() {
    let raw = textured_raw(
        CfaPattern::XTrans([
            1, 1, 0, 1, 1, 2, 1, 1, 2, 1, 1, 0, 2, 0, 1, 0, 2, 1, 1, 1, 2, 1, 1, 0, 1, 1, 0, 1, 1,
            2, 0, 2, 1, 2, 0, 1,
        ]),
        FRAME,
    );
    let (want, _) = full_frame(&raw, None);
    let (got, developed) = banded(&raw, None, 16);
    assert!(!developed.banded);
    assert_eq!(first_mismatch(&got, &want), None);
}

#[test]
fn warp_row_reach_bounds_every_sampled_source_row() {
    let aa = ActiveAreaRect::full(160, 256);
    let (list, _) = lens_list(aa);
    let PanoOpcode::WarpRectilinear(warp) = &list.opcodes[1] else {
        unreachable!("lens_list puts the warp second");
    };
    let reach = warp_row_reach(warp, aa);
    let (cx, cy) = (warp.center_x * 160.0, warp.center_y * 256.0);
    let radius = f64::hypot(cx.max(160.0 - cx), cy.max(256.0 - cy));
    let green = warp.planes[1];
    let worst = (0..3)
        .map(|p| opcode_apply::blend_warp_toward_identity(&warp.planes[p], &green, 1.0, 1.0))
        .flat_map(|set| {
            (0..256).flat_map(move |row| {
                (0..160).map(move |col| {
                    let (_, sy) = opcode_apply::warp_source(
                        &set,
                        col as f64 - cx,
                        row as f64 - cy,
                        cx,
                        cy,
                        1.0 / radius,
                        radius,
                    );
                    (sy - row as f64).abs()
                })
            })
        })
        .fold(0.0, f64::max);
    assert!(
        worst > f64::from(HR_HALO + CELL),
        "the test warp must reach past the highlight halo ({worst})"
    );
    assert!(
        f64::from(reach) >= worst + 2.0,
        "reach {reach} < measured {worst} + cubic taps"
    );
}
