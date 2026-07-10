// EditSession+NativeDetail.swift — viewport-bounded 1:1 RAW refinement.

import CoreImage
import Foundation

@MainActor
extension EditSession {
    /// Drop the native-detail overlay and invalidate any result currently in
    /// flight. Pure pan/zoom refines intentionally do not bump the main render
    /// generation, so this independent token is the stale-work guard.
    func clearNativeDetailPreview() {
        if nativeDetailInFlightID != nil {
            nativeDetailInFlightID = nil
            isRendering = false
        }
        nativeDetailRequestID &+= 1
        nativeDetailPreview = nil
        nativeDetailSourceRect = .zero
    }

    /// Develop and publish a full-quality 1:1 patch for the current visible
    /// source rectangle. Returns false when the RAW tile entry rejects the
    /// model, allowing the bounded whole-image refine fallback to run.
    func refineNativeDetail(gen: UInt64) async -> Bool {
        let asset = self.asset
        let assetID = asset.id
        let detailRect = NativeDetailLOD.detailRect(
            visibleRect: viewportSourceRect,
            imageSize: nativeImageSize
        )
        let decodeRect = NativeDetailLOD.decodeRect(
            detailRect: detailRect,
            imageSize: nativeImageSize
        )
        guard !detailRect.isEmpty, !decodeRect.isEmpty else { return false }

        nativeDetailRequestID &+= 1
        let requestID = nativeDetailRequestID
        nativeDetailInFlightID = requestID
        // The rendering flag must flip in the same MainActor slice as the
        // in-flight token, BEFORE the first suspension: an invalidation that
        // lands mid-await clears `isRendering` and nils the token, and this
        // request's defer then must not re-assert either one.
        renderPhase = .refine
        isRendering = true
        defer {
            if nativeDetailInFlightID == requestID {
                nativeDetailInFlightID = nil
                isRendering = false
            }
        }
        let m = model
        let pipeline = self.pipeline
        let renderer = nativeDetailRenderer
        let snapshot = await renderActor.snapshot(forAsset: asset)
        adoptDecodedWbFrame(snapshot.wbFrame)
        let asShot = wbDeltaAnchor
        let decodedTemperature = snapshot.wbFrame?.isPresent == true
            ? WbSliderFrame.decodeBakeAnchor.temperature
            : asShot?.temperature
        let decodedTint = snapshot.wbFrame?.isPresent == true
            ? WbSliderFrame.decodeBakeAnchor.tint
            : asShot?.tint

        let signpostID = editSessionSignposter.makeSignpostID()
        let signpostState = editSessionSignposter.beginInterval(
            "native-detail", id: signpostID
        )
        defer { editSessionSignposter.endInterval("native-detail", signpostState) }

        editSessionLogger.debug(
            "native detail gen=\(gen) request=\(requestID) rect=\(detailRect.origin.x, format: .fixed(precision: 0)),\(detailRect.origin.y, format: .fixed(precision: 0)) \(detailRect.width, format: .fixed(precision: 0))x\(detailRect.height, format: .fixed(precision: 0))"
        )

        do {
            let decoded = try await renderer.render(
                asset: asset,
                sourceRect: decodeRect,
                model: m,
                decodedTemperature: decodedTemperature,
                decodedTint: decodedTint
            )
            guard requestID == nativeDetailRequestID, !Task.isCancelled else {
                return true
            }

            // Use the same preview-quality Auto Profile tail as the base
            // canvas; only demosaic/source sampling is native-resolution.
            let profileLUT: CIFilter? = await {
                guard m.profile == .auto, let url = asset.primaryURL else { return nil }
                return await AutoProfileLUT.shared.filter(
                    forRawAt: url,
                    profile: m.profile,
                    quality: .preview
                )
            }()
            let localDetailRect = NativeDetailLOD.localCoreImageRect(
                detailRect: detailRect,
                decodeRect: decodeRect
            )
            let materialised = await Task.detached(priority: .userInitiated) {
                () -> CIImage? in
                let processed = pipeline.processSceneLinear(
                    decoded: decoded,
                    model: m,
                    targetSize: nil,
                    asShot: asShot,
                    decodedAtModel: snapshot.decodedAtModel,
                    profileLUT: profileLUT,
                    // A viewport patch must not use the whole-image chain
                    // cache: its key has dimensions but no source origin.
                    assetID: nil,
                    noiseProfile: snapshot.noiseProfile,
                    iso: snapshot.iso,
                    wbFrame: snapshot.wbFrame
                )
                let cropped = processed.cropped(to: localDetailRect)
                guard let cg = pipeline.materializeRegion(
                    cropped,
                    rect: localDetailRect
                ) else { return nil }
                return CIImage(cgImage: cg)
            }.value

            let live = await renderActor.currentGeneration()
            guard requestID == nativeDetailRequestID,
                  gen == live,
                  !Task.isCancelled,
                  self.asset.id == assetID,
                  NativeDetailLOD.shouldRender(
                      pixelScale: pixelScale,
                      visibleRect: viewportSourceRect
                  )
            else { return true }
            guard let materialised else {
                editSessionLogger.warning(
                    "native detail materialise failed; using bounded refine fallback"
                )
                return false
            }

            nativeDetailPreview = materialised
            nativeDetailSourceRect = detailRect
            renderError = nil
            return true
        } catch is CancellationError {
            return true
        } catch {
            guard requestID == nativeDetailRequestID else { return true }
            editSessionLogger.warning(
                "native detail unavailable; using bounded refine fallback: \(error.localizedDescription, privacy: .public)"
            )
            return false
        }
    }
}
