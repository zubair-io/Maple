import CoreGraphics
import CoreImage
import Foundation
import MapleAgentWire
import RawPipeline

@MainActor
extension EditSession {
  /// Shared on-demand sRGB frame for inspector and scope. Ordinary canvas
  /// rendering keeps its selected primaries; canonical coverage is paired here.
  func agentCPUFrame(maskID: UUID?) async throws -> (canvas: CIImage, weights: CIImage?) {
    _ = await latestRenderSchedule?.value
    await renderActor.awaitCurrentRenderIfInFlight()
    guard let preview = renderedPreview else {
      throw AgentError(code: "render_unavailable", message: "The current render is unavailable.")
    }
    // An already-sRGB frame needs no second develop. Its lazy rasterization
    // remains owned by the detached inspector/scope consumer.
    if maskID == nil, let name = preview.colorSpace?.name,
      [
        CGColorSpace.sRGB, CGColorSpace.extendedSRGB, CGColorSpace.linearSRGB,
        CGColorSpace.extendedLinearSRGB,
      ].contains(where: { CFEqual(name, $0) })
    {
      return (preview, nil)
    }
    let initial = await renderActor.snapshot(forAsset: asset)
    if initial.image == nil || !initial.isFresh {
      // XMP publication may complete after the scheduled frame. Acquire the
      // actual current develop, then require a fresh canonical scene buffer.
      _scheduleRender(phase: .fast)
      _ = await latestRenderSchedule?.value
      await renderActor.awaitCurrentRenderIfInFlight()
    }
    let model = renderModel
    let snapshot = await renderActor.snapshot(forAsset: asset)
    let resolvedIsRaw = await renderActor.resolvedIsRaw(for: asset.id) ?? asset.isRaw
    guard let decoded = snapshot.image, snapshot.isFresh,
      !resolvedIsRaw
        || (snapshot.profile == model.profile && snapshot.autoExposure == model.autoExposure)
    else {
      throw AgentError(
        code: "render_unavailable",
        message: "Canonical capture requires the current decoded render.")
    }
    let layer: Int32
    if let maskID {
      guard let index = model.localAdjustments.firstIndex(where: { $0.id == maskID }) else {
        throw AgentError(
          code: "mask_not_found", message: "The selected mask is not active in this render.")
      }
      layer = Int32(index)
    } else {
      layer = -1
    }
    let crop = effectiveCrop
    let nativeSize = nativeImageSize
    let anchor = wbDeltaAnchor
    let pipeline = self.pipeline
    let source = decoded.extent.size
    let cropWidth =
      CropImageStage.shouldApply(crop)
      ? max(CropGeometry.minCropFraction, crop.right - crop.left) : 1
    let cropHeight =
      CropImageStage.shouldApply(crop)
      ? max(CropGeometry.minCropFraction, crop.bottom - crop.top) : 1
    let fullTarget = CGSize(
      width: preview.extent.width / cropWidth, height: preview.extent.height / cropHeight)
    let inputScale = min(1, 2048 / max(fullTarget.width, fullTarget.height))
    let target = CGSize(
      width: fullTarget.width * inputScale, height: fullTarget.height * inputScale)
    let filmLattice = filmLutStore.lattice(for: model.filmLook)
    let autoTail: (filter: CIFilter?, native: NativeAutoProfile?) =
      resolvedIsRaw
      ? await autoProfileLUTForCPURender(
        asset: asset, model: model, quality: snapshot.quality ?? .preview,
        decodeGeneration: snapshot.decodeGeneration) : (nil, nil)
    let capture = Task<(canvas: CIImage, weights: CIImage?), Error>.detached(
      priority: .userInitiated
    ) {
      try Self.captureAgentCPUFrame(
        pipeline: pipeline, decoded: decoded, target: target, source: source,
        snapshot: snapshot, model: model, resolvedIsRaw: resolvedIsRaw, anchor: anchor,
        layer: layer, crop: crop, nativeSize: nativeSize, profileLUT: autoTail.filter,
        nativeAutoProfile: autoTail.native,
        filmLattice: filmLattice, hasMask: maskID != nil)
    }
    return try await capture.value
  }

