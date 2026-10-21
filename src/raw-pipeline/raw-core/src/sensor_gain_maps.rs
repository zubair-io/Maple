use crate::image::{CfaPattern, RawImage};
use crate::pipeline::pano::{
    opcode_apply::sample_lattice,
    opcodes::{
        self, ActiveAreaRect, GainMapOpcode, MapPolynomialOpcode, OpcodeList3, PanoOpcode,
        SkipReason, SkippedOpcode,
    },
};

mod clip_context;
pub(crate) use clip_context::ClipGainContext;

/// One OpcodeList2 step, executed in list order on black/white-normalised
/// values: a declared transfer (#4629) or a gain map.
#[derive(Clone, Debug)]
pub enum SensorStep {
    Transfer(MapPolynomialOpcode),
    Gain(GainMapOpcode),
}

/// OpcodeList2 sensor-domain corrections.
#[derive(Clone, Debug)]
pub struct SensorGainMaps {
    pub steps: Vec<SensorStep>,
    pub active_area: ActiveAreaRect,
}

/// The decode-time view of a source's opcode lists.
pub(crate) struct DecodedOpcodes {
    pub sensor_gain_maps: Option<SensorGainMaps>,
    pub list3: Option<(OpcodeList3, ActiveAreaRect)>,
    pub skipped: Vec<SkippedOpcode>,
}

pub(crate) fn read(bytes: &[u8], ext: &str, width: u32, height: u32) -> DecodedOpcodes {
    let lists = opcodes::read_opcode_lists(bytes, ext, width, height);
    let skipped = [&lists.list1, &lists.list2, &lists.list3]
        .into_iter()
        .flatten()
        .flat_map(|(list, _)| list.skipped.iter().copied())
        .collect();
    DecodedOpcodes {
        sensor_gain_maps: lists.list2.and_then(|(list, active_area)| {
            let steps: Vec<_> = list
                .opcodes
                .into_iter()
                .filter_map(|op| match op {
                    PanoOpcode::GainMap(map) => Some(SensorStep::Gain(map)),
                    PanoOpcode::MapPolynomial(polynomial) => Some(SensorStep::Transfer(polynomial)),
                    _ => None,
                })
                .collect();
            (!steps.is_empty()).then_some(SensorGainMaps { steps, active_area })
        }),
        list3: lists.list3.filter(|(list, _)| !list.opcodes.is_empty()),
        skipped,
    }
}

/// Whether declared OpcodeList2 transfers execute on this image. 8-bit lossy
/// LinearRaw keeps its gamma 2.4 guess instead: the downstream lossy white
/// balance and exposure were tuned to it, and the declared transfer
/// regresses the embedded-JPEG gate until they are re-derived (#5081).
pub(crate) fn transfers_apply(raw: &RawImage) -> bool {
    !(raw.cfa == CfaPattern::LinearRgb && raw.white_level <= 255)
}

/// Every required opcode the render does not execute: the parse-time skips
/// plus any declared transfer held back by [`transfers_apply`].
pub(crate) fn skipped_required(raw: &RawImage) -> Vec<SkippedOpcode> {
    let held_back = raw
        .sensor_gain_maps
        .iter()
        .filter(|_| !transfers_apply(raw))
        .flat_map(|maps| &maps.steps)
        .filter_map(|step| match step {
            SensorStep::Transfer(p) if p.required => Some(SkippedOpcode {
                list: opcodes::OpcodeListKind::List2,
                id: Some(opcodes::OPCODE_ID_MAP_POLYNOMIAL),
                required: true,
                reason: SkipReason::NotApplied,
            }),
            _ => None,
        });
    raw.opcode_skips
        .iter()
        .copied()
        .filter(|skip| skip.required)
        .chain(held_back)
        .collect()
}

/// Log each distinct skipped required opcode once per process: decode runs
/// per open and per sized render, and the same file is reopened often.
pub(crate) fn log_skipped_required_once(raw: &RawImage) {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};

    static SEEN: OnceLock<Mutex<HashSet<SkippedOpcode>>> = OnceLock::new();
    let skipped = skipped_required(raw);
    if skipped.is_empty() {
        return;
    }
    let mut seen = SEEN
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for skip in skipped.into_iter().filter(|skip| seen.insert(*skip)) {
        eprintln!(
            "[raw-core] {} renders without required DNG OpcodeList{} opcode {}: {:?}",
            raw.unique_camera_model
                .as_deref()
                .unwrap_or(&raw.camera_model),
            skip.list as u8,
            skip.id.map_or_else(|| "?".to_string(), |id| id.to_string()),
            skip.reason,
        );
    }
}

