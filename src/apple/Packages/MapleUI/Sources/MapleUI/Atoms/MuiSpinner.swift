// MuiSpinner.swift — Maple UI Spinner atom.
// Contract: docs/design/maple-ui/components/spinner.md

import SwiftUI

public enum MuiSpinnerSize: Sendable {
    case sm, md
}

public enum MuiSpinnerPlacement: Sendable {
    case inline, centered
}

/// The smallest possible "something is happening" indicator — used inline
/// next to a label or centered in an otherwise-empty box (spinner.md
/// §Purpose). A fast operation that finishes inside `delayMs` never flashes
/// a spinner at all.
public struct MuiSpinner: View {
    public let size: MuiSpinnerSize
    public let placement: MuiSpinnerPlacement
    public let delayMs: Int
    public let label: String

    @State private var isVisible = false
    @State private var rotation: Double = 0

    public init(
        size: MuiSpinnerSize = .md,
        placement: MuiSpinnerPlacement = .inline,
        delayMs: Int = 0,
        label: String = "Loading"
    ) {
        self.size = size
        self.placement = placement
        self.delayMs = delayMs
        self.label = label
    }

    public var body: some View {
        ring
            .opacity(isVisible ? 1 : 0)
            .frame(
                maxWidth: placement == .centered ? .infinity : nil,
                maxHeight: placement == .centered ? .infinity : nil
            )
            .task {
                if delayMs > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                }
                guard !Task.isCancelled else { return }
                withAnimation(.easeIn(duration: 0.15)) { isVisible = true }
            }
            // The rotating ring glyph is decorative; the accessible name
            // comes from `role="status"`'s equivalent below, not the
            // animation (spinner.md §Accessibility).
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
            .accessibilityAddTraits(.updatesFrequently)
    }

    private var ring: some View {
        Circle()
            .stroke(MuiTokens.border, lineWidth: lineWidth)
            .overlay(
                Circle()
                    .trim(from: 0, to: 0.75)
                    .stroke(MuiTokens.primary, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(rotation))
            )
            .frame(width: diameter, height: diameter)
            .onAppear {
                withAnimation(.linear(duration: 0.8).repeatForever(autoreverses: false)) {
                    rotation = 360
                }
            }
    }

    private var diameter: CGFloat {
        size == .sm ? 14 : 20
    }

    private var lineWidth: CGFloat {
        size == .sm ? 2 : 2.5
    }
}

#Preview("MuiSpinner — Sizes + placement") {
    VStack(spacing: 16) {
        HStack(spacing: 12) {
            MuiSpinner(size: .sm)
            MuiSpinner(size: .md)
        }
        MuiSpinner(size: .md, placement: .centered)
            .frame(width: 120, height: 80)
            .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusMd))
    }
    .padding()
    .background(MuiTokens.bg)
}
