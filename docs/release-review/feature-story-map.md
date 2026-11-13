# Maple feature → user story map (release review, v0.1.6)

Source: `docs/features.md`. `Maple User Stories.md` was empty (`# Untitled`) when this map was written, so every story below is **derived from features.md** and phrased as "As a photographer / operator…". Replace or edit the stories when the real ones exist; the area, feature IDs and code entry points stay valid.

Review rule for every area: classify each finding **P0** (release blocking: data loss, original file modified, wrong pixels/colour, crash, auth/security hole, cross-platform sidecar corruption, broken primary flow), **P1** (fix next release, documented), **P2** (polish). P0s are fixed in the review (ticket + PR). P1/P2 go to `docs/release-review/<area>.md` only.

Platforms: A = Apple (macOS/iPadOS/iOS), WS = Web Self Hosted, WH = Web Hosted, W = Windows, TV = Apple TV.

## Area 1 — Library, sources, imports, backup (`lib-sources`)

| ID  | Feature                                                               | Derived user story                                                                                  | Platforms    | Code entry points                                                            |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| L1  | Open RAW/bitmap/layered/video/audio/stub formats                      | As a photographer I can open any file my camera produces and see unsupported ones listed, not crash | all          | `src/api/src/fs/browse.ts` extension sets, client decoders                   |
| L2  | Local folder source + bookmark + change watcher                       | I pick a folder once and it stays available and updates when files change                           | A, W, WS     | `FilesystemSource.swift`, `BookmarkStore.swift`, `FolderChangeWatcher.swift` |
| L3  | Apple Photos source                                                   | I browse and edit my Photos library without touching originals                                      | A            | `PhotoKitSource.swift`, `PhotoKitSidecarStore.swift`                         |
| L4  | SMB source                                                            | I edit photos on my NAS                                                                             | A            | `SMBSource.swift`, `SMBCredentialStore.swift`                                |
| L5  | Self-hosted library source                                            | I connect to my Maple server and browse its libraries                                               | A, W, WS, TV | `Cloud/CloudSource.swift`, `src/api/src/fs/root.ts`                          |
| L6  | Hosted single-file / directory handle open and sidecar save/download  | I can edit in the browser with no server and still keep my edits                                    | WH           | `workspace/workspace-capabilities.ts`                                        |
| L7  | Server imports (never move/delete source, hash dedupe, dest rules)    | I import a card without duplicates and without losing the source                                    | WS, A        | `src/api/src/imports/`                                                       |
| L8  | Photos backup to server (resumable, backoff, Wi-Fi only, macOS agent) | My phone library backs up safely, resumes, and never loses an item                                  | A            | `MapleBackup/BackupEngine.swift`, `MapleBackupAgent/`, `src/api/src/backup/` |
| L9  | Server library backup (folder, Google Drive, versions, recovery)      | My server library is mirrored and recoverable                                                       | WS           | `docs/cloud-backup.md`, backup stage                                         |

## Area 2 — Browse, timeline, search, map, people (`browse-search`)

| ID  | Feature                                                             | Derived user story                              | Platforms        | Code entry points                                                                               |
| --- | ------------------------------------------------------------------- | ----------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| B1  | Rating / flag / color label / keywords in sidecar; keyboard culling | I cull fast with the keyboard and it persists   | A, WS, WH, W     | `models/color-label.ts`, sidecar writers                                                        |
| B2  | Grid, folder tiles, sort, quick filter                              | I browse a folder and find photos fast          | all but TV       | `components/asset-grid/`, `BrowseGrid.swift`, `LibraryGrid.swift`                               |
| B3  | Timeline + owner/rating/flag/colour/hidden/date filters             | I scroll my library by date and filter it       | A, WS, W, TV     | `components/timeline-view/`, `CloudTimelineView.swift`, `EditSessionViewModel.CloudTimeline.cs` |
| B4  | Preview/loupe, filmstrip, prev/next, video playback                 | I open a photo instantly and move through a set | all              | `shells/preview-shell/`, `PreviewView.swift`                                                    |
| B5  | Unified search (NL date, filters, FTS/vector)                       | I find "summer 2024 beach"                      | A, WS, W, TV     | `src/api/src/routes/search/`, `nl-date.ts`                                                      |
| B6  | Map clusters and pin search                                         | I see where photos were taken                   | A, WS, W, TV     | `routes/map/clusters.ts`, `MapView.swift`                                                       |
| B7  | People: detect, embed, cluster, manage, hide/exclude                | I see and manage who is in my photos            | WS (A, W facets) | `src/api/src/people/clustering-job.ts`                                                          |

