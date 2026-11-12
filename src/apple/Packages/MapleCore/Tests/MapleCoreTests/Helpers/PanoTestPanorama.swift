// PanoTestPanorama.swift — a stitched panorama on disk for tests: a real PNG
// and the Auto Crop sidecar the stitch records beside it.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

@testable import MapleCore

enum PanoTestPanorama {
  static let crop = PanoAutoCrop(
    outputWidth: 32, outputHeight: 16, x: 4, y: 2, width: 24, height: 12)

  static func pngData(width: Int, height: Int) throws -> Data {
    let data = NSMutableData()
    guard
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
      let destination = CGImageDestinationCreateWithData(
        data, UTType.png.identifier as CFString, 1, nil)
    else { throw CocoaError(.fileWriteUnknown) }
    context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.6, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    guard let image = context.makeImage() else { throw CocoaError(.fileWriteUnknown) }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
    return data as Data
  }

  /// Writes `p.png` into a new `directory` and, when `cropped`, records `crop`
  /// the way the stitch does, which leaves `p.xmp` beside it.
  static func stitched(in directory: URL, cropped: Bool = true) throws -> PanoResult {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let panorama = directory.appendingPathComponent("p.png")
    try pngData(width: crop.outputWidth, height: crop.outputHeight).write(to: panorama)
    guard cropped else { return PanoResult(outputURL: panorama, reportSummary: "") }
    try PanoAutoCropRecord.record(crop, forPanorama: panorama)
    return PanoResult(
      outputURL: panorama, reportSummary: "",
      edges: PanoEdgesReport(boundaryWarpStatus: .off, boundaryWarpApplied: 0, crop: crop))
  }
}
