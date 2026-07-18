// EditSession.swift — per-image transient editing state (spec § 01).
//
// Holds the current `AdjustmentModel`, undo/redo stacks, culling state,
// and the storage that the render layer mutates. Observable for SwiftUI.
//
// This file owns ONLY the type declaration + stored state + the small
// public lifecycle methods (init, beginEdit/undo/redo/resetToOriginal,
// computed canvas math). The behaviour layers live in sibling files:
//
//   • EditSession+Render.swift    — two-phase scheduler, decode lifecycle,
//                                   visible-region refine, export render
//   • EditSession+Hydration.swift — cold-open path, sidecar load, preview
//                                   seeds, native-size discovery
//   • EditSession+DeepZoom.swift  — tile-manager wiring, visible-region API
//
// Public API of `EditSession` (the symbols imported by callers) is
// unchanged across the split — see issue #120 for the three-layer cut.

import Foundation
import CoreImage

// MARK: - EditSession

/// Per-image editing session. Observed by SwiftUI via the `@Observable` macro;
/// bind from views via `@State` / `@Bindable` (Observation framework — no
/// legacy observed-object wrapper).
@MainActor
@Observable
public final class EditSession {
    /// Master switch for the deep-zoom tile path. When `false` (the
    /// current default), `_scheduleRefine` always uses the whole-image
    /// sized-FFI refine even at zoom > 1.0 — slower at very high zoom
    /// (~7 s for a 100 MP RAW on iPad) but produces pixel-perfect
    /// colors, no tile-boundary artifacts. When `true`, deep-zoom kicks
    /// in at `pixelScale >= 1.0` and renders 512² tiles on demand.
    ///
    /// Off by default while the per-tile color-parity ticket is open:
    /// the tile pipeline runs each filter chain independently per
    /// tile, and local-context stages (sharpen, clarity, NR) see
    /// different overlap context at tile boundaries — visible as
    /// faint seams or per-tile color shifts. Flip back on once the
    /// color parity work lands.
    ///
    /// Public + non-isolated so callers can flip it from any actor
    /// (e.g. a Settings UI toggle, a launch arg, a UITest harness).
    /// Stored as `nonisolated(unsafe)` because it's effectively a
    /// process-wide read-mostly config flag — racy reads return `false`
    /// or `true` and that's fine.
    nonisolated(unsafe) public static var deepZoomEnabled: Bool = false

    public let asset: AssetRef

    /// Byte-download progress for a remote (cloud) asset open (#822). Set by
    /// the caller (`prepareCloudSession`) when the asset's bytes arrive over
    /// HTTP, so the editor can show a determinate download bar while the
    /// fetch is in flight. `nil` for local / PhotoKit assets — their bytes
    /// are on disk or in Photos, so there's nothing to track and the editor
    /// skips the bar. The progress-reporting bytes provider drives the same
    /// instance; see `prepareCloudSession`.
    @ObservationIgnored public let downloadProgress: DownloadProgress?

    // MARK: Model

    public var model: AdjustmentModel {
        didSet {
            guard model != oldValue else { return }
            guard !isHydratingInitialState else { return }
            // Slider → render wire. If this log doesn't fire on a slider
            // drag, the @Bindable write never landed on `session.model` (the
            // binding path is broken). If it fires but the image doesn't
            // update, follow the trail into `_scheduleRender` →
            // `decodeAndRender` below.
            editSessionLogger.debug(
                "model changed — exposure=\(self.model.exposure, format: .fixed(precision: 2)) contrast=\(self.model.contrast, format: .fixed(precision: 0)) temp=\(self.model.temperature, format: .fixed(precision: 0))"
            )
            // A settled native-detail patch represents the previous model.
            // Remove it immediately so it cannot cover the responsive GPU
            // frame with stale pixels while the 150 ms refine debounce runs.
            clearNativeDetailPreview()
            // Crop-edit fast path (#638): while the Crop tool is armed the
            // canvas renders UNCROPPED and a handle drag mutates ONLY
            // `model.crop`. Re-rendering on every drag frame would be pure
            // waste — the rendered pixels don't change (effectiveCrop is
            // identity while editing) and the overlay draws the rect itself.
            // Skip the render so a crop drag costs zero pipeline work
            // (mirrors the web overlay). The sidecar write below still runs
            // so the rect persists. Leaving crop (cropEditingActive → false)
            // re-renders via its own `didSet`.
            let onlyCropChanged = onlyCropFieldChanged(from: oldValue, to: model)
            if !(cropEditingActive && onlyCropChanged) {
                _scheduleRender(phase: .fast)
            }
            if let store = sidecarStore {
                Task { await store.update(model: model, culling: culling) }
            }
        }
    }
    /// True when `b` differs from `a` ONLY in the `crop` field — used by
    /// `model`'s `didSet` to skip the render on a crop-handle drag while the
    /// crop tool is armed (#638). Compares by zeroing the crop on both: if
    /// the crop-stripped models are equal, the only delta was the crop.
    private func onlyCropFieldChanged(from a: AdjustmentModel, to b: AdjustmentModel) -> Bool {
        guard a.crop != b.crop else { return false }
        var aStripped = a
        var bStripped = b
        aStripped.crop = .identity
        bStripped.crop = .identity
        return aStripped == bStripped
    }

