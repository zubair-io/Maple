//! The white-balance-retargeted HueSatMap on the live WB drag (#5099).
//! Kept only for the hosts still on the scene-linear decode — Windows, Web and
//! Android/Linux — and removed when they take the capture decode (#5378, #5379,
//! #5380); Apple runs the creative stage instead (#5377).
//!
//! A develop at slider target `T` re-lerps a dual-illuminant HueSatMap at
//! the render profile's own CCT for `T` (#4633), in linear ProPhoto D50
//! after the ForwardMatrix. The post-DCP per-tick paths start from a buffer
//! developed at the anchor `A`, so a Rec.2020 3×3 delta alone keeps the
//! anchor's table. Per pixel this module instead runs
//!
//! ```text
//!   out = floor( R · H_T( M_pro · H_A⁻¹( R⁻¹ · b ) ) )
//! ```
//!
//! where `R` is ProPhoto→Rec.2020, `M_pro` the camera-gain conjugation
//! [`SliderFrameExport::rec2020_delta_matrix`] already derives (moved into
//! ProPhoto), and `H_w` the HueSatMap blended between the two endpoint
//! tables at weight `w`. `H_A⁻¹` is the HSV-space inverse
//! `hsm::invert_one_blended` ([`HSM_INVERSE_ITERATIONS`] steps) and `floor`
//! the develop's DCP exit soft floor (uniform lift of a negative channel).
//! The endpoint tables are session-constant: a tick only recomputes two
//! weights and three 3×3 matrices.
//!
//! The tables travel as one flat `f32` wire ([`WbHsmRetarget::wire`]) so
//! the FFI and WASM hosts hand a borrowed `(ptr, len)` per tick; the GPU
//! kernel (`raw-gpu` `white_balance_hsm.wgsl`) reads its table part. The
//! decode applies auto exposure after DCP, so the per-photo gain is folded
//! into `R⁻¹`/`R` and the tables see the develop's scale.

use crate::{
    color::{
        dcp::{self, DcpProfile},
        hsm::{self, HsmEncoding},
        matrices::m_pro_to_rec2020,
    },
    image::{ColorSpace, Image},
    math::{Matrix3, Vec3},
};

use super::{camera_neutral_for, is_as_shot_target, SliderFrame, SliderFrameExport};

/// Header floats ahead of the two tables on the flat wire.
const HEADER_LEN: usize = 6;

/// Steps of the anchor-table inverse (`hsm::invert_one_blended`, solved in
/// HSV). Each step leaves an error proportional to how fast the table
/// varies across the lattice: four leave test_0007 at mean ΔE00 ≤ 0.011
/// against a fresh develop and the synthetic tables of
/// `wb_hsm_retarget_tests` within 2e-5 scene-linear; each step is one
/// table evaluation per pixel per tick.
pub const HSM_INVERSE_ITERATIONS: u32 = 4;

/// The render profile's own CCT for a slider target — the illuminant its
/// dual calibration reads the target's camera neutral as
/// (`retargeted_render_profile` doc). `None` at the as-shot target, where
/// the render profile passes through untouched.
pub(crate) fn retarget_render_cct(
    frame: &SliderFrame,
    e: &dcp::CmEndpoints,
    temperature: f32,
    tint: f32,
) -> Option<f32> {
    if is_as_shot_target(frame, temperature, tint) {
        return None;
    }
    let target_neutral = camera_neutral_for(frame.cm_for_cct(temperature), temperature, tint);
    Some(dcp::compute_as_shot_cct(
        target_neutral,
        e.m_cold,
        e.cct_cold,
        e.m_warm,
        e.cct_warm,
    ))
}

/// What a white-balance retarget re-interpolates in a dual-calibration render
/// profile: its endpoints, the CCT it reads the target at and the
/// ForwardMatrix there.
pub(crate) struct RenderRetarget {
    pub endpoints: dcp::CmEndpoints,
    pub cct: f32,
    pub forward_matrix: Option<Matrix3>,
}

pub(crate) fn render_retarget(
    frame: &SliderFrame,
    profile: &DcpProfile,
    temperature: f32,
    tint: f32,
) -> Option<RenderRetarget> {
    let endpoints = profile.cm_endpoints?;
    let cct = retarget_render_cct(frame, &endpoints, temperature, tint)?;
    Some(RenderRetarget {
        endpoints,
        cct,
        forward_matrix: profile.forward_matrix_for_cct(cct),
    })
}

