use maple_linux::{
    cloud::{CloudEntry, DownloadedPhoto, EditJournal, RemoteXmp},
    controls::Control,
    sidecar::{SidecarDocument, SidecarStore},
};
use std::{fs, path::PathBuf};

fn entry() -> CloudEntry {
    CloudEntry {
        name: "photo.dng".into(),
        address: "library:photo.dng".into(),
        path: "/library/photo.dng".into(),
        ext: "dng".into(),
        id: None,
        size: include_bytes!("../../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng").len()
            as u64,
        mtime: "2026-10-06T00:00:00Z".into(),
        is_video: false,
        is_audio: false,
        is_stub: false,
    }
}
fn download() -> DownloadedPhoto {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("photo.dng");
    fs::write(
        &path,
        include_bytes!("../../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng"),
    )
    .unwrap();
    DownloadedPhoto {
        directory,
        path,
        document: SidecarDocument::default(),
        baseline: RemoteXmp {
            xml: None,
            etag: None,
            supports_preconditions: true,
        },
    }
}

#[test]
fn pending_edits_survive_reopen_and_cannot_be_replaced_by_a_new_download() {
    let base = tempfile::tempdir().unwrap();
    let remote = entry();
    let mut journal = EditJournal::open(base.path(), "https://photos.example/", &remote).unwrap();
    journal
        .prepare("https://photos.example/", &remote, download())
        .unwrap();
    let path = journal.path().unwrap();
    let before = fs::read(&path).unwrap();
    assert!(!journal.pending().unwrap());
    let (mut store, mut document) = SidecarStore::open(&path).unwrap();
    Control::Exposure.set(&mut document.model, 1.25).unwrap();
    store.save(&document).unwrap();
    assert!(journal.pending().unwrap());
    assert!(journal
        .prepare("https://photos.example/", &remote, download())
        .is_err());
    drop(journal);
    let reopened = EditJournal::open(base.path(), "https://photos.example/", &remote).unwrap();
    assert!(reopened.pending().unwrap());
    assert_eq!(
        SidecarStore::open(&reopened.path().unwrap())
            .unwrap()
            .1
            .model
            .exposure,
        1.25
    );
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn journal_excludes_other_editors_and_keeps_changed_original_pending_data() {
    let base = tempfile::tempdir().unwrap();
    let remote = entry();
    let mut journal = EditJournal::open(base.path(), "https://photos.example/", &remote).unwrap();
    journal
        .prepare("https://photos.example/", &remote, download())
        .unwrap();
    assert!(EditJournal::open(base.path(), "https://photos.example/", &remote).is_err());
    let path = journal.path().unwrap();
    let (mut store, mut document) = SidecarStore::open(&path).unwrap();
    Control::Exposure.set(&mut document.model, -1.0).unwrap();
    store.save(&document).unwrap();
    let xml = fs::read(path.with_extension("xmp")).unwrap();
    drop(journal);
    let mut changed = remote;
    changed.size += 1;
    assert!(EditJournal::open(base.path(), "https://photos.example/", &changed).is_err());
    assert_eq!(fs::read(path.with_extension("xmp")).unwrap(), xml);
}

#[test]
fn journal_refuses_a_symlink_in_place_of_the_owned_original() {
    let base = tempfile::tempdir().unwrap();
    let remote = entry();
    let mut journal = EditJournal::open(base.path(), "https://photos.example/", &remote).unwrap();
    journal
        .prepare("https://photos.example/", &remote, download())
        .unwrap();
    let path: PathBuf = journal.path().unwrap();
    let target = base.path().join("protected.dng");
    fs::write(&target, b"protected original").unwrap();
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&target, path).unwrap();
    assert!(journal.pending().is_err());
    assert_eq!(fs::read(target).unwrap(), b"protected original");
}
