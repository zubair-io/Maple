use raw_core::raster::{decode_raster, RasterImage};
use std::{fs, path::Path, process::Command};

fn source(directory: &Path) -> std::path::PathBuf {
    let path = directory.join("source.png");
    fs::write(
        &path,
        raw_core::png::encode(40, 20, &vec![255, 0, 0].repeat(40 * 20)).unwrap(),
    )
    .unwrap();
    path
}

fn resize(directory: &Path, fit: Option<&str>) -> RasterImage {
    let input = source(directory);
    let original = fs::read(&input).unwrap();
    let output = directory.join("result.png");
    let mut command = Command::new(env!("CARGO_BIN_EXE_maple-cli"));
    command
        .arg("resize")
        .arg(&input)
        .arg("--out")
        .arg(&output)
        .args(["--width", "10", "--height", "10"]);
    if let Some(fit) = fit {
        command.args(["--fit", fit]);
    }
    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(fs::read(input).unwrap(), original);
    decode_raster(&fs::read(output).unwrap(), Some("png")).unwrap()
}

#[test]
fn all_five_fits_produce_their_requested_dimensions() {
    for (fit, dimensions) in [
        ("inside", (10, 5)),
        ("fill", (10, 10)),
        ("cover", (10, 10)),
        ("contain", (10, 10)),
        ("outside", (20, 10)),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let result = resize(directory.path(), Some(fit));
        assert_eq!((result.width, result.height), dimensions, "{fit}");
    }
}

#[test]
fn contain_pads_the_image_instead_of_stretching_it() {
    let directory = tempfile::tempdir().unwrap();
    let result = resize(directory.path(), Some("contain"));
    assert_eq!((result.width, result.height), (10, 10));
    let pixel = |x: usize, y: usize| {
        let offset = (y * result.width as usize + x) * result.channels as usize;
        &result.data[offset..offset + 3]
    };
    assert_eq!(pixel(5, 0), &[0, 0, 0]);
    assert_eq!(pixel(5, 5), &[255, 0, 0]);
    assert_eq!(pixel(5, 9), &[0, 0, 0]);
}

#[test]
fn omitted_fit_still_defaults_to_inside() {
    let directory = tempfile::tempdir().unwrap();
    let result = resize(directory.path(), None);
    assert_eq!((result.width, result.height), (10, 5));
}

#[test]
fn fit_names_remain_case_insensitive() {
    let directory = tempfile::tempdir().unwrap();
    let result = resize(directory.path(), Some("OuTsIdE"));
    assert_eq!((result.width, result.height), (20, 10));
}

#[test]
fn unknown_fit_fails_without_overwriting_the_output() {
    let directory = tempfile::tempdir().unwrap();
    let input = source(directory.path());
    let original = fs::read(&input).unwrap();
    let output = directory.path().join("result.png");
    fs::write(&output, b"existing output").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_maple-cli"))
        .arg("resize")
        .arg(&input)
        .arg("--out")
        .arg(&output)
        .args(["--width", "10", "--height", "10", "--fit", "squash"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    let message = String::from_utf8_lossy(&result.stderr);
    assert!(message.contains("unknown resize fit 'squash'"), "{message}");
    for valid in ["inside", "fill", "cover", "contain", "outside"] {
        assert!(message.contains(valid), "{message}");
    }
    assert_eq!(fs::read(output).unwrap(), b"existing output");
    assert_eq!(fs::read(input).unwrap(), original);
}
