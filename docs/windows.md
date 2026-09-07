# Windows shell

The Windows product is a **WinUI 3 desktop app written in C#** (`src/windows/Maple.WinUI`) that P/Invokes the shared Rust core as a plain `raw_ffi.dll`. It is unpackaged (no MSIX identity), self-contained on the Windows App SDK, and ships a second executable beside it — `maple-cli.exe` — for panorama stitching. There is also a small Rust host crate, `maple-windows` (`src/windows/src/`), but it is a ~220-line diagnostic binary, not the shell the user runs. A `tauri.conf.json` sits in the directory and is **inert**: nothing builds it (see "Tauri is not used" below).

Everything the product bar depends on comes from the same Rust core the Apple and Web shells use: decode, the per-tick develop chain, the GPU live chain, thumbnails, export, the filename-template engine. The C# side owns the shell — window chrome, grid/preview/edit navigation, file operations, sidecar XML, the Maple Cloud client, and the File Explorer integration.

## What actually ships

| Artifact            | Built from                                           | Role                                                                                                 |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Maple.WinUI.exe`   | `src/windows/Maple.WinUI/Maple.WinUI.csproj`         | The app. WinUI 3, .NET 8, `win-x64` / `win-arm64`.                                                   |
| `raw_ffi.dll`       | `cargo build --release -p raw-ffi --features gpu`    | The Rust core behind the C ABI. Copied next to the exe by the csproj when present; not committed.    |
| `maple-cli.exe`     | `cargo build --release -p maple-cli --features pano` | Subprocess used for panorama stitching (and as the reference renderer in the qualification harness). |
| `maple-windows.exe` | `cargo build --manifest-path src/windows/Cargo.toml` | Rust host binary — diagnostics/scaffolding, see below.                                               |

The csproj declares `WindowsPackageType=None` and `WindowsAppSDKSelfContained=true`, targets `net8.0-windows10.0.19041.0` with a minimum of Windows 10 1809, and is PerMonitorV2 DPI-aware (`app.manifest`). Because there is no package identity, anything that normally needs it is done the unpackaged way: settings go to a JSON file rather than `ApplicationData`, protocol and file-type registration write `HKCU\Software\Classes`, and the cloud folder registers through the Win32 Cloud Files API instead of the WinRT sync-root manager.

### Tauri is not used

`src/windows/Cargo.toml` lists `tauri-build` only as an **optional build-dependency** behind a non-default `tauri` feature, and the crate has no `build.rs` to invoke it. `src/windows/src/main.rs` starts a `WindowsSession`, prints platform diagnostics, and opens an `rfd` folder picker — no webview, no Tauri runtime, no `tauri::Builder`. Nothing in the build scripts or `.github/workflows/windows.yml` references Tauri or the config file. `tauri.conf.json` (which points `frontendDist` at the Angular build output) describes a shape the repo does not build.

### The Rust host crate

`maple-windows` is four small files:

- `src/lib.rs` — `WindowsSession` (current directory + watcher) and `rfd` file/folder pickers.
- `src/sidecar.rs` — `<stem>.xmp` path derivation plus raw read/write of sidecar bytes, with unit tests covering drive-letter and UNC (`\\NAS\Photos\…`) paths.
- `src/watcher.rs` — a `notify` recursive watcher that hands back changed `.xmp` paths on poll.
- `src/main.rs` — the diagnostic entry point above.

It depends on `raw-core`, `raw-ffi` and `raw-gpu`, so building it proves those crates compile for the MSVC target, which is what CI uses it for. The shipping app does **not** load it; the C# app talks to `raw_ffi.dll` directly.

## The WinUI app

### Shell

`MainWindow` follows a three-stage flow declared by `ShellMode` in `MainWindow.xaml.cs`: **Browse** (grid) → **Preview** (full image, filmstrip, culling) → **Edit** (full-bleed canvas, tool rail, group panels). Sliders exist only in Edit. `MainWindow.xaml` (~900 lines) holds the layout: a custom menu strip that doubles as the title bar, a sidebar with a Timeline entry and two folder trees (Maple Cloud, Folders), the photo `GridView`, and the viewer with both an `Image` and a `SwapChainPanel` stacked so the CPU and GPU paths can swap. `Maple.UI.MuiWindowChrome.Extend` claims the caption strip and pins the caption-button colors to the Maple tokens.

Timeline queries the cloud search API in capture-date order and follows its continuation cursor through Load more. Dates appear as grid headers. Folder navigation clears stale grid contents while loading, expands the active path, and selects its sidebar row; both folder trees share one sidebar scrollbar. Preview opens with its info inspector docked on the right, with an info button to toggle it.

Keyboard handling lives in one `switch` in `MainWindow.xaml.cs`: `E`/`Escape` move between modes, `F2` renames, `Delete` trashes, `Ctrl+0/1/+/-` drive zoom (a `ScrollViewer` zoom factor — there is no tile pyramid on Windows), `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo, and `Ctrl+Shift+G` opens the Maple.UI gallery.