fn scaled(m: Matrix3, k: f32) -> Matrix3 {
    Matrix3(m.0.map(|row| row.map(|v| v * k)))
}

/// A profile's two HueSatMap endpoints as a flat wire, plus the render
/// profile's as-shot CCT (the anchor table's weight). The wire depends only
/// on the profile, so hosts can share one copy across photos; the as-shot
/// CCT is per photo and travels beside it.
#[derive(Clone, Debug, PartialEq)]
pub struct WbHsmRetarget {
    wire: Vec<f32>,
    as_shot_cct: f32,
}

impl WbHsmRetarget {
    /// The endpoints a white-balance retarget re-lerps, exactly when
    /// `wb_camera::retargeted_render_profile` moves the table: both
    /// HueSatMaps of one shape and encoding, dual calibration endpoints, and
    /// a ForwardMatrix. A LookTable after the HueSatMap would sit between
    /// the buffer and the table this delta inverts, so such a profile keeps
    /// the plain 3×3, as does every other `None`.
    pub fn resolve(profile: &DcpProfile) -> Option<WbHsmRetarget> {
        let tables = profile.hsm_endpoints.as_ref()?;
        let e = profile.cm_endpoints?;
        profile.forward_matrix_for_cct(profile.scene_cct)?;
        let (cold, warm) = (&tables.cold, &tables.warm);
        if profile.look_table.is_some() || cold.dims != warm.dims || cold.encoding != warm.encoding
        {
            return None;
        }
        let encoding = match cold.encoding {
            HsmEncoding::Linear => 0.0,
            HsmEncoding::Srgb => 1.0,
        };
        let header = [
            cold.dims[0] as f32,
            cold.dims[1] as f32,
            cold.dims[2] as f32,
            encoding,
            e.cct_cold,
            e.cct_warm,
        ];
        let wire = header
            .iter()
            .chain(&cold.data)
            .chain(&warm.data)
            .copied()
            .collect();
        Some(WbHsmRetarget {
            wire,
            as_shot_cct: profile.scene_cct,
        })
    }

    /// `[hue_divs, sat_divs, val_divs, encoding (0 linear, 1 sRGB), cct_cold,
    /// cct_warm, cold table…, warm table…]`.
    pub fn wire(&self) -> &[f32] {
        &self.wire
    }

    pub fn as_shot_cct(&self) -> f32 {
        self.as_shot_cct
    }

    /// The view for a buffer the decode scaled by `exposure_gain` after DCP.
    pub fn view(&self, exposure_gain: f32) -> HsmRetargetView<'_> {
        HsmRetargetView::from_wire(&self.wire, self.as_shot_cct, exposure_gain)
            .expect("resolve builds a valid wire")
    }
}

/// Borrowed, validated view of the wire with its per-photo scalars.
#[derive(Clone, Copy, Debug)]
pub struct HsmRetargetView<'a> {
    pub dims: [u32; 3],
    pub encoding: HsmEncoding,
    /// Both tables, cold then warm, as the wire carries them.
    pub tables: &'a [f32],
    pub(crate) cct_cold: f32,
    pub(crate) cct_warm: f32,
    pub(crate) as_shot_cct: f32,
    /// The auto-exposure gain the decode applied after DCP (the HueSatMap
    /// saw the buffer before it); 1 when unknown.
    pub(crate) exposure_gain: f32,
}

/// Per-tick constants of the live HueSatMap delta. `to_pro`/`from_pro`
/// carry the exposure gain, so the tables see the develop's own scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HsmLiveDelta {
    pub to_pro: Matrix3,
    pub delta_pro: Matrix3,
    pub from_pro: Matrix3,
    pub w_target: f32,
    pub w_anchor: f32,
    pub inverse_iterations: u32,
}

