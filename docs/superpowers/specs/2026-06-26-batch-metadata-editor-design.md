# Batch Metadata Editor — design

- **Date:** 2026-06-26
- **Status:** Draft (awaiting review)
- **Area:** `src/web` (Angular), `src/apple` (SwiftUI), `src/api` (Bun/Elysia + Mongo), XMP sidecar layers (TS / Swift / Rust)
- **Builds on:** the existing multi-select (panorama) flow, the XMP sidecar contract (`docs/xmp-canonical-format.md`), and the backup geo-layout / `refile-backups` work (`docs/superpowers/specs/2026-06-18-refile-backups-migration.md`, `2026-06-05-backup-geo-layout.md`).

## Problem

A working photographer routinely needs to fix or stamp metadata across many photos at once: correct a camera clock that was off by hours, set the time zone for a trip, drop the right location onto a day's shoot, and stamp copyright / creator / caption onto a whole import. Maple can select multiple images today (the panorama flow) but offers no way to edit their metadata in bulk — and it has no concept of *editing* capture metadata at all (GPS, capture time, time zone are read-only from the file's EXIF).

This feature adds a **Batch Metadata** editor: select N assets, edit a defined set of metadata fields, and persist the edits **non-destructively** — to XMP sidecars, never to the original file. Edited values become the *effective* metadata that the rest of the app (display, search, sort, geo-organised backups) reads.

## Goals

1. From the existing selection, open a **Batch Metadata** panel that edits one *or many* selected assets.
2. Edit, non-destructively (sidecar only):
   - **Capture correction:** GPS location, capture date/time (set or shift), time zone.
   - **Place names (IPTC text):** sublocation, city, state/province, country, country code.
   - **Description & cataloging:** title, caption ("notes"), headline, keywords, instructions.
   - **Creator & rights:** creator/author, creator job title, copyright notice, copyright status, usage terms, credit, source.
   - **Culling, in batch:** rating, flag, color label.
3. Keep the original file metadata **always recoverable** — `exif.*` is never mutated; a Reset reverts to the file-original.
4. When GPS is added or changed, **offer to re-file the asset's geo-organised backup copies** into the location-derived folder layout.
5. Set GPS by **typing an address and picking a Nominatim result** (forward geocode), with manual coordinate entry as a fallback.
6. Cover **photos/RAW and videos**, on **Web and Apple**, with byte-identical sidecar output across the TS / Swift / Rust XMP layers.

## Non-goals

