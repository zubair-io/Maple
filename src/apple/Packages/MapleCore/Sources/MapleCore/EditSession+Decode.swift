// EditSession+Decode.swift — Rust FFI decode + decode-time coalescing.
//
// Split out of `EditSession+Render.swift` (issue #120) so the scheduler /
// publish layer stays focused on render flow. Owns:
//   • `sharedDecode`         — single-flight Rust FFI decode per asset
//   • `coalescedRefineDecode`— register-before-await for refine peers
//   • `renderForExport`      — full-quality export bypass of the preview cache
//
// Cache invalidation, sidecar mtime helpers, freshness checks, and the
// preview-cache persistence path live in `EditSession+Cache.swift`. The
// stored cache fields (`decodedImage`, `decodeTask`, `refineDecodeTasks`,
// `decodedAtModel`, `decodedSidecarMtime`, `decodedRawResolution`,
// `decodedForAssetID`) live on `EditSession` — extensions can't add
// stored properties.

import Foundation
import CoreImage

@MainActor
extension EditSession {
    // MARK: - Export

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

    // MARK: - Rust FFI single-flight decode

    /// Returns the decoded CIImage for `asset`, running the Rust FFI at
    /// most once per asset even if multiple concurrent callers ask for it.
    /// If a peer render phase is already awaiting a decode for the same
    /// asset we piggy-back on that task; otherwise we start a fresh one.
    /// Writes `decodedImage` / `decodedForAssetID` when the task completes.
    func sharedDecode(
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
        // Decoded-image cache architecture (ported from Maple reference's
        // EditSession.swift):
        //
        //   • Decode ONCE per asset open at full sensor extent (half-res
        //     preview demosaic — the unsized scene-linear FFI). This costs
        //     ~200 MB resident fp16 for a 100 MP RAW but means slider/zoom/
        //     pan never re-cross the FFI for the lifetime of the session.
        //   • The full-resolution cached buffer feeds every fast/refine
        //     pass — `processSceneLinear`'s lazy Lanczos prescale fuses the
        //     downscale with the filter chain so CoreImage materialises
        //     only the requested target pixels, not the full intermediate.
        //   • At high zoom (refine target ≥ fast target), Piece 2's
        //     visible-region rendering crops the materialise step to the
        //     viewport rect via `CIContext.createCGImage(from: visibleRect)`
        //     — the cached buffer covers the whole canvas but only those
        //     pixels actually run through the chain.
        //
        // RAW vs non-RAW dispatch:
        //   1. AssetRef-level classification (extension or explicitIsRaw)
        //      is the fast path — file-shaped sources hit this.
        //   2. PhotoKit / Self-Hosted assets without an extension hint
        //      need a magic-byte sniff at first byte fetch. We do that
        //      below in the detached task before picking a decoder, so
        //      iPhone HEIF photos (no URL, no hint) route correctly.
        //
        // Plan 2 M3 — pass the asset's sidecar URL through to the
        // scene-linear FFI so highlight_recovery (Rust-side, pre-DCP)
        // responds to the saved highlightRecovery setting. Only pass a
        // URL when a sidecar file exists on disk; nil keeps the Rust
        // default model (highlight_recovery = Off) so first-open (no
        // sidecar) behaviour matches Plan 1.
        let extensionIsRaw = asset.isRaw
        let needsSniff = asset.primaryURL == nil && asset.hintExtension == nil && asset.explicitIsRaw == nil
        let task: Task<CIImage?, Never> = Task.detached(priority: .userInitiated) { [pipeline] in
            // Decode dispatch — RAW assets go through the Rust FFI; non-RAW
            // (HEIF / HEIC / JPEG / PNG) goes through ImageIO + Core Image.
            // The non-RAW path is Apple-only — see decodeSceneLinearNonRaw
            // in ImageEditPipeline.swift. Web has its own non-RAW path via
            // browser-native Image decode.
            //
            // Resolve the format for sourceless-without-hint assets via
            // a magic-byte sniff. Pre-fetch bytes once, classify, then
            // hand the same bytes through to the matching decoder via a
            // synthetic AssetRef whose bytesProvider returns the cached
            // bytes.
            var dispatchAsset = asset
            var dispatchIsRaw = extensionIsRaw
            if needsSniff, let provider = asset.bytesProvider {
                if let bytes = try? await provider() {
                    if let detected = AssetRef.detectIsRaw(bytes: bytes) {
                        dispatchIsRaw = detected
                    }
                    // Wrap the bytes in a synthetic ref so the chosen
                    // decoder reuses the bytes we just fetched (a second
                    // bytesProvider call against PhotoKit / Self-Hosted
                    // would re-do an iCloud fetch).
                    let cachedBytes = bytes
                    let displayName = asset.displayName
                    let hint: String? = {
                        // Promote the magic-byte-derived classification
                        // to an extension hint so downstream readers
                        // (CIRAWFilter for metadata) can pick the right
                        // backend. Default to "heic" / "jpg" / "png" as
                        // matches detectIsRaw.
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
                // Non-RAW path: ImageIO decode at full extent (no target
                // size — the cache feeds every fast/refine pass at any
                // size, same shape as the RAW path).
                return await mapleStageAsync("ImageIO non-RAW decode") {
                    await pipeline.decodeSceneLinearNonRaw(
                        asset: dispatchAsset, targetSize: nil
                    )
                }
            }
            // Re-bind asset to the dispatch ref so the rest of the block
            // uses the cached-bytes provider when sniff fired.
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
        decodedSidecarMtime = Self.sidecarMtime(for: asset)
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

}
