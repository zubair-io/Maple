# Fix #1666: Edit Metadata button silently does nothing (address-keyed assets)

## Problem

Modern browse assets use the slug:relPath addressing scheme, so `asset.id` looks like
`"photos:2026/France/IMG_0001.dng"`. The three batch-metadata endpoints
(`/api/metadata/snapshots`, `/api/xmp/batch`, `/api/backup/refile-count`,
`/api/backup/refile`) all accept absolute file paths. The browser-side
`onEditMetadata()` handler tries to recover absolute paths via
`this.state.absPathFor(a.id)` (reads a Map that is never populated) and
`a.absPath` (undefined on modern assets), so `paths` is always empty and the
handler returns early with no dialog shown.

## Fix

Move the path resolution to the server, where the slug-to-root mapping already
lives in memory (the libraries cache). The client sends `asset.id` (the address
string) to each endpoint; the server resolves it to an absolute path inside the
library jail before touching the filesystem or the DB.

## Server changes

`src/api/src/library/address.ts` gains two new exports that parse an address string
of the form `"slug:relPath"` into its components and resolve it to an absolute path.
`parseAddressString` splits on the first colon; `resolveAddressString` delegates to
the existing `resolveAddress` after the split. Both throw a `{status:400}` error
object if the string is malformed.

`src/api/src/routes/xmp-batch.ts` switches its per-entry body field from `path` to
`address`, resolves each address via `resolveAddressString`, and echoes `address`
(not an internal absolute path) in every result entry. Unknown or unauthorized
addresses produce a per-entry `ok:false` result so the batch continues rather than
aborting.

`src/api/src/routes/metadata-snapshots.ts` replaces the `{paths}` body with
`{addresses}`, resolves each via `resolveAddressString`, and returns each snapshot
keyed by `address`. Failed resolution returns `{address, metadata:{}}` so unknown
assets degrade gracefully.

`src/api/src/routes/backup-refile.ts` replaces `{paths}` with `{addresses}` on both
the `/api/backup/refile-count` and `/api/backup/refile` endpoints. Resolved absolute
paths are used only internally; all per-asset result entries echo the original
address string.

## Client changes

`batch-metadata.types.ts` renames the identifier field of `AssetMetadataSnapshot` and
`BatchApplyEntry` from `path` to `address`. `RefileItemResult` correspondingly
renames `path` to `address`. The pure `computeMixedValues` function is unaffected
because it reads only the `metadata` fields.

`batch-metadata.service.ts` updates every HTTP call to send `{addresses}` (not
`{paths}`) and to map response items by `address`. The `fetchSnapshots` signature
changes to `fetchSnapshots(addresses: string[])`.

`browse-shell.component.ts` replaces the broken `absPathFor` / `a.absPath` lookup in
`onEditMetadata()` with a direct map of `a.id` to `addresses`. The thin-fallback
path in the error handler uses the same `address: a.id` shape.

`batch-metadata-panel.component.ts` updates the two places that read `snap.path`
(the refile-count caller at line 344 and the refile caller at line 391) to read
`snap.address`.

## Tests

The existing `address.test.ts` file receives four new test cases for
`parseAddressString` (valid slug:relPath, empty relPath, malformed no-colon, empty
slug) and two for `resolveAddressString` (happy-path resolves, unknown slug returns
404).

API route test files (`xmp-batch.test.ts`, `metadata-snapshots.test.ts`,
`backup-refile.test.ts`) are updated to send `address` fields using the slug-based
in-memory cache setup from `address.test.ts`. A subset of new cases specifically
exercises resolution via the address string path.

Web tests (`batch-metadata.service.http.spec.ts`, `batch-metadata-panel.component.spec.ts`,
`batch-metadata-panel.geocode-refile.spec.ts`) are updated so all snapshot objects
use `address` instead of `path`. A new test in `browse-shell.component.spec.ts`
confirms that `onEditMetadata()` sets `batchMetaDialogVisible()` to true for
address-keyed assets, which is the regression that would have caught this bug.
