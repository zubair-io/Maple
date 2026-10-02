// RenderActor+Export.swift — full-resolution export render (slice 2).
//
// Full RAW export uses the shared Rust float display terminal, including
// film, saved removals and geometry. Fast/non-RAW exports retain the bounded
// preview graph; the session applies their crop before destination encoding.

import CoreImage
import Foundation

extension RenderActor {
  // MARK: - Export (slice 2)

  public func renderForExport(
    asset: AssetRef,
    model: AdjustmentModel,
    asShot: ImageEditPipeline.AsShotWB?,
    targetSize: CGSize? = nil,
    qualityOverride: PipelineRenderer.Quality? = nil,
    // #3190 review follow-up: `EditSession.renderForExport()` composites
    // an sRGB-baked `FilmLookCube` on this function's NON-RAW result
    // when the asset has a resolvable look — the caller passes `.srgb`
    // in that case so the encode doesn't hand the cube P3-gamma bytes.
    // RAW and non-RAW callers may also pin the delivery primaries
    // independently of the live canvas (#1472).
    targetPrimariesOverride: CanvasColorSpace? = nil,
    filmLut: (data: [Float], size: Int, key: UInt32)? = nil
  ) async throws -> CIImage {
    let pipeline = self.pipeline
    let m = model

    if !asset.isRaw {
      let decoded: CIImage
      if targetSize != nil,
        decodedForAssetID == asset.id,
        let cached = decodedImage
      {
        decoded = cached
      } else {
        guard
          let freshlyDecoded = await pipeline.decodeSceneLinearNonRaw(
            asset: asset, targetSize: targetSize
          )
        else {
          throw RenderError.pipelineFailed
        }
        decoded = freshlyDecoded
      }
      return await Task.detached(priority: .userInitiated) {
        autoreleasepool {
          pipeline.processSceneLinearNonRaw(
            decoded: decoded, model: m, targetSize: targetSize,
            targetPrimariesOverride: targetPrimariesOverride
          )
        }
      }.value
    }

    let quality: PipelineRenderer.Quality =
      qualityOverride ?? (targetSize != nil ? .preview : (AmazeFlag.isEnabled ? .amaze : .full))

    guard let targetSize else {
      return try await renderFullRawExport(
        asset: asset, model: m, quality: quality,
        target: targetPrimariesOverride ?? CanvasColorSpace.current, filmLut: filmLut)
    }

    let liveBaked = RawCoreBridge.stripAppleGPUStages(m)
    let canReuseCachedDecode =
      decodedForAssetID == asset.id
      && decodedImage != nil
      && decodedProfile == m.profile
      && decodedAutoExposure == m.autoExposure
      && (decodedBakedModel == liveBaked
        || (decodedBakedModel == nil
          && liveBaked == RawCoreBridge.stripAppleGPUStages(AdjustmentModel())))

    let decodeResult: ImageEditPipeline.SceneLinearDecodeResult?
    if canReuseCachedDecode, let cached = decodedImage {
      decodeResult = ImageEditPipeline.SceneLinearDecodeResult(
        image: cached,
        noiseProfile: decodedNoiseProfile,
        iso: decodedISO,
        wbFrame: decodedWbFrame,
        aeGain: decodedAeGain,
        whitesAnchorEv: decodedWhitesAnchorEv, nrSamplingScale: decodedNrSamplingScale,
        hasLensCorrections: decodedHasLensCorrections,
        lensCorrectionCaInert: decodedLensCorrectionCaInert,
        lensCorrectionDistortionInert: decodedLensCorrectionDistortionInert,
        cameraSupport: decodedCameraSupport
      )
    } else {
      // Export uses one immutable snapshot of the live edits, including
      // decode-baked fields. A remote or not-yet-saved sidecar must not
      // silently select defaults (#3357).
      let sidecar = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-export-\(UUID().uuidString).xmp")
      let xml = XMPSerializer.serialize(model: m, culling: CullingState())
      try xml.write(to: sidecar, atomically: true, encoding: .utf8)
      defer { try? FileManager.default.removeItem(at: sidecar) }
      decodeResult = await pipeline.decodeSceneLinearSized(
        asset: asset, targetSize: targetSize, xmpPath: sidecar, quality: quality,
        profileOverride: m.profile, autoExposureOverride: m.autoExposure)
    }
    guard let exportDecodeResult = decodeResult else {
      throw RenderError.pipelineFailed
    }
    let profileLUT: CIFilter?
    if m.profile == .auto {
      let url: URL
      if canReuseCachedDecode, let staged = await rawRenderSource.stagedURLIfAvailable(for: asset) {
        url = staged
      } else {
        url = try await rawRenderSource.url(for: asset)
      }
      let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
      let accessing = scope.startAccessingSecurityScopedResource()
      defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
      profileLUT = await AutoProfileLUT.shared.filter(
        forRawAt: url, profile: m.profile, quality: quality)
    } else {
      profileLUT = nil
    }
    let exportNoiseProfile = exportDecodeResult.noiseProfile
    let exportISO = exportDecodeResult.iso
    let exportWbFrame = exportDecodeResult.wbFrame
    // Frame-less RAWs use absolute CAT16 in the full develop; a metadata
    // estimate is not a decode-baked camera WB anchor (#1472).
    let exportAnchor =
      exportWbFrame.flatMap { frame -> ImageEditPipeline.AsShotWB? in
        guard frame.isPresent else { return nil }
        return .init(temperature: Double(frame.sceneCCT), tint: Double(frame.asShotTint))
      }
      ?? (exportDecodeResult.cameraSupport?.resolution == .rawlerFallback
        ? .init(temperature: 6500.0, tint: 0.0)
        : asShot)
    return await Task.detached(priority: .userInitiated) {
      autoreleasepool {
        pipeline.processSceneLinear(
          decoded: exportDecodeResult.image,
          model: m,
          targetSize: targetSize,
          asShot: exportAnchor,
          decodedAtModel: m,
          profileLUT: profileLUT,
          noiseProfile: exportNoiseProfile,
          iso: exportISO,
          wbFrame: exportWbFrame, whitesAnchorEv: exportDecodeResult.whitesAnchorEv,
          targetPrimariesOverride: targetPrimariesOverride,
          nrSamplingScale: exportDecodeResult.nrSamplingScale
        )
      }
    }.value
  }

  /// Compatibility RGB8 file render with the shared film stage (#2683).
  /// The normal full export uses `renderFullRawExport` to retain float
  /// precision. This dedicated actor keeps the synchronous FFI off MainActor.
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
