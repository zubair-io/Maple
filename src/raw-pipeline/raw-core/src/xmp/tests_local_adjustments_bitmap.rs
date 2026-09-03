//! `Mask::Bitmap` / `Mask::Everywhere` XMP I/O (#3271) — the third
//! `crs:MaskGroupBasedCorrections` container, Lightroom 11+'s own shape for
//! its AI masks. Split from `tests_local_adjustments.rs` for the same
//! size-budget reason that file's header explains for its own split from
//! `xmp/tests.rs`.

use super::*;
use crate::types::local_adjustment::{
    BitmapRecipe, LocalAdjustment, Mask, PartialAdjustments, Point2, SKIN_TONE_RANGE,
};

const INDENT: &str = "      ";

fn sidecar(children: &str) -> String {
    format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/1.0/"
      crs:Version="11.0">
{children}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#
    )
}

/// The epic's headline shape: a Vision person/skin selection, narrowed by
/// the skin-tone colour range (spec §5.2/§5.3). `raster_id` stays `0` on
/// both sides — the parser never resolves it; that is the raw-ffi mask
/// registry's job, keyed off `recipe.digest`.
fn bitmap_layer() -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Bitmap {
            recipe: BitmapRecipe {
                person: 0,
                facial_skin: true,
                body_skin: true,
                model: "apple-vision-person-instance/1".to_string(),
                digest: "a1b2c3d4e5f60718".to_string(),
            },
            raster_id: 0,
        },
        range: Some(SKIN_TONE_RANGE),
        adjustments: PartialAdjustments {
            hue: Some(12.0),
            ..Default::default()
        },
    }
}

/// The no-person-detected fallback (spec §3.2): weight 1 everywhere.
fn everywhere_layer() -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Everywhere,
        range: None,
        adjustments: PartialAdjustments {
            exposure: Some(0.3),
            ..Default::default()
        },
    }
}

#[test]
fn model_to_bytes_to_model_round_trips_bitmap_and_everywhere() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![bitmap_layer(), everywhere_layer()];

    let children = serialize_local_adjustments(&model, INDENT);
    let doc = sidecar(&children);
    let parsed = parse(&doc).expect("parse");

    assert_eq!(parsed.local_adjustments.len(), 2, "doc:\n{doc}");
    assert_eq!(parsed.local_adjustments[0], bitmap_layer());
    assert_eq!(parsed.local_adjustments[1], everywhere_layer());
}

#[test]
fn write_parse_write_is_a_fixed_point_for_group_container() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![bitmap_layer(), everywhere_layer()];

    let once = serialize_local_adjustments(&model, INDENT);
    let parsed = parse(&sidecar(&once)).expect("parse");
    let twice = serialize_local_adjustments(&parsed, INDENT);
    assert_eq!(once, twice);
}

/// Bitmap and Everywhere share one container and never touch the two
/// geometric-mask containers — unlike Linear/Radial, neither has parametric
/// coordinates `crs:GradientBasedCorrections`/`crs:CircularGradientBasedCorrections`
/// could carry.
#[test]
fn bitmap_and_everywhere_share_the_mask_group_based_corrections_container() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![bitmap_layer(), everywhere_layer()];
    let children = serialize_local_adjustments(&model, INDENT);

    assert!(children.contains("<crs:MaskGroupBasedCorrections>"), "{children}");
    assert!(!children.contains("<crs:GradientBasedCorrections>"), "{children}");
    assert!(
        !children.contains("<crs:CircularGradientBasedCorrections>"),
        "{children}"
    );
}

/// A model mixing a geometric mask with a bitmap mask emits both
/// containers and round-trips both layers — the third container is
/// additive, not a replacement for the first two.
#[test]
fn mixed_container_types_all_emit_and_round_trip_together() {
    let linear = LocalAdjustment::linear(
        Point2::new(0.1, 0.1),
        Point2::new(0.9, 0.9),
        PartialAdjustments {
            exposure: Some(0.4),
            ..Default::default()
        },
    );
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![linear.clone(), bitmap_layer()];

    let children = serialize_local_adjustments(&model, INDENT);
    assert!(children.contains("<crs:GradientBasedCorrections>"), "{children}");
    assert!(children.contains("<crs:MaskGroupBasedCorrections>"), "{children}");

    let parsed = parse(&sidecar(&children)).expect("parse");
    assert_eq!(parsed.local_adjustments.len(), 2, "doc:\n{children}");
    assert_eq!(parsed.local_adjustments[0], linear);
    assert_eq!(parsed.local_adjustments[1], bitmap_layer());
}

