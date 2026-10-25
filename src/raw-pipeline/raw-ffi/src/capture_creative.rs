//! The capture-first processing inputs (#5377): [`MapleCaptureCreative`] is
//! raw-core's `CreativeHeader` laid out flat, plus the profile's table wire.
//! A capture decode writes one; a host copies it verbatim and points the
//! per-tick params (`MapleGpuLiveParams::creative_ptr`,
//! `MapleAdjustmentParams::creative_ptr`) at its copy. The tables are
//! interned per profile for the life of the process, so the copy needs no
//! owner. See docs/pipeline.md § "The capture decode".

use raw_core::{
    color::{dcp::CmEndpoints, illuminant::Illuminant},
    math::Matrix3,
    pipeline::{AsShotTable, CreativeHeader, CreativeStage, ProfileCore, TableLayout, TableSpan},
    stages::wb_camera::SliderFrameParts,
};
use std::sync::Arc;

/// One table of [`MapleCaptureCreative::tables`]. All-zero `dims` means the
/// table is absent.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCreativeTable {
    /// Float offset into the wire.
    pub offset: u32,
    /// Hue, saturation and value divisions.
    pub dims: [u32; 3],
    /// 1 when the value axis is indexed sRGB-encoded.
    pub srgb: u32,
}

/// The creative stage of one capture decode. `present == 0` (a zeroed
/// struct) means absent. Matrices are row-major; flags are 0 or 1.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct MapleCaptureCreative {
    pub present: u32,
    /// 1 when the decode's model runs Oklab highlight recovery.
    pub highlight_recovery: u32,
    /// The exposure gain, measured on the as-shot render.
    pub ae_gain: f32,
    pub as_shot_neutral: [f32; 3],
    /// 0 StdA, 1 D50, 2 D55, 3 D65, 4 another illuminant at `illuminant_cct`.
    pub illuminant: u32,
    pub illuminant_cct: u32,
    pub color_matrix: [f32; 9],
    pub has_forward_matrix: u32,
    pub forward_matrix: [f32; 9],
    pub scene_cct: f32,
    pub scene_white_xyz: [f32; 3],
    pub wb_already_baked: u32,
    pub has_cm_endpoints: u32,
    pub cm_cold: [f32; 9],
    pub cct_cold: f32,
    pub cm_warm: [f32; 9],
    pub cct_warm: f32,
    pub has_fm_cold: u32,
    pub fm_cold: [f32; 9],
    pub has_fm_warm: u32,
    pub fm_warm: [f32; 9],
    /// 0 for the uncalibrated tiers, which keep the post-DCP white balance.
    pub has_frame: u32,
    pub frame_has_endpoints: u32,
    pub frame_m_cold: [f32; 9],
    pub frame_cct_cold: f32,
    pub frame_m_warm: [f32; 9],
    pub frame_cct_warm: f32,
    pub frame_cm_as_shot: [f32; 9],
    pub frame_scene_cct: f32,
    pub frame_scene_tint: f32,
    pub frame_render_cm: [f32; 9],
    /// 0 none, 1 the `hsm` table, 2 the endpoints lerped at `scene_cct`.
    pub as_shot_table: u32,
    pub hsm: MapleCreativeTable,
    pub cold: MapleCreativeTable,
    pub warm: MapleCreativeTable,
    pub look: MapleCreativeTable,
    /// The profile's table wire; valid for the life of the process.
    pub tables: *const f32,
    pub tables_len: usize,
}

fn flat(m: Matrix3) -> [f32; 9] {
    crate::scene_linear_f32::flatten_matrix(m)
}

fn matrix(m: &[f32; 9]) -> Matrix3 {
    Matrix3([[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]])
}

fn optional(flag: u32, m: &[f32; 9]) -> Option<Matrix3> {
    (flag != 0).then(|| matrix(m))
}

fn table_of(span: Option<TableSpan>) -> MapleCreativeTable {
    span.map_or_else(MapleCreativeTable::default, |s| MapleCreativeTable {
        offset: s.offset as u32,
        dims: s.dims,
        srgb: s.srgb as u32,
    })
}

fn span_of(table: &MapleCreativeTable) -> Option<TableSpan> {
    (table.dims != [0; 3]).then_some(TableSpan {
        dims: table.dims,
        srgb: table.srgb != 0,
        offset: table.offset as usize,
    })
}

const NO_TABLE: MapleCreativeTable = MapleCreativeTable {
    offset: 0,
    dims: [0; 3],
    srgb: 0,
};

