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
    public let asset: AssetRef

    // MARK: Model

    public var model: AdjustmentModel {
        didSet {
            guard model != oldValue else { return }
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

    /// Cached neutral decode for this asset. Populated on the first render
    /// and reused for every subsequent slider tick — the Rust FFI is only
    /// invoked again after `invalidateDecodedCache()` (e.g. on asset reload).
    /// Mirrors the `decodedImage` field in the Maple reference's EditSession.
    @ObservationIgnored private var decodedImage: CIImage?
    @ObservationIgnored private var decodedForAssetID: AssetRef.ID?

    /// In-flight decode task for the current asset. When a render phase
    /// needs a fresh decode and finds no cache, it either starts a new task
    /// here or awaits the existing one. This deduplicates concurrent cold
    /// decodes that would otherwise fire when `previewSize` / `pixelScale`
    /// cascade multiple scheduleRender/scheduleRefine calls while the first
    /// Rust FFI call is still running. Cleared by `invalidateDecodedCache`
    /// and whenever the current task finishes.
    @ObservationIgnored private var decodeTask: Task<CIImage?, Never>?
    @ObservationIgnored private var decodeTaskAssetID: AssetRef.ID?

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

    /// Fast-phase target — render at viewport resolution so every filter
    /// intermediate stays small. `nil` falls through to `ImageEditPipeline`'s
    /// built-in 2MP cap.
    private var fastTargetSize: CGSize? {
        previewSize == .zero ? nil : previewSize
    }

    /// Refined-phase target — when the user is zoomed in past fit, bump the
    /// target so we re-render at enough pixels to stay crisp. Fit mode
    /// (pixelScale == 0) leaves refine == fast and the scheduler short-
    /// circuits the refine pass.
    private var refinedTargetSize: CGSize? {
        guard let fast = fastTargetSize else { return nil }
        let mult = max(1.0, pixelScale)
        // Cap at 8× fast size — at that point CoreImage auto-tiling is
        // handling the scene anyway and further growth only hurts memory.
        let clamped = min(mult, 8.0)
        return CGSize(
            width: fast.width * clamped,
            height: fast.height * clamped
        )
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

    /// Load model + culling from disk; call once after init.
    ///
    /// Flow:
    ///   1. Read the file's as-shot WB via ImageIO (cheap — no decode).
    ///   2. Try to load the XMP sidecar.
    ///   3. If the sidecar exists, trust its values (user edits).
    ///   4. If no sidecar, seed `temperature` + `tint` from the as-shot WB
    ///      so the slider defaults to what the camera was metered at.
    ///
    /// A render is scheduled by the final `model = …` write; only one
    /// render fires per session open regardless of which branch runs.
    public func loadSidecar() async {
        // (1) As-shot WB from the RAW file metadata (no decode).
        if let url = asset.primaryURL,
           let asShot = ImageMetadataReader.readAsShotWB(from: url) {
            self.asShotCCT = asShot.temperature
            self.asShotTint = asShot.tint
        }

        // (2) XMP sidecar — absent for fresh images.
        var loadedModel: AdjustmentModel? = nil
        if let store = sidecarStore,
           let (m, c) = try? await store.load() {
            loadedModel = m
            culling = c
        }

        // (3/4) Build the initial model. As-shot seeding only applies when
        // no sidecar was loaded — once the user has saved edits, their
        // stored temperature wins.
        var base = loadedModel ?? .default
        if loadedModel == nil,
           let cct = asShotCCT, let t = asShotTint {
            base.temperature = cct
            base.tint = t
        }
        originalModel = base
        model = base
    }

    /// Force a full-resolution render immediately (useful before export).
    public func renderFull() async {
        await decodeAndRender(targetSize: nil, phase: .refine)
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
        guard renderedPreview == nil || decodedForAssetID != asset.id else { return }
        editSessionSignposter.emitEvent("open")
        // Order matters. `_scheduleRender` bumps `renderGeneration`, and
        // `loadEmbeddedPreviewIfAvailable` snapshots that value to guard its
        // delayed MainActor publish against later navigation. If we called
        // the preview loader first it would capture the pre-bump gen and
        // the guard inside its detached task would always fail — the
        // embedded preview would be silently dropped on every open.
        _scheduleRender(phase: .fast)
        loadEmbeddedPreviewIfAvailable()
    }

    /// Read the file's embedded JPEG preview off the main actor and publish
    /// it as `renderedPreview` so the user sees *something* while the Rust
    /// develop runs. No-op for sourceless assets or when the file has no
    /// extractable preview. Only writes the preview back when the real
    /// render hasn't already landed (`decodedImage == nil`) — the generation
    /// counter guards against races with a concurrent fast pass.
    private func loadEmbeddedPreviewIfAvailable() {
        guard let url = asset.primaryURL else { return }
        let gen = renderGeneration
        let assetID = asset.id
        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        Task.detached(priority: .userInitiated) { [weak self] in
            let accessing = scope.startAccessingSecurityScopedResource()
            defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
            let t0 = Date()
            guard let ci = Self.readEmbeddedPreview(from: url) else { return }
            let ms = Int(Date().timeIntervalSince(t0) * 1000)
            await MainActor.run {
                guard let self else { return }
                // Drop if anything moved under us: the asset changed, the
                // render generation advanced, or a real Maple decode already
                // published a preview.
                guard self.asset.id == assetID,
                      self.renderGeneration == gen,
                      self.decodedForAssetID != self.asset.id,
                      self.decodedImage == nil else {
                    return
                }
                self.renderedPreview = ci
                editSessionSignposter.emitEvent("embedded paint")
                editSessionLogger.debug(
                    "embedded preview published \(ms)ms extent=\(ci.extent.width)x\(ci.extent.height)"
                )
            }
        }
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
            // Short-circuit when refine would render at the same (or smaller)
            // target as the most recent fast pass. Avoids a wasted CoreImage
            // pipeline build when the user hasn't actually zoomed in.
            if let fast = fastTargetSize, let refine = refinedTargetSize,
               refine.width <= fast.width + 1 && refine.height <= fast.height + 1 {
                return
            }
            await decodeAndRender(targetSize: refinedTargetSize, phase: .refine, gen: gen)
        }
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

        do {
            let image: CIImage
            if let cached, alreadyDecodedID == asset.id {
                // Cached decode — apply filter chain only. Hot path.
                image = await Task.detached(priority: .userInitiated) {
                    pipeline.process(decoded: cached, model: m, targetSize: targetSize, asShot: asShot)
                }.value
            } else {
                // Cold decode — run the Rust FFI once, cache the result.
                // Dedupe: if another render phase is already awaiting a
                // decode for this asset, piggy-back on its Task rather than
                // starting a concurrent one. SwiftUI can fire previewSize
                // and pixelScale didSets in rapid succession as the
                // viewport lays itself out, which used to schedule several
                // cold decodes in parallel — each observing `decodedImage`
                // still nil because no sibling had written it yet. The
                // result was N concurrent Rust FFI decodes on a 100MP RAW
                // with no survivor ever reaching the published-preview
                // assignment. Single in-flight decode per asset fixes it.
                let decoded = await sharedDecode(asset: asset, pipeline: pipeline)
                guard let decoded else {
                    throw RenderError.pipelineFailed
                }
                // Process is cheap (CoreImage filter chain) — run it per
                // phase with the caller's targetSize. Not shared with peers
                // because targetSize differs between fast and refine.
                let processed = await Task.detached(priority: .userInitiated) {
                    pipeline.process(decoded: decoded, model: m, targetSize: targetSize, asShot: asShot)
                }.value
                image = processed
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
        decodedForAssetID = nil
        decodeTask = nil
        decodeTaskAssetID = nil
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
            return await existing.value
        }
        // Stale task for a previous asset — drop the reference; its
        // detached work will finish into a value nobody reads, but we
        // don't await it. Happens on asset switch mid-decode.
        decodeTask = nil
        decodeTaskAssetID = nil

        let decodeSignpostID = editSessionSignposter.makeSignpostID()
        let decodeState = editSessionSignposter.beginInterval("decode", id: decodeSignpostID)
        let task = Task.detached(priority: .userInitiated) { [pipeline] () -> CIImage? in
            await pipeline.decode(asset: asset)
        }
        decodeTask = task
        decodeTaskAssetID = asset.id

        let decoded = await task.value
        editSessionSignposter.endInterval("decode", decodeState)

        // Only touch shared cache state when the session is still looking
        // at the same asset. An asset switch during the await would have
        // reassigned decodeTask / decodeTaskAssetID, and we don't want a
        // stale decode to clobber the fresh one.
        if self.asset.id == asset.id {
            if let decoded {
                decodedImage = decoded
                decodedForAssetID = asset.id
            }
            if decodeTaskAssetID == asset.id {
                decodeTask = nil
                decodeTaskAssetID = nil
            }
        }
        return decoded
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