    public var culling: CullingState {
        didSet {
            guard !isHydratingInitialState else { return }
            if let store = sidecarStore {
                Task { await store.update(model: model, culling: culling) }
            }
        }
    }

    /// Snapshot at session open — used by before/after toggle.
    public internal(set) var originalModel: AdjustmentModel

    /// As-shot white balance read from the RAW file's metadata via
    /// `CIRAWFilter`. `nil` when the file is not a recognized RAW or when
    /// metadata is unreadable. Populated by `loadSidecar()` on session open;
    /// used by:
    ///   • `ImageEditPipeline.process(...)` — passed as the `neutral` input
    ///     to `CITemperatureAndTint` so the Temperature slider behaves like
    ///     Lightroom's (slider = scene white point, default = as-shot).
    ///   • DetailPanel's Info tab — surfaced to the user as read-only
    ///     metadata.
    public internal(set) var asShotCCT: Double?
    public internal(set) var asShotTint: Double?

    /// The WB pair `loadSidecar()` seeded into a fresh (sidecar-less)
    /// model: the `CIRAWFilter` placeholder when readable, else the model
    /// defaults (bytes-backed RAWs have no URL for the placeholder read).
    /// `nil` before hydration, or when a sidecar's authored values won.
    /// `adoptDecodedWbFrame` re-seeds the model only while it still sits
    /// exactly at this pair — an explicit record of "WB untouched since
    /// hydration" that doesn't depend on the placeholder existing (#1781).
    var wbSeedTemperature: Double?
    var wbSeedTint: Double?

    /// Decode-exported WB slider frame (#1781) — raw-core's own calibration
    /// frame for this asset, adopted when the first scene-linear decode
    /// lands (`adoptDecodedWbFrame`). Once present:
    ///   • `asShotCCT`/`asShotTint` are updated to the frame's as-shot
    ///     estimate (the decode's number wins over the `CIRAWFilter`
    ///     pre-decode placeholder, which reads a DIFFERENT frame);
    ///   • every per-tick WB delta anchors at the frame's own as-shot pair
    ///     (`wbDeltaAnchor`) so live, tick, and full develops agree.
    /// `nil` until a decode lands, or forever for frame-less sources
    /// (non-RAW, `RawlerFallback` bodies) — those keep legacy behaviour.
    public internal(set) var wbSliderFrame: WbSliderFrame?

    /// The WB delta anchor: the WB actually baked into the buffer. The
    /// strip decode OMITS WB (#1883) → As-Shot develop → the frame's own
    /// pair when present, else the legacy estimate. NOT 6500/0 (#1976):
    /// post-#1894 that mislabel overcooled every settled render to cyan.
    var wbDeltaAnchor: ImageEditPipeline.AsShotWB? {
        if let frame = wbSliderFrame, frame.isPresent {
            return ImageEditPipeline.AsShotWB(
                temperature: Double(frame.sceneCCT),
                tint: Double(frame.asShotTint)
            )
        }
        guard let cct = asShotCCT, let t = asShotTint else { return nil }
        return ImageEditPipeline.AsShotWB(temperature: cct, tint: t)
    }

    // MARK: Render output