impl SensorGainMaps {
    /// `value` normalised to [0, 1], put through every step covering the site
    /// in list order. Consecutive gains are multiplied together before they
    /// meet the value, so a list without transfers is `value × Π gains`.
    pub(crate) fn apply(&self, x: u32, y: u32, plane: u32, value: f32, transfers: bool) -> f32 {
        let Some((x, y)) = self.site(x, y) else {
            return value;
        };
        let (value, gain) = self
            .steps
            .iter()
            .fold((value, 1.), |(v, g), step| match step {
                SensorStep::Gain(map) if covers_gain(map, x, y, plane) => {
                    (v, g * self.lattice_gain(map, x, y, plane))
                }
                SensorStep::Transfer(p) if transfers && p.covers(x, y, plane) => {
                    (p.evaluate(v * g), 1.)
                }
                _ => (v, g),
            });
        value * gain
    }

    /// A lower bound on every site's saturation level (`apply` of an encoded
    /// 1), tracked as an interval through the steps; a site a step does not
    /// cover keeps its value, so each step widens rather than replaces it.
    pub(crate) fn saturation_floor(&self, transfers: bool) -> f32 {
        let (floor, _) = self
            .steps
            .iter()
            .fold((1f32, 1f32), |(low, high), step| match step {
                SensorStep::Gain(map) => {
                    let (min, max) = map
                        .gains
                        .iter()
                        .fold((1f32, 1f32), |(a, b), &g| (a.min(g), b.max(g)));
                    let products = [low * min, low * max, high * min, high * max];
                    (
                        products.into_iter().fold(f32::INFINITY, f32::min),
                        products.into_iter().fold(f32::NEG_INFINITY, f32::max),
                    )
                }
                SensorStep::Transfer(p) if transfers => {
                    let (min, max) = p.range_over(low, high);
                    (low.min(min), high.max(max))
                }
                SensorStep::Transfer(_) => (low, high),
            });
        floor
    }

    pub(crate) fn has_gains(&self) -> bool {
        self.steps.iter().any(|s| matches!(s, SensorStep::Gain(_)))
    }

    pub(crate) fn has_transfers(&self) -> bool {
        self.steps
            .iter()
            .any(|s| matches!(s, SensorStep::Transfer(_)))
    }

    fn site(&self, x: u32, y: u32) -> Option<(u32, u32)> {
        let aa = self.active_area;
        let x = x.checked_sub(aa.left)?;
        let y = y.checked_sub(aa.top)?;
        (x < aa.width && y < aa.height).then_some((x, y))
    }

    fn lattice_gain(&self, map: &GainMapOpcode, x: u32, y: u32, plane: u32) -> f32 {
        let aa = self.active_area;
        let h = (((x as f64 + 0.5) / aa.width as f64) - map.origin_h) / map.spacing_h;
        let v = (((y as f64 + 0.5) / aa.height as f64) - map.origin_v) / map.spacing_v;
        sample_lattice(map, v, h, plane.min(map.map_planes - 1))
    }
}

fn covers_gain(map: &GainMapOpcode, x: u32, y: u32, plane: u32) -> bool {
    x >= map.left
        && x < map.right
        && y >= map.top
        && y < map.bottom
        && (x - map.left) % map.col_pitch == 0
        && (y - map.top) % map.row_pitch == 0
        && plane >= map.plane
        && plane - map.plane < map.planes
}

#[cfg(test)]
mod tests {
    use super::*;

    impl SensorGainMaps {
        fn saturation(&self, x: u32, y: u32, plane: u32) -> f32 {
            self.apply(x, y, plane, 1., true)
        }
    }

    use crate::{
        decode::decode_bytes,
        linearize::{sensor_linearize, sensor_linearize_region},
        test_support::{
            gain_map::{blob, map},
            synth_dng::SyntheticGreyDng,
        },
    };

