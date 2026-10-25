//! Per-tick constants of the GPU twin of [`CreativeStage::render`] (#5376);
//! see docs/pipeline.md. Tables travel as one wire built once per profile.

use super::{basis_inverse, CreativeAnchors, CreativeStage};
use crate::{
    color::{dcp, dcp::DcpProfile, hsm::HsmEncoding, hsm::HsmTable, matrices::m_pro_to_rec2020},
    error::{Error, Result},
    math::Matrix3,
    stages::{wb_camera, wb_camera::SliderFrame, white_balance},
    types::WbMethod,
    xmp::{AdjustmentModel, HighlightRecoveryMode},
};

/// One table's place in the wire, laid out as [`HsmTable::data`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TableSpan {
    pub dims: [u32; 3],
    pub srgb: bool,
    pub offset: usize,
}

impl TableSpan {
    /// The table's float count; `None` when the dims overflow it.
    pub(super) fn len(&self) -> Option<usize> {
        self.dims
            .iter()
            .try_fold(3usize, |n, &d| n.checked_mul(d as usize))
    }

    pub(super) fn encoding(&self) -> HsmEncoding {
        if self.srgb {
            HsmEncoding::Srgb
        } else {
            HsmEncoding::Linear
        }
    }
}

/// Where the as-shot HueSatMap comes from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AsShotTable {
    None,
    Table(TableSpan),
    /// The two endpoint tables lerped at the profile's as-shot CCT, which is
    /// how `dcp::profile_for` builds a dual-illuminant profile's table. The
    /// wire then depends on the profile alone, not on the photo.
    Endpoints,
}

/// Which tables a wire holds and where.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TableLayout {
    pub as_shot: AsShotTable,
    /// The cold and warm illuminant HueSatMaps.
    pub endpoints: Option<(TableSpan, TableSpan)>,
    pub look: Option<TableSpan>,
}

/// Every table a white balance can select, flattened into one buffer.
#[derive(Clone, Debug)]
pub struct CreativeWire {
    floats: Vec<f32>,
    layout: TableLayout,
}

impl CreativeWire {
    pub fn floats(&self) -> &[f32] {
        &self.floats
    }

    pub fn layout(&self) -> TableLayout {
        self.layout
    }
}

/// A table of the wire as the GPU reads it. A blended HueSatMap names both
/// endpoint tables and the weight of the warm one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlanTable {
    pub dims: [u32; 3],
    pub srgb: bool,
    pub cold_offset: usize,
    pub warm_offset: Option<usize>,
    pub warm_weight: f32,
}

impl PlanTable {
    fn single(span: TableSpan) -> Self {
        Self {
            dims: span.dims,
            srgb: span.srgb,
            cold_offset: span.offset,
            warm_offset: None,
            warm_weight: 0.0,
        }
    }

    /// The pair blended at `weight`, as `hsm::lerp_tables` would, or the cold
    /// table alone where `dcp::lerp_hsm_for_cct` keeps it: one calibration
    /// illuminant, or two tables that cannot be lerped.
    fn blend(cold: TableSpan, warm: TableSpan, weight: Option<f32>) -> Self {
        let comparable = cold.dims == warm.dims && cold.srgb == warm.srgb;
        match weight {
            Some(warm_weight) if comparable => Self {
                warm_offset: Some(warm.offset),
                warm_weight,
                ..Self::single(cold)
            },
            _ => Self::single(cold),
        }
    }
}

/// Everything one tick of the GPU creative stage needs.
#[derive(Clone, Debug)]
pub struct CreativePlan<'w> {
    /// Capture basis (fixed as-shot Rec.2020) → linear ProPhoto D50 at the
    /// target white balance. Carries no exposure gain.
    pub to_pro: Matrix3,
    pub from_pro: Matrix3,
    pub tables: &'w [f32],
    pub hsm: Option<PlanTable>,
    pub look: Option<PlanTable>,
    pub highlight_recovery: bool,
    /// Applied after recovery: the exposure gain times the post-DCP white
    /// balance the uncalibrated tiers use.
    pub post: Matrix3,
}