    public var renderedPreview: CIImage?
    /// Display-encoded, native-resolution pixels for the currently visible
    /// source rectangle at 100%+. Kept separate from `renderedPreview` so the
    /// canvas can place this small patch over either the GPU or CPU base without
    /// rasterizing a full-sensor `CGImage`.
    public var nativeDetailPreview: CIImage?
    public internal(set) var nativeDetailSourceRect: CGRect = .zero
    /// True only when `renderedPreview` is a COMPLETED full-canvas render of
    /// the current model. False for cold-open seeds (cached JPEG, embedded
    /// JPEG, `.maple` sidecar preview) and for progressive composites that
    /// stitch a fresh viewport patch over an older underlay (visible-region
    /// refine, deep-zoom tiles). `persistCurrentPreviewToCache` gates on this:
    /// persisting a seed or a mixed-provenance composite bakes a tone seam
    /// into `RenderedPreviewCache` + the browse thumbnail that then reappears
    /// on every cold open until a full render overwrites it (#1881).
    /// `@ObservationIgnored` — cache-provenance bookkeeping, not view state;
    /// only the paired `renderedPreview` write should drive UI updates.
    @ObservationIgnored var previewIsFullRender: Bool = false

    /// True only while `renderedPreview` holds the browse-grid-thumbnail seed
    /// (#2040) and nothing richer has landed yet. `ensureRenderStarted`'s
    /// synchronous thumbnail seed is the fastest available pixels — faster
    /// even than the cached-preview seed below — but it is also the coarsest
    /// (a 256px AVIF grid thumbnail), so every richer seed
    /// (`seedFromCachedPreview`/`seedFromMapleSidecarPreview`/
    /// `seedFromEmbeddedPreview`) and every real render (`decodeAndRender`,
    /// `refineVisibleRegion`, deep-zoom) must be free to overwrite it. Without
    /// this flag, `seedFromCachedPreview`'s "don't clobber something already
    /// better" guard (`renderedPreview == nil`) would read the thumbnail seed
    /// as "already seeded" and refuse to ever replace it with the actual
    /// cached develop. `@ObservationIgnored` for the same reason as
    /// `previewIsFullRender` — seed-ordering bookkeeping, not view state.
    @ObservationIgnored var previewIsThumbnailSeed: Bool = false
    public var renderPhase: RenderPhase = .fast
    public var isRendering: Bool = false
    /// Last render error, if any. Views can surface a banner when non-nil.
    public var renderError: Error?
    /// Last sidecar write error, if any. Views can surface a banner when non-nil.
    public var sidecarError: Error?

    /// True once the wgpu live path has PRESENTED at least one frame into the
    /// CURRENT canvas `CAMetalLayer`. The GPU path presents directly
    /// to the layer and never assigns `renderedPreview`, so the loading
    /// indicator and the canvas-ready sentinel cannot use `renderedPreview != nil`
    /// to know the GPU canvas has content (hydration also seeds `renderedPreview`
    /// early). Set in `presentViaGpuLive`; RESET by the canvas controller's
    /// first-register block whenever a fresh `CAMetalLayer` mounts (#1878) —
    /// the session survives editor⇄preview round trips in AppShell's session
    /// store, but a re-entry creates a new, blank layer that this flag must
    /// describe (left set, the re-entry render kicks short-circuit and the
    /// CPU backdrop stays hidden: the black-canvas-on-reopen bug). See #1069.
    public var gpuFramePresented: Bool = false

    /// True once a wgpu present has THROWN for this session (#1769). Views gate
    /// the GPU canvas leaf on this: a torn/failed present must not stay on
    /// glass with no repaint path — flipping this false→true unmounts the
    /// `CAMetalLayer` canvas and falls back to the CPU `renderedPreview` leaf,
    /// which the CPU fallback render (the same `decodeAndRender` pass that
    /// observed the failure) then publishes. Sticky for the session: the GPU
    /// canvas unmounts, so no further presents run to clear it; a new image is
    /// a new `EditSession` and starts clean. Set in `presentViaGpuLive`.
    public var gpuPresentFailed: Bool = false

