// CanvasZoomModel+Stops.swift — the named zoom stops (#5710).
//
// Fit, fill and 100% are the three levels a user reaches deliberately: the
// zoom badge cycles them in that order. Pinch reaches the same fit and fill
// levels through detents (CanvasZoomModel+Geometry.swift).

import CoreGraphics
import Foundation

extension CanvasZoomModel {

    /// The named stop the current zoom sits on, or `nil` for a free scale.
    public var currentStop: ZoomStop? {
        if pixelScale == 0 { return .fit }
        if fillsViewport { return .fill }
        return pixelScale == 1 ? .actualSize : nil
    }

    /// The badge's cycle for this geometry: `fit → fill → 100%`, without
    /// stops that coincide.
    public static func badgeStops(context: CanvasZoomContext) -> [ZoomStop] {
        distinctStops(fit: context.fitScale, fill: context.fillScale, actualSize: 1)
    }

    /// Fill: the image covers the whole viewport, centred. The overflowing
    /// axis can then be panned.
    public mutating func zoomToFill(context: CanvasZoomContext) {
        pixelScale = context.fillScale
        fillsViewport = true
        panOffset = .zero
        basePan = .zero
    }

    /// Badge tap: advance to the next stop in `fit → fill → 100%`. A free
    /// scale (pinched, stepped, below fit) returns to fit.
    public mutating func advanceStop(context: CanvasZoomContext) {
        switch Self.nextStop(after: currentStop, in: Self.badgeStops(context: context)) {
        case .fit: resetToFit()
        case .fill: zoomToFill(context: context)
        case .actualSize: zoomToScale(1.0)
        }
    }
}