Feature work is split across `MainWindow.*.cs` partials, each paired with a WinUI-free logic class it delegates to:

| Partial                                             | Feature                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `MainWindow.Selection.cs`                           | Grid multi-select (Extended mode) mirrored into the view model.                            |
| `MainWindow.Rename.cs`                              | Inline single-asset rename (F2, double-click filename).                                    |
| `MainWindow.BatchRename.cs`                         | Template-token batch rename with live before/after preview.                                |
| `MainWindow.MoveToFolder.cs`                        | Keyboard/Narrator-accessible move, sharing the drag path's apply code.                     |
| `MainWindow.DragDrop.cs`                            | Drag grid selection onto folder-tree nodes; Ctrl = copy; collisions ask.                   |
| `MainWindow.DropMount.cs`                           | OS drops onto the window (mount by reference) and Explorer "Open with" activations.        |
| `MainWindow.FolderContextMenu.cs`                   | Sources-tree flyout: New Folder / Rename / Move to Trash.                                  |
| `MainWindow.Trash.cs`, `MainWindow.TrashRestore.cs` | Delete → Trash, and the in-app restore list for Maple's own trash.                         |
| `MainWindow.Reveal.cs`                              | "Show in Explorer" (`explorer.exe /select,"<path>"`).                                      |
| `MainWindow.Crop.cs`                                | Crop tool: live rotate preview, client-side display crop, sidecar `crs:Crop*` for develop. |
| `MainWindow.Panels.cs`                              | Edit chrome — tool rail, group panels, star row, docked Preview inspector, histogram.      |
| `MainWindow.Pano.cs`                                | Panorama stitching over a grid multi-selection.                                            |
| `MainWindow.Dialogs.cs`                             | Folder picker, export dialogs, Settings window.                                            |
| `MainWindow.Qualify.cs`                             | Headless qualification mode (see "Qualification harness").                                 |

The convention throughout is that the `MainWindow` partial is UI-thread mechanics only (dialogs, focus, Narrator announcements) and the decision logic lives in a plain C# class under `Services/FileOperations/` or `ViewModels/`, so it can be unit-tested without a live window.

### View model

`EditSessionViewModel` (`ViewModels/`, a `CommunityToolkit.Mvvm` `ObservableObject`) is split into partials by concern: `.Library` (photo collections, folder tree, thumbnails), `.Watcher` (live grid updates), `.Selection`, `.Rename`, `.RenameReconcile`, `.BatchRename`, `.DragMove`, `.DropMount`, `.FolderCrud`, `.Trash`, `.Cloud` (auth, sidecars, download-to-edit) and `.CloudBrowse` (server directory walk). The base partial owns the decoded scene-linear image, the canonical `AdjustmentState`, the render loop, debounced sidecar persistence, and the undo stack. Edit sessions decode at 1600px long edge by default (`DefaultPreviewLongEdge`), overridable via `MAPLE_DECODE_LONG_EDGE` for perf experiments.

### Custom entry point

`Program.cs` replaces the XAML-generated `Main` (`DISABLE_XAML_GENERATED_MAIN`). It registers the instance key `maple-main`; a second process — launched by the browser handing back a `maple-app://` sign-in callback, or by Explorer opening a file — redirects its activation to the running instance instead of opening a second window. `App.xaml.cs` routes both `Protocol` and `File` activations, and accepts the registry-fallback forms where the URI or path arrives as a plain `Launch` argument.