    /// True from the start of a cold-open until the full-quality (background
    /// Rust) decode lands. The sub-second-open seeds a fast preview (cache /
    /// embedded JPEG) and presents it within ~50 ms, so `gpuFramePresented` /
    /// `renderedPreview` flip almost immediately — but the full decode runs for
    /// seconds behind that preview. The loading indicator keys off THIS so it
    /// stays visible the whole time the image is still being brought to full
    /// quality (#1201 / #1069 follow-up). Set in `openAssetPipelineAsync`.
    public var isFullQualityDecoding: Bool = false

    /// True from the start of a cold-open until the first full-quality frame is
    /// actually ON SCREEN — i.e. one render step LONGER than `isFullQualityDecoding`.
    ///
    /// `isFullQualityDecoding` drops the instant the background Rust decode call
    /// returns, but the decoded buffer still has to run through the filter chain
    /// and publish before the user sees the real image. On a fast machine that
    /// tail is sub-300 ms (the indicator flashed and vanished mid-pipeline); on a
    /// 50 MP+ RAW it is the seconds the user is actually waiting through. The
    /// loading indicator keys off THIS flag so it stays up across the whole
    /// decode→first-frame window. Set in `openAssetPipelineAsync`; cleared once
    /// the first full-quality frame is on screen AFTER the decode has finished —
    /// on the CPU path in `decodeAndRender` (the `renderedPreview` publish) and on
    /// the default GPU live path in `presentViaGpuLive` (which presents directly
    /// to the `CAMetalLayer` and never publishes `renderedPreview`). The
    /// `!isFullQualityDecoding` gate on both means embedded-preview frames, which
    /// land while the decode is still in flight, don't clear it early. A decode
    /// that fails terminally clears it in `decodeAndRender`'s `catch` so it can't
    /// stick. A new image is a new `EditSession`, so it resets naturally. See #1201.
    public var isResolvingFirstFrame: Bool = false

    /// Native image size in sensor pixels. Populated on the first decode and
    /// kept stable across phases/renders. Fit-to-viewport and zoom math must
    /// read this rather than `renderedPreview.extent` — the preview buffer
    /// can legitimately differ from native (half-res decode + CoreImage
    /// upscale on display), and anchoring zoom against the preview extent
    /// produces inconsistent targets across fast/refine and slider ticks.
    public internal(set) var nativeImageSize: CGSize = .zero

    // MARK: Crop (#638)

    /// True while the Crop tool is armed in the editor. The crop overlay
    /// sits over the FULL frame, so while this is set the render path shows
    /// the image UNCROPPED (and the canvas/zoom extent stays the full
    /// `nativeImageSize`). Cleared when another tool arms / Done — the next
    /// render publishes the cropped+straightened result. Mirrors the web
    /// `CropSessionService.active` (derived from `armedTool == .crop`); set
    /// by `EditorState.arm(tool:)`.
    ///
    /// Writing it re-kicks a fast render so entering/leaving crop swaps the
    /// canvas between full-frame and cropped immediately (the web canvas
    /// re-renders on the same transition).
    public var cropEditingActive: Bool = false {
        didSet {
            guard cropEditingActive != oldValue else { return }
            guard !isHydratingInitialState else { return }
            clearNativeDetailPreview()
            // A new image is a new session, so this only fires on a genuine
            // arm/disarm. Re-render so the canvas reflects the cropped vs.
            // uncropped state, and re-push the zoom geometry so fit math
            // retargets the new (cropped or full-frame) extent.
            _scheduleRender(phase: .fast)
        }
    }

    /// The crop rect the render path should apply right now: identity while
    /// the crop tool is armed (show the full frame under the overlay),
    /// otherwise the model's crop. Mirrors the web `renderModelForCrop`.
    var effectiveCrop: Crop {
        cropEditingActive ? .identity : model.crop
    }

    /// Image extent the canvas / zoom math should anchor to: the CROPPED
    /// size when a crop is applied (not editing), otherwise the full-frame
    /// `nativeImageSize`. Keeps fit / 100% / pan and the canvas frame on the
    /// cropped image. `.zero` until the metadata seed lands (same contract
    /// as `nativeImageSize`).
    public var effectiveImageSize: CGSize {
        guard nativeImageSize != .zero else { return nativeImageSize }
        return CropImageStage.croppedSize(effectiveCrop, nativeSize: nativeImageSize)
    }

    // MARK: Zoom / pan

