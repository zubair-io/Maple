# Release review: library, sources, imports, backup (Area 1)

Release v0.1.6, reviewed against `origin/main`. Code reading only; no suite was run.

No P0 was found in this area. Two P1 defects were filed.

| ID | Verdict | Findings |
|---|---|---|
| L1 | works (not deeply reviewed) | none |
| L2 | works with P1 | P1 [#5617](https://github.com/zubair-io/Maple/issues/5617), P2-3 |
| L3 | not reviewed | none |
| L4 | works with P2 | P2-1 |
| L5 | not reviewed | none |
| L6 | works | none |
| L7 | works with P1 | P1 [#5616](https://github.com/zubair-io/Maple/issues/5616) |
| L8 | works with P2 | P2-2 |
| L9 | not reviewed | none |

## P1

- **L7, retry drops a failed sidecar.** `src/api/src/db/repos/imports.retry.ts` resets a failed sidecar row to `pending` but keeps its image row `copied`. `ImportRunner.processImport` (`src/api/src/imports/worker.ts`, primary loop) ignores stored state, hashes the already-landed image, finds it in `assets`, and records the image and every sidecar `skipped_duplicate`. The sidecar is never copied and the import reports done. Source files are untouched. Issue #5616.
- **L2, stale bookmarks never refreshed.** `AppShell+FolderActions.swift` (`openSavedFolder`, sub-folder open) and `AppShell+SourceRestore.swift` read `bookmarkDataIsStale` and ignore it, so a stale bookmark stays in `SavedFolderStore` / `SourceSelectionStore` until it stops resolving. `restoreLastSource` then clears the saved selection, including when the cause is only an unmounted external volume. Issue #5617.

## P2

- **P2-1 (L4).** `SMBCredentialStore.keychainSet` deletes the existing Keychain item before adding the new one, so a failed add loses the saved password. The header comment says `kSecClassInternetPassword`; the code uses generic passwords.
- **P2-2 (L8).** `routes/backup-ingest.ts` trusts the client-supplied `X-Maple-Maple-Id` as the content identity and never re-hashes the assembled file. A mismatching id with different bytes is materialised as an extra location of the existing asset (the byte comparison only guards the "already on disk" short-circuit). Reachable only by an authenticated client.
- **P2-3 (L2).** `BookmarkStore.swift` is unused by the app target; its `restore()` deletes stale bookmarks. Dead code with a misleading contract.

## What was checked

- **L7:** `copy.ts` (temp sibling plus no-clobber publish, source never written), `dest.ts` (path-safety validators on every segment), the create route (jail to `MAPLE_ROOTS`, refuses a source inside the target library), the worker (dedup at the image, sidecar remap after a collision rename, cancel between files, lease heartbeat, terminal status rules).
- **L8 server:** chunk protocol (`backup-chunk.ts`: offset, length and tmp-size checks), ingest dedup and collision placement. **L8 Apple:** `BackupEngine.process` (Wi-Fi gate, busy-elsewhere, bounded retries persisted, companions never fail the photo).
- **L2/L4/L6:** bookmark resolution paths, SMB credential store, hosted workspace capability policy (single file and read-only folder download the XMP; writable folder writes the sibling).

## Not verified

L1 beyond file inventory, L3 (PhotoKit source), L5 (cloud source and `fs/root.ts`), L9 (cloud backup destinations), the macOS backup agent, the change watcher, and all runtime behaviour on device or in a browser. No tests were executed; the machine load average was above 40 during the review.
