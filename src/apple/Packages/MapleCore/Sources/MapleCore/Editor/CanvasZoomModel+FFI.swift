// CanvasZoomModel+FFI.swift — CanvasZoomModel ↔ MapleCanvasZoomState and
// ZoomStop ↔ stop codes (#5714). Pure value conversion, no zoom rules.

import CoreGraphics
import Foundation
import RawPipeline

extension CanvasZoomModel {
  var ffi: MapleCanvasZoomState {
    MapleCanvasZoomState(
      pixel_scale: Double(pixelScale),
      pan_offset: MapleCanvasSize(panOffset),
      base_pan: MapleCanvasSize(basePan),
      has_drag_translation_base: dragTranslationBase == nil ? 0 : 1,
      drag_translation_base: MapleCanvasSize(dragTranslationBase ?? .zero),
      has_pinch_start_scale: pinchStartScale == nil ? 0 : 1,
      pinch_start_scale: Double(pinchStartScale ?? 0),
      pinch_start_pan: MapleCanvasSize(pinchStartPan),
      pinch_start_centroid: MapleCanvasPoint(pinchStartCentroid),
      pinch_last_centroid: MapleCanvasPoint(pinchLastCentroid),
      fills_viewport: fillsViewport ? 1 : 0,
      pinch_start_magnification: Double(pinchStartMagnification),
      pinch_last_magnification: Double(pinchLastMagnification),
      has_drag_last_translation: dragLastTranslation == nil ? 0 : 1,
      drag_last_translation: MapleCanvasSize(dragLastTranslation ?? .zero)
    )
  }

  mutating func adopt(_ state: MapleCanvasZoomState) {
    pixelScale = CGFloat(state.pixel_scale)
    panOffset = CGSize(state.pan_offset)
    basePan = CGSize(state.base_pan)
    dragTranslationBase =
      state.has_drag_translation_base != 0 ? CGSize(state.drag_translation_base) : nil
    pinchStartScale = state.has_pinch_start_scale != 0 ? CGFloat(state.pinch_start_scale) : nil
    pinchStartPan = CGSize(state.pinch_start_pan)
    pinchStartCentroid = CGPoint(x: state.pinch_start_centroid.x, y: state.pinch_start_centroid.y)
    pinchLastCentroid = CGPoint(x: state.pinch_last_centroid.x, y: state.pinch_last_centroid.y)
    fillsViewport = state.fills_viewport != 0
    pinchStartMagnification = CGFloat(state.pinch_start_magnification)
    pinchLastMagnification = CGFloat(state.pinch_last_magnification)
    dragLastTranslation =
      state.has_drag_last_translation != 0 ? CGSize(state.drag_last_translation) : nil
  }
}

extension CanvasZoomModel.ZoomStop {
  init?(code: UInt32) {
    switch code {
    case UInt32(MAPLE_CANVAS_ZOOM_STOP_FIT): self = .fit
    case UInt32(MAPLE_CANVAS_ZOOM_STOP_FILL): self = .fill
    case UInt32(MAPLE_CANVAS_ZOOM_STOP_ACTUAL_SIZE): self = .actualSize
    default: return nil
    }
  }

  var code: UInt32 {
    switch self {
    case .fit: return UInt32(MAPLE_CANVAS_ZOOM_STOP_FIT)
    case .fill: return UInt32(MAPLE_CANVAS_ZOOM_STOP_FILL)
    case .actualSize: return UInt32(MAPLE_CANVAS_ZOOM_STOP_ACTUAL_SIZE)
    }
  }
}

extension Optional where Wrapped == CanvasZoomModel.ZoomStop {
  var code: UInt32 { map(\.code) ?? UInt32(MAPLE_CANVAS_ZOOM_STOP_NONE) }
}

extension MapleCanvasZoomStops {
  /// The first three of `stops` (a stop cycle never has more).
  init(_ stops: [CanvasZoomModel.ZoomStop]) {
    let codes = stops.prefix(3).map(\.code) + [0, 0, 0]
    self.init(len: UInt32(min(stops.count, 3)), stops: (codes[0], codes[1], codes[2]))
  }

  var zoomStops: [CanvasZoomModel.ZoomStop] {
    let codes = [stops.0, stops.1, stops.2]
    return codes.prefix(Int(min(len, 3))).compactMap(CanvasZoomModel.ZoomStop.init(code:))
  }
}
