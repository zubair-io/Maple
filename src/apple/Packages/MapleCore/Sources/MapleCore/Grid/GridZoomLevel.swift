// GridZoomLevel.swift — discrete photo-grid zoom levels (#1550).
//
// MapleCore owns the level definitions so they can be consumed by both
// the Maple app target and any headless test target without a SwiftUI dep.
//
// Column counts are the iPhone definition; large screens decouple to a tamed,
// responsive cell size via `desktopCellWidth` (see ColumnStrategy.zoom in
// PhotoGrid.swift).

import CoreGraphics

/// Discrete photo-grid zoom levels. The column counts are the iPhone definition;
/// large screens use `desktopCellWidth` adaptively. Ordered by rawValue from
/// biggest cells (fullWidth) to smallest (dense).
public enum GridZoomLevel: Int, CaseIterable, Sendable, Codable {
    case fullWidth    // 1 column
    case comfortable  // 3-wide on iPhone (default)
    case compact      // 5-wide on iPhone
    case dense        // 9-wide on iPhone

    /// Canonical iPhone column count.
    public var phoneColumns: Int {
        switch self {
        case .fullWidth:   return 1
        case .comfortable: return 3
        case .compact:     return 5
        case .dense:       return 9
        }
    }

    /// Adaptive minimum cell width (pt) for tablet/desktop. Chosen so the grid
    /// reflows responsively as the window resizes AND stays sensible at both
    /// ends: the largest level is big multi-up tiles (not one giant image), the
    /// densest stays browsable (not a wall of tiny thumbnails). Phone keeps its
    /// exact `phoneColumns`; large screens decouple to these sizes so a wide Mac
    /// window never jumps straight to a single image or to dozens of tiny cells.
    public var desktopCellWidth: CGFloat {
        switch self {
        case .fullWidth:   return 340
        case .comfortable: return 220
        case .compact:     return 150
        case .dense:       return 105
        }
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
