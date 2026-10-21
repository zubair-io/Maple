// ColorGradingPanel.swift — Color Grading tool surface (#275).
//
// Shared color-grading surface for the Apple editor's adjustments panel.
//
// Layout: four `ColorWheelView`s (Shadows / Midtones / Highlights / Global)
// in a 2×2 grid, each paired with its zone's luminance offset slider, plus
// the balance slider underneath — thirteen controls total, matching
// `Tool.colorGrade.subParams`. The scalar sliders reuse the plain
// `LivingSlider` primitive (not `LivingSliderRow`, which is tool-keyed
// rather than field-keyed) so their visuals match every other slider in
// the editor.
//
// Shadows/Highlights hue+saturation read/write the `splitTone*` fields
// (ACR's own `crs:SplitToning*` layout); Midtones/Global and every
// luminance offset read/write the new `colorGrade*` fields. See
// `AdjustmentModel`'s Color Grading doc comment for the full field list.

import MapleCore
import SwiftUI

struct ColorGradingPanel: View {
  @Bindable var state: EditorState

  private struct Zone {
    let title: String
    let hue: WritableKeyPath<AdjustmentModel, Double>
    let saturation: WritableKeyPath<AdjustmentModel, Double>
    let luminance: WritableKeyPath<AdjustmentModel, Double>
    let luminanceRange: ClosedRange<Double>
  }

  private var zones: [Zone] {
    [
      Zone(
        title: "Shadows",
        hue: \.splitToneShadowHue, saturation: \.splitToneShadowSaturation,
        luminance: \.colorGradeShadowLuminance,
        luminanceRange: AdjustmentModel.colorGradeShadowLuminanceRange),
      Zone(
        title: "Midtones",
        hue: \.colorGradeMidtoneHue, saturation: \.colorGradeMidtoneSaturation,
        luminance: \.colorGradeMidtoneLuminance,
        luminanceRange: AdjustmentModel.colorGradeMidtoneLuminanceRange),
      Zone(
        title: "Highlights",
        hue: \.splitToneHighlightHue, saturation: \.splitToneHighlightSaturation,
        luminance: \.colorGradeHighlightLuminance,
        luminanceRange: AdjustmentModel.colorGradeHighlightLuminanceRange),
      Zone(
        title: "Global",
        hue: \.colorGradeGlobalHue, saturation: \.colorGradeGlobalSaturation,
        luminance: \.colorGradeGlobalLuminance,
        luminanceRange: AdjustmentModel.colorGradeGlobalLuminanceRange),
    ]
  }

  private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      LazyVGrid(columns: columns, spacing: 16) {
        ForEach(zones, id: \.title) { zone in
          zoneCell(zone)
        }
      }
      LivingSlider(
        label: "Balance",
        value: bind(\.splitToneBalance),
        range: AdjustmentModel.splitToneBalanceRange,
        isBipolar: true,
        defaultValue: 0,
        onEditingChanged: { editing in
          if editing {
            state.beginSliderInteraction(tool: .colorGrade, subParamID: "balance")
          } else {
            state.endGesture()
          }
        }
      )
      LivingSlider(
        label: "Blending",
        value: bind(\.colorGradeBlending),
        range: AdjustmentModel.colorGradeBlendingRange,
        isBipolar: false,
        defaultValue: 100,
        onEditingChanged: { editing in
          if editing {
            state.beginSliderInteraction(tool: .colorGrade, subParamID: "blending")
          } else {
            state.endGesture()
          }
        }
      )
      .accessibilityIdentifier("editor-color-grading-blending")

