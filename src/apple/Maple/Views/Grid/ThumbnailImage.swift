// ThumbnailImage.swift — shared leaf renderer and display-mode enum.
//
// Extracted from BrowseGrid.swift (M0 grid-unify refactor, #1490) so the
// five new shared grid components don't depend on BrowseGrid.swift.
// BrowseGrid.swift still compiles because both files are in the same Maple
// app target — no import needed, no call site changed.

import SwiftUI
import MapleCore
import CoreGraphics

// MARK: - GridDisplayMode

/// How image cells display their thumbnails inside the square cell box.
/// Folder cells ignore this — they always render as the icon-style tile.
///
/// - `.fill`: image scales to FILL the square, cropping any overflow on the
///   long edge. Default. Reads as a tightly-packed cover-style grid.
/// - `.fit`: image scales to FIT inside the square, leaving letterbox /
///   pillarbox bars on the short edge. Full content visible.
enum GridDisplayMode {
    case fill
    case fit

    /// SwiftUI `ContentMode` for the image inside the square frame.
    var contentMode: ContentMode {
        switch self {
        case .fill: return .fill
        case .fit:  return .fit
        }
    }

    /// Toggle helper.
    var toggled: GridDisplayMode {
        switch self {
        case .fill: return .fit
        case .fit:  return .fill
        }
    }

    /// SF Symbol shown on the toolbar button. Convention: show the OPPOSITE
    /// icon as the action target (i.e. while in fill we offer "switch to fit").
    var toggleIconName: String {
        switch self {
        case .fill: return "rectangle.compress.vertical"  // → fit (shrink content)
        case .fit:  return "rectangle.expand.vertical"    // → fill (cover cell)
        }
    }

    /// Accessibility label for the toolbar button.
    var toggleAccessibilityLabel: String {
        switch self {
        case .fill: return "Fit images to cell"
        case .fit:  return "Fill cells with images"
        }
    }
}

// MARK: - ThumbnailImage

/// Shared square thumbnail cell. Renders AVIF bytes (or a placeholder
/// when nil) inside a 1:1 rounded rectangle, with the caller's chosen
/// fill/fit content mode. Used by the local Browse grid AND the cloud
/// Timeline grid so both honor the toolbar's fill/fit toggle and pick
/// up future polish (transitions, hover effects, etc.) for free.
///
/// Layout pattern: `Rectangle().overlay { Image }` not `ZStack { ... }`.
/// With a plain ZStack the bounds expand to fit the largest child, and
/// an `Image().resizable().aspectRatio(.fill)` reports a preferred size
/// LARGER than the proposed size (short edge fills, long edge overflows).
/// The ZStack would grow to that overflowing size and an inner `.clipped()`
/// would clip at the wrong frame. Anchoring to the Rectangle and putting
/// the Image in `.overlay` keeps layout anchored to the Rectangle's bounds;
/// the outer `.aspectRatio(1, .fit)` then forces it square at the cell's
/// offered width, and `.clipShape` cleans up the overflow with rounded
/// corners.
struct ThumbnailImage: View {
    /// Cell corner radius. Shared rather than inlined so the zoom-to-open
    /// hero (#1489) starts at the radius the tile actually has and rounds it
    /// away as it opens.
    static let cornerRadius: CGFloat = 4

    /// The already-decoded thumbnail bitmap, or nil to show the placeholder.
    /// Decoding happens OFF the main actor in the owning cell's `.task` (via
    /// `ThumbnailDecoder`); this view is a pure renderer and never decodes —
    /// decoding in `body` on the main thread was the original grid-jank source.
    let image: CGImage?
    let displayMode: GridDisplayMode

    var body: some View {
        Rectangle()
            .fill(MapleTokens.surfaceAlt)
            .overlay {
                if let image {
                    // `Image(decorative:)` takes a CGImage directly and is
                    // cross-platform, so there's no AppKit/UIKit branch. The
                    // bitmap is already eagerly decoded (ThumbnailDecoder), so
                    // no pixel decode is deferred to draw time on the main thread.
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .aspectRatio(contentMode: displayMode.contentMode)
                } else {
                    Image(systemName: "photo")
                        .foregroundStyle(MapleTokens.textMuted)
                }
            }
            .aspectRatio(1, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: Self.cornerRadius))
    }
}

#Preview("ThumbnailImage — placeholder") {
    ThumbnailImage(image: nil, displayMode: .fill)
        .frame(width: 180, height: 180)
        .padding()
        .background(MapleTokens.bg)
}
