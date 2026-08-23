// MuiPopover.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.4). The anchored-floating-container primitive every overlay molecule
// (Context/Suggestion/Command/Bubble Menu) composes — it has no Built-from
// row of its own, it IS the positioning primitive. Exposed as a View
// modifier (`.muiPopover`) rather than a wrapper view: the caller's own
// trigger content becomes the anchor, and the panel attaches to it.
//
// Positioning: SwiftUI has no direct equivalent of the web reference's
// `position: absolute` panel measured against its anchor's own box, so
// this measures both the anchor and the panel via `GeometryReader` (into
// `anchorSize`/`panelSize`) and offsets the panel from a shared
// top-leading origin. The offset briefly reads a stale (zero) panel size
// on the very first layout pass before settling — acceptable for a fixed-
// content menu/panel, which converges within a frame.
//
// Outside-tap dismissal: SwiftUI overlays aren't clipped to their base
// view's layout bounds, so the tap-catching scrim is deliberately
// oversized rather than sized to the anchor — the closest local-component
// substitute for the web reference's document-level click listener, which
// has no equivalent without owning the app's own root view. Escape-to-
// dismiss is real keyboard handling, gated `#if os(macOS)` like every
// other keyboard-nav molecule in this wave.

import SwiftUI

public enum MuiPopoverPlacement: Sendable {
    case top, bottom, leading, trailing
}

public extension View {
    /// Attaches an anchored floating panel to this view. `closeRequested`
    /// fires on an outside tap or Escape — the caller owns `isPresented`
    /// and is expected to flip it false in response, same contract as the
    /// web reference's `mui-popover`.
    func muiPopover<PopoverContent: View>(
        isPresented: Bool,
        placement: MuiPopoverPlacement = .bottom,
        closeRequested: @escaping () -> Void,
        @ViewBuilder content: @escaping () -> PopoverContent
    ) -> some View {
        modifier(
            MuiPopoverModifier(
                isPresented: isPresented,
                placement: placement,
                closeRequested: closeRequested,
                popoverContent: content
            )
        )
    }
}

struct MuiPopoverModifier<PopoverContent: View>: ViewModifier {
    let isPresented: Bool
    let placement: MuiPopoverPlacement
    let closeRequested: () -> Void
    @ViewBuilder let popoverContent: () -> PopoverContent

    @State private var anchorSize: CGSize = .zero
    @State private var panelSize: CGSize = .zero

    private static var scrimExtent: CGFloat { 4000 }
    private static var gap: CGFloat { MuiTokens.spacingXs }

    func body(content: Content) -> some View {
        content
            .background(sizeReader { anchorSize = $0 })
            .overlay(alignment: .topLeading) {
                if isPresented {
                    ZStack(alignment: .topLeading) {
                        scrim
                        panel
                            .background(sizeReader { panelSize = $0 })
                            .offset(panelOffset)
                    }
                }
            }
    }

    private var scrim: some View {
        Color.clear
            .contentShape(Rectangle())
            .frame(width: Self.scrimExtent, height: Self.scrimExtent)
            .offset(x: -Self.scrimExtent / 2, y: -Self.scrimExtent / 2)
            .onTapGesture { closeRequested() }
    }

    private var panel: some View {
        popoverContent()
            .padding(MuiTokens.spacingSm)
            .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous)
                    .stroke(MuiTokens.border, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.28), radius: 16, y: 6)
            #if os(macOS)
            .onKeyPress(.escape) {
                closeRequested()
                return .handled
            }
            #endif
            .transition(.opacity)
            .animation(MuiTokens.Motion.sheetPresent, value: isPresented)
    }

    private var panelOffset: CGSize {
        switch placement {
        case .top: return CGSize(width: 0, height: -panelSize.height - Self.gap)
        case .bottom: return CGSize(width: 0, height: anchorSize.height + Self.gap)
        case .leading: return CGSize(width: -panelSize.width - Self.gap, height: 0)
        case .trailing: return CGSize(width: anchorSize.width + Self.gap, height: 0)
        }
    }

    private func sizeReader(_ report: @escaping (CGSize) -> Void) -> some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { report(proxy.size) }
                .onChange(of: proxy.size) { _, newSize in report(newSize) }
        }
    }
}

#Preview("MuiPopover") {
    struct Demo: View {
        @State private var open = false

        var body: some View {
            MuiButton(label: "Open popover", variant: .secondary) {
                open.toggle()
            }
            .muiPopover(isPresented: open, placement: .bottom, closeRequested: { open = false }) {
                VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                    MuiText("Popover content", variant: .rowLabel)
                    MuiText("Anchored below the trigger", variant: .body, color: .muted)
                }
                .frame(width: 200)
            }
        }
    }
    return Demo()
        .padding(80)
        .background(MuiTokens.bg)
}
