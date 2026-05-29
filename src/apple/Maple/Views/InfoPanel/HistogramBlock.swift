// HistogramBlock.swift — S6 Info content, section 2.
//
// v0.1 PLACEHOLDER. Spec calls for a server-rendered RGB curves SVG/PNG
// fetched from the API; the endpoint does not exist yet in `src/api/`
// (audited 2026-05-29 — no `/histogram/:assetId` route). Follow-up ticket:
// "API: server-rendered RGB histogram endpoint for InfoPanel".
//
// Until that lands we render a styled rounded rect with a "Histogram"
// label so the layout reserves the right amount of vertical space. The
// placeholder uses the same 56pt block height, 0.5pt border, 6pt corner
// radius, and `surface` background that the real component will keep,
// so swapping in the real PNG is a one-file edit.

import MapleCore
import SwiftUI

// MARK: - HistogramBlock

struct HistogramBlock: View {
  let asset: AssetRef?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      sectionHeader("Histogram")
      placeholder
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-panel-histogram")
  }

  private var placeholder: some View {
    ZStack {
      // Three faint gradient bands telegraph "this will be RGB curves
      // soon" without claiming to be data. Avoids the user mistaking
      // a flat gray rect for an actually-flat histogram.
      RoundedRectangle(cornerRadius: 6)
        .fill(MapleTokens.surface)
        .frame(height: 56)
        .overlay(
          RoundedRectangle(cornerRadius: 6)
            .stroke(MapleTokens.border, lineWidth: 0.5)
        )
        .overlay(
          GeometryReader { geo in
            ZStack {
              histogramCurve(color: .red, amplitude: 0.6, phase: 0.0, in: geo.size)
              histogramCurve(color: .green, amplitude: 0.7, phase: 0.4, in: geo.size)
              histogramCurve(color: .blue, amplitude: 0.5, phase: 0.8, in: geo.size)
            }
            .opacity(0.25)
          }
          .clipShape(RoundedRectangle(cornerRadius: 6))
        )
      Text("Histogram")
        .font(MapleTokens.Typography.eyebrow)
        .tracking(1.0)
        .foregroundStyle(MapleTokens.textMuted)
    }
    .accessibilityLabel("Histogram preview unavailable")
  }

  /// Synthetic Gaussian-ish bump for the placeholder. NOT real data;
  /// purely decorative so the placeholder reads as a histogram-shaped
  /// region instead of an empty box. Replaced wholesale when the real
  /// endpoint lands.
  private func histogramCurve(
    color: Color,
    amplitude: Double,
    phase: Double,
    in size: CGSize
  ) -> some View {
    Path { path in
      let w = size.width
      let h = size.height
      let center = w * phase
      let sigma = w * 0.20
      path.move(to: CGPoint(x: 0, y: h))
      for x in stride(from: 0.0, through: w, by: 2.0) {
        let dx = (x - center) / sigma
        let y = h - h * amplitude * exp(-0.5 * dx * dx)
        path.addLine(to: CGPoint(x: x, y: y))
      }
      path.addLine(to: CGPoint(x: w, y: h))
      path.closeSubpath()
    }
    .fill(color)
  }

  private func sectionHeader(_ title: String) -> some View {
    Text(title.uppercased())
      .font(MapleTokens.Typography.eyebrow)
      .foregroundStyle(MapleTokens.textMuted)
      .tracking(1.4)
  }
}

// MARK: - Previews

#Preview("HistogramBlock — placeholder") {
  HistogramBlock(asset: .preview())
    .frame(width: 280)
    .padding()
    .background(MapleTokens.bg)
}
