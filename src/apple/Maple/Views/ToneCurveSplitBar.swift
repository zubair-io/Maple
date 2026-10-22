// ToneCurveSplitBar.swift — Parametric split diamond strip, active-region
// window shading, curve-mode toggle, and selected knot readout (#5039).

import MapleCore
import SwiftUI

// MARK: - Active region window shading on Canvas

enum ToneCurvePlotShading {
  /// Draw a translucent vertical bell envelope on the plot Canvas when a
  /// parametric region slider or split diamond is active (#5039).
  static func drawActiveRegion(
    context: GraphicsContext,
    size: CGSize,
    region: ParametricRegion,
    shadow: Double,
    midtone: Double,
    highlight: Double,
    tint: Color
  ) {
    let samples = ToneCurveSplits.sampleRegionWindow(
      region: region, shadow: shadow, midtone: midtone, highlight: highlight, samples: 64
    )
    guard !samples.isEmpty else { return }
    let w = size.width
    let h = size.height

    // Draw vertical guide lines at the three split positions.
    let (s, m, hi) = ToneCurveSplits.orderedSplits(
      shadow: shadow, midtone: midtone, highlight: highlight
    )
    var splitGuides = Path()
    for splitPct in [s, m, hi] {
      let x = ToneCurveSplits.authoringX(forAxis: splitPct) * w
      splitGuides.move(to: CGPoint(x: x, y: 0))
      splitGuides.addLine(to: CGPoint(x: x, y: h))
    }
    context.stroke(
      splitGuides,
      with: .color(tint.opacity(0.28)),
      style: StrokeStyle(lineWidth: 0.75, dash: [2, 3])
    )

    // Draw the smoothstep window envelope rising from the bottom axis.
    var area = Path()
    area.move(to: CGPoint(x: 0, y: h))
    for sample in samples {
      let x = sample.x * w
      let y = h - sample.weight * h * 0.35
      area.addLine(to: CGPoint(x: x, y: y))
    }
    area.addLine(to: CGPoint(x: w, y: h))
    area.closeSubpath()
    context.fill(area, with: .color(tint.opacity(0.14)))
  }
}

// MARK: - ToneCurveSplitBar

/// Interactive parametric split strip placed directly beneath the Scene-Linear
/// Tone Curve plot (#5039). Renders three draggable diamond markers (`Shadow Split`,
/// `Midtone Split`, `Highlight Split`) along the `[0, 100]` region axis; double-tap
/// resets an individual split to its canonical `25 / 50 / 75` default.
struct ToneCurveSplitBar: View {
  let shadowSplit: Double
  let midtoneSplit: Double
  let highlightSplit: Double
  let onChange: (ParametricSplitHandle, Double) -> Void
  let onEditingChanged: (ParametricSplitHandle, Bool) -> Void
  let onReset: (ParametricSplitHandle) -> Void
  var onResetAll: (() -> Void)? = nil

  @State private var activeHandle: ParametricSplitHandle?

  var body: some View {
    VStack(spacing: 4) {
      GeometryReader { geo in
        let width = max(1, geo.size.width)
        ZStack(alignment: .leading) {
          // Track line
          Capsule()
            .fill(ProTokens.border)
            .frame(height: 2)
            .frame(maxWidth: .infinity)

          ForEach(ParametricSplitHandle.allCases, id: \.rawValue) { handle in
            let val = value(for: handle)
            let x = ToneCurveSplits.authoringX(forAxis: val) * width
            SplitDiamondMarker(
              handle: handle,
              value: val,
              isActive: activeHandle == handle,
              onNudge: { delta in
                let clamped = ToneCurveSplits.clampSplit(
                  handle: handle,
                  proposed: val + delta,
                  shadow: shadowSplit,
                  midtone: midtoneSplit,
                  highlight: highlightSplit
                )
                guard clamped != val else { return }
                onEditingChanged(handle, true)
                onChange(handle, clamped)
                onEditingChanged(handle, false)
              },
              onReset: { onReset(handle) }
            )
            .position(x: x, y: 10)
            .highPriorityGesture(
              DragGesture(minimumDistance: 0, coordinateSpace: .named("splitTrack"))
                .onChanged { drag in
                  if activeHandle != handle {
                    activeHandle = handle
                    onEditingChanged(handle, true)
                  }
                  let proposed = ToneCurveSplits.axis(forAuthoringX: drag.location.x / width)
                  let clamped = ToneCurveSplits.clampSplit(
                    handle: handle,
                    proposed: proposed,
                    shadow: shadowSplit,
                    midtone: midtoneSplit,
                    highlight: highlightSplit
                  )
                  onChange(handle, clamped)
                }
                .onEnded { _ in
                  if activeHandle == handle {
                    activeHandle = nil
                    onEditingChanged(handle, false)
                  }
                }
            )
          }
        }
        .coordinateSpace(name: "splitTrack")
      }
      .frame(height: 20)

      HStack {
        Text(
          "Splits: \(Int(shadowSplit.rounded())) / \(Int(midtoneSplit.rounded())) / \(Int(highlightSplit.rounded()))"
        )
        .font(.system(size: 9, weight: .regular).monospacedDigit())
        .foregroundStyle(ProTokens.textDim)
        Spacer()
        if shadowSplit != ToneCurveSplits.defaultShadow
          || midtoneSplit != ToneCurveSplits.defaultMidtone
          || highlightSplit != ToneCurveSplits.defaultHighlight
        {
          Button {
            if let onResetAll {
              onResetAll()
            } else {
              onReset(.shadow)
              onReset(.midtone)
              onReset(.highlight)
            }
          } label: {
            Text("Reset splits")
              .font(.system(size: 9, weight: .regular))
              .foregroundStyle(ProTokens.textMuted)
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("editor-tone-curve-reset-splits")
        }
      }
    }
  }

  private func value(for handle: ParametricSplitHandle) -> Double {
    switch handle {
    case .shadow: return shadowSplit
    case .midtone: return midtoneSplit
    case .highlight: return highlightSplit
    }
  }
}

private struct SplitDiamondMarker: View {
  let handle: ParametricSplitHandle
  let value: Double
  let isActive: Bool
  let onNudge: (Double) -> Void
  let onReset: () -> Void