    public var zoomScale: Double = 1.0
    /// Real screen pixels per image pixel.
    ///
    ///   • `0` (default) = "fit-to-viewport" — the refined target is
    ///     simply `previewSize`, matching the fast phase. Any refine pass is
    ///     a no-op in fit mode, so we skip it.
    ///   • `1.0` = 1:1 pixel-perfect.
    ///   • `> 1.0` = zoomed-in beyond native — refine target scales up so
    ///     the user sees image detail at actual resolution, not an
    ///     upscaled low-res preview.
    ///
    /// Set by `CanvasZoomController` (shared by the S5 editor and, formerly,
    /// the legacy `FullImageView`) from the magnification gesture and zoom
    /// toolbar buttons. Triggers a refine render when it changes (pan-only
    /// doesn't touch this, so panning doesn't re-render).
    public var pixelScale: CGFloat = 0 {
        didSet {
            guard pixelScale != oldValue else { return }
            clearNativeDetailPreview()
            _scheduleRefine()
        }
    }
    public var showingOriginal: Bool = false

    // MARK: Undo / redo

    @ObservationIgnored private var undoStack: [AdjustmentModel] = []
    @ObservationIgnored private var redoStack: [AdjustmentModel] = []
    public var canUndo: Bool { !undoStack.isEmpty }
    public var canRedo: Bool { !redoStack.isEmpty }

    /// Ring-buffer cap on the undo/redo stacks. S5 Editor (#625) bounds
    /// the editor's undo history to 32 entries per spec §4; older entries
    /// roll off the bottom (FIFO drop on push). The same cap is honored
    /// on `redo()` to keep the two stacks symmetric.
    public static let undoStackCap: Int = 32

    // MARK: Internals (shared across EditSession+* extensions)

    @ObservationIgnored let pipeline: ImageEditPipeline
    @ObservationIgnored let nativeDetailRenderer: NativeDetailRenderer
    /// Independent freshness token for native-detail work. Refine scheduling
    /// does not bump the main render generation on pure pan/zoom, so this token
    /// prevents an older visible-region result from publishing after a pan,
    /// resize, model change, or return to fit.
    @ObservationIgnored var nativeDetailRequestID: UInt64 = 0
    @ObservationIgnored var nativeDetailInFlightID: UInt64?
    /// Per-session render actor (issue #194). Slice 2 moved the decoded-
    /// image cache + `sharedDecode` / `coalescedRefineDecode` /
    /// `renderForExport` behind this boundary. Slice 3 moves the
    /// scheduler (render/refine task handles, generation counter,
    /// debounce + slider-drag coalescer) — the actor now owns
    /// `scheduleRender` / `scheduleRefine` and EditSession is a thin
    /// caller. The MainActor methods in `EditSession+Render.swift`
    /// remain the bodies that the actor's scheduled closures invoke
    /// (they read/write SwiftUI-observable state, so they must stay on
    /// MainActor).
    ///
    /// `internal` so the test suite can poke the actor's cache state
    /// and scheduler directly via `await session.renderActor.…`.
    @ObservationIgnored let renderActor: RenderActor
    /// File-backed sidecar store. `nil` for sourceless assets (PhotoKit, self-
    /// hosted API) where sidecar persistence goes through the source's
    /// `writeXMP` API instead.
    @ObservationIgnored let sidecarStore: (any SidecarStoreProtocol)?

    /// Where the editor persists the developed display preview (#2009) — the
    /// canonical `<filename>.avif`. Local file for URL-backed assets, an
    /// `/api/preview` upload for cloud assets, `nil` for sourceless assets with
    /// no destination. Written on an idle debounce + on exit, never per tick
    /// (`EditSession+DisplayPreviewPersist`).
    @ObservationIgnored let previewSink: (any DisplayPreviewSink)?

    /// Latest full-render frame awaiting persist to `previewSink`. Captured by
    /// the render-publish path; encoded + written once the idle debounce fires
    /// or the editor exits. `@ObservationIgnored` — persist bookkeeping, not
    /// view state.
    @ObservationIgnored var pendingPreviewImage: CIImage?

    /// The in-flight idle-debounce persist. Cancelled + rescheduled on each new
    /// captured frame; cancelled + flushed on exit.
    @ObservationIgnored var previewPersistTask: Task<Void, Never>?

