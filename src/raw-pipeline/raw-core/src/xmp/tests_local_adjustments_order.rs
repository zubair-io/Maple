//! Cross-container layer order (#4427): `papp:LayerOrder` keeps an
//! interleaved stack in model order through the per-kind XMP containers.
//! Helpers (`sidecar`, `INDENT`) come from `tests_local_adjustments.rs`.

use super::tests_local_adjustments::{sidecar, INDENT};
use super::*;
use crate::image::{ColorSpace, Image};
use crate::stages::local_adjustments::apply;
use crate::types::local_adjustment::{
    BitmapRecipe, BrushDab, LocalAdjustment, Mask, MaskSource, PartialAdjustments, Point2,
};

fn exposure(value: f32) -> PartialAdjustments {
    PartialAdjustments {
        exposure: Some(value),
        ..Default::default()
    }
}

fn linear(adjustments: PartialAdjustments) -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.2, 0.3),
            end: Point2::new(0.8, 0.7),
            feather: 0.5,
        },
        range: None,
        adjustments,
    }
}

fn radial(adjustments: PartialAdjustments) -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Radial {
            center: Point2::new(0.5, 0.5),
            radii: Point2::new(0.25, 0.125),
            angle: 0.0,
            feather: 0.5,
            invert: false,
        },
        range: None,
        adjustments,
    }
}

fn brush(adjustments: PartialAdjustments) -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Brush {
            dabs: vec![BrushDab::new(Point2::new(0.25, 0.3), 0.05, 0.5, 0.8, false)],
            digest: "0123456789abcdef".to_string(),
            raster_id: 0,
        },
        range: None,
        adjustments,
    }
}

fn bitmap(adjustments: PartialAdjustments) -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Bitmap {
            recipe: BitmapRecipe {
                source: MaskSource::PersonSkin,
                person: 0,
                facial_skin: true,
                body_skin: false,
                model: "apple-vision-person-instance/1".to_string(),
                digest: "a1b2c3d4e5f60718".to_string(),
            },
            raster_id: 0,
        },
        range: None,
        adjustments,
    }
}

fn interleaved_stack() -> Vec<LocalAdjustment> {
    vec![
        brush(exposure(0.1)),
        radial(exposure(0.2)),
        bitmap(exposure(0.3)),
        linear(exposure(0.4)),
        radial(exposure(0.5)),
    ]
}

fn save(layers: Vec<LocalAdjustment>) -> String {
    let model = AdjustmentModel {
        local_adjustments: layers,
        ..Default::default()
    };
    sidecar(&serialize_local_adjustments(&model, INDENT))
}

/// Cross-language byte-parity fixture (#4427): an interleaved stack (radial
/// below linear) stamps both corrections with their model index. The same
/// literal appears in `LocalAdjustmentOrderTests.swift`,
/// `local-adjustments-order.spec.ts` and `XmpLayerOrderTests.cs`.
const CANONICAL_ORDER_BLOCK: &str = r#"      <crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              papp:LayerOrder="1"
              crs:LocalExposure2012="0.4">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/Gradient"
                    crs:MaskValue="1"
                    crs:ZeroX="0.2" crs:ZeroY="0.3"
                    crs:FullX="0.8" crs:FullY="0.7"
                    papp:LocalFeather="0.5"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:GradientBasedCorrections>
      <crs:CircularGradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              papp:LayerOrder="0"
              crs:LocalExposure2012="0.2">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/CircularGradient"
                    crs:MaskValue="1"
                    crs:Top="0.375" crs:Left="0.25" crs:Bottom="0.625" crs:Right="0.75"
                    crs:Angle="0" crs:Midpoint="50" crs:Roundness="0"
                    crs:Feather="50" crs:Flipped="False"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:CircularGradientBasedCorrections>"#;

/// Cross-language fixture for a correction a host keeps verbatim (#4427):
/// a stroke with a brush version this build cannot read sits between two
/// modeled layers. Hosts that keep it (Apple, Web, Windows) insert a new
/// linear layer at the bottom, emit `PASSTHROUGH_ORDER_BLOCK` for the
/// modeled layers and renumber the stroke's key from 1 to 2. raw-core has no
/// passthrough, so it pins only the read side.
const BRUSH_V2_BLOCK: &str = r#"      <papp:BrushCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              papp:LayerOrder="1"
              crs:LocalExposure2012="0.3">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/Paint"
                    crs:MaskValue="1"
                    papp:BrushVersion="2"
                    papp:Dabs="0.25 0.3 0.05 0.5 0.8 0"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </papp:BrushCorrections>"#;

const PASSTHROUGH_ORDER_BLOCK: &str = r#"      <crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              papp:LayerOrder="0"
              crs:LocalExposure2012="0.1">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/Gradient"
                    crs:MaskValue="1"
                    crs:ZeroX="0.2" crs:ZeroY="0.3"
                    crs:FullX="0.8" crs:FullY="0.7"
                    papp:LocalFeather="0.5"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              papp:LayerOrder="1"
              crs:LocalExposure2012="0.4">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/Gradient"
                    crs:MaskValue="1"
                    crs:ZeroX="0.2" crs:ZeroY="0.3"
                    crs:FullX="0.8" crs:FullY="0.7"
                    papp:LocalFeather="0.5"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:GradientBasedCorrections>
      <crs:CircularGradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              papp:LayerOrder="3"
              crs:LocalExposure2012="0.2">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/CircularGradient"
                    crs:MaskValue="1"
                    crs:Top="0.375" crs:Left="0.25" crs:Bottom="0.625" crs:Right="0.75"
                    crs:Angle="0" crs:Midpoint="50" crs:Roundness="0"
                    crs:Feather="50" crs:Flipped="False"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:CircularGradientBasedCorrections>"#;