fn span_of(floats: &mut Vec<f32>, table: &HsmTable) -> TableSpan {
    let offset = floats.len();
    floats.extend_from_slice(&table.data);
    TableSpan {
        dims: table.dims,
        srgb: table.encoding == HsmEncoding::Srgb,
        offset,
    }
}

fn same_table(a: &HsmTable, b: &HsmTable) -> bool {
    a.dims == b.dims
        && a.encoding == b.encoding
        && a.data.len() == b.data.len()
        && a.data
            .iter()
            .zip(&b.data)
            .all(|(x, y)| x.to_bits() == y.to_bits())
}

/// The Rec.2020 matrix `white_balance::apply` multiplies by, `None` inside its
/// identity band.
fn post_dcp_white_balance(temperature: f32, tint: f32, method: WbMethod) -> Option<Matrix3> {
    if (temperature - 6500.0).abs() < 0.5 && tint.abs() < 0.5 {
        return None;
    }
    Some(match method {
        WbMethod::Cat16 => white_balance::wb_cat16_matrix(temperature, tint),
        WbMethod::DiagonalRec2020 => {
            let g = white_balance::wb_gains(temperature, tint);
            Matrix3([[g[0], 0.0, 0.0], [0.0, g[1], 0.0], [0.0, 0.0, g[2]]])
        }
    })
}

/// The inputs of one plan, after the white balance is resolved. `profile`'s
/// tables are not read: they are in the wire.
pub(super) struct PlanInputs<'a> {
    pub profile: &'a DcpProfile,
    pub frame: Option<&'a SliderFrame>,
    pub as_shot_neutral: [f32; 3],
    pub ae_gain: f32,
    pub highlight_recovery: bool,
    /// The calibrated tiers' camera-space target.
    pub target: Option<(f32, f32)>,
    /// The uncalibrated tiers' post-DCP white balance.
    pub fallback: (f32, f32, WbMethod),
}

pub(super) fn plan<'w>(
    inputs: PlanInputs<'_>,
    layout: &TableLayout,
    tables: &'w [f32],
) -> Result<CreativePlan<'w>> {
    let PlanInputs {
        profile,
        frame,
        as_shot_neutral,
        ae_gain,
        highlight_recovery,
        target,
        fallback,
    } = inputs;
    let inverse_basis = basis_inverse(&dcp::camera_to_rec2020_matrix(profile)?)?;
    let target = frame.zip(target);
    let gain = target
        .filter(|&(frame, (temperature, tint))| {
            !wb_camera::is_as_shot_target(frame, temperature, tint)
        })
        .map(|(frame, (temperature, tint))| {
            wb_camera::camera_wb_gain(frame, as_shot_neutral, temperature, tint)
        })
        .map_or(Matrix3::IDENTITY, |g| {
            Matrix3([[g[0], 0.0, 0.0], [0.0, g[1], 0.0], [0.0, 0.0, g[2]]])
        });
    let retarget = target.and_then(|(frame, (temperature, tint))| {
        wb_camera::render_retarget(frame, profile, temperature, tint)
    });
    let forward_matrix = retarget
        .as_ref()
        .map_or(profile.forward_matrix, |r| r.forward_matrix);
    let cam_to_pro = dcp::camera_to_prophoto_with_forward(profile, forward_matrix)?;
    let lerped_at = |cct: f32| match (layout.endpoints, profile.cm_endpoints) {
        (Some((cold, warm)), Some(e)) => Ok(PlanTable::blend(
            cold,
            warm,
            dcp::hsm_lerp_weight(e.cct_cold, e.cct_warm, cct),
        )),
        _ => Err(Error::Pipeline(
            "an as-shot HueSatMap lerped from endpoints needs both tables and both calibrations"
                .into(),
        )),
    };
    let hsm = match (&retarget, layout.endpoints) {
        (Some(r), Some(_)) if r.forward_matrix.is_some() => Some(lerped_at(r.cct)?),
        _ => match layout.as_shot {
            AsShotTable::None => None,
            AsShotTable::Table(span) => Some(PlanTable::single(span)),
            AsShotTable::Endpoints => Some(lerped_at(profile.scene_cct)?),
        },
    };
    let fallback_white_balance = match frame {
        Some(_) => None,
        None => post_dcp_white_balance(fallback.0, fallback.1, fallback.2),
    };
    Ok(CreativePlan {
        to_pro: cam_to_pro.mul_mat(&gain).mul_mat(&inverse_basis),
        from_pro: m_pro_to_rec2020(),
        tables,
        hsm,
        look: layout.look.map(PlanTable::single),
        highlight_recovery,
        post: Matrix3(
            fallback_white_balance
                .unwrap_or(Matrix3::IDENTITY)
                .0
                .map(|row| row.map(|v| v * ae_gain)),
        ),
    })
}

