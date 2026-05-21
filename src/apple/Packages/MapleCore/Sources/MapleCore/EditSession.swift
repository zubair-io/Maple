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
            _scheduleRender(phase: .fast)
            if let store = sidecarStore {
                Task { await store.update(model: model, culling: culling) }
            }
        }
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

    // MARK: Render output

    public var renderedPreview: CIImage?
    public var renderPhase: RenderPhase = .fast
    public var isRendering: Bool = false
    /// Last render error, if any. Views can surface a banner when non-nil.
    public var renderError: Error?

    /// Native image size in sensor pixels. Populated on the first decode and
    /// kept stable across phases/renders. Fit-to-viewport and zoom math must
    /// read this rather than `renderedPreview.extent` — the preview buffer
    /// can legitimately differ from native (half-res decode + CoreImage
    /// upscale on display), and anchoring zoom against the preview extent
    /// produces inconsistent targets across fast/refine and slider ticks.
    public internal(set) var nativeImageSize: CGSize = .zero

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
    /// Set by `FullImageView` from its magnification gesture and toolbar
    /// buttons. Triggers a refine render when it changes (pan-only doesn't
    /// touch this, so panning doesn't re-render).
    public var pixelScale: CGFloat = 0 {
        didSet {
            guard pixelScale != oldValue else { return }
            _scheduleRefine()
        }
    }
    public var showingOriginal: Bool = false

    // MARK: Undo / redo

    @ObservationIgnored private var undoStack: [AdjustmentModel] = []
    @ObservationIgnored private var redoStack: [AdjustmentModel] = []
    public var canUndo: Bool { !undoStack.isEmpty }
    public var canRedo: Bool { !redoStack.isEmpty }

    // MARK: Internals (shared across EditSession+* extensions)

    @ObservationIgnored let pipeline: ImageEditPipeline

    /// Per-session render actor (issue #194). Slice 2 moved the decoded-
    /// image cache + `sharedDecode` / `coalescedRefineDecode` /
    /// `renderForExport` behind this boundary; the scheduler still
    /// lives in `EditSession+Render.swift` and routes through here for
    /// every cache read/write. Slice 3 moves the scheduler too.
    ///
    /// `internal` so the test suite can poke the actor's cache state
    /// directly via `await session.renderActor.…`.
    @ObservationIgnored let renderActor: RenderActor
    /// File-backed sidecar store. `nil` for sourceless assets (PhotoKit, self-
    /// hosted API) where sidecar persistence goes through the source's
    /// `writeXMP` API instead.
    @ObservationIgnored let sidecarStore: (any SidecarStoreProtocol)?
    @ObservationIgnored var renderTask: Task<Void, Never>?
    @ObservationIgnored var refineTask: Task<Void, Never>?
    /// Bumped on every render schedule so that stale tasks exit before writing UI state.
    @ObservationIgnored var renderGeneration: UInt64 = 0

    /// True while `loadSidecar()` is applying persisted state. Hydration must
    /// not behave like a user edit: it should not schedule preview renders
    /// for every session pre-created by the browse grid, and it should not
    /// write sidecars back out while reading them.
    @ObservationIgnored var isHydratingInitialState = false

    /// Flips on when a caller actually asks this session for pixels. The app
    /// primes sessions for every folder asset so metadata/culling is ready,
    /// but those inactive sessions must stay decode-free until opened.
    @ObservationIgnored var renderRequested = false

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

    /// Visible region in oriented full-image source-pixel coords. Set
    /// by `FullImageView` via `updateTileVisibleRegion(viewport:zoom:)`.
    /// `_scheduleRefine`'s deep-zoom branch reads this when targeting
    /// the tile manager. `.zero` disables the deep-zoom branch.
    public internal(set) var viewportSourceRect: CGRect = .zero

    /// Viewport size in real pixels — set by FullImageView. Used as the fast
    /// phase's target size so the filter chain runs at viewport resolution
    /// rather than native resolution.
    public var previewSize: CGSize = .zero {
        didSet {
            guard previewSize != oldValue else { return }
            // First-time mount: we went from .zero to a real size. The first
            // render (usually triggered by `ensureRenderStarted()` before
            // FullImageView mounted) used the zero target and produced
            // nothing visible. Re-kick the fast phase against the real
            // viewport so the image appears immediately; refine follows.
            if oldValue == .zero {
                _scheduleRender(phase: .fast)
            } else {
                // Later resize (window drag) — refine only. `_scheduleRender`
                // also cancels the prior refine, so a continuous window drag
                // coalesces into a single refine pass after the user stops.
                _scheduleRefine()
            }
        }
    }

    /// Snapshot of the canvas state — viewport, native size, zoom — that
    /// drives every fit/zoom/target/visible-rect derivation. Centralising
    /// the math in `CanvasMath` (Ticket 10 item I) eliminates the dual
    /// `EditSession.pixelScale` (resolved value) vs.
    /// `FullImageView.@State pixelScale` (`0` = fit) source-of-truth
    /// problem — both consumers now build the same value type from the
    /// same inputs. `displayScale` defaults to 1 here because the session
    /// works in real pixels; the View passes its own displayScale when it
    /// needs the points-relative `displayFrameInPoints` accessor.
    public var canvasMath: CanvasMath {
        CanvasMath(
            viewportPx: previewSize,
            nativeImageSize: nativeImageSize,
            pixelScale: pixelScale
        )
    }

    /// Fast-phase target — render at viewport resolution so every filter
    /// intermediate stays small. `nil` falls through to `ImageEditPipeline`'s
    /// built-in 2MP cap.
    var fastTargetSize: CGSize? {
        canvasMath.fastTargetSize
    }

    /// Refined-phase target — `nativeImageSize × min(pixelScale, 1.0)`,
    /// floored at `fastTargetSize` so the refine is never lower-quality
    /// than the fast pass. Upscaling past native adds no real detail, so
    /// we cap at 1.0 and let the viewport upscale the native-sized buffer.
    /// Fit mode (pixelScale == 0) resolves to fast == refine and the
    /// refine scheduler short-circuits.
    ///
    /// Falls back to an 8×-fast estimate if `nativeImageSize` hasn't been
    /// populated yet (first decode is in flight). Once the decode lands,
    /// subsequent refines use the native-anchored path.
    var refinedTargetSize: CGSize? {
        canvasMath.refinedTargetSize
    }

    // MARK: Init

    public init(asset: AssetRef,
                model: AdjustmentModel = .default,
                culling: CullingState = CullingState(),
                remoteSidecarStore: (any SidecarStoreProtocol)? = nil) {
        self.asset = asset
        self.model = model
        self.originalModel = model
        self.culling = culling
        let pipeline = ImageEditPipeline()
        self.pipeline = pipeline
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
    }

    // MARK: - Public lifecycle

    /// Push the current model to the undo stack before a user gesture.
    public func beginEdit() {
        undoStack.append(model)
        redoStack.removeAll()
    }

    public func undo() {
        guard let prev = undoStack.popLast() else { return }
        redoStack.append(model)
        model = prev
    }

    public func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(model)
        model = next
    }

    public func resetToOriginal() {
        beginEdit()
        model = originalModel
    }

    // MARK: - Preview

    /// Sample `EditSession` for SwiftUI `#Preview` blocks. Constructed against
    /// `AssetRef.preview()` and the default `AdjustmentModel` — no rendering
    /// is kicked off because there's no real asset on disk, so the preview
    /// renders the view chrome around an empty pipeline. Issue #139.
    public static func preview(displayName: String = "IMG_0042.dng",
                               model: AdjustmentModel = .default,
                               culling: CullingState = CullingState()) -> EditSession {
        EditSession(
            asset: AssetRef.preview(displayName: displayName),
            model: model,
            culling: culling
        )
    }
}
