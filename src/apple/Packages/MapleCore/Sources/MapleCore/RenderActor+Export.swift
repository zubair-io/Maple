// RenderActor+Export.swift — full-resolution export render (slice 2).
//
// Extracted from `RenderActor.swift` to keep that file inside the 600-line
// hard budget (`tools/check-file-budget.sh`). Behaviour is unchanged: this
// is a verbatim move of the `renderForExport` method and its MARK section.
//
// Export is the one render path that genuinely wants a full-sensor decode —
// every interactive path decodes to a bounded display target (#785/#1637/
// #2058), so `renderForExport` is the sole remaining caller of the unsized
// `decodeSceneLinear` with the AMaZE flag gate (#940).

import Foundation
import CoreImage

extension RenderActor {
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
            profileOverride: asset.isRaw ? m.profile : nil,
            autoExposureOverride: asset.isRaw ? m.autoExposure : nil
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
}
