//! Cross-process qualification against real Maple XMP routes and files (#4317).
//! Browser auth/Secret Service are not qualified: only their test fixtures run.
use maple_linux::{
    cloud::{CloudClient, CloudEntry, CloudError, EditJournal, Server},
    controls::Control,
    sidecar::{SidecarDocument, SidecarStore},
};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
};

struct Fixture(Child);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bun = std::env::args_os().nth(1).unwrap_or_else(|| "bun".into());
    let root = tempfile::tempdir()?;
    let original = root.path().join("photo.dng");
    let raw = include_bytes!("../../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
    std::fs::write(&original, raw)?;
    let fixture_script =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("examples/cloud-fixture.ts");
    let mut fixture = Fixture(
        Command::new(bun)
            .arg(fixture_script)
            .arg(root.path())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?,
    );
    let stdout = fixture.0.stdout.take().ok_or("Fixture stdout missing")?;
    let line = BufReader::new(stdout)
        .lines()
        .take(20)
        .find_map(|line| {
            line.ok()
                .and_then(|line| line.strip_prefix("MAPLE_FIXTURE_URL ").map(str::to_owned))
        })
        .ok_or("Fixture did not publish its URL")?;
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let mut client = CloudClient::new(Server::parse(&line)?)?;
    client.probe()?;
    let (pending, _) = client.begin_sign_in()?;
    assert!(client.claim(&pending)?);
    let entry = CloudEntry {
        name: "photo.dng".into(),
        address: "library:photo.dng".into(),
        path: original.display().to_string(),
        id: None,
        ext: "dng".into(),
        size: raw.len() as u64,
        mtime: String::new(),
        is_video: false,
        is_audio: false,
        is_stub: false,
    };
    let mut downloaded = client.download_for_edit(&entry)?;
    assert_eq!(std::fs::read(&downloaded.path)?, raw);
    assert!(downloaded.baseline.xml.is_none());
    Control::Exposure.set(&mut downloaded.document.model, 1.25)?;
    let saved =
        client.save_versioned_xmp(&entry.path, &downloaded.document, &downloaded.baseline)?;
    let sidecar = original.with_extension("xmp");
    let server_xml = std::fs::read_to_string(&sidecar)?;
    assert_eq!(SidecarDocument::parse(&server_xml)?.model.exposure, 1.25);
    assert_eq!(saved.xml.as_deref(), Some(server_xml.as_str()));
    let external = server_xml.replace("Exposure2012=\"1.25\"", "Exposure2012=\"2.00\"");
    assert_ne!(external, server_xml);
    std::fs::write(&sidecar, &external)?;
    Control::Exposure.set(&mut downloaded.document.model, -1.0)?;
    assert!(matches!(
        client.save_versioned_xmp(&entry.path, &downloaded.document, &saved),
        Err(CloudError::Conflict)
    ));
    assert_eq!(std::fs::read_to_string(&sidecar)?, external);
    assert_eq!(downloaded.document.model.exposure, -1.0);
    let mut wrong_size = entry.clone();
    wrong_size.size += 1;
    assert!(client.download_for_edit(&wrong_size).is_err());
    let current = client.read_versioned_xmp(&entry.path)?;
    let fresh = SidecarDocument::parse(current.xml.as_deref().ok_or("No XMP")?)?;
    assert_eq!(fresh.model.exposure, 2.0);
    let reopened = client.download_for_edit(&entry)?;
    assert_eq!(reopened.document.model.exposure, 2.0);
    let journal_root = tempfile::tempdir()?;
    let mut journal = EditJournal::open(journal_root.path(), &line, &entry)?;
    journal.prepare(&line, &entry, client.download_for_edit(&entry)?)?;
    let local = journal.path()?;
    let (mut store, mut document) = SidecarStore::open(&local)?;
    Control::Exposure.set(&mut document.model, 0.75)?;
    store.save(&document)?;
    assert!(journal.pending()?);
    journal.synchronize(&mut client, &document)?;
    assert!(!journal.pending()?);
    let acknowledged = std::fs::read_to_string(&sidecar)?;
    let external_again = acknowledged.replace("Exposure2012=\"0.75\"", "Exposure2012=\"3.00\"");
    assert_ne!(external_again, acknowledged);
    std::fs::write(&sidecar, &external_again)?;
    Control::Exposure.set(&mut document.model, -2.0)?;
    store.save(&document)?;
    assert!(matches!(
        journal.synchronize(&mut client, &document),
        Err(CloudError::Conflict)
    ));
    assert!(journal.pending()?);
    drop(journal);
    let mut resumed = EditJournal::open(journal_root.path(), &line, &entry)?;
    assert!(resumed.pending()?);
    assert_eq!(SidecarStore::open(&local)?.1.model.exposure, -2.0);
    assert_eq!(std::fs::read_to_string(&sidecar)?, external_again);
    resumed.reload(&mut client)?;
    assert!(!resumed.pending()?);
    assert_eq!(SidecarStore::open(&local)?.1.model.exposure, 3.0);
    assert_eq!(std::fs::read(&local)?, raw);
    assert_eq!(std::fs::read(original)?, raw);
    println!("Cloud transaction passed: real RAW download, conditional save, conflict preservation, truncated-download rejection, durable resume, explicit reload and unchanged originals.");
    Ok(())
}
