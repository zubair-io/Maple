//! The creative stage as a host carries it (#5377): a per-photo
//! [`CreativeHeader`] of plain numbers and the profile's table wire, so a
//! decode can hand both to a host and every tick hand them back. The header
//! holds no heap data, which lets a GPU tick derive its plan without
//! allocating; the CPU chain rebuilds the full [`CreativeStage`].

use super::creative_plan::{plan, AsShotTable, PlanInputs, TableLayout, TableSpan};
use super::{CreativeAnchors, CreativePlan, CreativeStage, CreativeWire};
use crate::{
    color::{
        dcp::{self, CmEndpoints, DcpProfile, HsmEndpoints},
        hsm::HsmTable,
        illuminant::Illuminant,
    },
    error::{Error, Result},
    math::Matrix3,
    stages::wb_camera::{SliderFrame, SliderFrameParts},
    types::WbMethod,
    xmp::HighlightRecoveryMode,
};

/// The DCP profile without its tables (and without the `ProfileToneCurve`,
/// which no creative operation reads).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProfileCore {
    pub illuminant: Illuminant,
    pub color_matrix: Matrix3,
    pub forward_matrix: Option<Matrix3>,
    pub scene_cct: f32,
    pub scene_white_xyz: [f32; 3],
    pub wb_already_baked: bool,
    pub cm_endpoints: Option<CmEndpoints>,
}

impl ProfileCore {
    fn of(profile: &DcpProfile) -> Self {
        Self {
            illuminant: profile.illuminant,
            color_matrix: profile.color_matrix,
            forward_matrix: profile.forward_matrix,
            scene_cct: profile.scene_cct,
            scene_white_xyz: profile.scene_white_xyz,
            wb_already_baked: profile.wb_already_baked,
            cm_endpoints: profile.cm_endpoints,
        }
    }

    /// The profile with no tables. Builds nothing on the heap.
    fn bare(&self) -> DcpProfile {
        DcpProfile {
            illuminant: self.illuminant,
            color_matrix: self.color_matrix,
            forward_matrix: self.forward_matrix,
            scene_cct: self.scene_cct,
            scene_white_xyz: self.scene_white_xyz,
            wb_already_baked: self.wb_already_baked,
            hsm: None,
            look_table: None,
            tone_curve: None,
            cm_endpoints: self.cm_endpoints,
            hsm_endpoints: None,
        }
    }
}

/// Everything the creative stage of one decode needs besides the table wire.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CreativeHeader {
    pub profile: ProfileCore,
    /// `None` for the uncalibrated tiers, which keep the post-DCP white balance.
    pub frame: Option<SliderFrameParts>,
    pub as_shot_neutral: [f32; 3],
    /// Measured on the as-shot render of the capture (owner decision 5 on #5213).
    pub ae_gain: f32,
    /// Whether the decode's model runs Oklab highlight recovery.
    pub highlight_recovery: bool,
    pub tables: TableLayout,
}

/// One tick's white balance: the slider pair in the decode's slider frame,
/// already resolved (an untouched photo passes the frame's as-shot pair).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CreativeTick {
    pub temperature: f32,
    pub tint: f32,
    /// Used only by the uncalibrated tiers.
    pub wb_method: WbMethod,
}

impl CreativeStage {
    /// This stage as a header and the profile's table wire. The stage must
    /// carry a given exposure gain and an absolute white balance;
    /// `highlight_recovery` is the decode model's mode.
    pub fn transport(
        &self,
        highlight_recovery: HighlightRecoveryMode,
    ) -> Result<(CreativeHeader, CreativeWire)> {
        let ae_gain = self.given_gain()?;
        let wire = self.gpu_wire();
        let header = CreativeHeader {
            profile: ProfileCore::of(&self.profile),
            frame: self.frame.as_ref().map(SliderFrame::parts),
            as_shot_neutral: self.as_shot_neutral,
            ae_gain,
            highlight_recovery: highlight_recovery == HighlightRecoveryMode::OklabChromaReduction,
            tables: wire.layout(),
        };
        Ok((header, wire))
    }
}

impl CreativeHeader {
    /// The GPU plan for one tick. Allocates nothing.
    pub fn gpu_plan<'t>(&self, tables: &'t [f32], tick: CreativeTick) -> Result<CreativePlan<'t>> {
        self.check(tables)?;
        let profile = self.profile.bare();
        let frame = self.frame.map(SliderFrame::from_parts);
        plan(
            PlanInputs {
                profile: &profile,
                frame: frame.as_ref(),
                as_shot_neutral: self.as_shot_neutral,
                ae_gain: self.ae_gain,
                highlight_recovery: self.highlight_recovery,
                target: frame.map(|_| (tick.temperature, tick.tint)),
                fallback: (tick.temperature, tick.tint, tick.wb_method),
            },
            &self.tables,
            tables,
        )
    }

    /// The CPU creative stage, its tables copied out of the wire.
    pub fn stage(&self, tables: &[f32]) -> Result<CreativeStage> {
        self.check(tables)?;
        let table = |span: TableSpan| {
            HsmTable::new(
                span.dims,
                tables[span.offset..span.offset + span.len().unwrap_or(0)].to_vec(),
                span.encoding(),
            )
            .ok_or_else(|| Error::Pipeline("malformed creative table".into()))
        };
        let endpoints = self
            .tables
            .endpoints
            .map(|(cold, warm)| -> Result<HsmEndpoints> {
                Ok(HsmEndpoints {
                    cold: table(cold)?,
                    warm: table(warm)?,
                })
            })
            .transpose()?;
        let hsm = match self.tables.as_shot {
            AsShotTable::None => None,
            AsShotTable::Table(span) => Some(table(span)?),
            AsShotTable::Endpoints => match (&endpoints, self.profile.cm_endpoints) {
                (Some(e), Some(c)) => dcp::lerp_hsm_for_cct(
                    Some(&e.cold),
                    Some(&e.warm),
                    c.cct_cold,
                    c.cct_warm,
                    self.profile.scene_cct,
                ),
                _ => return Err(Error::Pipeline("creative endpoints are incomplete".into())),
            },
        };
        let look_table = self.tables.look.map(table).transpose()?;
        Ok(CreativeStage {
            profile: DcpProfile {
                hsm,
                look_table,
                hsm_endpoints: endpoints.map(std::sync::Arc::new),
                ..self.profile.bare()
            },
            frame: self.frame.map(SliderFrame::from_parts),
            as_shot_neutral: self.as_shot_neutral,
            anchors: CreativeAnchors::Given {
                ae_gain: self.ae_gain,
                decoded_wb: None,
            },
        })
    }

    /// Every span lies inside `tables`, so a host that pairs a header with
    /// another decode's wire fails here rather than reading past it.
    fn check(&self, tables: &[f32]) -> Result<()> {
        let fits = |span: &TableSpan| {
            span.dims.iter().all(|&d| d > 0)
                && span
                    .len()
                    .and_then(|len| span.offset.checked_add(len))
                    .is_some_and(|end| end <= tables.len())
        };
        let as_shot = match &self.tables.as_shot {
            AsShotTable::Table(span) => fits(span),
            AsShotTable::None => true,
            AsShotTable::Endpoints => {
                self.tables.endpoints.is_some() && self.profile.cm_endpoints.is_some()
            }
        };
        let endpoints = self
            .tables
            .endpoints
            .is_none_or(|(cold, warm)| fits(&cold) && fits(&warm));
        if as_shot && endpoints && self.tables.look.as_ref().is_none_or(fits) {
            Ok(())
        } else {
            Err(Error::Pipeline(
                "creative header does not match its table wire".into(),
            ))
        }
    }
}