    #[test]
    fn dng_list2_is_decoded_and_applied_per_sensor_site_before_demosaic() {
        let maps = [map(0, 0, 2.), map(0, 1, 3.), map(1, 0, 4.), map(1, 1, 5.)];
        let fixture = SyntheticGreyDng {
            opcode_list2: Some(blob(&maps)),
            ..Default::default()
        };
        let raw = decode_bytes(&fixture.write_to_bytes(), "dng").unwrap();
        assert_eq!(raw.sensor_gain_maps.as_ref().unwrap().steps.len(), 4);
        assert!(raw.opcode_list3.is_none());
        let mut control = raw.clone();
        control.sensor_gain_maps = None;
        let before = sensor_linearize(&control);
        let after = sensor_linearize(&raw);
        for y in 0..64 {
            for x in 0..64 {
                let i = y * 64 + x;
                let gain = [2., 3., 4., 5.][(y % 2) * 2 + x % 2];
                for c in 0..3 {
                    assert_eq!(after.pixels[i][c], before.pixels[i][c] * gain);
                }
            }
        }
        assert_eq!(raw.raw_data, control.raw_data);
        let region = sensor_linearize_region(&raw, 6, 10, 20, 18);
        for y in 0..18 {
            for x in 0..20 {
                assert_eq!(
                    region.pixels[y * 20 + x],
                    after.pixels[(y + 10) * 64 + x + 6]
                );
            }
        }
    }

    #[test]
    fn lattice_uses_absolute_sensor_bounds_and_preserves_extended_values() {
        let mut gm = map(1, 0, 2.);
        gm.gains = vec![1., 3., 5., 7.];
        let maps = SensorGainMaps {
            steps: vec![SensorStep::Gain(gm)],
            active_area: ActiveAreaRect {
                top: 3,
                left: 5,
                width: 8,
                height: 8,
            },
        };
        assert_eq!(maps.saturation(4, 4, 0), 1.);
        assert_eq!(maps.saturation(5, 3, 0), 1.);
        assert_eq!(maps.saturation(6, 4, 0), 1.);
        assert_eq!(maps.saturation(5, 4, 1), 1.);
        assert!((maps.saturation(5, 4, 0) - 1.875).abs() < 1e-6);
        let fixture = SyntheticGreyDng {
            linear_value: 0.8,
            opcode_list2: Some(blob(&[map(0, 0, 4.)])),
            ..Default::default()
        };
        let raw = decode_bytes(&fixture.write_to_bytes(), "dng").unwrap();
        assert!(sensor_linearize(&raw)
            .pixels
            .iter()
            .flatten()
            .any(|v| *v > 1.));
    }

    #[test]
    fn gain_planes_use_absolute_image_plane_and_single_plane_maps_broadcast() {
        let mut gm = map(0, 0, 1.);
        gm.plane = 1;
        gm.planes = 2;
        gm.map_planes = 3;
        gm.row_pitch = 1;
        gm.col_pitch = 1;
        gm.gains = [2., 3., 4.].repeat(4);
        let maps = |gm: &GainMapOpcode| SensorGainMaps {
            steps: vec![SensorStep::Gain(gm.clone())],
            active_area: ActiveAreaRect::full(64, 64),
        };
        let per_plane = maps(&gm);
        assert_eq!(per_plane.saturation(12, 20, 0), 1.);
        assert_eq!(per_plane.saturation(12, 20, 1), 3.);
        assert_eq!(per_plane.saturation(12, 20, 2), 4.);
        let broadcast = maps(&GainMapOpcode {
            map_planes: 1,
            gains: vec![5.; 4],
            ..gm
        });
        assert_eq!(broadcast.saturation(12, 20, 0), 1.);
        assert_eq!(broadcast.saturation(12, 20, 1), 5.);
        assert_eq!(broadcast.saturation(12, 20, 2), 5.);
    }

