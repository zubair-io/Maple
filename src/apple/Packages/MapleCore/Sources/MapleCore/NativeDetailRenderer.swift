// NativeDetailRenderer.swift — viewport-bounded native-pixel RAW refinement.
//
// Zoom-to-fit stays on the sized whole-image decode. At 100% and above this
// actor opens one stripped-model RAW handle, develops only the visible source
// rectangle (plus a small filter halo), and returns scene-linear fp16 pixels
// for the normal Apple display chain. No full-sensor RGBAf buffer is created.

import CoreImage
import Foundation
import RawPipeline

/// Deep-zoom tile selection, resolved by the shared Rust implementation
/// (`raw_core::canvas::native_detail`, #5714): the 1:1 gate, the displayed
/// detail rect, the pan-reuse margin (#2063), the decode halo (#5169) and the
/// visible-region update decision. All rects are oriented source pixels with
/// a top-left origin.
enum NativeDetailLOD {
  private static let constants = maple_canvas_native_detail_constants()
  static let minimumPixelScale = CGFloat(constants.min_pixel_scale)
  /// Floor on the filter context around a patch; the per-tick chain's reach
  /// (`PipelineRenderer.sceneLinearChainWindowReach`) widens it (#5169).
  static let filterHalo = CGFloat(constants.filter_halo)
  /// The published patch grows by this fraction of the visible rect's longer
  /// edge, at most `panMarginCeiling` px, so small pans reuse it (#2063).
  static let panMarginFraction = CGFloat(constants.pan_margin_fraction)
  static let panMarginCeiling = CGFloat(constants.pan_margin_ceiling)

  /// At 1:1 or above, for a non-empty region not already covering the image.
  static func shouldRender(
    pixelScale: CGFloat,
    visibleRect: CGRect,
    imageSize: CGSize? = nil
  ) -> Bool {
    maple_canvas_native_detail_should_render(
      Double(pixelScale), MapleCanvasRect(visibleRect), MapleCanvasSize(imageSize ?? .zero)) != 0
  }

  /// The visible rect rounded outward and clamped to the oriented image.
  static func detailRect(visibleRect: CGRect, imageSize: CGSize) -> CGRect {
    CGRect(
      maple_canvas_native_detail_rect(MapleCanvasRect(visibleRect), MapleCanvasSize(imageSize)))
  }

  /// Total pixels the patch grows by on each axis (split across both edges).
  static func panMargin(for visibleRect: CGRect) -> CGFloat {
    CGFloat(maple_canvas_native_detail_pan_margin(MapleCanvasRect(visibleRect)))
  }

  /// The rect developed and published: `detailRect` grown by `panMargin`.
  static func patchRect(visibleRect: CGRect, imageSize: CGSize) -> CGRect {
    CGRect(
      maple_canvas_native_detail_patch_rect(
        MapleCanvasRect(visibleRect), MapleCanvasSize(imageSize)))
  }

  /// Source rect sent to the RAW tile entry: the patch plus a two-sided halo
  /// of at least `filterHalo`. Empty requests whole-image refinement.
  static func decodeRect(
    detailRect: CGRect, imageSize: CGSize, halo: CGFloat
  ) -> CGRect {
    CGRect(
      maple_canvas_native_detail_decode_rect(
        MapleCanvasRect(detailRect), MapleCanvasSize(imageSize), Double(halo)))
  }

  /// A top-left-oriented source rect in the local CoreImage (bottom-left
  /// origin) coordinates of its containing decode patch.
  static func localCoreImageRect(detailRect: CGRect, decodeRect: CGRect) -> CGRect {
    CGRect(
      maple_canvas_native_detail_bottom_up_rect(
        MapleCanvasRect(detailRect), MapleCanvasRect(decodeRect)))
  }

  /// Whether the published patch (nil when none) already covers `detailRect`.
  static func publishedPatchCovers(_ patch: CGRect?, detailRect: CGRect) -> Bool {
    maple_canvas_native_detail_patch_covers(
      patch == nil ? 0 : 1, MapleCanvasRect(patch ?? .zero), MapleCanvasRect(detailRect)) != 0
  }

  /// What a visible-region update must do to the published patch.
  static func visibleRegionChange(
    from previousViewport: CGRect, to viewport: CGRect,
    previousZoom: CGFloat, zoom: CGFloat,
    publishedPatch: CGRect?, imageSize: CGSize
  ) -> MapleCanvasVisibleRegionChange {
    maple_canvas_visible_region_change(
      MapleCanvasVisibleRegionUpdate(
        previous_viewport: MapleCanvasRect(previousViewport),
        viewport: MapleCanvasRect(viewport),
        previous_zoom: Double(previousZoom),
        zoom: Double(zoom),
        has_published_patch: publishedPatch == nil ? 0 : 1,
        published_patch: MapleCanvasRect(publishedPatch ?? .zero),
        image_size: MapleCanvasSize(imageSize)))
  }
}

