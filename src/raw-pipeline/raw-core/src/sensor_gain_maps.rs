use crate::pipeline::pano::{
    opcode_apply::sample_lattice,
    opcodes::{self, ActiveAreaRect, GainMapOpcode, PanoOpcode},
};

mod clip_context;
pub(crate) use clip_context::ClipGainContext;

#[derive(Clone, Debug)]
pub struct SensorGainMaps {
    pub maps: Vec<GainMapOpcode>,
    pub active_area: ActiveAreaRect,
}

pub(crate) fn read(bytes: &[u8], ext: &str, width: u32, height: u32) -> Option<SensorGainMaps> {
    let (list, active_area) =
        opcodes::read_opcode_list(bytes, ext, width, height, rawler::tags::DngTag::OpcodeList2)?;
    let maps: Vec<_> = list
        .opcodes
        .into_iter()
        .filter_map(|op| match op {
            PanoOpcode::GainMap(map) => Some(map),
            _ => None,
        })
        .collect();
    (!maps.is_empty()).then_some(SensorGainMaps { maps, active_area })
}

impl SensorGainMaps {
    pub(crate) fn gain_at(&self, x: u32, y: u32, plane: u32) -> f32 {
        let aa = self.active_area;
        let Some(x) = x.checked_sub(aa.left) else {
            return 1.;
        };
        let Some(y) = y.checked_sub(aa.top) else {
            return 1.;
        };
        if x >= aa.width || y >= aa.height {
            return 1.;
        }
        self.maps
            .iter()
            .filter(|map| {
                x >= map.left
                    && x < map.right
                    && y >= map.top
                    && y < map.bottom
                    && (x - map.left) % map.col_pitch == 0
                    && (y - map.top) % map.row_pitch == 0
                    && plane >= map.plane
                    && plane - map.plane < map.planes
            })
            .map(|map| {
                let h = (((x as f64 + 0.5) / aa.width as f64) - map.origin_h) / map.spacing_h;
                let v = (((y as f64 + 0.5) / aa.height as f64) - map.origin_v) / map.spacing_v;
                sample_lattice(map, v, h, plane.min(map.map_planes - 1))
            })
            .product()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(raw.sensor_gain_maps.as_ref().unwrap().maps.len(), 4);
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
            maps: vec![gm],
            active_area: ActiveAreaRect {
                top: 3,
                left: 5,
                width: 8,
                height: 8,
            },
        };
        assert_eq!(maps.gain_at(4, 4, 0), 1.);
        assert_eq!(maps.gain_at(5, 3, 0), 1.);
        assert_eq!(maps.gain_at(6, 4, 0), 1.);
        assert_eq!(maps.gain_at(5, 4, 1), 1.);
        assert!((maps.gain_at(5, 4, 0) - 1.875).abs() < 1e-6);
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
        let mut maps = SensorGainMaps {
            maps: vec![gm],
            active_area: ActiveAreaRect::full(64, 64),
        };
        assert_eq!(maps.gain_at(12, 20, 0), 1.);
        assert_eq!(maps.gain_at(12, 20, 1), 3.);
        assert_eq!(maps.gain_at(12, 20, 2), 4.);
        maps.maps[0].map_planes = 1;
        maps.maps[0].gains = vec![5.; 4];
        assert_eq!(maps.gain_at(12, 20, 0), 1.);
        assert_eq!(maps.gain_at(12, 20, 1), 5.);
        assert_eq!(maps.gain_at(12, 20, 2), 5.);
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
            maps: vec![gm],
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
