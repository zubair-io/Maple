// CropOverlaySurface.swift — the crop tool's overlay, drawn by the shared Rust
// overlay renderer (#5715) instead of SwiftUI shapes.
//
// The overlay lives on its own upright, viewport-sized layer above the
// (straighten-rotated) image. On the GPU path wgpu draws it into a dedicated
// `CAMetalLayer` (`maple_gpu_present_crop_overlay`); on the CPU fallback the
// same primitives are rasterized by `raw_core::canvas::rasterize_overlay`
// into a bitmap the layer shows as its contents. Neither path touches the
// develop chain, so a crop drag redraws only this layer. Handle positions for
// accessibility come from the same Rust geometry.

import CoreGraphics
import Foundation
import QuartzCore
import RawPipeline

/// Everything the crop overlay is drawn from.
public struct CropOverlayInput: Equatable, Sendable {
  public var crop: Crop
  /// Viewport (overlay layer) size in points.
  public var viewport: CGSize
  /// Display-oriented image size in pixels.
  public var imageSize: CGSize
  /// Overlay pixels per point.
  public var pixelScale: Double
  /// The handle being dragged, if any; its frame edges are emphasised.
  public var activeHandle: CropGeometry.Handle?

  public init(
    crop: Crop, viewport: CGSize, imageSize: CGSize, pixelScale: Double,
    activeHandle: CropGeometry.Handle?
  ) {
    self.crop = crop
    self.viewport = viewport
    self.imageSize = imageSize
    self.pixelScale = pixelScale
    self.activeHandle = activeHandle
  }

  /// The overlay surface's size in pixels; zero on an axis with no extent.
  public var pixelSize: (width: Int, height: Int) {
    let scale = pixelScale.isFinite && pixelScale > 0 ? pixelScale : 1
    let pixels = { (points: CGFloat) -> Int in
      let value = (Double(points) * scale).rounded()
      return value.isFinite && value >= 1 ? Int(min(value, 16384)) : 0
    }
    return (pixels(viewport.width), pixels(viewport.height))
  }

  var ffi: MapleCanvasCropOverlayInput {
    MapleCanvasCropOverlayInput(
      crop: MapleCanvasCrop(crop),
      viewport: MapleCanvasSize(width: Double(viewport.width), height: Double(viewport.height)),
      image_size: MapleCanvasSize(
        width: Double(imageSize.width), height: Double(imageSize.height)),
      pixel_scale: pixelScale,
      active_handle: activeHandle?.code ?? UInt32(MAPLE_CANVAS_CROP_HANDLE_NONE))
  }
}

public enum CropOverlaySurface {
  /// The handles that get an accessible element: corners, then edges.
  public static let accessibleHandles: [CropGeometry.Handle] = [.tl, .tr, .bl, .br, .t, .b, .l, .r]

  /// A handle's centre in viewport points, from the Rust crop geometry.
  public static func handleCenter(_ handle: CropGeometry.Handle, _ input: CropOverlayInput)
    -> CGPoint
  {
    let point = maple_canvas_crop_handle_center(input.ffi, handle.code)
    return CGPoint(x: point.x, y: point.y)
  }

  private static let generationLock = NSLock()
  nonisolated(unsafe) private static var lastGeneration: UInt64 = 0

  /// A fresh surface generation for a newly created overlay layer, so the
  /// Rust surface cache never reuses a surface across layer instances that
  /// happen to share an address.
  public static func nextGeneration() -> UInt64 {
    generationLock.lock()
    defer { generationLock.unlock() }
    lastGeneration &+= 1
    return lastGeneration
  }

  /// Draw the overlay into `layer` on the GPU. Returns `false` when the GPU
  /// path is unavailable; the caller then switches to `rasterize`.
  public static func presentGpu(
    _ input: CropOverlayInput, layer: CAMetalLayer, generation: UInt64
  ) -> Bool {
    let size = input.pixelSize
    guard size.width > 0, size.height > 0 else { return true }
    let layerPtr = Unmanaged.passUnretained(layer).toOpaque()
    return maple_gpu_present_crop_overlay(
      input.ffi, layerPtr, generation, UInt32(size.width), UInt32(size.height)) == 0
  }

  /// Rasterize the overlay on the CPU into a premultiplied RGBA image the size
  /// of `input.pixelSize`, or `nil` for an empty surface.
  public static func rasterize(_ input: CropOverlayInput) -> CGImage? {
    let size = input.pixelSize
    guard size.width > 0, size.height > 0 else { return nil }
    let stride = size.width * 4
    let length = stride * size.height
    guard let data = CFDataCreateMutable(nil, length) else { return nil }
    CFDataSetLength(data, length)
    let rc = maple_canvas_crop_overlay_rasterize(
      input.ffi, UInt32(size.width), UInt32(size.height), stride,
      CFDataGetMutableBytePtr(data), length)
    guard rc == 0, let provider = CGDataProvider(data: data) else { return nil }
    return CGImage(
      width: size.width, height: size.height, bitsPerComponent: 8, bitsPerPixel: 32,
      bytesPerRow: stride, space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGBitmapInfo(
        rawValue: CGImageAlphaInfo.premultipliedLast.rawValue
          | CGBitmapInfo.byteOrder32Big.rawValue),
      provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
  }
}
