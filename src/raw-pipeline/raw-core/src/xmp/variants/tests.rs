//! Round-trip and structural tests for the variants / snapshots / history
//! blocks (#2437). The document-level fixtures write a real `.xmp` file into
//! a temp directory and read it back, per `CLAUDE.md`'s "no mocks for the
//! sidecar layer" convention — the sidecar is the contract.

use super::*;
use crate::types::adjustment::{Crop, Profile};
use std::path::PathBuf;

/// Wrap a `rdf:Description` attribute fragment and child block into the
/// canonical envelope, matching what the three shells write.
fn document(attrs: &str, children: &str) -> String {
    let body = if children.is_empty() {
        format!("    <rdf:Description rdf:about=\"\"{attrs}/>\n")
    } else {
        format!("    <rdf:Description rdf:about=\"\"{attrs}>\n{children}\n    </rdf:Description>\n")
    };
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
         <x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n\
         \x20 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
         {body}\
         \x20 </rdf:RDF>\n\
         </x:xmpmeta>\n\
         <?xpacket end=\"w\"?>\n"
    )
}

/// A temp directory that removes itself. raw-core has no `tempfile`
/// dependency and this is the only test here that needs one.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "maple-2437-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn sample() -> Variants {
    let mut snapshot_model = AdjustmentModel {
        profile: Profile::Neutral,
        brightness: 12.0,
        ..Default::default()
    };
    snapshot_model.crop = Crop {
        top: 0.1,
        left: 0.2,
        bottom: 0.9,
        right: 0.8,
        angle: 0.0,
    };
    Variants {
        variant_id: String::new(),
        variant_name: String::new(),
        variants: vec![
            VariantRecord {
                id: "warm".into(),
                name: "Warm & tight".into(),
                created: "2026-09-07T10:00:00Z".into(),
                deleted: false,
            },
            VariantRecord {
                id: "bw".into(),
                name: String::new(),
                created: "2026-09-07T10:05:00Z".into(),
                deleted: true,
            },
        ],
        snapshots: vec![Snapshot {
            name: "Before crop".into(),
            created: "2026-09-07T10:01:00Z".into(),
            model: snapshot_model,
        }],
        history: vec![
            HistoryEntry {
                kind: "adjustment".into(),
                description: "Brightness".into(),
                time: "2026-09-07T10:01:00Z".into(),
                model: AdjustmentModel {
                    brightness: 6.0,
                    ..Default::default()
                },
            },
            HistoryEntry {
                kind: "preset".into(),
                description: "Applied \"Golden Hour\"".into(),
                time: "2026-09-07T10:02:00Z".into(),
                model: AdjustmentModel {
                    film_look: "kodak-gold-200".into(),
                    film_strength: 80.0,
                    ..Default::default()
                },
            },
            HistoryEntry {
                kind: "snapshot".into(),
                description: "Restored \"Before crop\"".into(),
                time: "2026-09-07T10:03:00Z".into(),
                model: AdjustmentModel {
                    profile: Profile::Neutral,
                    deep_denoise: 30.0,
                    ..Default::default()
                },
            },
        ],
    }
}

#[test]
fn empty_blocks_emit_nothing() {
    assert_eq!(serialize_variants(&Variants::default(), "      "), "");
}

