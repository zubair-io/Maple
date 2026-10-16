//! Resident camera calibration for the pre-DCP GPU boundary (#4629).
//!
//! Derive only small uniforms per update; profile tables remain borrowed from
//! the session. This is staged with the complete GPU DCP pass. Shipping live
//! hosts still use the post-DCP prefix until AE and upstream spatial stages
//! can move with it without changing their order or adding per-tick uploads.

use crate::{
    color::{
        dcp::{self, DcpProfile, ProfileSource},
        hsm::HsmEncoding,
        matrices::m_pro_to_rec2020,
    },
    image::RawImage,
    stages::wb_camera::{self, SliderFrame},
    xmp::AdjustmentModel,
};
use raw_gpu::{DcpColorimetryPass, HueSatMapPass};

pub struct GpuCameraColorimetry {
    profile: DcpProfile,
    frame: Option<SliderFrame>,
    as_shot_neutral: [f32; 3],
}

impl GpuCameraColorimetry {
    /// Prepare the actual sized CPU camera prefix for one persistent session.
    /// It ends before user WB/DCP; the caller must retain this image and run
    /// the remaining stages in order. No live caller switches boundaries yet.
    pub fn prepare(
        raw: &RawImage,
        model: &AdjustmentModel,
        max_long_edge: u32,
        cancel: crate::CancelToken<'_>,
    ) -> crate::Result<(Self, crate::image::Image)> {
        let mut camera = crate::pipeline::develop_camera_sized_from_raw(
            raw,
            model,
            crate::pipeline::RenderQuality::Amaze,
            max_long_edge,
            cancel,
        )?;
        let calibration = Self::resolve(raw)?;
        camera.whites_anchor_ev = Some(dcp::scene_white_anchor(&camera, &calibration.profile)?);
        if cancel.is_cancelled() {
            return Err(crate::Error::Cancelled);
        }
        Ok((calibration, camera))
    }

    pub fn resolve(raw: &RawImage) -> crate::Result<Self> {
        let (profile, source) = dcp::profile_for_with_source(raw)?;
        let fallback =
            matches!(source, ProfileSource::RawlerFallback) || raw.uses_legacy_lossy_linearraw();
        let frame = (!fallback).then(|| SliderFrame::resolve(raw, &profile));
        Ok(Self {
            profile,
            frame,
            as_shot_neutral: raw.as_shot_neutral,
        })
    }

    /// Exact camera-WB + colorimetry stage. Fallback WB remains a downstream
    /// CAT16/diagonal operation, just as in the CPU develop chain. AE and the
    /// remaining upstream operations are deliberately outside this stage.
    pub fn pass(&self, model: &AdjustmentModel) -> crate::Result<DcpColorimetryPass<'_>> {
        let profile = &self.profile;
        // profile_for strips aesthetic LookTables. Reject unsupported manual
        // profiles instead of silently dropping their tetrahedral operation.
        if profile.look_table.is_some() {
            return Err(crate::Error::Dcp(
                "GPU camera colorimetry requires a colorimetry-only profile".into(),
            ));
        }
        let (camera_gain, forward_matrix) = match &self.frame {
            Some(frame) => {
                let (temperature, tint) = wb_camera::resolve_target_versioned(
                    model,
                    frame,
                    profile,
                    self.as_shot_neutral,
                );
                let gain = if wb_camera::is_as_shot_target(frame, temperature, tint) {
                    [1.0; 3]
                } else {
                    wb_camera::camera_wb_gain(frame, self.as_shot_neutral, temperature, tint)
                };
                (
                    gain,
                    wb_camera::resolved_camera_to_xyz_d50(frame, profile, temperature, tint),
                )
            }
            None => ([1.0; 3], profile.forward_matrix),
        };
        let entry = dcp::camera_to_prophoto_with_forward(profile, forward_matrix)?;
        let exit = m_pro_to_rec2020();
        let hsm = profile.hsm.as_ref().map(|table| HueSatMapPass {
            dims: table.dims,
            srgb: table.encoding == HsmEncoding::Srgb,
            data: &table.data,
        });
        let entry = if hsm.is_some() {
            entry
        } else {
            exit.mul_mat(&entry)
        };
        Ok(DcpColorimetryPass {
            camera_gain,
            entry: entry.0,
            exit: exit.0,
            hsm,
        })
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "colorimetry_tests.rs"]
mod tests;

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "camera_prepare_tests.rs"]
mod camera_prepare_tests;