## Area 3 — Editor: colour and detail pipeline (`editor-pipeline`)

| ID  | Feature                                                                                                   | Derived user story                                                    | Platforms             | Code entry points                                  |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------- | -------------------------------------------------- |
| E1  | White balance: sliders, presets, picker, As Shot, Auto                                                    | I fix colour cast with a click                                        | A, WS, WH, W          | `raw-core` WB, `MainWindow.WhiteBalance.cs`        |
| E2  | Tone: exposure, contrast, H/S/W/B, parametric + point curves, AutoExposure                                | My tone edits behave like Adobe's and stay identical across platforms | all editors           | `raw-core/src/stages`, generated adjustment models |
| E3  | Colour: vibrance, saturation, HSL 24, B&W mixer, grading wheels, profile Auto/Neutral, highlight recovery | I grade colour and trust the default look                             | all editors           | `raw-core`, profile picker                         |
| E4  | Detail: clarity/texture/dehaze, sharpen, capture sharpening, NR, demosaic, lens corrections, CA, defringe | Detail edits are sharp, artifact-free, and cache-correct              | A, WS, WH (W partial) | `raw-core` detail + decode product                 |
| E5  | Effects: vignette, grain, 100 film LUTs                                                                   | I apply a film look                                                   | A, WS, WH             | `film_catalog.rs`, `resources/film-luts/`          |
| E6  | CPU/GPU/Apple/Web/Windows pixel parity, 16 ms slider budget                                               | A slider feels instant and looks the same everywhere                  | all                   | `raw-gpu`, parity harness, `docs/testing.md`       |

## Area 4 — Editor: geometry, masks, retouch, presets, chrome (`editor-tools`)

| ID  | Feature                                                                            | Derived user story                                 | Platforms              | Code entry points                                          |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------- | ---------------------------------------------------------- |
| T1  | Crop + straighten (aspect presets)                                                 | I crop and level a photo and the sidecar stores it | all editors            | `components/crop-overlay/`, `Crop.swift`                   |
| T2  | Manual geometry + guided geometry                                                  | I fix converging verticals                         | A, WS, WH, W           | homography stage, sidecar keys                             |
| T3  | Presets (built-in + user, sparse model)                                            | I save and apply a look                            | A, WS, WH              | `editor/presets/preset-model.ts`                           |
| T4  | AUTO, Reset, undo/redo                                                             | One tap AUTO, undo anything                        | all editors            | AUTO analysis, history                                     |
| T5  | Copy/paste/sync settings, batch transfer ledger                                    | I sync edits to 2,000 photos crash-safely          | A, WS, WH              | batch transfer, `docs/measurements/batch-transfer-3311.md` |
| T6  | Masks: linear/radial/bitmap, groups, colour range, 17 local controls               | I dodge and burn with masks                        | A, WS, WH, W (partial) | `stages/local_adjustments/`                                |
| T7  | Clone / heal brush                                                                 | I remove dust spots                                | A, WS, WH              | `stages/retouch/`                                          |
| T8  | Editor chrome: scopes, before/after, command router, keyboard, iPhone/iPad layouts | The editor works by keyboard, touch and pencil     | A, WS, WH, W           | `editor-command-router.ts`, `EditorCommandRouter.swift`    |
| T9  | Deep zoom                                                                          | I inspect at 8×                                    | A                      | `NativeDetailRenderer.swift`, `DeepZoomState.swift`        |