#[test]
fn round_trips_through_a_real_sidecar_file() {
    let expected = sample();
    let dir = TempDir::new("roundtrip");
    let path = dir.0.join("IMG_1234.xmp");
    let xml = document(
        " papp:Profile=\"Auto\"",
        &serialize_variants(&expected, "      "),
    );
    std::fs::write(&path, xml).unwrap();

    let text = std::fs::read_to_string(&path).unwrap();
    let (model, parsed) = crate::xmp::parse_document(&text).unwrap();

    // The document's own develop state is untouched by the three blocks —
    // a history entry's brightness must never leak onto the live image.
    assert_eq!(model.brightness, 0.0);
    assert_eq!(model.deep_denoise, 0.0);
    assert_eq!(model.film_look, "");
    assert_eq!(model.crop, Crop::default());

    assert_eq!(parsed.variants, expected.variants);
    assert_eq!(parsed.snapshots.len(), 1);
    assert_eq!(parsed.snapshots[0].name, "Before crop");
    assert_eq!(parsed.snapshots[0].created, "2026-09-07T10:01:00Z");
    assert_eq!(parsed.snapshots[0].model.brightness, 12.0);
    assert_eq!(parsed.snapshots[0].model.profile, Profile::Neutral);
    assert_eq!(
        parsed.snapshots[0].model.crop,
        expected.snapshots[0].model.crop
    );

    let kinds: Vec<&str> = parsed.history.iter().map(|h| h.kind.as_str()).collect();
    assert_eq!(kinds, ["adjustment", "preset", "snapshot"]);
    assert_eq!(parsed.history[1].description, "Applied \"Golden Hour\"");
    assert_eq!(parsed.history[1].model.film_look, "kodak-gold-200");
    assert_eq!(parsed.history[1].model.film_strength, 80.0);
    assert_eq!(parsed.history[2].model.deep_denoise, 30.0);
}

#[test]
fn serialization_is_a_fixed_point() {
    let first = serialize_variants(&sample(), "      ");
    let (_, parsed) = crate::xmp::parse_document(&document("", &first)).unwrap();
    assert_eq!(serialize_variants(&parsed, "      "), first);
}

#[test]
fn entry_tone_curves_ride_as_children() {
    let entry = HistoryEntry {
        kind: "adjustment".into(),
        description: "Tone curve".into(),
        time: "2026-09-07T11:00:00Z".into(),
        model: AdjustmentModel {
            tone_curve_luma: crate::types::adjustment::ToneCurve::new(vec![
                (0.0, 0.0),
                (0.5, 0.55),
                (1.0, 1.0),
            ]),
            ..Default::default()
        },
    };
    let branch = Variants {
        history: vec![entry],
        ..Default::default()
    };
    let block = serialize_variants(&branch, "      ");
    assert!(block.contains("<papp:SceneLinearToneCurve>"), "{block}");
    assert!(block.contains("<rdf:li>127.5, 140.25</rdf:li>"), "{block}");

    let (model, parsed) = crate::xmp::parse_document(&document("", &block)).unwrap();
    // The nested curve belongs to the entry, not to the live image.
    assert!(model.tone_curve_luma.is_identity());
    assert_eq!(parsed.history[0].model.tone_curve_luma.points.len(), 3);
    assert_eq!(parsed.history[0].model.tone_curve_luma.points[1].1, 0.55);
}

#[test]
fn variant_identity_rides_as_a_document_attribute() {
    let xml = document(
        " papp:Profile=\"Auto\" papp:VariantId=\"warm\" papp:VariantName=\"Warm\"",
        "",
    );
    let (model, parsed) = crate::xmp::parse_document(&xml).unwrap();
    assert_eq!(parsed.variant_id, "warm");
    assert_eq!(parsed.variant_name, "Warm");
    assert_eq!(model.profile, Profile::Auto);
}

#[test]
fn a_variant_naive_sidecar_yields_empty_branching() {
    let xml = document(" papp:Profile=\"Auto\" papp:Brightness=\"6\"", "");
    let (model, parsed) = crate::xmp::parse_document(&xml).unwrap();
    assert_eq!(model.brightness, 6.0);
    assert_eq!(parsed, Variants::default());
}

#[test]
fn history_is_bounded_at_the_cap() {
    let entries: Vec<HistoryEntry> = (0..HISTORY_CAP + 9)
        .map(|i| HistoryEntry {
            kind: "adjustment".into(),
            description: format!("Step {i}"),
            time: "2026-09-07T10:00:00Z".into(),
            model: AdjustmentModel::default(),
        })
        .collect();
    let compacted = compact_history(entries);
    assert_eq!(compacted.len(), HISTORY_CAP);
    // Compaction drops the oldest and never rewrites a survivor.
    assert_eq!(compacted[0].description, "Step 9");
    assert_eq!(
        compacted[HISTORY_CAP - 1].description,
        format!("Step {}", HISTORY_CAP + 8)
    );
}