impl MapleCaptureCreative {
    pub(crate) const ABSENT: MapleCaptureCreative = MapleCaptureCreative {
        present: 0,
        highlight_recovery: 0,
        ae_gain: 1.0,
        as_shot_neutral: [0.0; 3],
        illuminant: 0,
        illuminant_cct: 0,
        color_matrix: [0.0; 9],
        has_forward_matrix: 0,
        forward_matrix: [0.0; 9],
        scene_cct: 0.0,
        scene_white_xyz: [0.0; 3],
        wb_already_baked: 0,
        has_cm_endpoints: 0,
        cm_cold: [0.0; 9],
        cct_cold: 0.0,
        cm_warm: [0.0; 9],
        cct_warm: 0.0,
        has_fm_cold: 0,
        fm_cold: [0.0; 9],
        has_fm_warm: 0,
        fm_warm: [0.0; 9],
        has_frame: 0,
        frame_has_endpoints: 0,
        frame_m_cold: [0.0; 9],
        frame_cct_cold: 0.0,
        frame_m_warm: [0.0; 9],
        frame_cct_warm: 0.0,
        frame_cm_as_shot: [0.0; 9],
        frame_scene_cct: 0.0,
        frame_scene_tint: 0.0,
        frame_render_cm: [0.0; 9],
        as_shot_table: 0,
        hsm: NO_TABLE,
        cold: NO_TABLE,
        warm: NO_TABLE,
        look: NO_TABLE,
        tables: std::ptr::null(),
        tables_len: 0,
    };

    pub(crate) fn new(header: &CreativeHeader, tables: &'static [f32]) -> Self {
        let p = &header.profile;
        let (illuminant, illuminant_cct) = match p.illuminant {
            Illuminant::StdA => (0, 0),
            Illuminant::D50 => (1, 0),
            Illuminant::D55 => (2, 0),
            Illuminant::D65 => (3, 0),
            Illuminant::Other(cct) => (4, cct),
        };
        let e = p.cm_endpoints;
        let f = header.frame;
        let fe = f.and_then(|f| f.endpoints);
        let zero = [0.0; 9];
        let (as_shot_table, hsm) = match header.tables.as_shot {
            AsShotTable::None => (0, None),
            AsShotTable::Table(span) => (1, Some(span)),
            AsShotTable::Endpoints => (2, None),
        };
        Self {
            present: 1,
            highlight_recovery: header.highlight_recovery as u32,
            ae_gain: header.ae_gain,
            as_shot_neutral: header.as_shot_neutral,
            illuminant,
            illuminant_cct,
            color_matrix: flat(p.color_matrix),
            has_forward_matrix: p.forward_matrix.is_some() as u32,
            forward_matrix: p.forward_matrix.map_or(zero, flat),
            scene_cct: p.scene_cct,
            scene_white_xyz: p.scene_white_xyz,
            wb_already_baked: p.wb_already_baked as u32,
            has_cm_endpoints: e.is_some() as u32,
            cm_cold: e.map_or(zero, |e| flat(e.m_cold)),
            cct_cold: e.map_or(0.0, |e| e.cct_cold),
            cm_warm: e.map_or(zero, |e| flat(e.m_warm)),
            cct_warm: e.map_or(0.0, |e| e.cct_warm),
            has_fm_cold: e.is_some_and(|e| e.fm_cold.is_some()) as u32,
            fm_cold: e.and_then(|e| e.fm_cold).map_or(zero, flat),
            has_fm_warm: e.is_some_and(|e| e.fm_warm.is_some()) as u32,
            fm_warm: e.and_then(|e| e.fm_warm).map_or(zero, flat),
            has_frame: f.is_some() as u32,
            frame_has_endpoints: fe.is_some() as u32,
            frame_m_cold: fe.map_or(zero, |e| flat(e.0)),
            frame_cct_cold: fe.map_or(0.0, |e| e.1),
            frame_m_warm: fe.map_or(zero, |e| flat(e.2)),
            frame_cct_warm: fe.map_or(0.0, |e| e.3),
            frame_cm_as_shot: f.map_or(zero, |f| flat(f.cm_as_shot)),
            frame_scene_cct: f.map_or(0.0, |f| f.scene_cct),
            frame_scene_tint: f.map_or(0.0, |f| f.scene_tint),
            frame_render_cm: f.map_or(zero, |f| flat(f.render_cm)),
            as_shot_table,
            hsm: table_of(hsm),
            cold: table_of(header.tables.endpoints.map(|e| e.0)),
            warm: table_of(header.tables.endpoints.map(|e| e.1)),
            look: table_of(header.tables.look),
            tables: tables.as_ptr(),
            tables_len: tables.len(),
        }
    }

