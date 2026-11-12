# Android documents provider

`MapleDocumentsProvider` (`src/android/app/src/main/java/app/justmaple/aperture/documents/`) puts Maple Cloud in the Android Files app and in every app's document picker (`ACTION_OPEN_DOCUMENT`, `ACTION_CREATE_DOCUMENT`, `ACTION_OPEN_DOCUMENT_TREE`). It is the Storage Access Framework counterpart of the Apple File Provider extensions and uses the same server contract (see [apple](apple.md) and [server-api](server-api.md)). The authority is `app.justmaple.aperture.documents`; the provider is exported behind `MANAGE_DOCUMENTS`, so only the system document UI binds to it and other apps receive per-document grants from the user's choice.

## Roots and documents

Each connected Maple Cloud or self-hosted server is one root titled **Maple Cloud**, with the server's host as its summary. Its children are the server's libraries (`GET /api/folders`, label as the name). Roots appear and disappear with sign-in and sign-out; the app tells the provider through `MapleDocumentsProvider.connectionsChanged`.

Document IDs are path-keyed like the unified listing, so a rename yields a new ID:

| ID                                        | Document                                         |
| ----------------------------------------- | ------------------------------------------------ |
| `<server>`                                | A connected server: its libraries                |
| `<server>/d/<library>/<slug>/<b64(path)>` | A folder; an empty path is the library root      |
| `<server>/f/<library>/<slug>/<b64(path)>` | A file (photo, video, sidecar or any other file) |

`<server>` is the app's connection ID, `<library>` the 24-hex library ID, `<slug>` its URL slug and `<b64(path)>` the library-relative path as unpadded base64url. Parsing rejects empty, `.`/`..` and hidden (dot-prefixed) segments, so no ID can reach `.maple/` data or leave its library. `isChildDocument` holds only within one server, library and path prefix, which is what `ACTION_OPEN_DOCUMENT_TREE` grants rely on.

## Browsing, opening and thumbnails

