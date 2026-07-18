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
    ///
    /// `internal` (not `private`) so the decoded-cache methods extracted
    /// to `RenderActor+DecodedCache.swift` can reach it — actor isolation
    /// is preserved because the extension stays on this actor in-module.
    let pipeline: ImageEditPipeline

    // MARK: - Decoded-image cache state (slice 2)
    //
    // These stored properties live in the actor body (Swift forbids stored
    // properties in extensions) but are `internal` so the slice-2 decode
    // methods in `RenderActor+DecodedCache.swift` can mutate them under the
    // actor's isolation.

    var decodedImage: CIImage?
    var decodedRawResolution: CGSize = .zero
    var decodedForAssetID: AssetRef.ID?

    /// The "baked" model the cached `decodedImage` was decoded from — the
    /// `RawCoreBridge.stripAppleGPUStages(…)` of the asset's sidecar model
    /// at decode time (#950). This replaces the old sidecar-mtime freshness
    /// key for the IN-MEMORY decoded-image cache only.
    ///
    /// Why not mtime: the decoded scene-linear buffer is a pure function of
    /// `(raw bytes, stripAppleGPUStages(model), profile, target)`. The
    /// Apple-GPU stages are stripped before decode and re-applied LIVE per
    /// tick (`maple_apply_scene_linear_chain`), so editing a STRIPPED field
    /// (exposure, nrColor, sharpenAmount, …) does NOT change the decode —
    /// yet the 750 ms-debounced XMP autosave bumps the sidecar mtime, so the
    /// old key forced a full ~15 s re-decode on the first edit after any
    /// drag pause. Keying on the stripped model is correct by construction:
    /// identical stripped model ⇒ identical decode ⇒ cache hit; a change to
    /// any *baked* (KEPT) field — `highlightRecovery`,
    /// `captureSharpeningAmount/Sigma`, the unsharp `sharpenRadius/Detail/
    /// Masking` — changes the value and forces a re-decode. We store the
    /// stripped model itself and compare by value (`==`): a hash would be a
    /// collision risk for zero benefit on a single in-memory comparison.
    ///
    /// `nil` = "no sidecar on disk at decode time" (the FFI used
    /// `AdjustmentModel::default()`, which is already in the stripped state).
    /// The rendered-preview DISK cache (`RenderedPreviewCache`) and the
    /// deep-zoom tile cache KEEP sidecar-mtime — they depend on the FULL
    /// model and are cross-session; only this in-memory cache changes.
    var decodedBakedModel: AdjustmentModel?

    /// The sidecar mtime captured alongside `decodedBakedModel` — a pure
    /// FAST-PATH gate, NOT the freshness source of truth (#950). The
    /// freshness check runs on every `snapshot(forAsset:)`, i.e. every
    /// slider tick, and recomputing `decodedBakedModel` is a synchronous
    /// XMP parse + model alloc. During a stripped-field drag the on-disk
    /// sidecar isn't changing, so an unchanged mtime is proof the file is
    /// byte-identical ⇒ the baked model is unchanged ⇒ we can skip the
    /// parse entirely. We only fall through to the parse-and-compare when
    /// the mtime actually moved (a save landed). This keeps the per-tick
    /// hot path allocation-free (CLAUDE.md § Performance invariants) while
    /// the baked model remains the authoritative key — mtime can only make
    /// us do MORE work (parse on a same-baked save), never serve a stale
    /// buffer. `nil` mirrors `decodedBakedModel == nil` (no sidecar).
    var decodedSidecarMtime: Date?

    var decodedAtModel: AdjustmentModel?

    /// Per-camera NoiseLevelFunction profile captured at decode time (PR #1709
    /// review fix 4). `nil` when the DNG carries no NoiseLevelFunction tag; the
    /// adaptive NR stage falls back to the ISO-only estimate in that case.
    /// Stored alongside the decoded image so `processSceneLinear` can forward
    /// it to `maple_apply_scene_linear_chain_f32` without re-decoding.
    var decodedNoiseProfile: [Float]? = nil

    /// ISO speed captured at decode time (PR #1709 review fix 4). 0 when not
    /// available; the Rust chain substitutes 100 on its side.
    var decodedISO: UInt32 = 0

    /// Decode-exported WB slider frame captured at decode time (#1781).
    /// `nil` for non-RAW / seeded buffers or frame-less bodies. Stored
    /// alongside the decoded image so the per-tick chains and the
    /// EditSession's As-Shot seed use raw-core's frame numbers.
    var decodedWbFrame: WbSliderFrame? = nil

    /// Profile the cached `decodedImage` was developed for (#871). The
    /// decode buffer is now profile-dependent: `Profile::Auto` develops
    /// `auto_exposure` Off (so it byte-matches the buffer the Auto curve
    /// was fit against), while `Profile::Neutral` keeps `auto_exposure` On.
    /// A profile toggle must therefore re-decode rather than reuse the
    /// wrong-AE buffer — `snapshot(forAsset:)` reports this so the render
    /// path treats a profile mismatch as a cache miss. `nil` = a non-RAW
    /// or seeded buffer where the Auto/Neutral distinction doesn't apply.
    var decodedProfile: Profile?

    /// Whether the cached `decodedImage` is a FULL-resolution decode
    /// (sufficient for the refine pass / a deep-zoom crop) or a
    /// downsampled fast-phase decode (#785). The fast phase accepts any
    /// fresh cache; the refine pass treats a sized-only cache as a miss
    /// UNLESS the cache's resolution already covers the requested target
    /// (#2039 — see `refineCacheSufficient`), so a low-res
    /// fast decode never poisons the final render but a covering sized one
    /// is reused instead of forcing a redundant re-decode. Seeded preview /
    /// embedded-JPEG buffers are NOT full.
    var decodedIsFull: Bool = false

    /// Monotonic counter bumped every time the decoded-image cache is
    /// WRITTEN — a real decode landing in `sharedDecode`'s write-gated
    /// block, or a `seed`/`seedIfUnpopulated` call (#2049). This is the
    /// buffer's IDENTITY, independent of pixel dimensions: a baked-field
    /// edit (highlightRecovery, captureSharpeningAmount/Sigma, the unsharp
    /// sharpenRadius/Detail/Masking) forces a fresh decode at the SAME
    /// target dims, so dims alone can't tell the GPU-live present that the
    /// uploaded buffer is stale — this generation can. Never reset (a
    /// monotonic counter across asset switches is fine: switching assets
    /// always triggers a fresh decode that bumps it, so an identity built
    /// from it never accidentally matches a different asset's upload).
    var decodeGeneration: UInt64 = 0

    /// (image, noiseProfile, iso, wbFrame) — noiseProfile/iso forwarded to the
    /// NR stage (PR #1709 review fix 4); wbFrame is the #1781 slider-frame
    /// export. Non-RAW decodes yield (image, nil, 0, nil).
    var decodeTask: Task<(CIImage, [Float]?, UInt32, WbSliderFrame?)?, Never>?
    var decodeTaskAssetID: AssetRef.ID?
    /// Cancel flag bound to the in-flight `decodeTask` (#951). Created when a
    /// NEW decode launches in `sharedDecode`; flipped (`requestCancel()`) only
    /// when that decode is genuinely abandoned — a different-identity decode
    /// supersedes it (replace path), `invalidate()`, or `cancelAll()` (asset
    /// switch). It is deliberately bound to the DECODE TASK, not the render
    /// generation: `sharedDecode` is single-flight and JOINS an in-flight
    /// decode across generations (a slider tick during a cold open shares the
    /// one decode), so flipping on every generation bump would spuriously
    /// cancel a decode a newer same-asset generation is about to join. The
    /// in-flight Task holds its OWN strong reference to its flag across the FFI
    /// call, so replacing this stored reference never frees a flag the Rust
    /// worker is still reading. `nil` when no decode is in flight.
    var decodeCancelFlag: CancelFlag?
    /// The decode target the in-flight `decodeTask` was launched for:
    /// `nil` = full decode, non-nil = sized fast decode. A refine that
    /// needs a full decode must not join a sized fast task (the join
    /// would hand back a low-res buffer); the single-flight check below
    /// only reuses the task when it already satisfies the caller's
    /// fullness requirement.
    var decodeTaskIsFull: Bool = false
    /// Profile the in-flight `decodeTask` was launched for (#871). Part of
    /// the task IDENTITY: a render for a different profile must NOT join an
    /// in-flight decode for the other profile (it would get the wrong-AE
    /// buffer), so the join check below compares this too.
    var decodeTaskProfile: Profile?

    var refineDecodeTasks: [RefineDecodeKey: RefineDecodeSlot] = [:]
    var refineDecodeSlotCounter: UInt64 = 0

    /// Content-resolved RAW/non-RAW classification for bytes-backed assets
    /// (PhotoKit / Self-Hosted) that arrive with no URL and no extension hint,
    /// keyed by asset id. Filled from the authoritative magic-byte sniff in
    /// `sharedDecode`; read by `presentViaGpuLive` so the GPU `inputShape`
    /// matches the decode rather than `AssetRef.isRaw` — whose extension
    /// fallback defaults bytes-backed assets to RAW, which made the GPU view
    /// tail run AgX on a non-RAW buffer and crush white to grey (#1553).
    private var resolvedIsRawByAsset: [AssetRef.ID: Bool] = [:]

    /// Record the content-sniffed classification for `id`. Called from the
    /// `sharedDecode` worker once the magic-byte sniff resolves.
    func recordResolvedIsRaw(_ id: AssetRef.ID, _ isRaw: Bool) {
        resolvedIsRawByAsset[id] = isRaw
    }

    /// The content-resolved RAW classification for `id`, or `nil` when the asset
    /// never needed a sniff (URL/extension-backed assets — `AssetRef.isRaw` is
    /// authoritative for those).
    func resolvedIsRaw(for id: AssetRef.ID) -> Bool? {
        resolvedIsRawByAsset[id]
    }

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
        /// True when the cached decode is full-resolution (sufficient for
        /// refine / deep-zoom crops). A sized fast decode or a seeded
        /// preview buffer is `false` — refine must re-decode (#785).
        public let isFull: Bool
        /// Profile the cached buffer was developed for (#871), or `nil` for
        /// non-RAW / seeded buffers. The render path compares this to the
        /// live profile and treats a mismatch as a miss so a profile toggle
        /// re-decodes the (profile-dependent, AE-Off-for-Auto) buffer.
        public let profile: Profile?
        /// Per-camera noise profile from the RAW decode (PR #1709 review fix 4).
        /// `nil` when the DNG carries no NoiseLevelFunction tag or the buffer
        /// was seeded from a display-encoded preview.
        public let noiseProfile: [Float]?
        /// ISO speed from the RAW decode (PR #1709 review fix 4). 0 for seeded
        /// / non-RAW buffers; the Rust chain substitutes 100 on its side.
        public let iso: UInt32
        /// Decode-exported WB slider frame (#1781). `nil` for seeded /
        /// non-RAW buffers or frame-less bodies.
        public let wbFrame: WbSliderFrame?
        /// The decode-cache write generation the cached buffer was written
        /// under (#2049) — see `RenderActor.decodeGeneration`. Threaded into
        /// `presentViaGpuLive` so the GPU-live upload identity can detect a
        /// same-dims re-decode (a baked-field edit) and re-upload instead of
        /// silently presenting the live chain over stale pixels.
        public let decodeGeneration: UInt64
    }

    // MARK: - Scheduler state (slice 3)

    /// Current render task — fast phase, kicked synchronously per
    /// schedule call. `scheduleRender` cancels this before spawning the
    /// next one.
    ///
    /// `internal` (not `private`) so the `_test…` inspectors extracted to
    /// `RenderActor+TestHooks.swift` can read it — same pattern as the
    /// decoded-cache state above; actor isolation is preserved because
    /// the extension stays on this actor in-module.
    var renderTask: Task<Void, Never>?

    /// Current refine task — wraps the 150 ms debounce sleep plus the
    /// refine work. Cancelled on every schedule (both `scheduleRender`
    /// and `scheduleRefine`) so a continuous slider drag collapses to a
    /// single refine pass at the tail.
    ///
    /// `internal` for `RenderActor+TestHooks.swift` — see `renderTask`.
    var refineTask: Task<Void, Never>?

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
                decoded: decoded, model: model, targetSize: nil,
                assetID: asset.id
            )
        }

        let sidecar: URL? = {
            guard let url = asset.sidecarURL,
                  FileManager.default.fileExists(atPath: url.path)
            else { return nil }
            return url
        }()
        try Task.checkCancellation()
        guard let decodeResult = await pipeline.decodeSceneLinear(
            asset: asset, quality: .preview, xmpPath: sidecar,
            profileOverride: asset.isRaw ? model.profile : nil
        ) else {
            throw RenderError.pipelineFailed
        }
        try Task.checkCancellation()
        return pipeline.processSceneLinear(
            decoded: decodeResult.image,
            model: model,
            targetSize: nil,
            asShot: nil,
            decodedAtModel: nil,
            assetID: asset.id,
            noiseProfile: decodeResult.noiseProfile,
            iso: decodeResult.iso,
            wbFrame: decodeResult.wbFrame
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
        guard let exportDecodeResult = await pipeline.decodeSceneLinear(
            asset: asset, quality: AmazeFlag.isEnabled ? .amaze : .full, xmpPath: sidecar,
            profileOverride: asset.isRaw ? m.profile : nil
        ) else {
            throw RenderError.pipelineFailed
        }
        let exportDecodedAtModel = EditSession.parseSidecarModel(for: asset)
        let exportNoiseProfile = exportDecodeResult.noiseProfile
        let exportISO = exportDecodeResult.iso
        let exportWbFrame = exportDecodeResult.wbFrame
        return await Task.detached(priority: .userInitiated) {
            pipeline.processSceneLinear(
                decoded: exportDecodeResult.image,
                model: m,
                targetSize: nil,
                asShot: asShot,
                decodedAtModel: exportDecodedAtModel,
                noiseProfile: exportNoiseProfile,
                iso: exportISO,
                wbFrame: exportWbFrame
            )
        }.value
    }

    // MARK: - Decode + cache lifecycle (slice 2)
    //
    // The single-flight decode (`sharedDecode`), the coalesced refine
    // decode (`coalescedRefineDecode`), and the cache lifecycle helpers
    // (`invalidate` / `snapshot` / `seed` / `seedIfUnpopulated`) live in
    // `RenderActor+DecodedCache.swift` as an `extension RenderActor` —
    // they stay actor-isolated there and mutate the stored properties
    // declared above. Split out under the file-size budget (#785 CI gate);
    // the scheduler (slice 3) remains in this file.

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

    /// Wait for the render task that's in flight RIGHT NOW to settle, if
    /// any — a no-op when nothing is running. (#2064.)
    ///
    /// This exists so a caller whose only goal is "make sure a render
    /// eventually reflects the latest state" doesn't have to go through
    /// `scheduleRender`'s cancel-previous path when a render is already
    /// working: cancelling and relaunching an in-flight fast-phase render
    /// throws away whatever progress it made and redoes an IDENTICAL pass
    /// whenever nothing the render actually reads (model, decoded buffer,
    /// GPU-layer availability) changed in the meantime — pure churn during
    /// exactly the cold-open window where time-to-first-pixel matters most.
    ///
    /// Awaiting the existing task instead lets it finish on its own terms.
    /// This is safe specifically because the render body re-reads its
    /// inputs live rather than trusting anything captured at schedule
    /// time: `decodeAndRender` re-fetches `renderActor.snapshot(forAsset:)`
    /// fresh, and `presentViaGpuLive` re-reads `driver.hasLayer` fresh,
    /// each time a render actually runs — so an in-flight render started
    /// before some new state landed (a newly-registered GPU layer, a
    /// richer decode) will very often still pick that state up by the time
    /// it gets there. The caller is expected to re-check whatever
    /// condition it cared about AFTER this returns and schedule a fresh
    /// render only if that check still says one is needed — see
    /// `EditSession.kickRenderAfterGpuCanvasMount`.
    ///
    /// Captures the in-flight task handle before awaiting so a concurrent
    /// `scheduleRender` replacing `renderTask` mid-wait can't redirect this
    /// call onto a different (newer) task — we always wait for the one
    /// that was actually in flight when the caller asked.
    public func awaitCurrentRenderIfInFlight() async {
        guard let task = renderTask, !task.isCancelled else { return }
        await task.value
    }

    /// Cancel both in-flight tasks. Used on asset switch / session
    /// teardown so background work from the previous asset doesn't
    /// continue to spend GPU cycles after the user moved on.
    public func cancelAll() {
        renderTask?.cancel()
        refineTask?.cancel()
        renderTask = nil
        refineTask = nil
        // #951: interrupt the in-flight cold decode too. Previously this nil'd
        // only the render/refine task handles, leaving a superseded asset's
        // ~8.5 s decode running to completion on the worker thread after the
        // user moved on. Flipping the flag unwinds it mid-stage. The decode
        // Task keeps its own strong ref to the flag, so the FFI worker still
        // reads valid memory after we drop our reference.
        decodeCancelFlag?.requestCancel()
        decodeCancelFlag = nil
    }

    // MARK: - Test hooks
    //
    // The `_test…` seed/inspector methods live in
    // `RenderActor+TestHooks.swift` — split out under the #785 file-size
    // budget. They stay actor-isolated there (in-module extension) and
    // `internal` so the package test target reaches them.
}
