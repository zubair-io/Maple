use raw_core::output_file::*;
use std::fs;

#[test]
fn refuses_original_extensions_and_canonical_inputs() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("input.jpg");
    let xmp = dir.path().join("snapshot.data");
    fs::write(&source, b"original image").unwrap();
    let xml = b"<x:xmpmeta xmlns:x='adobe:ns:meta/'/>";
    fs::write(&xmp, xml).unwrap();
    for ext in rawler::decoders::supported_extensions()
        .iter()
        .chain(["XmP"].iter())
    {
        assert!(write_derived(
            &dir.path().join(format!("out.{ext}")),
            &[&source],
            b"pixels"
        )
        .is_err());
    }
    for out in [&source, &dir.path().join("./input.jpg"), &xmp] {
        assert!(write_derived(out, &[&source, &xmp], b"pixels").is_err());
    }
    assert_eq!(fs::read(source).unwrap(), b"original image");
    assert_eq!(fs::read(xmp).unwrap(), xml);
}

#[cfg(unix)]
#[test]
fn links_and_planted_fixed_temp_preserve_original_bytes() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("original.dng");
    let sidecar = dir.path().join("original.xmp");
    fs::write(&source, b"original").unwrap();
    fs::write(&sidecar, b"<x:xmpmeta xmlns:x='adobe:ns:meta/'/>").unwrap();
    for target in [&source, &sidecar] {
        let out = dir.path().join("alias.png");
        symlink(target, &out).unwrap();
        assert!(write_derived(&out, &[&source, &sidecar], b"pixels").is_err());
        fs::remove_file(&out).unwrap();
        fs::hard_link(target, &out).unwrap();
        assert!(write_derived(&out, &[&source, &sidecar], b"pixels").is_err());
        fs::remove_file(out).unwrap();
    }
    let out = dir.path().join("out.png");
    symlink(&source, dir.path().join("out.png.tmp")).unwrap();
    write_derived(&out, &[&source], b"pixels").unwrap();
    assert_eq!(fs::read(&out).unwrap(), b"pixels");
    fs::remove_file(dir.path().join("out.png.tmp")).unwrap();
    fs::hard_link(&source, dir.path().join("out.png.tmp")).unwrap();
    write_derived(&out, &[&source], b"replacement").unwrap();
    assert_eq!(fs::read(out).unwrap(), b"replacement");
    assert_eq!(fs::read(source).unwrap(), b"original");
    assert_eq!(
        fs::read(sidecar).unwrap(),
        b"<x:xmpmeta xmlns:x='adobe:ns:meta/'/>"
    );
}

#[test]
fn concurrent_publications_are_complete_and_leave_no_staging_files() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out.png");
    std::thread::scope(|scope| {
        for byte in 0..16 {
            let out = &out;
            scope.spawn(move || write_derived(out, &[], &vec![byte; 4096]).unwrap());
        }
    });
    let result = fs::read(&out).unwrap();
    assert_eq!(result.len(), 4096);
    assert!(result.iter().all(|b| *b == result[0]));
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn failed_publication_cleans_up_owned_staging_file() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out.png");
    fs::create_dir(&out).unwrap();
    assert!(write_derived(&out, &[], b"pixels").is_err());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}
