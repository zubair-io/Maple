// MuiCropOverlay.swift — Maple UI Organisms · Editing surfaces
// (unified-component-catalog.md §4.5). A draggable, keyboard-nudgeable crop
// rectangle over an image: 8 resize handles (4 corners + 4 edge midpoints),
// a rule-of-thirds grid, and a dimmed mask outside the crop.
//
// Deviates from the catalog's "Built from: Drag Bar, Icon" note the same
// way the web reference does: Drag Bar's 1-D scrub contract doesn't fit an
// 8-handle 2-D rectangle resize, so this implements its own drag/nudge math
// directly (`MuiCropOverlayMath`, shared and unit-tested) instead of
// composing Drag Bar.

import SwiftUI

public struct MuiCropOverlay: View {
    public let containerSize: CGSize
    public let minSize: CGFloat
    @Binding public var rect: MuiCropRect
    public let committed: ((MuiCropRect) -> Void)?

    @GestureState private var dragStartRect: MuiCropRect?

    public init(
        containerSize: CGSize,
        minSize: CGFloat = 24,
        rect: Binding<MuiCropRect>,
        committed: ((MuiCropRect) -> Void)? = nil
    ) {
        self.containerSize = containerSize
        self.minSize = minSize
        self._rect = rect
        self.committed = committed
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            mask
            cropFrame
            thirdsGrid
            ForEach(MuiCropHandleId.allCases, id: \.self) { handle in
                handleView(handle)
            }
        }
        .frame(width: containerSize.width, height: containerSize.height)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Crop overlay")
    }

    private var mask: some View {
        Path { path in
            path.addRect(CGRect(origin: .zero, size: containerSize))
            path.addRect(CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height))
        }
        .fill(Color.black.opacity(0.55), style: FillStyle(eoFill: true))
        .allowsHitTesting(false)
    }

    private var cropFrame: some View {
        Rectangle()
            .stroke(MuiTokens.primary, lineWidth: 1)
            .frame(width: rect.width, height: rect.height)
            .position(x: rect.x + rect.width / 2, y: rect.y + rect.height / 2)
            .allowsHitTesting(false)
    }

    private var thirdsGrid: some View {
        Path { path in
            let v1 = rect.x + rect.width / 3
            let v2 = rect.x + rect.width * 2 / 3
            let h1 = rect.y + rect.height / 3
            let h2 = rect.y + rect.height * 2 / 3
            path.move(to: CGPoint(x: v1, y: rect.y)); path.addLine(to: CGPoint(x: v1, y: rect.y + rect.height))
            path.move(to: CGPoint(x: v2, y: rect.y)); path.addLine(to: CGPoint(x: v2, y: rect.y + rect.height))
            path.move(to: CGPoint(x: rect.x, y: h1)); path.addLine(to: CGPoint(x: rect.x + rect.width, y: h1))
            path.move(to: CGPoint(x: rect.x, y: h2)); path.addLine(to: CGPoint(x: rect.x + rect.width, y: h2))
        }
        .stroke(Color.white.opacity(0.35), lineWidth: 1)
        .allowsHitTesting(false)
    }

    private func handleView(_ handle: MuiCropHandleId) -> some View {
        let position = MuiCropOverlayMath.handlePosition(handle: handle, rect: rect)
        return Circle()
            .fill(MuiTokens.surface)
            .overlay(Circle().stroke(MuiTokens.primary, lineWidth: 1.5))
            .frame(width: 14, height: 14)
            .position(position)
            .gesture(dragGesture(for: handle))
            .accessibilityLabel("Crop handle: \(accessibleName(handle))")
            .accessibilityAdjustableAction { direction in
                let step: CGFloat = 1
                let delta: (dx: CGFloat, dy: CGFloat)?
                switch direction {
                case .increment: delta = MuiCropOverlayMath.nudgeDelta(key: "ArrowRight", step: step)
                case .decrement: delta = MuiCropOverlayMath.nudgeDelta(key: "ArrowLeft", step: step)
                @unknown default: delta = nil
                }
                guard let delta else { return }
                let next = MuiCropOverlayMath.applyHandleDelta(handle: handle, startRect: rect, dx: delta.dx, dy: delta.dy, minSize: minSize, containerSize: containerSize)
                rect = next
                committed?(next)
            }
    }

    private func dragGesture(for handle: MuiCropHandleId) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($dragStartRect) { _, state, _ in
                if state == nil { state = rect }
            }
            .onChanged { value in
                let start = dragStartRect ?? rect
                rect = MuiCropOverlayMath.applyHandleDelta(
                    handle: handle, startRect: start,
                    dx: value.translation.width, dy: value.translation.height,
                    minSize: minSize, containerSize: containerSize
                )
            }
            .onEnded { _ in committed?(rect) }
    }

    private func accessibleName(_ handle: MuiCropHandleId) -> String {
        switch handle {
        case .nw: return "top left"
        case .n: return "top"
        case .ne: return "top right"
        case .e: return "right"
        case .se: return "bottom right"
        case .s: return "bottom"
        case .sw: return "bottom left"
        case .w: return "left"
        }
    }
}

#Preview("MuiCropOverlay") {
    struct Demo: View {
        @State private var rect = MuiCropRect(x: 40, y: 30, width: 180, height: 120)
        var body: some View {
            ZStack {
                MuiTokens.imageCanvas
                MuiCropOverlay(containerSize: CGSize(width: 280, height: 200), rect: $rect)
            }
            .frame(width: 280, height: 200)
        }
    }
    return Demo().padding().background(MuiTokens.bg)
}
