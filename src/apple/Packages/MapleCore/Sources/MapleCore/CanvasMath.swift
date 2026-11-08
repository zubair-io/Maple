// CanvasMath.swift — one canvas snapshot's fit/zoom/framing math.
//
// A thin wrapper over the shared Rust implementation (`raw_core::canvas`,
// #5714): every derived value is resolved by `maple_canvas_math_resolve`, so
// Apple, and the other shells as they adopt it, read the same fit scale,
// display frame, render targets and visible source rect.
//
// Conventions:
//   • `viewportPx` is in REAL screen pixels (points × displayScale).
//   • `nativeImageSize` is in oriented full-image source pixels; `.zero`
//     until the metadata seed lands (`imageExtent` is then nil).
//   • `pixelScale`: 0 = fit, 1 = pixel-perfect, >1 = zoomed in.
//   • `panOffset` is in POINTS, positive = image dragged right/down.

import CoreGraphics
import Foundation
import RawPipeline

public struct CanvasMath: Sendable, Equatable {
  /// Largest render-target edge (Metal's texture-edge ceiling, #2061).
  public static let metalMaxTextureEdge = CGFloat(maple_canvas_constants().max_texture_edge)

  public let viewportPx: CGSize
  public let nativeImageSize: CGSize
  /// User-intent pixel scale; `effectivePixelScale` resolves fit.
  public let pixelScale: CGFloat
  public let panOffset: CGSize
  /// Points → real-pixels factor.
  public let displayScale: CGFloat

  public init(
    viewportPx: CGSize,
    nativeImageSize: CGSize,
    pixelScale: CGFloat,
    panOffset: CGSize = .zero,
    displayScale: CGFloat = 1
  ) {
    self.viewportPx = viewportPx
    self.nativeImageSize = nativeImageSize
    self.pixelScale = pixelScale
    self.panOffset = panOffset
    self.displayScale = displayScale
  }

  private var resolved: MapleCanvasMathResult {
    maple_canvas_math_resolve(
      MapleCanvasMathInput(
        viewport_px: MapleCanvasSize(viewportPx),
        native_image_size: MapleCanvasSize(nativeImageSize),
        pixel_scale: Double(pixelScale),
        pan_offset: MapleCanvasSize(panOffset),
        display_scale: Double(displayScale)
      ))
  }

  /// `nativeImageSize` once known, otherwise nil — fit math must not anchor
  /// to a preview-resolution buffer.
  public var imageExtent: CGSize? {
    let result = resolved
    return result.has_image_extent ? CGSize(result.image_extent) : nil
  }

  /// Fit-to-viewport scale; 1 when the image or viewport is unknown.
  public var fitPixelScale: CGFloat { CGFloat(resolved.fit_pixel_scale) }

  /// Scale at which the image covers the viewport; 1 when degenerate.
  public var fillPixelScale: CGFloat { CGFloat(resolved.fill_pixel_scale) }

  /// `pixelScale` with the `0 == fit` sentinel resolved.
  public var effectivePixelScale: CGFloat { CGFloat(resolved.effective_pixel_scale) }

  /// On-screen frame in points; nil until the image extent is known.
  public var displayFrameInPoints: CGSize? {
    let result = resolved
    return result.has_display_frame ? CGSize(result.display_frame_in_points) : nil
  }

  /// Fast-phase target (the viewport); nil while the viewport is unset.
  public var fastTargetSize: CGSize? {
    let result = resolved
    return result.has_fast_target ? CGSize(result.fast_target_size) : nil
  }

  /// Refined-phase target: `native × min(pixelScale, 1)`, floored at the fast
  /// target, capped at 2× the viewport long edge and `metalMaxTextureEdge`
  /// (#1637, #2061).
  public var refinedTargetSize: CGSize? {
    let result = resolved
    return result.has_refined_target ? CGSize(result.refined_target_size) : nil
  }

  /// Visible region in oriented source pixels, clamped to the image; `.zero`
  /// when degenerate.
  public var visibleSourceRect: CGRect {
    CGRect(resolved.visible_source_rect)
  }
}

extension MapleCanvasSize {
  init(_ size: CGSize) {
    self.init(width: Double(size.width), height: Double(size.height))
  }
}

extension MapleCanvasPoint {
  init(_ point: CGPoint) {
    self.init(x: Double(point.x), y: Double(point.y))
  }
}

extension CGSize {
  init(_ size: MapleCanvasSize) {
    self.init(width: size.width, height: size.height)
  }
}

extension MapleCanvasRect {
  init(_ rect: CGRect) {
    self.init(
      x: Double(rect.origin.x), y: Double(rect.origin.y),
      width: Double(rect.size.width), height: Double(rect.size.height))
  }
}

extension CGRect {
  init(_ rect: MapleCanvasRect) {
    self.init(x: rect.x, y: rect.y, width: rect.width, height: rect.height)
  }
}
