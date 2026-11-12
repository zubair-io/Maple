// ToneCurveHoverPreview.swift — what a press on the tone-curve plot would
// do, drawn under a hovering Apple Pencil or pointer (#5121).
//
// A ring marks the point a press would grab; a ghost point with guide
// lines marks where it would add one. Both come from the same
// `ToneCurveEditing.press` rule the press itself runs, so the preview and
// the edit agree. Decorative: the points themselves carry the labels.

import MapleCore
import SwiftUI

struct ToneCurveHoverPreview: View {
  let press: ToneCurvePress
  /// The materialized points the plot is showing.
  let knots: [ToneCurvePoint]
  let stroke: Color
  let side: CGFloat

  private var target: ToneCurvePoint? {
    switch press {
    case .grab(let index): return knots.indices.contains(index) ? knots[index] : nil
    case .insert(let x, let y): return (x: x, y: y)
    }
  }

  var body: some View {
    ZStack(alignment: .topLeading) {
      if let target {
        let center = CGPoint(x: target.x * side, y: (1 - target.y) * side)
        switch press {
        case .grab:
          Circle().stroke(ProTokens.accent, lineWidth: 1.5)
            .frame(width: 17, height: 17)
            .position(center)
        case .insert:
          Rectangle().fill(stroke.opacity(0.35)).frame(width: side, height: 0.5)
            .position(x: side / 2, y: center.y)
          Rectangle().fill(stroke.opacity(0.35)).frame(width: 0.5, height: side)
            .position(x: center.x, y: side / 2)
          Circle().stroke(stroke, lineWidth: 1.5)
            .frame(width: 9, height: 9)
            .position(center)
        }
        Text("In \(Self.percent(target.x))% · Out \(Self.percent(target.y))%")
          .font(.system(size: 9, weight: .regular).monospacedDigit())
          .foregroundStyle(ProTokens.textMuted)
          .padding(4)
      }
    }
    .frame(width: side, height: side, alignment: .topLeading)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  private static func percent(_ value: Double) -> Int { Int((value * 100).rounded()) }
}