- **No mutation of original files.** Ever. (Load-bearing principle #1.)
- **No pixel-pipeline change.** This is metadata; the scene-linear chain and parity gates are untouched.
- **No EXIF/IPTC writing *into* the original** image or video container — sidecars only.
- **No new contact-block / IPTC-Extension structures** beyond the fields listed (YAGNI — add when a real caller needs them).
- **No bulk re-file migration changes.** `refile-backups` stays the one-time cleanup it is; we add a *targeted, on-demand* relocate that reuses its canonical-path function and mover.
- **No timeline/effort framing in this doc** — milestones below are sequencing only.

---

## Field catalog

All edits map to **standard** XMP/IPTC namespaces so they round-trip through Lightroom, Bridge, Apple Photos, and exiftool. Today these attributes already survive Maple's sidecar round-trip as *passthrough* (`unknownAttributes`/`unknownNodes`), so promoting them to first-class fields is backward-compatible.

| UI label | XMP field | Form | Batch op |
| --- | --- | --- | --- |
| **GPS latitude** | `exif:GPSLatitude` | `DDD,MM.mmmmN` | set / clear |
| **GPS longitude** | `exif:GPSLongitude` | `DDD,MM.mmmmW` | set / clear |
| **GPS altitude** | `exif:GPSAltitude` + `exif:GPSAltitudeRef` | rational + 0/1 | set / clear (optional, follows location) |
| **Capture date/time** | `exif:DateTimeOriginal` | ISO-8601 with offset | set (2 modes) / shift |
| **Time zone** | offset embedded in `exif:DateTimeOriginal`; IANA name in `papp:TimeZone` | `+02:00` / `Europe/Paris` | set |
| **Sublocation** | `Iptc4xmpCore:Location` | text | set / clear |
| **City** | `photoshop:City` | text | set / clear |
| **State/Province** | `photoshop:State` | text | set / clear |
| **Country** | `photoshop:Country` | text | set / clear |
| **Country code** | `Iptc4xmpCore:CountryCode` | ISO 3166-1 | set / clear |
| **Title** | `dc:title` | lang-alt | set / clear |
| **Caption (Notes)** | `dc:description` | lang-alt | set / clear |
| **Headline** | `photoshop:Headline` | text | set / clear |
| **Keywords** | `dc:subject` | bag | add / remove / replace |
| **Instructions** | `photoshop:Instructions` | text | set / clear |
| **Creator / Author** | `dc:creator` | seq | set / clear |
| **Creator job title** | `photoshop:AuthorsPosition` | text | set / clear |
| **Copyright notice** | `dc:rights` | lang-alt | set / clear |
| **Copyright status** | `xmpRights:Marked` | bool (unknown = absent) | set tri-state |
| **Usage terms** | `xmpRights:UsageTerms` | lang-alt | set / clear |
| **Credit** | `photoshop:Credit` | text | set / clear |
| **Source** | `photoshop:Source` | text | set / clear |
| **Rating** | `xmp:Rating` | 0–5 | set |
| **Flag** | `papp:Flag` | pick/reject/unflagged | set |
| **Color label** | `papp:ColorLabel` | red…blue | set |

`xmp:Rating`, `papp:Flag`, `papp:ColorLabel`, and `dc:subject` already exist in Maple's culling model — this feature reuses them and adds multi-asset application.

### Notes on representation

- **"Notes" = Caption** → `dc:description` (portable; shows as Caption in Lightroom/Apple Photos). A separate private note was considered and rejected for v1.
- **Time zone** is carried as the **offset in the `exif:DateTimeOriginal` string** (the interoperable representation). The **IANA zone name** is additionally stored in a proprietary `papp:TimeZone` field so Maple can round-trip the user's intent (e.g. `Europe/Paris` vs a bare `+02:00`) and handle DST correctly on later shifts. Readers that don't know `papp:TimeZone` still get a correct absolute instant from the offset.
- **Copyright status** is tri-state: *unknown* (omit `xmpRights:Marked`), *copyrighted* (`True`), *public domain* (`False`).

---

## Storage & data-flow model

**Chosen: XMP is the authored source of truth; the DB holds an immutable original plus a sparse override projection; the app reads "effective" metadata.** (Alternatives — mutate `exif.*` in place, or XMP-only with no DB — were rejected: the first breaks "exif = file truth" and risks re-index clobber; the second can't drive server-side search / re-geocode / backup re-file.)

### 1. Sidecar (authored truth)

- Edits are written to the asset's `.xmp` sidecar in the standard namespaces above.
- **Images/RAW:** the existing sidecar, alongside the existing adjustment + culling blocks.
- **Videos:** a `.xmp` sidecar beside the video (`clip.mov` → `clip.xmp`) carrying a **metadata-only** block (no crop/adjustment fields — those are image-only). "Never touch the file" is preserved.
- Passthrough is preserved: unknown attributes/nodes still round-trip verbatim. Only fields the user actually edits are emitted; untouched fields are not written.

### 2. DB (derived, for search / sort / geo)

- `asset.exif` stays the **file-original**, immutable. Never written by this feature.
- New sparse subdoc **`asset.metadata_override`**, reconciled from the sidecar by the `override-ingest` stage. It carries the search/sort/geo-relevant subset and records what was touched:

```jsonc
{
  "metadata_override": {
    "edited_at": "2026-06-26T16:40:00Z",
    "touched_fields": ["gps", "captured_at", "time_zone", "dc:subject"],
    "gps": { "lat": 48.8566, "lng": 2.3522, "alt": 35.0 },
    "captured_at": "2026-06-26T18:40:00+02:00",
    "time_zone": "Europe/Paris",
    "place_text": { "city": "Paris", "country": "France", "country_code": "FR" },
    "keywords": ["travel", "france"]
  }
}
```

- **`gps` keeps the existing `{ lat, lng }` shape** used by `asset.exif.gps` (`src/api/src/db/schema.ts:126`) — *not* GeoJSON. Matching the original's shape keeps the effective resolver symmetric; nothing in `src/api` uses a `2dsphere` index or `$near`/`$geoWithin` today (geo is facet-based via `place.rollups`), so GeoJSON would be speculative (YAGNI). If spatial search is ever added it must be introduced on **both** `exif.gps` and the override together — and only then does the GeoJSON `[lng, lat]` ordering caveat apply.
- The complete authored set always lives in the sidecar; the override subdoc is a projection. `touched_fields` makes provenance (file vs user) explicit per field.

### 3. Effective resolver

A single resolver defines what the app sees:

```
effective.captured_at = override.captured_at ?? exif.captured_at
effective.gps         = override.gps         ?? exif.gps
effective.time_zone   = override.time_zone   ?? exif.time_zone(none today)
effective.place_text  = override.place_text  ?? (derived place)
```

- Display panels, search/faceting, date sort, and the backup geo-layout all read **effective**.
- On a capture-time edit, recompute the indexed `captured_year` / `captured_month` from `effective.captured_at`.
- On a GPS edit, re-derive `place` (see Location flow) from `effective.gps`.
- **Reset** removes the override (clears the relevant sidecar fields); effective falls back to `exif.*`. This is also the "restore original location/time" path — the original is never lost because `exif.*` is untouched.

### Where the ingest happens

Heavy ingest work (geocode, derived recompute, geo-path) runs **off the request path** as a polled background stage that reuses the existing version-mismatch worker model (`StageConfig` / `runStage` / `versionBumpReset`, `src/api/src/workers/`) — *not* synchronously inside the HTTP write. This keeps a large batch from saturating the single-process event loop and serialises work per-asset through the existing claim query. The stage is idempotent and crash-safe: a re-run reconciles `metadata_override` from the sidecar (the source of truth).

- **Web / Self-Hosted:** the client writes sidecars via the XMP route; a batch edit uses a new **`POST /api/xmp/batch`** carrying N `{path, metadata}` entries, so a 500-asset edit is one request, not 500. The server writes each sidecar (atomic temp-file + rename, as today) and marks each asset's new `override-ingest` stage dirty (the path-keyed `/api/xmp?path=` route does no DB update today — `src/api/src/routes/xmp.ts` — so it gains this dirty-mark). The polled `override-ingest` stage then parses the metadata block → updates `metadata_override` → recomputes `captured_year/month` → re-geocodes `place` on GPS change.
- **Apple standalone (local library, no server):** the override is read straight from the sidecar into the local view model; there is no Mongo, so search/geo are local and read effective directly. The backup re-file offer (a server feature) does not appear.

---

## Operations & semantics

### Per-field "touched" model

The panel edits a **heterogeneous selection**. For each field:

- A field whose value differs across the selection shows a **"(mixed)"** placeholder.
- A field the user does not touch is **left unchanged** (not written).
- A field can be explicitly **cleared** (writes an empty value / removes the override) — distinct from "left unchanged".

### Date/time

Three operations, chosen per-edit:

1. **Set absolute — anchor + preserve spacing.** The selection is first **sorted ascending by `effective.captured_at`** (never by UI/selection order, which is an unordered set); the chronologically-earliest photo is the anchor. The delta `Δt = t_chosen − t_anchor_old` is applied to every photo, preserving relative spacing. (Lightroom's "Adjust to a specified date and time".)
2. **Set absolute — same time on all.** Every selected photo gets the identical instant.
3. **Shift by a delta.** `± days / hours / minutes`, applied to each photo's effective capture time; always preserves spacing. For clock fixes and travel.

Photos with **no capture time at all** (no EXIF `DateTimeOriginal`) cannot anchor or shift relative to nothing — they are skipped by shift/anchor modes and only settable via "same time on all", with a clear count in the confirm step.

### Time zone

Setting a time zone re-stamps the offset on `effective.captured_at` for each photo and records `papp:TimeZone`. Two intents, surfaced as a toggle:

- **Assign** (the EXIF time was wall-clock-correct, just unlabeled): keep the wall-clock reading, attach the offset.
- **Convert** (the instant is correct, relabel into a new zone): keep the instant, recompute the wall-clock reading.

**Convert requires a known source offset.** Assets whose EXIF carries no offset (the common case — see open question #2) have no defined instant to preserve. For those, Convert falls back to a **default home time zone** — a DB-backed setting per `CLAUDE.md`'s settings rule, surfaced on a settings page, never an env var — treating the wall-clock reading as local to that zone; the confirm step reports how many assets used the fallback. Assign has no such dependency.

### Keywords (`dc:subject`)

Multi-value, so it gets **add / remove / replace** rather than set:

- **Add:** exact-string **set union** into each photo's existing keyword bag — existing order preserved, only previously-absent keywords appended (no duplicate `dc:subject` entries).
- **Remove:** exact-string subtract.
- **Replace:** overwrite the whole set (guarded by confirm).

### Location

Primary input is **address search**:

- **Web / Self-Hosted:** a new `GET /api/geocode/search?q=…` proxies the existing Nominatim integration (`src/api/src/enrichment/nominatim-client.ts`) in **forward** mode (`/search`), debounced and rate-limited like the existing reverse path. The user types an address, picks a result; the result supplies `lat/lon` + structured address. We set `exif:GPSLatitude/Longitude` and populate the place text fields from the result.
- **Apple standalone:** native `CLGeocoder` forward geocode (idiomatic per-platform, no server needed), same UX.
- **Fallback (both):** manual lat/lon entry, and a **"copy location from another selected photo"** helper.
- After a GPS edit, the canonical `place` is re-derived server-side via Nominatim reverse (Self-Hosted) so the stored `Place` schema stays consistent regardless of which geocoder seeded the edit. Place-text fields the user typed by hand win over derived values (the touched-model rule).

---

## Backup re-file (on-demand, GPS edits)

When a GPS edit changes an asset's **effective location**, its geo-organised backup/mirror copies may now sit in the wrong folder. The geo layout is `<year>/<State|Country>/<Town·City|Place>/<file>` (`backupLocationSegments` in `src/api/src/backup/location-segments.ts`; sanitised by `backup/path-formatter.ts`).

- After applying a location change, the panel surfaces an **explicit, separate opt-in**: *"Move N backup copies to match the new location?"* — never automatic.
- Accepting computes the canonical folder from the *new* effective `place` and moves each affected asset through the existing **crash-safe `moveBackupAsset`** (`src/api/src/workers/migration/move-backup-asset.ts`), the same mover `refile-backups` uses, and updates `backup_layout_version`.
- This is a **targeted, on-demand relocate** for the edited assets — distinct from the bulk `refile-backups` migration, which remains untouched. (The describe-stage already establishes that a real-time relocate hook is acceptable; this is the user-triggered analogue.)
- **Scope:** the offer appears only for assets that actually have geo-organised backup copies (the device-backup / mirror libraries). Plain libraries are not geo-foldered, so no offer. Apple standalone never shows it.
- No asset file is deleted except as the trailing step of the verified crash-safe copy. (Load-bearing: originals and their backups are sacred.)

---

## UX

### Entry point

Reuse the existing multi-select. The selection bar gains an **"Edit Metadata…"** action next to "Merge to Panorama…":

- **Apple:** add the action to `PanoSelectionBar` (rename/refactor to a general selection bar) in `src/apple/Maple/Views/`; enabled when `BrowseViewModel.selectedIDs` is non-empty.
- **Web:** add to the browse-shell selection toolbar (`src/web/projects/maple-common/src/lib/shells/browse-shell/`); enabled when `LibrarySelection.selectedCount() ≥ 1`.

Works for a single selected asset too (it is just N = 1).

### The panel

A modal/sheet following the established pano-dialog pattern. The selection is **snapshotted at open** (`[...selectedAssetIds()]` / `selectedAssets`). Grouped, collapsible sections matching the catalog (Capture, Location, Description, Creator & Rights, Culling). Each editable field shows current value, "(mixed)", or empty, with an explicit clear affordance.

### Confirm / preview

Before writing, a summary states exactly what will change, e.g.:

> **42 photos** — capture time **+5h 00m**; location → **Paris, France**; copyright → **© 2026 Z. Lawrence**; keywords **+travel, +france**. *3 photos have no capture time and will be skipped for the time shift.*

Apply writes each sidecar (and triggers override-ingest server-side). Partial failures are reported per-asset; successful writes are not rolled back. The backup re-file offer (if any) appears as a follow-up step after a successful location change.

### Reset

A per-field / per-section **Reset to original** clears the override and falls back to `exif.*`. A selection-wide "Reset metadata edits" is available with a confirm.

---

## Cross-platform parity

- **XMP layers:** the new fields are added to the **TypeScript** serializer/parser (`src/web/projects/maple-common/src/lib/xmp/`) and the **Swift** serializer/parser (`src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization.swift`) with **semantic parity** (same field set, same values, each per-platform byte-stable) — not cross-platform byte-identical output (see Testing). The **Rust** parser (`src/raw-pipeline/raw-core/src/xmp/mod.rs`) silently ignores unknown attributes and nested elements (`_ => {}`), so it already tolerates the new fields (it parses the adjustment model only) — a test confirms it does not error or mis-parse.
- **Single-source constants:** any enumerations or defaults that appear in more than one language (e.g. copyright-status mapping, namespace URIs) are emitted from `raw-core` via the `codegen` crate and `tools/codegen.sh`, guarded by the `codegen-drift` CI job.
- **Geocoder divergence is acceptable:** GPS coordinates are the authored truth; place *text* is derived and may differ slightly between Nominatim (web/server) and CLGeocoder (Apple). Self-Hosted re-canonicalises place server-side, so the stored `Place` is consistent.

---

## Edge cases

- **No capture time:** excluded from shift/anchor modes; settable only via "same time on all"; counted in the confirm step.
- **Heterogeneous selection (mixed file types, mixed values):** "(mixed)" placeholders; only touched fields written; video vs image sidecar path chosen per-asset.
- **Videos without an existing sidecar:** a new metadata-only `.xmp` is created beside the file.
- **Partial write failure:** per-asset error reporting; no silent success; successes kept.
- **Concurrent edits / autosave:** the `override-ingest` stage reconciles from the sidecar idempotently, so a re-run after an adjustment autosave is safe; the write path must not clobber the passthrough block or an in-flight adjustment autosave (the metadata and adjustment blocks share one sidecar).
- **DST / ambiguous local times** when converting zones: resolved via the IANA `papp:TimeZone`, not a bare offset.
- **Re-index from file** must not overwrite `metadata_override` (it only refreshes `exif.*`); effective resolution keeps the override on top.

---

## Testing

- **XMP parity (M0 gate), two layers:** (a) **Per-platform byte-stable round-trip** — `serialize → parse → serialize` is byte-identical on each platform independently (TS and Swift), over real `.xmp` files in temp dirs, exercising lang-alt / seq / bag and GPS/altitude formatting; passthrough preserved. (b) **Cross-platform semantic parity** — parsing platform A's output yields the same model *and the same set of emitted fields/values* on platform B. No byte-diff requirement across platforms (see below). No mocks.
- **Byte-canonical TS↔Swift harmonization is out of scope** — pre-existing debt: the two serializers already diverge on the `papp:` URI, namespace-declaration order, indentation, and attribute sort (none implement the `docs/xmp-canonical-format.md` ordering). This feature adds semantically-parity-safe fields on top of each existing serializer; making the two byte-identical is tracked in a **separate KTLO ticket**.
- **Rust tolerance test:** a sidecar carrying the new metadata fields parses to the same `AdjustmentModel` and the fields survive (no drop).
- **Effective-resolver unit tests:** override-present, override-absent, partial override, reset; `captured_year/month` recompute; anchor-vs-same-time-vs-shift math (incl. no-capture-time skip).
- **Geocode-search integration:** forward `/api/geocode/search` against a Nominatim test double; result → GPS + place-text mapping.
- **Backup re-file integration:** GPS edit → new effective place → canonical-path recompute → `moveBackupAsset` lands the copy in `<year>/<State|Country>/<Town·City|Place>/`; scoped to geo-backup assets only; verified crash-safe (no premature delete).
- **Video sidecar:** metadata-only `.xmp` written beside a video, parsed back, no adjustment/crop block.

---

## Milestones (sequencing)

- **M0 — Shared core.** New XMP fields in TS + Swift (+ Rust tolerance); `metadata_override` schema; effective resolver; codegen constants. Round-trip + resolver tests.
- **M1 — API.** `POST /api/xmp/batch` write + per-asset stage-dirty mark; new polled `override-ingest` stage (reconcile `metadata_override`, recompute `captured_year/month`, re-geocode `place`); `GET /api/geocode/search` (Nominatim forward); search/sort/geo read effective.
- **M2 — Web UI.** Batch Metadata panel; selection-bar entry; address search; confirm/preview; reset.
- **M3 — Backup re-file.** On-demand targeted relocate offer reusing `backupLocationSegments` + `moveBackupAsset`; scoped to geo-backup assets.
- **M4 — Apple UI.** Selection-bar entry; panel; CLGeocoder address search; standalone (sidecar-direct) + server-connected paths.
- **M5 — Video.** Metadata-only sidecar path on both platforms; override-ingest for video assets. **Bundles the scanner change atomically:** today `src/api/src/imports/scan.ts:160` pairs sidecars to images only and counts a movie's `.xmp` as an orphan, so a re-index would silently drop a video override. Video sidecar *writing* is therefore gated on the scanner recognising `clip.xmp ↔ clip.mov` (via `canonicalBaseFromSidecarFilename`, `src/api/src/fs/browse.ts`); both land in the same change — writes never ship before pairing.

Each milestone is its own ticket and PR (per `CONTRIBUTING.md`), with `Closes #N`.

---

## Open questions / risks

1. **Video sidecar discovery — RESOLVED.** Confirmed: the scanner (`src/api/src/imports/scan.ts:160`) pairs sidecars to images only and treats a movie's `.xmp` as an orphan, so a re-index would silently drop a video override. M5 extends the pairing to videos and ships that change atomically with video sidecar writing (see M5).
2. **`exif.time_zone` source:** there is no original time-zone field today, and most EXIF lacks an offset; "Assign vs Convert" assumes the EXIF wall-clock is the baseline, and Convert falls back to the settings-configured default home zone when no source offset exists. Open: should a camera-provided offset (e.g. `OffsetTimeOriginal`) be read at index time to seed `time_zone`?
3. **Lang-alt scope:** v1 writes the default (`x-default`) language for `dc:title`/`dc:description`/`dc:rights`/`xmpRights:UsageTerms`. Multi-language is out of scope unless a caller needs it.
4. **Hosted (non-Self-Hosted) backups:** confirm the backup/mirror system (and thus the re-file offer) only applies to Self-Hosted; Hosted has no operator file roots.
