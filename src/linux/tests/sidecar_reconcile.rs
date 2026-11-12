//! Outside sidecar changes merge through the shared `reconcile_xmp` (#4983)
//! instead of being refused, on real files beside an untouched original.
use std::fs;
use std::path::PathBuf;

use maple_linux::controls::Control;
use maple_linux::sidecar::{SidecarDocument, SidecarError, SidecarStore};
use raw_core::workflow::SidecarWorkflow;
use tempfile::TempDir;

const ORIGINAL: &[u8] = b"original bytes are immutable";
const NESTED: &str =
    r#"<vendor:Nested keep="exact"><![CDATA[a < b]]><!-- kept --></vendor:Nested>"#;

fn sidecar(attributes: &str) -> String {
    format!(
        r#"<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/photo/1.0/"
      xmlns:vendor="urn:vendor"
      vendor:Data="exact"{attributes}>
      {NESTED}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#
    )
}

struct Photo {
    _directory: TempDir,
    original: PathBuf,
    store: SidecarStore,
    document: SidecarDocument,
}

fn open(xml: &str) -> Photo {
    let directory = TempDir::new().unwrap();
    let original = directory.path().join("photo.dng");
    fs::write(&original, ORIGINAL).unwrap();
    fs::write(original.with_extension("xmp"), xml).unwrap();
    let (store, document) = SidecarStore::open(&original).unwrap();
    Photo {
        _directory: directory,
        original,
        store,
        document,
    }
}

impl Photo {
    fn sidecar(&self) -> String {
        fs::read_to_string(self.store.path()).unwrap()
    }

    /// Another application rewrites the sidecar, as Lightroom does.
    fn outside_edit(&self, from: &str, to: &str) {
        let xml = self.sidecar();
        assert!(xml.contains(from), "{from} not in {xml}");
        fs::write(self.store.path(), xml.replacen(from, to, 1)).unwrap();
    }

    fn history(&self) -> Vec<raw_core::workflow::WorkflowHistoryEntry> {
        SidecarWorkflow::from_xmp(&self.sidecar())
            .unwrap()
            .map(|record| record.history)
            .unwrap_or_default()
    }

    fn reopened(&self) -> SidecarDocument {
        SidecarStore::open(&self.original).unwrap().1
    }
}

fn edit(document: &SidecarDocument, control: Control, value: f32) -> SidecarDocument {
    let mut edited = document.clone();
    control.set(&mut edited.model, value).unwrap();
    edited
}

