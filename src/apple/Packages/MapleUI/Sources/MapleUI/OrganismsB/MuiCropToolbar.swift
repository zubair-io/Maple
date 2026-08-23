// MuiCropToolbar.swift — Maple UI Organisms · Editing surfaces
// (unified-component-catalog.md §4.5). Aspect-ratio presets (Chip Row,
// `select` mode) plus a straighten angle scrub (Drag Bar) and a Reset
// button that restores both to their defaults, built from Chip Row, Drag
// Bar, Button.

import SwiftUI

public struct MuiCropToolbar: View {
    public static let defaultAspect = "free"
    public static let defaultAngle = 0.0
    public static let aspectChips: [MuiChip] = [
        MuiChip(id: "free", label: "Free"),
        MuiChip(id: "1:1", label: "1:1"),
        MuiChip(id: "4:5", label: "4:5"),
        MuiChip(id: "16:9", label: "16:9"),
    ]

    @Binding public var aspect: String
    @Binding public var angle: Double
    public let aspectChanged: ((String) -> Void)?
    public let angleChanged: ((Double) -> Void)?
    public let resetRequested: (() -> Void)?

    public init(
        aspect: Binding<String>,
        angle: Binding<Double>,
        aspectChanged: ((String) -> Void)? = nil,
        angleChanged: ((Double) -> Void)? = nil,
        resetRequested: (() -> Void)? = nil
    ) {
        self._aspect = aspect
        self._angle = angle
        self.aspectChanged = aspectChanged
        self.angleChanged = angleChanged
        self.resetRequested = resetRequested
    }

    public var body: some View {
        HStack(spacing: MuiTokens.spacingMd) {
            MuiChipRow(
                chips: Self.aspectChips,
                mode: .select,
                selectedId: Binding(get: { aspect }, set: { setAspect($0 ?? Self.defaultAspect) })
            )

            MuiDragBar(label: "Straighten", value: Binding(get: { angle }, set: { setAngle($0) }), range: -45...45, step: 1)
                .frame(width: 140)

            MuiButton(label: "Reset", variant: .ghost, size: .sm) { reset() }
        }
    }

    private func setAspect(_ next: String) {
        aspect = next
        aspectChanged?(next)
    }

    private func setAngle(_ next: Double) {
        angle = next
        angleChanged?(next)
    }

    private func reset() {
        aspect = Self.defaultAspect
        angle = Self.defaultAngle
        aspectChanged?(Self.defaultAspect)
        angleChanged?(Self.defaultAngle)
        resetRequested?()
    }
}

#Preview("MuiCropToolbar") {
    struct Demo: View {
        @State private var aspect = "16:9"
        @State private var angle = 4.0
        var body: some View {
            MuiCropToolbar(aspect: $aspect, angle: $angle)
                .padding()
                .background(MuiTokens.bg)
        }
    }
    return Demo()
}
