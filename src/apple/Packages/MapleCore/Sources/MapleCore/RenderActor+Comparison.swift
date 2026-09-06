import CoreImage
import Foundation

extension RenderActor {
  /// A comparison uses the same bounded decode/develop chain as the editor,
  /// with an immutable model. It never changes the live session or its XMP.
  func renderComparison(
    asset: AssetRef, model: AdjustmentModel, target: CGSize, nativeSize: CGSize,
    asShot: ImageEditPipeline.AsShotWB? = nil,
    filmLattice: (data: [Float], size: Int, key: UInt32)?
  ) async throws -> CIImage {
    let pipeline = self.pipeline
    let source = rawRenderSource
    let cancel = CancelFlag()
    let work = Task.detached(priority: .userInitiated) {
      let sidecar = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-comparison-\(UUID().uuidString).xmp")
      let xml = XMPSerializer.serialize(model: model, culling: CullingState())
      try xml.write(to: sidecar, atomically: true, encoding: .utf8)
      defer { try? FileManager.default.removeItem(at: sidecar) }
      let raw: ImageEditPipeline.SceneLinearDecodeResult?
      let decoded: CIImage
      if asset.isRaw {
        let url = try await source.url(for: asset)
        let fileAsset = AssetRef(url: url, scopeParentURL: asset.scopeParentURL)
        raw = await pipeline.decodeSceneLinearSized(
          asset: fileAsset, targetSize: target, xmpPath: sidecar,
          profileOverride: model.profile, autoExposureOverride: model.autoExposure,
          cancel: cancel)
        guard let image = raw?.image else { throw RenderError.pipelineFailed }
        decoded = image
      } else {
        raw = nil
        guard let image = await pipeline.decodeSceneLinearNonRaw(asset: asset, targetSize: target)
        else { throw RenderError.pipelineFailed }
        decoded = image
      }
      try Task.checkCancellation()
      let profileLUT: CIFilter?
      if asset.isRaw, model.profile == .auto {
        let url = try await source.url(for: asset)
        let scope = asset.scopeParentURL ?? url
        let access = scope.startAccessingSecurityScopedResource()
        defer { if access { scope.stopAccessingSecurityScopedResource() } }
        profileLUT = await AutoProfileLUT.shared.filter(
          forRawAt: url, profile: .auto, quality: .preview)
      } else {
        profileLUT = nil
      }
      try Task.checkCancellation()
      let boundedTarget = ImageEditPipeline.cappedToDelivered(
        target, delivered: decoded.extent.size)
      let filmActive = filmLattice != nil && model.filmStrength > 0
      let processed: CIImage
      if let raw {
        let anchor =
          raw.wbFrame.flatMap { frame -> ImageEditPipeline.AsShotWB? in
            guard frame.isPresent else { return nil }
            return ImageEditPipeline.AsShotWB(
              temperature: Double(frame.sceneCCT), tint: Double(frame.asShotTint))
          } ?? asShot
        processed = pipeline.processSceneLinear(
          decoded: decoded, model: model, targetSize: boundedTarget,
          asShot: anchor, decodedAtModel: model, profileLUT: profileLUT,
          noiseProfile: raw.noiseProfile, iso: raw.iso, wbFrame: raw.wbFrame,
          targetPrimariesOverride: filmActive ? .srgb : nil)
      } else {
        processed = pipeline.processSceneLinearNonRaw(
          decoded: decoded, model: model, targetSize: boundedTarget,
          targetPrimariesOverride: filmActive ? .srgb : nil)
      }
      let film = FilmLookCube.apply(
        to: processed, lattice: filmLattice, strengthPct: model.filmStrength)
      try Task.checkCancellation()
      return CropImageStage.apply(model.crop, to: film, nativeSize: nativeSize)
    }
    return try await withTaskCancellationHandler {
      try await work.value
    } onCancel: {
      work.cancel()
      cancel.requestCancel()
    }
  }
}
