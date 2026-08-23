// MuiTypingIndicator.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Someone-is-typing affordance, built from Avatar, Text.

import SwiftUI

public struct MuiTypingIndicator: View {
    public let name: String

    @State private var phase: CGFloat = 0

    public init(name: String) {
        self.name = name
    }

    public var body: some View {
        HStack(spacing: MuiTokens.spacingXs) {
            MuiAvatar(name: name, size: .xs)
            MuiText("\(name) is typing", variant: .chipLabel, color: .muted)
            HStack(spacing: 3) {
                ForEach(0..<3) { index in
                    Circle()
                        .fill(MuiTokens.textMuted)
                        .frame(width: 4, height: 4)
                        .opacity(dotOpacity(index))
                }
            }
            .accessibilityHidden(true)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                phase = 1
            }
        }
        // A state change (e.g. someone starting/stopping typing) is
        // announced without the user needing focus on the element.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name) is typing")
        .accessibilityAddTraits(.updatesFrequently)
    }

    private func dotOpacity(_ index: Int) -> Double {
        let offset = Double(index) * 0.25
        let value = (sin((Double(phase) * .pi * 2) + offset * .pi * 2) + 1) / 2
        return 0.3 + value * 0.7
    }
}

#Preview("MuiTypingIndicator") {
    MuiTypingIndicator(name: "Ada")
        .padding()
        .background(MuiTokens.bg)
}