#[test]
fn an_over_long_history_is_trimmed_on_read() {
    let branch = Variants {
        history: (0..HISTORY_CAP + 4)
            .map(|i| HistoryEntry {
                kind: "adjustment".into(),
                description: format!("Step {i}"),
                time: String::new(),
                model: AdjustmentModel::default(),
            })
            .collect(),
        ..Default::default()
    };
    let xml = document("", &serialize_variants(&branch, "      "));
    let (_, parsed) = crate::xmp::parse_document(&xml).unwrap();
    assert_eq!(parsed.history.len(), HISTORY_CAP);
    assert_eq!(parsed.history[0].description, "Step 4");
}

#[test]
fn variant_ids_are_filename_safe() {
    assert!(is_valid_variant_id("warm"));
    assert!(is_valid_variant_id("v2"));
    assert!(is_valid_variant_id("A-b_9"));
    assert!(!is_valid_variant_id(""));
    assert!(!is_valid_variant_id(PRIMARY_VARIANT_ID));
    assert!(!is_valid_variant_id("with space"));
    assert!(!is_valid_variant_id("with.dot"));
    assert!(!is_valid_variant_id("with/slash"));
    assert!(!is_valid_variant_id("../escape"));
    assert!(!is_valid_variant_id("é"));
    assert!(!is_valid_variant_id(&"x".repeat(33)));
}

#[test]
fn variant_sidecar_names_round_trip() {
    assert_eq!(
        variant_sidecar_name("IMG_1234.xmp", "warm").unwrap(),
        "IMG_1234.v-warm.xmp"
    );
    // Videos append rather than swap, so the marker lands before `.xmp`
    // either way and the two naming rules stay independent.
    assert_eq!(
        variant_sidecar_name("clip.mov.xmp", "warm").unwrap(),
        "clip.mov.v-warm.xmp"
    );
    assert_eq!(variant_sidecar_name("IMG_1234.xmp", "primary"), None);
    assert_eq!(variant_sidecar_name("IMG_1234.dng", "warm"), None);

    assert_eq!(
        parse_variant_sidecar_name("IMG_1234.v-warm.xmp").unwrap(),
        ("IMG_1234.xmp".to_string(), "warm".to_string())
    );
    assert_eq!(
        parse_variant_sidecar_name("clip.mov.v-warm.xmp").unwrap(),
        ("clip.mov.xmp".to_string(), "warm".to_string())
    );
    // A plain sidecar, and a sibling whose marker segment is not an id this
    // build would ever write, both stay non-variants.
    assert_eq!(parse_variant_sidecar_name("IMG_1234.xmp"), None);
    assert_eq!(parse_variant_sidecar_name("IMG_1234.v-.xmp"), None);
    assert_eq!(parse_variant_sidecar_name("IMG_1234.v-a b.xmp"), None);
}

#[test]
fn a_manifest_entry_with_an_unusable_id_is_dropped() {
    let xml = document(
        "",
        "      <papp:Variants>\n\
         \x20       <rdf:Seq>\n\
         \x20         <rdf:li>\n\
         \x20           <rdf:Description papp:VariantId=\"../escape\"/>\n\
         \x20         </rdf:li>\n\
         \x20         <rdf:li>\n\
         \x20           <rdf:Description papp:VariantId=\"warm\"/>\n\
         \x20         </rdf:li>\n\
         \x20       </rdf:Seq>\n\
         \x20     </papp:Variants>",
    );
    let (_, parsed) = crate::xmp::parse_document(&xml).unwrap();
    assert_eq!(parsed.variants.len(), 1);
    assert_eq!(parsed.variants[0].id, "warm");
}

#[test]
fn tombstones_are_kept_and_filtered() {
    let branch = sample();
    let live: Vec<&str> = branch.live_variants().map(|v| v.id.as_str()).collect();
    assert_eq!(live, ["warm"]);
    assert!(branch.variant("bw").unwrap().deleted);
    assert!(branch.variant("nope").is_none());
}