/// Session-scoped, single-handle visible-region renderer. The handle cache key
/// uses only decode-baked fields, so normal slider changes reuse the decoded
/// mosaic; changes such as highlight recovery reopen it correctly.
actor NativeDetailRenderer {
  private struct HandleKey: Equatable {
    let url: URL
    let sourceMtime: Date
    let bakedModel: AdjustmentModel
  }

  private var handleKey: HandleKey?
  private var handle: MapleRawHandle?

  func render(
    asset: AssetRef,
    sourceRect: CGRect,
    model: AdjustmentModel
  ) throws -> CIImage {
    guard !Task.isCancelled else { throw CancellationError() }
    guard let url = asset.primaryURL else { throw PipelineError.noByteSource }

    var bakedModel = RawCoreBridge.stripAppleGPUStages(model)
    bakedModel.profile = model.profile
    bakedModel.look = .default
    let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
    let accessing = scope.startAccessingSecurityScopedResource()
    defer { if accessing { scope.stopAccessingSecurityScopedResource() } }

    let key = HandleKey(
      url: url,
      sourceMtime: Self.modificationDate(for: url),
      bakedModel: bakedModel
    )

    // The Rust tile ABI accepts display-oriented source coordinates and
    // applies the RAW's EXIF orientation internally. Keep this rect in the
    // same oriented coordinate space as the canvas; mapping it back to
    // sensor axes here would rotate/flip it a second time.
    let x = Int(sourceRect.minX.rounded())
    let y = Int(sourceRect.minY.rounded())
    let width = Int(sourceRect.width.rounded())
    let height = Int(sourceRect.height.rounded())
    guard x >= 0, y >= 0, width > 0, height > 0,
      x <= Int(UInt32.max), y <= Int(UInt32.max),
      width <= Int(UInt32.max), height <= Int(UInt32.max)
    else {
      throw PipelineError.renderFailed(code: 9, message: "invalid native-detail geometry")
    }

    let rawHandle: MapleRawHandle
    if handleKey == key, let handle {
      rawHandle = handle
    } else {
      guard !Task.isCancelled else { throw CancellationError() }
      // Release the old handle BEFORE opening its replacement (#2061g):
      // a baked-field edit (e.g. highlight recovery) reopens the handle
      // with a different `bakedModel`, and holding both the old and
      // new decoded mosaics live at once transiently doubles resident
      // memory (~30-300MB each). Nil-ing here drops this actor's only
      // strong reference so `MapleRawHandle.deinit` (which calls
      // `maple_close_raw_handle`) can run before the new open begins.
      // If `openRawHandle` throws, the renderer is simply left
      // handle-less — actor state stays consistent (both fields nil)
      // and the next `render` call reopens fresh.
      handle = nil
      handleKey = nil
      let opened = try PipelineRenderer.openRawHandle(
        rawPath: url,
        model: model,
        profileOverride: model.profile,
        autoExposureOverride: model.autoExposure
      )
      handleKey = key
      handle = opened
      rawHandle = opened
    }

    guard !Task.isCancelled else { throw CancellationError() }
    // The capture tile (#5377): the patch's capture result in the fixed
    // as-shot basis, f32 like the whole-image decode (#1945). White
    // balance, the camera profile, Oklab recovery and auto exposure are the
    // creative stage, which the windowed per-tick chain runs with the
    // whole-image decode's creative stage — so the patch matches the fit
    // view at every white balance, with no anchor to thread through here.
    let imageData = try PipelineRenderer.renderCaptureTileF32(
      handle: rawHandle,
      srcX: UInt32(x), srcY: UInt32(y),
      srcW: UInt32(width), srcH: UInt32(height),
      outW: UInt32(width), outH: UInt32(height),
      quality: .full
    )
    guard imageData.bytesPerPixel == 16 else {
      throw PipelineError.renderFailed(
        code: 9,
        message: "native-detail tile was not f32 RGBA"
      )
    }

    let colorSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
    return CIImage(
      bitmapData: imageData.pixels,
      bytesPerRow: imageData.width * imageData.bytesPerPixel,
      size: CGSize(width: imageData.width, height: imageData.height),
      format: .RGBAf,
      colorSpace: colorSpace
    )
  }

  private static func modificationDate(for url: URL) -> Date {
    let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attrs?[.modificationDate] as? Date) ?? .distantPast
  }
}
