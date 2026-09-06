import CoreImage
import Foundation

extension LocalHistogram {
  /// Rasterize only a small display-encoded image on the CPU-canvas path.
  /// Explicit output primaries keep the histogram in the canvas's color space.
  static func displayedImage(
    _ image: CIImage, context: CIContext, colorSpace: CanvasColorSpace
  ) async throws -> CloudHistogram {
    try Task.checkCancellation()
    let extent = image.extent
    guard extent.width.isFinite, extent.height.isFinite, extent.width >= 1, extent.height >= 1
    else { throw PipelineError.renderFailed(code: -1, message: "invalid histogram extent") }
    let scale = min(1, 512 / max(extent.width, extent.height))
    let width = max(1, Int((extent.width * scale).rounded(.down)))
    let height = max(1, Int((extent.height * scale).rounded(.down)))
    let small = image.transformed(
      by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY)
    )
    .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let name = colorSpace == .displayP3 ? CGColorSpace.displayP3 : CGColorSpace.sRGB
    guard let space = CGColorSpace(name: name) else {
      throw PipelineError.renderFailed(code: -1, message: "histogram color space unavailable")
    }
    var rgba = [UInt8](repeating: 0, count: width * height * 4)
    rgba.withUnsafeMutableBytes {
      context.render(
        small, toBitmap: $0.baseAddress!, rowBytes: width * 4,
        bounds: CGRect(x: 0, y: 0, width: width, height: height), format: .RGBA8, colorSpace: space)
    }
    try Task.checkCancellation()
    return sample(rgba, width: width, height: height, components: 4)
  }

  private static func sample(
    _ pixels: [UInt8], width: Int, height: Int, components: Int
  ) -> CloudHistogram {
    let step = max(1, (max(width, height) + 511) / 512)
    var red = [Int](repeating: 0, count: 256)
    var green = red
    var blue = red
    pixels.withUnsafeBufferPointer { bytes in
      for y in stride(from: 0, to: height, by: step) {
        for x in stride(from: 0, to: width, by: step) {
          let offset = (y * width + x) * components
          red[Int(bytes[offset])] += 1
          green[Int(bytes[offset + 1])] += 1
          blue[Int(bytes[offset + 2])] += 1
        }
      }
    }
    return CloudHistogram(r: red, g: green, b: blue)
  }
}
