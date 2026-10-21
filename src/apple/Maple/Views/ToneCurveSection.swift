// ToneCurveSection.swift — Tone Curve tool surface (#367).
//
// Replaces the group's living-slider stack while the Tone Curve tool is
// armed, the same swap-in-a-custom-surface pattern `HSLSection` (#274) and
// `ColorGradingPanel` (#275) use — and for the same structural reason: the
// tool carries eight fields and no single primary one, so
// `ToolValueMapping.displayRange` is nil for it and this section IS its
// control surface.
//
//   ┌────────────────────────────────────────────────┐
//   │  [Luma] [R] [G] [B]              Reset curve   │  ← channel selector
//   │  ┌──────────────────────────────────────────┐  │
//   │  │            (square curve plot)           │  │  ← point curve
//   │  └──────────────────────────────────────────┘  │
//   │  Highlights   ──────●──────────────      +12   │
//   │  Lights       ────────●────────────       +4   │  ← parametric
//   │  Darks        ──────●──────────────        0   │     regions
//   │  Shadows      ──────●──────────────       -8   │
//   └────────────────────────────────────────────────┘
//
// Two families, matching `docs/xmp-canonical-format.md` § "Tone curves" and the two shapes
// `AdjustmentModel` carries. The four PARAMETRIC region scalars are declared
// as `Tool.toneCurve`'s sub-params and route through `EditorState`'s value
// pipe (`arm(subParamId:)` + `setArmedDisplayValue`), exactly as HSL's band
// sliders do — so the value HUD, the undo boundaries and the per-sub-param
// modified dots all follow a drag here. The four per-channel POINT curves are
// point lists rather than scalars, so they cannot be sub-params; they are
// written straight onto `session.model` by the plot, with `commit()` called
// once at gesture start to open the undo boundary.
//
// The Angular twin is `tone-curve.component.ts`; both draw the curve through
// a port of raw-core's Fritsch–Carlson evaluator, pinned to it by the shared
// sample table in `ToneCurveMathTests`.

import MapleCore
import SwiftUI

// MARK: - ToneCurveSection

struct ToneCurveSection: View {
  @Bindable var state: EditorState

  /// The four curves the channel selector switches between.
  private struct Channel: Identifiable {
    let id: String
    let label: String
    let keyPath: WritableKeyPath<AdjustmentModel, ToneCurve>
    let stroke: Color
  }

  /// Which point-curve FAMILY the plot edits (#2232). `.sceneLinear`
  /// (`papp:SceneLinearToneCurve*`) applies pre-AgX in scene-linear light
  /// — the original #367 family. `.display` (`crs:ToneCurvePV2012*`)
  /// applies post-AgX in display-linear `[0, 1]`, independently per
  /// channel — not luma-coupled, matching Adobe Camera Raw's own
  /// point-curve behaviour. Both families can be authored on the same
  /// image at once; this toggle only changes which one the widget is
  /// currently editing.
  private enum Family: String, CaseIterable, Identifiable {
    case sceneLinear, display
    var id: String { rawValue }
    var label: String { self == .sceneLinear ? "Scene" : "Display" }
  }

  private static let sceneLinearChannels: [Channel] = [
    Channel(id: "luma", label: "Luma", keyPath: \.toneCurveLuma, stroke: ProTokens.accent),
    Channel(id: "r", label: "R", keyPath: \.toneCurveRed, stroke: ProTokens.curveRed),
    Channel(id: "g", label: "G", keyPath: \.toneCurveGreen, stroke: ProTokens.curveGreen),
    Channel(id: "b", label: "B", keyPath: \.toneCurveBlue, stroke: ProTokens.curveBlue),
  ]

  private static let displayChannels: [Channel] = [
    Channel(
      id: "luma", label: "Master", keyPath: \.displayToneCurveLuma, stroke: ProTokens.accent
    ),
    Channel(id: "r", label: "R", keyPath: \.displayToneCurveRed, stroke: ProTokens.curveRed),
    Channel(
      id: "g", label: "G", keyPath: \.displayToneCurveGreen, stroke: ProTokens.curveGreen
    ),
    Channel(id: "b", label: "B", keyPath: \.displayToneCurveBlue, stroke: ProTokens.curveBlue),
  ]

  /// Which family is active. Local view state, same rationale as
  /// `selectedChannelID` below — a lens onto the model, not a value
  /// stored in it.
  @State private var selectedFamily: Family = .sceneLinear

  /// Which channel the plot edits. Local view state: it is a lens onto the
  /// model, not a value stored in it, so it deliberately does NOT persist to
  /// the sidecar.
  @State private var selectedChannelID = "luma"
  @State private var activeRegion: ParametricRegion?
  @State private var selectedKnotIndex: Int?
  @Environment(\.toneCurveKeyboardBridge) private var keyboardBridge
  @State private var curveKeyHandler: ((KeyPress) -> KeyPress.Result)?

  private var channels: [Channel] {
    selectedFamily == .display ? Self.displayChannels : Self.sceneLinearChannels
  }

