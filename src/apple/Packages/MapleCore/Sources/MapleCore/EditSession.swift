// EditSession.swift — per-image transient editing state (spec § 01).
//
// Holds the current AdjustmentModel, undo/redo stacks, culling state,
// and render phase. Observable for SwiftUI.

import Foundation
import CoreImage
import ImageIO
import os
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// Subsystem used by the slider → render boundary so Console filtering lets a
// user confirm that slider ticks are actually reaching the render scheduler.
// Filter in Console.app with: subsystem:app.justmaple.maple category:EditSession
private let editSessionLogger = Logger(
    subsystem: "app.justmaple.maple",
    category: "EditSession"
)

// Signposter for the render pipeline. Surfaced in Instruments (Points of
// Interest + Timeline) so the cold-open waterfall is visible without extra
// tooling. Events we emit:
//   - "open"           event  on ensureRenderStarted entry
//   - "embedded paint" event  when the embedded JPEG lands on screen
//   - "fast"           interval for the fast-phase render pass
//   - "refine"         interval for the refine-phase render pass
//   - "decode"         interval around the Rust decode call
// To view: Xcode → Open Developer Tool → Instruments → Points of Interest,
// or Profile the app and filter by subsystem.
private let editSessionSignposter = OSSignposter(
    subsystem: "app.justmaple.maple",
    category: "EditSession"
)

// MARK: - RenderPhase

/// Two-phase rendering per spec § 02 / § 05.
public enum RenderPhase: Sendable, Equatable {
    /// Fast preview at reduced resolution (≤ 50ms target).
    case fast
    /// Full-resolution final render (≤ 300ms target).
    case refine
}

// MARK: - AssetRef

/// Lightweight reference to a source asset.
///
/// For filesystem-shaped sources (`FilesystemSource`, `SMBSource`, Files.app)
/// `primaryURL` is set and the Rust pipeline reads from disk. For sources
/// that only hand out bytes (`PhotoKitSource`, `SelfHostedSource`)
/// `primaryURL` is `nil` and `bytesProvider` must be set to a closure that
/// fetches the full RAW bytes on demand; the pipeline then calls
/// `PipelineRenderer.render(rawBytes:hint:)`.
///
/// `AssetRef` identity is a UUID minted per session so the Browse grid can
/// diff rows — it is not a content hash.
public struct AssetRef: Identifiable, Sendable, Equatable, Hashable {
    /// On-demand bytes fetch for sourceless assets. Typed as an async
    /// `@Sendable` closure so EditSession can call it from an actor hop.
    public typealias BytesProvider = @Sendable () async throws -> Data

    public let id: UUID
    /// Filesystem URL of the RAW file. `nil` for PhotoKit / self-hosted
    /// assets that live behind an opaque identifier.
    public let primaryURL: URL?
    /// Display name. Derived from `primaryURL` when available; callers that
    /// construct URL-less refs should pass one explicitly.
    public let displayNameOverride: String?
    /// Best-effort RAW extension (without dot, e.g. "dng") for sourceless
    /// assets. Ignored when `primaryURL` is non-nil.
    public let hintExtension: String?
    /// Closure used to fetch bytes on demand. `nil` means the asset lives on
    /// disk at `primaryURL`.
    public let bytesProvider: BytesProvider?
    /// Stable cross-session identifier for sourceless assets — typically the
    /// upstream `ImageRef.id` (BLAKE3 maple:id hex from the Bun API, or a
    /// PHAsset localIdentifier). `nil` for filesystem assets, where the URL
    /// path serves as the cache key.
    public let stableID: String?

    /// Bookmark-resolved ancestor URL that grants security-scoped access to
    /// `primaryURL`. Set when the asset originated from a filesystem walk
    /// rooted at a security-scoped bookmark (user picked the folder via the
    /// system picker, or we resolved it from a persisted bookmark). Wrapping
    /// the Rust FFI read in a `startAccessingSecurityScopedResource` bracket
    /// on THIS URL — not on a path-reconstructed `deletingLastPathComponent()`
    /// — is what makes sandboxed reads actually succeed. See Port 1 notes.
    public var scopeParentURL: URL?

    public var sidecarURL: URL? {
        primaryURL.map { $0.deletingPathExtension().appendingPathExtension("xmp") }
    }

    public var displayName: String {
        if let override = displayNameOverride, !override.isEmpty {
            return override
        }
        return primaryURL?.deletingPathExtension().lastPathComponent ?? "Untitled"
    }

    /// True when the asset should route through the Rust RAW decode path
    /// (rawler → DCP → demosaic → scene-linear chain). False routes through
    /// the Apple non-RAW path (`CGImageSource` → embedded ICC → scene-linear
    /// chain that skips the WB calibration / DCP / demosaic stages).
    ///
    /// Detection prefers the extension when one is available — `dng` is a
    /// RAW format even though `ImageIO` can also decode some DNGs. iPhone
    /// ProRAW lives on this fence and deserves the full pipeline.
    ///
    /// `nil` extension (PhotoKit / Self-Hosted with no hint) defaults to
    /// `true` (RAW) — historical behaviour. Callers that want strict
    /// magic-byte sniffing should call `Self.detectIsRaw(bytes:)` and pass
    /// the result via `AssetRef.init(...)` explicitly.
    public var isRaw: Bool {
        let ext: String
        if let primaryURL {
            ext = primaryURL.pathExtension.lowercased()
        } else if let hint = hintExtension {
            ext = hint.lowercased()
        } else {
            // No URL, no hint — assume RAW so existing PhotoKit / Self-
            // Hosted RAW fixtures keep their behaviour. The non-RAW path
            // is opt-in via an explicit hint extension.
            return true
        }
        if NonRawImageExtensions.all.contains(ext) {
            return false
        }
        // Anything not in the non-RAW set (including the empty string)
        // routes through the RAW path. This covers the entire
        // RAWExtensions.all set plus formats we haven't seen yet.
        return true
    }

    /// Magic-byte sniff for the first ~16 bytes of an image. Used by
    /// PhotoKit's bytes-provider path when the source returns HEIF/JPEG
    /// without forwarding an extension hint. Returns `nil` when the
    /// signature is unrecognised — caller should fall back to extension
    /// detection (or assume RAW per the historical default).
    ///
    /// Signatures:
    ///   - JPEG: `FF D8 FF`
    ///   - PNG:  `89 50 4E 47 0D 0A 1A 0A`
    ///   - HEIF: ftyp box at offset 4 with major brand `heic`/`heix`/
    ///           `mif1`/`heim`/`heis`/`hevc`/`hevm`/`hevs`/`avif`
    public static func detectIsRaw(bytes: Data) -> Bool? {
        guard bytes.count >= 12 else { return nil }
        // JPEG magic.
        if bytes[0] == 0xFF, bytes[1] == 0xD8, bytes[2] == 0xFF {
            return false
        }
        // PNG magic.
        if bytes.count >= 8,
           bytes[0] == 0x89, bytes[1] == 0x50, bytes[2] == 0x4E, bytes[3] == 0x47,
           bytes[4] == 0x0D, bytes[5] == 0x0A, bytes[6] == 0x1A, bytes[7] == 0x0A {
            return false
        }
        // HEIF / HEIC — `ftyp` box at offset 4, brand at offset 8.
        let ftypBytes: [UInt8] = [0x66, 0x74, 0x79, 0x70]  // "ftyp"
        if bytes[4] == ftypBytes[0], bytes[5] == ftypBytes[1],
           bytes[6] == ftypBytes[2], bytes[7] == ftypBytes[3] {
            // Read 4-char brand at offset 8.
            let brand = String(bytes: bytes[8..<12], encoding: .ascii) ?? ""
            let nonRawBrands: Set<String> = [
                "heic", "heix", "mif1", "heim", "heis",
                "hevc", "hevm", "hevs", "avif",
            ]
            if nonRawBrands.contains(brand) {
                return false
            }
        }
        // Unknown signature — caller falls back.
        return nil
    }

    public init(url: URL, scopeParentURL: URL? = nil) {
        self.id = UUID()
        self.primaryURL = url
        self.displayNameOverride = nil
        self.hintExtension = url.pathExtension.isEmpty ? nil : url.pathExtension
        self.bytesProvider = nil
        self.stableID = nil
        self.scopeParentURL = scopeParentURL
    }