    /// The header and the table wire, or why the struct cannot be one.
    ///
    /// # Safety
    /// `tables` null or valid for `tables_len` floats for `'a`.
    pub(crate) unsafe fn header<'a>(&self) -> Result<(CreativeHeader, &'a [f32]), String> {
        if self.present != 1 {
            return Err("creative inputs are not a capture decode's".into());
        }
        let tables: &'a [f32] = match (self.tables.is_null(), self.tables_len) {
            (_, 0) => &[],
            (false, len) => std::slice::from_raw_parts(self.tables, len),
            (true, _) => return Err("creative tables are null".into()),
        };
        let illuminant = match self.illuminant {
            0 => Illuminant::StdA,
            1 => Illuminant::D50,
            2 => Illuminant::D55,
            3 => Illuminant::D65,
            4 => Illuminant::Other(self.illuminant_cct),
            other => return Err(format!("unknown creative illuminant {other}")),
        };
        let as_shot = match (self.as_shot_table, span_of(&self.hsm)) {
            (0, _) => AsShotTable::None,
            (1, Some(span)) => AsShotTable::Table(span),
            (2, _) => AsShotTable::Endpoints,
            (kind, _) => return Err(format!("malformed creative as-shot table {kind}")),
        };
        let endpoints = match (span_of(&self.cold), span_of(&self.warm)) {
            (Some(cold), Some(warm)) => Some((cold, warm)),
            (None, None) => None,
            _ => return Err("creative endpoint tables come in pairs".into()),
        };
        let header = CreativeHeader {
            profile: ProfileCore {
                illuminant,
                color_matrix: matrix(&self.color_matrix),
                forward_matrix: optional(self.has_forward_matrix, &self.forward_matrix),
                scene_cct: self.scene_cct,
                scene_white_xyz: self.scene_white_xyz,
                wb_already_baked: self.wb_already_baked != 0,
                cm_endpoints: (self.has_cm_endpoints != 0).then(|| CmEndpoints {
                    m_cold: matrix(&self.cm_cold),
                    cct_cold: self.cct_cold,
                    m_warm: matrix(&self.cm_warm),
                    cct_warm: self.cct_warm,
                    fm_cold: optional(self.has_fm_cold, &self.fm_cold),
                    fm_warm: optional(self.has_fm_warm, &self.fm_warm),
                }),
            },
            frame: (self.has_frame != 0).then(|| SliderFrameParts {
                endpoints: (self.frame_has_endpoints != 0).then(|| {
                    (
                        matrix(&self.frame_m_cold),
                        self.frame_cct_cold,
                        matrix(&self.frame_m_warm),
                        self.frame_cct_warm,
                    )
                }),
                cm_as_shot: matrix(&self.frame_cm_as_shot),
                scene_cct: self.frame_scene_cct,
                scene_tint: self.frame_scene_tint,
                render_cm: matrix(&self.frame_render_cm),
            }),
            as_shot_neutral: self.as_shot_neutral,
            ae_gain: self.ae_gain,
            highlight_recovery: self.highlight_recovery != 0,
            tables: TableLayout {
                as_shot,
                endpoints,
                look: span_of(&self.look),
            },
        };
        Ok((header, tables))
    }
}

impl MapleCaptureCreative {
    /// Feed every field to `h`. The tables are interned by content, so their
    /// address and length stand for their floats.
    pub(crate) fn hash_into(&self, h: &mut impl std::hash::Hasher) {
        let floats = [
            &[self.ae_gain, self.scene_cct, self.cct_cold, self.cct_warm][..],
            &self.as_shot_neutral,
            &self.color_matrix,
            &self.forward_matrix,
            &self.scene_white_xyz,
            &self.cm_cold,
            &self.cm_warm,
            &self.fm_cold,
            &self.fm_warm,
            &self.frame_m_cold,
            &[
                self.frame_cct_cold,
                self.frame_cct_warm,
                self.frame_scene_cct,
                self.frame_scene_tint,
            ],
            &self.frame_m_warm,
            &self.frame_cm_as_shot,
            &self.frame_render_cm,
        ];
        floats
            .iter()
            .flat_map(|values| values.iter())
            .for_each(|v| h.write_u32(v.to_bits()));
        let tables = [&self.hsm, &self.cold, &self.warm, &self.look];
        [
            self.present,
            self.highlight_recovery,
            self.illuminant,
            self.illuminant_cct,
            self.has_forward_matrix,
            self.wb_already_baked,
            self.has_cm_endpoints,
            self.has_fm_cold,
            self.has_fm_warm,
            self.has_frame,
            self.frame_has_endpoints,
            self.as_shot_table,
        ]
        .into_iter()
        .chain(
            tables
                .into_iter()
                .flat_map(|t| [t.offset, t.dims[0], t.dims[1], t.dims[2], t.srgb]),
        )
        .for_each(|v| h.write_u32(v));
        h.write_usize(self.tables as usize);
        h.write_usize(self.tables_len);
    }
}