    @ObservationIgnored private var sidecarErrorTask: Task<Void, Never>?

    /// The wgpu live-render driver (epic #925, P4b-apple / #1028). Created
    /// lazily ONLY when the runtime flag is on (`GpuLiveFlag.isEnabled` —
    /// default on, off via `MAPLE_GPU_LIVE=0`), so a process with the flag off
    /// allocates nothing and the CPU + Metal path runs unchanged. Owns the
    /// per-dims `GpuLiveSession` + the registered `CAMetalLayer`;
    /// `decodeAndRender` drives it instead of publishing a `CIImage`, and
    /// `GpuLiveCanvasView` registers its canvas layer into it.
    @ObservationIgnored public lazy var gpuLiveDriver: GpuLiveDriver? =
        GpuLiveFlag.isEnabled ? GpuLiveDriver() : nil

    /// True while `loadSidecar()` is applying persisted state. Hydration must
    /// not behave like a user edit: it should not schedule preview renders
    /// for every session pre-created by the browse grid, and it should not
    /// write sidecars back out while reading them.
    @ObservationIgnored var isHydratingInitialState = false

    /// Flips on when a caller actually asks this session for pixels. The app
    /// primes sessions for every folder asset so metadata/culling is ready,
    /// but those inactive sessions must stay decode-free until opened.
    @ObservationIgnored var renderRequested = false

    /// Set by `seedFromCachedPreview` when it ran while `previewSize` was
    /// still `.zero` (`ensureRenderStarted()` racing ahead of
    /// `CanvasZoomController`'s viewport push — documented on
    /// `ensureRenderStarted()`). `RenderedPreviewCache` folds screenWidth
    /// into its key, so that attempt looked up a bogus `screenWidth == 1`
    /// bucket and could never match a previous session's real-width entry.
    /// `previewSize`'s `didSet` re-attempts the lookup once the real
    /// viewport lands and clears this flag either way — the retry fires at
    /// most once per cold-open (#2041).
    @ObservationIgnored var cachedPreviewSeedPendingViewport = false

    // MARK: Deep zoom (Plan 3 / Ticket 06 M4)

    /// Tile manager for deep-zoom (`pixelScale >= 1.0`) refine renders.
    /// Created lazily on the first deep-zoom request so that
    /// fit-mode-only sessions never allocate one. Shares the
    /// process-wide `RawImageCache.shared` so the rawler decode is
    /// reused across sessions and tile fetches.
    @ObservationIgnored var tileManager: TileManager?

    /// Background task that listens to `tileManager.events()` and
    /// re-kicks `_scheduleRefine()` whenever a tile lands. Cancelled
    /// when the asset switches or the session deinits.
    @ObservationIgnored var tileEventsTask: Task<Void, Never>?

    /// Observer that drives `downloadProgress` while iOS/macOS materializes
    /// a FileProvider-backed asset (Files-app sidebar / iCloud Drive).
    /// Created lazily by `openAssetPipelineAsync` for URL-backed assets;
    /// stays nil for cloud-search opens (those drive progress via
    /// `CloudByteDownloadBox`) and for sourceless assets without a URL.
    @ObservationIgnored var fileProviderObserver: FileProviderDownloadObserver?

    /// Visible region in oriented full-image source-pixel coords. Set by
    /// `CanvasZoomController` via `updateTileVisibleRegion(viewport:zoom:)`.
    /// `_scheduleRefine`'s deep-zoom branch reads this when targeting
    /// the tile manager. `.zero` disables the deep-zoom branch.
    public internal(set) var viewportSourceRect: CGRect = .zero

