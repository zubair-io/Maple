//! Best-effort UI facts share the resolver lookup required by the WB display seed.
//! They do not introduce another render prerequisite or change pixel development.

use raw_core::{color::dcp, image::RawImage, support_tiers::RenderSupport};

pub(crate) fn assess(raw: &RawImage) -> ((f32, f32), Option<RenderSupport>) {
    from_resolution(raw, dcp::estimate_as_shot_cct_tint_with_source(raw))
}

fn from_resolution(
    raw: &RawImage,
    result: raw_core::Result<((f32, f32), dcp::ProfileSource)>,
) -> ((f32, f32), Option<RenderSupport>) {
    match result {
        Ok((wb, source)) => (wb, Some(RenderSupport::from_source(raw, &source))),
        Err(_) => (
            (
                raw_core::stages::white_balance::estimate_cct_from_neutral(raw.as_shot_neutral),
                0.0,
            ),
            None,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw() -> RawImage {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
        raw_core::decode::decode(&fixture).expect("committed synthetic DNG")
    }

    #[test]
    fn shared_lookup_preserves_wb_and_reports_the_actual_profile_source() {
        let raw = raw();
        let (wb, support) = assess(&raw);
        assert_eq!(wb, crate::as_shot_wb(&raw));
        assert_eq!(support.unwrap(), RenderSupport::resolve(&raw).unwrap());
    }

    #[test]
    fn assessment_failure_keeps_the_wb_fallback_and_leaves_support_unassessed() {
        let raw = raw();
        let (wb, support) =
            from_resolution(&raw, Err(raw_core::Error::Dcp("assessment failed".into())));
        assert_eq!(
            wb,
            (
                raw_core::stages::white_balance::estimate_cct_from_neutral(raw.as_shot_neutral),
                0.0
            )
        );
        assert!(support.is_none());
    }
}
