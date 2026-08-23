// MuiCropOverlayMath.swift — pure resize/nudge math shared by
// `MuiCropOverlay`'s pointer-drag handler and its keyboard-nudge handler.
// Ported from the web reference's `applyHandleDelta` (mui-crop-overlay.
// component.ts) — same eight-handle rect-resize contract, each handle
// moving a fixed subset of the rect's four edges with the edges it doesn't
// move acting as the clamp anchor (e.g. dragging `nw` can't push `left`
// past `right - minSize`).

import CoreGraphics

public enum MuiCropHandleId: String, CaseIterable, Sendable {
    case nw, n, ne, e, se, s, sw, w
}

public struct MuiCropRect: Equatable, Sendable {
    public var x: CGFloat
    public var y: CGFloat
    public var width: CGFloat
    public var height: CGFloat

    public init(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

enum MuiCropOverlayMath {
    /// Which of a rect's four edges each handle moves — the handles not
    /// listed here move none, i.e. a corner handle moves two edges and an
    /// edge-midpoint handle moves one.
    static func movedEdges(for handle: MuiCropHandleId) -> (left: Bool, top: Bool, right: Bool, bottom: Bool) {
        switch handle {
        case .nw: return (true, true, false, false)
        case .n: return (false, true, false, false)
        case .ne: return (false, true, true, false)
        case .e: return (false, false, true, false)
        case .se: return (false, false, true, true)
        case .s: return (false, false, false, true)
        case .sw: return (true, false, false, true)
        case .w: return (true, false, false, false)
        }
    }

    /// Applies a resize delta for one handle to `startRect`, clamped so the
    /// result never leaves `[0, containerSize]` on either axis and never
    /// shrinks below `minSize` on either axis. Pure — the single source of
    /// resize math shared by pointer-drag and keyboard-nudge.
    static func applyHandleDelta(
        handle: MuiCropHandleId,
        startRect: MuiCropRect,
        dx: CGFloat,
        dy: CGFloat,
        minSize: CGFloat,
        containerSize: CGSize
    ) -> MuiCropRect {
        let edges = movedEdges(for: handle)

        let startLeft = startRect.x
        let startTop = startRect.y
        let startRight = startRect.x + startRect.width
        let startBottom = startRect.y + startRect.height

        let left = edges.left ? clamp(startLeft + dx, 0, startRight - minSize) : startLeft
        let top = edges.top ? clamp(startTop + dy, 0, startBottom - minSize) : startTop
        let right = edges.right ? clamp(startRight + dx, startLeft + minSize, containerSize.width) : startRight
        let bottom = edges.bottom ? clamp(startBottom + dy, startTop + minSize, containerSize.height) : startBottom

        return MuiCropRect(x: left, y: top, width: right - left, height: bottom - top)
    }

    /// Converts an arrow key into a `(dx, dy)` nudge — `nil` for any other
    /// key. Horizontal and vertical nudge independently, unlike a 1-D scrub
    /// control's single-axis arrow mapping.
    static func nudgeDelta(key: String, step: CGFloat) -> (dx: CGFloat, dy: CGFloat)? {
        switch key {
        case "ArrowLeft": return (-step, 0)
        case "ArrowRight": return (step, 0)
        case "ArrowUp": return (0, -step)
        case "ArrowDown": return (0, step)
        default: return nil
        }
    }

    /// Screen position for one handle given the current rect — corners at
    /// the four corners, edge handles at the midpoint of the edge they move.
    static func handlePosition(handle: MuiCropHandleId, rect: MuiCropRect) -> CGPoint {
        let midX = rect.x + rect.width / 2
        let midY = rect.y + rect.height / 2
        let right = rect.x + rect.width
        let bottom = rect.y + rect.height
        switch handle {
        case .nw: return CGPoint(x: rect.x, y: rect.y)
        case .n: return CGPoint(x: midX, y: rect.y)
        case .ne: return CGPoint(x: right, y: rect.y)
        case .e: return CGPoint(x: right, y: midY)
        case .se: return CGPoint(x: right, y: bottom)
        case .s: return CGPoint(x: midX, y: bottom)
        case .sw: return CGPoint(x: rect.x, y: bottom)
        case .w: return CGPoint(x: rect.x, y: midY)
        }
    }

    private static func clamp(_ value: CGFloat, _ min: CGFloat, _ max: CGFloat) -> CGFloat {
        Swift.min(max, Swift.max(min, value))
    }
}
