// MuiPad2D.swift — Maple UI Molecules-L1 ("2-D Pad" in
// unified-component-catalog.md §2.1). Two-axis draggable puck over a
// rectangular gradient field (e.g. white-balance temp/tint); a primitive
// plot with no atom dependency. A self-contained design-system
// re-implementation of the web reference's `mui-pad-2d`.

import SwiftUI

public struct MuiPad2DValue: Equatable, Sendable {
    /// `[-1, 1]`, right positive.
    public var x: Double
    /// `[-1, 1]`, up positive.
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public struct MuiPad2D: View {
    @Binding public var value: MuiPad2DValue
    public let size: CGFloat
    public let gradientColors: [Color]
    public let accessibilityLabel: String
    public let disabled: Bool

    private static let step = 0.05

    public init(
        value: Binding<MuiPad2DValue>,
        size: CGFloat = 96,
        gradientColors: [Color] = [.blue, MuiTokens.surfaceAlt, .orange],
        accessibilityLabel: String = "2-D pad",
        disabled: Bool = false
    ) {
        self._value = value
        self.size = size
        self.gradientColors = gradientColors
        self.accessibilityLabel = accessibilityLabel
        self.disabled = disabled
    }

    public var body: some View {
        let puck = MuiPad2DMath.puckPosition(x: value.x, y: value.y)

        ZStack {
            RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous)
                .fill(LinearGradient(colors: gradientColors, startPoint: .topLeading, endPoint: .bottomTrailing))
                .overlay(
                    RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous)
                        .stroke(MuiTokens.border, lineWidth: 1)
                )

            Circle()
                .fill(Color.white)
                .frame(width: 12, height: 12)
                .shadow(color: .black.opacity(0.45), radius: 1)
                .position(x: size * puck.leftPct / 100, y: size * puck.topPct / 100)
        }
        .frame(width: size, height: size)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { g in
                    guard !disabled else { return }
                    value = Self.value(atLocation: g.location, size: size)
                }
        )
        #if os(macOS)
        .focusable(!disabled)
        .onMoveCommand { direction in
            guard !disabled else { return }
            switch direction {
            case .left: value.x = MuiPad2DMath.clamp(value.x - Self.step)
            case .right: value.x = MuiPad2DMath.clamp(value.x + Self.step)
            case .up: value.y = MuiPad2DMath.clamp(value.y + Self.step)
            case .down: value.y = MuiPad2DMath.clamp(value.y - Self.step)
            @unknown default: break
            }
        }
        #endif
        .opacity(disabled ? 0.45 : 1)
        .accessibilityElement()
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(String(format: "x %.2f, y %.2f", value.x, value.y))
    }

    /// The `x`/`y` value for a pointer at `location` within a pad of `size`
    /// points. Public + static so this is unit-testable without running a
    /// gesture.
    public static func value(atLocation location: CGPoint, size: CGFloat) -> MuiPad2DValue {
        guard size > 0 else { return MuiPad2DValue(x: 0, y: 0) }
        let fracX = Double(location.x / size)
        let fracY = Double(location.y / size)
        let result = MuiPad2DMath.value(fracX: fracX, fracY: fracY)
        return MuiPad2DValue(x: result.x, y: result.y)
    }
}

#Preview("MuiPad2D") {
    struct Demo: View {
        @State private var whiteBalance = MuiPad2DValue(x: 0.2, y: -0.3)

        var body: some View {
            HStack(spacing: 24) {
                MuiPad2D(value: $whiteBalance)
                MuiPad2D(value: .constant(MuiPad2DValue(x: 0, y: 0)), disabled: true)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