impl<'a> HsmRetargetView<'a> {
    /// Parse a host's wire. `None` for an empty slice (a host without the
    /// tables), a malformed header or a non-positive as-shot CCT, so a bad
    /// host buffer degrades to the plain 3×3 delta. A non-positive or
    /// non-finite gain (a host that predates it) reads as 1.
    pub fn from_wire(
        wire: &'a [f32],
        as_shot_cct: f32,
        exposure_gain: f32,
    ) -> Option<HsmRetargetView<'a>> {
        let header = wire.get(..HEADER_LEN)?;
        let dim = |v: f32| (v.fract() == 0.0 && (1.0..=4096.0).contains(&v)).then_some(v as usize);
        let dims = [dim(header[0])?, dim(header[1])?, dim(header[2])?];
        let encoding = match header[3] {
            0.0 => HsmEncoding::Linear,
            1.0 => HsmEncoding::Srgb,
            _ => return None,
        };
        let ccts = [header[4], header[5], as_shot_cct];
        if !ccts.iter().all(|c| c.is_finite() && *c > 0.0) {
            return None;
        }
        let table_len = dims[0]
            .checked_mul(dims[1])?
            .checked_mul(dims[2])?
            .checked_mul(3)?;
        let tables = &wire[HEADER_LEN..];
        (Some(tables.len()) == table_len.checked_mul(2)).then(|| HsmRetargetView {
            dims: dims.map(|d| d as u32),
            encoding,
            tables,
            cct_cold: ccts[0],
            cct_warm: ccts[1],
            as_shot_cct,
            exposure_gain: if exposure_gain.is_finite() && exposure_gain > 0.0 {
                exposure_gain
            } else {
                1.0
            },
        })
    }

    fn cold_warm(&self) -> (&'a [f32], &'a [f32]) {
        self.tables.split_at(self.tables.len() / 2)
    }

    /// The reciprocal-CCT blend weight `dcp::lerp_hsm_for_cct` uses at `cct`.
    fn weight_at(&self, cct: f32) -> f32 {
        if (self.cct_cold - self.cct_warm).abs() < 1.0 {
            return 0.0;
        }
        let inv_cold = 1.0 / self.cct_cold;
        ((1.0 / cct - inv_cold) / (1.0 / self.cct_warm - inv_cold)).clamp(0.0, 1.0)
    }

    fn weight_for(&self, frame: &SliderFrameExport, slider: (f32, f32)) -> f32 {
        self.weight_at(
            frame
                .render_cct_at(slider.0, slider.1)
                .unwrap_or(self.as_shot_cct),
        )
    }

    /// The per-tick constants for a drag from `decoded` to `target`, around
    /// the Rec.2020 delta the caller already derived for them
    /// (`SliderFrameExport::rec2020_delta_matrix`). `None` inside the
    /// identity band, where the buffer passes through untouched.
    pub fn live_delta(
        &self,
        frame: &SliderFrameExport,
        delta_rec2020: Matrix3,
        target: (f32, f32),
        decoded: (f32, f32),
    ) -> Option<HsmLiveDelta> {
        if (target.0 - decoded.0).abs() < 0.5 && (target.1 - decoded.1).abs() < 0.5 {
            return None;
        }
        let pro_to_rec2020 = m_pro_to_rec2020();
        let rec2020_to_pro = pro_to_rec2020.inverse()?;
        let gain = self.exposure_gain;
        Some(HsmLiveDelta {
            to_pro: scaled(rec2020_to_pro, 1.0 / gain),
            delta_pro: rec2020_to_pro
                .mul_mat(&delta_rec2020)
                .mul_mat(&pro_to_rec2020),
            from_pro: scaled(pro_to_rec2020, gain),
            w_target: self.weight_for(frame, target),
            w_anchor: self.weight_for(frame, decoded),
            inverse_iterations: HSM_INVERSE_ITERATIONS,
        })
    }

    fn apply_table(&self, p: Vec3, w: f32) -> Vec3 {
        hsm::apply_one_blended(p, self.dims, self.encoding, self.cold_warm(), w)
    }

    /// One Rec.2020 pixel through the module-doc composition.
    pub fn apply_pixel(&self, d: &HsmLiveDelta, rgb: Vec3) -> Vec3 {
        let x = hsm::invert_one_blended(
            d.to_pro.mul_vec(rgb),
            self.dims,
            self.encoding,
            self.cold_warm(),
            d.w_anchor,
            d.inverse_iterations,
        );
        let moved = self.apply_table(d.delta_pro.mul_vec(x), d.w_target);
        let out = d.from_pro.mul_vec(moved);
        let lift = (-out[0].min(out[1]).min(out[2])).max(0.0);
        [out[0] + lift, out[1] + lift, out[2] + lift]
    }

    pub(crate) fn apply_image(&self, d: &HsmLiveDelta, img: &mut Image) {
        img.assert_space(ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = self.apply_pixel(d, *p);
        }
    }
}

#[cfg(test)]
#[path = "wb_hsm_retarget_tests.rs"]
mod tests;
