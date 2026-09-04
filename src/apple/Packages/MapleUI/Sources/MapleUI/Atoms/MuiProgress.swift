// MuiProgress.swift — Maple UI Progress atom.
// Contract: docs/design/maple-ui/components/progress.md

import SwiftUI

public enum MuiProgressShape: Sendable {
    case bar, ring
}

public enum MuiProgressSize: Sendable {
    case sm, md
}

/// Communicates that a longer-running operation is underway, as a filling
/// bar or ring — determinate with a known percentage, or an animated
/// indeterminate treatment when there isn't one (progress.md §Purpose).
public struct MuiProgress: View {
    public let shape: MuiProgressShape
    public let size: MuiProgressSize
    public let value: Double?
    public let label: String?

    @State private var indeterminatePhase: CGFloat = 0

    public init(shape: MuiProgressShape = .bar, size: MuiProgressSize = .md, value: Double? = nil, label: String? = nil) {
        self.shape = shape
        self.size = size
        self.value = value
        self.label = label
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
            Group {
                switch shape {
                case .bar: barView
                case .ring: ringView
                }
            }
            if let label {
                Text(label)
                    .font(MuiTokens.TypeScale.font(.body))
                    .foregroundStyle(MuiTokens.textMuted)
            }
        }
        .onAppear {
            guard value == nil else { return }
            withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) {
                indeterminatePhase = 1
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityValue(accessibilityValueText)
    }

    private var barView: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(MuiTokens.surface)
                if let clamped = Self.clampedValue(value) {
                    Capsule()
                        .fill(MuiTokens.primary)
                        .frame(width: geo.size.width * clamped / 100)
                        .animation(.easeOut(duration: 0.2), value: clamped)
                } else {
                    Capsule()
                        .fill(MuiTokens.primary)
                        .frame(width: geo.size.width * 0.3)
                        .offset(x: (geo.size.width * 1.3) * indeterminatePhase - geo.size.width * 0.3)
                }
            }
        }
        .frame(height: barHeight)
    }

    private var ringView: some View {
        ZStack {
            Circle()
                .stroke(MuiTokens.surface, lineWidth: ringLineWidth)
            if let clamped = Self.clampedValue(value) {
                Circle()
                    .trim(from: 0, to: clamped / 100)
                    .stroke(MuiTokens.primary, style: StrokeStyle(lineWidth: ringLineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.2), value: clamped)
            } else {
                Circle()
                    .trim(from: 0, to: 0.25)
                    .stroke(MuiTokens.primary, style: StrokeStyle(lineWidth: ringLineWidth, lineCap: .round))
                    .rotationEffect(.degrees(Double(indeterminatePhase) * 360 - 90))
            }
        }
        .frame(width: ringDiameter, height: ringDiameter)
    }

    private var barHeight: CGFloat {
        size == .sm ? 4 : 8
    }

    private var ringDiameter: CGFloat {
        size == .sm ? 24 : 36
    }

    private var ringLineWidth: CGFloat {
        size == .sm ? 3 : 4
    }

    private var accessibilityValueText: String {
        if let label { return label }
        if let clamped = Self.clampedValue(value) { return "\(Int(clamped))%" }
        return "In progress"
    }

    /// Clamps `value` into `0...100`; `nil` passes through unchanged
    /// (indeterminate). Public + static so out-of-range clamping is
    /// unit-testable without rendering a view (progress.md §Props).
    public static func clampedValue(_ value: Double?) -> Double? {
        guard let value else { return nil }
        return Swift.min(100, Swift.max(0, value))
    }
}

#Preview("MuiProgress — Bar") {
    VStack(alignment: .leading, spacing: 16) {
        MuiProgress(shape: .bar, value: 60, label: "60%")
        MuiProgress(shape: .bar, value: nil, label: "Exporting…")
    }
    .frame(width: 200)
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiProgress — Ring") {
    HStack(spacing: 16) {
        MuiProgress(shape: .ring, size: .sm, value: 40)
        MuiProgress(shape: .ring, size: .md, value: nil)
    }
    .padding()
    .background(MuiTokens.bg)
}