      tonalZoneWeightsStrip
    }
    .padding(.vertical, 4)
    .accessibilityIdentifier("editor-color-grading-panel")
  }

  private var tonalZoneWeightsStrip: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("TONAL ZONE WEIGHTS")
          .font(.system(size: 9, weight: .semibold))
          .tracking(0.6)
          .foregroundStyle(ProTokens.textMuted)
        Spacer()
        Text(
          String(
            format: "Sh %.2f · Hi %.2f",
            state.session.model.colorGradeShadowEdge,
            state.session.model.colorGradeHighlightEdge
          )
        )
        .font(.system(size: 9, weight: .medium, design: .monospaced))
        .foregroundStyle(ProTokens.textMuted)
      }

      GeometryReader { geo in
        let w = max(geo.size.width, 1)
        let h = max(geo.size.height, 1)
        let shX = CGFloat(state.session.model.colorGradeShadowEdge) * w
        let hiX = CGFloat(state.session.model.colorGradeHighlightEdge) * w

        ZStack(alignment: .topLeading) {
          RoundedRectangle(cornerRadius: 6)
            .fill(Color.black.opacity(0.28))
            .overlay(
              RoundedRectangle(cornerRadius: 6)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )

          Canvas { ctx, size in
            let steps = 64
            var shPath = Path()
            var midPath = Path()
            var hiPath = Path()
            for i in 0...steps {
              let t = Double(i) / Double(steps)
              let x = CGFloat(t) * size.width
              let weights = Self.zoneWeights(
                at: t,
                balance: state.session.model.splitToneBalance,
                blending: state.session.model.colorGradeBlending,
                shadowEdge: state.session.model.colorGradeShadowEdge,
                highlightEdge: state.session.model.colorGradeHighlightEdge
              )
              let ySh = (1 - CGFloat(weights.sh)) * (size.height - 8) + 4
              let yMid = (1 - CGFloat(weights.mid)) * (size.height - 8) + 4
              let yHi = (1 - CGFloat(weights.hi)) * (size.height - 8) + 4
              if i == 0 {
                shPath.move(to: CGPoint(x: x, y: ySh))
                midPath.move(to: CGPoint(x: x, y: yMid))
                hiPath.move(to: CGPoint(x: x, y: yHi))
              } else {
                shPath.addLine(to: CGPoint(x: x, y: ySh))
                midPath.addLine(to: CGPoint(x: x, y: yMid))
                hiPath.addLine(to: CGPoint(x: x, y: yHi))
              }
            }
            ctx.stroke(shPath, with: .color(Color.cyan.opacity(0.85)), lineWidth: 1.5)
            ctx.stroke(midPath, with: .color(Color.orange.opacity(0.85)), lineWidth: 1.5)
            ctx.stroke(hiPath, with: .color(Color.yellow.opacity(0.90)), lineWidth: 1.5)
          }

          edgeHandle(
            x: shX, height: h, color: .cyan,
            label: "Shadow Edge", id: "color-grade-shadow-edge-handle",
            onDrag: { locX in
              let norm = Double(locX / w)
              state.session.model.colorGradeShadowEdge = min(max(norm, 0.10), 0.564622)
            },
            onReset: {
              state.session.model.colorGradeShadowEdge = 0.564622
              state.commit()
            }
          )

          edgeHandle(
            x: hiX, height: h, color: .yellow,
            label: "Highlight Edge", id: "color-grade-highlight-edge-handle",
            onDrag: { locX in
              let norm = Double(locX / w)
              state.session.model.colorGradeHighlightEdge = min(max(norm, 0.564622), 0.90)
            },
            onReset: {
              state.session.model.colorGradeHighlightEdge = 0.564622
              state.commit()
            }
          )
        }
      }
      .frame(height: 44)
      .accessibilityIdentifier("editor-color-grading-zone-weights")
    }
  }

  private func edgeHandle(
    x: CGFloat,
    height: CGFloat,
    color: Color,
    label: String,
    id: String,
    onDrag: @escaping (CGFloat) -> Void,
    onReset: @escaping () -> Void
  ) -> some View {
    ZStack {
      Rectangle()
        .fill(color.opacity(0.65))
        .frame(width: 1.5, height: height - 4)
      Circle()
        .fill(color)
        .frame(width: 10, height: 10)
        .overlay(Circle().stroke(Color.black.opacity(0.6), lineWidth: 1))
    }
    .frame(width: 22, height: height)
    .contentShape(Rectangle())
    .position(x: x, y: height / 2)
    .gesture(
      DragGesture(minimumDistance: 0)
        .onChanged { g in
          onDrag(g.location.x)
        }
        .onEnded { _ in
          state.endGesture()
        }
    )
    .onTapGesture(count: 2, perform: onReset)
    .accessibilityElement()
    .accessibilityLabel(label)
    .accessibilityIdentifier(id)
  }

  static func zoneWeights(
    at l: Double,
    balance: Double,
    blending: Double,
    shadowEdge: Double,
    highlightEdge: Double
  ) -> (sh: Double, mid: Double, hi: Double) {
    let lClamped = min(max(l, 0), 1)
    let b = min(max(balance, -100), 100) / 100.0
    let lMid = 0.564622 - 0.18 * b
    let lLow = min(max(shadowEdge, 0.10), 0.564622)
    let lHigh = min(max(highlightEdge, 0.564622), 0.90)
    let w = min(max(blending, 0), 100) / 100.0
    let sh0 = max(lLow * (1 - w), 0)
    let sh1 = max(min(lLow + (lMid - lLow) * w, 1), sh0 + 1e-4)
    let hi0 = min(max(lMid + (lHigh - lMid) * (1 - w), 0), 1 - 1e-4)
    let hi1 = max(min(lHigh + (1 - lHigh) * w, 1), hi0 + 1e-4)
    let wSh = 1 - smoothstep(sh0, sh1, lClamped)
    let wHi = smoothstep(hi0, hi1, lClamped)
    let wMid = max(1 - wSh - wHi, 0)
    return (wSh, wMid, wHi)
  }

  private static func smoothstep(_ e0: Double, _ e1: Double, _ x: Double) -> Double {
    let span = max(e1 - e0, 1e-5)
    let t = min(max((x - e0) / span, 0), 1)
    return t * t * (3 - 2 * t)
  }

  private func zoneCell(_ zone: Zone) -> some View {
    VStack(spacing: 8) {
      Text(zone.title.uppercased())
        .font(.system(size: 9, weight: .semibold))
        .tracking(0.6)
        .foregroundStyle(ProTokens.textMuted)

      ColorWheelView(
        label: "\(zone.title) colour wheel",
        hue: bind(zone.hue),
        saturation: bind(zone.saturation),
        onCommit: { state.commit() },
        onEnd: { state.endGesture() }
      )
      .frame(width: 96, height: 96)

      LivingSlider(
        label: "Lum",
        value: bind(zone.luminance),
        range: zone.luminanceRange,
        isBipolar: true,
        defaultValue: 0,
        onEditingChanged: { editing in
          if editing {
            state.beginSliderInteraction(
              tool: .colorGrade,
              subParamID: Tool.colorGrade.subParams.first { $0.keyPath == zone.luminance }?.id)
          } else {
            state.endGesture()
          }
        }
      )
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-color-grading-zone-\(zone.title.lowercased())")
  }

  private func bind(_ keyPath: WritableKeyPath<AdjustmentModel, Double>) -> Binding<Double> {
    Binding(
      get: { state.session.model[keyPath: keyPath] },
      set: { state.session.model[keyPath: keyPath] = $0 }
    )
  }
}
