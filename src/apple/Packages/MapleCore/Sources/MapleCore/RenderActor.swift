// RenderActor.swift — actor boundary for the per-image render pipeline.
//
// Slice 3 of 3 — issue #194. This file now owns:
//   • The decoded-image cache + FFI decode coalescers (slice 2)
//   • The two-phase scheduler — fast / refine task handles, debounce
//     timers, generation counter, slider-drag coalescing (slice 3)
//
// EditSession (MainActor) is now a thin caller: it owns the observable
// publish state (`renderedPreview`, `renderPhase`, `isRendering`,
// `renderError`) and the model/culling/canvas math. Slider ticks and
// other render-triggering mutations call `await renderActor.schedule…(…)`
// — the actor cancels the in-flight task and debounces the storm into a
// single fast publish + (optionally) a refine publish.
//
// Surface (cumulative across all 3 slices):
//
//   • `init(pipeline:)`
//   • `renderPreview(asset:model:)`               — slice 1 boundary check
//   • `renderForExport(asset:model:asShot:)`      — slice 2
//   • `sharedDecode(asset:normalize:)`            — slice 2
//   • `coalescedRefineDecode(asset:target:decode:)` — slice 2
//   • `invalidate()`                              — slice 2
//   • `snapshot(forAsset:)`                       — slice 2
//   • `seed(...)` / `seedIfUnpopulated(...)`      — slice 2
//   • `scheduleRender(phase:work:)`               — slice 3
//   • `scheduleRefine(work:)`                     — slice 3
//   • `cancelAll()`                               — slice 3
//   • `currentGeneration()`                       — slice 3
//
// The scheduler API takes a `@Sendable` closure parameterised on a
// `UInt64` generation counter — the closure does the actual filter-chain
// work (still on MainActor — see EditSession+Render.swift) and checks
// `await renderActor.currentGeneration() == gen` before publishing.
// This lets the heavy CPU work stay anchored to MainActor (where it
// needs to read `previewSize` / `pixelScale` / `nativeImageSize` /
// `asShotCCT,Tint` / `renderedPreview` for the composite underlay) while
// the actor owns the cancel/coalesce/debounce decisions.
//
// Two-phase semantics (matches CLAUDE.md § Performance invariants):
//
//   • Fast phase — runs immediately on every schedule. Slider drag at
//     60–120 Hz lands here; the previous in-flight task is cancelled
//     before the new one launches so only the most recent tick reaches
//     the filter chain.
//   • Refine phase — debounced 150 ms after the last schedule. During a
//     continuous drag the refine task is cancelled on every tick; it
//     only fires once the user pauses. The refine debounce is the
//     "drag coalescer" — many ticks collapse into one full-resolution
//     refine pass when the drag settles.
//
// Cancellation contract:
//
//   • `scheduleRender(phase:)` cancels the previous `renderTask` AND
//     the previous `refineTask` synchronously (under the actor's
//     isolation), bumps `renderGeneration`, then spawns a new
//     `renderTask`. The closure receives the post-bump generation
//     counter and is responsible for honouring `Task.isCancelled` and
//     the gen-counter check.
//   • `scheduleRefine()` cancels only the previous `refineTask`. It
//     does NOT bump the generation counter — refine schedules during a
//     pan/zoom or window resize must not invalidate the most recent
//     fast publish.

import Foundation
import CoreImage

