use raw_core::output_file::*;
use std::fs;

#[test]
fn missing_input_preserves_existing_output_validation() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out.png");
    fs::write(&out, b"old pixels").unwrap();
    let missing = dir.path().join("missing.xmp");
    validate_destination(&out, &[&missing]).unwrap();
    write_derived(&out, &[&missing], b"new pixels").unwrap();
    assert_eq!(fs::read(out).unwrap(), b"new pixels");
}

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
        let out = dir.path().join(format!("out.{ext}"));
        assert!(write_derived(&out, &[&source], b"pixels").is_err());
    }
    for out in [&source, &dir.path().join("./input.jpg"), &xmp] {
        assert!(write_derived(out, &[&source, &xmp], b"pixels").is_err());
    }
    assert_eq!(fs::read(source).unwrap(), b"original image");
    assert_eq!(fs::read(xmp).unwrap(), xml);
}

#[test]
fn refuses_extension_only_originals_and_unlisted_sidecars() {
    #[cfg(target_os = "linux")]
    use std::os::unix::ffi::OsStringExt;
    let dir = tempfile::tempdir().unwrap();
    let names = [".xmp", ".XmP", ".dng", ".DnG"].map(std::ffi::OsString::from);
    #[cfg(target_os = "linux")]
    let names = names.into_iter().chain([std::ffi::OsString::from_vec(vec![
        0xff, b'.', b'x', b'm', b'p',
    ])]);
    for name in names {
        let out = dir.path().join(&name);
        let original = b"existing original or sidecar";
        fs::write(&out, original).unwrap();
        assert!(write_derived(&out, &[], b"derived pixels").is_err());
        assert_eq!(fs::read(&out).unwrap(), original, "{name:?}");
        fs::remove_file(&out).unwrap();
        assert!(write_derived(&out, &[], b"derived pixels").is_err());
        assert!(!out.exists(), "{name:?}");
    }
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[cfg(any(unix, windows))]
#[test]
fn links_and_planted_fixed_temp_preserve_original_bytes() {
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("original.dng");
    let sidecar = dir.path().join("original.xmp");
    fs::write(&source, b"original").unwrap();
    fs::write(&sidecar, b"<x:xmpmeta xmlns:x='adobe:ns:meta/'/>").unwrap();
    for target in [&source, &sidecar] {
        let out = dir.path().join("alias.png");
        #[cfg(unix)]
        {
            symlink(target, &out).unwrap();
            assert!(write_derived(&out, &[&source, &sidecar], b"pixels").is_err());
            fs::remove_file(&out).unwrap();
        }
        fs::hard_link(target, &out).unwrap();
        assert!(validate_destination(&out, &[&source, &sidecar]).is_err());
        assert!(write_derived(&out, &[&source, &sidecar], b"pixels").is_err());
        fs::remove_file(out).unwrap();
    }
    #[cfg(unix)]
    {
        let out = dir.path().join("out.png");
        symlink(&source, dir.path().join("out.png.tmp")).unwrap();
        write_derived(&out, &[&source], b"pixels").unwrap();
        assert_eq!(fs::read(&out).unwrap(), b"pixels");
        fs::remove_file(dir.path().join("out.png.tmp")).unwrap();
        fs::hard_link(&source, dir.path().join("out.png.tmp")).unwrap();
        write_derived(&out, &[&source], b"replacement").unwrap();
        assert_eq!(fs::read(out).unwrap(), b"replacement");
    }
    assert_eq!(fs::read(source).unwrap(), b"original");
    assert_eq!(
        fs::read(sidecar).unwrap(),
        b"<x:xmpmeta xmlns:x='adobe:ns:meta/'/>"
    );
}

#[cfg(windows)]
#[test]
fn win32_trimmed_names_cannot_create_or_replace_protected_files() {
    use std::os::windows::ffi::OsStringExt;
    let dir = tempfile::tempdir().unwrap();
    let non_unicode = dir.path().join(std::ffi::OsString::from_wide(&[0xd800]));
    fs::create_dir(&non_unicode).unwrap();
    for (parent, names) in [
        (dir.path(), ["out.xmp.", "out.dng "]),
        (non_unicode.as_path(), ["out.xmp", "out.dng"]),
    ] {
        for name in names {
            let out = parent.join(name);
            let original = parent.join(name.trim_end_matches(['.', ' ']));
            assert!(write_derived(&out, &[], b"derived").is_err(), "{name}");
            assert!(!original.exists(), "{name}");
            fs::write(&original, b"original").unwrap();
            assert!(write_derived(&out, &[], b"derived").is_err(), "{name}");
            assert_eq!(fs::read(&original).unwrap(), b"original", "{name}");
        }
        assert_eq!(
            fs::read_dir(parent).unwrap().count(),
            2 + usize::from(parent == dir.path())
        );
    }
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

#[cfg(unix)]
#[test]
fn publication_reports_directory_sync_result() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out.png");
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o300)).unwrap();
    let can_sync = fs::File::open(dir.path())
        .and_then(|parent| parent.sync_all())
        .is_ok();
    let result = write_derived(&out, &[], b"complete pixels");
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        result.is_ok(),
        can_sync,
        "directory sync result must be reported"
    );
    assert_eq!(fs::read(&out).unwrap(), b"complete pixels");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn output_permissions_follow_process_umask() {
    use std::os::unix::fs::PermissionsExt;
    const CHILD: &str = "MAPLE_TEST_OUTPUT_PERMISSIONS_CHILD";
    if std::env::var_os(CHILD).is_some() {
        let dir = tempfile::tempdir().unwrap();
        let ordinary = dir.path().join("ordinary.png");
        let derived = dir.path().join("derived.png");
        fs::write(&ordinary, b"pixels").unwrap();
        write_derived(&derived, &[], b"pixels").unwrap();
        assert_eq!(
            derived.metadata().unwrap().permissions().mode() & 0o777,
            ordinary.metadata().unwrap().permissions().mode() & 0o777
        );
        return;
    }
    // Set umask before starting each test process, never in this threaded runner.
    for mask in ["022", "002", "077"] {
        let result = std::process::Command::new("sh")
            .args(["-c", &format!("umask {mask}; exec \"$1\" --exact output_permissions_follow_process_umask --nocapture"), "sh"])
            .arg(std::env::current_exe().unwrap())
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "umask {mask}: {}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
