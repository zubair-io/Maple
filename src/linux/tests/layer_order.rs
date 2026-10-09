use std::fs;

use maple_linux::controls::Control;
use maple_linux::sidecar::{sidecar_path, SidecarStore};
use raw_core::types::adjustment::AdjustmentModel;
use raw_core::types::{BrushDab, LocalAdjustment, Mask, PartialAdjustments, Point2};
use raw_core::xmp::serialize_local_adjustments;
use tempfile::TempDir;

fn layer(mask: Mask, exposure: f32) -> LocalAdjustment {
    LocalAdjustment {
        mask,
        range: None,
        adjustments: PartialAdjustments {
            exposure: Some(exposure),
            ..Default::default()
        },
    }
}

fn interleaved_stack() -> Vec<LocalAdjustment> {
    vec![
        layer(
            Mask::Brush {
                dabs: vec![BrushDab::new(Point2::new(0.25, 0.3), 0.05, 0.5, 0.8, false)],
                digest: "0123456789abcdef".to_string(),
                raster_id: 0,
            },
            0.1,
        ),
        layer(
            Mask::Radial {
                center: Point2::new(0.5, 0.5),
                radii: Point2::new(0.25, 0.125),
                angle: 0.0,
                feather: 0.5,
                invert: false,
            },
            0.2,
        ),
        layer(
            Mask::Linear {
                start: Point2::new(0.2, 0.3),
                end: Point2::new(0.8, 0.7),
                feather: 0.5,
            },
            0.4,
        ),
    ]
}

fn sidecar(children: &str) -> String {
    format!(
        r#"<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/photo/1.0/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/">
{children}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#
    )
}

fn corrections(xml: &str) -> &str {
    let start = xml.find("<crs:GradientBasedCorrections>").unwrap();
    let end = xml.find("</papp:BrushCorrections>").unwrap();
    &xml[start..end]
}

#[test]
fn an_interleaved_stack_keeps_its_order_through_a_linux_edit() {
    let model = AdjustmentModel {
        local_adjustments: interleaved_stack(),
        ..Default::default()
    };
    let source = sidecar(&serialize_local_adjustments(&model, "      "));
    assert!(source.contains("papp:LayerOrder=\"2\""));

    let temp = TempDir::new().unwrap();
    let original = temp.path().join("photo.dng");
    fs::write(&original, b"original").unwrap();
    fs::write(sidecar_path(&original).unwrap(), &source).unwrap();

    let (mut store, mut document) = SidecarStore::open(&original).unwrap();
    assert_eq!(document.model.local_adjustments, interleaved_stack());
    Control::Exposure.set(&mut document.model, 1.25).unwrap();
    store.save(&document).unwrap();

    let saved = fs::read_to_string(store.path()).unwrap();
    assert_eq!(corrections(&saved), corrections(&source));
    let (_, reopened) = SidecarStore::open(&original).unwrap();
    assert_eq!(reopened.model.local_adjustments, interleaved_stack());
}
