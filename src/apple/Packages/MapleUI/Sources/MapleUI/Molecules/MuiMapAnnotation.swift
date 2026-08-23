// MuiMapAnnotation.swift — Maple UI Molecules-L1 (unified-component-
// catalog.md §2.7; Built from: Image, Badge, Text). A map pin: a thumbnail
// (or a fallback glyph when no photo is given) inside a teardrop pin
// shape, with an optional cluster-count badge and caption.

import SwiftUI

public struct MuiMapAnnotation: View {
    public let url: URL?
    public let label: String?
    public let count: Int?

    public init(url: URL? = nil, label: String? = nil, count: Int? = nil) {
        self.url = url
        self.label = label
        self.count = count
    }

    private static let pinDiameter: CGFloat = 40
    private static let pinHeight: CGFloat = 48

    public var body: some View {
        VStack(spacing: 2) {
            ZStack(alignment: .topTrailing) {
                pin
                if let count, count > 1 {
                    MuiBadge(variant: .count, value: "\(count)")
                        .offset(x: 8, y: -6)
                }
            }
            if let label {
                MuiText(label, variant: .toolLabel, color: .muted, truncate: true)
                    .frame(maxWidth: Self.pinDiameter + 24)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var pin: some View {
        // The pin's frame is deliberately taller than it is wide
        // (`pinHeight` > `pinDiameter`) so `MuiPinShape` has room below the
        // circle to draw its downward tail without the tail overlapping
        // the photo/glyph itself.
        let shape = MuiPinShape()
        ZStack {
            shape.fill(MuiTokens.surface)
            shape.stroke(MuiTokens.border, lineWidth: 1)

            Group {
                if let url {
                    MuiImage(url: url, alt: label ?? "Photo location", fit: .fill, radius: .none)
                } else {
                    ZStack {
                        MuiTokens.surfaceAlt
                        MuiIcon(name: "photo", size: .sm, color: MuiTokens.textMuted)
                    }
                }
            }
            .frame(width: Self.pinDiameter - 8, height: Self.pinDiameter - 8)
            .clipShape(Circle())
            .offset(y: -(Self.pinHeight - Self.pinDiameter) / 2)
        }
        .frame(width: Self.pinDiameter, height: Self.pinHeight)
    }
}

/// A teardrop map-pin outline: a circle (diameter `rect.width`) with a
/// downward-pointing tail filling the remaining height below it.
struct MuiPinShape: Shape {
    func path(in rect: CGRect) -> Path {
        let circleRect = CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.width)
        var path = Path(ellipseIn: circleRect)
        let tip = CGPoint(x: rect.midX, y: rect.maxY)
        let baseY = circleRect.maxY - rect.width * 0.18
        path.move(to: CGPoint(x: rect.midX - rect.width * 0.22, y: baseY))
        path.addLine(to: tip)
        path.addLine(to: CGPoint(x: rect.midX + rect.width * 0.22, y: baseY))
        path.closeSubpath()
        return path
    }
}

#Preview("MuiMapAnnotation") {
    HStack(alignment: .top, spacing: 24) {
        MuiMapAnnotation(label: "Golden Gate")
        MuiMapAnnotation(label: "Trip cluster", count: 12)
    }
    .padding()
    .background(MuiTokens.bg)
}