## Area 5 — Export (`export`)

| ID  | Feature                                                   | Derived user story                                   | Platforms          | Code entry points                               |
| --- | --------------------------------------------------------- | ---------------------------------------------------- | ------------------ | ----------------------------------------------- |
| X1  | JPEG/TIFF/PNG/AVIF/WebP/HEIC with correct ICC and P3/sRGB | My exports have the right colour in any viewer       | all                | `raw-core/src/export.rs`, `MapleExporter.swift` |
| X2  | Resize caps, never upscale, quality                       | I export sized deliverables                          | all                | export options                                  |
| X3  | Saved recipes + durable batch queue (cancel/resume/retry) | I batch-export and survive a crash                   | A (mac), WS, WH, W | `docs/export-recipes.md`                        |
| X4  | AI-agent MCP export (macOS)                               | An assistant can export without overwriting anything | A                  | `Packages/MapleMCP`                             |

## Area 6 — Panorama (`pano`)

| ID  | Feature                                                                     | Derived user story                                    | Platforms | Code entry points                                  |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------- | --------- | -------------------------------------------------- |
| P1  | Merge-to-panorama options (retention, local alignment, strategy), progress  | I merge frames and see progress                       | A, WS, W  | `maple-pano`, `PanoMergeView.swift`, `pano-dialog` |
| P2  | Edges: Boundary Warp + Auto Crop recorded in XMP (just merged, #5608/#5570) | The panorama's ragged edge is fixed non-destructively | A, WS     | `docs/pano.md` § Edges                             |
| P3  | Server provisioning (`pano_not_provisioned`), single-flight stitch          | Operators can enable pano safely                      | WS        | `src/api/src/job-runner/handlers/pano-stitch.ts`   |
| P4  | Memory behaviour on iPad (epic #5450)                                       | Large panos do not crash my iPad                      | A         | `docs/pano.md` § Memory                            |

## Area 7 — File management and trash (`files`)

| ID  | Feature                                                            | Derived user story                       | Platforms     | Code entry points                      |
| --- | ------------------------------------------------------------------ | ---------------------------------------- | ------------- | -------------------------------------- |
| F1  | Crash-safe `relocateFile` (copy, verify, publish, repoint, delete) | A move never loses or half-moves a photo | WS            | `src/api/src/fs/relocate.ts`           |
| F2  | Rename / batch rename / move / folder ops                          | I reorganise safely                      | A, WS, W      | file ops                               |
| F3  | Trash, restore, 30-day GC, SMB copy-only restore                   | Delete is recoverable                    | all but WH/TV | `.maple/trash`, restore                |
| F4  | Hide + `.hidden` marker                                            | Hidden photos stay hidden everywhere     | WS, A         | hide marker                            |
| F5  | Drag-out copy of originals, File Provider, Quick Look              | I use Finder/Files with my library       | A             | `MapleFileProvider*`, `MapleQuickLook` |

## Area 8 — Settings, admin, auth, API security (`admin-auth`)

| ID  | Feature                                                                             | Derived user story                        | Platforms    | Code entry points                          |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------- | ------------ | ------------------------------------------ |
| S1  | Passkey auth, token rotation, native code exchange, roles owner/member, file access | Only people I invite can reach my library | WS, A, W, TV | `src/api/src/auth`, `docs/api.md`          |
| S2  | Workers admin: pause/resume/concurrency/retry/dead-letter                           | I can see and control background work     | WS, A        | `workers/stage-config.ts`, `run-stage.ts`  |
| S3  | Settings pages (sources, network, cloudflare, observability, map, panorama)         | I configure my server without a shell     | WS, A        | `src/web/projects/maple/src/app/settings/` |
| S4  | Path jail to registered roots, share/stream tokens                                  | No request can read outside my libraries  | WS           | `src/api/src/fs/root.ts`                   |
| S5  | Server deploy and migrations (SQLite, Docker/Bun)                                   | Upgrades never corrupt my index           | WS           | `src/api/`, `Dockerfile`                   |
