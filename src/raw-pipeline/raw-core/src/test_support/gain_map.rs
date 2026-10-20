//! Synthetic DNG OpcodeList2 GainMap opcodes for sensor-gain tests.
use crate::pipeline::pano::opcodes::GainMapOpcode;

pub fn map(top: u32, left: u32, gain: f32) -> GainMapOpcode {
    GainMapOpcode {
        top,
        left,
        bottom: 64,
        right: 64,
        plane: 0,
        planes: 1,
        row_pitch: 2,
        col_pitch: 2,
        points_v: 2,
        points_h: 2,
        spacing_v: 1.,
        spacing_h: 1.,
        origin_v: 0.,
        origin_h: 0.,
        map_planes: 1,
        gains: vec![gain; 4],
    }
}

pub fn blob(maps: &[GainMapOpcode]) -> Vec<u8> {
    let mut result = (maps.len() as u32).to_be_bytes().to_vec();
    for m in maps {
        let mut body = Vec::new();
        for v in [
            m.top,
            m.left,
            m.bottom,
            m.right,
            m.plane,
            m.planes,
            m.row_pitch,
            m.col_pitch,
            m.points_v,
            m.points_h,
        ] {
            body.extend(v.to_be_bytes());
        }
        for v in [m.spacing_v, m.spacing_h, m.origin_v, m.origin_h] {
            body.extend(v.to_be_bytes());
        }
        body.extend(m.map_planes.to_be_bytes());
        for v in &m.gains {
            body.extend(v.to_be_bytes());
        }
        for v in [9, 0x0103_0000, 0, body.len() as u32] {
            result.extend(v.to_be_bytes());
        }
        result.extend(body);
    }
    result
}