    #[test]
    fn linear_rgb_uses_each_gain_plane_after_black_subtraction() {
        let mut raw = decode_bytes(&SyntheticGreyDng::default().write_to_bytes(), "dng").unwrap();
        raw.cfa = crate::CfaPattern::LinearRgb;
        raw.raw_data = vec![300; raw.width as usize * raw.height as usize * 3];
        raw.black_level = [100; 4];
        raw.white_level = 500;
        let mut gm = map(0, 0, 1.);
        gm.planes = 3;
        gm.map_planes = 3;
        gm.row_pitch = 1;
        gm.col_pitch = 1;
        gm.gains = [2., 3., 4.].repeat(4);
        raw.sensor_gain_maps = Some(SensorGainMaps {
            steps: vec![SensorStep::Gain(gm)],
            active_area: ActiveAreaRect::full(raw.width, raw.height),
        });
        let image = crate::linearize::linearraw_to_camera_rgb(&raw).unwrap();
        assert!(image.pixels.iter().all(|pixel| *pixel == [1., 1.5, 2.]));
    }

    #[test]
    fn clipping_scales_keep_sensor_phase_and_half_resolution_quad_coordinates() {
        let maps = [map(0, 0, 2.), map(0, 1, 3.), map(1, 0, 4.), map(1, 1, 5.)];
        let fixture = SyntheticGreyDng {
            opcode_list2: Some(blob(&maps)),
            ..Default::default()
        };
        let raw = decode_bytes(&fixture.write_to_bytes(), "dng").unwrap();
        let native = ClipGainContext::new(&raw, (0, 0), 1).unwrap();
        assert_eq!(native.scale(0, 64), [2., 3.5, 5.]);
        assert_eq!(native.scale(1, 64), [2., 3., 5.]);
        assert_eq!(native.scale(64, 64), [2., 4., 5.]);
        let quad = ClipGainContext::new(&raw, (0, 0), 2).unwrap();
        assert_eq!(quad.scale(0, 32), [2., 3.5, 5.]);
        let tile = ClipGainContext::new(&raw, (6, 10), 1).unwrap();
        for y in 0..8 {
            for x in 0..8 {
                assert_eq!(
                    tile.scale(y * 8 + x, 8),
                    native.scale((y + 10) * 64 + x + 6, 64)
                );
            }
        }
    }

    #[test]
    fn gain_aware_highlights_preserve_unclipped_bright_values_and_known_channels() {
        use crate::{stages::highlight_recovery, xmp::HighlightRecoveryMode, ColorSpace, Image};
        let maps = [map(0, 0, 2.), map(0, 1, 3.), map(1, 0, 4.), map(1, 1, 5.)];
        let raw = decode_bytes(
            &SyntheticGreyDng {
                opcode_list2: Some(blob(&maps)),
                ..Default::default()
            }
            .write_to_bytes(),
            "dng",
        )
        .unwrap();
        let context = ClipGainContext::new(&raw, (0, 0), 1).unwrap();
        let mut image = Image::new(64, 64, ColorSpace::CameraNativeLinearRgb);
        for (i, pixel) in image.pixels.iter_mut().enumerate() {
            *pixel = context.scale(i, 64).map(|g| g * 0.6);
        }
        let before = image.pixels.clone();
        let mut wrong = image.clone();
        highlight_recovery::apply(
            &mut wrong,
            HighlightRecoveryMode::ChromaticAdaptation,
            [1.; 3],
            0.,
        );
        assert_ne!(wrong.pixels, before);
        highlight_recovery::apply_in_sensor_space(
            &mut image,
            HighlightRecoveryMode::ChromaticAdaptation,
            [1.; 3],
            0.,
            None,
            None,
            Some(context),
        );
        assert_eq!(image.pixels, before);
        let index = 32 * 64 + 32;
        image.pixels[index][0] = context.scale(index, 64)[0];
        let known = image.pixels[index];
        highlight_recovery::apply_in_sensor_space(
            &mut image,
            HighlightRecoveryMode::ChromaticAdaptation,
            [1.; 3],
            0.,
            None,
            None,
            Some(context),
        );
        assert_ne!(image.pixels[index][0], known[0]);
        assert_eq!(image.pixels[index][1], known[1]);
        assert_eq!(image.pixels[index][2], known[2]);
        for i in 0..before.len() {
            if i != index {
                assert_eq!(image.pixels[i], before[i]);
            }
        }
    }
}

#[cfg(test)]
#[path = "sensor_gain_maps/transfer_tests.rs"]
mod transfer_tests;
