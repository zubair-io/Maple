//! Portable accepted edit consumption through the actual CLI executable.
use raw_core::{export_recipe::ExportRecipe, types::accepted_removal::ContentDigest};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/removal/calibration"
);
fn stage() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    for (input, output) in [("source.dng", "photo.dng"), ("saved.xmp", "photo.xmp")] {
        fs::copy(
            Path::new(FIXTURE).join(input),
            directory.path().join(output),
        )
        .unwrap();
    }
    let assets = directory.path().join(".maple/inpaint");
    fs::create_dir_all(&assets).unwrap();
    for (name, suffix) in [("mask.mimf", "mask"), ("patch.f16", "f16")] {
        let bytes = fs::read(Path::new(FIXTURE).join(name)).unwrap();
        fs::write(
            assets.join(format!(
                "{}.{suffix}",
                ContentDigest::for_bytes(&bytes).hex()
            )),
            bytes,
        )
        .unwrap();
    }
    directory
}
fn run(directory: &Path, command: &str, output: &Path, options: &[&str]) -> Output {
    let mut cli = Command::new(env!("CARGO_BIN_EXE_maple-cli"));
    cli.arg(command)
        .arg(directory.join("photo.dng"))
        .arg("--params")
        .arg(directory.join("photo.xmp"));
    if command == "render" {
        cli.arg("--out").arg(output);
    } else {
        cli.arg("--recipe").arg(output);
    }
    cli.args(options).output().unwrap()
}
fn pixels(path: &Path) -> raw_core::raster::RasterImage {
    raw_core::raster::decode_raster(&fs::read(path).unwrap(), Some("png")).unwrap()
}
fn success(result: Output) {
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
#[test]
fn render_batch_and_recipe_keep_the_portable_saved_result_without_models() {
    let directory = stage();
    let root = directory.path();
    let original = fs::read(root.join("photo.dng")).unwrap();
    let sidecar = fs::read(root.join("photo.xmp")).unwrap();
    let expected = fs::read(Path::new(FIXTURE).join("preview-64.rgb")).unwrap();
    for demosaic in ["amaze", "full", "preview"] {
        let output = root.join(format!("{demosaic}.png"));
        success(run(root, "render", &output, &["--demosaic", demosaic]));
        let image = pixels(&output);
        if demosaic == "preview" {
            assert_eq!((image.width, image.height), (8, 4));
            assert!(
                image
                    .data
                    .chunks_exact(3)
                    .any(|rgb| rgb[2] > rgb[1] + 80 && rgb[1] > rgb[0] + 40),
                "the accepted blue patch must survive half-resolution development"
            );
        } else {
            assert_eq!((image.width, image.height), (16, 8));
            assert_eq!(image.data, expected);
        }
    }
    let output = root.join("p3.png");
    success(run(root, "render", &output, &["--target-primaries", "p3"]));
    assert_ne!(pixels(&output).data, expected);
    let recipe = root.join("recipe.json");
    fs::write(
        &recipe,
        serde_json::to_vec(&ExportRecipe {
            format: "png".into(),
            quality: None,
            max_long_edge: Some(4),
            destination: "directory".into(),
            directory: Some(root.join("exports").to_str().unwrap().into()),
            overwrite_policy: "error".into(),
            ..Default::default()
        })
        .unwrap(),
    )
    .unwrap();
    success(run(root, "export-recipe", &recipe, &[]));
    let image = pixels(&root.join("exports/photo.png"));
    assert_eq!((image.width, image.height), (4, 2));
    assert_eq!(
        image.data,
        fs::read(Path::new(FIXTURE).join("preview-4.rgb")).unwrap()
    );
    let manifest = root.join("manifest.json");
    fs::write(
        &manifest,
        serde_json::to_vec(&serde_json::json!({"cases":[{
            "raw":root.join("photo.dng"),"xmp":root.join("photo.xmp"),"name":"saved","outputs":[]
        }]}))
        .unwrap(),
    )
    .unwrap();
    success(
        Command::new(env!("CARGO_BIN_EXE_maple-cli"))
            .arg("batch")
            .arg("--manifest")
            .arg(manifest)
            .arg("--out-dir")
            .arg(root.join("batch"))
            .output()
            .unwrap(),
    );
    assert_eq!(pixels(&root.join("batch/saved.png")).data, expected);
    assert_eq!(fs::read(root.join("photo.dng")).unwrap(), original);
    assert_eq!(fs::read(root.join("photo.xmp")).unwrap(), sidecar);
}
#[test]
fn a_missing_saved_companion_is_a_failed_command_not_an_unedited_deliverable() {
    let directory = stage();
    let root = directory.path();
    fs::remove_dir_all(root.join(".maple/inpaint")).unwrap();
    let output = root.join("failed.png");
    let result = run(root, "render", &output, &[]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("saved companion"));
    assert!(!output.exists());
}
