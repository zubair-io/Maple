// GpuCanvasPlaceholder.swift — the canvas placeholder on the GPU live canvas
// (#5758): the grid thumbnail, then the server or cached preview, drawn into
// the canvas's own CAMetalLayer through the live chain's present pass, until
// the photo's first rendered frame replaces it in the same drawable.
//
// The layer is laid out at the photo's frame by the zoom host, so the
// placeholder moves with every zoom and pan exactly as the render does, and
// the swap changes only the pixels. The re-encode into the canvas's colour
// space, the surface size and the present all live in the shared core
// (`maple_gpu_present_placeholder`); this file decodes the still and keeps the
// one ordering rule: no placeholder may land after the live chain started
// presenting.

import CoreGraphics
import Foundation
import QuartzCore
import RawPipeline

/// A decoded still in the 8-bit RGBX layout the placeholder present reads.
public struct GpuPlaceholderPixels: Sendable, Equatable {
  public let bytes: [UInt8]
  public let width: Int
  public let height: Int
  /// 0 sRGB, 1 Display P3 (`PlaceholderColorSpace`).
  public let colorSpace: UInt32

  /// The largest long edge uploaded. A display preview is 1280 px and a
  /// grid thumbnail 512. The present pass resamples bilinearly from four
  /// texels, so a still much larger than the viewport would alias, and the
  /// core refuses one past `PLACEHOLDER_MAX_EDGE` (4096).
  public static let maxLongEdge = 2048

  /// Draws `image` into an RGBX bitmap in Display P3 when it is wide-gamut,
  /// otherwise in sRGB (CoreGraphics converts the profile either way),
  /// scaled down to `maxLongEdge`. `nil` for an empty image.
  public init?(image: CGImage) {
    guard image.width > 0, image.height > 0 else { return nil }
    let longEdge = max(image.width, image.height)
    let scale = min(1, Double(Self.maxLongEdge) / Double(longEdge))
    let width = max(1, Int((Double(image.width) * scale).rounded(.down)))
    let height = max(1, Int((Double(image.height) * scale).rounded(.down)))
    let isDisplayP3 =
      image.colorSpace.map { $0.name == CGColorSpace.displayP3 || $0.isWideGamutRGB } ?? false
    guard
      let space = CGColorSpace(name: isDisplayP3 ? CGColorSpace.displayP3 : CGColorSpace.sRGB)
    else { return nil }
    let rowBytes = width * 4
    var bytes = [UInt8](repeating: 0, count: rowBytes * height)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let context = CGContext(
          data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
          bytesPerRow: rowBytes, space: space,
          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            | CGBitmapInfo.byteOrder32Big.rawValue)
      else { return false }
      context.interpolationQuality = .high
      context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard drawn else { return nil }
    self.bytes = bytes
    self.width = width
    self.height = height
    self.colorSpace = isDisplayP3 ? 1 : 0
  }

  /// Whether the still can fill a layer of `bounds` without visibly
  /// stretching: the layer scales the drawable to its bounds, and the still
  /// is drawn edge to edge. A grid thumbnail's rounded short edge stays well
  /// inside the tolerance; unknown bounds (not laid out yet) fit.
  func fits(_ bounds: CGSize) -> Bool {
    guard bounds.width > 0, bounds.height > 0 else { return true }
    let stillAspect = Double(width) / Double(height)
    let boundsAspect = Double(bounds.width / bounds.height)
    return abs(stillAspect / boundsAspect - 1) <= Self.aspectTolerance
  }

  static let aspectTolerance = 0.01
}

/// The placeholder's ordering rule, kept apart from the GPU so it is tested
/// without one. A placeholder may present only until the live chain's first
/// present is issued for the current layer; a newly registered layer is blank
/// again, so it may show the placeholder until the chain presents into it.
struct GpuPlaceholderGate: Equatable {
  private(set) var chainIssued = false
  /// The latest still for the open photo, re-presented when a new layer
  /// registers before the chain has presented.
  private(set) var pending: GpuPlaceholderPixels?
  private(set) var viewportPx: CGSize = .zero

  var accepts: Bool { !chainIssued }

  /// Records `pixels` as the still to show and returns whether it may be
  /// presented now. A still offered after the chain owns the layer is kept
  /// for the next layer, which starts blank.
  mutating func offer(_ pixels: GpuPlaceholderPixels, viewportPx: CGSize) -> Bool {
    pending = pixels
    self.viewportPx = viewportPx
    return accepts
  }

  mutating func chainWillPresent() {
    chainIssued = true
    pending = nil
  }

  /// A different layer registered: it holds nothing yet. Returns whether
  /// there is a still to present into it.
  mutating func layerChanged() -> Bool {
    chainIssued = false
    return pending != nil
  }
}

/// Serializes placeholder presents off the main actor. The Rust side takes
/// the same process-wide GPU lock as the live chain's present.
actor GpuPlaceholderPresenter {
  static let shared = GpuPlaceholderPresenter()

  /// `maple_gpu_present_placeholder`'s return code: 0 presented, 4 cancelled.
  func present(
    _ pixels: GpuPlaceholderPixels, layer: CAMetalLayer, viewportPx: CGSize,
    target: CanvasColorSpace, cancel: CancelFlag, surfaceGeneration: UInt64
  ) -> Int32 {
    let layerPointer = Unmanaged.passUnretained(layer).toOpaque()
    let rc = pixels.bytes.withUnsafeBufferPointer { buffer in
      maple_gpu_present_placeholder(
        buffer.baseAddress, UInt32(pixels.width), UInt32(pixels.height), UInt(pixels.width * 4),
        pixels.colorSpace, target == .displayP3 ? 1 : 0,
        Double(viewportPx.width), Double(viewportPx.height),
        layerPointer, cancel.pointer, surfaceGeneration)
    }
    withExtendedLifetime(cancel) {}
    return rc
  }
}
