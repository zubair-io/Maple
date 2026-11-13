// CropGeometry.swift — pure geometry for the interactive crop/straighten
// overlay (#638). A thin wrapper over the shared Rust implementation
// (`raw_core::canvas::crop`, #5714), which is a port of the web
// `crop-geometry.ts`; the web `crop-geometry.spec.ts`, the Rust tests and
// this package's `CropGeometryTests` assert the same invariants.
//
// No SwiftUI, no actor isolation — every function is a plain map over
// explicit inputs.
//
// Coordinate spaces:
//   • normalized — the `Crop` rect edges in [0, 1] against the
//     display-oriented image (post-EXIF). This is exactly what the
//     pipeline / XMP consume.
//   • footprint  — the image's on-screen rect in points at FIT zoom,
//     centered in the viewport (the crop tool forces fit + zero pan, so
//     the displayed image always maps 1:1 onto this rect).
//
// The straighten preview rotates the displayed IMAGE by `angle` while the
// crop rectangle stays axis-aligned — mirroring the renderer's "rotate the
// frame, then cut an axis-aligned rect" model (spec § 3.12). The preview
// applies no corner fill, matching the renderer, so a near-edge crop
// reveals the same corner in both preview and output.

import CoreGraphics
import Foundation
import RawPipeline

public enum CropGeometry {
  /// Minimum crop rectangle size as a fraction of each image axis. Stops
  /// a drag from collapsing the rect to zero. Matches the web
  /// `MIN_CROP_FRACTION`.
  public static let minCropFraction: Double = maple_canvas_crop_min_fraction()

  // MARK: - Types

  /// The image's on-screen rect (points) at fit zoom, centered in the
  /// viewport.
  public struct Footprint: Equatable, Sendable {
    public var left: Double
    public var top: Double
    public var width: Double
    public var height: Double

    public init(left: Double, top: Double, width: Double, height: Double) {
      self.left = left
      self.top = top
      self.width = width
      self.height = height
    }
  }

  /// A screen-space rectangle in points.
  public struct PxRect: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
      self.x = x
      self.y = y
      self.width = width
      self.height = height
    }
  }

  /// Handles the user can grab: 4 corners, 4 edge midpoints, plus the
  /// interior (move).
  public enum Handle: String, Equatable, Sendable, CaseIterable {
    case tl, tr, bl, br, t, b, l, r, move
  }

  // MARK: - Footprint / mapping

  /// Fit footprint: the largest centered rect of the image's aspect that
  /// fits the viewport, upscaling an image smaller than it — the same rule
  /// as `CanvasMath.fitPixelScale`, so the overlay aligns with the painted
  /// image.
  public static func fitFootprint(
    wrapW: Double, wrapH: Double, imgW: Double, imgH: Double
  ) -> Footprint {
    let rect = maple_canvas_crop_fit_footprint(
      MapleCanvasSize(width: wrapW, height: wrapH),
      MapleCanvasSize(width: imgW, height: imgH))
    return Footprint(left: rect.x, top: rect.y, width: rect.width, height: rect.height)
  }

  /// Crop rect (normalized) → screen rect (points) over the footprint.
  public static func cropRectToPx(_ crop: Crop, _ fp: Footprint) -> PxRect {
    PxRect(maple_canvas_crop_rect_in_view(MapleCanvasCrop(crop), MapleCanvasRect(fp)))
  }

  /// Screen point (points, viewport-relative) → normalized image coords,
  /// clamped to [0, 1]. Inverse of the footprint map.
  public static func pxToNormalized(
    _ px: Double, _ py: Double, _ fp: Footprint
  ) -> (nx: Double, ny: Double) {
    let point = maple_canvas_crop_view_point_to_normalized(
      MapleCanvasPoint(x: px, y: py), MapleCanvasRect(fp))
    return (point.x, point.y)
  }

  // MARK: - Hit testing

  /// Which handle (if any) the pointer hit. Corners win over edges; the
  /// interior is `.move`. `tol` is the grab radius in points. Returns
  /// `nil` outside the rect + tolerance.
  public static func hitTestHandle(
    _ px: Double, _ py: Double, _ rect: PxRect, _ tol: Double
  ) -> Handle? {
    Handle(
      code: maple_canvas_crop_hit_test(
        MapleCanvasPoint(x: px, y: py), MapleCanvasRect(rect), tol))
  }

  // MARK: - Resize

  /// Resize options for a handle drag. `aspect` (width / height of the
  /// FINAL image-space rect) locks the proportions; `nil` is a free crop.
  public struct ResizeOptions: Equatable, Sendable {
    /// Locked aspect as image-space width:height, or `nil` for free.
    public var aspect: Double?
    /// Image pixel dimensions, needed to honor a pixel aspect against
    /// the normalized rect (which is relative to each axis independently).
    public var imgW: Double
    public var imgH: Double

    public init(aspect: Double?, imgW: Double, imgH: Double) {
      self.aspect = aspect
      self.imgW = imgW
      self.imgH = imgH
    }
  }

  /// Apply a handle drag to a crop rect. `nx`/`ny` are the dragged pointer
  /// in normalized image coords. Edges are clamped so the rect keeps at
  /// least `minCropFraction` on each axis and never inverts; an aspect
  /// lock recomputes the free edge from the dragged one about the
  /// opposite/anchor corner.
  public static func resizeCrop(
    _ crop: Crop, _ handle: Handle, _ nx: Double, _ ny: Double, _ opts: ResizeOptions
  ) -> Crop {
    let options = MapleCanvasCropResizeOptions(
      has_aspect: opts.aspect == nil ? 0 : 1,
      aspect: opts.aspect ?? 0,
      image_size: MapleCanvasSize(width: opts.imgW, height: opts.imgH))
    return Crop(
      maple_canvas_crop_resize(
        MapleCanvasCrop(crop), handle.code, MapleCanvasPoint(x: nx, y: ny), options))
  }

  // MARK: - Move

  /// Translate the whole crop rect by a normalized delta, clamped so it
  /// stays inside the image without resizing.
  public static func moveCrop(_ crop: Crop, _ dnx: Double, _ dny: Double) -> Crop {
    Crop(
      maple_canvas_crop_move(
        MapleCanvasCrop(crop), MapleCanvasSize(width: dnx, height: dny)))
  }

  // MARK: - Aspect presets

  /// Build a centered crop rect of the given IMAGE-space aspect
  /// (width:height in pixels), as large as fits the frame. Used by the
  /// aspect-ratio presets. Preserves the straighten `angle`.
  public static func centeredCropForAspect(
    _ aspect: Double, _ imgW: Double, _ imgH: Double, _ angle: Double
  ) -> Crop {
    Crop(
      maple_canvas_crop_centered_for_aspect(
        aspect, MapleCanvasSize(width: imgW, height: imgH), angle))
  }
}

