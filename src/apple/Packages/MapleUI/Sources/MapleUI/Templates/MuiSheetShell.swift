// MuiSheetShell.swift — Maple UI Templates (unified-component-catalog.md
// §5). Three-region layout: Scrim, Grab handle, Body. The design-system
// generalization of the app's own phone-tier `BottomSheet.swift`
// (src/apple/Maple/Views/BottomSheet.swift) — same scrim / grab-handle /
// pan-to-dismiss contract, rebuilt as a regions-only template with a
// `detents` input instead of that view's hardcoded 74% height. Regions
// only — no content of its own.
//
// Detents are fractions (0–1] of the container height; `activeDetent` is
// an index into that array so a caller can snap the sheet to a different
// detent (e.g. "peek" vs "full") without a drag. Dragging the grab handle
// only ever dismisses (matches `BottomSheet.swift`'s pan-down gesture) — it
// does not cycle detents; that's a deliberately separate concern from the
// dismiss threshold this component owns. The pure detent/threshold math
// lives in `MuiSheetShellMath` (Internal).
//
// Motion mirrors `BottomSheet.swift`'s asymmetric present/dismiss timing
// (`MuiTokens.Motion.sheetPresent` / `.sheetDismiss`) plus a snappy spring
// for the rubber-band snap-back when a drag doesn't cross the dismiss
// threshold.

import SwiftUI

public struct MuiSheetShell<Content: View>: View {
    public let isPresented: Bool
    /// Fractions (0–1] of container height. Index 0 is the default detent.
    public let detents: [Double]
    public let activeDetent: Int
    /// Positions the scrim/sheet absolutely within the nearest positioned
    /// ancestor instead of covering the whole screen (mirrors
    /// `MuiOverlayShell`'s `contained` input).
    public let contained: Bool
    public let dismissed: (() -> Void)?
    public let content: Content

    @State private var dragOffset: CGFloat = 0

    public init(
        isPresented: Bool,
        detents: [Double] = [0.4, 0.9],
        activeDetent: Int = 0,
        contained: Bool = false,
        dismissed: (() -> Void)? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.isPresented = isPresented
        self.detents = detents
        self.activeDetent = activeDetent
        self.contained = contained
        self.dismissed = dismissed
        self.content = content()
    }

    public var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                if isPresented {
                    Color.black.opacity(0.55)
                        .ignoresSafeArea(contained ? [] : .all)
                        .contentShape(Rectangle())
                        .onTapGesture { dismissed?() }
                        .transition(.opacity)
                }

                if isPresented {
                    sheet(containerHeight: geo.size.height)
                        .transition(.move(edge: .bottom))
                }
            }
            .animation(MuiTokens.Motion.sheetPresent, value: isPresented)
        }
    }

    private func sheet(containerHeight: CGFloat) -> some View {
        let fraction = MuiSheetShellMath.heightFraction(detents: detents, activeDetent: activeDetent)
        let height = containerHeight * CGFloat(fraction)

        return VStack(spacing: 0) {
            grabHandle
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .background(
            MuiTokens.surface,
            in: UnevenRoundedRectangle(topLeadingRadius: MuiTokens.radiusLg, bottomLeadingRadius: 0, bottomTrailingRadius: 0, topTrailingRadius: MuiTokens.radiusLg)
        )
        .shadow(color: .black.opacity(0.6), radius: 15, x: 0, y: -8)
        .offset(y: max(0, dragOffset))
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { g in dragOffset = max(0, g.translation.height) }
                .onEnded { g in handleDragEnd(translation: g.translation.height, sheetHeight: height) }
        )
        .muiEscapeDismissible(onDismiss: dismissed)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }

    private var grabHandle: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(MuiTokens.borderHi)
            .frame(width: 38, height: 4)
            .padding(.top, MuiTokens.spacingSm)
            .padding(.bottom, MuiTokens.spacingXs)
            .accessibilityHidden(true)
    }

    private func handleDragEnd(translation: CGFloat, sheetHeight: CGFloat) {
        let downward = max(0, translation)
        let distanceTriggered = MuiSheetShellMath.isDistanceDismissed(dy: Double(downward), sheetHeight: Double(sheetHeight))

        if distanceTriggered {
            dragOffset = 0
            dismissed?()
        } else {
            withAnimation(.snappy(duration: 0.25)) {
                dragOffset = 0
            }
        }
    }
}

#Preview("MuiSheetShell") {
    MuiSheetShell(isPresented: true) {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            MuiText("Info", variant: .sheetTitle)
            MuiText("Sample sheet content.", variant: .body, color: .muted)
            Spacer()
        }
        .padding(MuiTokens.spacingLg)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(MuiTokens.bg)
}

#Preview("MuiSheetShell — contained, tall detent") {
    MuiSheetShell(isPresented: true, detents: [0.5, 0.9], activeDetent: 1, contained: true) {
        MuiText("Contained demo mode.", variant: .body, color: .muted)
            .padding(MuiTokens.spacingLg)
    }
    .frame(width: 320, height: 400)
    .background(MuiTokens.bg)
}
