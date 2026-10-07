use maple_linux::library::{Folder, MediaKind};
use std::fs;
use tempfile::TempDir;

#[test]
fn scans_real_folder_one_level_and_filters_sidecars_and_cache() {
    let temp = TempDir::new().unwrap();
    fs::create_dir(temp.path().join("child")).unwrap();
    fs::create_dir(temp.path().join(".maple")).unwrap();
    fs::write(temp.path().join("z.DNG"), b"raw").unwrap();
    fs::write(temp.path().join("a.jpg"), b"jpeg").unwrap();
    fs::write(temp.path().join("z.xmp"), b"sidecar").unwrap();
    fs::write(temp.path().join(".hidden.dng"), b"hidden").unwrap();
    fs::write(temp.path().join("child/inside.nef"), b"nested").unwrap();
    let folder = Folder::scan(temp.path()).unwrap();
    assert_eq!(folder.folders, vec![temp.path().join("child")]);
    assert_eq!(folder.photos.len(), 2);
    assert_eq!(folder.photos[0].path.file_name().unwrap(), "a.jpg");
    assert_eq!(folder.photos[0].kind, MediaKind::Raster);
    assert_eq!(folder.photos[1].kind, MediaKind::Raw);
    assert_eq!(folder.photos[1].size, 3);
    assert!(folder.errors.is_empty());
}

#[test]
fn inaccessible_or_missing_folder_is_an_error() {
    let temp = TempDir::new().unwrap();
    assert!(Folder::scan(&temp.path().join("absent")).is_err());
}

#[cfg(unix)]
#[test]
fn follows_browsable_symlinks_and_reports_broken_entries() {
    let temp = TempDir::new().unwrap();
    fs::create_dir(temp.path().join("target")).unwrap();
    fs::write(temp.path().join("target/photo.dng"), b"raw").unwrap();
    std::os::unix::fs::symlink(
        temp.path().join("target"),
        temp.path().join("linked-folder"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        temp.path().join("target/photo.dng"),
        temp.path().join("linked-photo.dng"),
    )
    .unwrap();
    std::os::unix::fs::symlink(temp.path().join("missing"), temp.path().join("broken.dng"))
        .unwrap();
    let folder = Folder::scan(temp.path()).unwrap();
    assert!(folder.folders.contains(&temp.path().join("linked-folder")));
    assert_eq!(folder.photos.len(), 1);
    assert_eq!(
        folder.photos[0].path.file_name().unwrap(),
        "linked-photo.dng"
    );
    assert_eq!(folder.errors.len(), 1);
}