Folders list through `GET /api/folder/:slug/*` in 500-entry cursor pages (#4001/#4006). `folders` become directories; `images`, `files` and `sidecars` become files. Orphan `.xmp` files and hidden entries are not listed by the server and are not shown. MIME types follow the extension, with the same RAW types the app registers for `VIEW`/`SEND`.

`openDocument` in read mode first stats the file (`GET /api/folders/:id/file-meta`), then streams `GET /api/folders/:id/file` to a temporary file in 64 KiB chunks and publishes it into the download cache keyed by path, size and mtime. Nothing is buffered whole in memory, so 100 MP RAWs cost one disk copy. The client gets a regular, seekable read-only descriptor. Cancelling the `CancellationSignal` disconnects the socket mid-transfer, raises `OperationCanceledException` and keeps no partial file. A download whose length differs from the stat fails rather than publish mixed bytes.

`openDocumentThumbnail` serves the server's 512 px AVIF (`GET /api/thumb/:slug/*`) through the app's conditional cloud derivative cache, revalidated by ETag. Android 10/11 cannot decode AVIF, so the bounded AVIF is converted once by the core (`NativeBridge.cachePng`) into a private PNG. Only photos advertise thumbnails; videos and audio do not.

Every cache is bounded; [caching](caching.md#documents-provider-5836) lists keys, bounds and invalidation.

## What can be changed

Capabilities follow what the server allows, per item:

| Item                                          | Flags                     | Server route                                                                                          |
| --------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Library root                                  | create                    | —                                                                                                     |
| Folder                                        | create, rename            | `POST /api/folders/:id/mkdir`, `POST /api/folders/:id/move`                                           |
| Indexed photo or video                        | rename, delete, thumbnail | `POST /api/assets/:id/rename` (`collision: skip`), `DELETE /api/assets/:id?intent=trash`              |
| Photo or video the server has not indexed yet | thumbnail only            | —                                                                                                     |
| Other file                                    | write, rename, delete     | `POST /api/folders/:id/upload`, `POST /api/folders/:id/file/relocate`, `DELETE /api/folders/:id/file` |
| `.xmp` sidecar                                | read only                 | —                                                                                                     |

- **Originals are never modified.** Photos and videos are read-only; only ordinary files and new documents accept writes.
- **Deletes are always trash** (#4706). Photos use the intent-carrying asset delete, and a 409 `state: "trashed"` counts as success; the server moves paired sidecars with the photo. Other files move to the library's `.maple/trash`. There is no Trash container in the Files app, matching Apple.
- **Folders cannot be deleted.** `trash-folder` trashes only indexed assets and the server has no folder removal, so a delete would leave the folder in place. Folder delete is not advertised.
- **Photos rename through their asset**, so the paired sidecar follows. A photo the server has not indexed yet has no asset; renaming or deleting it through the plain-file route would separate it from its sidecar, so it is refused with "still indexing". Asset rename needs the server's native filename engine and fails closed (503) without it.
- **Sidecars are never replaced.** Existing `.xmp` files are read-only: Maple writes them only through its conditional XMP saves (#2532). A new `.xmp` created here uploads through the upload route, which answers 409 instead of replacing an existing sidecar; the provider then keeps the new bytes under the next free name (`edit (1).xmp`).

### Creating and writing

`createDocument` adds the MIME type's extension when the name has none and picks a free name with the platform's `name (1).ext` rule against the current listing. A folder is created at once. A file is staged in a durable pending-upload journal (`filesDir/documents-provider/uploads/`) and listed in its folder until the server accepts it. Writers get a descriptor on the staged file; when it closes cleanly the file uploads in the background (`POST /api/folders/:id/upload`, fixed length). Writing an existing ordinary file stages a copy (prefilled from the server unless the mode truncates); the upload replaces it and the server keeps the previous copy in Maple Trash.

SAF writers close before Maple can report a failure, so the journal keeps the bytes until the upload succeeds. An unreachable server, an expired session or a 5xx leaves the record for the next retry, which runs on folder listings and change-feed polls. Rejected uploads are kept and logged rather than deleted. Records are keyed by server origin, so signing out keeps them and reconnecting to the same server resumes them. A created document that no writer touches for a minute uploads as it is.

## Change notification

Cursors carry `setNotificationUri` for the folder, document or roots they describe. While the provider is in use, `CloudChangeFeed` polls `GET /api/changes` every 5 seconds per server; it stops after 10 minutes without provider activity, so background work stays bounded. The first poll adopts the journal head without replaying history. Each change row notifies its parent folder's children URI and the item's document URIs, resolving `folder_id` through the library list (refreshed when a row names an unknown library). Sidecar edits arrive as `update` rows on the photo (#4468) and notify the same way.

A 409 resumes from the server's `current` cursor, never 0, which would loop on a busy server. It also drops that server's cached metadata and notifies every document of the provider, so open folders list again. The cursor is stored per server in the `maple-documents` preferences and removed on sign-out.

The server sends push wakes only through APNs and the app has no Firebase Cloud Messaging, so the provider has no push wake.

## Authentication

The provider uses the app's stored credentials (`CloudCredentials`, Android Keystore) and its `CloudHttp` client. An expired access token refreshes once and retries. Refresh tokens rotate on every use and the app and provider hold separate clients, so refresh and logout share one process-wide lane: two clients never spend the same refresh token. Rotation saves only that server's new tokens.

A document of a server that is no longer connected, a 401 after refresh, a 403, a network failure or any non-success listing raises an exception (`FileNotFoundException` for 404, otherwise `IllegalStateException` with the server's message). A failed or signed-out listing is never an empty folder (#4757). Sign-out removes only that server's credentials, download cache, metadata and change cursor; other servers, app sources, private sidecars and pending uploads are untouched (#4716).

## Local folder libraries

Local folder libraries are document trees the user granted from another provider, which already shows them in the Files app and pickers. The provider does not re-export them: that would list them twice and proxy another provider's grants to new callers, widening access.

## Tests

- `CloudDocumentContractTest` (JVM): document ID round trips, traversal and hidden-segment rejection, tree membership, capability flags, MIME and collision naming, and the change-feed cursor rules (head adoption, notification, 409 recovery to `current`, sign-out).
- `CloudDocumentsProviderTest` and `CloudDocumentsWriteTest` (device): run against a real, disposable Maple API through `src/android/scripts/with-cloud-api.sh`, which boots `src/api` with a fresh SQLite database and library, `MAPLE_DEV_AUTH=1`, and `adb reverse`. They cover roots and tree grants, RAW/JPEG byte-exact opens, thumbnails, mid-transfer cancellation, read-only originals and sidecars, create/write/upload, rename, trash, the never-replace-a-sidecar race, change-feed notification of an external upload, token rotation, and sign-out and unreachable servers as errors.

```bash
cd src/android
scripts/with-cloud-api.sh ./gradlew connectedDebugAndroidTest   # a booted emulator or device
./gradlew testDebugUnitTest --tests 'app.justmaple.aperture.documents.*'
```

Without the server's native library (`src/api/native/libraw_ffi.*`) the server cannot render thumbnails or validate asset renames. The harness then stages fresh shared-cache thumbnails for its fixtures, and the write test asserts that the photo rename fails closed instead of succeeding. CI runs this way. Locally, build the library with `src/api/scripts/build-raw-ffi.sh` to exercise real thumbnail generation and photo renames.

The system Files app UI (DocumentsUI rendering, the picker, the progress UI for long downloads) and physical-device storage behaviour are not covered by automated tests.
