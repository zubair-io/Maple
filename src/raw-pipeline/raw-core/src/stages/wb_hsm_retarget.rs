//! The white-balance-retargeted HueSatMap on the live WB drag (#5099).
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
//! tables at weight `w`. `H_A⁻¹` is a fixed-point inverse
//! ([`HSM_INVERSE_ITERATIONS`]) and `floor` the develop's DCP exit soft
//! floor (uniform lift of a negative channel). The endpoint tables are session-constant:
//! a tick only recomputes two weights and three 3×3 matrices.
//!
//! The tables travel as one flat `f32` wire ([`WbHsmRetarget::flat`]) so
//! the FFI and WASM hosts hand a borrowed `(ptr, len)` per tick, and the
//! GPU kernel (`raw-gpu` `white_balance_hsm.wgsl`) reads the same layout:
//!
//! ```text
//!   [hue_divs, sat_divs, val_divs, encoding (0 linear, 1 sRGB),
//!    cct_cold, cct_warm, as_shot_cct, cold table…, warm table…]
//! ```

use crate::{
    color::{
        dcp::DcpProfile,
        hsm::{self, HsmEncoding},
        matrices::m_pro_to_rec2020,
    },
    image::{ColorSpace, Image},
    math::{Matrix3, Vec3},
};

use super::SliderFrameExport;

/// Header floats ahead of the two tables on the flat wire.
pub const HSM_RETARGET_HEADER_LEN: usize = 7;

/// Fixed-point steps of the anchor-table inverse, as `hsm::invert_one`.
/// Each step shrinks the residual by roughly the table's local slope: on
/// the synthetic tables of `wb_hsm_retarget_tests` 2 steps leave 3e-3 of
/// scene-linear error, 4 leave 9e-5.
pub const HSM_INVERSE_ITERATIONS: usize = 4;

/// Owned flat wire of a profile's two HueSatMap endpoints, resolved once
/// per decode.
#[derive(Clone, Debug, PartialEq)]
pub struct WbHsmRetarget {
    flat: Vec<f32>,
}

impl WbHsmRetarget {
    /// The endpoints a white-balance retarget re-lerps, exactly when
    /// `wb_camera::retargeted_render_profile` moves the table: both
    /// HueSatMaps of one shape and encoding, dual calibration endpoints, and
    /// a ForwardMatrix. `None` keeps the per-tick paths on the plain 3×3.
    pub fn resolve(profile: &DcpProfile) -> Option<WbHsmRetarget> {
        let tables = profile.hsm_endpoints.as_ref()?;
        let e = profile.cm_endpoints?;
        profile.forward_matrix_for_cct(profile.scene_cct)?;
        let (cold, warm) = (&tables.cold, &tables.warm);
        if cold.dims != warm.dims || cold.encoding != warm.encoding {
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
            profile.scene_cct,
        ];
        let flat = header
            .iter()
            .chain(&cold.data)
            .chain(&warm.data)
            .copied()
            .collect();
        Some(WbHsmRetarget { flat })
    }

    pub fn flat(&self) -> &[f32] {
        &self.flat
    }

    pub fn view(&self) -> HsmRetargetView<'_> {
        HsmRetargetView::from_flat(&self.flat).expect("resolve builds a valid wire")
    }
}

/// Borrowed, validated view of the flat wire.
#[derive(Clone, Copy, Debug)]
pub struct HsmRetargetView<'a> {
    pub dims: [u32; 3],
    pub encoding: HsmEncoding,
    /// Both tables, cold then warm, as the wire carries them.
    pub tables: &'a [f32],
    pub cold: &'a [f32],
    pub warm: &'a [f32],
    pub cct_cold: f32,
    pub cct_warm: f32,
    pub as_shot_cct: f32,
}

/// Per-tick constants of the live HueSatMap delta.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HsmLiveDelta {
    pub to_pro: Matrix3,
    pub delta_pro: Matrix3,
    pub from_pro: Matrix3,
    pub w_target: f32,
    pub w_anchor: f32,
}

