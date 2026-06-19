// EditSession+Hydration.swift — cold-open / sidecar-load layer.
//
// Split from EditSession.swift (issue #120). Owns the path from "the user
// just opened an asset" through "the canvas has pixels":
//   • XMP sidecar load + as-shot WB seed
//   • Embedded JPEG / disk-cached preview seeding
//   • Native image size discovery (sync URL, async bytes-provider)
//   • Decoded-extent → native-canvas normalisation
//
// EditSession itself stays focused on live working state; this file
// orchestrates how that state gets populated on first open.

import Foundation
import CoreImage
import ImageIO

@MainActor
extension EditSession {
    // MARK: - Sidecar / model hydration

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

        // (2) XMP sidecar — absent for fresh images. The store reports
        // its own presence (file existence for local; 404 vs 200 for
        // cloud) so we don't second-guess via FileManager. The previous
        // FileManager-based gate was always false for cloud assets,
        // silently discarding persisted edits.
        var loadedModel: AdjustmentModel? = nil
        var loadedCulling: CullingState? = nil
        if let store = sidecarStore,
           let (m, c) = try? await store.loadIfPresent() {
            loadedModel = m
            loadedCulling = c
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
        // Push asShotCCT/asShotTint into the model when there's no XMP
        // sidecar so the slider DISPLAYS the camera's WB (matches the reference
        // renderer's "As Shot" semantic — slider shows the as-shot CCT). Once the
        // user has saved edits, the stored temperature wins.
        //
        // This pairs with `ImageEditPipeline.processSceneLinear`'s
        // decodedTemp/decodedTint computation: when there's no sidecar
        // those fall back to the same asShot CCT/tint, so the chain's
        // `apply_delta(live=asShotCCT, decoded=asShotCCT)` is identity
        // — slider shows asShotCCT, no shift applied. This is the
        // expected UX. (Removing the asShotCCT push here without
        // also fixing decodedTemp produced the "slider shows 6500" UX
        // regression user noticed; pushing it without fixing decodedTemp
        // produced the magenta cast.)
        var base = loadedModel ?? .default
        if loadedModel == nil,
           let cct = asShotCCT, let tint = asShotTint {
            base.temperature = cct
            base.tint = tint
        }
        return base
    }

