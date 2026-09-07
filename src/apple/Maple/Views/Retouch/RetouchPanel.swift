// RetouchPanel.swift — the Heal tool's control surface (#3409): the brush
// (Heal/Clone, size, feather, opacity) plus the image's spot list. Mounted
// as a full-surface swap in both control layouts (StackedAdjustmentsPanel,
// MobileControlBar) the way MaskPanel is, since Heal has no single primary
// field for the generic slider grid to key off.
//
// The brush controls are session-level: they seed the next spot AND rewrite
// the selected one, so the panel reads as a brush rather than a per-spot
// form. The canvas half — discs and the source link — is `RetouchOverlay`.

import MapleCore
import SwiftUI

struct RetouchPanel: View {
    @Bindable var state: EditorState

    /// Brush size in fractions of the image width — 0.2 % to 20 %, the range
    /// a dust spot through a whole distraction occupies.
    private static let radiusRange: ClosedRange<Double> = 0.002...0.2

    private var retouch: RetouchSession { state.retouch }

    var body: some View {
        VStack(spacing: 0) {
            header
            brushControls
            if retouch.spots.isEmpty {
                Text("No repair spots yet — tap the image to cover a blemish with pixels from somewhere else.")
                    .font(.system(size: 12))
                    .foregroundStyle(ProTokens.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .accessibilityIdentifier("editor-retouch-empty")
            } else {
                Divider()
                spotList
            }
        }
        .accessibilityIdentifier("editor-retouch-panel")
    }

    private var header: some View {
        HStack {
            Text("Heal").font(.system(size: 13, weight: .semibold))
            Spacer()
            Button("Reset") { retouch.resetAll() }
                .disabled(retouch.spots.isEmpty)
                .accessibilityLabel("Remove every repair spot")
                .accessibilityIdentifier("editor-retouch-reset")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private var brushControls: some View {
        VStack(spacing: 4) {
            Picker(
                "Repair mode",
                selection: Binding(
                    get: { retouch.brushKind },
                    set: { retouch.setKind($0) })
            ) {
                Text("Heal").tag(RetouchKind.heal)
                Text("Clone").tag(RetouchKind.clone)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityIdentifier("editor-retouch-mode")

            RetouchSliderRow(
                label: "Size", value: retouch.brushRadius, range: Self.radiusRange,
                onChange: { retouch.setRadius($0) },
                onEditingChanged: { editing in
                    if editing { retouch.beginGesture() } else { retouch.endGesture() }
                })
            RetouchSliderRow(
                label: "Feather", value: retouch.brushFeather, range: 0...1,
                onChange: { retouch.setFeather($0) },
                onEditingChanged: { editing in
                    if editing { retouch.beginGesture() } else { retouch.endGesture() }
                })
            RetouchSliderRow(
                label: "Opacity", value: retouch.brushOpacity, range: 0...1,
                onChange: { retouch.setOpacity($0) },
                onEditingChanged: { editing in
                    if editing { retouch.beginGesture() } else { retouch.endGesture() }
                })
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }

    /// A `LazyVStack`, not a `List` (#3409 review): every surface that mounts
    /// this panel — the iPhone control bar's measured `ScrollView`, the
    /// inspector's own scroll view — already scrolls, and a `List` inside a
    /// scroll view needs an explicit height, fights the outer scroller for
    /// the drag gesture, and clips its own rows. Losing `List` also loses
    /// `.swipeActions`, which is the point: delete is an explicit button per
    /// row now, so it is discoverable, hit-testable on macOS, and reachable
    /// by VoiceOver and the keyboard rather than hidden behind a swipe.
    private var spotList: some View {
        LazyVStack(spacing: 0) {
            ForEach(Array(retouch.spots.enumerated()), id: \.element.id) { index, spot in
                RetouchListRow(
                    spot: spot,
                    index: index,
                    isSelected: spot.id == retouch.selectedSpotID,
                    onSelect: { retouch.select(spot.id) },
                    onDelete: { retouch.delete(spot.id) })
            }
        }
    }
}

/// A plain `Slider`, not `LivingSliderRow` — the same reason `MaskSliderRow`
/// is one: the tool-level value pipe is keyed on a single
/// `WritableKeyPath<AdjustmentModel, Double>`, and a brush control writes
/// into an array element (and a session default) instead. The undo push
/// fires once per gesture via `onEditingChanged`, matching
/// `LivingSliderRow`'s own commit boundary.
private struct RetouchSliderRow: View {
    let label: String
    let value: Double
    let range: ClosedRange<Double>
    let onChange: (Double) -> Void
    let onEditingChanged: (Bool) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(ProTokens.textMuted)
                .frame(width: 56, alignment: .leading)
            Slider(
                value: Binding(get: { value }, set: onChange),
                in: range,
                onEditingChanged: onEditingChanged)
        }
        .accessibilityIdentifier("editor-retouch-\(label.lowercased())")
    }
}

/// One row in the Heal panel's spot list.
private struct RetouchListRow: View {
    let spot: RetouchSpot
    let index: Int
    let isSelected: Bool
    let onSelect: () -> Void
    let onDelete: () -> Void

    private var name: String {
        "\(spot.kind == .clone ? "Clone" : "Heal") \(index + 1)"
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "bandage").frame(width: 20)
            Text(name).font(.system(size: 13))
            Spacer()
            Text("\(Int((spot.opacity * 100).rounded()))%")
                .font(.system(size: 11))
                .foregroundStyle(ProTokens.textMuted)
            Button(action: onDelete) {
                Image(systemName: "trash")
                    .font(.system(size: 12))
                    .foregroundStyle(ProTokens.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Delete \(name)")
            .accessibilityIdentifier("editor-retouch-delete-\(spot.id.uuidString)")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(isSelected ? MapleTokens.surfaceAlt : .clear)
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .accessibilityIdentifier("editor-retouch-row-\(spot.id.uuidString)")
    }
}