impl<'a> HsmRetargetView<'a> {
    /// Parse the flat wire. `None` for an empty slice (a host without the
    /// tables) or any malformed header, so a bad host buffer degrades to
    /// the plain 3×3 delta.
    pub fn from_flat(flat: &'a [f32]) -> Option<HsmRetargetView<'a>> {
        let header = flat.get(..HSM_RETARGET_HEADER_LEN)?;
        let dim = |v: f32| (v.fract() == 0.0 && (1.0..=4096.0).contains(&v)).then_some(v as u32);
        let dims = [dim(header[0])?, dim(header[1])?, dim(header[2])?];
        let encoding = match header[3] {
            0.0 => HsmEncoding::Linear,
            1.0 => HsmEncoding::Srgb,
            _ => return None,
        };
        let ccts = [header[4], header[5], header[6]];
        if !ccts.iter().all(|c| c.is_finite() && *c > 0.0) {
            return None;
        }
        let table_len = dims.iter().map(|d| *d as usize).product::<usize>() * 3;
        let tables = &flat[HSM_RETARGET_HEADER_LEN..];
        (tables.len() == 2 * table_len).then(|| HsmRetargetView {
            dims,
            encoding,
            tables,
            cold: &tables[..table_len],
            warm: &tables[table_len..],
            cct_cold: ccts[0],
            cct_warm: ccts[1],
            as_shot_cct: ccts[2],
        })
    }

    /// The reciprocal-CCT blend weight `dcp::lerp_hsm_for_cct` uses at `cct`.
    pub fn weight_at(&self, cct: f32) -> f32 {
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

    /// The per-tick constants for a drag from `decoded` to `target`. `None`
    /// inside the identity band, where the buffer passes through untouched.
    pub fn live_delta(
        &self,
        frame: &SliderFrameExport,
        target: (f32, f32),
        decoded: (f32, f32),
    ) -> Option<HsmLiveDelta> {
        if (target.0 - decoded.0).abs() < 0.5 && (target.1 - decoded.1).abs() < 0.5 {
            return None;
        }
        let from_pro = m_pro_to_rec2020();
        let to_pro = from_pro.inverse()?;
        let delta_rec2020 = frame.rec2020_delta_matrix(target, decoded);
        Some(HsmLiveDelta {
            to_pro,
            delta_pro: to_pro.mul_mat(&delta_rec2020).mul_mat(&from_pro),
            from_pro,
            w_target: self.weight_for(frame, target),
            w_anchor: self.weight_for(frame, decoded),
        })
    }

    fn apply_table(&self, p: Vec3, w: f32) -> Vec3 {
        hsm::apply_one_blended(p, self.dims, self.encoding, (self.cold, self.warm), w)
    }

    /// One Rec.2020 pixel through the module-doc composition.
    pub fn apply_pixel(&self, d: &HsmLiveDelta, rgb: Vec3) -> Vec3 {
        let p = d.to_pro.mul_vec(rgb);
        let x = (0..HSM_INVERSE_ITERATIONS).fold(p, |x, _| {
            let y = self.apply_table(x, d.w_anchor);
            [x[0] + p[0] - y[0], x[1] + p[1] - y[1], x[2] + p[2] - y[2]]
        });
        let moved = self.apply_table(d.delta_pro.mul_vec(x), d.w_target);
        let out = d.from_pro.mul_vec(moved);
        let lift = (-out[0].min(out[1]).min(out[2])).max(0.0);
        [out[0] + lift, out[1] + lift, out[2] + lift]
    }

    pub fn apply_image(&self, d: &HsmLiveDelta, img: &mut Image) {
        img.assert_space(ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = self.apply_pixel(d, *p);
        }
    }
}

#[cfg(test)]
#[path = "wb_hsm_retarget_tests.rs"]
mod tests;
