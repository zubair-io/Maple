#![cfg(feature = "test-support")]
use raw_core::{
    export_recipe::ExportRecipe, image::CfaPattern, test_support::synth_perf::SyntheticPerfDng,
};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

fn source(directory: &Path, name: &str) -> std::path::PathBuf {
    let source = directory.join(name);
    SyntheticPerfDng {
        width: 64,
        height: 48,
        cfa: CfaPattern::Rggb,
    }
    .write_to(&source)
    .unwrap();
    source
}
fn run(source: &Path, recipe: &ExportRecipe, xmp: Option<&Path>) -> Output {
    let recipe_path = source.with_extension("recipe.json");
    fs::write(&recipe_path, serde_json::to_vec(recipe).unwrap()).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_maple-cli"));
    command
        .arg("export-recipe")
        .arg(source)
        .arg("--recipe")
        .arg(recipe_path);
    if let Some(xmp) = xmp {
        command.arg("--params").arg(xmp);
    }
    command.output().unwrap()
}
fn recipe(directory: &Path) -> ExportRecipe {
    ExportRecipe {
        destination: "directory".into(),
        directory: Some(directory.to_str().unwrap().into()),
        overwrite_policy: "error".into(),
        format: "png".into(),
        quality: None,
        ..Default::default()
    }
}
fn success(output: Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn cli_consumes_saved_recipe_and_the_explicit_edit_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let source = source(dir.path(), "photo.dng");
    let original = fs::read(&source).unwrap();
    let out = dir.path().join("exports");
    let mut recipe = recipe(&out);
    success(run(&source, &recipe, None));
    let unedited = fs::read(out.join("photo.png")).unwrap();
    let xmp = dir.path().join("edit.xmp");
    fs::write(&xmp, r#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="1.4"/></rdf:RDF>"#).unwrap();
    recipe.naming_template = "{original}_{n}.{ext}".into();
    success(run(&source, &recipe, Some(&xmp)));
    assert_ne!(fs::read(out.join("photo_1.png")).unwrap(), unedited);
    assert_eq!(fs::read(&source).unwrap(), original);
}

#[test]
fn cli_error_skip_replace_policies_are_explicit_and_preserve_originals() {
    let dir = tempfile::tempdir().unwrap();
    let source = source(dir.path(), "photo.dng");
    let original = fs::read(&source).unwrap();
    let mut recipe = recipe(dir.path());
    let output_path = dir.path().join("photo.png");
    fs::write(&output_path, b"existing deliverable").unwrap();
    assert!(!run(&source, &recipe, None).status.success());
    recipe.overwrite_policy = "skip".into();
    let skipped = run(&source, &recipe, None);
    assert!(String::from_utf8_lossy(&skipped.stdout).contains("skipped:"));
    success(skipped);
    assert_eq!(fs::read(&output_path).unwrap(), b"existing deliverable");
    recipe.overwrite_policy = "replace".into();
    success(run(&source, &recipe, None));
    assert_eq!(&fs::read(&output_path).unwrap()[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(fs::read(&source).unwrap(), original);
}

#[test]
fn cli_refuses_an_output_that_is_the_original_even_with_replace() {
    let dir = tempfile::tempdir().unwrap();
    let source = source(dir.path(), "photo.png");
    let original = fs::read(&source).unwrap();
    let recipe = ExportRecipe {
        overwrite_policy: "replace".into(),
        ..recipe(dir.path())
    };
    let result = run(&source, &recipe, None);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("original"));
    assert_eq!(fs::read(&source).unwrap(), original);
}
