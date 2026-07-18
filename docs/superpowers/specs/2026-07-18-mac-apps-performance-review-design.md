# Mac/iOS app performance review — findings and fix plan

Date: 2026-07-18. Scope: the Apple (macOS/iPadOS/iOS) app, three product goals:

1. Reduce the time from opening an image to the first GPU-rendered frame in the editor.
2. Reduce memory use, particularly on iOS where 100 MP RAWs have jetsam-killed the app.
3. Improve 100% (1:1) zoom performance — entering, panning, and slider response while zoomed.

The review combined three parallel code audits (load path, memory, zoom) with direct
verification of every load-bearing claim against source. Findings marked CONFIRMED were
traced in code by two independent readers; SUSPECTED items need an Instruments trace to
quantify but have a verified mechanism.

## The headline compound defect

Three independently-confirmed mechanisms stack multiplicatively on the default
configuration (RAW asset, `Profile == .auto`, GPU-live on):

- **Discarded CPU-side Auto-Profile fit.** `decodeAndRender` awaits
  `AutoProfileLUT.shared.filter(...)` (a cold per-image FFI fit — "JPEG extract + full
  develop … seconds on a 100 MP RAW") _before_ attempting the GPU present
  (`EditSession+Render.swift:382-385`). When `presentViaGpuLive` handles the frame — the
  default outcome — the result is discarded unused, because the GPU driver runs its own
  independent fit (`EditSession+GpuLive.swift:169-172`). Every cold open of a
  never-fitted image pays seconds of serialized work, plus the multi-GB develop
  transient previously identified as the iOS jetsam lever, for zero benefit.
- **Fit thrown away on every GPU session re-open.** `GpuLiveDriver.open()` resets
  `autoProfileFitDone = false` unconditionally (`GpuLiveDriver.swift:157`), and `open()`
  runs on every dims change because `isOpen` compares exact dims
  (`GpuLiveDriver.swift:286-288`). The fit's inputs are `(rawPath, quality)` — dims play
  no part — yet a window resize, a zoom past fit, or a crop toggle repeats the entire
  seconds-long fit.
- **Fast/refine dims flip-flop.** The fast phase presents at viewport dims; the refine
  phase (once `pixelScale` exceeds fit) presents at up to 2× viewport
  (`CanvasMath.refinedTargetSize`). With exact-dims `isOpen`, each fast→refine→fast
  transition closes and re-opens the wgpu session, each re-open paying a full f32 CPU
  readback (`sceneLinearFloats`) + re-upload — and, per the previous bullet, a full
  auto-profile refit.

Net effect while zoomed between fit and 100% on a RAW+Auto image: **every pan or slider
settle costs a fresh sized FFI decode, two GPU session re-opens, and a seconds-long
auto-profile refit.** At plain fit zoom the refine short-circuits
(`refinedTargetSize == fastTargetSize`), which is why the cold open at fit feels merely
slow while zooming feels broken.

## Prioritized fixes

### P0 — build now

| #   | Fix                                                                                                                                                                                                                                                                                                                                                                                                          | Goal served         | Size | Files (primary)                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ---- | ------------------------------------------------------------ |
| F1  | Compute the CPU `profileLUT` lazily, only on the CPU-fallback branches after `presentViaGpuLive` declines the frame (both the cached and fresh-decode branches, and `refineVisibleRegion` keeps its existing eager fetch since it is CPU-only). Removes seconds + a multi-GB transient from the default cold open.                                                                                           | load, memory        | S    | `EditSession+Render.swift`                                   |
| F2  | Cache the GPU-live auto-profile fit across session re-opens, keyed `(rawPath, mtime, quality)`. The artifacts live Rust-side in the session, so the cache belongs in the process-wide slot that already survives re-opens; the Swift `autoProfileFitDone` flag alone cannot carry it. Touches `raw-core` gpu-live + `raw-ffi` + xcframework rebuild; caching only — no color-math change, no parity surface. | load, zoom          | M    | `gpu_live` (Rust), `GpuLiveDriver.swift`                     |
| F3  | Coalesce macOS trackpad wheel-pan: `wheelPan` currently calls `commitToSession()` per scroll event, nil-ing the sharp native-detail patch and re-spawning the refine task at scroll-event frequency (visible flicker). Commit once per pan-idle, matching the drag/pinch gesture contract.                                                                                                                   | zoom                | S    | `CanvasZoomController.swift`                                 |
| F4  | Broaden the memory-pressure response beyond the thumbnail cache: also clear `RenderedPreviewCache.memCache`, invalidate `RenderActor` decoded buffers + tile entries on non-active sessions, and drop GPU sessions for backgrounded editors.                                                                                                                                                                 | memory (iOS)        | M    | `MapleApp.swift`, `AppShell.swift`, cache classes            |
| F5  | Prune `AppShell.sessions` on every folder load/navigation, not only on editor-open. Today each `EditSession` (own `CIContext`, `RenderActor`, `NativeDetailRenderer`) accumulates for every asset ever scrolled into view, across folders, for the process lifetime.                                                                                                                                         | memory              | S-M  | `AppShell.swift`, `AppShell+FolderActions.swift`             |
| F6  | Stop the refine re-decode churn at zoom: the interactive path can never set `decodedIsFull` (`decodeTarget` never returns nil), so `cacheSufficient` is always false for refine and every settle re-decodes. Treat a cached sized decode whose dims already cover the refine target as sufficient; this also stops the fast/refine GPU dims flip-flop when the covering buffer is reused.                    | zoom, load, battery | M    | `RenderActor+DecodedCache.swift`, `EditSession+Render.swift` |

### P1 — next wave

- **F7 — Grid-thumbnail placeholder in the editor.** The GPU canvas mounts blank; the
  browse grid's already-decoded thumbnail should paint underneath until the first
  present (mechanism exists as `showCpuBackdrop`). Perceived-latency win on every open.
- **F8 — `RenderedPreviewCache` width-bucket race.** The one cold-open lookup keys on
  `previewSize.width` which can still be zero at that moment, missing the cache that
  funds the ~35 ms budget. Re-attempt once the viewport seeds, or bucket coarsely.
- **F9 — Export-path memory bounding.** Export decodes full-res with no M0/M3-style cap
  and both Metal blur helpers allocate 3 full-res `rgba32Float` textures per call
  (~4.8 GB-order transients on 100 MP) — the largest remaining jetsam risk, not covered
  by the interactive gates. Autoreleasepool the FFI round-trips, then evaluate tiling.
- **F10 — `MetalKernels` shared `CIContext`.** Both blur helpers build a fresh
  `CIContext` + command queue per call (`MetalKernels.swift:163,295`), on effectively
  every CPU-path render since sharpen/nrColor default non-zero.

### P2/P3 — ticketed follow-ups

- `DecodedBufferCache` is configured but has zero production read/write callers — decide
  wire-in vs removal.
- Native-detail patch prefetch / overlap reuse (pan at 100% always waits out the 150 ms
  debounce + full patch develop; no neighbor prefetch, no reuse of the previous patch's
  overlap).
- True 1:1 for Neutral/ACR profiles at 100% (native-detail is Auto-only; blocked on
  tile AE parity, existing issue #1167) and for non-RAW.
- Defensive clamp of refine/native-detail targets to Metal's 16384 texture limit.
- `CanvasImageView` `.equatable()` so the per-body `createCGImage` skip is a contract,
  not an accident of SwiftUI diffing.
- `TileManager` LRU/byte budget (currently dead code — `deepZoomEnabled = false` — but
  documented "No LRU. No byte budget.").
- `NativeDetailRenderer` transient double-handle window on baked-field edits.
- Dead-code cleanup: unreachable `refineVisibleRegion` branch, unreferenced
  `invalidateDecodedCache()`.
- Cold-open trigger churn: up to five call sites each cancel-and-restart the first
  render.

## Verification approach

Swift-side fixes verify with `swift test` in `Packages/MapleCore` plus an
`xcodebuild` macOS build; F2 also rebuilds the xcframework and runs
`cargo test -p raw-core`. None of the P0 fixes touch color math; the color-parity
harness applies only to F2's Rust changes (caching layer, output-identical), where the
existing raw-gpu parity gate is the relevant check. Runtime evidence: `MemoryProbe`
samples and the existing `editSessionSignposter` intervals (`decode` / `fast` /
`refine`) before/after on the 100 MP reference DNG.
