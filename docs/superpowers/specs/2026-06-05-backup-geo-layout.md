# Backup folders by geography + relocation migration — design

> **Superseded (2026-06-18)** by
> `docs/superpowers/specs/2026-06-18-refile-backups-migration.md`. The
> `restructure-backup-geo` migration described here gated re-work on a one-way
> `backup_layout_version` stamp that could freeze an asset stamped on a no-op
> before its geocode resolved. It (and `restructure-backup-folders` /
> `restructure-backup-screenshots`) was replaced by the single self-checking
> `refile-backups` cleanup. The geo path-derivation logic below
> (`backupLocationSegments`) is unchanged and still in use.

Brainstormed 2026-06-05. Follows the #744 work in
`docs/superpowers/specs/2026-05-31-backup-layout-and-migration-worker.md`
(the day-folder drop + the generic Migration worker), which this builds on.

Two related changes to the device-backup ("iPhone backup") library layout:

1. Replace the single location segment with a **geographic two-level** layout
   for **new** backups.
2. Ship a second **Migration** (in the existing migration worker / registry) that
   re-files already-backed-up photos into the new layout.

---

## Part 1 — New backup folder structure

`formatBackupPath` (TS) / `PathFormatter.format` (Swift) — the byte-parity pair.

|                  | Old (#744)            | New                                                  |
| ---------------- | --------------------- | ---------------------------------------------------- |
| With location    | `<year>/<loc>/<file>` | `<year>/<State or Country>/<Town/City‖Place>/<file>` |
| Without location | `<year>/<MM>/<file>`  | `<year>/<MM>/<file>` (unchanged)                     |

Where:

- **Top segment** — the US **State** (full name, e.g. `California`) when the
  photo is in the USA, otherwise the **Country** (full name, e.g. `France`).
  "USA" is decided by the ISO 3166-1 country code (`us`, stored lowercased on
  the `Place`). If the USA branch has no state (or the foreign branch no
  country), it cross-falls-back to the other so a sparse geocode still produces
  a folder.
- **Second segment** — the **Town/City** (the locality rollup) when known,
  otherwise the nearest **Place Name** (first POI). "Town/City ‖ Place Name".
- The `<year>/` prefix is **kept** so located and un-located photos stay under a
  consistent year root, and an asset is never moved across year folders.
- **No location data → the fallback is unchanged**: `<year>/<MM>/<file>`.

The mapping `Place → [segments]` lives in `backup/location-segments.ts`
(`backupLocationSegments`), shared by the ingest hot path and the migration.
Segment sanitisation (trim, `/`,`\` → `_`, drop `.`/`..`/leading-dot, drop
empties) lives in `backup/path-formatter.ts` (`sanitizeLocationSegments`) and is
applied identically on both — so a migrated file lands byte-for-byte where a
fresh ingest of the same place would write it. Filename safety is unchanged.

Geocoding stays **server-side**: the device uploads GPS, `backup-ingest`
resolves the place (warm `geocode_cache`, then a live Nominatim lookup) and
computes the path. `resolveBackupLocation` now returns the ordered segments
(`[]` = use the date-only fallback). The Swift `PathFormatter` only powers the
settings preview + parity test (the phone has no reverse geocoder).

Both implementations + their unit tests + the `BackupPathPreview` sample change
together.

---

## Part 2 — Migration "Restructure backups by location"

`workers/migration/restructure-backup-geo.ts`, registered in the existing
`MIGRATIONS` array — the worker, routes, status surface, and `/settings/workers`
UI pick it up generically (no new plumbing).

### Scope (which assets)

Backup-origin assets (`phasset_links`) whose canonical entry (`fileinfo[0]`) is
live, that **have been reverse-geocoded** (`place` set — resolved or an
unresolvable stub), and that are **not yet stamped** into this layout
(`backup_layout_version !== 2`).

- Assets with GPS the geocode worker hasn't reached yet (`place == null`) are
  **not** candidates — their final folder isn't known. They're left until
  geocoding fills `place`; re-enabling the migration then picks them up. This is
  the case that matters: a photo backed up on a cold cache lands in the date
  fallback and is **relocated** to its geo folder once the worker geocodes it.
- No-GPS assets never get a `place`, so they're excluded — and they're already
  in the (unchanged) date fallback, so there's nothing to do.

### Idempotency marker

`AssetDoc.backup_layout_version` (number). Generation **1** is the implicit
pre-geo flat layout from #744 (never stamped); **2** is this layout. The
migration stamps `2` on every asset it places (in the same repoint write, or on
its own for a no-op), and selects on `{ $ne: 2 }`. This makes `countRemaining()`
a cheap indexed count and guarantees done-detection terminates: an asset is
processed exactly once, after it has `place` data. Path shape alone can't
distinguish "already migrated" from "needs work" (both can be 2- or 3-segment),
so the explicit marker is load-bearing.

### Target directory

`computeGeoDir(doc)`:

- **Year** = the leading segment of the current path when it's 4 digits (so the
  file never moves across year folders), else `exif.captured_year`, else `null`
  (→ stamp-and-leave; pathological since every backup path starts `<year>/`).
- **Segments** = `sanitizeLocationSegments(backupLocationSegments(place))`.
- Non-empty segments → `<year>/<segs…>`. Empty (unresolved stub) → return the
  **current** dir (already the date fallback → the move collapses to a no-op
  stamp).

### Per-asset move

Reuses the shared, crash-safe `moveBackupAsset` (extracted from #744 into
`workers/migration/move-backup-asset.ts`): copy → verify (full-file) → repoint
the matched `fileinfo` entry **between verify and delete** → delete sources →
drop the stale `.maple` cache → reclaim the empty old folder → dedupe any
discover-watcher race entry. The repoint resets the `thumb`/`preview` stage
versions (regenerate cache at the new path) **and** stamps
`backup_layout_version: 2`. Collisions dedupe (byte-identical, no companions) or
suffix-rename; never overwrite. When the computed dir equals the current dir,
no file is touched — only the marker is written.

#744's migration is refactored to call the same `moveBackupAsset` (it always has
a distinct target dir and no marker, so its behaviour is unchanged).

---

## Acceptance criteria → where met

- New backups land at `<year>/<State|Country>/<Town/City‖Place>/<file>`; parity
  tests updated (TS + Swift); `BackupPathPreview` shows the new path. → Part 1
- No-location backups unchanged (`<year>/<MM>`). → Part 1
- Migration registered in the registry; toggle in `/settings/workers`. → Part 2
- Relocates geocoded backups (including date-fallback photos geocoded after the
  fact); idempotent; copy-verify-delete; collision-safe; cache reset. → Part 2
- Tests: `location-segments`, `path-formatter` (both langs), `computeGeoDir`,
  migration move e2e. → all parts
