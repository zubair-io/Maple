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
    opcode_list(&maps.iter().map(gain_entry).collect::<Vec<_>>())
}

/// One OpcodeList2 GainMap entry, flagged required like the Pixel files.
pub fn gain_entry(m: &GainMapOpcode) -> Vec<u8> {
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
    entry(9, 0, &body)
}

/// One OpcodeList2 entry: a required MapPolynomial over
/// `[top, bottom) × [left, right)` for `planes` planes from `plane`, every
/// site, with `coefficients`.
pub fn polynomial_entry(
    [top, left, bottom, right]: [u32; 4],
    plane: u32,
    planes: u32,
    coefficients: &[f64],
) -> Vec<u8> {
    let degree = coefficients.len() as u32 - 1;
    let body: Vec<u8> = [top, left, bottom, right, plane, planes, 1, 1, degree]
        .iter()
        .flat_map(|v| v.to_be_bytes())
        .chain(coefficients.iter().flat_map(|c| c.to_be_bytes()))
        .collect();
    entry(8, 0, &body)
}

/// One opcode-list entry; `flags` bit 0 marks it optional.
pub fn entry(id: u32, flags: u32, body: &[u8]) -> Vec<u8> {
    [id, 0x0103_0000, flags, body.len() as u32]
        .iter()
        .flat_map(|v| v.to_be_bytes())
        .chain(body.iter().copied())
        .collect()
}

/// An opcode-list blob from pre-encoded entries.
pub fn opcode_list(entries: &[Vec<u8>]) -> Vec<u8> {
    (entries.len() as u32)
        .to_be_bytes()
        .into_iter()
        .chain(entries.iter().flatten().copied())
        .collect()
}