## Talking to the Rust core

All native calls go through `Native/RawFfi.cs`: a `static unsafe class` of `[DllImport("raw_ffi.dll", CallingConvention = Cdecl)]` externs. Return convention is `0 = success`, with the message read from `maple_last_error()` on the **same thread** as the failing call. Struct layouts are hand-mirrored in `Native/MapleAdjustmentParams.cs`, `Native/MapleGpuLiveParams.cs` and `Native/RawFfiStructs.cs`, field-for-field against the Rust `#[repr(C)]` definitions, append-only at the tail. Two guards keep them honest: `RawFfi.VerifyAbi()` asserts `sizeof(MapleAdjustmentParams) == 672` at startup so a drifted mirror fails loudly instead of corrupting pixels, and `Maple.WinUI.Tests/RawFfiLayoutTests.cs` (#3221) loads the `raw_ffi.dll` CI just built (`MAPLE_RAW_FFI_DLL`) and checks every mirror — size and each field's name, order and offset — against `maple_abi_layout` (`raw-ffi/src/abi_layout.rs`, `core::mem::offset_of!` over the real structs). Appending a field on the Rust side means appending it to the C# mirror AND to the field list in `abi_layout.rs` in the same commit.

The entries the app uses, grouped:

- **Decode** — `maple_render_file_scene_linear_sized_f32` (cancellable) plus its free function.
- **Per-tick chain** — `maple_apply_chain_and_encode_display_f32` and the curves-aware sibling `maple_apply_chain_and_encode_display_curves_f32`.
- **GPU live** — `maple_gpu_live_open` / `maple_gpu_present_chain_winui` / `maple_gpu_present_chain_winui_scaled` / `maple_gpu_live_close`.
- **Auto Profile** — `maple_gpu_fit_auto_profile`, `maple_compute_auto_profile_lut`, `maple_compute_auto_adjustments`.
- **Derivatives** — `maple_render_thumbnail_avif_to_file`, `maple_render_thumbnail_preview_jpeg_to_file`, `maple_render_develop_jpeg_to_file`, `maple_export_developed_to_file`, `maple_histogram_file`.
- **Filenames** — `maple_validate_filename` and `maple_render_filename_template_buf`, the same symbols Apple and the Self Hosted API call, wrapped by `Services/FilenameValidation.cs` and `Services/FilenameTemplateEngine.cs`.

### Render loop

`Services/RenderEngine.cs` decodes once to a scene-linear f32 base, then re-runs the Rust chain per adjustment change. `StripChainStages` zeroes every field the per-tick chain re-applies (white balance, tone, colour, curves, crop) so nothing bakes into the base and double-applies — the mirror of Apple's `stripAppleGPUStages`. `DecodedImage` carries the decode-exported state the chain needs: WB frame block, noise profile, ISO, AE gain, and the Auto Profile tail (fitted curve + residual LUT for the GPU path, a composed display LUT for CPU).

`Services/RenderScheduler.cs` is a latest-wins background loop: a slider tick overwrites the pending snapshot, so a fast drag never queues more than one frame. Two display paths:

- **GPU** — the wgpu DX12 live chain presents straight into the `SwapChainPanel`. The panel's `ISwapChainPanelNative*` is QI'd once at window construction (IID `63AAD0B8-…`) and handed to the scheduler; composition-scale changes bump a surface generation. A half-res session feeds the fast phase and is upscaled inside the present shader, so the surface never resizes on a phase swap.
- **CPU fallback** — the fused CPU chain renders BGRA frames: a half-res fast pass, then a full-res refine debounced by 150ms. Any GPU failure downgrades the process to this path for good, logging the reason to `%LOCALAPPDATA%\Maple\maple.log` via `Services/DiagLog.cs`.

`MAPLE_FORCE_CPU=1` pins the CPU path for A/B comparison. The clipping overlay (`ClipOverlayEnabled`) is gated off the hot path when idle, and refreshes at the histogram's debounced cadence on the GPU path because presented pixels never leave the swapchain.

## Sidecars

`Services/Xmp/` is the fourth implementation of the sidecar contract described in [xmp-canonical-format](xmp-canonical-format.md).

- `XmpParser.cs` — permissive reader. Attributes resolve by namespace URI + local name (never by a spoofable source prefix); unknown attributes and nested elements are captured for passthrough; missing keys take canonical defaults.
- `XmpWriter.cs` — canonical serializer: fixed envelope, LF endings, two-space indent ladder, the three core namespaces in fixed order, attributes sorted by namespace priority then name, non-default fields only, passthrough re-emitted verbatim.
- `XmpSidecarDocument.cs` — the parsed model plus the passthrough buckets.
- `SidecarStore.cs` — file I/O. Reads are permissive (absent or unparseable → null); writes are atomic (temp file in the same directory, then `File.Move` with overwrite). Images use same-stem (`photo.dng` → `photo.xmp`); videos keep their extension (`clip.mov` → `clip.mov.xmp`) so a Live Photo's still and clip don't clobber each other.

`Services/SidecarWatcher.cs` watches `*.xmp` in the open folder so external edits refresh the UI.

## File operations

`Services/FileOperations/` holds the relocate primitive and everything built on it, all WinUI-free by construction so the test project can link the sources directly:

- `LocalFileOperations.*.cs` — copy-verify-delete relocate, collision handling, case-only rename, folder CRUD, trash, trash restore. Relocation also cleans up the old shared thumbnail entry.
- `CollisionResolver.cs` — appends `.N` before the extension until free, bounded to 1000 attempts; mirrors the API's `pickFreePath` and Apple's `CollisionResolver.swift`.
- `RecycleBinService.cs` — `SHFileOperationW` with `FOF_ALLOWUNDO`. A delete on a **local fixed drive** goes to the real Windows Recycle Bin, primary and sidecar in one call so they can't half-succeed.
- `TrashPaths.cs` / `MapleTrashListing.cs` — the fallback for network shares and failed Recycle Bin calls: `<libraryRoot>/.maple/trash/<relative-parent>`, preserving position under the root so restore reconstructs the tree. This mirrors the API's `computeTrashPath` and Apple's `trashDestinationDir`. Only these items appear in "Restore from Maple Trash…" — Recycle Bin items are restored from Explorer.
- `DragMoveLogic.cs`, `BatchRenameLogic.cs`, `DropMountLogic.cs`, `FolderTreeCrudLogic.cs`, `RenameLogic.cs`, `TrashSelectionLogic.cs`, `RevealInFileManagerLogic.cs` — the pure decision halves of the corresponding UI partials.
- `LibraryChangeQueue.cs` — thread-safe debounce bookkeeping behind `Services/LibraryWatcher.cs`, which watches the browsed folder (top level only) for arrivals, deletions and renames and coalesces them into one batch.
- `RenameIndexStore.cs` + `RenameReconciliationLogic.cs` — the closed-app rename fallback. A live rename is followed from `FileSystemWatcher.Renamed`; a rename that happened while Maple was closed is recovered by diffing the current scan against a persisted per-folder fingerprint snapshot (size, EXIF capture time, camera serial — never pixels, never sidecar contents).

## Thumbnails and caches

`Services/ThumbnailService.cs` runs two tiers, both rendered by the Rust core with EXIF orientation baked in:

| Tier           | Location                                                  | Key                        | Notes                                                                                                                                                |
| -------------- | --------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 512px grid     | `<folder>\.maple\thumbs\<sha256_prefix16(basename)>.avif` | filename hash              | Cross-app shared cache. Served as-is with no staleness check (originals are immutable). Falls back to the local cache when the folder is unwritable. |
| 2560px preview | `%LOCALAPPDATA%\Maple\local-cache`                        | `path\|mtime\|size\|maxPx` | Machine-local embedded-JPEG preview for the Preview screen. Entries older than 30 days swept at construction.                                        |

`Services/ThumbCachePaths.cs` implements the shared-path derivation and pins the write contract: any client writing there must render at exactly 512px long edge, AVIF quality 55, because an existing entry is never re-rendered by anyone. The hash input is the **basename**, not the absolute path, so `.maple/` travels with the photos. See [caching](caching.md).

## Maple Cloud

`Services/Cloud/CloudClient.cs` is an HTTP client for the Self Hosted API: bearer auth with a `401 → /api/auth/refresh → retry once` loop, the refresh credential being the httpOnly `maple_refresh` cookie held in the handler's `CookieContainer`. Thumbs and previews are AVIF, disk-cached by address hash. Sign-in is the browser passkey ceremony over PKCE (`CloudPkce.cs`): the verifier never leaves the app, the web app sees only the S256 challenge, and the one-time code comes back through the `maple-app://` scheme registered by `Services/ProtocolRegistrar.cs`.

Cloud browsing (`EditSessionViewModel.CloudBrowse.cs`) walks the same routes every other platform walks — `GET /api/folders` for the roots, `GET /api/fs/dir` for each level — deliberately not `/api/search`, which returns a capture-sorted feed with no directory structure. See [server-api](server-api.md).

### File Explorer integration

`Services/CloudFiles/` puts Maple Cloud in File Explorer as `%USERPROFILE%\Maple Cloud`, the Windows counterpart of the Apple File Provider extension. `CfApi.cs` hand-declares the slice of `cldapi.dll` the provider needs (x64 layouts, `Pack = 8`); `CloudFilesSyncRoot.cs` registers the sync root and serves two callbacks:

- **`FETCH_PLACEHOLDERS`** — on-demand directory population. Each placeholder's `FileIdentity` is the entry's absolute server path, so a callback can address the server with no local state.
- **`FETCH_DATA`** — on-demand hydration. Opening a placeholder streams `GET /api/fs/raw` straight into `CfExecute` `TRANSFER_DATA` chunks; nothing spools to disk first. Explorer's "Always keep on this device" rides the same callback under the FULL hydration policy.

Registration uses the Win32 `CfRegisterSyncRoot` path rather than the WinRT `StorageProviderSyncRootManager`, which requires the package identity this unpackaged app does not have. Placeholders, cloud status icons and hydration all work; only the navigation-pane branding entry needs the packaged registration. This is browse/hydrate/pin only — no `NOTIFY_*` callbacks are registered, so Explorer-initiated deletes, renames and writes stay local and are not propagated to the server. Startup is gated on the `CloudFilesEnabled` setting, and a failed start resets that flag so the Settings checkbox never claims a sync root that isn't running.

## Settings, registration, diagnostics

`Services/AppSettings.cs` persists to a JSON file under `%LOCALAPPDATA%\Maple`. Its invariant: every partial write goes through `AppSettings.Update`, which reloads then writes — a long-lived cached instance calling `Save()` would serialize a stale snapshot over fields other code paths had since changed. Cloud refresh tokens are protected with DPAPI.

`SettingsWindow.cs` composes the Settings surface directly on Maple.UI (`MuiSettingsShell` + `MuiListRow` nav + one `MuiSettingsSection` per section) with six sections: Library, Maple Cloud, Interface, Panorama, Storage, About. Actions that already have an owner in `MainWindow` (cloud connect, sidebar toggle) are passed in as callbacks rather than reimplemented.

`Services/FileTypeRegistrar.cs` registers the ProgId `Maple.Exposure.Image` under `HKCU\Software\Classes` for the extensions in `DropMountLogic.SupportedExtensions` — additive only (an `OpenWithProgids` entry, never the default handler), the counterpart of Apple's document-type claims. `ProtocolRegistrar.cs` does the same for `maple-app://`. Both self-register at launch so the exe path stays fresh across rebuilds.

## Panorama

`Services/Pano/PanoService.cs` shells out to `maple-cli pano stitch` rather than calling through FFI, so a multi-minute, multi-gigabyte stitch runs in its own process — the same route the Self Hosted API's `pano_stitch` job takes. It streams the CLI's `pano:`-prefixed stderr as status and keeps the tail for error reporting. `PanoProvisioner.cs` downloads two pinned artifact sets into `%LOCALAPPDATA%\Maple`: the ALIKED + LightGlue ONNX models (URLs and SHA-256 mirrored from `src/raw-pipeline/maple-pano/models.toml`, re-verified by `maple-cli` before every stitch) and the ONNX Runtime 1.23.2 win-x64 runtime, guarded by `maple-cli`'s preflight rejection of anything below ORT API 1.22. Output is a scene-linear 16-bit master PNG beside the frames plus a display JPEG the library watcher picks up live. See [pano](pano.md).

## Maple.UI

`src/windows/Maple.WinUI/MapleUI/` is the Windows port of the shared design system in [unified-component-catalog](unified-component-catalog.md), organized by the catalog's own tiers: 27 atom files, 61 L1 molecules, 28 L2 molecules, 65 organisms, 11 templates and 31 page files, plus a gallery. Each interactive component is split into a WinUI control and a plain-C# `*Math` / `*Logic` sibling (`MuiSliderMath`, `MuiCropOverlayMath`, `MuiDialogLogic`, the `Mui*PageReducer` classes, …) so the decisions are testable without a live window — that split is what most of the test project exercises.

`Themes/Tokens.xaml` is **generated** by `tools/codegen.sh` from `raw-core`'s `ui_tokens.rs` (colors, radii, spacing) and must not be hand-edited; `cross.yml`'s `codegen-drift` job regenerates and diffs the whole tree, so a stale `Tokens.xaml` fails CI. `MapleUI/MuiStyles.xaml` layers the styles on top. The gallery window (`MapleUI/Gallery/`) is a dev/design tool reachable with `Ctrl+Shift+G`, not a product surface.

## Tests

`Maple.WinUI.Tests` (xUnit, 93 files, ~690 test cases) deliberately targets plain `net8.0` — **not** `net8.0-windows`/`UseWinUI` — and takes no `ProjectReference` on the app. Instead it links the app's WinUI-free source files a second time via explicit `<Compile Include>` entries. That keeps the pure logic testable and the project restorable/runnable on any OS, without pulling in the Windows App SDK restore graph.

What it covers: the XMP parser/writer/store round-trips, canonical envelope and number formatting, legacy layouts, passthrough and WB scale versioning; the whole file-operations layer (relocate parity, collision, crash safety, sidecar follow, trash/restore including path-traversal, rename reconciliation, drag-move, drop-mount, batch rename, folder CRUD, selection); `AppSettings.Update`; `StorageReport`; `ThumbCachePaths` (carrying the same filename→hex vectors as the API, Apple and web implementations); and the Maple.UI math/logic/reducer classes.

Sidecar tests follow the repo's "no mocks for the sidecar layer" rule and use real files in temp directories.

**`SidecarCorpusRoundTripTests`** round-trips every `.xmp` in the shared golden corpus at `test-fixtures/sidecars/`. Because `test-fixtures/*` is gitignored, `Support/RepoPaths.cs` walks up to the repo root and skip-passes with a message when the corpus is absent — the expected case on a fresh clone and on the hosted CI runner. What it asserts is a fixed point of _meaning_, not bytes: parse → serialize → re-parse, and the two parsed models must agree. Byte-identity is the Swift/TS contract; the Windows `AdjustmentState` is a structural subset of the schema, so a real Maple sidecar carrying fields Windows doesn't model would legitimately re-emit different bytes in that region while losing nothing (passthrough preserves it). Passthrough is asserted with two rules: attribute/namespace passthrough is canonicalized on write and compared order-insensitively; node passthrough order is load-bearing (mask groups, history entries, snapshots) and compared as an exact ordered sequence.

### Qualification harness

`src/windows/scripts/qualify-winui.ps1` is the Windows counterpart of the Apple UITest visual harness. It drives `MainWindow.Qualify.cs`, which runs headless-ish under environment variables: `MAPLE_QUALIFY_RAW` names the photo to open in Edit, `MAPLE_QUALIFY_OUT` the directory for `report.json`. Two app runs:

1. **GPU** — times ticks wiggling Exposure ±0.01 through the real render loop; reports median and p95 against the 16ms target and 50ms hard limit.
2. **CPU** — `MAPLE_FORCE_CPU=1` plus `MAPLE_DUMP_FRAME=<png>` for a pixel-exact frame, compared against `maple-cli render` of the same RAW + sidecar via `maple-cli diff` (mean ΔE00 budget 2.0 by default).

It skip-passes when no RAW fixture is available, and when `python3` is genuinely missing it still writes both parity artifacts and says there is no ΔE verdict. See [testing](testing.md).

## Build and run

The Rust half builds anywhere; the C# app builds on Windows only.

```bash
# One shot: codegen + raw-ffi + the Rust host + the WinUI app (dotnet optional)
bash src/windows/scripts/build-windows.sh

# Or the pieces, from the repo root:
cargo build --release --manifest-path src/raw-pipeline/Cargo.toml -p raw-ffi --features gpu
cargo build --release --manifest-path src/windows/Cargo.toml

# The app (Windows, .NET 8 SDK)
dotnet build src/windows/Maple.WinUI/Maple.WinUI.csproj -c Release -r win-x64

# Tests — plain net8.0, runs on any OS
dotnet test src/windows/Maple.WinUI.Tests/Maple.WinUI.Tests.csproj -c Release
```

`build-windows.sh` honours `WINDOWS_TARGET` (default `x86_64-pc-windows-msvc`) and runs `tools/codegen.sh` first so `Themes/Tokens.xaml` and the other generated outputs are current. The csproj copies `raw_ffi.dll` and `maple-cli.exe` out of `src/raw-pipeline/target/release/` when they exist, so build the Rust side before the app.

```powershell
# Qualification run (Windows, after building the app and maple-cli)
pwsh src/windows/scripts/qualify-winui.ps1 -Raw C:\path\to\photo.dng
```

## CI

`.github/workflows/windows.yml` runs one job, `windows-build-and-test`, on `windows-latest` for every push to `main` and every pull request:

```bash
cargo check --manifest-path src/raw-pipeline/Cargo.toml --target x86_64-pc-windows-msvc -p raw-core
cargo check --manifest-path src/raw-pipeline/Cargo.toml --target x86_64-pc-windows-msvc -p raw-ffi --features gpu
cargo test  --manifest-path src/raw-pipeline/Cargo.toml -p raw-core --lib
cargo build --manifest-path src/windows/Cargo.toml --release
dotnet build src/windows/Maple.WinUI/Maple.WinUI.csproj -c Release -r win-x64
dotnet test  src/windows/Maple.WinUI.Tests/Maple.WinUI.Tests.csproj -c Release
./tools/codegen.sh
```

Rust toolchain via `dtolnay/rust-toolchain@stable` with the MSVC target, .NET via `actions/setup-dotnet@v4` pinned to `8.0.x`, and `Swatinem/rust-cache@v2` caching both the `src/raw-pipeline` and `src/windows` target directories. The last step only proves `codegen.sh` runs on Windows; the drift comparison itself is the `codegen-drift` job in `cross.yml`.

Note what CI does **not** do: `cargo test` for `maple-windows` itself (only `cargo build`), and the `qualify-winui.ps1` harness is not wired into any workflow.

## File-budget gates cover C#; formatting gates still don't

`tools/check-file-budget.sh` and `tools/check-budget-headroom.sh` — the 400-line soft / 600-line hard file-size budget, and the 570-line growth ratchet — cover `.cs` (#2747), same as every other source extension. Three pre-existing files were over the hard limit at the moment `.cs` was brought under the gate and are seeded in `tools/budget-allowlist.txt`'s day-0-for-C# entries: `MainWindow.xaml.cs` (839 lines), `CloudClient.cs` (631), `EditSessionViewModel.Library.cs` (605) — each needs its own split ticket on the KTLO board, same as any other allowlisted file. The splitting discipline visible throughout the codebase — the `MainWindow.*.cs` partials, the `EditSessionViewModel` partials, the `*Math`/`*Logic` extractions — now has enforcement behind it, not just convention.

`.xaml` is still outside both scripts' extension list — a XAML-only change is not measured, allowlisted, or blocked. Likewise, `lefthook.yml`'s Prettier hook globs `ts,tsx,js,jsx,html,scss,css,json,yaml,yml,md,graphql`, so there is still no formatting gate on C# or XAML.
