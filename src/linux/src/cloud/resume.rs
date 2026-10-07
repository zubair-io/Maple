//! Edits a quit or crash left unsynchronized are pushed on the next connection.
use super::{CloudClient, CloudEntry, CloudError, EditJournal};
use crate::sidecar::SidecarStore;
use std::path::Path;

#[derive(Default)]
pub struct Resumed {
    pub synchronized: Vec<String>,
    pub unsynchronized: Vec<String>,
    /// The first journal still pending, held so the editor cannot move to
    /// another photograph until it is synchronized or reloaded.
    pub held: Option<EditJournal>,
}

pub fn resume_pending(base: &Path, client: &mut CloudClient) -> Result<Resumed, CloudError> {
    let server = client.server_url().to_owned();
    let mut resumed = Resumed::default();
    for entry in EditJournal::recorded_entries(base, &server)? {
        match resume(base, &server, &entry, client) {
            Ok(None) => {}
            Ok(Some(Ok(()))) => resumed.synchronized.push(entry.name),
            Ok(Some(Err((journal, error)))) => {
                resumed
                    .unsynchronized
                    .push(format!("{}: {error}", entry.name));
                resumed.held = resumed.held.or(Some(journal));
            }
            Err(error) => resumed
                .unsynchronized
                .push(format!("{}: {error}", entry.name)),
        }
    }
    Ok(resumed)
}

type Outcome = Option<Result<(), (EditJournal, CloudError)>>;

fn resume(
    base: &Path,
    server: &str,
    entry: &CloudEntry,
    client: &mut CloudClient,
) -> Result<Outcome, CloudError> {
    let mut journal = EditJournal::open(base, server, entry)?;
    if !journal.pending()? {
        return Ok(None);
    }
    let (_, document) = SidecarStore::open(&journal.path()?)
        .map_err(|error| CloudError::Protocol(error.to_string()))?;
    Ok(Some(
        journal
            .synchronize(client, &document)
            .map_err(|error| (journal, error)),
    ))
}
