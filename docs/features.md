# Maple features

Maple is a non-destructive RAW photo editor and library manager that ships as four front ends over one Rust image-processing core: a SwiftUI app for macOS/iPadOS/iOS, an Angular web app in two deployments (Self Hosted against Maple's own server, and Hosted running entirely in the browser), a WinUI 3 app for Windows, and a tvOS viewer. Every front end can open a folder of RAWs, cull them (ratings, flags, color labels, keywords), develop them with the same adjustment model, and export a deliverable — but only the ones backed by the Maple server get search, map, people, imports, and background enrichment. Edits never touch the original file: they are written to an `.xmp` sidecar next to it, and the pixels are re-derived on demand. The single source of truth for what an adjustment _is_ — its name, range, and default — is the Rust `ADJUSTMENT_SCHEMA` in `src/raw-pipeline/raw-core/src/types/adjustment/`, from which the Swift, TypeScript, and C# models are generated or hand-mirrored.

Read [architecture.md](architecture.md) for how the pieces fit together, [pipeline.md](pipeline.md) for what the adjustments actually do to pixels, and [xmp-canonical-format.md](xmp-canonical-format.md) for the sidecar contract.

---

## 1. Library and sources

### What Maple can open

`src/api/src/fs/browse.ts` holds the authoritative extension allowlists, and the web/native clients apply the same sets:

| Bucket        | Extensions                                                            | Handling                                                          |
| ------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| RAW           | `cr2 cr3 nef arw dng raf orf rw2 pef srw x3f 3fr mef erf mrw raw fff` | Full decode + develop through the Rust core                       |
| Bitmap        | `jpg jpeg png webp gif tif tiff heic heif avif`                       | Decoded via sharp / heic-convert (server) or the platform decoder |
| Layered / HDR | `psd psb hdr`                                                         | Flattened to RGBA8 first, then treated as a bitmap                |
| Video         | `mov mp4 m4v avi mkv webm mts m2ts 3gp mxf 3g2 flv vob mpg wmv f4v`   | Listed, thumbnailed, playable — not developable                   |
| Audio         | `mp3 wav m4a aac`                                                     | Indexed for filename/size/date only                               |
| Stubs         | `eip braw afphoto ai`                                                 | Listed with metadata only; no viable decode path exists           |

### Source kinds

The Apple app has the widest set. Each conforms to the `ImageSource` actor protocol in `src/apple/Packages/MapleCore/Sources/MapleCore/Sources/ImageSource.swift`:

- **Local folder** — `FilesystemSource.swift`, persisted as a security-scoped bookmark (`BookmarkStore.swift`), watched for external changes (`FolderChangeWatcher.swift`).
- **Apple Photos** — `PhotoKitSource.swift`, with All / Favorites / Picks / Rejects / Albums filters. Sidecars for PhotoKit assets live in app support (`PhotoKitSidecarStore.swift`) since the originals are not writable.
- **SMB / network share** — `SMBSource.swift` over AMSMB2, credentials in `SMBCredentialStore.swift`. This is a client-side capability only; the server has no SMB client.
- **Self-hosted Maple server** — `Cloud/CloudSource.swift`, listing over the server's filesystem API and streaming RAW bytes on demand.
- **Composed** — `ComposedSource.swift` pairs server metadata with SMB byte reads for the case where both reach the same storage.

Windows opens local folders (`EditSessionViewModel.Library.cs`) and self-hosted servers (`EditSessionViewModel.Cloud.cs`), and additionally mounts a server library as a Windows Cloud Files sync root so it appears in File Explorer (`Services/CloudFiles/CfApi.cs`).

Web Self Hosted browses whatever roots the server has registered. Web Hosted has no server at all: it opens a single file, or a directory handle via the File System Access API, and its write capability is decided by `workspace/workspace-capabilities.ts` — a writable folder saves the sidecar next to the original, while a single file or a read-only folder downloads the `.xmp` instead.

On the server, a library root is just an absolute local directory validated by `src/api/src/fs/root.ts` and registered with a slug. There is no source-type discriminator; a network share works only because the operating system already mounted it at a path. Every file operation is jailed to registered roots plus the `MAPLE_ROOTS` list.

### Imports

Server-side import (`src/api/src/imports/`) copies a server-local folder into a registered library and **never moves or deletes the source**. Each file is hashed and skipped if the library already has it. Destination layout is chosen by the first matching rule in `src/api/src/imports/dest.ts`: an explicit per-bucket label wins; otherwise a photo captured within 30 minutes of an already-indexed asset lands in that asset's folder; otherwise `<year>/<parent>/<source-folder>/`; otherwise `<year>/misc/<source-folder>/`. Paired `.xmp` sidecars follow their image. Progress, per-file results, and cancellation are tracked per job. The operator surface is Settings → Imports on web and the server-admin Imports screen on Apple.

### Backup

Backup is the reverse direction and is Apple-only: the iOS/macOS app uploads the device's Photos library to a self-hosted server. `src/apple/Packages/MapleBackup/Sources/MapleBackup/BackupEngine.swift` walks a queue, uploads original bytes in resumable chunks, then best-effort uploads companions (the Apple-rendered twin, a Live Photo `.mov`, and a Maple sidecar when a real edit exists). Only the primary bytes decide success. Failures back off exponentially (1s, 2s, 4s … capped at an hour) for up to 8 attempts before the item is marked failed; Wi-Fi-only mode re-queues instead of uploading on cellular. On macOS a LaunchAgent (`src/apple/MapleBackupAgent/`) keeps uploading with the app closed. Server-side, `src/api/src/backup/path-formatter.ts` files each upload under `<year>/Screenshot/`, `<year>/<state-or-country>/<town>/`, or `<year>/Misc/`.

---

## 2. Browse, timeline, search, map, people

### Culling metadata

Four things travel in the sidecar and drive every filter: a 0–5 **rating**, a **flag** (`pick` / `reject` / `unflagged`), one of six **color labels** (red, orange, yellow, green, blue, purple — `src/web/projects/maple-common/src/lib/models/color-label.ts`), and free-form **keywords**. Rating and flag have direct controls everywhere; the colour label is set through the batch-metadata sheet rather than a per-asset swatch. Keyboard culling is consistent across Apple, web, and Windows: number keys set the rating, `P` picks, `X` rejects, `U` unflags.

### Grid and timeline

The web browse surface (`shells/browse-shell/`) is a collapsible sources sidebar plus one of three center views chosen in `self-hosted-browse-content.component.html`: a folder **grid**, a **timeline**, or the **map**. The grid (`components/asset-grid/`) offers a breadcrumb, a rescan trigger, a 60–220px thumbnail-size slider, a date/name sort toggle, a quick filter cycling all → picks → 4-stars, and virtual-scrolled rows: the directory's sub-folders first, as fixed 180×64 folder tiles wrapped in their own section (the Windows `BrowseFolderTiles` design, shared by Apple's `FolderTile` — #3099), then justified rows of asset tiles. The timeline (`components/timeline-view/`) groups by month under sticky year headers and carries its own filter row: minimum rating, flag, color label, hidden-image visibility (Show Normal / Show All / Show Only Hidden), and a captured-from/to date range.

Apple's equivalents are `BrowseGrid.swift` (Mac/iPad), `LibraryGrid.swift` (iPhone), and two timelines — `CloudTimelineView.swift` for a single server library and `AllSourcesTimelineView.swift` for the union of every server library and the local Photos library. Windows has a browse grid with format/rating/flag dropdown filters and a sidebar Timeline that scopes the grid to a date bucket, switching it to date-grouped presentation (`EditSessionViewModel.Library.cs`).

Opening one photo lands in a fast **preview** surface (`shells/preview-shell/` on web, `PreviewView.swift` on Apple, `ShellMode.Preview` on Windows) that paints the cached thumbnail then a display-resolution preview, with no decode pipeline mounted. It carries a filmstrip, prev/next navigation, flag and rating controls, an info panel, and an Edit action into the real editor. Videos play here through the platform player wherever a server is backing the library — on web the `<video>` element needs the Self Hosted stream token, so Hosted never renders one.

### Search

`/search` on Web Self Hosted (`lib/search/search.component.ts`) is the one search surface: a query box with an `@`-triggered people/places tag picker, recent queries, a result count with a sort control, and a filter panel offering a date preset (Today / Last 7 days / Last 30 days / This year) or a custom range, plus people and place facets. Scene-type and month-of-year filters are honoured and render as removable chips but have no picker — they arrive through generated-collection deep links.

Server-side (`src/api/src/routes/search/`), MongoDB is always the source of truth. Structured filters compile to a Mongo query; free text falls back to a `$text` index, or is answered by Meilisearch when that sidecar is configured. Filterable fields include camera, lens, ISO/aperture/focal ranges, date range, recurring month, rating, flag, color, extension, path prefix, scene type, activity, subjects, screenshot-ness, people, and place. Hybrid vector search exists behind `meilisearch-config.ts` but is **disabled by default**. A deliberately conservative natural-language date parser handles bare years, `Month [D][, YYYY]`, and qualified seasons like "summer 2024" (`src/api/src/routes/search/nl-date.ts`).

Apple mirrors this with a `SearchViewModel`/`SearchParams` pair shared by two surfaces: on iPhone, `PhoneSearchTab.swift` — a top-level Search tab with the same Date/People/Places filter panel; on Mac/iPad, `CloudSearchView.swift` inside the three-column shell. A generated-collection widget tap or a Map pin/cluster tap seeds whichever surface the platform uses (`AppShell+DeepLink.swift`, `AppShell+Map.swift`) rather than opening a second search UI. Apple TV's `SearchScreen.swift` is text-only — it consumes the same parameters but ships no filter UI. Windows' search box is a client-side substring match over filename, camera model, and lens; it is not the unified search.

### Map

`components/map-view/` renders MapLibre GL with clustered pins and a density heatmap over `GET /api/map/clusters`. The server clusters by a zoom-sized latitude/longitude grid (`src/api/src/routes/map/clusters.ts`) and accepts every search filter alongside the viewport bounding box, so the payload scales with visible cells rather than library size. Tapping a pin runs a place-filtered search. The base-map tile URL is operator-configured and the server never proxies tiles, so photo coordinates never leave the deployment. Apple has a native MapKit version (`Views/Map/MapView.swift`) and Apple TV has `TVMapScreen.swift`. Windows has no map.

### People

Face work happens in two pipeline stages — detection then a 512-dimension embedding per face — after which `src/api/src/people/clustering-job.ts` assigns each face to a person by nearest-centroid cosine similarity, seeding a new auto-named person when nothing matches. Clustering runs automatically when the embed stage drains; it is not a button.

Settings → People on Web Self Hosted is the only full management surface: rename (renaming onto an existing name merges), merge several people into one, set a cover photo, assign or unassign an individual face, hide a face so it stops influencing clustering, and hide or exclude a whole person. **Hidden** removes a person from the People list but leaves their photos in place; **excluded** additionally drops their photos from search, timeline, and every non-file listing. Both are reversible from the Hidden and Excluded pages. Apple exposes people only as a search facet. Windows and Apple TV have no people surface.

---

## 3. The editor

Every platform edits the same `AdjustmentModel`. The generated TypeScript mirror is `src/web/projects/maple-common/src/lib/generated/adjustment-model.generated.ts` (fields and defaults) plus `adjustment-tables.generated.ts` (ranges and copy/paste groups); the Swift mirror is `src/apple/Packages/MapleCore/Sources/MapleCore/Generated/AdjustmentModel+Generated.swift`. Nested values that a flat schema cannot describe — the crop rectangle and the four point curves — are hand-written alongside in `models/adjustment-model.ts` and `MapleCore/Crop.swift` / `ToneCurve.swift`.

### White balance

| Field         | Range                        | Default |
| ------------- | ---------------------------- | ------- |
| `temperature` | 2000 – 12000 K               | 6500    |
| `tint`        | −150 … 150                   | 0       |
| `wbMethod`    | `Cat16` \| `DiagonalRec2020` | `Cat16` |

`whiteBalancePreset` is a sidecar-only marker outside the generated schema; its vocabulary (As Shot, Auto, Daylight, Cloudy, Shade, Tungsten, Fluorescent, Flash, Custom) round-trips faithfully, but no front end offers a picker — Maple itself only ever writes `As Shot` or `Custom`. Web and Apple do offer a two-dimensional WB pad that drives temperature and tint together, and an "as shot" restore.

### Tone

`exposure` is −4 … +4 EV; `brightness`, `contrast`, `highlights`, `shadows`, `whites`, `blacks` and the four parametric-curve regions (`parametricHighlights`, `parametricLights`, `parametricDarks`, `parametricShadows`) are all −100 … 100, defaulting to 0. `autoExposure` (`On` by default) anchors scene mid-gray before the view transform; the `exposure` slider stacks on top of it in EV.

Four point curves — `toneCurveLuma`, `toneCurveRed`, `toneCurveGreen`, `toneCurveBlue` — are lists of `[x, y]` control points in a 0–1 authoring domain. **The empty curve is identity**, which is what keeps a default model bit-identical on every platform. `toneCurveMode` selects `PerChannel` (three independent curves, hue shifts allowed) or `RatioPreserving` (folded through Rec.2020 luma).

### Color

- `vibrance`, `saturation`: −100 … 100.
- **HSL**: eight bands (red, orange, yellow, green, aqua, blue, purple, magenta) × hue / saturation / luminance = 24 sliders, each −100 … 100.
- **Black & white**: `blackWhite` (`Off` / `On`) plus eight `grayMixer*` weights. Turning it on routes the same eight-band stage into a monochrome path and makes the 24 HSL sliders inert.
- **Color grading**: four wheels. Shadows and highlights use the `splitToneShadowHue`/`Saturation` and `splitToneHighlightHue`/`Saturation` pairs (hue 0–360°, saturation 0–100); midtone and global have their own hue/saturation; all four zones have a luminance offset (−100 … 100); `splitToneBalance` warps the tonal axis.
- `highlightRecovery` picks the reconstruction mode (`Off`, `Blend`, `Luminance`, `ChromaticAdaptation` — the default — or `OklabChromaReduction`).
- `profile` chooses the render shaping: `Auto` (default) fits a per-image curve from the RAW's embedded JPEG preview; `Neutral` runs the plain scene-referred AgX view transform.

### Detail

| Field                                            | Range         | Default |
| ------------------------------------------------ | ------------- | ------- |
| `clarity`, `texture`, `dehaze`                   | −100 … 100    | 0       |
| `sharpenAmount`                                  | 0 … 150       | 40      |
| `sharpenRadius`                                  | 0.5 … 3.0     | 1.0     |
| `sharpenDetail`                                  | 0 … 100       | 25      |
| `sharpenMasking`                                 | 0 … 100       | 0       |
| `captureSharpeningAmount`                        | 0 … 100       | 0       |
| `captureSharpeningSigma`                         | 0.5 … 2.0     | 1.0     |
| `nrLuminance`                                    | 0 … 100       | 0       |
| `nrColor`                                        | 0 … 100       | 25      |
| `chromaPrefilter`                                | 0 … 100       | 0       |
| `deepDenoise`                                    | 0 … 100       | 0       |
| `hotPixelSuppression`                            | `Off` \| `On` | `Off`   |
| `lensProfileEnable`                              | `On` \| `Off` | `On`    |
| `lensCorrectionDistortion` / `Ca` / `Vignetting` | 0 … 100       | 100     |

`chromaPrefilter`, `deepDenoise`, `hotPixelSuppression`, and the three lens-correction scales live inside the decode product: changing one invalidates the decoded-image cache and costs a full re-decode, which is why the web UI commits them on pointer release rather than on every tick.

### Effects

`vignetteAmount` (−100 … 100, negative darkens corners), `vignetteFeather` (0–100, default 50), `grainAmount` (0–100), `grainSize` (0–100, default 25), `grainRoughness` (0–100, default 50), plus `filmLook` and `filmStrength`.

**Film looks** are 100 baked 3-D LUTs shipped as `.mlut` files under `resources/film-luts/`, catalogued in `src/raw-pipeline/raw-core/src/film_catalog.rs` across six families: black & white (18), cinema print (12), color negative (20), consumer vintage (20), instant (10), and slide (20). `filmStrength` blends the look against the pre-look value in display-linear, so 100 is the full look. The catalog id is what lands in the sidecar.

### Geometry

`crop` is `{ top, left, bottom, right, angle }` normalized to 0–1 against the display-oriented image, with `angle` in degrees (positive = clockwise). Identity is the full frame at zero rotation, and the whole crop group is omitted from the sidecar in that case. Nine aspect presets ship (`components/crop-overlay/crop-aspect.ts`): Free, Original, 1:1, 3:2, 4:3, 16:9, 2:3, 3:4, 9:16. Crop is edited through an interactive canvas overlay plus a toolbar with a ±45° straighten bar and a reset — never through a value slider.

### Presets, AUTO, reset, copy/paste

A **preset** is a named, schema-versioned _sparse_ adjustment model: only the fields it names are applied, keyed by canonical snake_case names so a preset written on any platform applies on every other (`editor/presets/preset-model.ts`). Unknown keys from a newer schema are preserved on round-trip and skipped on apply. Five built-ins ship — Flat, High Contrast, Monochrome, No Sharpening, No Color NR — alongside user presets. Web and Apple both have a presets panel; Windows does not.

**AUTO** analyses the RAW and writes **exposure only**, as a single undo entry, alongside `autoExposure: 'Off'`. The underlying analysis also returns white balance and tone estimates, and the apply path deliberately ignores them: single-image gray-world white balance produced bad casts, so as-shot is kept. It is wired on web (`editor-state.service.ts`) and Windows (Edit → Auto Adjust); on Apple the method exists in `EditorState+AutoReset.swift` but no view calls it.

**Reset** restores every develop slider to its factory default, points white balance at the camera's as-shot reading, and returns the profile to Auto — while deliberately preserving crop and rotation.

**Copy / Paste / Sync settings** moves adjustments across a selection. The paste dialog is selective, using the schema's own groups: White Balance, Tone, Color, Detail, Effects, Geometry. Three fields are never copied — local adjustments, inpaint removals, and the deprecated capture-sharpening radius alias. This exists on web and Apple; Windows has no copy/paste of develop settings.

### Local adjustments and masks — not surfaced

`raw-core` implements linear (gradient) and radial (ellipse) masks with per-layer partial adjustments — exposure, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temperature, tint — applied between dehaze and sharpen (`src/raw-pipeline/raw-core/src/stages/local_adjustments/`), and round-trips them through the sidecar. A separate inpaint-removal model exists in `src/raw-pipeline/raw-core/src/types/inpaint.rs`. **No platform exposes either.** The web tool dock renders Mask and Heal as explicitly disabled, `aria-hidden` entries (`components/editor/tool-dock.component.ts`), and Apple's `ToolDock.swift` does the same.

### Editor chrome

The web editor's top bar carries a Scopes toggle (the live histogram on tablet and up, an icon on phone) that opens a panel with the histogram, luma waveform, RGB parade and vectorscope reduced from the render worker's per-frame readback (`components/scopes/scope-sample.ts`), then AUTO, Reset, a before/after split toggle, undo (long-press for redo), Info, and Export. Its tool dock has ten entries in Apple's order: the four groups (Light, Color, Effects, Detail) plus Crop, Tone Curve, Film, Presets, and the two disabled placeholders, whose label and ticket come from the editor parity manifest (`editor/parity/`). Sub-tool chips split Color into Basic / HSL / B&W, Effects into Basic / Grade / Film, and Detail into Basic / Lens. Every primary region — navigation, image identity, scopes, comparison, export, filmstrip, tools, tool controls, inspector — carries a `data-editor-region` hook and a landmark label, in the same order at phone, tablet and desktop widths; a resize re-lays the chrome out around unchanged edit state.

Apple's editor is composed from `EditorView.swift` and ships **two control layouts** selected in Settings → General: a compact tool rail with a flyout slider panel, and a stacked panel showing all four groups in one scrollable inspector. Its tool enum (`MapleCore/Editor/ToolModel.swift`) matches web's 25 tools and adds three more — a first-class Tone Curve tool and the two capture-sharpening (deconvolution) controls that web does not expose. Chrome includes a mini histogram, a before/after toggle that appears only once the image is dirty, and a zoom-percent readout.

Windows' edit rail has six entries (Light, Color, Effects, Detail, Tone Curve, Crop) over eight slider sections, and is the only front end that exposes the parametric tone-curve sliders and a point curve with Luma/R/G/B channel tabs side by side.

Zoom on Apple is a tiled deep-zoom path (`MapleCore/DeepZoomState.swift`, `Cache/TileManager.swift`) reaching 8× pixel scale; see [zoom.md](zoom.md). Web and Windows pan and zoom a single rendered surface with fit and 1:1 shortcuts.

---

## 4. Export

`src/raw-pipeline/raw-core/src/export.rs` is the shared export path: it renders through the same colour chain as the on-screen canvas, always with the highest-quality demosaic, and tags every file with an ICC profile describing the primaries it actually carries.

- **Formats**: JPEG (8-bit, quality-controlled), TIFF (16-bit lossless), PNG (8-bit lossless).
- **Colour spaces**: sRGB or Display P3.
- **Size**: full resolution, or a long-edge cap of 4096 / 2560 / 2048 / 1024. Export never upscales.
- **Quality**: JPEG only, default 92.

Web (`lib/export/export-dialog.component.ts`) and Windows (`MainWindow.Dialogs.cs`) present exactly this dialog. Apple has its own encoder (`MapleCore/MapleExporter.swift`) offering JPEG sRGB, JPEG P3, **HEIC P3**, TIFF 16-bit, and PNG with a quality slider — but no size control, even though the option exists in its `ExportOptions` struct.

**Export is single-asset on every front end.** The server has a `batch_jpeg_export` job (`src/api/src/job-runner/handlers/batch-jpeg-export.ts`) that renders a list of assets to a directory at a 4096px cap, but no client UI creates one.

---

## 5. Panorama

Selecting several frames and choosing "Merge to panorama" runs the stitcher in `src/raw-pipeline/maple-pano/`. The user-facing options are the same in all three places that offer it: **frame retention** (Keep or Strict), **local alignment** (Mesh or Off), and, when the binary reports support for it, a **projection strategy** (Auto, Rotation, or Tile). Progress streams while it runs, and the stitched result is written back into the library.

Stitching depends on ALIKED and LightGlue ONNX models plus a recent ONNX Runtime, so it is **off until provisioned**. On the server, `PanoConfig.enabled` defaults to false and a stitch request returns `pano_not_provisioned` until Settings → Panorama supplies the `maple-cli` path and models directory; only one stitch may run at a time. Apple and Windows provision their own local model directories (`Views/PanoSettingsView.swift`, `Services/Pano/PanoProvisioner.cs`) and stitch in-process. Details in [pano.md](pano.md).

---

## 6. File management

On the server every durable file operation is built on one crash-safe primitive, `relocateFile` in `src/api/src/fs/relocate.ts`: copy to a temporary sibling, verify byte-for-byte, publish atomically, carry the paired `.xmp` along, repoint the database, then delete the original. A failure anywhere up to and including the repoint leaves the original untouched. Collisions resolve as skip, replace, or keep-both for user-initiated moves, and auto-suffix for unattended ones.

- **Rename** — inline on a grid tile (F2 or double-click) and in the info panel.
- **Batch rename** — a template with a live preview list, applied sequentially so each step sees the previous one's result.
- **Move** — drag a tile onto a folder row in the sidebar, or use a "Move to…" dialog with a folder picker as the keyboard-reachable equivalent. Collisions raise a prompt; a summary banner reports the outcome.
- **Trash and restore** — a soft delete. The server moves the file to `<libraryRoot>/.maple/trash/<original relative path>` and stamps a deletion time; the row survives with its original path recorded, and restore puts it back (suffixing if the path is now occupied). A garbage collector purges after 30 days. Deleting an already-trashed asset is the permanent purge. The web trash panel offers per-item restore, Restore All, and Empty Trash.
- **Folder operations** — create, rename, move, and recursive trash/restore.
- **Hide** — an asset can be marked hidden in the database and sidecar, with a sibling `<file>.hidden` marker written so filesystem-only consumers such as the File Provider agree. Timeline filters can show normal, all, or only hidden assets. There is no per-asset hide button in the web UI today; hiding is driven by person visibility and by the describe stage's nudity detection.

Apple routes trash by source: on macOS a local file goes to the real Finder Trash, on iOS/iPadOS and SMB it goes to Maple's own `.maple/trash` with an in-app browser and restore, a server asset is trashed through the API, and PhotoKit assets cannot be trashed at all. Windows uses the Windows Recycle Bin for local fixed drives and Maple's trash for network paths.

---

## 7. Settings and admin

Web Self Hosted's settings shell (`src/web/projects/maple/src/app/settings/`) is the reference operator surface:

| Page                        | What it configures                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account                     | Signed-in identity, registered passkeys (with per-credential delete), paired devices (e.g. an Apple TV) with revoke, sign out                                                |
| Users                       | Member roster, per-member file-access toggle, invite codes (issue / rescind / share with QR)                                                                                 |
| Workers                     | Every pipeline stage: pause/resume, concurrency, max attempts, live counters and dead-letter, plus enrichment config (vision model endpoint, geocoder, face-model directory) |
| Sources                     | Registered library roots with live connection status; add a source                                                                                                           |
| Imports                     | Pick a target library, browse the server filesystem, review capture-date buckets, import with live progress                                                                  |
| Panorama                    | Enable toggle, `maple-cli` path, models directory, ONNX Runtime library path                                                                                                 |
| Map                         | Base-map tile/style URL                                                                                                                                                      |
| Network                     | Operator override for the LAN address self-hosted clients prefer over the public URL                                                                                         |
| Cloudflare                  | R2 thumbnail-mirror credentials and enable toggle, with a non-saving connection test                                                                                         |
| Observability               | OTLP endpoint, ingestion key, traces/logs/metrics toggles, sample ratio, test event                                                                                          |
| People (+ Hidden, Excluded) | Face-cluster identities; see §2                                                                                                                                              |

Apple reaches the same server-side pages through a dedicated server-admin window (`Views/ServerAdmin/ServerAdminView.swift`: Workers, Sources, Network, Cloudflare, Enrichment, Imports — all owner-only) and keeps device-local preferences (General, Backup, Cloud, Sources, Pano, Observability, File Provider) in its own Settings scene. Windows' settings window is five local sections only: library folders, Maple Cloud connection, interface, panorama provisioning, and storage/diagnostics.

Accounts have exactly two roles, `owner` and `member`, plus one per-user permission, file access. Authentication is passkey-based (WebAuthn) with short-lived access tokens and rotating refresh families; native apps sign in by handing the ceremony to the system browser and exchanging a one-time code. See [api.md](api.md) and [indexer-enrichment.md](indexer-enrichment.md) for what the stages and workers actually do.

---

## 8. Per-platform matrix

Web is split into its two deployments because they differ substantially. Every cell below was checked against the code that mounts the surface.

| Feature                            | Apple                                            | Web (Self Hosted) | Web (Hosted)       | Windows                   | Apple TV  |
| ---------------------------------- | ------------------------------------------------ | ----------------- | ------------------ | ------------------------- | --------- |
| Open local folder                  | yes                                              | via server        | File System Access | yes                       | no        |
| Apple Photos library               | yes                                              | no                | no                 | no                        | no        |
| SMB share                          | yes                                              | no                | no                 | no                        | no        |
| Self-hosted server library         | yes                                              | yes               | no                 | yes                       | yes       |
| Single-file open                   | yes                                              | no                | yes                | yes                       | no        |
| Grid browse                        | yes                                              | yes               | yes                | yes                       | no        |
| Timeline                           | yes                                              | yes               | no                 | yes (date buckets)        | yes       |
| Preview / loupe                    | yes                                              | yes               | yes                | yes                       | yes       |
| Video playback                     | yes                                              | yes               | no                 | no                        | yes       |
| Ratings / flags / color labels     | yes                                              | yes               | yes                | ratings + flags           | no        |
| Unified search                     | yes                                              | yes               | no                 | filename/camera/lens only | text only |
| Map                                | yes                                              | yes               | no                 | no                        | yes       |
| People management                  | facet only                                       | yes               | no                 | no                        | no        |
| Editor (develop)                   | yes                                              | yes               | yes                | yes                       | no        |
| Tone curve (point)                 | yes                                              | yes               | yes                | yes                       | no        |
| Parametric tone curve              | via curve panel                                  | via curve panel   | via curve panel    | dedicated sliders         | no        |
| HSL / B&W mixer                    | yes                                              | yes               | yes                | yes                       | no        |
| Color grading wheels               | yes                                              | yes               | yes                | yes                       | no        |
| Film looks                         | yes                                              | yes               | yes                | no                        | no        |
| Presets                            | yes                                              | yes               | yes                | no                        | no        |
| Capture sharpening (deconvolution) | yes                                              | no                | no                 | no                        | no        |
| Deep denoise / chroma prefilter    | yes                                              | yes               | yes                | no                        | no        |
| Crop + straighten                  | yes                                              | yes               | yes                | yes                       | no        |
| Masks / local adjustments          | no                                               | yes               | yes                | no                        | no        |
| AUTO                               | no UI                                            | yes               | yes                | yes                       | no        |
| Reset all                          | yes                                              | yes               | yes                | yes                       | no        |
| Copy / paste / sync settings       | yes                                              | yes               | yes                | no                        | no        |
| Before/after                       | yes                                              | yes               | yes                | no                        | no        |
| Histogram                          | yes                                              | yes               | yes                | yes (+ clipping dots)     | no        |
| Deep-zoom tiles                    | yes                                              | no                | no                 | no                        | no        |
| Export                             | yes (+HEIC, no resize)                           | yes               | yes                | yes                       | no        |
| Batch export                       | no                                               | no                | no                 | no                        | no        |
| Panorama stitch                    | yes                                              | yes               | no                 | yes                       | no        |
| Rename / batch rename              | yes                                              | yes               | no                 | yes                       | no        |
| Move / drag to folder              | yes                                              | yes               | no                 | yes                       | no        |
| Trash + restore                    | yes                                              | yes               | no                 | yes                       | no        |
| Batch metadata edit                | yes                                              | yes               | no                 | no                        | no        |
| Server imports                     | yes                                              | yes               | no                 | no                        | no        |
| Photos backup to server            | yes                                              | no                | no                 | no                        | no        |
| Worker / enrichment admin          | yes                                              | yes               | no                 | no                        | no        |
| Users, invites, passkey management | no                                               | yes               | no                 | no                        | no        |
| PWA protocol + file handlers       | n/a                                              | both              | protocol only      | OS registration           | n/a       |
| OS shell integration               | Finder / Files File Provider, Quick Look, widget | no                | no                 | File Explorer sync root   | no        |

Apple additionally ships four extensions: a macOS **File Provider** that mounts a server library in Finder and an iOS twin that does the same in Files, a **Quick Look** provider that shows the server's pre-baked thumbnail instead of materializing a 150MB RAW on spacebar, and a **widget** that surfaces a photo from the day's generated collection and deep-links back into the app.

Per-platform detail lives in [apple.md](apple.md), [web.md](web.md), and [windows.md](windows.md).
