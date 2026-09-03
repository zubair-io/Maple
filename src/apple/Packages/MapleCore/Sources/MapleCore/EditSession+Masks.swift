// EditSession+Masks.swift — the Mask tool's model-side surface (#3275, spec
// §3.2, §3.3). Owns mask selection (drives the scope HUD's target, Task 5)
// and the Vision → raster → registered-id → model.localAdjustments pipeline.
// UI (MaskPanel, PeoplePickerSheet) calls only this surface; neither view
// touches PersonSkinMaskService or the FFI registry directly.

import CoreGraphics
import CoreImage
import Foundation

extension EditSession {
    /// Detect people in a fresh, uncropped reduced-resolution develop of the
    /// current asset. The people picker calls this once when it opens.
    public func detectMaskPersons() async throws -> [PersonCandidate] {
        let image = try await renderForSegmentation()
        return try await personSkinMaskService.detectPersons(in: image)
    }

    /// Create a person-skin `LocalAdjustment`, register its raster, select it.
    public func createPersonSkinMask(person: PersonCandidate, facialSkin: Bool, bodySkin: Bool) async throws {
        let image = try await renderForSegmentation()
        let request = SkinRasterRequest(person: person.id, facialSkin: facialSkin, bodySkin: bodySkin)
        let modelId = "apple-vision-person-instance/1"
        let digest = Self.maskDigest(assetKey: assetIdentityKey(), request: request, model: modelId)
        let (w, h, bytes) = try await maskRasterStore.raster(for: digest, model: modelId) {
            try await self.personSkinMaskService.makeRaster(image: image, request: request)
        }
        guard let rasterId = MaskRasterRegistry.register(digest: digest, width: w, height: h, bytes: bytes) else {
            throw PersonSkinMaskError.visionFailed("raster registration failed")
        }
        let recipe = BitmapRecipe(
            person: person.id, facialSkin: facialSkin, bodySkin: bodySkin, model: modelId, digest: digest)
        let layer = LocalAdjustment(
            mask: .bitmap(recipe: recipe, rasterId: rasterId), range: .skinTone, adjustments: PartialAdjustments())
        model.localAdjustments.append(layer)
        selectedMaskId = layer.id
    }

    /// "Skin range only (whole image)" — the no-person fallback (spec §3.2).
    public func createWholeImageSkinMask() {
        let layer = LocalAdjustment(mask: .everywhere, range: .skinTone, adjustments: PartialAdjustments())
        model.localAdjustments.append(layer)
        selectedMaskId = layer.id
    }

    public func deleteMask(id: UUID) {
        guard let layer = model.localAdjustments.first(where: { $0.id == id }) else { return }
        if case .bitmap(let recipe, let rasterId) = layer.mask {
            MaskRasterRegistry.release(rasterId)
            _ = recipe  // the on-disk raster cache entry outlives one layer's deletion — re-adding the same person re-hits the MaskRasterStore cache rather than re-running Vision.
        }
        model.localAdjustments.removeAll { $0.id == id }
        maskDisabledStash.removeValue(forKey: id)
        if selectedMaskId == id { selectedMaskId = nil }
    }

    /// Disabled = present-but-inert: the panel keeps the row (so the user can
    /// re-enable it), the pipeline skips it. There is no `enabled` bit
    /// anywhere in the wire format (raw-core's `PartialAdjustments`, the
    /// flat record, or the XMP schema) — adding one would be a cross-cutting
    /// change to three already-shipped formats, out of scope here. Instead
    /// this reduces `adjustments` to `PartialAdjustments()`, matching
    /// `stages::local_adjustments::apply`'s existing "an empty adjustments
    /// set is a stage no-op" contract (it skips mask evaluation entirely
    /// when `PartialAdjustments.isEmpty`, so a cleared-but-still-ranged
    /// layer costs nothing and renders nothing) — and stashes the prior
    /// values in `maskDisabledStash` (session-only, never persisted) so
    /// re-enabling restores them instead of losing the user's sliders.
    public func setMaskEnabled(id: UUID, enabled: Bool) {
        guard let idx = model.localAdjustments.firstIndex(where: { $0.id == id }) else { return }
        if enabled {
            guard let restored = maskDisabledStash.removeValue(forKey: id) else { return }
            model.localAdjustments[idx].adjustments = restored
        } else {
            guard !model.localAdjustments[idx].adjustments.isEmpty else { return }
            maskDisabledStash[id] = model.localAdjustments[idx].adjustments
            model.localAdjustments[idx].adjustments = PartialAdjustments()
        }
    }

