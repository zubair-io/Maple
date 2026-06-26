// FocalZoomMath.swift — pure layout math for focal-anchored grid zoom (#1550).
//
// MapleCore owns this so it's unit-testable without a SwiftUI dependency
// (mirrors the GridZoomLevel / MapleLayout split). The SwiftUI plumbing in
// PhotoGrid/GridZoomGesture calls these to decide where the focal image lands
// and how many invisible leading spacer cells line it up.

import CoreGraphics

public enum FocalZoomMath {

    /// Modulo that always returns a value in `0..<n` (Swift's `%` keeps the
    /// sign of the dividend, which breaks the spacer math for negative offsets).
    public static func positiveMod(_ a: Int, _ n: Int) -> Int {
        guard n > 0 else { return 0 }
        return ((a % n) + n) % n
    }

    /// The column the focal image should occupy in the new layout.
    ///
    /// - Zoom IN (fewer columns): keep the focal's horizontal SIDE — a left-edge
    ///   image stays left, right stays right, center stays center — by remapping
    ///   its normalized position `colOld/(nOld-1)` onto `0..<nNew`. At a single
    ///   column the only option is 0.
    /// - Zoom OUT (more columns): always the center column.
    ///
    /// - Parameters:
    ///   - colOld: focal's current 0-based column.
    ///   - nOld/nNew: column counts before/after (clamped to >= 1 by the caller).
    ///   - zoomingIn: true when `nNew < nOld`.
    public static func targetColumn(colOld: Int, nOld: Int, nNew: Int, zoomingIn: Bool) -> Int {
        guard nNew > 1 else { return 0 }
        if zoomingIn {
            let side = nOld <= 1 ? 0.5 : Double(colOld) / Double(nOld - 1)
            let mapped = Int((side * Double(nNew - 1)).rounded())
            return min(max(mapped, 0), nNew - 1)
        }
        return (nNew - 1) / 2
    }

    /// How many invisible leading spacer cells to prepend so the focal's global
    /// slot (`globalSlot = leadingFolderCount + focalIndex`) lands in `targetColumn`
    /// at the new column count. Always in `0..<nNew`.
    ///
    /// Returns 0 when `nNew <= 1` (single column needs no offset). The caller
    /// additionally clamps to 0 when the focal is already in row 0 (`globalSlot <
    /// nNew`) to avoid a visible gap above a near-top focal.
    public static func leadingSpacers(globalSlot: Int, nNew: Int, targetColumn: Int) -> Int {
        guard nNew > 1 else { return 0 }
        return positiveMod(targetColumn - globalSlot, nNew)
    }

    /// Replicate SwiftUI's `GridItem(.adaptive(minimum:))` column packing so the
    /// tablet/desktop column count can be derived without reading SwiftUI. (Phone
    /// uses exact `GridZoomLevel.phoneColumns`.) Prefer the *measured* first-row
    /// count when available; this is the pre-layout estimate / fallback.
    public static func adaptiveColumnCount(contentWidth: CGFloat, minCell: CGFloat, gap: CGFloat) -> Int {
        guard contentWidth > 0, minCell > 0 else { return 1 }
        return max(1, Int((contentWidth + gap) / (minCell + gap)))
    }
}