    /// Construct an `AssetRef` for a source without a filesystem URL
    /// (PhotoKit, self-hosted API). `bytesProvider` is invoked the first time
    /// the pipeline needs RAW bytes — callers should capture the source actor
    /// weakly, not strongly, if they want the session to deinit cleanly.
    /// `stableID` is the upstream cross-session identifier used as the
    /// thumbnail cache key (e.g. an API maple:id, a PHAsset localIdentifier).
    public init(displayName: String,
                hintExtension: String?,
                stableID: String? = nil,
                bytesProvider: @escaping BytesProvider) {
        self.id = UUID()
        self.primaryURL = nil
        self.displayNameOverride = displayName
        self.hintExtension = hintExtension
        self.bytesProvider = bytesProvider
        self.stableID = stableID
        self.scopeParentURL = nil
    }

    public static func == (lhs: AssetRef, rhs: AssetRef) -> Bool {
        lhs.id == rhs.id
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

// MARK: - EditSession

/// Per-image editing session. Observed by SwiftUI via the `@Observable` macro;
/// use `@State` / `@Bindable` in views, not `@ObservedObject`.
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
    public private(set) var originalModel: AdjustmentModel

    /// As-shot white balance read from the RAW file's metadata via
    /// `CIRAWFilter`. `nil` when the file is not a recognized RAW or when
    /// metadata is unreadable. Populated by `loadSidecar()` on session open;
    /// used by:
    ///   • `ImageEditPipeline.process(...)` — passed as the `neutral` input
    ///     to `CITemperatureAndTint` so the Temperature slider behaves like
    ///     Lightroom's (slider = scene white point, default = as-shot).
    ///   • DetailPanel's Info tab — surfaced to the user as read-only
    ///     metadata.
    public private(set) var asShotCCT: Double?
    public private(set) var asShotTint: Double?

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
    public private(set) var nativeImageSize: CGSize = .zero

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

    // MARK: Internals

    @ObservationIgnored private let pipeline: ImageEditPipeline
    /// File-backed sidecar store. `nil` for sourceless assets (PhotoKit, self-
    /// hosted API) where sidecar persistence goes through the source's
    /// `writeXMP` API instead.
    @ObservationIgnored private let sidecarStore: XMPSidecarStore?
    @ObservationIgnored private var renderTask: Task<Void, Never>?
    @ObservationIgnored private var refineTask: Task<Void, Never>?
    /// Bumped on every render schedule so that stale tasks exit before writing UI state.
    @ObservationIgnored private var renderGeneration: UInt64 = 0

    /// True while `loadSidecar()` is applying persisted state. Hydration must
    /// not behave like a user edit: it should not schedule preview renders
    /// for every session pre-created by the browse grid, and it should not
    /// write sidecars back out while reading them.
    @ObservationIgnored private var isHydratingInitialState = false

    /// Flips on when a caller actually asks this session for pixels. The app
    /// primes sessions for every folder asset so metadata/culling is ready,
    /// but those inactive sessions must stay decode-free until opened.
    @ObservationIgnored private var renderRequested = false

    /// Cached neutral decode for this asset. Populated on the first render
    /// and reused for every subsequent slider tick — the Rust FFI is only
    /// invoked again after `invalidateDecodedCache()` (e.g. on asset reload).
    /// Mirrors the `decodedImage` field in the Maple reference's EditSession.
    @ObservationIgnored private var decodedImage: CIImage?

    /// Actual underlying pixel resolution of `decodedImage` BEFORE the
    /// `decodedForNativeCanvas` upscale. The CIImage's `.extent` reports
    /// the native canvas dims (because that helper applies an affine
    /// scale + crop), but the pixel data is at the original sized-FFI
    /// output resolution — typically ~viewport. The refine path uses
    /// this to decide whether the cached buffer can serve a high-res
    /// target or a fresh native-target decode is needed.
    @ObservationIgnored private var decodedRawResolution: CGSize = .zero
    @ObservationIgnored private var decodedForAssetID: AssetRef.ID?

    /// Plan 2 M3 — model snapshot at the moment `sharedDecode`'s Rust FFI
    /// ran. Used by `processSceneLinear`'s WhiteBalance kernel as the
    /// "decoded WB" reference so the kernel applies only the live delta
    /// and the slider doesn't double-apply on top of Rust-side WB.
    ///
    /// Plan 2 v1 limitation: only WB uses this; tone/vibrance/saturation
    /// will double-apply on saved sidecars until the user moves a slider
    /// (which triggers a re-decode at the new model). Plan 2 v2 generalises
    /// the delta to every kernel.
    @ObservationIgnored public private(set) var decodedAtModel: AdjustmentModel?

    /// In-flight decode task for the current asset. When a render phase
    /// needs a fresh decode and finds no cache, it either starts a new task
    /// here or awaits the existing one. This deduplicates concurrent cold
    /// decodes that would otherwise fire when `previewSize` / `pixelScale`
    /// cascade multiple scheduleRender/scheduleRefine calls while the first
    /// Rust FFI call is still running. Cleared by `invalidateDecodedCache`
    /// and whenever the current task finishes.
    @ObservationIgnored private var decodeTask: Task<CIImage?, Never>?
    @ObservationIgnored private var decodeTaskAssetID: AssetRef.ID?

    /// Ticket 10 item H — refine-decode coalescer. Maps `(asset, target)`
    /// to an in-flight `decodeSceneLinearSized` task so that two refine
    /// schedules at the same target collapse to one Rust call.
    ///
    /// Why this exists: `_scheduleRefine`'s 250 ms debounce + the
    /// stale-gen bail-out in `decodeAndRender` (commit `d4eed05`) both
    /// fire BEFORE the decode starts. Once a refine is inside the
    /// synchronous Rust call (~10 s on a 100 MP RAW), nothing
    /// short-circuits a sibling refine that arrives a moment later — it
    /// passes the gen check, enters the Rust call in parallel, and only
    /// the second result publishes (the first is wasted CPU). The
    /// coalescer fixes the race: the second arrival sees the in-flight
    /// task and awaits its value instead of starting its own.
    ///
    /// The stale-gen bail-out is preserved as a fast-fail check — when
    /// it catches the race the coalescer never gets called, which keeps
    /// the dictionary cleaner. When the bail-out misses (both tasks
    /// past it), the coalescer is the safety net.
    ///
    /// Keyed by `(asset.id, integer-rounded width × height)` because the
    /// target sizes that arrive at the refine boundary are point-derived
    /// floats whose fractional bits aren't load-bearing — two refines
    /// with target widths 1500.0 and 1500.0001 should still collapse.
    @ObservationIgnored private var refineDecodeTasks: [RefineDecodeKey: RefineDecodeSlot] = [:]
    @ObservationIgnored private var refineDecodeSlotCounter: UInt64 = 0

    /// Slot value paired with a `Task<CIImage?, Never>` so cleanup at
    /// task completion can match its own insertion (vs. a sibling that
    /// raced in via `invalidateDecodedCache` + a new schedule). `Task`
    /// itself is a value type — no `===` to compare instances — so we
    /// disambiguate via a monotonically-increasing slot id.
    fileprivate struct RefineDecodeSlot {
        let id: UInt64
        let task: Task<CIImage?, Never>
    }

    /// Composite key for the refine-decode coalescer dictionary. Hashes
    /// asset identity together with integer-quantised target dimensions
    /// so floating-point jitter from layout passes doesn't bypass the
    /// dedupe.
    fileprivate struct RefineDecodeKey: Hashable {
        let assetID: AssetRef.ID
        let widthPx: Int
        let heightPx: Int

        init(assetID: AssetRef.ID, target: CGSize) {
            self.assetID = assetID
            self.widthPx = Int(target.width.rounded())
            self.heightPx = Int(target.height.rounded())
        }
    }

    // MARK: Deep zoom (Plan 3 / Ticket 06 M4)

    /// Tile manager for deep-zoom (`pixelScale >= 1.0`) refine renders.
    /// Created lazily on the first deep-zoom request so that
    /// fit-mode-only sessions never allocate one. Shares the
    /// process-wide `RawImageCache.shared` so the rawler decode is
    /// reused across sessions and tile fetches.
    @ObservationIgnored private var tileManager: TileManager?

    /// Background task that listens to `tileManager.events()` and
    /// re-kicks `_scheduleRefine()` whenever a tile lands. Cancelled
    /// when the asset switches or the session deinits.
    @ObservationIgnored private var tileEventsTask: Task<Void, Never>?

    /// Visible region in oriented full-image source-pixel coords. Set
    /// by `FullImageView` via `updateTileVisibleRegion(viewport:zoom:)`.
    /// `_scheduleRefine`'s deep-zoom branch reads this when targeting
    /// the tile manager. `.zero` disables the deep-zoom branch.
    public private(set) var viewportSourceRect: CGRect = .zero

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
    private var fastTargetSize: CGSize? {
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
    private var refinedTargetSize: CGSize? {
        canvasMath.refinedTargetSize
    }

    // MARK: Init

    public init(asset: AssetRef,
                model: AdjustmentModel = .default,
                culling: CullingState = CullingState()) {
        self.asset = asset
        self.model = model
        self.originalModel = model
        self.culling = culling
        self.pipeline = ImageEditPipeline()
        if let url = asset.primaryURL {
            self.sidecarStore = XMPSidecarStore(rawURL: url)
        } else {
            // Sourceless asset — XMP writes go through the source's REST /
            // PhotoKit-companion writer, not a local .xmp sidecar.
            self.sidecarStore = nil
        }
    }

    // MARK: - Public API

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

    // MARK: Deep zoom (Plan 3 / Ticket 06 M4)

    /// FullImageView calls this from the magnification gesture, the
    /// ⌘1/⌘=/⌘- toolbar shortcuts, and (on macOS) the Cmd+scroll
    /// handler. Updates the visible source-pixel rect for the tile
    /// manager and the live `pixelScale`. When `zoom` changes
    /// meaningfully (epsilon = 0.01) we re-schedule a refine so the
    /// deep-zoom branch in `_scheduleRefine` re-routes through the
    /// tile manager. Pure pan with the same zoom triggers a refine
    /// reschedule too — the tile composite has to retarget the new
    /// visible region.
    public func updateTileVisibleRegion(viewport: CGRect, zoom: CGFloat) {
        let prevRect = viewportSourceRect
        let prevZoom = pixelScale
        viewportSourceRect = viewport
        pixelScale = zoom  // didSet on pixelScale will reschedule when changed
        // If zoom didn't change but the viewport rect did (pure pan),
        // pixelScale.didSet won't fire — kick a refine here. Use a
        // small tolerance so a sub-pixel jitter doesn't trigger a
        // reschedule storm during a pinch.
        if abs(zoom - prevZoom) <= 0.01,
           !prevRect.equalTo(viewport) {
            _scheduleRefine()
        }
    }

    /// Compute the visible region in oriented full-image source-pixel
    /// coords from the on-screen viewport (in points), the current
    /// zoom (real-px-per-image-px), the native image extent, and the
    /// current pan offset (in points; positive = image dragged right /
    /// down). `displayScale` is points → real pixels.
    ///
    /// Thin forwarder around `CanvasMath.visibleSourceRect`; kept on
    /// `EditSession` so existing call sites (`FullImageView`,
    /// `EditSessionDeepZoomTests`) don't have to thread the value type
    /// in just to read this one rect. The actual math lives in
    /// `CanvasMath` (Ticket 10 item I).
    ///
    /// Important contract difference vs. `CanvasMath.visibleSourceRect`:
    /// here `zoom == 0` is treated as "disabled" and returns `.zero`
    /// (the deep-zoom branch in `_scheduleRefine` reads `.isEmpty` to
    /// decide whether to route through the tile manager). `CanvasMath`
    /// treats `pixelScale == 0` as "fit" and resolves it. Callers that
    /// pass a literal zero through this helper (e.g. fit-mode toolbar
    /// reset) want the disabled semantics; the View already
    /// pre-resolves `pixelScale` to a non-zero value via
    /// `effectivePixelScale` before calling here.
    ///
    /// `nonisolated` so callers (`FullImageView` at construction time,
    /// `MapleCoreTests` off-main) can invoke it without an actor hop.
    nonisolated public static func computeVisibleSourceRect(
        viewport: CGSize,
        zoom: CGFloat,
        imageSize: CGSize?,
        panOffset: CGSize,
        displayScale: CGFloat
    ) -> CGRect {
        // Preserve the disabled-on-zero contract — `CanvasMath`'s
        // `visibleSourceRect` would resolve 0 → fit and return a real
        // rect. Tests + deep-zoom branch depend on `.zero` here.
        guard zoom > 0 else { return .zero }
        let viewportPx = CGSize(
            width: viewport.width * displayScale,
            height: viewport.height * displayScale
        )
        let canvas = CanvasMath(
            viewportPx: viewportPx,
            nativeImageSize: imageSize ?? .zero,
            pixelScale: zoom,
            panOffset: panOffset,
            displayScale: displayScale
        )
        return canvas.visibleSourceRect
    }

    /// Load model + culling from disk; call once after init.
    ///
    /// Flow:
    ///   1. Read the file's as-shot WB via ImageIO (cheap — no decode).
    ///   2. Try to load the XMP sidecar.
    ///   3. If the sidecar exists, trust its values (user edits).
    ///   4. If no sidecar, seed `temperature` + `tint` from the as-shot WB
    ///      so the slider defaults to what the camera was metered at.
    ///
    /// Hydration is silent for sessions pre-created by the browse grid; a
    /// render is scheduled only if the editor has already requested pixels.
    public func loadSidecar() async {
        // (1) As-shot white balance — needed by Browse so the WB chip
        // shows the correct value without opening the editor. Cheap
        // (CIRAWFilter property reads, no decode).
        //
        // `seedNativeImageSizeFromMetadata` is intentionally deferred
        // to `ensureRenderStarted()`. Reading the canonical sensor dims
        // builds a `CIRAWFilter` per asset; running it for every
        // session in the browse grid trips a long stall on iPad with
        // many fixtures. Native dims are only consumed by FullImageView
        // (canvas frame, fit math), so the read can wait until the
        // user actually opens the asset.
        if let url = asset.primaryURL {
            if let asShot = ImageMetadataReader.readAsShotWB(from: url) {
                self.asShotCCT = asShot.temperature
                self.asShotTint = asShot.tint
            }
        }

        // (2) XMP sidecar — absent for fresh images.
        var loadedModel: AdjustmentModel? = nil
        var loadedCulling: CullingState? = nil
        let sidecarExists = asset.sidecarURL
            .map { FileManager.default.fileExists(atPath: $0.path) } ?? false
        if let store = sidecarStore,
           let (m, c) = try? await store.load() {
            if sidecarExists {
                loadedModel = m
                loadedCulling = c
            }
        }

        // (3/4) Build the initial model. As-shot seeding only applies when
        // no sidecar was loaded — once the user has saved edits, their
        // stored temperature wins.
        let base = Self.initialModel(
            loadedModel: loadedModel,
            asShotCCT: asShotCCT,
            asShotTint: asShotTint
        )

        let previousModel = model
        isHydratingInitialState = true
        if let loadedCulling {
            culling = loadedCulling
        }
        originalModel = base
        model = base
        isHydratingInitialState = false

        if renderRequested, model != previousModel {
            _scheduleRender(phase: .fast)
        }
    }

    static func initialModel(
        loadedModel: AdjustmentModel?,
        asShotCCT: Double?,
        asShotTint: Double?
    ) -> AdjustmentModel {
        var base = loadedModel ?? .default
        if loadedModel == nil,
           let cct = asShotCCT, let tint = asShotTint {
            base.temperature = cct
            base.tint = tint
        }
        return base
    }

    /// Force a full-resolution render immediately (useful before export).
    public func renderFull() async {
        renderRequested = true
        await decodeAndRender(targetSize: nil, phase: .refine)
    }

    /// Bake the current model against a fresh full-quality decode for export.
    ///
    /// The editor's cached `decodedImage` comes from a half-res preview
    /// decode (`Quality.preview` — quad demosaic) so slider ticks stay
    /// responsive on a 100 MP RAW. Reusing that cache for export would ship
    /// preview-quality pixels to disk. This entry point bypasses the cache
    /// and runs the parity-gated `Quality.full` path; intentionally slow,
    /// call only from explicit export flows.
    ///
    /// Plan 2 v2 v5: routes through the scene-linear FFI + processSceneLinear
    /// chain — same path the editor uses for previews. The legacy `decode` /
    /// `process` chain that ran in the wrong color space on AgX-baked sRGB
    /// u8 has been deleted.
    public func renderForExport() async throws -> CIImage {
        let asset = self.asset
        let pipeline = self.pipeline
        let m = self.model
        let asShot: ImageEditPipeline.AsShotWB? = {
            guard let cct = asShotCCT, let t = asShotTint else { return nil }
            return ImageEditPipeline.AsShotWB(temperature: cct, tint: t)
        }()

        // Non-RAW export — ImageIO decode + non-RAW chain. Skip the Rust
        // FFI entirely (which would reject HEIF / JPEG bytes).
        if !asset.isRaw {
            guard let decoded = await pipeline.decodeSceneLinearNonRaw(
                asset: asset, targetSize: nil
            ) else {
                throw RenderError.pipelineFailed
            }
            return await Task.detached(priority: .userInitiated) {
                pipeline.processSceneLinearNonRaw(
                    decoded: decoded, model: m, targetSize: nil
                )
            }.value
        }

        // Pass the asset's sidecar URL through to the scene-linear FFI so
        // the Rust path applies highlight_recovery (Apple-irreplaceable
        // pre-DCP stage). The FFI also pre-applies the rest of the model
        // at decode time; the `decodedAtModel` capture below reflects that.
        let sidecar: URL? = {
            guard let url = asset.sidecarURL,
                  FileManager.default.fileExists(atPath: url.path)
            else { return nil }
            return url
        }()
        guard let decoded = await pipeline.decodeSceneLinear(
            asset: asset, quality: .full, xmpPath: sidecar
        ) else {
            throw RenderError.pipelineFailed
        }
        // Mirror processSceneLinear's WB-delta semantics: the Rust path
        // applied the sidecar at decode, so feed the kernel chain the
        // model the FFI used so WB doesn't double-apply.
        let exportDecodedAtModel = Self.parseSidecarModel(for: asset)
        return await Task.detached(priority: .userInitiated) {
            pipeline.processSceneLinear(
                decoded: decoded,
                model: m,
                targetSize: nil,
                asShot: asShot,
                decodedAtModel: exportDecodedAtModel
            )
        }.value
    }

    /// Kick off a render for the current model. Views call this in `.task`
    /// when they become the active editor so the first frame doesn't wait
    /// on a slider move. Cheap to call redundantly — reuses the decoded
    /// cache when present.
    ///
    /// Perf: on a fresh asset the Rust decode path can take several seconds
    /// for a big RAW (CR2 / NEF at 50+ MP). To keep the editor responsive we
    /// read the file's embedded JPEG preview via ImageIO first (~50 ms) and
    /// publish it as `renderedPreview`, then let the real develop replace it
    /// when it lands. The preview never sticks once a Maple render is in
    /// `decodedImage` — the guard above returns early on revisit.
    public func ensureRenderStarted() {
        renderRequested = true
        if let url = asset.primaryURL {
            seedNativeImageSizeFromMetadata(url)
        }
        guard renderedPreview == nil || decodedForAssetID != asset.id else { return }
        editSessionSignposter.emitEvent("open")
        // Sub-second open strategy: seed `decodedImage` from whatever's
        // fastest to get hold of (cache hit → embedded JPEG), then kick
        // the fast-phase filter chain. That unlocks slider interaction
        // within ~50 ms because `decodeAndRender`'s hot path reuses the
        // cached decode instead of blocking on `sharedDecode` (~15–20 s
        // on a 100 MP RAW). The real Rust decode still runs in the
        // background; when it lands, `sharedDecode` overwrites
        // `decodedImage` with the full-quality output and a follow-up
        // `_scheduleRender(.fast)` re-processes the current model against
        // it — quality silently upgrades without the user losing
        // responsiveness.
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.openAssetPipelineAsync()
        }
    }

    /// Orchestrates the cold-open path so the fast-phase filter chain
    /// has a `decodedImage` to work against before the expensive Rust
    /// decode completes. All three inputs (disk cache, embedded JPEG,
    /// Rust decode) are attempted; the first one back seeds the cached
    /// slot so sliders become responsive. Later inputs overwrite the
    /// slot only when they're strictly better (cache → embedded →
    /// Rust). Each seed triggers a `_scheduleRender(.fast)` so the view
    /// upgrades as better sources land.
    @MainActor
    private func openAssetPipelineAsync() async {
        let pipeline = self.pipeline
        let openedAsset = self.asset

        // Kick the background Rust decode early — it's the slowest,
        // latency-hiding it behind the preview paths matters most. This
        // task also writes `nativeImageSize` + `decodedImage` when it
        // completes via `sharedDecode`'s tail.
        let rustTask: Task<Void, Never> = Task { [weak self] in
            guard let self else { return }
            _ = await self.sharedDecode(asset: openedAsset, pipeline: pipeline)
            // Re-render against the Rust output when it lands (but only
            // if we're still on the same asset).
            if self.asset.id == openedAsset.id {
                self._scheduleRender(phase: .fast)
            }
        }

        // Try the disk cache first — it's the last-known-good develop
        // and lands in ~10 ms if present.
        let cachedHit = await mapleStageAsync("cached preview lookup") {
            await self.seedFromCachedPreview(for: openedAsset)
        }
        if cachedHit {
            self._scheduleRender(phase: .fast)
        }

        // Embedded JPEG — camera-baked preview, ~50 ms via ImageIO. Seeds
        // `decodedImage` so sliders have something to filter against
        // even if there was no cache hit. Won't overwrite a preceding
        // cache seed because the guards check `decodedForAssetID`.
        let embeddedHit = await mapleStageAsync("embedded preview seed") {
            await self.seedFromEmbeddedPreview(for: openedAsset)
        }
        if embeddedHit {
            self._scheduleRender(phase: .fast)
        }

        // Wait for the Rust task so this driver routine doesn't leave a
        // dangling reference. We already triggered the re-render above.
        await rustTask.value
    }

    /// Synchronous URL-driven seed. Used by `decodedForNativeCanvas` (the
    /// hot render path) and by `ensureRenderStarted`. Sourceless assets
    /// (no `primaryURL`) need the async variant below — they have to pull
    /// bytes through `bytesProvider` first.
    private func seedNativeImageSizeFromMetadata(_ url: URL) {
        guard nativeImageSize == .zero,
              let size = ImageMetadataReader.readPixelSize(from: url)?.cgSize,
              size.width > 0,
              size.height > 0
        else { return }
        nativeImageSize = size
    }

    /// Sourceless-aware variant. PhotoKit and Self-Hosted assets surface
    /// bytes through `bytesProvider` without a stable URL — without this
    /// path `nativeImageSize` stays zero and `imageExtent` returns nil, so
    /// the canvas shows the placeholder forever (audit fix A / Ticket 10
    /// item J). Reads bytes through the provider, runs the Data-based
    /// `readPixelSize` (which walks every subimage exactly like the URL
    /// path), and writes the result back on the main actor.
    @MainActor
    private func seedNativeImageSizeFromMetadataAsync(_ asset: AssetRef) async {
        guard nativeImageSize == .zero else { return }
        if let url = asset.primaryURL {
            seedNativeImageSizeFromMetadata(url)
            return
        }
        guard let provider = asset.bytesProvider else { return }
        guard let data = try? await provider() else { return }
        let hint = asset.hintExtension
        // Re-check identity + native-size after the await — the user may
        // have switched assets while bytes were fetching.
        guard nativeImageSize == .zero, self.asset.id == asset.id else { return }
        guard let size = ImageMetadataReader
            .readPixelSize(from: data, identifierHint: hint)?.cgSize,
              size.width > 0, size.height > 0
        else { return }
        nativeImageSize = size
    }

    private func decodedForNativeCanvas(_ decoded: CIImage, asset: AssetRef) -> CIImage {
        let decodedSize = decoded.extent.size
        if nativeImageSize == .zero, let url = asset.primaryURL {
            seedNativeImageSizeFromMetadata(url)
        } else if nativeImageSize == .zero, asset.bytesProvider != nil {
            // Sourceless asset — bytes-based seed is async; kick it off so
            // a subsequent render hop sees the real native size. The
            // current call returns the unscaled decode (the guard below
            // bails when nativeImageSize is still zero) which is correct:
            // the next `_scheduleRender` after the seed lands will
            // re-normalise to the real canvas.
            Task { @MainActor [weak self] in
                guard let self else { return }
                await self.seedNativeImageSizeFromMetadataAsync(asset)
                if self.asset.id == asset.id, self.nativeImageSize != .zero {
                    self._scheduleRender(phase: .fast)
                }
            }
        }
        // ONLY metadata is allowed to seed `nativeImageSize`. Earlier
        // versions of this method had a "slack-grow" path that wrote
        // `decodedSize` whenever it was 10% larger than the current
        // native — but the SIZED-FFI buffer's dimensions are
        // VIEWPORT-DERIVED (target ≈ viewport-edge × displayScale, NOT
        // sensor dims). User reported on iPad: 100 MP image → first
        // sized FFI returned 2084×1389 → slack-grow promoted it to
        // "native" → "100%" rendered at 2084 px instead of ~12000.
        // Trusting metadata exclusively means the canvas waits for a
        // real sensor-dim seed before showing pixels at all (better
        // than the wrong scale). When metadata is unavailable for an
        // asset (PhotoKit / Self-Hosted), the canvas waits forever —
        // tracked in audit fix A (sourceless-metadata path).

        guard nativeImageSize.width > 0,
              nativeImageSize.height > 0,
              decodedSize.width > 0,
              decodedSize.height > 0
        else { return decoded }

        let sx = nativeImageSize.width / decodedSize.width
        let sy = nativeImageSize.height / decodedSize.height
        guard sx.isFinite, sy.isFinite, sx > 0, sy > 0 else { return decoded }
        guard abs(sx - 1) > 0.01 || abs(sy - 1) > 0.01 else { return decoded }

        let decodedAspect = decodedSize.width / decodedSize.height
        let nativeAspect = nativeImageSize.width / nativeImageSize.height
        guard abs(decodedAspect - nativeAspect) / nativeAspect < 0.03 else { return decoded }

        editSessionLogger.debug(
            "normalizing decoded extent \(decodedSize.width)x\(decodedSize.height) to native canvas \(self.nativeImageSize.width)x\(self.nativeImageSize.height)"
        )
        let originNormalized = decoded.transformed(by: CGAffineTransform(
            translationX: -decoded.extent.origin.x,
            y: -decoded.extent.origin.y
        ))
        return originNormalized
            .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
            .cropped(to: CGRect(origin: .zero, size: nativeImageSize))
    }

    /// Returns true if a cached rendered preview was loaded and the
    /// session state was updated (`decodedImage` / `renderedPreview`).
    /// No-op + false when there's no cache hit or the asset switched.
    @MainActor
    private func seedFromCachedPreview(for asset: AssetRef) async -> Bool {
        guard let url = asset.primaryURL else { return false }
        guard renderedPreview == nil, decodedForAssetID != asset.id else { return false }
        let w = Int(max(previewSize.width, 1))
        let cached = await RenderedPreviewCache.shared
            .preview(for: url, screenWidth: w)
        guard let cached else { return false }
        guard self.asset.id == asset.id, decodedForAssetID != asset.id else { return false }
        renderedPreview = cached
        decodedImage = decodedForNativeCanvas(cached, asset: asset)
        decodedRawResolution = cached.extent.size
        decodedForAssetID = asset.id
        editSessionLogger.debug(
            "cached preview seeded decode extent=\(cached.extent.width)x\(cached.extent.height)"
        )
        return true
    }

    /// Returns true if the embedded JPEG preview was loaded and seeded
    /// into `decodedImage`. No-op + false when the asset has no
    /// extractable preview, has already been Rust-decoded, or the asset
    /// switched mid-await.
    @MainActor
    private func seedFromEmbeddedPreview(for asset: AssetRef) async -> Bool {
        guard let url = asset.primaryURL else { return false }
        guard decodedForAssetID != asset.id else { return false }
        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        let ci: CIImage? = await Task.detached(priority: .userInitiated) { () -> CIImage? in
            let accessing = scope.startAccessingSecurityScopedResource()
            defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
            return Self.readEmbeddedPreview(from: url)
        }.value
        guard let ci else { return false }
        guard self.asset.id == asset.id, decodedForAssetID != asset.id else { return false }
        renderedPreview = ci
        decodedImage = decodedForNativeCanvas(ci, asset: asset)
        decodedRawResolution = ci.extent.size
        decodedForAssetID = asset.id
        editSessionSignposter.emitEvent("embedded paint")
        editSessionLogger.debug(
            "embedded preview seeded decode extent=\(ci.extent.width)x\(ci.extent.height)"
        )
        return true
    }

    /// Extract the camera's embedded JPEG preview via ImageIO. Returns a
    /// CIImage at up to 2048 px long edge — enough to look sharp in the
    /// editor's viewport without paying full-resolution decode cost.
    nonisolated private static func readEmbeddedPreview(from url: URL) -> CIImage? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        // `FromImageIfAbsent: false` means we only return the camera's
        // pre-baked preview. When a RAW has no embedded preview (rare, but
        // happens with ProRAW passthrough and some synthetic DNGs), ImageIO
        // would otherwise full-decode the Bayer data to synthesize one —
        // which defeats the whole point of this "fast" path. Returning nil
        // lets the caller fall through to the real Rust decode instead.
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: false,
            kCGImageSourceCreateThumbnailFromImageIfAbsent: false,
            kCGImageSourceThumbnailMaxPixelSize: 2048,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCache: false,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
            return nil
        }
        return CIImage(cgImage: cg)
    }

    // MARK: - Cache persistence

    /// Snapshot the current `renderedPreview` into `RenderedPreviewCache`
    /// so a future cold open of this asset can paint pixels instantly.
    /// Called from both the refine path (after refine publishes) and the
    /// refine-skip branch in `_scheduleRefine` — without the latter,
    /// fit-to-window opens (the most common case) never populate the
    /// cache and every cold re-open redoes the Rust pipeline.
    @MainActor
    private func persistCurrentPreviewToCache() {
        guard let url = asset.primaryURL,
              let preview = renderedPreview else { return }
        let capturedImage = preview
        let capturedWidth = Int(max(previewSize.width, 1))
        Task.detached(priority: .utility) {
            await RenderedPreviewCache.shared.storePreview(
                capturedImage, for: url, screenWidth: capturedWidth
            )
        }
    }

    // MARK: - Private render scheduling

    /// Two-phase scheduler. Called on slider changes and on initial load:
    ///   1. Fast pass at `fastTargetSize` — renders at viewport resolution
    ///      so the filter chain stays in the 16ms budget on a 100MP RAW.
    ///   2. 250ms debounce then a refine pass at `refinedTargetSize`.
    ///      Skipped when pixelScale is 0 (fit mode) because refine == fast.
    ///
    /// Generation-counter guards preserved — stale tasks exit before
    /// writing UI state so a folder / image switch mid-render doesn't
    /// clobber the new image's preview.
    private func _scheduleRender(phase: RenderPhase) {
        renderTask?.cancel()
        refineTask?.cancel()
        renderGeneration &+= 1
        let gen = renderGeneration
        editSessionLogger.debug("scheduleRender gen=\(gen) phase=\(String(describing: phase), privacy: .public)")
        renderTask = Task { @MainActor in
            // 50 ms debounce — during a continuous slider drag every
            // micro-tick (~60–120 Hz) lands here; cancelling the previous
            // task + sleeping this one short-circuits the storm. Only the
            // last tick of the drag burst survives to call decodeAndRender.
            try? await Task.sleep(for: .milliseconds(50))
            guard gen == renderGeneration, !Task.isCancelled else { return }
            await decodeAndRender(targetSize: fastTargetSize, phase: .fast, gen: gen)
            guard gen == renderGeneration, !Task.isCancelled else { return }
            _scheduleRefine(gen: gen)
        }
    }

    /// Kick a refine pass without re-running the fast phase. Used for
    /// pan/zoom (pixelScale changed) and viewport resizes where the cached
    /// decoded CIImage is still valid — we just need a different
    /// `targetSize` downstream.
    private func _scheduleRefine(gen requested: UInt64? = nil) {
        refineTask?.cancel()
        let gen = requested ?? renderGeneration
        refineTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            guard gen == renderGeneration, !Task.isCancelled else { return }
            // Plan 3 / Ticket 06 M4 — deep-zoom branch. When the user
            // has zoomed past 1.0 (one source pixel per screen pixel)
            // we route the refine through the tile manager instead of
            // re-running the whole-image scene-linear pipeline. The
            // tile path renders 512² source-pixel tiles on demand and
            // composites them over the upscaled cached preview, so
            // memory stays bounded and slider/pan latency hits the
            // brief's 16 ms target on cache hits. The fit-zoom path
            // below is unchanged for `pixelScale < 1.0`.
            //
            // Gated by `EditSession.deepZoomEnabled`. Default OFF —
            // the per-tile pipeline has known color-discontinuity
            // artifacts at tile boundaries (local-context stages like
            // sharpen/clarity see different overlap context per tile).
            // When OFF, refine falls through to the sized-FFI path
            // below, which renders the full image once at the refined
            // target size — slower at very high zoom but pixel-perfect
            // colors. Flip ON once the per-tile color parity ticket
            // lands.
            if Self.deepZoomEnabled,
               pixelScale >= 1.0,
               !viewportSourceRect.isEmpty,
               let _ = asset.primaryURL {
                await refineDeepZoom(gen: gen)
                return
            }
            // Short-circuit when refine would render at the same (or smaller)
            // target as the most recent fast pass. Avoids a wasted CoreImage
            // pipeline build when the user hasn't actually zoomed in. Persist
            // the fast result first so a cold re-open can paint from the
            // cache — without this, fit-to-window opens (the common case)
            // never populate `RenderedPreviewCache`.
            if let fast = fastTargetSize, let refine = refinedTargetSize,
               refine.width <= fast.width + 1 && refine.height <= fast.height + 1 {
                persistCurrentPreviewToCache()
                return
            }
            await decodeAndRender(targetSize: refinedTargetSize, phase: .refine, gen: gen)
        }
    }

    /// Deep-zoom refine path (Plan 3 Task 8). Lazily spins up the
    /// session's `TileManager`, asks it to composite the visible-tile
    /// set, and republishes the result as `renderedPreview`. The tile
    /// manager fetches missing tiles in the background; this method
    /// returns the composite of currently-cached tiles immediately.
    /// When new tiles land, `tileEventsTask` reschedules a refine so
    /// the composite progressively fills in.
    @MainActor
    private func refineDeepZoom(gen: UInt64) async {
        let mgr = ensureTileManager()
        // Snapshot inputs that the actor call might race against a
        // pixelScale write. We only republish if the gen counter
        // matches at the end.
        let visible = viewportSourceRect
        let zoom = pixelScale
        let assetRef = self.asset
        // Capture the current preview as a fallback for transparent
        // regions of the tile composite. Without it, unloaded portions
        // of the canvas render as BLACK (CGImage from a CIImage with
        // transparent regions over an sRGB workspace fills with black,
        // not preview content). User reported "image goes to black"
        // when the deep-zoom composite published.
        let existingPreview = renderedPreview
        do {
            let composite = try await mgr.update(
                asset: assetRef,
                viewportSourceRect: visible,
                zoom: zoom,
                totalSourceSize: nativeImageSize
            )
            guard gen == renderGeneration, !Task.isCancelled else { return }
            if !composite.extent.isEmpty {
                // Composite the tile-canvas OVER an upscaled version of
                // the existing preview. Tiles cover the visible viewport;
                // the upscaled preview fills everything else (blurry but
                // not black). As more tiles land, more of the canvas
                // becomes pixel-perfect — the rest stays preview-quality.
                renderedPreview = compositeWithPreviewUnderlay(
                    composite,
                    underlay: existingPreview,
                    canvasSize: nativeImageSize
                )
            }
            renderError = nil
        } catch {
            editSessionLogger.error(
                "refineDeepZoom failed gen=\(gen) error=\(String(describing: error), privacy: .public)"
            )
            renderError = error
        }
    }

    /// Place the tile composite (full-canvas extent, transparent where
    /// no tiles loaded) over an upscaled `underlay` (preview-quality
    /// image) so unloaded regions show preview pixels instead of black.
    /// The output extent equals `canvasSize`.
    @MainActor
    private func compositeWithPreviewUnderlay(
        _ composite: CIImage,
        underlay: CIImage?,
        canvasSize: CGSize
    ) -> CIImage {
        let canvasRect = CGRect(origin: .zero, size: canvasSize)
        guard let underlay,
              underlay.extent.width > 0,
              underlay.extent.height > 0,
              canvasSize.width > 0,
              canvasSize.height > 0
        else {
            return composite
        }
        // Scale the underlay to the full canvas. Translate origin to
        // (0, 0) first because some preview-source CIImages carry a
        // non-zero origin (cropped buffers, embedded JPEGs).
        let originNormalized = underlay.transformed(by: CGAffineTransform(
            translationX: -underlay.extent.origin.x,
            y: -underlay.extent.origin.y
        ))
        let sx = canvasSize.width / underlay.extent.width
        let sy = canvasSize.height / underlay.extent.height
        let scaledUnderlay = originNormalized
            .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
            .cropped(to: canvasRect)
        return composite
            .composited(over: scaledUnderlay)
            .cropped(to: canvasRect)
    }

    /// Lazy create the session's `TileManager` and start the
    /// tile-completion subscription. Subsequent calls return the
    /// existing instance. Must be called from the main actor — the
    /// session itself is `@MainActor` so this is implicit.
    @MainActor
    private func ensureTileManager() -> TileManager {
        if let mgr = tileManager { return mgr }
        let mgr = TileManager(rawCache: RawImageCache.shared)
        tileManager = mgr
        // Subscribe to tile-completion events. Each tile insert pokes
        // the refine scheduler so the deep-zoom composite progressively
        // refines. The subscription task lives until the session
        // deinits or the asset switches.
        tileEventsTask?.cancel()
        tileEventsTask = Task { [weak self, weak mgr] in
            guard let mgr else { return }
            // `events()` is actor-isolated; the await hops onto the
            // tile manager's actor to construct the stream. Iterating
            // the stream, however, is just AsyncStream.Iterator —
            // doesn't require staying on the manager's actor.
            let stream = await mgr.events()
            for await _ in stream {
                guard let self else { return }
                if Task.isCancelled { return }
                // Coalesce repaints. _scheduleRefine has its own 250 ms
                // debounce, so a flurry of tile inserts collapses into
                // a single re-composite pass. Hop onto the main actor
                // to call into the session.
                await MainActor.run { self._scheduleRefine() }
            }
        }
        return mgr
    }

    /// Unified render entry point — handles both fast and refine phases
    /// by taking the target size as a parameter. Reuses the cached decoded
    /// CIImage on the hot path so slider ticks skip the Rust FFI.
    private func decodeAndRender(targetSize: CGSize?, phase: RenderPhase, gen: UInt64? = nil) async {
        isRendering = true
        renderPhase = phase
        let m = model
        let asset = self.asset
        let pipeline = self.pipeline
        let cached = decodedImage
        let alreadyDecodedID = decodedForAssetID
        // Plan 2 M3 — snapshot the decode-time model for the WB kernel.
        // On the hot path (`cached != nil`) this is the value persisted
        // by the prior `sharedDecode` call. On the cold path it's
        // refreshed after `sharedDecode` returns below.
        let cachedDecodedAtModel = decodedAtModel
        let asShot: ImageEditPipeline.AsShotWB? = {
            guard let cct = asShotCCT, let t = asShotTint else { return nil }
            return ImageEditPipeline.AsShotWB(temperature: cct, tint: t)
        }()
        editSessionLogger.debug(
            "decodeAndRender begin gen=\(gen ?? 0) phase=\(String(describing: phase), privacy: .public) target=\(targetSize?.width ?? 0)x\(targetSize?.height ?? 0) cached=\(cached != nil)"
        )
        // Signpost interval covers the full decode+process for this phase so
        // Instruments can show fast-pass and refine-pass bars stacked on the
        // same timeline. `.fast` and `.refine` are separate interval names so
        // they appear as independent lanes.
        let phaseName: StaticString = (phase == .fast) ? "fast" : "refine"
        let phaseSignpostID = editSessionSignposter.makeSignpostID()
        let phaseState = editSessionSignposter.beginInterval(phaseName, id: phaseSignpostID)
        defer { editSessionSignposter.endInterval(phaseName, phaseState) }

        let filterStageName: StaticString = (phase == .fast)
            ? "filter chain (.fast)"
            : "filter chain (.refine)"

        do {
            let image: CIImage
            // Refine path needs FULL resolution at the refined target.
            // The shared decode caches a viewport-sized buffer (~1810 px
            // long edge on iPad); processing it for refine would just
            // restretch the same low-res pixels — that's the user's
            // "100% doesn't look full resolution" symptom. Compare
            // against `decodedRawResolution` (the actual pixel
            // dimensions of the cached buffer BEFORE the affine upscale
            // applied by `decodedForNativeCanvas`). The CIImage's
            // `.extent` reports the upscaled native dims and would
            // make this check vacuously false.
            let needsFreshHighResDecode: Bool = {
                guard phase == .refine, let target = targetSize else { return false }
                guard cached != nil, decodedRawResolution.width > 0 else { return true }
                return decodedRawResolution.width + 0.5 < target.width
                    || decodedRawResolution.height + 0.5 < target.height
            }()
            // Dispatch the kernel chain on asset.isRaw — non-RAW skips the
            // WB-calibration kernel (the JPEG was baked at the source-light
            // already) and uses processSceneLinearNonRaw.
            let isRaw = asset.isRaw
            if needsFreshHighResDecode, let target = targetSize {
                // Bail out BEFORE the expensive decode if a newer
                // refine has already been scheduled. Without this,
                // two `decodeAndRender(.refine)` tasks for the same
                // asset can both pass the early `Task.isCancelled`
                // check, hit the 10 s native decode in parallel, and
                // produce two finished results — only the second one
                // is published, the first is wasted work. User saw
                // this directly: the trace logged
                // `[swift] rust FFI scene-linear decode (refine)`
                // twice with two interleaved pipeline runs.
                if let gen, gen != renderGeneration {
                    editSessionLogger.debug(
                        "decodeAndRender gen=\(gen) stale before high-res decode (current=\(self.renderGeneration)), dropping early"
                    )
                    isRendering = false
                    return
                }
                let sidecar: URL? = {
                    guard let url = asset.sidecarURL,
                          FileManager.default.fileExists(atPath: url.path)
                    else { return nil }
                    return url
                }()
                let assetCapture = asset
                let pipelineCapture = pipeline
                // Ticket 10 item H — coalesce concurrent refine decodes
                // by `(asset, target)`. The stale-gen bail-out above is
                // a fast-fail check; this is the safety net for the race
                // where two `decodeAndRender(.refine)` tasks both pass
                // the gen check, both enter the synchronous Rust call,
                // and one's work ends up wasted. Joining the in-flight
                // task here means the second arrival re-uses the first
                // call's result rather than double-decoding.
                let decoded = await coalescedRefineDecode(
                    asset: assetCapture, target: target
                ) {
                    if !isRaw {
                        return await mapleStageAsync("ImageIO non-RAW decode (refine)") {
                            await pipelineCapture.decodeSceneLinearNonRaw(
                                asset: assetCapture, targetSize: target
                            )
                        }
                    }
                    return await mapleStageAsync("rust FFI scene-linear decode (refine)") {
                        await pipelineCapture.decodeSceneLinearSized(
                            asset: assetCapture, targetSize: target, xmpPath: sidecar
                        )
                    }
                }
                guard !Task.isCancelled else {
                    isRendering = false
                    return
                }
                if let gen, gen != renderGeneration {
                    editSessionLogger.debug(
                        "decodeAndRender gen=\(gen) stale after high-res decode (current=\(self.renderGeneration)), dropping result"
                    )
                    isRendering = false
                    return
                }
                guard let decoded else {
                    throw RenderError.pipelineFailed
                }
                let freshDecodedAtModel = self.decodedAtModel
                let processed = await Task.detached(priority: .userInitiated) {
                    mapleStage(filterStageName) {
                        if !isRaw {
                            return pipeline.processSceneLinearNonRaw(
                                decoded: decoded, model: m, targetSize: target
                            )
                        }
                        return pipeline.processSceneLinear(
                            decoded: decoded, model: m, targetSize: target,
                            asShot: asShot, decodedAtModel: freshDecodedAtModel
                        )
                    }
                }.value
                image = processed
            } else if let cached, alreadyDecodedID == asset.id {
                // Cached decode — apply scene-linear chain only. Hot path.
                image = await Task.detached(priority: .userInitiated) {
                    mapleStage(filterStageName) {
                        if !isRaw {
                            return pipeline.processSceneLinearNonRaw(
                                decoded: cached, model: m, targetSize: targetSize
                            )
                        }
                        return pipeline.processSceneLinear(
                            decoded: cached, model: m, targetSize: targetSize,
                            asShot: asShot, decodedAtModel: cachedDecodedAtModel
                        )
                    }
                }.value
            } else {
                // Cold decode — run the Rust FFI once (RAW) or ImageIO once
                // (non-RAW), cache the result. Dedupe: if another render
                // phase is already awaiting a decode for this asset, piggy-
                // back on its Task rather than starting a concurrent one.
                // SwiftUI can fire previewSize and pixelScale didSets in
                // rapid succession as the viewport lays itself out, which
                // used to schedule several cold decodes in parallel — each
                // observing `decodedImage` still nil because no sibling had
                // written it yet. The result was N concurrent Rust FFI
                // decodes on a 100MP RAW with no survivor ever reaching the
                // published-preview assignment. Single in-flight decode per
                // asset fixes it.
                let decoded = await sharedDecode(asset: asset, pipeline: pipeline)
                guard !Task.isCancelled else {
                    isRendering = false
                    return
                }
                guard let decoded else {
                    throw RenderError.pipelineFailed
                }
                // Plan 2 M3 — sharedDecode has just published decodedAtModel
                // (the model the Rust path used for this decode). Capture
                // it here so the WB kernel applies (live - decoded).
                let freshDecodedAtModel = self.decodedAtModel
                // Process is cheap (Metal-kernel chain) — run it per
                // phase with the caller's targetSize. Not shared with peers
                // because targetSize differs between fast and refine.
                let processed = await Task.detached(priority: .userInitiated) {
                    mapleStage(filterStageName) {
                        if !isRaw {
                            return pipeline.processSceneLinearNonRaw(
                                decoded: decoded, model: m, targetSize: targetSize
                            )
                        }
                        return pipeline.processSceneLinear(
                            decoded: decoded, model: m, targetSize: targetSize,
                            asShot: asShot, decodedAtModel: freshDecodedAtModel
                        )
                    }
                }.value
                image = processed
            }

            guard !Task.isCancelled else {
                editSessionLogger.debug("decodeAndRender gen=\(gen ?? 0) cancelled, dropping result")
                isRendering = false
                return
            }
            if let gen, gen != renderGeneration {
                editSessionLogger.debug("decodeAndRender gen=\(gen) stale (current=\(self.renderGeneration)), dropping result")
                isRendering = false
                return
            }
            renderedPreview = image
            renderError = nil
            editSessionLogger.debug(
                "decodeAndRender published preview gen=\(gen ?? 0) extent=\(image.extent.width)x\(image.extent.height)"
            )

            // Refresh the on-disk thumbnail so the browse grid reflects the
            // user's develop (not the camera's embedded preview). Only on
            // the refine pass — the fast pass is viewport-sized and blurry
            // when downscaled to 256 px. Filesystem assets only: sourceless
            // assets don't have a stable URL to key off of.
            if phase == .refine, let url = asset.primaryURL {
                Task.detached(priority: .utility) {
                    await ThumbnailLoader.shared.updateThumbnailFromRender(image, for: url)
                }
                persistCurrentPreviewToCache()
            }
        } catch {
            if let gen, gen != renderGeneration {
                isRendering = false
                return
            }
            // Surface the failure. Without this log a silent decode failure
            // looks identical to "still decoding" from the outside — the
            // viewport just never paints.
            editSessionLogger.error(
                "decodeAndRender failed gen=\(gen ?? 0) phase=\(String(describing: phase), privacy: .public) error=\(String(describing: error), privacy: .public)"
            )
            renderError = error
        }
        isRendering = false
    }

    /// Drop the cached decoded CIImage — call after reloading the sidecar
    /// from disk or when the underlying asset bytes may have changed.
    public func invalidateDecodedCache() {
        decodedImage = nil
        decodedRawResolution = .zero
        decodedForAssetID = nil
        decodeTask = nil
        decodeTaskAssetID = nil
        // Ticket 10 item H — clear the refine-decode coalescer so a fresh
        // schedule against the same `(asset, target)` doesn't piggy-back
        // on a now-stale in-flight decode (which captured the prior
        // sidecar / xmp state). In-flight tasks aren't cancelled here —
        // their detached work runs to completion and their result is
        // dropped by the gen check upstream.
        refineDecodeTasks.removeAll()
        // Plan 2 M3 — the next decode will re-parse the sidecar; clear
        // the cached snapshot so the WB delta can't compose against a
        // stale decode-time model.
        decodedAtModel = nil
        // Plan 3 — drop tile cache for this asset so the next deep-zoom
        // refine starts from a clean slate against the fresh decode.
        // The tile manager is per-session so we just clear it; the
        // events subscription stays alive (it's keyed off this manager
        // instance, not per-asset).
        let mgr = tileManager
        Task { await mgr?.clear() }
    }

    /// Returns the decoded CIImage for `asset`, running the Rust FFI at
    /// most once per asset even if multiple concurrent callers ask for it.
    /// If a peer render phase is already awaiting a decode for the same
    /// asset we piggy-back on that task; otherwise we start a fresh one.
    /// Writes `decodedImage` / `decodedForAssetID` when the task completes.
    private func sharedDecode(
        asset: AssetRef,
        pipeline: ImageEditPipeline
    ) async -> CIImage? {
        if let existing = decodeTask, decodeTaskAssetID == asset.id {
            guard let decoded = await existing.value else { return nil }
            guard self.asset.id == asset.id else { return decoded }
            // Plan 2 M3 — also publish decodedAtModel on the piggy-back
            // path. Idempotent: any prior caller's cold-path tail wrote
            // the same value (same asset, same sidecar parse).
            if decodedAtModel == nil {
                decodedAtModel = Self.parseSidecarModel(for: asset)
            }
            return decodedForNativeCanvas(decoded, asset: asset)
        }
        decodeTask = nil
        decodeTaskAssetID = nil

        // Register the task SYNCHRONOUSLY before any await so sibling
        // callers that arrive during the cache lookup or Rust decode see
        // the in-flight task and piggy-back via the `existing` check
        // above. The previous version `await`-ed
        // `DecodedBufferCache.shared.decoded(for:)` before setting
        // `decodeTask`, so 4–5 concurrent callers could all slip past the
        // guard during that yield and each kick off its own Rust FFI —
        // observable as N concurrent `decodeAndRender published gen=1`
        // lines on cold open and a decode time that scaled with caller
        // count instead of shrinking to one Rust pass.
        let decodeSignpostID = editSessionSignposter.makeSignpostID()
        let decodeState = editSessionSignposter.beginInterval("decode", id: decodeSignpostID)
        // Capture the current viewport size so the scene-linear path can
        // route through the sized FFI when known. Plan 1 v2 Task 8: the
        // sized entry caps the Rust output's long edge at the viewport,
        // dropping the FFI buffer from ~200 MB (half-res scene-linear) to
        // ~12 MB for a 1500-px-long-edge target.
        let capturedViewport = previewSize
        let isRaw = asset.isRaw
        let task: Task<CIImage?, Never> = Task.detached(priority: .userInitiated) { [pipeline] in
            // Decode dispatch — RAW assets go through the Rust FFI; non-RAW
            // (HEIF / HEIC / JPEG / PNG) goes through ImageIO + Core Image.
            // The non-RAW path is Apple-only — see decodeSceneLinearNonRaw
            // in ImageEditPipeline.swift. Web has its own non-RAW path via
            // browser-native Image decode.
            if !isRaw {
                let target: CGSize? = (capturedViewport.width > 1 && capturedViewport.height > 1)
                    ? capturedViewport
                    : nil
                return await mapleStageAsync("ImageIO non-RAW decode") {
                    await pipeline.decodeSceneLinearNonRaw(
                        asset: asset, targetSize: target
                    )
                }
            }

            // Scene-linear FFI routing:
            //   1. Viewport size is known → use the sized FFI entry
            //      (ticket 06 Milestone 2). Output is ~12 MB for a
            //      1500-px-long-edge buffer vs ~200 MB for the half-res
            //      scene-linear buffer.
            //   2. No viewport hint → fall back to the unsized entry
            //      (Task 4) so behavior is no worse than v1.
            //
            // The on-disk DecodedBufferCache (sRGB JPEGs) is bypassed —
            // it can't round-trip extended-range fp16. A follow-up plan
            // revs the cache format; for now scene-linear opens always
            // pay the Rust decode cost.
            //
            // Plan 2 M3 — pass the asset's sidecar URL through to the
            // scene-linear FFI so highlight_recovery (Rust-side, pre-DCP)
            // responds to the saved highlightRecovery setting. Only pass
            // a URL when a sidecar file exists on disk; nil keeps the
            // Rust default model (highlight_recovery = Off) so first-open
            // (no sidecar) behaviour matches Plan 1.
            let sidecar: URL? = {
                guard let url = asset.sidecarURL,
                      FileManager.default.fileExists(atPath: url.path)
                else { return nil }
                return url
            }()
            let decoded: CIImage?
            if capturedViewport.width > 1, capturedViewport.height > 1 {
                decoded = await mapleStageAsync("rust FFI scene-linear decode") {
                    await pipeline.decodeSceneLinearSized(
                        asset: asset, targetSize: capturedViewport,
                        xmpPath: sidecar
                    )
                }
            } else {
                decoded = await mapleStageAsync("rust FFI scene-linear decode") {
                    await pipeline.decodeSceneLinear(asset: asset, xmpPath: sidecar)
                }
            }
            guard let decoded else { return nil }
            return decoded
        }
        decodeTask = task
        decodeTaskAssetID = asset.id

        let decoded = await task.value
        editSessionSignposter.endInterval("decode", decodeState)

        guard self.asset.id == asset.id else { return decoded }
        guard let decoded else {
            if decodeTaskAssetID == asset.id {
                decodeTask = nil
                decodeTaskAssetID = nil
            }
            return nil
        }

        let normalized = decodedForNativeCanvas(decoded, asset: asset)
        decodedImage = normalized
        decodedRawResolution = decoded.extent.size
        decodedForAssetID = asset.id
        // Plan 2 M3 — capture the model the Rust path used during decode
        // so processSceneLinear's WhiteBalance kernel can compute the
        // (live - decoded) delta and avoid double-applying WB. Mirrors
        // the sidecar gate above: nil when no sidecar exists on disk
        // (Rust used .default), or the parsed sidecar model otherwise.
        decodedAtModel = Self.parseSidecarModel(for: asset)
        if decodeTaskAssetID == asset.id {
            decodeTask = nil
            decodeTaskAssetID = nil
        }
        return normalized
    }

    /// Ticket 10 item H — coalesce concurrent refine decodes by
    /// `(asset, target)`. Returns the decoded `CIImage?` from the Rust
    /// FFI, running the underlying call at most once per
    /// `(asset, target)` even when multiple refine schedules race
    /// past the stale-gen bail-out and arrive here in parallel.
    ///
    /// The closure parameter is the actual decode call — usually
    /// `pipeline.decodeSceneLinearSized`, but tests inject a counter so
    /// they can verify N concurrent invocations collapse to one.
    ///
    /// Register-before-await ordering matters: we synchronously install
    /// the task in `refineDecodeTasks` BEFORE the first `await` so a
    /// sibling caller arriving during the Rust call sees the in-flight
    /// task and joins. The same race fix applied to `sharedDecode` —
    /// see commit `3602889`.
    @discardableResult
    internal func coalescedRefineDecode(
        asset: AssetRef,
        target: CGSize,
        decode: @escaping @Sendable () async -> CIImage?
    ) async -> CIImage? {
        let key = RefineDecodeKey(assetID: asset.id, target: target)
        if let existing = refineDecodeTasks[key] {
            editSessionLogger.debug(
                "coalescedRefineDecode joined in-flight task for \(target.width, format: .fixed(precision: 0))x\(target.height, format: .fixed(precision: 0))"
            )
            return await existing.task.value
        }
        refineDecodeSlotCounter &+= 1
        let slotID = refineDecodeSlotCounter
        let task = Task<CIImage?, Never>.detached(priority: .userInitiated) {
            await decode()
        }
        refineDecodeTasks[key] = RefineDecodeSlot(id: slotID, task: task)
        let result = await task.value
        // Cleanup. Only clear if the slot still holds our slot id — an
        // `invalidateDecodedCache` call between register and completion
        // could have nil-ed the dictionary, and a subsequent call could
        // have inserted a new task at the same key. Don't clobber it.
        if refineDecodeTasks[key]?.id == slotID {
            refineDecodeTasks[key] = nil
        }
        return result
    }

    /// Plan 2 M3 — parse the asset's sidecar (if present on disk) into
    /// an AdjustmentModel. Used to capture the decode-time model so the
    /// WhiteBalance kernel can apply only the live-vs-decoded delta.
    /// Returns `.default` when no sidecar exists or the parse fails —
    /// this matches what the Rust path uses on the same condition.
    private static func parseSidecarModel(for asset: AssetRef) -> AdjustmentModel {
        guard let url = asset.sidecarURL,
              FileManager.default.fileExists(atPath: url.path)
        else {
            return .default
        }
        guard let xml = try? String(contentsOf: url, encoding: .utf8) else {
            return .default
        }
        guard let (m, _) = try? XMPParser.parse(xml) else {
            return .default
        }
        return m
    }
}

private extension CGSize {
    var pixelArea: CGFloat {
        width * height
    }
}

// MARK: - RenderError

/// Errors surfaced by `EditSession._render`.
public enum RenderError: Error, LocalizedError, Sendable {
    case pipelineFailed

    public var errorDescription: String? {
        switch self {
        case .pipelineFailed:
            return "Failed to render preview."
        }
    }
}
