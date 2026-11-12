//! Lens-correction queries on a decoded RAW's `OpcodeList3` (#2231, #3189).
use super::RawImage;
use crate::pipeline::pano::opcodes::PanoOpcode;

impl RawImage {
    /// Whether this RAW carries a parsed `OpcodeList3` at all — the signal
    /// the lens-correction inspector panel (#2231) uses to disable/hide
    /// itself when there is nothing for `lens_profile_enable` /
    /// `lens_correction_*` to scale. `false` for any source with no
    /// `OpcodeList3` tag, or whose tag failed to parse into a recognised
    /// opcode (see `pipeline::pano::opcodes::read_opcode_list3`).
    pub fn has_lens_corrections(&self) -> bool {
        self.opcode_list3.is_some()
    }

    /// Whether the chromatic-aberration slider (`lens_correction_ca`) is
    /// INERT on this RAW — true when there is no `WarpRectilinear` opcode,
    /// or every `WarpRectilinear` opcode carries a single coefficient set
    /// (`planes.len() <= 1`, #2231). A single set applies identically to
    /// every color plane (`WarpRectilinearOpcode`'s own doc comment: "N = 1
    /// means common"), so there is no per-plane divergence for the CA scale
    /// to attenuate — moving the slider changes nothing. `true` (inert) is
    /// also the answer when there are no lens corrections at all, matching
    /// `has_lens_corrections() == false` implying every scale is a no-op.
    pub fn lens_correction_ca_inert(&self) -> bool {
        let Some((list, _)) = &self.opcode_list3 else {
            return true;
        };
        list.opcodes.iter().all(|op| match op {
            PanoOpcode::WarpRectilinear(w) => w.planes.len() <= 1,
            _ => true,
        })
    }

    /// Whether the distortion slider (`lens_correction_distortion`) is
    /// INERT on this RAW — true when there is no `WarpRectilinear` opcode
    /// in `OpcodeList3` at all (#3189). A vignette-only source (only
    /// `FixVignetteRadial`) is the common case: `has_lens_corrections()`
    /// is `true` — there IS an opcode list — but there is nothing
    /// `lens_correction_distortion` can scale.
    ///
    /// Unlike `lens_correction_ca_inert`, a SINGLE coefficient set is
    /// enough for distortion to have a real geometric effect — CA needs
    /// per-plane divergence to have anything to attenuate, but distortion
    /// warps every plane identically under a single set, which is still a
    /// real (if colour-neutral) correction. So this checks presence only,
    /// not `planes.len()`. `true` (inert) is also the answer when there
    /// are no lens corrections at all, matching
    /// `has_lens_corrections() == false`.
    pub fn lens_correction_distortion_inert(&self) -> bool {
        let Some((list, _)) = &self.opcode_list3 else {
            return true;
        };
        !list
            .opcodes
            .iter()
            .any(|op| matches!(op, PanoOpcode::WarpRectilinear(_)))
    }
}