  private var labelText: String {
    switch handle {
    case .shadow: return "Shadow split"
    case .midtone: return "Midtone split"
    case .highlight: return "Highlight split"
    }
  }

  var body: some View {
    Rectangle()
      .fill(isActive ? ProTokens.accent : ProTokens.text)
      .frame(width: 7, height: 7)
      .rotationEffect(.degrees(45))
      .overlay(
        Rectangle()
          .stroke(ProTokens.accent, lineWidth: isActive ? 1.5 : 1)
          .frame(width: 7, height: 7)
          .rotationEffect(.degrees(45))
      )
      .frame(width: 18, height: 18)
      .contentShape(Rectangle())
      .onTapGesture(count: 2, perform: onReset)
      .accessibilityElement()
      .accessibilityLabel(labelText)
      .accessibilityValue("\(Int(value.rounded()))%")
      .accessibilityIdentifier("editor-tone-curve-split-\(handle.rawValue)")
      .accessibilityAdjustableAction { direction in
        onNudge(direction == .increment ? 1.0 : -1.0)
      }
  }
}

// MARK: - ToneCurveModeRow & KnotReadoutRow

/// Segmented `Per-Channel | Ratio-Preserving` toggle for Scene-Linear point
/// curves (`papp:ToneCurveMode`, #5039).
struct ToneCurveModeRow: View {
  let mode: ToneCurveMode
  let onSelect: (ToneCurveMode) -> Void

  var body: some View {
    HStack(spacing: 4) {
      Text("Mode")
        .font(.system(size: 9, weight: .regular))
        .foregroundStyle(ProTokens.textDim)
      Spacer(minLength: 6)
      modeButton(.perChannel, label: "Per-Channel")
      modeButton(.ratioPreserving, label: "Ratio-Preserving")
    }
  }

  private func modeButton(_ target: ToneCurveMode, label: String) -> some View {
    let selected = mode == target
    return Button {
      guard mode != target else { return }
      onSelect(target)
    } label: {
      Text(label)
        .font(.system(size: 9, weight: selected ? .semibold : .regular))
        .foregroundStyle(selected ? ProTokens.accent : ProTokens.textDim)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(
          RoundedRectangle(cornerRadius: MapleTokens.Radius.sm, style: .continuous)
            .fill(selected ? ProTokens.accent(0x28) : Color.clear)
        )
        .overlay(
          RoundedRectangle(cornerRadius: MapleTokens.Radius.sm, style: .continuous)
            .stroke(selected ? ProTokens.accent : ProTokens.border, lineWidth: 0.5)
        )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(label) tone curve mode")
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("editor-tone-curve-mode-\(target.rawValue)")
  }
}

/// Compact selected-knot coordinate readout (`In: XX% · Out: YY%`) with a
/// one-tap delete action for interior control points (#5039).
struct ToneCurveKnotReadout: View {
  let knot: ToneCurvePoint
  let isEndpoint: Bool
  let onDelete: () -> Void

  var body: some View {
    HStack(spacing: 6) {
      Text("In \(Int((knot.x * 100).rounded()))% · Out \(Int((knot.y * 100).rounded()))%")
        .font(.system(size: 9, weight: .regular).monospacedDigit())
        .foregroundStyle(ProTokens.textMuted)
        .accessibilityIdentifier("editor-tone-curve-knot-readout")
      if !isEndpoint {
        Button(action: onDelete) {
          Text("Delete point")
            .font(.system(size: 9, weight: .regular))
            .foregroundStyle(ProTokens.accent)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Delete selected curve point")
        .accessibilityIdentifier("editor-tone-curve-delete-knot")
      }
    }
  }
}
