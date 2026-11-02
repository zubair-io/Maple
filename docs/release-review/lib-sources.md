# Release review: library, sources, imports, backup (Area 1)

Release v0.1.6, reviewed against `origin/main`. Code reading only; the one fix has a focused test.

One P0 was found and fixed (L7, PR #5634). It was first filed as a P1; it is a P0 because the retry the operator uses to recover a failed sidecar copy reports success while the library permanently lacks the sidecar, and the sidecar is the record of the user's edits.

| ID  | Verdict       | Findings                                                                                                                                                                                |
| --- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | works with P2 | P2-5                                                                                                                                                                                    |
| L2  | works with P1 | P1 [#5617](https://github.com/zubair-io/Maple/issues/5617), P2-3                                                                                                                        |
| L3  | works         | none; no Photos write APIs are used anywhere in the Apple sources                                                                                                                       |
| L4  | works with P2 | P2-1                                                                                                                                                                                    |
| L5  | works with P2 | P2-4                                                                                                                                                                                    |
| L6  | works         | none                                                                                                                                                                                    |
| L7  | broken, fixed | P0 [#5616](https://github.com/zubair-io/Maple/issues/5616) / PR [#5634](https://github.com/zubair-io/Maple/pull/5634); P1 [#5635](https://github.com/zubair-io/Maple/issues/5635); P2-6 |
| L8  | works with P2 | P2-2                                                                                                                                                                                    |
| L9  | works with P2 | P2-7                                                                                                                                                                                    |

## P0

- **L7, retry drops a failed sidecar (#5616, fixed in #5634).** `src/api/src/db/repos/imports.retry.ts` resets a failed sidecar row to `pending` but keeps its image row `copied`. `ImportRunner.processImport` (`src/api/src/imports/worker.ts`, primary loop) ignored stored state, hashed the already-landed image, found it in `assets`, and recorded the image and every sidecar `skipped_duplicate`. Failing scenario: the import copies `IMG.dng`, the copy of `IMG.xmp` fails, the import ends `done` with one failure, the operator fixes the cause and retries, and the import now reports a clean success while the library has no `IMG.xmp`. The fix treats a stored-`copied` primary as landed and copies only its pending sidecars.

## P1

- **L7, movies are not content-deduplicated (#5635).** Only images are hashed and checked against `assets`. A movie is skipped only when its computed destination already holds identical bytes, and that destination includes the source folder name. Importing the same card from a differently named folder copies every movie again.
- **L2, stale bookmarks never refreshed (#5617).** `AppShell+FolderActions.swift` (`openSavedFolder`, sub-folder open) and `AppShell+SourceRestore.swift` read `bookmarkDataIsStale` and ignore it, so a stale bookmark stays saved until it stops resolving. `restoreLastSource` then clears the saved selection, including when the cause is only an unmounted external volume.

## P2

- **P2-1 (L4).** `SMBCredentialStore.keychainSet` deletes the existing Keychain item before adding the new one, so a failed add loses the saved password. The header comment says `kSecClassInternetPassword`; the code uses generic passwords.
- **P2-2 (L8).** `routes/backup-ingest.ts` trusts the client-supplied `X-Maple-Maple-Id` as the content identity and never re-hashes the assembled file. A mismatching id with different bytes is stored as an extra location of the existing asset. Reachable only by an authenticated client.
- **P2-3 (L2).** `BookmarkStore.swift` is unused by the app target; its `restore()` deletes stale bookmarks. Dead code with a misleading contract.
- **P2-4 (L5).** `CloudSource.videoURL` and `motionClipURL` put the access token in the URL query string so the player can fetch without headers. The token can land in server access logs.
- **P2-5 (L1).** The import scanner treats audio and stub extensions (`.mp3`, `.eip`, `.braw`) as `image` kind, so they are hashed and handed to the indexer as images. Only the classification was read, not what the indexer does with them.
- **P2-6 (L7).** A collision-renamed primary is recorded with its new destination, but its sidecar keeps the old name until it is copied. If the process dies in between, regrouping on reclaim no longer pairs them and the sidecar is dropped. Rare, and the source still holds it.
- **P2-7 (L9).** `routes/cloud-backup.ts` `validateMirror` compares the mirror's real path to library paths resolved lexically (`path.resolve`), so a library registered through a symlink can be overlapped by a mirror that the check was meant to refuse.

## What was checked

- **L7:** `copy.ts` (temp sibling plus no-clobber publish, source never written), `dest.ts` (path-safety validators on every segment), the create route (jail to `MAPLE_ROOTS`, refuses a source inside the target library), the worker (dedup at the image, sidecar remap after a collision rename, cancel between files, lease heartbeat, terminal status rules), and retry.
- **L8 server:** chunk protocol (`backup-chunk.ts`: offset, length and tmp-size checks), ingest dedup and collision placement. **L8 Apple:** `BackupEngine.process` (Wi-Fi gate, busy-elsewhere, bounded retries persisted, companions never fail the photo) and the macOS agent entry point (single-engine lock, stop and settings re-check, shared state and device id with the app).
- **L1:** the extension allowlists in `workers/discover/types.ts` and `fs/browse.ts` classification of video, stub and audio kinds.
- **L2:** bookmark resolution paths and `FolderChangeWatcher` (debounced child changes, self-invalidation when the folder is removed, renamed or revoked, `stop()` safe from the event queue).
- **L3:** PhotoKit sources never call any Photos change-request API; edits persist to the App Support XMP keyed by local identifier.
- **L4/L6:** SMB credential store, hosted workspace capability policy (single file and read-only folder download the XMP; writable folder writes the sibling).
- **L5:** `CloudSource` reads and downloads, with sidecar writes routed to `CloudSidecarStore`. The server path jail in `fs/root.ts` was read only in part.
- **L9:** destination create, update and delete guards, restore preview then job, and the recovery restore refusing to overwrite (exclusive link publish).

## Not verified

- `fs/root.ts` mirror and alias handling beyond the first 200 lines, the Google Drive provider, and the `cloud-backup/` engine and purge internals.
- The client-side decoders for L1 and the full PhotoKit catalog code.
- All runtime behaviour on device or in a browser. The machine load average was above 40 during the review, so no broad suites were run; the focused worker test passes, and the repo-wide `EXIF capture time` test failure in `src/imports` is pre-existing.