    /// Viewport size in real pixels — set by `GpuLiveCanvasView` /
    /// `CanvasZoomController`. Used as the fast phase's target size so the
    /// filter chain runs at viewport resolution rather than native resolution.
    public var previewSize: CGSize = .zero {
        didSet {
            guard previewSize != oldValue else { return }
            clearNativeDetailPreview()
            // First-time mount: we went from .zero to a real size. The first
            // render (usually triggered by `ensureRenderStarted()` before the
            // canvas mounted) used the zero target and produced nothing
            // visible. Re-kick the fast phase against the real viewport so
            // the image appears immediately; refine follows.
            if oldValue == .zero {
                _scheduleRender(phase: .fast)
            } else {
                // Later resize (window drag) — refine only. `_scheduleRender`
                // also cancels the prior refine, so a continuous window drag
                // coalesces into a single refine pass after the user stops.
                _scheduleRefine()
            }
            // A viewport landed — if the cache-preview seed is still waiting
            // for a usable width (#2041), give it a correctly-bucketed shot.
            // Deliberately OUTSIDE the zero-transition branch: a sub-pixel
            // layout-churn transient (0 → 0.5) takes the zero branch but
            // fails the seed's `width >= 1` guard and re-arms the pending
            // flag; the real width then arrives with `oldValue == 0.5`, so
            // gating the retry on `oldValue == .zero` would strand the flag
            // forever (jules review). The internal
            // `guard cachedPreviewSeedPendingViewport` makes this free on
            // every non-pending update.
            retryCachedPreviewSeedIfPending()
        }
    }

    // `canvasMath` + `fastTargetSize` + `refinedTargetSize` moved to
    // `EditSession+CanvasMath.swift` (file-size budget, #2041).

    // MARK: Init

    public init(asset: AssetRef,
                model: AdjustmentModel = .default,
                culling: CullingState = CullingState(),
                remoteSidecarStore: (any SidecarStoreProtocol)? = nil,
                remotePreviewSink: (any DisplayPreviewSink)? = nil,
                downloadProgress: DownloadProgress? = nil) {
        self.asset = asset
        self.model = model
        self.originalModel = model
        self.culling = culling
        self.downloadProgress = downloadProgress
        let pipeline = ImageEditPipeline()
        self.pipeline = pipeline
        self.nativeDetailRenderer = NativeDetailRenderer()
        self.renderActor = RenderActor(pipeline: pipeline)
        if let url = asset.primaryURL {
            // Local-file asset — write to the .xmp sidecar next to the RAW.
            self.sidecarStore = XMPSidecarStore(rawURL: url)
        } else if let remote = remoteSidecarStore {
            // Cloud-backed (or PhotoKit) asset — caller injects a remote
            // store that round-trips through the API.
            self.sidecarStore = remote
        } else {
            // Sourceless and no remote store wired — edits are session-local.
            self.sidecarStore = nil
        }

        // Preview sink parallels the sidecar store (#2009): a local file next
        // to the RAW for URL-backed assets, else the injected cloud uploader,
        // else no destination.
        if let url = asset.primaryURL {
            self.previewSink = LocalDisplayPreviewSink(
                previewURL: MapleSidecarPaths.previewURL(for: url))
        } else {
            self.previewSink = remotePreviewSink
        }

        if let store = self.sidecarStore {
            sidecarErrorTask = Task { [weak self, store] in
                // Mirror the tileEventsTask pattern: check cancellation before
                // touching UI state so teardown doesn't publish a stale error
                // after the session is gone.
                let stream = await store.errors()
                for await error in stream {
                    guard let self else { return }
                    if Task.isCancelled { return }
                    await MainActor.run {
                        self.sidecarError = error
                    }
                }
            }
        }
    }

    deinit {
        sidecarErrorTask?.cancel()
        previewPersistTask?.cancel()
    }

    // MARK: - Public lifecycle

    /// Push the current model to the undo stack before a user gesture.
    /// Trims to `undoStackCap` (FIFO) so the editor's history stays bounded.
    public func beginEdit() {
        undoStack.append(model)
        if undoStack.count > Self.undoStackCap {
            undoStack.removeFirst(undoStack.count - Self.undoStackCap)
        }
        redoStack.removeAll()
    }

    public func undo() {
        guard let prev = undoStack.popLast() else { return }
        redoStack.append(model)
        if redoStack.count > Self.undoStackCap {
            redoStack.removeFirst(redoStack.count - Self.undoStackCap)
        }
        model = prev
    }

    public func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(model)
        if undoStack.count > Self.undoStackCap {
            undoStack.removeFirst(undoStack.count - Self.undoStackCap)
        }
        model = next
    }

    public func resetToOriginal() {
        beginEdit()
        model = originalModel
    }

    // `setKeywords` + `flushPendingSidecarWrite` moved to
    // `EditSession+Lifecycle.swift` (file-size budget, #2009).

}
