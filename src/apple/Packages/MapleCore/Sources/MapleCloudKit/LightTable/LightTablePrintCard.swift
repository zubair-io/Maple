// LightTablePrintCard.swift
//
// The pieces `LightTableView` lays out for each print: the matted card itself
// and the "leaf fall" transition it glides in and out with.

import SwiftUI

/// Transition modifier for a print's "leaf fall": a horizontal slide (`dx`,
/// additive to the settled offset) plus a small 3D tilt that resolves to flat
/// (`.settled`) as the print lands. Used for both the fall-in and slide-off.
struct PrintFall: ViewModifier {
  let dx: CGFloat
  let x: Double
  let y: Double
  let z: Double

  static let settled = PrintFall(dx: 0, x: 0, y: 0, z: 0)

  func body(content: Content) -> some View {
    content
      .rotation3DEffect(.degrees(x), axis: (x: 1, y: 0, z: 0), perspective: 0.6)
      .rotation3DEffect(.degrees(y), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
      .rotationEffect(.degrees(z))
      .offset(x: dx)
  }
}

/// One scattered "print" — a photo on a white mat with a layered drop
/// shadow. Reads `\.isFocused` from the focusable modifier applied just
/// outside it, raising itself with an accent ring when focused (tvOS).
struct LightTablePrintCard<Content: View>: View {
  let imageSize: CGFloat
  let matPadding: CGFloat
  let accent: Color
  @ViewBuilder let content: Content

  @Environment(\.isFocused) private var isFocused

  private var shadowScale: CGFloat { imageSize / LightTableMetrics.television.imageSize }

  var body: some View {
    content
      .frame(width: imageSize, height: imageSize)
      .padding(matPadding)
      .background(Color.white)
      .clipShape(RoundedRectangle(cornerRadius: 6))
      .overlay(
        RoundedRectangle(cornerRadius: 6)
          .stroke(accent, lineWidth: isFocused ? 6 : 0)
      )
      // A soft, wide ambient shadow plus a tighter key shadow, so the print
      // reads as a physical card lifted off the table. Tuned on Maple TV's
      // 300 pt prints and scaled with the print on smaller screens.
      .shadow(
        color: .black.opacity(isFocused ? 0.32 : 0.20),
        radius: (isFocused ? 44 : 22) * shadowScale, x: 0, y: (isFocused ? 26 : 13) * shadowScale
      )
      .shadow(
        color: .black.opacity(isFocused ? 0.24 : 0.16),
        radius: (isFocused ? 9 : 4) * shadowScale, x: 0, y: (isFocused ? 6 : 2) * shadowScale
      )
      .scaleEffect(isFocused ? 1.14 : 1.0)
      .animation(.easeOut(duration: 0.25), value: isFocused)
  }
}