#[test]
fn the_passthrough_literal_reads_in_full_stack_order() {
    let renumbered = BRUSH_V2_BLOCK.replace("papp:LayerOrder=\"1\"", "papp:LayerOrder=\"2\"");
    let document = sidecar(&format!("{PASSTHROUGH_ORDER_BLOCK}\n{renumbered}"));
    assert_eq!(
        parse(&document).expect("parse").local_adjustments,
        vec![
            linear(exposure(0.1)),
            linear(exposure(0.4)),
            radial(exposure(0.2)),
        ]
    );
}

#[test]
fn interleaved_pair_matches_the_cross_language_literal() {
    let model = AdjustmentModel {
        local_adjustments: vec![radial(exposure(0.2)), linear(exposure(0.4))],
        ..Default::default()
    };
    assert_eq!(
        serialize_local_adjustments(&model, INDENT),
        CANONICAL_ORDER_BLOCK
    );
    let parsed = parse(&sidecar(CANONICAL_ORDER_BLOCK)).expect("parse");
    assert_eq!(parsed.local_adjustments, model.local_adjustments);
}

#[test]
fn interleaved_stack_survives_save_reopen_save_through_a_file() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("interleaved.xmp");
    let first = save(interleaved_stack());
    std::fs::write(&path, &first).expect("write");

    let reopened = parse(&std::fs::read_to_string(&path).expect("read")).expect("parse");
    assert_eq!(reopened.local_adjustments, interleaved_stack());

    let second = save(reopened.local_adjustments);
    assert_eq!(second, first, "a re-save must be a fixed point");
    assert_eq!(first.matches("papp:LayerOrder=").count(), 5);
}

#[test]
fn a_stack_already_in_container_order_writes_no_order_keys() {
    let ordered = vec![
        linear(exposure(0.4)),
        radial(exposure(0.2)),
        brush(exposure(0.1)),
        bitmap(exposure(0.3)),
    ];
    let saved = save(ordered.clone());
    assert!(!saved.contains("papp:LayerOrder"), "{saved}");
    assert_eq!(parse(&saved).expect("parse").local_adjustments, ordered);
}

#[test]
fn an_unkeyed_sidecar_keeps_container_order() {
    let stripped: String = save(interleaved_stack())
        .lines()
        .filter(|line| !line.contains("papp:LayerOrder="))
        .collect::<Vec<_>>()
        .join("\n");
    let reopened = parse(&stripped).expect("parse").local_adjustments;
    assert_eq!(
        reopened,
        vec![
            linear(exposure(0.4)),
            radial(exposure(0.2)),
            radial(exposure(0.5)),
            brush(exposure(0.1)),
            bitmap(exposure(0.3)),
        ]
    );
    let model = AdjustmentModel {
        local_adjustments: reopened,
        ..Default::default()
    };
    assert!(!serialize_local_adjustments(&model, INDENT).contains("papp:LayerOrder"));
}

#[test]
fn a_partially_keyed_sidecar_keeps_container_order() {
    let saved = save(vec![radial(exposure(0.2)), linear(exposure(0.4))]);
    let partial = saved.replacen("              papp:LayerOrder=\"1\"\n", "", 1);
    assert_ne!(partial, saved);
    assert_eq!(
        parse(&partial).expect("parse").local_adjustments,
        vec![linear(exposure(0.4)), radial(exposure(0.2))]
    );
}

#[test]
fn a_malformed_order_key_is_a_parse_error() {
    let saved = save(vec![radial(exposure(0.2)), linear(exposure(0.4))]);
    let corrupt = saved.replacen("papp:LayerOrder=\"1\"", "papp:LayerOrder=\"-1\"", 1);
    assert!(parse(&corrupt).is_err());
}

fn grey(width: u32) -> Image {
    Image {
        nr_sampling_scale: 1.0,
        whites_anchor_ev: None,
        width,
        height: 1,
        pixels: vec![[0.18, 0.18, 0.18]; width as usize],
        space: ColorSpace::SceneLinearRec2020,
    }
}

fn render(layers: &[LocalAdjustment]) -> Vec<[f32; 3]> {
    let mut image = grey(4);
    apply(&mut image, layers, &[]);
    image.pixels
}

/// Exposure multiplies and Blacks adds, so the two layers do not commute:
/// the reloaded stack must render exactly like the authored one, and the
/// per-kind order a key-less reader would produce must render differently.
#[test]
fn the_reloaded_order_is_the_order_that_renders() {
    let lift = LocalAdjustment {
        mask: Mask::Everywhere,
        range: None,
        adjustments: PartialAdjustments {
            blacks: Some(60.0),
            ..Default::default()
        },
    };
    let gain = LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.0),
            end: Point2::new(1.0, 0.0),
            feather: 0.0,
        },
        range: None,
        adjustments: exposure(1.5),
    };
    let authored = vec![lift.clone(), gain.clone()];
    let reopened = parse(&save(authored.clone()))
        .expect("parse")
        .local_adjustments;

    assert_eq!(reopened, authored);
    assert_eq!(render(&reopened), render(&authored));
    assert_ne!(render(&[gain, lift]), render(&authored));
}
