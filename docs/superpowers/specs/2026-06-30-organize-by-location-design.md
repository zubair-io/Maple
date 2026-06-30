# Organize photos by location — move a photo into its `year/state/city` folder when its location is set

Ticket: #1671. Builds on the Batch Metadata Editor epic (#1575) and generalizes the M3 backup re-file (#1631).

## Problem

When a user sets or changes a photo's location in the batch metadata editor, nothing offers to put the photo where that location says it belongs. The only existing "move on location change" behavior (M3) was gated to backup-origin assets (those with `phasset_links`), so for an ordinary library photo — the common case — the offer never appeared. Users expect: _I gave this photo a location, let me file it under that location._

There is one file per photo. This feature relocates that file; it does not create copies.

## Behavior

After the user applies a metadata change in the batch panel, **if the edit touched any location-determining field** — the GPS coordinates _or_ any place-text field (city / state / country / country-code / sublocation) — the panel evaluates each affected photo for relocation and, when at least one would move, shows a single opt-in offer: **"Move N photo(s) into their location folders?"** with **Move** / **Skip** actions. (This widens the M3 trigger, which fired only on GPS change.) It reuses the panel's existing post-apply offer slot (the phase the M3 prompt used), now ungated.

A photo is offered for relocation when both hold:

- Its effective location resolves to a geo folder via the existing `backupLocationSegments` — i.e. at least a country or state is known (a bare lat/lon with no resolved place yields no folder and is not offered). Picking a result from the panel's address search populates the place text, so this is satisfied by the normal flow.
- That geo folder differs from the folder the file currently lives in (no prompt when the file is already in the right place).

Accepting **Move** relocates, for each qualifying photo, the photo file **and its `.xmp` sidecar together** into `<libraryRoot>/<year>/<State|Country>/<City>/`, where `<libraryRoot>` is the root of the photo's own registered library and the segments come from `backupLocationSegments` (the same layout the backup system already uses). Screenshots keep their existing `<year>/Screenshot` treatment.

The result is reported per batch: e.g. "4 moved, 1 skipped (name already in use was auto-renamed)". The offer is never automatic — declining leaves every file in place.

Scope is any selected photo whose location was set; there is no backup/mirror requirement. If a photo additionally has geo-organized backup copies, those continue to be relocated as before — the user does not interact with that.

## Architecture

The change generalizes the existing M3 server path rather than adding a parallel one.

- **Move machinery (reuse).** The crash-safe single-file relocation already exists (`moveBackupAsset`: copy companions into the new dir, verify each copied byte-for-byte, repoint the DB row between verify and delete, reset the per-path cache stages, then delete the source). It already moves the asset's primary file plus companions. This feature reuses it; the `.xmp` sidecar is treated as a companion so it moves with the photo.
- **Eligibility (change).** The `isGeoBackupCandidate` gate (which required `phasset_links`) is replaced by a general predicate: the photo has a resolvable place (`backupLocationSegments` non-empty, or the existing screenshot rule) **and** the target geo dir differs from the current dir (`geoDir(doc) !== primary.path`, the existing `wouldRelocate` shape). No `phasset_links` requirement.
- **Endpoints.** The existing `/api/backup/refile-count` and `/api/backup/refile` (address-based since #1668) are generalized to this predicate so they act on any asset. They are renamed to `/api/library/relocate-count` and `/api/library/relocate` to reflect that they relocate the primary file by location, not just backup copies; the old paths are removed (no external callers besides the panel). Both take `{ addresses: string[] }` and resolve via the existing `resolveAddress` jail.
- **Client.** The batch panel's post-apply flow calls the relocate-count endpoint when the location was set; if the count is > 0 it shows the offer, and **Move** calls the relocate endpoint. The browse-shell/service send the asset addresses (`a.id`). After a successful move the browse listing refreshes so the moved photos appear under their new folders.

## Data flow

1. User sets a location (address search → GPS + place text, or manual place text) and applies → sidecar written and `metadata_override.place_text` reconciled (existing M2/M3 path).
2. Panel calls `relocate-count(addresses)`. The server resolves each address, loads the doc, computes the target geo dir from the effective place, and counts those whose target differs from their current folder.
3. Count > 0 → panel shows the **Move N…** offer.
4. **Move** → `relocate(addresses)`. Per asset: compute target dir → relocate the primary file + `.xmp` sidecar into `<libraryRoot>/<targetDir>/`, auto-renaming on collision, crash-safely → repoint the DB `fileinfo` (path + filename) and therefore the photo's `slug:relPath` address → reset cache stages so thumbs/previews regenerate at the new path.
5. Browse refreshes; the photos now render under their location folders.

## Crash-safety and the non-destructive stance

This is the first feature that relocates a user's original file, which the project otherwise never does (load-bearing principle #1, "original files are never modified"). It is allowed here by explicit user request and is bounded to _relocation_ — the file's bytes are never altered; only its path changes. Safety is preserved by the existing copy → verify → repoint → delete ordering: the source is deleted only after the destination copy is verified and the DB repointed, so a crash at any point leaves the original intact and readable, never lost or half-written.

## Same-name collision → auto-rename

If the target folder already contains a file with the same name, the moved file (and its sidecar) get a numeric suffix: `photo.dng` → `photo-2.dng` (and `photo.xmp` → `photo-2.xmp`), incrementing until free. The DB row and address use the renamed name. Renames are reported in the per-batch result. The pre-existing file is never overwritten.

## Edge cases

- **No resolvable place** (bare coordinates, no city/state/country): not offered; nothing moves.
- **Already in the right folder**: not offered.
- **Library root not resolvable** for an asset: that asset is skipped with a per-asset error in the result; others proceed.
- **Partial batch failure**: per-asset results (moved / skipped / renamed / error); a single failure never aborts the batch and never leaves a half-moved file.
- **Address change**: because the file's `relPath` changes, its address changes; the response reports the moved photos so the client can refresh rather than hold stale addresses.

## Testing

- Server: a non-backup asset (no `phasset_links`) with a resolved place is counted and relocated into `<libraryRoot>/<year>/<state>/<city>/` with its sidecar; the DB path/address update; the source is gone and the destination verified. Collision → auto-rename (`-2`) for both file and sidecar; pre-existing file untouched. Already-in-place → count 0. No-place → count 0. Per-asset error isolation. Crash-safety ordering covered by the existing `moveBackupAsset` tests, extended for the non-backup + sidecar-companion + rename cases.
- Web: the panel offers **Move N…** after a location apply when count > 0 and not when 0; **Move** calls relocate and refreshes; **Skip** dismisses. Real-component specs (per #1616).

## Out of scope

- Re-organizing an entire library in bulk (this is per-edit, opt-in only).
- A configurable folder template (fixed to the existing `backupLocationSegments` layout; revisit if requested).
- Moving originals for assets whose location is read-only / not set in this edit.
