//! Per-tick constants of the GPU twin of [`CreativeStage::render`] (#5376);
//! see docs/pipeline.md. Tables travel as one wire built once per profile.

use super::{basis_inverse, CreativeAnchors, CreativeStage};
use crate::{
    color::{dcp, hsm::HsmEncoding, hsm::HsmTable, matrices::m_pro_to_rec2020},
    error::{Error, Result},
    math::Matrix3,
    stages::{wb_camera, white_balance},
    types::WbMethod,
    xmp::{AdjustmentModel, HighlightRecoveryMode},
};

/// One table's place in the wire.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Span {
    dims: [u32; 3],
    srgb: bool,
    offset: usize,
}

/// Every table a white balance can select, flattened as
/// `[as-shot HueSatMap | endpoint cold | endpoint warm | LookTable]`, each
/// laid out as [`HsmTable::data`].
#[derive(Clone, Debug)]
pub struct CreativeWire {
    floats: Vec<f32>,
    as_shot_hsm: Option<Span>,
    /// The cold table and, when the two are the same shape, the warm one's offset.
    endpoints: Option<(Span, Option<usize>)>,
    look: Option<Span>,
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
    fn single(span: Span) -> Self {
        Self {
            dims: span.dims,
            srgb: span.srgb,
            cold_offset: span.offset,
            warm_offset: None,
            warm_weight: 0.0,
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

fn span_of(floats: &mut Vec<f32>, table: &HsmTable) -> Span {
    let offset = floats.len();
    floats.extend_from_slice(&table.data);
    Span {
        dims: table.dims,
        srgb: table.encoding == HsmEncoding::Srgb,
        offset,
    }
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

impl CreativeStage {
    /// The profile's tables as one wire, built once per profile.
    pub fn gpu_wire(&self) -> CreativeWire {
        let profile = &self.profile;
        let mut floats = Vec::new();
        let as_shot_hsm = profile.hsm.as_ref().map(|t| span_of(&mut floats, t));
        let endpoints = profile.hsm_endpoints.as_ref().map(|e| {
            let cold = span_of(&mut floats, &e.cold);
            let comparable = e.cold.dims == e.warm.dims && e.cold.encoding == e.warm.encoding;
            let warm = comparable.then(|| span_of(&mut floats, &e.warm).offset);
            (cold, warm)
        });
        let look = profile.look_table.as_ref().map(|t| span_of(&mut floats, t));
        CreativeWire {
            floats,
            as_shot_hsm,
            endpoints,
            look,
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
        let CreativeAnchors::Given {
            ae_gain,
            decoded_wb: None,
        } = self.anchors
        else {
            return Err(Error::Pipeline(
                "the GPU creative stage takes a given exposure gain and an absolute white balance"
                    .into(),
            ));
        };
        let profile = &self.profile;
        let inverse_basis = basis_inverse(&dcp::camera_to_rec2020_matrix(profile)?)?;
        let target = self.frame.as_ref().map(|frame| {
            let (temperature, tint) =
                wb_camera::resolve_target_versioned(model, frame, profile, self.as_shot_neutral);
            (frame, temperature, tint)
        });
        let gain = target
            .filter(|&(frame, temperature, tint)| {
                !wb_camera::is_as_shot_target(frame, temperature, tint)
            })
            .map(|(frame, temperature, tint)| {
                wb_camera::camera_wb_gain(frame, self.as_shot_neutral, temperature, tint)
            })
            .map_or(Matrix3::IDENTITY, |g| {
                Matrix3([[g[0], 0.0, 0.0], [0.0, g[1], 0.0], [0.0, 0.0, g[2]]])
            });
        let retarget = target.and_then(|(frame, temperature, tint)| {
            wb_camera::render_retarget(frame, profile, temperature, tint)
        });
        let forward_matrix = retarget
            .as_ref()
            .map_or(profile.forward_matrix, |r| r.forward_matrix);
        let cam_to_pro = dcp::camera_to_prophoto_with_forward(profile, forward_matrix)?;
        let hsm = match (&retarget, wire.endpoints, profile.cm_endpoints) {
            (Some(r), Some((cold, warm_offset)), Some(e)) if r.forward_matrix.is_some() => Some(
                match (
                    warm_offset,
                    dcp::hsm_lerp_weight(e.cct_cold, e.cct_warm, r.cct),
                ) {
                    (Some(warm_offset), Some(warm_weight)) => PlanTable {
                        warm_offset: Some(warm_offset),
                        warm_weight,
                        ..PlanTable::single(cold)
                    },
                    _ => PlanTable::single(cold),
                },
            ),
            _ => wire.as_shot_hsm.map(PlanTable::single),
        };
        let fallback_white_balance = match self.frame {
            Some(_) => None,
            None => {
                let (temperature, tint) = white_balance::resolve_wb(model);
                post_dcp_white_balance(temperature, tint, model.wb_method)
            }
        };
        Ok(CreativePlan {
            to_pro: cam_to_pro.mul_mat(&gain).mul_mat(&inverse_basis),
            from_pro: m_pro_to_rec2020(),
            tables: &wire.floats,
            hsm,
            look: wire.look.map(PlanTable::single),
            highlight_recovery: model.highlight_recovery
                == HighlightRecoveryMode::OklabChromaReduction,
            post: Matrix3(
                fallback_white_balance
                    .unwrap_or(Matrix3::IDENTITY)
                    .0
                    .map(|row| row.map(|v| v * ae_gain)),
            ),
        })
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