#[test]
fn an_outside_edit_to_another_property_merges_with_the_linux_edit() {
    let mut photo = open(&sidecar(r#" crs:Exposure2012="0.25""#));
    let contrast = edit(&photo.document, Control::Contrast, 20.0);
    assert!(photo.store.save(&contrast).unwrap().is_none());
    photo.outside_edit(
        r#"vendor:Data="exact""#,
        r#"vendor:Data="lightroom" crs:HueAdjustmentRed="12""#,
    );
    let exposure = edit(&contrast, Control::Exposure, 1.0);
    let merged = photo
        .store
        .save(&exposure)
        .unwrap()
        .expect("an outside change is merged, not refused")
        .document;

    let written = photo.sidecar();
    assert_eq!(merged.serialize().unwrap(), written);
    let reopened = photo.reopened();
    assert_eq!(reopened.model.exposure, 1.0);
    assert_eq!(reopened.model.contrast, 20.0);
    assert_eq!(reopened.model.hue_adjustment_red, 12.0);
    assert!(written.contains(r#"vendor:Data="lightroom""#));
    assert!(written.contains(NESTED));
    let history = photo.history();
    let outside = history.last().expect("the outside state is recorded");
    assert_eq!(outside.action, "external");
    assert!(outside
        .adjustment_xmp
        .contains(r#"crs:HueAdjustmentRed="12""#));
    assert_eq!(fs::read(&photo.original).unwrap(), ORIGINAL);

    let adopted = edit(&merged, Control::Clarity, 15.0);
    assert!(
        photo.store.save(&adopted).unwrap().is_none(),
        "the adopted document is the new base"
    );
    assert_eq!(photo.history().len(), history.len());
    assert_eq!(photo.reopened().model.clarity, 15.0);
}

#[test]
fn both_sides_changing_one_property_keep_the_linux_value_and_record_the_other() {
    let mut photo = open(&sidecar(r#" crs:Exposure2012="0.25""#));
    photo.outside_edit(r#"crs:Exposure2012="0.25""#, r#"crs:Exposure2012="-1""#);
    let exposure = edit(&photo.document, Control::Exposure, 1.5);
    photo.store.save(&exposure).unwrap().expect("merged");
    assert_eq!(photo.reopened().model.exposure, 1.5);
    let history = photo.history();
    assert_eq!(history.len(), 1);
    assert!(history[0]
        .adjustment_xmp
        .contains(r#"crs:Exposure2012="-1""#));
}

#[test]
fn queued_and_undo_states_apply_their_own_changes_on_top_of_the_merge() {
    let mut photo = open(&sidecar(r#" crs:Exposure2012="0.25""#));
    let opened = photo.document.clone();
    let exposure = edit(&opened, Control::Exposure, 1.0);
    assert!(photo.store.save(&exposure).unwrap().is_none());
    photo.outside_edit(
        r#"vendor:Data="exact""#,
        r#"vendor:Data="exact" crs:HueAdjustmentRed="12""#,
    );
    let contrast = edit(&exposure, Control::Contrast, 20.0);
    photo.store.save(&contrast).unwrap().expect("merged");

    // Queued before the editor adopted the merge: it must not revert it.
    let queued = edit(&contrast, Control::Clarity, 15.0);
    photo.store.save(&queued).unwrap();
    let model = photo.reopened().model;
    assert_eq!(
        (model.exposure, model.contrast, model.clarity),
        (1.0, 20.0, 15.0)
    );
    assert_eq!(model.hue_adjustment_red, 12.0);

    // Undo back to the opening state reverts only Maple's own edits.
    photo.store.save(&opened).unwrap();
    let model = photo.reopened().model;
    assert_eq!(
        (model.exposure, model.contrast, model.clarity),
        (0.25, 0.0, 0.0)
    );
    assert_eq!(model.hue_adjustment_red, 12.0);
    assert!(photo.sidecar().contains(NESTED));
    assert_eq!(fs::read(&photo.original).unwrap(), ORIGINAL);
}

#[test]
fn a_redo_saved_after_an_adopted_merge_and_its_undo_keeps_the_redone_change() {
    // #5887 review: exposure 0 -> 1 while another app changes vibrance; the
    // editor adopts the merge (its undo state rebased onto it), undoes, the
    // undo is saved, then Redo restores the adopted document.
    let mut photo = open(&sidecar(""));
    let opened = photo.document.clone();
    let exposure = edit(&opened, Control::Exposure, 1.0);
    photo.outside_edit(
        r#"vendor:Data="exact""#,
        r#"vendor:Data="exact" crs:Vibrance="30""#,
    );
    let merged = photo.store.save(&exposure).unwrap().expect("merged");
    let adopted = merged.document.clone();
    let undo = merged.rebase(&opened).unwrap();
    assert_eq!((undo.model.exposure, undo.model.vibrance), (0.0, 30.0));

    assert!(photo.store.save(&undo).unwrap().is_none());
    let model = photo.reopened().model;
    assert_eq!((model.exposure, model.vibrance), (0.0, 30.0));

    assert!(photo.store.save(&adopted).unwrap().is_none());
    let model = photo.reopened().model;
    assert_eq!(
        (model.exposure, model.vibrance),
        (1.0, 30.0),
        "the redo lands"
    );

    // An undo state the editor had not rebased (still in the opening
    // lineage) never reverts the outside change either.
    photo.store.save(&opened).unwrap();
    let model = photo.reopened().model;
    assert_eq!((model.exposure, model.vibrance), (0.0, 30.0));
    assert_eq!(fs::read(&photo.original).unwrap(), ORIGINAL);
}

#[test]
fn an_existing_workflow_record_keeps_its_history_and_gains_the_outside_state() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/workflow/v1-sidecar.xmp");
    let source = fs::read_to_string(fixture).unwrap();
    let before = SidecarWorkflow::from_xmp(&source).unwrap().unwrap().history;
    let mut photo = open(&source);
    let opened = photo.document.clone();
    photo.outside_edit(r#"crs:Vibrance="0""#, r#"crs:Vibrance="7""#);
    let exposure = edit(&opened, Control::Exposure, -0.5);
    photo.store.save(&exposure).unwrap().expect("merged");
    let model = photo.reopened().model;
    assert_eq!((model.exposure, model.vibrance), (-0.5, 7.0));
    let after = photo.history();
    assert_eq!(after.len(), before.len() + 1);
    for (kept, original) in after.iter().zip(&before) {
        assert_eq!(kept.id, original.id);
        assert_eq!(kept.adjustment_xmp, original.adjustment_xmp);
    }
    assert_eq!(after.last().unwrap().action, "external");
}

#[test]
fn an_unmergeable_outside_change_is_refused_without_touching_the_file() {
    let mut photo = open(&sidecar(""));
    let split = sidecar(r#" crs:Clarity="5""#).replace(
        "    </rdf:Description>\n",
        "    </rdf:Description>\n    <rdf:Description rdf:about=\"\" xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" crs:Texture=\"9\"/>\n",
    );
    fs::write(photo.store.path(), &split).unwrap();
    let exposure = edit(&photo.document, Control::Exposure, 1.0);
    assert!(matches!(
        photo.store.save(&exposure),
        Err(SidecarError::Merge(_))
    ));
    assert_eq!(photo.sidecar(), split);
    assert_eq!(fs::read(&photo.original).unwrap(), ORIGINAL);
}
