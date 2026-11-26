//! `maple_export_recipe_pair_to_files` against `maple_export_recipe_to_file`
//! as the oracle: the same bytes per recipe, and a second render that fails
//! without disturbing the first.

use crate::export_recipe::maple_export_recipe_to_file;
use crate::export_recipe_pair::maple_export_recipe_pair_to_files;
use raw_core::export_recipe::ExportRecipe;
use raw_core::image::CfaPattern;
use raw_core::test_support::synth_perf::SyntheticPerfDng;
use std::ffi::CString;
use std::path::{Path, PathBuf};

fn xmp(settings: &str) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" {settings}/></rdf:RDF></x:xmpmeta>"#
    )
}

fn raw_edit() -> String {
    xmp(r#"crs:Exposure2012="0.8" crs:Contrast2012="20""#)
}

fn c(text: &str) -> CString {
    CString::new(text).unwrap()
}

fn jpeg_recipe(max_long_edge: u32) -> String {
    serde_json::to_string(&ExportRecipe {
        quality: Some(90),
        max_long_edge: Some(max_long_edge),
        ..Default::default()
    })
    .unwrap()
}

fn synthetic_raw(directory: &Path) -> PathBuf {
    let path = directory.join("source.dng");
    SyntheticPerfDng {
        width: 192,
        height: 128,
        cfa: CfaPattern::Rggb,
    }
    .write_to(&path)
    .unwrap();
    path
}

fn single(source: &Path, edit: &str, recipe: &str, output: &Path) -> i32 {
    unsafe {
        maple_export_recipe_to_file(
            c(source.to_str().unwrap()).as_ptr(),
            c(edit).as_ptr(),
            c(recipe).as_ptr(),
            std::ptr::null(),
            c(output.to_str().unwrap()).as_ptr(),
        )
    }
}

fn pair(source: &Path, edit: &str, first: (&str, &Path), second: (&str, &Path)) -> i32 {
    unsafe {
        maple_export_recipe_pair_to_files(
            c(source.to_str().unwrap()).as_ptr(),
            c(edit).as_ptr(),
            std::ptr::null(),
            c(first.0).as_ptr(),
            c(first.1.to_str().unwrap()).as_ptr(),
            c(second.0).as_ptr(),
            c(second.1.to_str().unwrap()).as_ptr(),
        )
    }
}

fn assert_pair_matches_two_single_renders(source: &Path, edit: &str, directory: &Path) {
    let (small, large) = (jpeg_recipe(48), jpeg_recipe(96));
    let oracle = [directory.join("single-48"), directory.join("single-96")];
    assert_eq!(single(source, edit, &small, &oracle[0]), 0);
    assert_eq!(single(source, edit, &large, &oracle[1]), 0);
    let paired = [directory.join("pair-48"), directory.join("pair-96")];
    assert_eq!(
        pair(source, edit, (&small, &paired[0]), (&large, &paired[1])),
        0,
        "pair render failed"
    );
    let bytes = |path: &PathBuf| std::fs::read(path).unwrap();
    assert_eq!(bytes(&paired[0]), bytes(&oracle[0]));
    assert_eq!(bytes(&paired[1]), bytes(&oracle[1]));
    assert_ne!(bytes(&paired[0]), bytes(&paired[1]));
}

#[test]
fn raw_pair_writes_the_bytes_of_two_single_renders() {
    let root = tempfile::tempdir().unwrap();
    let source = synthetic_raw(root.path());
    let original = std::fs::read(&source).unwrap();
    assert_pair_matches_two_single_renders(&source, &raw_edit(), root.path());
    assert_eq!(std::fs::read(&source).unwrap(), original);
}

#[test]
fn baked_raster_pair_writes_the_bytes_of_two_single_renders() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.png");
    image::RgbImage::from_fn(160, 120, |x, y| {
        image::Rgb([(x * 3 % 255) as u8, (y * 5 % 255) as u8, 91])
    })
    .save(&source)
    .unwrap();
    assert_pair_matches_two_single_renders(&source, &xmp(r#"crs:Exposure2012="1""#), root.path());
}

#[test]
fn a_failed_second_render_leaves_the_first_file_complete() {
    let root = tempfile::tempdir().unwrap();
    let source = synthetic_raw(root.path());
    let (small, large) = (jpeg_recipe(48), jpeg_recipe(96));
    let oracle = root.path().join("single-48");
    assert_eq!(single(&source, &raw_edit(), &small, &oracle), 0);

    let first = root.path().join("unwritable-second");
    let missing_directory = root.path().join("absent").join("second");
    assert_eq!(
        pair(
            &source,
            &raw_edit(),
            (&small, &first),
            (&large, &missing_directory)
        ),
        101
    );
    assert_eq!(
        std::fs::read(&first).unwrap(),
        std::fs::read(&oracle).unwrap()
    );
    assert!(!missing_directory.exists());

    let first = root.path().join("invalid-second-recipe");
    let second = root.path().join("never-written");
    assert_eq!(
        pair(&source, &raw_edit(), (&small, &first), ("{}", &second)),
        101
    );
    assert_eq!(
        std::fs::read(&first).unwrap(),
        std::fs::read(&oracle).unwrap()
    );
    assert!(!second.exists());
}

#[test]
fn a_failed_first_render_writes_nothing() {
    let root = tempfile::tempdir().unwrap();
    let source = synthetic_raw(root.path());
    let (small, large) = (jpeg_recipe(48), jpeg_recipe(96));
    let outputs = [root.path().join("first"), root.path().join("second")];

    let unreadable = root.path().join("absent.dng");
    assert_eq!(
        pair(
            &unreadable,
            &raw_edit(),
            (&small, &outputs[0]),
            (&large, &outputs[1])
        ),
        1
    );
    assert_eq!(
        pair(
            &source,
            &raw_edit(),
            ("{}", &outputs[0]),
            (&large, &outputs[1])
        ),
        1
    );
    std::fs::write(&outputs[0], b"occupied").unwrap();
    assert_eq!(
        pair(
            &source,
            &raw_edit(),
            (&small, &outputs[0]),
            (&large, &outputs[1])
        ),
        1
    );
    assert_eq!(std::fs::read(&outputs[0]).unwrap(), b"occupied");
    assert!(!outputs[1].exists());
}
