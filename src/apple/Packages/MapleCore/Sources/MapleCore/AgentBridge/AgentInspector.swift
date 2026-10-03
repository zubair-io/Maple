import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import MapleAgentWire
import UniformTypeIdentifiers

/// Turns the on-canvas image into what an agent inspects: a JPEG and
/// display-referred measurements computed from the very same pixels, so
/// the picture and the numbers can never describe different renders.
///
/// Measurements are on the 8-bit sRGB encoding the photographer sees.
/// They describe display occupancy, not sensor data: near-white means
/// "at the top of the display range", which darkening alone can reduce.
enum AgentInspector {
  static let defaultMaxEdge = 1024
  static let maxEdgeRange = 256...2048
  static let nearWhiteThreshold: UInt8 = 250
  static let nearBlackThreshold: UInt8 = 5

  struct Region: Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    static func parse(_ value: JSONValue?) throws -> Region? {
      guard let value else { return nil }
      guard let x = value["x"]?.numberValue, let y = value["y"]?.numberValue,
        let width = value["width"]?.numberValue, let height = value["height"]?.numberValue
      else {
        throw AgentError(
          code: "invalid_arguments",
          message: "`region` needs numeric x, y, width and height (normalized 0…1).")
      }
      guard x >= 0, y >= 0, width > 0, height > 0, x + width <= 1.0001, y + height <= 1.0001
      else {
        throw AgentError(
          code: "invalid_arguments",
          message:
            "`region` must lie inside the image: 0 ≤ x, y and x + width, y + height ≤ 1, with positive size."
        )
      }
      return Region(x: x, y: y, width: width, height: height)
    }
  }

  struct Inspection {
    let jpeg: Data
    let width: Int
    let height: Int
    let metrics: JSONValue
  }

  static func parseMaxEdge(_ value: JSONValue?) throws -> Int {
    guard let value else { return defaultMaxEdge }
    guard let number = value.numberValue, number.rounded() == number,
      maxEdgeRange.contains(Int(number))
    else {
      throw AgentError(
        code: "invalid_arguments",
        message:
          "`max_edge` must be an integer in \(maxEdgeRange.lowerBound)…\(maxEdgeRange.upperBound).")
    }
    return Int(number)
  }

  static func inspect(_ image: CIImage, maxEdge: Int, region: Region?, context: CIContext)
    throws -> Inspection
  {
    let extent = image.extent.integral
    guard extent.width >= 1, extent.height >= 1, extent.width.isFinite else {
      throw AgentError(code: "render_unavailable", message: "The current render is empty.")
    }
    var cropped = image
    if let region {
      let rect = CGRect(
        x: extent.minX + region.x * extent.width,
        y: extent.maxY - (region.y + region.height) * extent.height,
        width: region.width * extent.width,
        height: region.height * extent.height
      ).integral.intersection(extent)
      cropped = image.cropped(to: rect)
    }
    let source = cropped.extent
    let scale = min(1, Double(maxEdge) / Double(max(source.width, source.height)))
    let width = max(1, Int((source.width * scale).rounded()))
    let height = max(1, Int((source.height * scale).rounded()))
    let scaled =
      cropped
      .transformed(by: CGAffineTransform(translationX: -source.minX, y: -source.minY))
      .transformed(
        by: CGAffineTransform(
          scaleX: CGFloat(width) / source.width, y: CGFloat(height) / source.height))
    guard let sRGB = CGColorSpace(name: CGColorSpace.sRGB),
      let cgImage = context.createCGImage(
        scaled, from: CGRect(x: 0, y: 0, width: width, height: height), format: .RGBA8,
        colorSpace: sRGB)
    else {
      throw AgentError(code: "render_unavailable", message: "Could not rasterize the render.")
    }
    let pixels = try rgbaBytes(cgImage, colorSpace: sRGB)
    return Inspection(
      jpeg: try jpeg(cgImage), width: width, height: height,
      metrics: metrics(rgba: pixels, width: width, height: height))
  }

  static func rgbaBytes(_ image: CGImage, colorSpace: CGColorSpace) throws -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let context = CGContext(
          data: buffer.baseAddress, width: image.width, height: image.height,
          bitsPerComponent: 8, bytesPerRow: image.width * 4, space: colorSpace,
          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
      else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
      return true
    }
    guard drawn else {
      throw AgentError(code: "render_unavailable", message: "Could not read the render's pixels.")
    }
    return bytes
  }

  static func jpeg(_ image: CGImage) throws -> Data {
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data, UTType.jpeg.identifier as CFString, 1, nil)
    else { throw AgentError(code: "render_unavailable", message: "JPEG encoder unavailable.") }
    CGImageDestinationAddImage(
      destination, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
      throw AgentError(code: "render_unavailable", message: "JPEG encoding failed.")
    }
    return data as Data
  }

  /// Display-referred statistics over an RGBA8 sRGB buffer.
  static func metrics(rgba: [UInt8], width: Int, height: Int) -> JSONValue {
    let count = width * height
    guard count > 0, rgba.count >= count * 4 else { return [:] }
    var lumaHistogram = [Int](repeating: 0, count: 256)
    var sums = (r: 0.0, g: 0.0, b: 0.0, chroma: 0.0)
    var nearWhite = 0
    var nearBlack = 0
    for index in 0..<count {
      let r = rgba[index * 4]
      let g = rgba[index * 4 + 1]
      let b = rgba[index * 4 + 2]
      let high = max(r, g, b)
      let low = min(r, g, b)
      if high >= nearWhiteThreshold { nearWhite += 1 }
      if high <= nearBlackThreshold { nearBlack += 1 }
      sums.r += Double(r)
      sums.g += Double(g)
      sums.b += Double(b)
      sums.chroma += Double(high - low)
      let luma = 0.2126 * Double(r) + 0.7152 * Double(g) + 0.0722 * Double(b)
      lumaHistogram[min(255, Int(luma.rounded()))] += 1
    }
    let total = Double(count)
    func percentile(_ p: Double) -> Double {
      let target = Int((p * total).rounded(.up))
      var seen = 0
      for (level, binCount) in lumaHistogram.enumerated() {
        seen += binCount
        if seen >= max(1, target) { return Double(level) / 255 }
      }
      return 1
    }
    let coarse = stride(from: 0, to: 256, by: 16).map { start in
      JSONValue.number(
        (Double(lumaHistogram[start..<(start + 16)].reduce(0, +)) / total * 10_000).rounded()
          / 10_000)
    }
    let meanLuma =
      lumaHistogram.enumerated().reduce(0.0) { $0 + Double($1.offset * $1.element) } / total / 255
    func round4(_ value: Double) -> JSONValue { .number((value * 10_000).rounded() / 10_000) }
    return [
      "basis":
        "8-bit sRGB display encoding of the on-screen render; luma uses Rec.709 weights on encoded values",
      "pixel_count": .int(count),
      "luma_mean": round4(meanLuma),
      "luma_percentiles": [
        "p01": round4(percentile(0.01)), "p05": round4(percentile(0.05)),
        "p50": round4(percentile(0.50)), "p95": round4(percentile(0.95)),
        "p99": round4(percentile(0.99)),
      ],
      "near_white_fraction": round4(Double(nearWhite) / total),
      "near_black_fraction": round4(Double(nearBlack) / total),
      "near_white_threshold": .int(Int(nearWhiteThreshold)),
      "near_black_threshold": .int(Int(nearBlackThreshold)),
      "channel_means": [
        "r": round4(sums.r / total / 255), "g": round4(sums.g / total / 255),
        "b": round4(sums.b / total / 255),
      ],
      "mean_chroma": round4(sums.chroma / total / 255),
      "luma_histogram_16": .array(coarse),
    ]
  }
}