    // MARK: - Cold-open orchestration

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
        } else if asset.bytesProvider != nil {
            // Sourceless / remote asset (Self-Hosted, SMB, PhotoKit) has no URL
            // to read synchronously. Seed `nativeImageSize` from the bytes at
            // cold-open — in parallel with the decode — instead of leaving it to
            // the decode's normalize closure, which only kicks the async seed
            // AFTER the first present. Without an early seed `nativeImageSize`
            // stays .zero → `displayFrameInPoints` nil → the canvas shows the
            // placeholder, so `GpuLiveCanvasView` never mounts, `register(layer:)`
            // never fires, and the first `presentViaGpuLive` takes the no-layer
            // reject → CPU fallback. Local files don't hit this — they seed
            // synchronously above, so their GPU layer is registered before the
            // decode lands. The async seed is idempotent (guards on `.zero`), so
            // it no-ops on revisit and races harmlessly with the decode's kick. (#1604)
            let seedAsset = asset
            Task { @MainActor [weak self] in
                guard let self else { return }
                await self.seedNativeImageSizeFromMetadataAsync(seedAsset)
                // Re-present once the size lands (still the current asset): the
                // canvas leaf has now mounted + registered its layer, so this
                // render goes through the GPU live path. `.fast` reuses the
                // in-flight/cached decode — no second decode.
                if self.asset.id == seedAsset.id, self.nativeImageSize != .zero {
                    self._scheduleRender(phase: .fast)
                }
            }
        }
        // `EditSession.asset` is `let`, so once a preview lands for this
        // session it's guaranteed to be for `self.asset`. The decoded-
        // image cache now lives on `renderActor` (issue #194 slice 2);
        // the cheap MainActor check here is just "have we already
        // published anything?". The hard "do we need a real decode?"
        // check is the snapshot-fetch inside `openAssetPipelineAsync`.
        guard renderedPreview == nil else { return }
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
    func openAssetPipelineAsync() async {
        // Re-entrancy guard: `ensureRenderStarted()` fires from several sites
        // (FullImageView.onAppear / EditorView / GpuLiveCanvasView layout). A
        // second concurrent cold-open run would double-decode AND could clear
        // the indicator flag while the first decode is still in flight. The
        // MainActor serializes this synchronous prefix, so check-then-set is
        // atomic. #1201 review.
        guard !isFullQualityDecoding else { return }
        // The full-quality decode is now in flight; the loading indicator stays
        // up until it lands (not just until the sub-second preview presents).
        // `defer` so the flag never sticks if this later grows early-returns or
        // becomes cancellation-aware. #1201
        isFullQualityDecoding = true
        defer { isFullQualityDecoding = false }
        // Held one render step LONGER than `isFullQualityDecoding`: the indicator
        // stays up until the first render AFTER the decode actually publishes a
        // full-quality frame (cleared in `decodeAndRender`), not merely until the
        // decode call returns. No `defer` — clearing is the render's job, and a
        // new image is a new session, so it can't leak across opens. #1201
        isResolvingFirstFrame = true
        editSessionLogger.notice(
            "loading indicator SHOWN — cold-open decode+render in flight for \(self.asset.id, privacy: .public)"
        )

        // FileProvider materialization tracking — drives the download overlay
        // for assets that iOS/macOS lazy-materialize (Files-app sidebar / iCloud
        // Drive). No-op for local files (observer returns immediately) and
        // skipped entirely for cloud-search assets, which have no primaryURL
        // and drive progress via CloudByteDownloadBox.
        if let url = asset.primaryURL,
           let downloadProgress,
           fileProviderObserver == nil {
            let observer = FileProviderDownloadObserver()
            fileProviderObserver = observer
            Task { @MainActor in
                await observer.start(url: url, progress: downloadProgress)
            }
        }

        let openedAsset = self.asset

        // Kick the background Rust decode early — it's the slowest,
        // latency-hiding it behind the preview paths matters most. The
        // actor writes its cache fields on completion via the
        // `sharedDecode` tail; we re-kick the fast render so the
        // scheduler picks up the new cache on its next snapshot.
        let actor = self.renderActor
        // #871: develop the pre-decode for the LIVE profile so its
        // auto_exposure-Off-when-Auto decision matches the buffer the Auto
        // cube will be applied over (and the decode cache keys on it).
        let openProfile = self.model.profile
        let rustTask: Task<Void, Never> = Task { [weak self] in
            _ = await actor.sharedDecode(
                asset: openedAsset,
                profile: openProfile,
                normalize: { [weak self] image, asset in
                    guard let self else { return image }
                    return await MainActor.run {
                        self.decodedForNativeCanvas(image, asset: asset)
                    }
                }
            )
            guard let self else { return }
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

        // .maple/previews baked preview (#1365) — instant cold-open for assets
        // with no embedded JPEG (panos). Tried after the rendered-preview cache
        // (the best, last-develop result) and before the embedded path.
        let sidecarHit = await mapleStageAsync("maple sidecar preview seed") {
            await self.seedFromMapleSidecarPreview(for: openedAsset)
        }
        if sidecarHit {
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
        // Full-quality decode landed — the `defer` above drops the loading
        // indicator on return (success or a nil/failed decode), so it never sticks.
        await rustTask.value
    }

    // MARK: - Native image size discovery

    /// Synchronous URL-driven seed. Used by `decodedForNativeCanvas` (the
    /// hot render path) and by `ensureRenderStarted`. Sourceless assets
    /// (no `primaryURL`) need the async variant below — they have to pull
    /// bytes through `bytesProvider` first.
    func seedNativeImageSizeFromMetadata(_ url: URL) {
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
    func seedNativeImageSizeFromMetadataAsync(_ asset: AssetRef) async {
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

    // MARK: - Decoded → native canvas normalisation

    func decodedForNativeCanvas(_ decoded: CIImage, asset: AssetRef) -> CIImage {
        let decodedSize = decoded.extent.size
        if nativeImageSize == .zero, let url = asset.primaryURL {
            seedNativeImageSizeFromMetadata(url)
        }
        // Sourceless / bytes-backed assets seed `nativeImageSize` once, at
        // cold-open in `ensureRenderStarted` (#1604) — a single trigger point.
        // Re-kicking the async bytes seed here would race that one and could
        // call `bytesProvider()` (a network fetch) a second time, so it is
        // intentionally not duplicated. The current call returns the unscaled
        // decode; the cold-open seed's `_scheduleRender(.fast)` re-normalises
        // to the real canvas once the native size lands.
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

    // MARK: - Preview seeds (cache + embedded JPEG)

    /// Returns true if a cached rendered preview was loaded and the
    /// session state was updated. Writes the decoded-image cache via
    /// `renderActor.seedIfUnpopulated(...)` so the check+write is
    /// atomic against the background Rust decode landing first (issue
    /// #194 slice 2). When the actor refuses the seed (a better buffer
    /// is already cached), `renderedPreview` is left alone.
    func seedFromCachedPreview(for asset: AssetRef) async -> Bool {
        guard let url = asset.primaryURL else { return false }
        guard renderedPreview == nil else { return false }
        let w = Int(max(previewSize.width, 1))
        let cached = await RenderedPreviewCache.shared
            .preview(for: url, screenWidth: w)
        guard let cached else { return false }
        guard self.asset.id == asset.id else { return false }
        let normalized = decodedForNativeCanvas(cached, asset: asset)
        let accepted = await renderActor.seedIfUnpopulated(
            asset: asset,
            decoded: normalized,
            rawResolution: cached.extent.size
        )
        guard accepted else { return false }
        // Only publish the lower-quality buffer to the canvas once the
        // actor has accepted it — otherwise the Rust decode already
        // wrote a better cache and we'd be downgrading the visible
        // preview for no reason.
        renderedPreview = cached
        editSessionLogger.debug(
            "cached preview seeded decode extent=\(cached.extent.width)x\(cached.extent.height)"
        )
        return true
    }

    /// Returns true if the embedded JPEG preview was loaded and seeded
    /// into the actor's decoded-image cache. Same atomicity contract as
    /// `seedFromCachedPreview` above.
    func seedFromEmbeddedPreview(for asset: AssetRef) async -> Bool {
        guard let url = asset.primaryURL else { return false }
        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        let ci: CIImage? = await Task.detached(priority: .userInitiated) { () -> CIImage? in
            let accessing = scope.startAccessingSecurityScopedResource()
            defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
            return EditSession.readEmbeddedPreview(from: url)
        }.value
        guard let ci else { return false }
        guard self.asset.id == asset.id else { return false }
        let normalized = decodedForNativeCanvas(ci, asset: asset)
        let accepted = await renderActor.seedIfUnpopulated(
            asset: asset,
            decoded: normalized,
            rawResolution: ci.extent.size
        )
        guard accepted else { return false }
        renderedPreview = ci
        editSessionSignposter.emitEvent("embedded paint")
        editSessionLogger.debug(
            "embedded preview seeded decode extent=\(ci.extent.width)x\(ci.extent.height)"
        )
        return true
    }

    /// Returns true if the `.maple/previews` baked preview was loaded and
    /// seeded into the actor's decoded-image cache. Same atomicity contract as
    /// `seedFromEmbeddedPreview`. Primary instant cold-open path for a pano,
    /// whose 16-bit PNG has no embedded JPEG and whose full develop is slow. (#1365.)
    func seedFromMapleSidecarPreview(for asset: AssetRef) async -> Bool {
        guard let url = asset.primaryURL else { return false }
        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        let ci: CIImage? = await Task.detached(priority: .userInitiated) { () -> CIImage? in
            let accessing = scope.startAccessingSecurityScopedResource()
            defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
            return EditSession.readMapleSidecarPreview(from: url)
        }.value
        guard let ci else { return false }
        guard self.asset.id == asset.id else { return false }
        let normalized = decodedForNativeCanvas(ci, asset: asset)
        let accepted = await renderActor.seedIfUnpopulated(
            asset: asset,
            decoded: normalized,
            rawResolution: ci.extent.size
        )
        guard accepted else { return false }
        renderedPreview = ci
        editSessionSignposter.emitEvent("maple sidecar preview paint")
        editSessionLogger.debug(
            "maple sidecar preview seeded decode extent=\(ci.extent.width)x\(ci.extent.height)"
        )
        return true
    }
}

// MARK: - Embedded preview reader (nonisolated)

extension EditSession {
    /// Read the render-time `.maple/previews/<key>_1600.jpg` baked preview for
    /// an asset and decode it to a `CIImage`. Asset-relative (resolves next to
    /// the asset, e.g. a pano in `Panoramas/`). Returns nil when absent. (#1365.)
    nonisolated static func readMapleSidecarPreview(from url: URL) -> CIImage? {
        let preview = MapleSidecarPaths.previewURL(for: url)
        guard FileManager.default.fileExists(atPath: preview.path),
            let data = try? Data(contentsOf: preview)
        else { return nil }
        return CIImage(data: data)
    }

    /// Extract the camera's embedded JPEG preview via ImageIO. Returns a
    /// CIImage at up to 2048 px long edge — enough to look sharp in the
    /// editor's viewport without paying full-resolution decode cost.
    nonisolated static func readEmbeddedPreview(from url: URL) -> CIImage? {
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
}
