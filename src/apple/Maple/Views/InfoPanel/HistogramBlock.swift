// HistogramBlock.swift — S6 Info content, section 2.
//
// Live RGB histogram on every platform (closes #633 / histogram-all-platforms).
// The curves and the data loading live in the shared `MiniHistogram` (see
// `Views/MiniHistogram.swift`), which the editor pill's 70×30 chip also uses —
// this file is the 56pt inspector block's chrome around it: section header,
// surface fill, hairline border, and the decorative placeholder shown until
// data lands.
//
// Layout pact with the placeholder: same 56pt block height, 0.5pt border, 6pt
// corner radius, `surface` background. The live canvas fades in over the
// placeholder once the data lands, so the inspector never jumps; an in-place
// edit keeps the prior curves visible through the recompute (no mid-edit flash).

import MapleCore
import SwiftUI

struct HistogramBlock: View {
  /// The active editing session. The histogram is computed for `session.asset`
  /// under the live `session.model` / `session.culling`, so it tracks edits.
  /// `nil` ⇒ placeholder.
  let session: EditSession?

  private static let cornerRadius: CGFloat = 6

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      sectionHeader("Histogram")
      block
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-panel-histogram")
  }

  // MARK: - Block body

  private var block: some View {
    RoundedRectangle(cornerRadius: Self.cornerRadius)
      .fill(MapleTokens.surface)
      .frame(height: 56)
      .overlay(
        MiniHistogram(session: session) { placeholderArt }
          .clipShape(RoundedRectangle(cornerRadius: Self.cornerRadius))
      )
      .overlay(
        RoundedRectangle(cornerRadius: Self.cornerRadius)
          .stroke(MapleTokens.border, lineWidth: 0.5)
      )
  }

  // MARK: - Placeholder (no client, no stableID, fetch error)

  /// Three faint gradient bands telegraph "this will be RGB curves soon"
  /// without claiming to be data, under a label that says so outright.
  /// Avoids the user mistaking a flat gray rect for an actually-flat
  /// histogram. The surrounding fill + border come from `block`.
  private var placeholderArt: some View {
    ZStack {
      GeometryReader { geo in
        ZStack {
          histogramCurve(color: .red, amplitude: 0.6, phase: 0.0, in: geo.size)
          histogramCurve(color: .green, amplitude: 0.7, phase: 0.4, in: geo.size)
          histogramCurve(color: .blue, amplitude: 0.5, phase: 0.8, in: geo.size)
        }
        .opacity(0.25)
      }
      Text("Histogram")
        .font(MapleTokens.Typography.eyebrow)
        .tracking(1.0)
        .foregroundStyle(MapleTokens.textMuted)
    }
  }

  /// Synthetic Gaussian-ish bump for the placeholder. NOT real data;
  /// purely decorative so the placeholder reads as a histogram-shaped
  /// region instead of an empty box.
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
  // No session ⇒ no source ⇒ placeholder (the preview asset isn't on disk).
  HistogramBlock(session: nil)
    .frame(width: 280)
    .padding()
    .background(MapleTokens.bg)
}