impl CreativeStage {
    /// The profile's tables as one wire, built once per profile. A
    /// dual-illuminant profile's as-shot table is not stored: it is the
    /// endpoints lerped at the as-shot CCT, so the wire carries nothing
    /// specific to the photo.
    pub fn gpu_wire(&self) -> CreativeWire {
        let profile = &self.profile;
        let mut floats = Vec::new();
        let endpoints = profile
            .hsm_endpoints
            .as_ref()
            .map(|e| (span_of(&mut floats, &e.cold), span_of(&mut floats, &e.warm)));
        let lerped = |e: &dcp::HsmEndpoints| {
            profile.cm_endpoints.and_then(|c| {
                dcp::lerp_hsm_for_cct(
                    Some(&e.cold),
                    Some(&e.warm),
                    c.cct_cold,
                    c.cct_warm,
                    profile.scene_cct,
                )
            })
        };
        let as_shot = match (&profile.hsm, &profile.hsm_endpoints) {
            (None, _) => AsShotTable::None,
            (Some(table), Some(e)) if lerped(e).is_some_and(|l| same_table(&l, table)) => {
                AsShotTable::Endpoints
            }
            (Some(table), _) => AsShotTable::Table(span_of(&mut floats, table)),
        };
        let look = profile.look_table.as_ref().map(|t| span_of(&mut floats, t));
        CreativeWire {
            floats,
            layout: TableLayout {
                as_shot,
                endpoints,
                look,
            },
        }
    }

    /// The GPU creative stage's constants for `model`. The host supplies the
    /// exposure gain through [`CreativeAnchors::Given`] and the model's white
    /// balance is absolute: the buffer is a capture result, which no white
    /// balance has touched. `wire` must come from [`Self::gpu_wire`] on this
    /// stage.
    pub fn gpu_plan<'w>(
        &self,
        wire: &'w CreativeWire,
        model: &AdjustmentModel,
    ) -> Result<CreativePlan<'w>> {
        let ae_gain = self.given_gain()?;
        let target = self.frame.as_ref().map(|frame| {
            wb_camera::resolve_target_versioned(model, frame, &self.profile, self.as_shot_neutral)
        });
        let (temperature, tint) = white_balance::resolve_wb(model);
        plan(
            PlanInputs {
                profile: &self.profile,
                frame: self.frame.as_ref(),
                as_shot_neutral: self.as_shot_neutral,
                ae_gain,
                highlight_recovery: model.highlight_recovery
                    == HighlightRecoveryMode::OklabChromaReduction,
                target,
                fallback: (temperature, tint, model.wb_method),
            },
            &wire.layout,
            &wire.floats,
        )
    }

    /// The exposure gain of a stage the GPU can run: a given gain and an
    /// absolute white balance.
    pub(super) fn given_gain(&self) -> Result<f32> {
        match self.anchors {
            CreativeAnchors::Given {
                ae_gain,
                decoded_wb: None,
            } => Ok(ae_gain),
            _ => Err(Error::Pipeline(
                "the GPU creative stage takes a given exposure gain and an absolute white balance"
                    .into(),
            )),
        }
    }

    /// The CPU oracle the GPU creative stage is gated against.
    #[doc(hidden)]
    pub fn render_basis(
        &self,
        capture: crate::image::Image,
        model: &AdjustmentModel,
    ) -> Result<(crate::image::Image, f32)> {
        self.render(
            capture,
            super::CaptureSpace::Basis,
            model,
            super::Chain::Full,
        )
    }
}
