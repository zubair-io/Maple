import CoreGraphics
import CoreImage
import Foundation
import MapleAgentWire

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
    let profileLUT =
      resolvedIsRaw ? await autoProfileLUTForCPURender(asset: asset, model: model) : nil
    let capture = Task.detached(priority: .userInitiated) {
      () throws -> (canvas: CIImage, weights: CIImage?) in
      guard let floats = pipeline.sceneLinearFloats(from: decoded, targetSize: target) else {
        throw AgentError(
          code: "render_unavailable", message: "Could not read the captured scene buffer.")
      }
      let scale = NoiseSamplingScale.reduced(
        snapshot.nrSamplingScale, from: source,
        to: CGSize(width: floats.width, height: floats.height))
      let params = PipelineRenderer.makeParams(
        from: model,
        decodedTemperature: resolvedIsRaw ? (anchor?.temperature ?? 6500) : 6500,
        decodedTint: resolvedIsRaw ? (anchor?.tint ?? 0) : 0, skipAgX: !resolvedIsRaw,
        iso: snapshot.iso, wbFrame: resolvedIsRaw ? snapshot.wbFrame : nil,
        whitesAnchorEv: snapshot.whitesAnchorEv, nrSamplingScale: scale)
      let paired = try PipelineRenderer.agentScopeFrame(
        pixels: floats.pixels,
        width: floats.width, height: floats.height, params: params, layer: layer,
        noiseProfile: snapshot.noiseProfile, localAdjustments: model.localAdjustments)
      let rgb = stride(from: 0, to: paired.count, by: 4).flatMap { i in
        [paired[i], paired[i + 1], paired[i + 2], Float(1)]
      }
      let encoded = CIImage(
        bitmapData: rgb.withUnsafeBufferPointer { Data(buffer: $0) },
        bytesPerRow: floats.width * 16, size: CGSize(width: floats.width, height: floats.height),
        format: .RGBAf, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
      let auto = AutoProfileLUT.apply(profileLUT, to: encoded)
      let final = FilmLookCube.apply(
        to: auto, lattice: filmLattice, strengthPct: model.filmStrength)
      let canvas = CropImageStage.apply(crop, to: final, nativeSize: nativeSize)
      guard maskID != nil else { return (canvas, nil) }
      let coverage = stride(from: 3, to: paired.count, by: 4).map { paired[$0] }
      let weights = CIImage(
        bitmapData: coverage.withUnsafeBufferPointer { Data(buffer: $0) },
        bytesPerRow: floats.width * 4, size: CGSize(width: floats.width, height: floats.height),
        format: .Rf, colorSpace: nil)
      return (canvas, CropImageStage.apply(crop, to: weights, nativeSize: nativeSize))
    }
    return try await capture.value
  }
}