    /// `true` when `id` currently carries no live adjustments purely because
    /// `setMaskEnabled(id:enabled:false)` zeroed them — as opposed to a
    /// freshly-created mask that never had any. Drives the panel's toggle
    /// state without adding a model field.
    public func isMaskEnabled(id: UUID) -> Bool {
        maskDisabledStash[id] == nil
    }

    private static func maskDigest(assetKey: String, request: SkinRasterRequest, model: String) -> String {
        // FNV-1a, 64-bit, hex-formatted to exactly 16 lowercase chars —
        // matches `maple_mask_raster_register`'s required digest shape
        // (raw-ffi/src/mask_registry.rs) without needing an FFI round trip
        // just to name a cache entry.
        let raw = "\(assetKey)|\(request.person)|\(request.facialSkin)|\(request.bodySkin)|\(model)"
        let digest = raw.utf8.reduce(UInt64(1469598103934665603)) { h, b in (h ^ UInt64(b)) &* 1099511628211 }
        return String(format: "%016llx", digest)
    }

    /// A key stable across app launches for the SAME asset, used only to
    /// namespace the mask-raster cache (never persisted, never shown to the
    /// user) — the asset's own stable id when it has one (PhotoKit /
    /// Self-Hosted), else its filesystem path.
    private func assetIdentityKey() -> String {
        asset.stableID ?? asset.primaryURL?.path ?? asset.id.uuidString
    }

    /// `.maple/masks/` beside the asset's own folder, mirroring
    /// `ThumbnailDiskCache.configure(folderURL:)` / `RenderedPreviewCache
    /// .configure(folderURL:)`'s exact two-line resolution — deliberately
    /// NOT reusing either cache's already-resolved directory, since both are
    /// share-wide singletons keyed to whichever folder was most recently
    /// opened (see `ThumbnailDiskCache`'s `cacheDir` doc comment, #2763),
    /// not necessarily THIS session's asset. A sourceless asset (PhotoKit /
    /// Self-Hosted, no local folder) falls back to a fixed location under
    /// the app's own Caches directory, matching `ThumbnailDiskCache
    /// .sourcelessCacheDir`'s convention — a single shared directory is
    /// correct there too, since `MaskRasterStore` keys entries by digest
    /// (which already folds in asset identity), not by asset-scoped
    /// subdirectory.
    // `internal` (not `private`): `private` scopes to this FILE, but the
    // one call site is `EditSession.swift`'s `maskRasterStore` lazy-var
    // initializer, in the main class file, not this extension.
    func maskCacheDirectory() -> URL {
        if let folder = asset.primaryURL?.deletingLastPathComponent() {
            return folder.appendingPathComponent(".maple", isDirectory: true)
                .appendingPathComponent("masks", isDirectory: true)
        }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        return caches
            .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
            .appendingPathComponent("sourceless-masks", isDirectory: true)
    }

    /// A fresh, uncropped develop at reduced resolution — NOT the display
    /// preview (which may carry the crop) — for Vision segmentation, which
    /// needs a spatially faithful image, not colour-critical precision.
    /// RAW assets decode through the sized scene-linear FFI path and the
    /// SAME model-application + display-encode chain the canvas uses
    /// (skipping only the Auto Profile LUT fit and the as-shot WB anchor —
    /// neither matters for a Vision input); non-RAW assets (panoramas,
    /// JPEG/HEIF/PNG) go through the CoreImage-only path those already use
    /// everywhere else in this file's sibling `LocalHistogram.computeNonRaw`.
    private func renderForSegmentation() async throws -> CGImage {
        let target = CGSize(width: 1024, height: 1024)
        let pipeline = ImageEditPipeline()
        let ciImage: CIImage
        if asset.isRaw {
            guard let decoded = await pipeline.decodeSceneLinearSized(asset: asset, targetSize: target)
            else {
                throw PipelineError.renderFailed(code: -1, message: "mask segmentation decode failed")
            }
            ciImage = pipeline.processSceneLinear(
                decoded: decoded.image, model: model, targetSize: nil,
                asShot: nil, decodedAtModel: nil, profileLUT: nil,
                assetID: asset.id, noiseProfile: decoded.noiseProfile, iso: decoded.iso, wbFrame: decoded.wbFrame
            )
        } else {
            guard let decoded = await pipeline.decodeSceneLinearNonRaw(asset: asset, targetSize: target)
            else {
                throw PipelineError.renderFailed(code: -1, message: "mask segmentation decode failed")
            }
            ciImage = pipeline.processSceneLinearNonRaw(
                decoded: decoded, model: model, targetSize: nil, assetID: asset.id
            )
        }
        guard let image = pipeline.renderPreview(ciImage, targetSize: target) else {
            throw PipelineError.renderFailed(code: -2, message: "mask segmentation CGImage render failed")
        }
        return image
    }
}