/// Per-session actor boundary for the render pipeline. Owns the decoded-
/// image cache (slice 2) plus the two-phase scheduler (slice 3).
public actor RenderActor {
    /// Shared GPU pipeline (Metal kernels + `CIContext`). Constructed by
    /// `EditSession` and handed in — keeping a single `ImageEditPipeline`
    /// per session preserves the current GPU-resource lifetime.
    private let pipeline: ImageEditPipeline

    // MARK: - Decoded-image cache state (slice 2)

    private var decodedImage: CIImage?
    private var decodedRawResolution: CGSize = .zero
    private var decodedForAssetID: AssetRef.ID?
    private var decodedSidecarMtime: Date?
    private var decodedAtModel: AdjustmentModel?

    private var decodeTask: Task<CIImage?, Never>?
    private var decodeTaskAssetID: AssetRef.ID?

    private var refineDecodeTasks: [RefineDecodeKey: RefineDecodeSlot] = [:]
    private var refineDecodeSlotCounter: UInt64 = 0

    struct RefineDecodeSlot {
        let id: UInt64
        let task: Task<CIImage?, Never>
    }

    struct RefineDecodeKey: Hashable {
        let assetID: AssetRef.ID
        let widthPx: Int
        let heightPx: Int

        init(assetID: AssetRef.ID, target: CGSize) {
            self.assetID = assetID
            self.widthPx = Int(target.width.rounded())
            self.heightPx = Int(target.height.rounded())
        }
    }

    public struct DecodedSnapshot: Sendable {
        public let image: CIImage?
        public let decodedAtModel: AdjustmentModel?
        public let rawResolution: CGSize
        public let isFresh: Bool
    }

    // MARK: - Scheduler state (slice 3)

    /// Current render task — fast phase, kicked synchronously per
    /// schedule call. `scheduleRender` cancels this before spawning the
    /// next one.
    private var renderTask: Task<Void, Never>?

    /// Current refine task — wraps the 150 ms debounce sleep plus the
    /// refine work. Cancelled on every schedule (both `scheduleRender`
    /// and `scheduleRefine`) so a continuous slider drag collapses to a
    /// single refine pass at the tail.
    private var refineTask: Task<Void, Never>?

    /// Monotonic generation counter — bumped on every `scheduleRender`
    /// (NOT on `scheduleRefine`). The render closure receives its
    /// generation at spawn time and must re-read `currentGeneration()`
    /// (or compare against the captured `gen`) before publishing so
    /// stale results from a superseded schedule don't clobber the
    /// preview produced by the newer one.
    private var renderGeneration: UInt64 = 0

    /// Refine debounce — 150 ms matches CLAUDE.md § Performance
    /// invariants. Slice-2 EditSession used 250 ms; slice 3 aligns to
    /// the spec. The shorter delay makes the refine pass land sooner
    /// after the user stops dragging without measurably hurting the
    /// coalesce ratio on a continuous slider drag.
    public static let refineDebounceMilliseconds: UInt64 = 150

    public init(pipeline: ImageEditPipeline) {
        self.pipeline = pipeline
    }

    // MARK: - Slice 1 surface (preserved)

    /// Render a preview CIImage for `asset` against `model`.
    ///
    /// Thin pass-through preserved from slice 1 for the boundary check
    /// in `RenderActorTests`. The production scheduler does NOT route
    /// through this method — it calls into the closure handed to
    /// `scheduleRender(work:phase:)`.
    public func renderPreview(
        asset: AssetRef,
        model: AdjustmentModel
    ) async throws -> CIImage {
        if !asset.isRaw {
            try Task.checkCancellation()
            guard let decoded = await pipeline.decodeSceneLinearNonRaw(
                asset: asset, targetSize: nil
            ) else {
                throw RenderError.pipelineFailed
            }
            try Task.checkCancellation()
            return pipeline.processSceneLinearNonRaw(
                decoded: decoded, model: model, targetSize: nil
            )
        }

        let sidecar: URL? = {
            guard let url = asset.sidecarURL,
                  FileManager.default.fileExists(atPath: url.path)
            else { return nil }
            return url
        }()
        try Task.checkCancellation()
        guard let decoded = await pipeline.decodeSceneLinear(
            asset: asset, quality: .preview, xmpPath: sidecar
        ) else {
            throw RenderError.pipelineFailed
        }
        try Task.checkCancellation()
        return pipeline.processSceneLinear(
            decoded: decoded,
            model: model,
            targetSize: nil,
            asShot: nil,
            decodedAtModel: nil
        )
    }

    // MARK: - Export (slice 2)

    public func renderForExport(
        asset: AssetRef,
        model: AdjustmentModel,
        asShot: ImageEditPipeline.AsShotWB?
    ) async throws -> CIImage {
        let pipeline = self.pipeline
        let m = model

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
        let exportDecodedAtModel = EditSession.parseSidecarModel(for: asset)
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

    // MARK: - Single-flight decode (slice 2)

    func sharedDecode(
        asset: AssetRef,
        normalize: @escaping @Sendable (CIImage, AssetRef) async -> CIImage
    ) async -> CIImage? {
        if let existing = decodeTask, decodeTaskAssetID == asset.id {
            guard let decoded = await existing.value else { return nil }
            if decodedAtModel == nil {
                decodedAtModel = EditSession.parseSidecarModel(for: asset)
            }
            return await normalize(decoded, asset)
        }
        decodeTask = nil
        decodeTaskAssetID = nil

        let decodeSignpostID = editSessionSignposter.makeSignpostID()
        let decodeState = editSessionSignposter.beginInterval("decode", id: decodeSignpostID)

        let extensionIsRaw = asset.isRaw
        let needsSniff = asset.primaryURL == nil
            && asset.hintExtension == nil
            && asset.explicitIsRaw == nil
        let task: Task<CIImage?, Never> = Task.detached(priority: .userInitiated) { [pipeline] in
            var dispatchAsset = asset
            var dispatchIsRaw = extensionIsRaw
            if needsSniff, let provider = asset.bytesProvider {
                if let bytes = try? await provider() {
                    if let detected = AssetRef.detectIsRaw(bytes: bytes) {
                        dispatchIsRaw = detected
                    }
                    let cachedBytes = bytes
                    let displayName = asset.displayName
                    let hint: String? = {
                        if dispatchIsRaw { return asset.hintExtension }
                        if bytes.count >= 4 {
                            if bytes[0] == 0xFF, bytes[1] == 0xD8 { return "jpg" }
                            if bytes[0] == 0x89, bytes[1] == 0x50 { return "png" }
                            if bytes.count >= 8 {
                                if bytes[4] == 0x66, bytes[5] == 0x74,
                                   bytes[6] == 0x79, bytes[7] == 0x70 {
                                    return "heic"
                                }
                            }
                        }
                        return asset.hintExtension
                    }()
                    dispatchAsset = AssetRef(
                        displayName: displayName,
                        hintExtension: hint,
                        stableID: asset.stableID,
                        explicitIsRaw: dispatchIsRaw,
                        bytesProvider: { cachedBytes }
                    )
                }
            }

            if !dispatchIsRaw {
                return await mapleStageAsync("ImageIO non-RAW decode") {
                    await pipeline.decodeSceneLinearNonRaw(
                        asset: dispatchAsset, targetSize: nil
                    )
                }
            }
            let asset = dispatchAsset
            let sidecar: URL? = {
                guard let url = asset.sidecarURL,
                      FileManager.default.fileExists(atPath: url.path)
                else { return nil }
                return url
            }()
            let decoded = await mapleStageAsync("rust FFI scene-linear decode") {
                await pipeline.decodeSceneLinear(asset: asset, xmpPath: sidecar)
            }
            guard let decoded else { return nil }
            return decoded
        }
        decodeTask = task
        decodeTaskAssetID = asset.id

        let decoded = await task.value
        editSessionSignposter.endInterval("decode", decodeState)

        guard let decoded else {
            if decodeTaskAssetID == asset.id {
                decodeTask = nil
                decodeTaskAssetID = nil
            }
            return nil
        }

        let normalized = await normalize(decoded, asset)
        decodedImage = normalized
        decodedRawResolution = decoded.extent.size
        decodedForAssetID = asset.id
        decodedAtModel = EditSession.parseSidecarModel(for: asset)
        decodedSidecarMtime = EditSession.sidecarMtime(for: asset)
        if decodeTaskAssetID == asset.id {
            decodeTask = nil
            decodeTaskAssetID = nil
        }
        return normalized
    }

    @discardableResult
    public func coalescedRefineDecode(
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
        if refineDecodeTasks[key]?.id == slotID {
            refineDecodeTasks[key] = nil
        }
        return result
    }

    // MARK: - Cache lifecycle (slice 2)

    public func invalidate() {
        decodedImage = nil
        decodedRawResolution = .zero
        decodedForAssetID = nil
        decodedSidecarMtime = nil
        decodeTask = nil
        decodeTaskAssetID = nil
        refineDecodeTasks.removeAll()
        decodedAtModel = nil
    }

    public func snapshot(forAsset asset: AssetRef) -> DecodedSnapshot {
        let isFresh = (decodedForAssetID == asset.id)
            && (EditSession.sidecarMtime(for: asset) == decodedSidecarMtime)
        return DecodedSnapshot(
            image: decodedImage,
            decodedAtModel: decodedAtModel,
            rawResolution: decodedRawResolution,
            isFresh: isFresh
        )
    }

    public func seed(
        asset: AssetRef,
        decoded: CIImage,
        rawResolution: CGSize,
        decodedAtModel: AdjustmentModel? = nil
    ) {
        self.decodedImage = decoded
        self.decodedRawResolution = rawResolution
        self.decodedForAssetID = asset.id
        self.decodedSidecarMtime = EditSession.sidecarMtime(for: asset)
        self.decodedAtModel = decodedAtModel
    }

    public func seedIfUnpopulated(
        asset: AssetRef,
        decoded: CIImage,
        rawResolution: CGSize,
        decodedAtModel: AdjustmentModel? = nil
    ) -> Bool {
        if decodedImage != nil && decodedForAssetID == asset.id {
            return false
        }
        self.decodedImage = decoded
        self.decodedRawResolution = rawResolution
        self.decodedForAssetID = asset.id
        self.decodedSidecarMtime = EditSession.sidecarMtime(for: asset)
        self.decodedAtModel = decodedAtModel
        return true
    }

    // MARK: - Scheduler (slice 3)

    /// Current generation counter — render closures call this on resume
    /// to confirm they're still the newest schedule before publishing.
    /// Identical semantics to the `gen != renderGeneration` guard the
    /// pre-slice-3 EditSession scheduler used.
    public func currentGeneration() -> UInt64 {
        renderGeneration
    }

    /// Schedule a render. Cancels the previous fast + refine tasks,
    /// bumps the generation counter, and spawns a new task that runs
    /// `work` immediately (no fast-phase sleep — the cancel-previous
    /// already short-circuits the storm during a slider drag).
    ///
    /// The closure receives the post-bump generation counter; it is
    /// expected to honour `Task.isCancelled` and to compare against the
    /// live `currentGeneration()` before writing to MainActor state.
    ///
    /// Returns the generation counter so callers that need to coordinate
    /// follow-up work (e.g. chaining a refine after the fast publish)
    /// can do so without an extra actor hop.
    @discardableResult
    public func scheduleRender(
        phase: RenderPhase,
        work: @escaping @Sendable (UInt64) async -> Void
    ) -> UInt64 {
        renderTask?.cancel()
        refineTask?.cancel()
        renderGeneration &+= 1
        let gen = renderGeneration
        editSessionLogger.debug(
            "scheduleRender gen=\(gen) phase=\(String(describing: phase), privacy: .public)"
        )
        renderTask = Task { [work] in
            await work(gen)
        }
        return gen
    }

    /// Schedule a refine. Cancels the previous refine task and spawns a
    /// new one that sleeps for `refineDebounceMilliseconds` before
    /// running `work`. During a continuous flurry of schedules only the
    /// last one survives the debounce — the slider-drag coalescer.
    ///
    /// Does NOT bump `renderGeneration` — pan/zoom and window-resize
    /// refines must not invalidate the most recent fast publish. The
    /// closure receives the live generation so it can still bail out if
    /// a NEWER fast schedule landed after the refine debounce started.
    @discardableResult
    public func scheduleRefine(
        work: @escaping @Sendable (UInt64) async -> Void
    ) -> UInt64 {
        refineTask?.cancel()
        let gen = renderGeneration
        refineTask = Task { [work] in
            try? await Task.sleep(for: .milliseconds(Int(RenderActor.refineDebounceMilliseconds)))
            guard !Task.isCancelled else { return }
            await work(gen)
        }
        return gen
    }

    /// Cancel both in-flight tasks. Used on asset switch / session
    /// teardown so background work from the previous asset doesn't
    /// continue to spend GPU cycles after the user moved on.
    public func cancelAll() {
        renderTask?.cancel()
        refineTask?.cancel()
        renderTask = nil
        refineTask = nil
    }

    // MARK: - Test hooks

    internal func _testSeedDecodedCache(
        asset: AssetRef,
        decoded: CIImage,
        rawResolution: CGSize,
        sidecarMtime: Date?,
        decodedAtModel: AdjustmentModel? = nil
    ) {
        self.decodedImage = decoded
        self.decodedRawResolution = rawResolution
        self.decodedForAssetID = asset.id
        self.decodedSidecarMtime = sidecarMtime
        self.decodedAtModel = decodedAtModel
    }

    internal func _testDecodedCachePopulated(forAsset asset: AssetRef) -> Bool {
        decodedImage != nil && decodedForAssetID == asset.id
    }

    internal func _testDecodedCacheIsFresh(forAsset asset: AssetRef) -> Bool {
        snapshot(forAsset: asset).isFresh
    }

    internal var _testDecodedAtModel: AdjustmentModel? { decodedAtModel }

    /// Test inspector — true when a render task is currently in flight
    /// (not yet completed, not cancelled). Used by
    /// `RenderActorSchedulerTests` to assert cancel-previous semantics.
    internal func _testRenderTaskInFlight() -> Bool {
        guard let task = renderTask else { return false }
        return !task.isCancelled
    }

    internal func _testRefineTaskInFlight() -> Bool {
        guard let task = refineTask else { return false }
        return !task.isCancelled
    }
}
