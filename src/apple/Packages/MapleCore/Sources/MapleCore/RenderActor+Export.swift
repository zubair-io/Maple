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
        asShot: ImageEditPipeline.AsShotWB?,
        // #3190 review follow-up: `EditSession.renderForExport()` composites
        // an sRGB-baked `FilmLookCube` on this function's NON-RAW result
        // when the asset has a resolvable look — the caller passes `.srgb`
        // in that case so the encode doesn't hand the cube P3-gamma bytes.
        // The RAW branch below never needs this: a RAW export with a
        // resolved look takes the bit-exact `maple_render_file_with_film`
        // path instead and never reaches here (see
        // `EditSession.renderForExport()`'s doc comment), so film is
        // guaranteed inactive whenever the RAW branch runs.
        targetPrimariesOverride: CanvasColorSpace? = nil
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
                    decoded: decoded, model: m, targetSize: nil,
                    targetPrimariesOverride: targetPrimariesOverride
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

    /// Full decode→develop→render of a RAW+XMP with a film-look lattice
    /// blended in (epic #2683, Task 10 / bugfix round 2). Wraps
    /// `PipelineRenderer.render(rawPath:xmpPath:quality:filmLut:)` —
    /// `maple_render_file_with_film` under the FFI — the same heavy,
    /// CPU-bound call the plain `renderForExport` above keeps off the main
    /// actor via `Task.detached`. This entry doesn't need the extra
    /// `Task.detached` hop: `PipelineRenderer` is a stateless `Sendable`
    /// struct around the FFI, and `RenderActor` is already a dedicated
    /// actor distinct from `@MainActor` — running the call directly inside
    /// this method keeps it off the main actor without adding a second
    /// concurrency domain to reason about.
    ///
    /// `EditSession.renderExportWithFilmLook()` keeps the `@MainActor`-side
    /// responsibilities (the applicability guard, flushing the pending
    /// sidecar write, resolving the lattice from `filmLutStore`) and awaits
    /// this method for the heavy render only.
    public func renderExportWithFilmLook(
        rawPath: URL,
        xmpPath: URL?,
        quality: PipelineRenderer.Quality,
        filmLut: (data: [Float], size: Int, key: UInt32)?
    ) throws -> MapleImageData {
        try PipelineRenderer.render(
            rawPath: rawPath,
            xmpPath: xmpPath,
            quality: quality,
            filmLut: filmLut
        )
    }
}
