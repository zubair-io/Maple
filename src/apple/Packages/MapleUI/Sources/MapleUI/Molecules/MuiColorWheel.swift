// MuiColorWheel.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.1). Draggable hue/saturation puck; a primitive plot with no atom
// dependency. A self-contained design-system re-implementation of the web
// reference's `mui-color-wheel` — same polar convention (hue 0° = right,
// increasing counter-clockwise; puck radius = saturation).

import SwiftUI

public struct MuiColorWheelValue: Equatable, Sendable {
    /// Degrees, `[0, 360)`.
    public var hue: Double
    /// `[0, 100]`.
    public var saturation: Double

    public init(hue: Double, saturation: Double) {
        self.hue = hue
        self.saturation = saturation
    }
}

public struct MuiColorWheel: View {
    @Binding public var value: MuiColorWheelValue
    public let size: CGFloat
    public let accessibilityLabel: String
    public let disabled: Bool

    private static let hueStepDeg = 1.0
    private static let satStep = 1.0

    public init(
        value: Binding<MuiColorWheelValue>,
        size: CGFloat = 96,
        accessibilityLabel: String = "Color wheel",
        disabled: Bool = false
    ) {
        self._value = value
        self.size = size
        self.accessibilityLabel = accessibilityLabel
        self.disabled = disabled
    }

    public var body: some View {
        let puck = MuiColorWheelMath.puckPosition(hue: value.hue, saturation: value.saturation)

        ZStack {
            Circle()
                .fill(AngularGradient(gradient: hueGradient, center: .center))
                .overlay(
                    Circle().fill(
                        RadialGradient(colors: [.white, .white.opacity(0)], center: .center, startRadius: 0, endRadius: size / 2)
                    )
                )
                .overlay(Circle().stroke(MuiTokens.border, lineWidth: 1))

            Circle()
                .fill(Color.white)
                .frame(width: 12, height: 12)
                .shadow(color: .black.opacity(0.45), radius: 1)
                .position(x: size * puck.leftPct / 100, y: size * puck.topPct / 100)
        }
        .frame(width: size, height: size)
        .contentShape(Circle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { g in
                    guard !disabled else { return }
                    value = Self.value(atLocation: g.location, size: size, currentHue: value.hue)
                }
        )
        #if os(macOS)
        .focusable(!disabled)
        .onMoveCommand { direction in
            guard !disabled else { return }
            switch direction {
            case .left: value.hue = MuiColorWheelMath.wrapHue(value.hue - Self.hueStepDeg)
            case .right: value.hue = MuiColorWheelMath.wrapHue(value.hue + Self.hueStepDeg)
            case .up: value.saturation = Swift.min(100, value.saturation + Self.satStep)
            case .down: value.saturation = Swift.max(0, value.saturation - Self.satStep)
            @unknown default: break
            }
        }
        #endif
        .opacity(disabled ? 0.45 : 1)
        .accessibilityElement()
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue("Hue \(Int(value.hue)) degrees, saturation \(Int(value.saturation)) percent")
    }

    private var hueGradient: Gradient {
        Gradient(colors: stride(from: 0, through: 360, by: 30).map {
            Color(hue: $0 / 360, saturation: 1, brightness: 1)
        })
    }

    /// The hue/saturation value for a pointer at `location` within a wheel
    /// of `size` points, keeping `currentHue` when the pointer lands exactly
    /// on the center. Public + static so this is unit-testable without
    /// running a gesture.
    public static func value(atLocation location: CGPoint, size: CGFloat, currentHue: Double) -> MuiColorWheelValue {
        let halfSize = Double(size / 2 == 0 ? 1 : size / 2)
        let dx = (Double(location.x) - Double(size / 2)) / halfSize
        let dy = -(Double(location.y) - Double(size / 2)) / halfSize
        let result = MuiColorWheelMath.value(dx: dx, dy: dy, currentHue: currentHue)
        return MuiColorWheelValue(hue: result.hue, saturation: result.saturation)
    }
}

#Preview("MuiColorWheel") {
    struct Demo: View {
        @State private var shadows = MuiColorWheelValue(hue: 210, saturation: 40)

        var body: some View {
            HStack(spacing: 24) {
                MuiColorWheel(value: $shadows)
                MuiColorWheel(value: .constant(MuiColorWheelValue(hue: 0, saturation: 0)), disabled: true)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
