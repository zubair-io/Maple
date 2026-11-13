// CropOverlaySurface.swift — the crop tool's overlay, drawn by the shared Rust
// overlay renderer (#5715) instead of SwiftUI shapes.
//
// The overlay lives on its own upright layer, the viewport plus an overscan
// margin, above the (straighten-rotated) image. On the GPU path wgpu draws it
// into a dedicated `CAMetalLayer` (`maple_gpu_present_crop_overlay`); on the
// CPU fallback the same primitives are rasterized by
// `raw_core::canvas::rasterize_overlay` into a bitmap the layer shows as its
// contents. Neither path touches the develop chain, so a crop drag redraws
// only this layer. Handle positions for accessibility come from the same Rust
// geometry.

import CoreGraphics
import Foundation
import QuartzCore
import RawPipeline

/// Everything the crop overlay is drawn from.
public struct CropOverlayInput: Equatable, Sendable {
  public var crop: Crop
  /// Viewport size in points; the overlay layer overscans it by `overscan`.
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

  /// Points the overlay surface extends past the viewport on every side, so
  /// corner dots and frame strokes on a viewport edge are drawn whole.
  public static var overscan: CGFloat { CGFloat(maple_canvas_crop_overlay_overscan()) }

  /// The overlay surface's size in pixels, the viewport plus `overscan` on
  /// every side; zero on an axis with no extent or past the 16384 px
  /// texture limit, which draws nothing.
  public var pixelSize: (width: Int, height: Int) {
    let scale = pixelScale.isFinite && pixelScale > 0 ? pixelScale : 1
    let pixels = { (points: CGFloat) -> Int in
      guard (Double(points) * scale).rounded() >= 1 else { return 0 }
      let value = (Double(points + 2 * Self.overscan) * scale).rounded()
      return value.isFinite && value <= 16384 ? Int(value) : 0
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

  /// The outcome of one GPU overlay present.
  public enum GpuPresentResult: Equatable, Sendable {
    case presented
    /// The surface has no pixels (zero or past the texture limit); nothing
    /// was drawn and the layer's previous frame is stale.
    case empty
    /// This frame failed (a drawable timeout, a lost surface); the next
    /// present starts from a fresh surface.
    case frameFailed
    /// No GPU device: the GPU path will not work this process.
    case unavailable
  }

  /// Draw the overlay into `layer` on the GPU.
  public static func presentGpu(
    _ input: CropOverlayInput, layer: CAMetalLayer, generation: UInt64
  ) -> GpuPresentResult {
    let size = input.pixelSize
    guard size.width > 0, size.height > 0 else { return .empty }
    let layerPtr = Unmanaged.passUnretained(layer).toOpaque()
    switch maple_gpu_present_crop_overlay(
      input.ffi, layerPtr, generation, UInt32(size.width), UInt32(size.height))
    {
    case 0: return .presented
    case -5: return .unavailable
    default: return .frameFailed
    }
  }

  /// Release the GPU surface drawn under `generation`, which holds a
  /// reference to its layer and drawables until released.
  public static func releaseGpu(generation: UInt64) {
    _ = maple_gpu_release_crop_overlay(generation)
  }
}

/// CPU-fallback rasterization into a small pool of reused pixel buffers.
///
/// Each frame's `CGImage` wraps a pooled buffer through a data provider whose
/// release callback hands the buffer back once Core Animation drops the
/// image, so a buffer is never rewritten while an image still shows it and a
/// redraw at a stable size allocates no pixel memory. Rows are padded to 64
/// bytes for Core Animation's upload.
public final class CropOverlayRasterPool: @unchecked Sendable {
  private let lock = NSLock()
  private var free: [UnsafeMutableRawPointer] = []
  private var bufferLength = 0

  public init() {}

  deinit {
    for buffer in free { buffer.deallocate() }
  }

  /// The overlay as a premultiplied RGBA image, or `nil` for an empty surface.
  public func rasterize(_ input: CropOverlayInput) -> CGImage? {
    let size = input.pixelSize
    guard size.width > 0, size.height > 0 else { return nil }
    let stride = (size.width * 4 + 63) / 64 * 64
    let length = stride * size.height
    let buffer = take(length: length)
    let rc = maple_canvas_crop_overlay_rasterize(
      input.ffi, UInt32(size.width), UInt32(size.height), UInt(stride),
      buffer.assumingMemoryBound(to: UInt8.self), UInt(length))
    guard rc == 0 else {
      give(buffer, length: length)
      return nil
    }
    let lease = Unmanaged.passRetained(RasterLease(pool: self, length: length)).toOpaque()
    guard
      let provider = CGDataProvider(
        dataInfo: lease, data: buffer, size: length,
        releaseData: { info, data, _ in
          guard let info else { return }
          let lease = Unmanaged<RasterLease>.fromOpaque(info).takeRetainedValue()
          lease.pool.give(UnsafeMutableRawPointer(mutating: data), length: lease.length)
        })
    else {
      Unmanaged<RasterLease>.fromOpaque(lease).release()
      give(buffer, length: length)
      return nil
    }
    return CGImage(
      width: size.width, height: size.height, bitsPerComponent: 8, bitsPerPixel: 32,
      bytesPerRow: stride, space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGBitmapInfo(
        rawValue: CGImageAlphaInfo.premultipliedLast.rawValue
          | CGBitmapInfo.byteOrder32Big.rawValue),
      provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
  }

  /// Buffers held for reuse right now; for tests.
  var pooledCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return free.count
  }

  private func take(length: Int) -> UnsafeMutableRawPointer {
    lock.lock()
    defer { lock.unlock() }
    if length != bufferLength {
      for buffer in free { buffer.deallocate() }
      free.removeAll()
      bufferLength = length
    }
    return free.popLast() ?? UnsafeMutableRawPointer.allocate(byteCount: length, alignment: 64)
  }

  fileprivate func give(_ buffer: UnsafeMutableRawPointer, length: Int) {
    lock.lock()
    defer { lock.unlock() }
    if length == bufferLength, free.count < 3 {
      free.append(buffer)
    } else {
      buffer.deallocate()
    }
  }
}

private final class RasterLease {
  let pool: CropOverlayRasterPool
  let length: Int
  init(pool: CropOverlayRasterPool, length: Int) {
    self.pool = pool
    self.length = length
  }
}
