// MuiDrawerShell.swift — Maple UI Templates (unified-component-catalog.md
// §5). Two-region layout: Scrim, edge Panel. The design-system
// generalization of `SourcePickerDrawerComponent`'s (web reference) scrim +
// pan-to-dismiss shape — same 30%-of-width threshold. Unlike that
// left-edge-only component with its own header/search/tree chrome, this is
// a plain regions-only template: no content of its own, and `edge` picks
// either side.
//
// Dismissal: scrim tap, (macOS only) Escape via the shared
// `muiEscapeDismissible` modifier, and pan-to-dismiss past the threshold —
// dragging the panel itself, matching the web reference (not a separate
// handle; Drawer Shell's catalog regions are Scrim + Panel only, unlike
// Sheet Shell's dedicated grab handle). `minimumDistance: 10` (rather than
// the web's raw pointer-capture) keeps a tap or an inner scroll from being
// immediately read as a dismiss drag.
//
// Motion: the open/close slide is a plain `MuiTokens.Motion.drawer`
// transition; a drag that doesn't clear the threshold snaps back to 0 with
// the same spring `MuiSheetShell` uses for its rubber-band.

import SwiftUI

public enum MuiDrawerShellEdge: Sendable {
    case left, right
}

public struct MuiDrawerShell<Content: View>: View {
    public let isPresented: Bool
    public let edge: MuiDrawerShellEdge
    public let width: Double
    /// Positions the scrim/panel absolutely within the nearest positioned
    /// ancestor instead of covering the whole screen (mirrors
    /// `MuiOverlayShell`'s `contained` input).
    public let contained: Bool
    public let dismissed: (() -> Void)?
    public let content: Content

    @State private var dragDx: CGFloat?

    public init(
        isPresented: Bool,
        edge: MuiDrawerShellEdge = .left,
        width: Double = 320,
        contained: Bool = false,
        dismissed: (() -> Void)? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.isPresented = isPresented
        self.edge = edge
        self.width = width
        self.contained = contained
        self.dismissed = dismissed
        self.content = content()
    }

    public var body: some View {
        ZStack(alignment: edge == .left ? .leading : .trailing) {
            if isPresented {
                Color.black.opacity(0.5)
                    .ignoresSafeArea(contained ? [] : .all)
                    .contentShape(Rectangle())
                    .onTapGesture { dismissed?() }
                    .transition(.opacity)
            }

            if isPresented {
                panel.transition(.move(edge: edge == .left ? .leading : .trailing))
            }
        }
        .animation(MuiTokens.Motion.drawer, value: isPresented)
    }

    private var panel: some View {
        content
            .frame(width: width)
            .frame(maxHeight: .infinity)
            .background(MuiTokens.surface)
            .overlay(alignment: edge == .left ? .trailing : .leading) {
                Rectangle().fill(MuiTokens.border).frame(width: 1)
            }
            .shadow(color: .black.opacity(0.35), radius: 20, x: edge == .left ? 8 : -8)
            .offset(x: dragDx ?? 0)
            .gesture(
                DragGesture(minimumDistance: 10)
                    .onChanged { g in
                        dragDx = MuiDrawerShellMath.closingDelta(rawDx: Double(g.translation.width), edge: edge)
                    }
                    .onEnded { g in handleDragEnd(translation: g.translation.width) }
            )
            .muiEscapeDismissible(onDismiss: dismissed)
            .accessibilityElement(children: .contain)
    }

    private func handleDragEnd(translation: CGFloat) {
        let closingDx = MuiDrawerShellMath.closingDelta(rawDx: Double(translation), edge: edge)
        let triggered = MuiDrawerShellMath.isDismissed(dx: closingDx, width: width)

        if triggered {
            dragDx = 0
            dismissed?()
        } else {
            withAnimation(.snappy(duration: 0.25)) {
                dragDx = 0
            }
        }
    }
}

#Preview("MuiDrawerShell — left") {
    MuiDrawerShell(isPresented: true) {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            MuiText("Sources", variant: .sheetTitle)
            MuiText("Panel content.", variant: .body, color: .muted)
            Spacer()
        }
        .padding(MuiTokens.spacingLg)
    }
    .frame(width: 500, height: 320)
    .background(MuiTokens.bg)
}

#Preview("MuiDrawerShell — right, contained") {
    MuiDrawerShell(isPresented: true, edge: .right, width: 260, contained: true) {
        MuiText("Right-edge panel.", variant: .body, color: .muted)
            .padding(MuiTokens.spacingLg)
    }
    .frame(width: 400, height: 300)
    .background(MuiTokens.bg)
}
