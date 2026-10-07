//! The Linux writer against the shared on-disk sidecar fixtures
//! (docs/xmp-canonical-format.md § "Test contract").
use maple_linux::controls::Control;
use maple_linux::sidecar::SidecarDocument;
use std::{fs, path::PathBuf};

fn corpus() -> Vec<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test-fixtures");
    ["local-adjustments", "sidecars"]
        .iter()
        .filter_map(|directory| fs::read_dir(root.join(directory)).ok())
        .flatten()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "xmp"))
        .collect()
}

#[test]
fn every_shared_fixture_survives_an_unrelated_edit_and_resaves_as_a_fixed_point() {
    let fixtures = corpus();
    assert!(
        !fixtures.is_empty(),
        "the committed local-adjustment exports are always present"
    );
    for path in fixtures {
        let source = fs::read_to_string(&path).unwrap();
        let original = SidecarDocument::parse(&source)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        let mut edited = original.clone();
        Control::Exposure.set(&mut edited.model, 0.75).unwrap();
        let saved = edited.serialize().unwrap();
        let reread = SidecarDocument::parse(&saved).unwrap();
        let expected = {
            let mut model = original.model.clone();
            Control::Exposure.set(&mut model, 0.75).unwrap();
            model
        };
        assert_eq!(reread.model, expected, "{}", path.display());
        assert_eq!(reread.culling, original.culling, "{}", path.display());
        assert_eq!(reread.serialize().unwrap(), saved, "{}", path.display());
    }
}