extension CropGeometry.Handle {
  init?(code: UInt32) {
    switch code {
    case UInt32(MAPLE_CANVAS_CROP_HANDLE_TOP_LEFT): self = .tl
    case UInt32(MAPLE_CANVAS_CROP_HANDLE_TOP_RIGHT): self = .tr
    case UInt32(MAPLE_CANVAS_CROP_HANDLE_BOTTOM_LEFT): self = .bl
    case UInt32(MAPLE_CANVAS_CROP_HANDLE_BOTTOM_RIGHT): self = .br
    case UInt32(MAPLE_CANVAS_CROP_HANDLE_TOP): self = .t
    case UInt32(MAPLE_CANVAS_CROP_HANDLE_BOTTOM): self = .b
    case UInt32(MAPLE_CANVAS_CROP_HANDLE_LEFT): self = .l
    case UInt32(MAPLE_CANVAS_CROP_HANDLE_RIGHT): self = .r
    case UInt32(MAPLE_CANVAS_CROP_HANDLE_MOVE): self = .move
    default: return nil
    }
  }

  var code: UInt32 {
    switch self {
    case .tl: return UInt32(MAPLE_CANVAS_CROP_HANDLE_TOP_LEFT)
    case .tr: return UInt32(MAPLE_CANVAS_CROP_HANDLE_TOP_RIGHT)
    case .bl: return UInt32(MAPLE_CANVAS_CROP_HANDLE_BOTTOM_LEFT)
    case .br: return UInt32(MAPLE_CANVAS_CROP_HANDLE_BOTTOM_RIGHT)
    case .t: return UInt32(MAPLE_CANVAS_CROP_HANDLE_TOP)
    case .b: return UInt32(MAPLE_CANVAS_CROP_HANDLE_BOTTOM)
    case .l: return UInt32(MAPLE_CANVAS_CROP_HANDLE_LEFT)
    case .r: return UInt32(MAPLE_CANVAS_CROP_HANDLE_RIGHT)
    case .move: return UInt32(MAPLE_CANVAS_CROP_HANDLE_MOVE)
    }
  }
}

extension MapleCanvasCrop {
  init(_ crop: Crop) {
    self.init(
      top: crop.top, left: crop.left, bottom: crop.bottom, right: crop.right,
      angle: crop.angle)
  }
}

extension MapleCanvasRect {
  init(_ footprint: CropGeometry.Footprint) {
    self.init(
      x: footprint.left, y: footprint.top, width: footprint.width,
      height: footprint.height)
  }

  init(_ rect: CropGeometry.PxRect) {
    self.init(x: rect.x, y: rect.y, width: rect.width, height: rect.height)
  }
}

extension CropGeometry.PxRect {
  init(_ rect: MapleCanvasRect) {
    self.init(x: rect.x, y: rect.y, width: rect.width, height: rect.height)
  }
}

extension Crop {
  init(_ crop: MapleCanvasCrop) {
    self.init(
      top: crop.top, left: crop.left, bottom: crop.bottom, right: crop.right,
      angle: crop.angle)
  }
}
