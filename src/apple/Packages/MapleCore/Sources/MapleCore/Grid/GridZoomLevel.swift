// GridZoomLevel.swift — discrete photo-grid zoom levels (#1550).
//
// MapleCore owns the level definitions so they can be consumed by both
// the Maple app target and any headless test target without a SwiftUI dep.
//
// Column counts are the iPhone definition; bigger screens keep the same
// cell SIZE via `targetCellWidth` (see ColumnStrategy.zoom in PhotoGrid.swift).

import CoreGraphics

/// Discrete photo-grid zoom levels. The column counts are the iPhone definition;
/// bigger screens keep the same cell SIZE (see `targetCellWidth`). Ordered by
/// rawValue from biggest cells (fullWidth) to smallest (dense).
public enum GridZoomLevel: Int, CaseIterable, Sendable, Codable {
    case fullWidth    // 1 column
    case comfortable  // 3-wide on iPhone (default)
    case compact      // 5-wide on iPhone
    case dense        // 10-wide on iPhone

    /// Canonical iPhone column count.
    public var phoneColumns: Int {
        switch self {
        case .fullWidth:   return 1
        case .comfortable: return 3
        case .compact:     return 5
        case .dense:       return 10
        }
    }

    /// Reference iPhone content width (pt) used to derive a device-independent
    /// cell size for tablet/desktop adaptive layouts.
    public static let referencePhoneWidth: CGFloat = 390

    /// Target cell width on tablet/desktop — keeps a cell the same physical size
    /// it has on iPhone at this level, so the column count grows with the window.
    public var targetCellWidth: CGFloat {
        GridZoomLevel.referencePhoneWidth / CGFloat(phoneColumns)
    }

    /// Toward bigger cells / fewer columns (clamped, no wrap).
    public func zoomedIn() -> GridZoomLevel {
        GridZoomLevel(rawValue: rawValue - 1) ?? self
    }

    /// Toward smaller cells / more columns (clamped, no wrap).
    public func zoomedOut() -> GridZoomLevel {
        GridZoomLevel(rawValue: rawValue + 1) ?? self
    }
}
