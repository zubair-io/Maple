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
// Two families, matching `docs/maple-paper.md` § 3 and the two shapes
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

    private static let channels: [Channel] = [
        Channel(id: "luma", label: "Luma", keyPath: \.toneCurveLuma, stroke: ProTokens.accent),
        Channel(id: "r", label: "R", keyPath: \.toneCurveRed, stroke: ProTokens.curveRed),
        Channel(id: "g", label: "G", keyPath: \.toneCurveGreen, stroke: ProTokens.curveGreen),
        Channel(id: "b", label: "B", keyPath: \.toneCurveBlue, stroke: ProTokens.curveBlue),
    ]

    /// Which channel the plot edits. Local view state: it is a lens onto the
    /// model, not a value stored in it, so it deliberately does NOT persist to
    /// the sidecar.
    @State private var selectedChannelID = "luma"

    private var channel: Channel {
        Self.channels.first { $0.id == selectedChannelID } ?? Self.channels[0]
    }

    private var points: [ToneCurvePoint] {
        state.session.model[keyPath: channel.keyPath].points
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            channelRow
            ToneCurvePlot(
                points: points,
                stroke: channel.stroke,
                channelName: channel.label,
                session: state.session,
                onChange: writeCurve,
                onCommit: { state.commit() }
            )
            regionSliders
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor-tone-curve-section")
    }

    // MARK: - Channel selector

    private var channelRow: some View {
        HStack(spacing: 4) {
            ForEach(Self.channels) { ch in
                ToneCurveChannelChip(
                    label: ch.label,
                    isSelected: ch.id == selectedChannelID,
                    isModified: !state.session.model[keyPath: ch.keyPath].isIdentity,
                    tint: ch.stroke,
                    action: { selectedChannelID = ch.id }
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
            onCommit: { state.commit() }
        )
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
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(isSelected ? ProTokens.accent(0x28) : Color.clear)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
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