/// A hand-authored fixture (not Maple's own writer output) proves the read
/// side accepts third-party-shaped `Mask/Image` input, not only Maple's own
/// round trip — same bar `tests_local_adjustments.rs`'s
/// `parses_acr_plausible_gradient_and_radial` holds Linear/Radial to.
#[test]
fn parses_a_hand_authored_person_skin_mask_image() {
    let children = r#"      <crs:MaskGroupBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              crs:LocalHue="0.12">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/Image"
                    crs:MaskSubType="1"
                    crs:MaskValue="1"
                    papp:MaskSource="PersonSkin"
                    papp:MaskPerson="0"
                    papp:MaskFacialSkin="True"
                    papp:MaskBodySkin="False"
                    papp:MaskModel="apple-vision-person-instance/1"
                    papp:MaskDigest="deadbeefcafef00d"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:MaskGroupBasedCorrections>"#;

    let model = parse(&sidecar(children)).expect("parse");
    assert_eq!(model.local_adjustments.len(), 1);
    match &model.local_adjustments[0].mask {
        Mask::Bitmap { recipe, raster_id } => {
            assert_eq!(recipe.person, 0);
            assert!(recipe.facial_skin);
            assert!(!recipe.body_skin);
            assert_eq!(recipe.model, "apple-vision-person-instance/1");
            assert_eq!(recipe.digest, "deadbeefcafef00d");
            assert_eq!(*raster_id, 0, "the parser never resolves a raster id");
        }
        other => panic!("expected bitmap mask, got {other:?}"),
    }
    assert_eq!(model.local_adjustments[0].adjustments.hue, Some(12.0));
}

/// Lightroom's own Select Subject / Select Sky masks are also `Mask/Image`
/// with a `crs:MaskDigest`, but carry no `papp:*` recipe — Maple can't
/// regenerate them, so the correction is dropped like any other
/// unrecognized mask kind, not treated as an error.
#[test]
fn lightroom_ai_mask_without_a_papp_recipe_is_skipped_not_fatal() {
    let children = r#"      <crs:MaskGroupBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True" crs:LocalExposure2012="1">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/Image" crs:MaskSubType="0" crs:MaskValue="1" crs:MaskDigest="lightroomownsubjectmaskdigest"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:MaskGroupBasedCorrections>"#;
    let model = parse(&sidecar(children)).expect("parse");
    assert!(model.local_adjustments.is_empty());
}

/// `papp:MaskSource="PersonSkin"` without `papp:MaskDigest` is a hard parse
/// error, not a silently-invented digest — an unregistered digest can never
/// resolve to a raster, so the correction would render as nothing forever
/// with no signal anything was wrong (same rationale as the geometric
/// masks' required-coordinate guard).
#[test]
fn person_skin_mask_missing_digest_is_a_hard_error() {
    let children = r#"      <crs:MaskGroupBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True" crs:LocalExposure2012="1">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/Image" crs:MaskValue="1" papp:MaskSource="PersonSkin"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:MaskGroupBasedCorrections>"#;
    assert!(parse(&sidecar(children)).is_err());
}

/// `crs:CorrectionActive="False"` drops a bitmap correction exactly like it
/// drops a geometric one — the active/inactive check runs before the mask
/// is even inspected.
#[test]
fn inactive_correction_drops_a_bitmap_layer_too() {
    let children = r#"      <crs:MaskGroupBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="False" crs:LocalExposure2012="1">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/Image" crs:MaskValue="1" papp:MaskSource="PersonSkin" papp:MaskDigest="deadbeefcafef00d"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:MaskGroupBasedCorrections>"#;
    let model = parse(&sidecar(children)).expect("parse");
    assert!(model.local_adjustments.is_empty());
}

/// The Everywhere fallback combines with the skin-tone range refinement
/// exactly like a Bitmap mask does — range is a refinement of whichever
/// primary mask it rides on, not something Bitmap-specific.
#[test]
fn everywhere_mask_combines_with_a_range_refinement() {
    let mut layer = everywhere_layer();
    layer.range = Some(SKIN_TONE_RANGE);
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![layer.clone()];

    let children = serialize_local_adjustments(&model, INDENT);
    assert!(children.contains("papp:RangeKind=\"Color\""), "{children}");
    assert!(children.contains("papp:MaskSource=\"Everywhere\""), "{children}");

    let parsed = parse(&sidecar(&children)).expect("parse");
    assert_eq!(parsed.local_adjustments, vec![layer]);
}
