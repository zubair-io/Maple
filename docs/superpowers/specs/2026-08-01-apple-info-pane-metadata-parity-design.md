# Apple info pane: full metadata parity + clickable path

Ticket: #2518. Platform: Apple only (macOS, iPadOS, iOS). No API or web changes.

## Background

The info pane (`InfoPanelView`, `src/apple/Maple/Views/InfoPanel/`) is the metadata inspector shown beside or below an open image. A user reported that reaching an image through Search leaves the pane missing metadata such as the capture date and the description. Investigation showed two distinct problems, and that the Browse path is not a clean reference either — it also omits fields.

### Problem one: the rich-detail fetch is broken on every cloud path

The server search and browse projections emit three identifiers for each asset: `id` (the editor id, `"fs:<absPath>"`), `_id` (the Mongo ObjectId), and `address` (`"slug:relPath"`). The Swift `SearchAsset` model decodes only `id`. `prepareCloudSession` then sets `AssetRef.stableID` to that value, and `EnrichmentBlock` calls the detail endpoint with it. The detail route parses the id with `new ObjectId(...)`, which throws on `"fs:/…"`, so the request returns 400 and the Description, OCR, and Transcript section renders nothing. This has been dead on cloud assets since the enrichment work in #2212. Search is simply where it was noticed, because the local filesystem Browse grid reads EXIF straight off disk and hides the enrichment section entirely, so it looks complete by comparison.

### Problem two: the pane renders only a subset of available metadata

Compared with the web info pane (the parity reference) and the backend `AssetDetailDto`, the Apple pane omits, regardless of entry point: date and time taken (no row at all), the file path, the city and structured place (the city row is hard-coded to a dash), the vision tags, faces and people, the file size, and the pixel dimensions.

## Goal

Bring the Apple info pane to parity with the web info pane, and make the file path clickable so that it opens the asset's containing folder inside Maple's own browse view. The chosen scope is full parity: the scalar fields the user named plus the AI-derived Vision and Faces sections.

## Design

### Cloud catalog identity: one new field on AssetRef

`AssetRef` (in `MapleCore`) is intentionally thin and carries no photographic metadata. Rather than widen it field by field, add a single optional plain-data value that captures the cloud catalog identity:

```
public struct CatalogRef: Hashable, Sendable {
    public let serverID: URL
    public let folderID: String
    public let absPath: String
    public let address: String   // slug:relPath
}
```

carried as `AssetRef.catalog: CatalogRef?`, nil for local filesystem and PhotoKit assets. `prepareCloudSession` fills it from the `SearchAsset` it already holds. This one field serves three consumers and leaves `stableID` — the thumbnail-cache key — untouched:

- the detail fetch keys off `catalog.address`,
- the path row displays `catalog.absPath` (local assets use `primaryURL.path`),
- the reveal-folder action uses `catalog.serverID`, `catalog.folderID`, and the parent of `absPath`.

This requires `SearchAsset` to decode `address`, `_id`, and `abs_path` in addition to `id`. The timeline and browse projections must be confirmed to emit the same fields so that cloud Browse is fixed alongside Search; if a projection is missing a field, the corresponding Swift decode stays optional and that path degrades gracefully rather than crashing.

### Address-based detail fetch

`CloudAssetDetailClient` gains a lookup by address that calls `GET /api/assets/by-address?address=slug:relPath`. That endpoint already exists and returns the same `AssetDetailDto`, so no API change is needed. Addressing by the stable `slug:relPath` rather than the Mongo ObjectId matches the decision the web app already made in #2269 and survives re-indexing, which can change an ObjectId.

### Richer detail model

`CloudAssetDetail` currently decodes only description, OCR text, and transcript. Expand it to decode the rest of the `AssetDetailDto` that the pane will show: `place`, `vision`, `faces`, and `size`, using focused Codable structs that mirror the server JSON. A pure projection type turns the decoded detail into the view's section models, so the mapping is unit-testable without a live server.

### Clickable path opens the containing folder in Maple

Add a `@MainActor` method on `AppShell`, `revealContainingFolder(of: AssetRef)`, that dispatches on the asset:

- a cloud asset (has `catalog`) calls the existing `loadCloudLibrary(serverID:folderID:libraryPath:)` with `libraryPath` set to the parent directory of `catalog.absPath`;
- a local asset (has `primaryURL`) calls the existing `openSubFolder` when a root bookmark is active, or `openSavedFolder` for a saved top-level folder.

After loading the folder the method returns the center column to the grid: the pane shell sets `mode = .browse`, and on iPhone the Library navigation stack is cleared with `libraryPath = []`.

The action reaches the info pane as a SwiftUI environment value (`revealFolderAction`), set once at the AppShell root. Because the iPhone info pane is presented as a sheet and SwiftUI does not propagate custom environment values across a sheet or popover boundary, the action must be re-injected onto the sheet content at the Preview boundary, exactly as `cloudAssetDetailClient` and `cloudHistogramClient` are re-injected after #2234.

The path row is interactive only when there is a revealable target: a cloud asset with a `catalog`, or a local asset whose folder scope can be resolved. PhotoKit assets have no folder concept and show no path row.

### Info-pane UI

The camera and location grid gains overview rows: Taken (date) and Dimensions, both read from the EXIF that the pane already loads from the image bytes for the camera identity, lens, aperture, shutter, ISO, and focal rows; Path (clickable) and Size; and the City row is populated from the decoded `place` instead of the hard-coded dash.

Three new focused sections mirror the web pane's field selection: Place (the structured address), Vision (subjects, scene, setting, activity, shot type, colors, mood, and a screenshot badge), and Faces. Each is a small, independently previewable SwiftUI view driven by the projection type, added to the enrichment area alongside the existing description, OCR, and transcript blocks.

### Sourcing tradeoff

Date and dimensions come from the EXIF read that already backs the camera rows, so their source is consistent across local and cloud and no new field is added to the DTO. On a cloud asset they appear once the RAW download that already feeds those rows completes — no new download is introduced, but the values are not instant. This is accepted for consistency with how the camera, lens, and ISO rows already behave.

## Verification

Apple is not gated by the cloud CI, so verification is local. Unit tests (`swift test`) cover the decode and projection seams: `SearchAsset` decoding the new identifiers, `CloudAssetDetail` decoding the expanded DTO, the projection from decoded detail to section models, and the derivation of a reveal target from an `AssetRef`. Builds cover macOS and an iOS simulator, since the iPhone sheet path only type-checks under an iOS build. A run against a signed-in cloud library confirms that date, description, path, place, vision, and faces render on the Search path, and that clicking the path lands on the containing folder from the inline pane and from the iPhone sheet. The worktree may need an xcframework rebuild before the first build, which is a known gotcha in this repo.

## Out of scope

No API or web changes. No new metadata that the backend does not already expose (for example, no new DTO fields for dimensions — those come from EXIF). No changes to thumbnail caching or the `stableID` key.
