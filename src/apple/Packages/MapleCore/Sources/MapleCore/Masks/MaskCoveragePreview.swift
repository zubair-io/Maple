import CoreGraphics
import Foundation

/// Geometric coverage only, before colour-range refinement. Bitmap rasters are
/// resolved once by the caller, outside the pixel loop. Runs off the main actor.
public enum MaskCoveragePreview {
  public static func image(
    mask: LocalMask, imageSize: CGSize, rasters: [UInt32: MaskRasterStore.Raster],
    projection: MaskProjection = .identity
  ) -> CGImage? {
    guard imageSize.width.isFinite, imageSize.height.isFinite,
      imageSize.width > 0, imageSize.height > 0
    else { return nil }
    let scale = min(1, 512 / max(imageSize.width, imageSize.height))
    let width = max(1, Int((imageSize.width * scale).rounded()))
    let height = max(1, Int((imageSize.height * scale).rounded()))
    var rgba = [UInt8](repeating: 0, count: width * height * 4)
    for y in 0..<height {
      guard !Task.isCancelled else { return nil }
      for x in 0..<width {
        let presented = MaskPoint(
          x: Double(x) / Double(max(1, width - 1)),
          y: Double(y) / Double(max(1, height - 1)))
        let weight: Double
        if let frame = projection.apply(presented),
          (0...1).contains(frame.x), (0...1).contains(frame.y)
        {
          weight = MaskWeight.evaluate(mask, x: frame.x, y: frame.y, rasters: rasters)
        } else {
          weight = 0
        }
        let alpha = weight.isFinite ? UInt8((min(1, max(0, weight)) * 255).rounded()) : 0
        let offset = (y * width + x) * 4
        for channel in 0..<4 { rgba[offset + channel] = alpha }
      }
    }
    guard let provider = CGDataProvider(data: Data(rgba) as CFData) else { return nil }
    return CGImage(
      width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
      bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
      provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
  }
}

@MainActor
extension EditSession {
  /// Resolve all component rasters using the same source cache as rendering.
  /// Missing or unresolved rasters leave the whole group inert, including invert.
  public func maskCoveragePreview(for mask: LocalMask) async -> CGImage? {
    var rasters: [UInt32: MaskRasterStore.Raster] = [:]
    for bitmap in mask.bitmapMasks where bitmap.rasterId != 0 {
      guard !Task.isCancelled else { return nil }
      if rasters[bitmap.rasterId] == nil {
        rasters[bitmap.rasterId] = try? await sourceMaskRaster(for: bitmap.recipe)
      }
    }
    // Brush leaves re-rasterize from their dabs through the same
    // `maple_brush_rasterize` the registry upload uses, so the preview is
    // exactly what the render samples.
    for brush in mask.brushMasks where brush.rasterId != 0 {
      guard !Task.isCancelled else { return nil }
      if rasters[brush.rasterId] == nil, let raster = sourceBrushRaster(dabs: brush.dabs) {
        rasters[brush.rasterId] = raster
      }
    }
    let resolved = rasters
    let size = nativeImageSize
    let model = self.model
    let presentedSize = CropImageStage.croppedSize(model.crop, nativeSize: size)
    let projection = MaskProjection.presentationToFrame(
      crop: model.crop, perspective: model.perspective, nativeSize: size)
    let task = Task.detached(priority: .userInitiated) {
      MaskCoveragePreview.image(
        mask: mask, imageSize: presentedSize, rasters: resolved, projection: projection)
    }
    return await withTaskCancellationHandler {
      await task.value
    } onCancel: {
      task.cancel()
    }
  }
}
