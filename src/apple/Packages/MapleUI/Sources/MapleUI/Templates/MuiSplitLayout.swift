// MuiSplitLayout.swift — Maple UI Templates (unified-component-catalog.md
// §5). Three-region layout: Sidebar, Center, Detail. Backs the Browse,
// Editor, Document, and Chat pages (§6). Regions only — no content of its
// own.
//
// Sidebar and Detail are draggable-resizable (a `DragGesture` on a 1pt
// handle between regions, clamped to min/max width) and the resulting
// widths are `@Binding`s so a drag is directly two-way bindable by the
// caller — same contract as the web reference's `model()` widths.
//
// Collapse order at narrow widths: Detail collapses first (it's the most
// dispensable region — an inspector or thread panel), then Sidebar,
// leaving Center full-width on a phone. Width comes from a
// `GeometryReader` on the host rather than a horizontal size class — a
// size class only has two steps (compact/regular), but collapse here needs
// two independent thresholds (900pt then 640pt), so measuring the actual
// host width is the only way to reproduce the web reference's two-stage
// collapse. The pure decision math lives in `MuiSplitLayoutMath` (Internal)
// so it's unit-testable without a live `GeometryReader`.

import SwiftUI
#if os(macOS)
import AppKit
#endif

public struct MuiSplitLayout<Sidebar: View, Center: View, Detail: View>: View {
    @Binding public var sidebarWidth: Double
    public let sidebarMin: Double
    public let sidebarMax: Double

    /// Whether the Detail region is in use at all — a caller with nothing
    /// to put there (e.g. Chat with no thread open) sets this false rather
    /// than projecting an empty region.
    public let showDetail: Bool
    @Binding public var detailWidth: Double
    public let detailMin: Double
    public let detailMax: Double

    /// Set false to keep every region rendered regardless of host width —
    /// an escape hatch for embedding a miniature/preview instance (e.g. a
    /// design-showcase card) narrower than the collapse breakpoints
    /// without it losing regions.
    public let collapseEnabled: Bool

    public let sidebar: Sidebar
    public let center: Center
    public let detail: Detail

    @State private var sidebarDragStartWidth: Double?
    @State private var detailDragStartWidth: Double?

    public init(
        sidebarWidth: Binding<Double> = .constant(260),
        sidebarMin: Double = 200,
        sidebarMax: Double = 400,
        showDetail: Bool = true,
        detailWidth: Binding<Double> = .constant(320),
        detailMin: Double = 240,
        detailMax: Double = 480,
        collapseEnabled: Bool = true,
        @ViewBuilder sidebar: () -> Sidebar = { EmptyView() },
        @ViewBuilder center: () -> Center,
        @ViewBuilder detail: () -> Detail = { EmptyView() }
    ) {
        self._sidebarWidth = sidebarWidth
        self.sidebarMin = sidebarMin
        self.sidebarMax = sidebarMax
        self.showDetail = showDetail
        self._detailWidth = detailWidth
        self.detailMin = detailMin
        self.detailMax = detailMax
        self.collapseEnabled = collapseEnabled
        self.sidebar = sidebar()
        self.center = center()
        self.detail = detail()
    }

    public var body: some View {
        GeometryReader { geo in
            let hostWidth = Double(geo.size.width)
            let sidebarCollapsed = MuiSplitLayoutMath.sidebarCollapsed(hostWidth: hostWidth, collapseEnabled: collapseEnabled)
            let detailCollapsed = MuiSplitLayoutMath.detailCollapsed(showDetail: showDetail, hostWidth: hostWidth, collapseEnabled: collapseEnabled)

            HStack(spacing: 0) {
                if !sidebarCollapsed {
                    sidebar
                        .frame(width: sidebarWidth)
                        .frame(maxHeight: .infinity)
                        .clipped()
                    resizeHandle(dragged: sidebarHandleGesture, accessibilityLabel: "Resize sidebar")
                }

                center.frame(maxWidth: .infinity, maxHeight: .infinity)

                if !detailCollapsed {
                    resizeHandle(dragged: detailHandleGesture, accessibilityLabel: "Resize detail")
                    detail
                        .frame(width: detailWidth)
                        .frame(maxHeight: .infinity)
                        .clipped()
                }
            }
        }
    }

    /// Sidebar handle: dragging right (positive dx) grows it.
    private var sidebarHandleGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { g in
                let start = sidebarDragStartWidth ?? sidebarWidth
                if sidebarDragStartWidth == nil { sidebarDragStartWidth = sidebarWidth }
                sidebarWidth = MuiSplitLayoutMath.clamp(start + Double(g.translation.width), min: sidebarMin, max: sidebarMax)
            }
            .onEnded { _ in sidebarDragStartWidth = nil }
    }

    /// Detail sits to the right of its handle, so dragging left (negative
    /// dx) grows it — invert the delta relative to the Sidebar handle.
    private var detailHandleGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { g in
                let start = detailDragStartWidth ?? detailWidth
                if detailDragStartWidth == nil { detailDragStartWidth = detailWidth }
                detailWidth = MuiSplitLayoutMath.clamp(start - Double(g.translation.width), min: detailMin, max: detailMax)
            }
            .onEnded { _ in detailDragStartWidth = nil }
    }

    private func resizeHandle(dragged gesture: some Gesture, accessibilityLabel: String) -> some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: 9)
            .overlay(Rectangle().fill(MuiTokens.border).frame(width: 1))
            .contentShape(Rectangle())
            .gesture(gesture)
            #if os(macOS)
            .onHover { hovering in
                if hovering {
                    NSCursor.resizeLeftRight.push()
                } else {
                    NSCursor.pop()
                }
            }
            #endif
            .accessibilityElement()
            .accessibilityLabel(accessibilityLabel)
            .accessibilityAddTraits(.isButton)
    }
}

#Preview("MuiSplitLayout") {
    struct Demo: View {
        @State private var sidebarWidth = 260.0
        @State private var detailWidth = 320.0

        var body: some View {
            MuiSplitLayout(sidebarWidth: $sidebarWidth, detailWidth: $detailWidth) {
                MuiTokens.surface.overlay(MuiText("Sidebar", variant: .body, color: .muted))
            } center: {
                MuiTokens.imageCanvas.overlay(MuiText("Center", variant: .body, color: .muted))
            } detail: {
                MuiTokens.surface.overlay(MuiText("Detail", variant: .body, color: .muted))
            }
        }
    }
    return Demo().frame(width: 900, height: 400)
}

#Preview("MuiSplitLayout — no detail") {
    MuiSplitLayout(showDetail: false) {
        MuiTokens.surface.overlay(MuiText("Sidebar", variant: .body, color: .muted))
    } center: {
        MuiTokens.imageCanvas.overlay(MuiText("Center", variant: .body, color: .muted))
    }
    .frame(width: 700, height: 300)
}