  private var channel: Channel {
    channels.first { $0.id == selectedChannelID } ?? channels[0]
  }

  private var points: [ToneCurvePoint] {
    state.session.model[keyPath: channel.keyPath].points
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      familyRow
      if selectedFamily == .sceneLinear {
        ToneCurveModeRow(
          mode: state.session.model.toneCurveMode,
          onSelect: { newMode in
            keyboardBridge?.resign?()
            state.commit(description: "Tone Curve mode")
            state.session.model.toneCurveMode = newMode
            state.session.endEdit()
          }
        )
      }
      channelRow
      curvePlot
      if let knotInfo = selectedKnotInfo {
        ToneCurveKnotReadout(
          knot: knotInfo.knot,
          isEndpoint: knotInfo.isEndpoint,
          onDelete: deleteSelectedKnot
        )
      }
      if selectedFamily == .sceneLinear {
        splitBar
        regionSliders
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-tone-curve-section")
    #if os(iOS)
      .focusedSceneValue(\.toneCurveKeyPress, curveKeyHandler)
    #endif
  }

  var curvePlot: ToneCurvePlot {
    ToneCurvePlot(
      readPoints: { points },
      stroke: channel.stroke,
      channelName: channel.label,
      session: state.session,
      onChange: writeCurve,
      onEditingChanged: { editing in
        if editing { state.commit() } else { state.endGesture() }
      },
      keyboardBridge: keyboardBridge,
      onKeyHandlerChanged: { handler in curveKeyHandler = handler },
      activeRegion: selectedFamily == .sceneLinear ? activeRegion : nil,
      shadowSplit: state.session.model.parametricShadowSplit,
      midtoneSplit: state.session.model.parametricMidtoneSplit,
      highlightSplit: state.session.model.parametricHighlightSplit,
      onSelectedKnotChanged: { idx in selectedKnotIndex = idx }
    )
  }

  private var selectedKnotInfo: (knot: ToneCurvePoint, isEndpoint: Bool)? {
    guard let idx = selectedKnotIndex else { return nil }
    let list = ToneCurveEditing.materialize(points)
    guard list.indices.contains(idx) else { return nil }
    return (list[idx], idx == 0 || idx == list.count - 1)
  }

  private func deleteSelectedKnot() {
    guard let idx = selectedKnotIndex else { return }
    let next = ToneCurveEditing.remove(points, index: idx)
    guard ToneCurve(points: next) != ToneCurve(points: points) else { return }
    selectedKnotIndex = nil
    state.commit()
    writeCurve(next)
    state.endGesture()
  }

  private var splitBar: some View {
    ToneCurveSplitBar(
      shadowSplit: state.session.model.parametricShadowSplit,
      midtoneSplit: state.session.model.parametricMidtoneSplit,
      highlightSplit: state.session.model.parametricHighlightSplit,
      onChange: { handle, value in
        switch handle {
        case .shadow: state.session.model.parametricShadowSplit = value
        case .midtone: state.session.model.parametricMidtoneSplit = value
        case .highlight: state.session.model.parametricHighlightSplit = value
        }
      },
      onEditingChanged: { handle, editing in
        if editing {
          keyboardBridge?.resign?()
          activeRegion = Self.region(forSplit: handle)
          state.commit(description: "Tone Curve split")
        } else {
          activeRegion = nil
          state.endGesture()
        }
      },
      onReset: { handle in
        keyboardBridge?.resign?()
        state.commit(description: "Reset Tone Curve split")
        switch handle {
        case .shadow: state.session.model.parametricShadowSplit = ToneCurveSplits.defaultShadow
        case .midtone: state.session.model.parametricMidtoneSplit = ToneCurveSplits.defaultMidtone
        case .highlight:
          state.session.model.parametricHighlightSplit = ToneCurveSplits.defaultHighlight
        }
        state.session.endEdit()
      },
      onResetAll: {
        keyboardBridge?.resign?()
        state.commit(description: "Reset Tone Curve splits")
        state.session.model.parametricShadowSplit = ToneCurveSplits.defaultShadow
        state.session.model.parametricMidtoneSplit = ToneCurveSplits.defaultMidtone
        state.session.model.parametricHighlightSplit = ToneCurveSplits.defaultHighlight
        state.session.endEdit()
      }
    )
  }

  private static func region(forSplit handle: ParametricSplitHandle) -> ParametricRegion {
    switch handle {
    case .shadow: return .shadows
    case .midtone: return .darks
    case .highlight: return .highlights
    }
  }

  // MARK: - Family selector

  /// Scene-linear vs display-referred (#2232). Reuses the same
  /// `ToneCurveChannelChip` the channel row uses below — one visual
  /// language for "pick one of a small closed set" on this surface,
  /// rather than introducing a second control style.
  private var familyRow: some View {
    HStack(spacing: 4) {
      ForEach(Family.allCases) { fam in
        ToneCurveChannelChip(
          label: fam.label,
          isSelected: fam == selectedFamily,
          isModified: false,
          tint: ProTokens.accent,
          action: {
            keyboardBridge?.resign?()
            selectedFamily = fam
            selectedChannelID = "luma"
          }
        )
        .accessibilityIdentifier("editor-tone-curve-family-\(fam.rawValue)")
      }
    }
  }

  // MARK: - Channel selector

  private var channelRow: some View {
    HStack(spacing: 4) {
      ForEach(channels) { ch in
        ToneCurveChannelChip(
          label: ch.label,
          isSelected: ch.id == selectedChannelID,
          isModified: !state.session.model[keyPath: ch.keyPath].isIdentity,
          tint: ch.stroke,
          action: {
            keyboardBridge?.resign?()
            selectedChannelID = ch.id
          }
        )
      }
      Spacer(minLength: 6)
      Button(action: resetChannel) {
        Text("Reset curve")
          .font(.system(size: 9, weight: .regular))
          .foregroundStyle(ProTokens.textMuted)
      }
      .buttonStyle(.plain)
      .disabled(points.isEmpty)
      .accessibilityLabel("Reset \(channel.label) curve")
      .accessibilityIdentifier("editor-tone-curve-reset")
    }
    // Deliberately NO container identifier here. An `accessibilityIdentifier`
    // on a plain (non-element) container propagates down and REPLACES the
    // identifiers of its descendants, so a row id would erase the per-chip
    // ids the tests query. Observed in the #367 UITest tree, where the
    // chips came back as five buttons all called `editor-tone-curve-channels`.
  }

  // MARK: - Parametric region sliders

  private var regionSliders: some View {
    VStack(spacing: 10) {
      ForEach(Tool.toneCurve.subParams) { sub in
        regionSlider(sub)
      }
    }
    // No container identifier — see the note on `channelRow`.
  }

  private func regionSlider(_ sub: ToolSubParam) -> some View {
    LivingSlider(
      label: sub.label,
      value: Binding(
        get: { state.session.model[keyPath: sub.keyPath] },
        set: { newValue in
          // Arm before writing so the HUD, the undo burst and
          // `resetArmedTool` all target THIS region.
          if state.armedTool != .toneCurve { state.arm(tool: .toneCurve) }
          if state.armedSubParamId != sub.id { state.arm(subParamId: sub.id) }
          state.setArmedDisplayValue(newValue)
        }
      ),
      range: sub.range,
      isBipolar: true,
      defaultValue: sub.defaultDisplayValue,
      onEditingChanged: { editing in
        if editing {
          keyboardBridge?.resign?()
          activeRegion = ParametricRegion(rawValue: sub.id)
          state.beginSliderInteraction(tool: .toneCurve, subParamID: sub.id)
        } else {
          activeRegion = nil
          state.endGesture()
        }
      }
    )
    #if os(iOS)
      .focusedValue(\.toneCurveKeyPress, curveKeyHandler)
    #endif
    .accessibilityIdentifier("editor-tone-curve-\(sub.id)")
  }

  // MARK: - Writes

  /// Write the active channel's curve. No `commit()` here: the plot opens
  /// the undo boundary once at gesture start, so a drag that forwards many
  /// writes still collapses to one undo entry.
  private func writeCurve(_ next: [ToneCurvePoint]) {
    state.session.model[keyPath: channel.keyPath] = ToneCurve(points: next)
  }

  /// Back to the identity — the EMPTY list, not the corner anchors, so an
  /// undone edit leaves the sidecar as clean as it found it (#365).
  private func resetChannel() {
    keyboardBridge?.resign?()
    state.commit()
    writeCurve([])
  }
}

// MARK: - ToneCurveChannelChip

/// One channel tab. Selected state gets the channel's own tint as a ring;
/// a channel carrying a non-identity curve gets a filled dot below it, the
/// same modified affordance `HSLBandChip` uses.
private struct ToneCurveChannelChip: View {
  let label: String
  let isSelected: Bool
  let isModified: Bool
  let tint: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 3) {
        Text(label)
          .font(.system(size: 10, weight: isSelected ? .semibold : .regular))
          .foregroundStyle(isSelected ? tint : ProTokens.textDim)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 3)
          .background(
            RoundedRectangle(cornerRadius: MapleTokens.Radius.sm, style: .continuous)
              .fill(isSelected ? ProTokens.accent(0x28) : Color.clear)
          )
          .overlay(
            RoundedRectangle(cornerRadius: MapleTokens.Radius.sm, style: .continuous)
              .stroke(isSelected ? tint : Color.clear, lineWidth: 0.5)
          )
        Circle()
          .fill(isModified ? tint : Color.clear)
          .frame(width: 3, height: 3)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(label) tone curve")
    .accessibilityAddTraits(isSelected ? .isSelected : [])
    .accessibilityIdentifier("editor-tone-curve-channel-\(label.lowercased())")
  }
}

// MARK: - Preview

#if DEBUG
  #Preview("ToneCurveSection") {
    let state = EditorState(session: EditSession.preview())
    return ToneCurveSection(state: state)
      .frame(width: 320)
      .padding()
      .background(ProTokens.bg)
  }
#endif