  nonisolated private static func captureAgentCPUFrame(
    pipeline: ImageEditPipeline, decoded: CIImage, target: CGSize, source: CGSize,
    snapshot: RenderActor.DecodedSnapshot, model: AdjustmentModel, resolvedIsRaw: Bool,
    anchor: ImageEditPipeline.AsShotWB?, layer: Int32, crop: Crop, nativeSize: CGSize,
    profileLUT: CIFilter?, nativeAutoProfile: NativeAutoProfile?,
    filmLattice: (data: [Float], size: Int, key: UInt32)?, hasMask: Bool
  ) throws -> (canvas: CIImage, weights: CIImage?) {
    guard let floats = pipeline.sceneLinearFloats(from: decoded, targetSize: target) else {
      throw AgentError(
        code: "render_unavailable", message: "Could not read the captured scene buffer.")
    }
    let scale: Float = NoiseSamplingScale.reduced(
      snapshot.nrSamplingScale, from: source,
      to: CGSize(width: floats.width, height: floats.height))
    let params: MapleAdjustmentParams = PipelineRenderer.makeParams(
      from: model,
      decodedTemperature: resolvedIsRaw ? (anchor?.temperature ?? 6500) : 6500,
      decodedTint: resolvedIsRaw ? (anchor?.tint ?? 0) : 0, skipAgX: !resolvedIsRaw,
      iso: snapshot.iso, wbFrame: resolvedIsRaw ? snapshot.wbFrame : nil,
      whitesAnchorEv: snapshot.whitesAnchorEv, nrSamplingScale: scale)
    let paired: [Float] = try PipelineRenderer.agentScopeFrame(
      pixels: floats.pixels,
      width: floats.width, height: floats.height, params: params, layer: layer,
      noiseProfile: snapshot.noiseProfile, localAdjustments: model.localAdjustments)
    var rgb = paired
    for index in stride(from: 3, to: rgb.count, by: 4) {
      rgb[index] = 1
    }
    // Canonical capture shares the settled native Auto tail with the canvas.
    // Coverage remains the paired pre-display weights, never color transformed.
    let rgbaData: Data
    if nativeAutoProfile?.artifacts != nil {
      let sceneData: Data = floats.pixels.withUnsafeBufferPointer { Data(buffer: $0) }
      rgbaData = try PipelineRenderer.applyChainAndEncodeDisplayTargetWithAuto(
        inputBytes: sceneData, width: floats.width, height: floats.height, params: params,
        targetPrimaries: CanvasColorSpace.srgb.wireValue, noiseProfile: snapshot.noiseProfile,
        localAdjustments: model.localAdjustments, nativeAutoProfile: nativeAutoProfile)
    } else {
      rgbaData = rgb.withUnsafeBufferPointer { Data(buffer: $0) }
    }
    let encoded: CIImage = CIImage(
      bitmapData: rgbaData,
      bytesPerRow: floats.width * 16, size: CGSize(width: floats.width, height: floats.height),
      format: .RGBAf, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
    let auto: CIImage = AutoProfileLUT.apply(profileLUT, to: encoded)
    let final: CIImage = FilmLookCube.apply(
      to: auto, lattice: filmLattice, strengthPct: model.filmStrength)
    let canvas: CIImage = CropImageStage.apply(crop, to: final, nativeSize: nativeSize)
    guard hasMask else { return (canvas, nil) }
    let coverage: [Float] = stride(from: 3, to: paired.count, by: 4).map { (index: Int) -> Float in
      paired[index]
    }
    let coverageData: Data = coverage.withUnsafeBufferPointer {
      (buffer: UnsafeBufferPointer<Float>) -> Data in
      Data(buffer: buffer)
    }
    let weights: CIImage = CIImage(
      bitmapData: coverageData,
      bytesPerRow: floats.width * 4, size: CGSize(width: floats.width, height: floats.height),
      format: .Rf, colorSpace: nil)
    return (canvas, CropImageStage.apply(crop, to: weights, nativeSize: nativeSize))
  }
}