/// The creative inputs a per-tick params struct points at, or `None` when the
/// pointer is null (a host still on the scene-linear decode).
///
/// # Safety
/// `ptr` null or valid for the call, its tables valid for `'a`.
pub(crate) unsafe fn creative_from_ptr<'a>(
    ptr: *const MapleCaptureCreative,
) -> Result<Option<(CreativeHeader, &'a [f32])>, String> {
    ptr.as_ref().map(|c| c.header()).transpose()
}

/// One tick's GPU creative plan when `ptr` names a capture decode's creative
/// stage; the slider pair in `tick` is absolute in the decode's slider frame.
/// Allocates nothing: the plan borrows the interned tables.
///
/// # Safety
/// `ptr` null or valid for the call, its tables valid for `'a`.
pub(crate) unsafe fn gpu_plan<'a>(
    ptr: *const MapleCaptureCreative,
    tick: raw_core::pipeline::CreativeTick,
) -> Result<Option<raw_core::pipeline::CreativePlan<'a>>, String> {
    let Some((header, tables)) = creative_from_ptr(ptr)? else {
        return Ok(None);
    };
    header
        .gpu_plan(tables, tick)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Decodes whose CPU creative stage stays built; one per open editor is
/// plenty, and a miss only rebuilds.
const CPU_STAGES: usize = 4;

type CpuStageKey = (CreativeHeader, usize, usize);

static CPU_STAGE_CACHE: std::sync::Mutex<Vec<(CpuStageKey, Arc<CreativeStage>)>> =
    std::sync::Mutex::new(Vec::new());

/// The CPU creative stage of one capture decode. Building it copies the
/// tables out of the wire, so it is built once per decode and shared by
/// every tick: the stage depends only on the header and its interned wire,
/// never on the slider pair.
pub(crate) fn cpu_stage(
    header: &CreativeHeader,
    tables: &'static [f32],
) -> Result<Arc<CreativeStage>, String> {
    let key = (*header, tables.as_ptr() as usize, tables.len());
    let mut cache = CPU_STAGE_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(hit) = cache.iter().position(|(k, _)| *k == key) {
        cache[..=hit].rotate_right(1);
        return Ok(Arc::clone(&cache[0].1));
    }
    let stage = Arc::new(header.stage(tables).map_err(|e| e.to_string())?);
    cache.truncate(CPU_STAGES - 1);
    cache.insert(0, (key, Arc::clone(&stage)));
    Ok(stage)
}

/// A capture decode:the capture result in the fixed as-shot basis and its
/// creative stage. `scene.wb_hsm_data` is always null; `scene.ae_gain` is the
/// creative stage's gain, which the pixels do not carry.
#[repr(C)]
pub struct MapleCaptureBufferF32 {
    pub scene: crate::buffers::MapleSceneLinearBufferF32,
    pub creative: MapleCaptureCreative,
}

/// Free a buffer populated by a `maple_render_*_capture*_f32` entry. The
/// creative tables are shared and stay valid.
///
/// # Safety
/// `buffer` null or a buffer a capture entry populated.
#[no_mangle]
pub unsafe extern "C" fn maple_free_capture_buffer_f32(buffer: *mut MapleCaptureBufferF32) {
    crate::error::catch_panic("maple_free_capture_buffer_f32", (), || {
        if let Some(buffer) = buffer.as_mut() {
            crate::buffers::maple_free_scene_linear_buffer_f32(&mut buffer.scene);
            buffer.creative = MapleCaptureCreative::ABSENT;
        }
    })
}

#[cfg(test)]
#[path = "capture_creative_tests.rs"]
mod tests;
