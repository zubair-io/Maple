// MaskSection.swift — Mask tool surface (#355, slice 3 of #280).
//
// Replaces the group's living-slider stack while the Mask tool is armed —
// the same swap-in-a-custom-surface pattern `FilmSection` (#2683),
// `ToneCurveSection` (#367) and `HSLSection` (#274) use, for the same
// structural reason: a layer stack is a list, not a scalar, so
// `ToolValueMapping.displayRange` is nil for `.mask` and this section IS its
// control surface. The canvas half (handles + weight tint) is `MaskOverlay`.
//
//   ┌────────────────────────────────────────────────┐
//   │  [+ Linear]  [+ Radial]                        │  ← add row
//   ├────────────────────────────────────────────────┤
//   │  ▸ Linear 1                              🗑    │  ← one row per layer,
//   │    Radial 2                              🗑    │     active = selected
//   ├────────────────────────────────────────────────┤
//   │  Feather      ──────●─────────────      0.50   │  ← selected layer:
//   │  Invert                                 (◯)    │     shape controls
//   │  Exposure     ──────●─────────────     +0.00   │     + the ten local
//   │  …                                             │     controls
//   │                                   [Reset]      │
//   └────────────────────────────────────────────────┘
//
// Composed from the Maple UI design system (`MuiButton`, `MuiListRow`,
// `MuiLivingSlider`, `MuiToggle`, `MuiText`) per
// `docs/unified-component-catalog.md`. Continuous edits (sliders) ride
// `EditorState`'s mask gesture — one undo entry per drag, closed on release
// through the slider's `onCommit`; discrete ones (add / remove / invert /
// reset) commit their own.

import MapleCore
import MapleUI
import SwiftUI

struct MaskSection: View {
    @Bindable var state: EditorState

    /// The ten local controls with the ranges their global twins use.
    private struct Control: Identifiable {
        let id: String
        let label: String
        let field: WritableKeyPath<PartialAdjustments, Double?>
        let range: ClosedRange<Double>
        let step: Double
    }

    private static let controls: [Control] = [
        Control(id: "exposure", label: "Exposure", field: \.exposure, range: -4...4, step: 0.05),
        Control(id: "contrast", label: "Contrast", field: \.contrast, range: -100...100, step: 1),
        Control(id: "highlights", label: "Highlights", field: \.highlights, range: -100...100, step: 1),
        Control(id: "shadows", label: "Shadows", field: \.shadows, range: -100...100, step: 1),
        Control(id: "whites", label: "Whites", field: \.whites, range: -100...100, step: 1),
        Control(id: "blacks", label: "Blacks", field: \.blacks, range: -100...100, step: 1),
        Control(id: "saturation", label: "Saturation", field: \.saturation, range: -100...100, step: 1),
        Control(id: "vibrance", label: "Vibrance", field: \.vibrance, range: -100...100, step: 1),
        // Local temperature is a Kelvin DELTA off the frame's white point
        // (raw-core `local_adjustments::apply_pixel`), not the absolute CCT
        // the global slider carries.
        Control(id: "temperature", label: "Temp", field: \.temperature, range: -2000...2000, step: 10),
        Control(id: "tint", label: "Tint", field: \.tint, range: -150...150, step: 1),
    ]

    private var layers: [LocalAdjustment] { state.session.model.localAdjustments }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            addRow
            if layers.isEmpty {
                MuiText("No masks yet — add a linear or radial mask to edit part of the image.",
                        variant: .body, color: .muted)
                    .accessibilityIdentifier("editor-mask-empty")
            } else {
                layerList
            }
            if let selected = state.selectedMask {
                MuiDivider()
                shapeControls(selected)
                adjustmentSliders
                footerRow
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor-mask-section")
    }

    // MARK: - Add

    private var addRow: some View {
        HStack(spacing: 8) {
            MuiButton(label: "Linear", variant: .secondary, size: .sm, leadingIcon: "plus") {
                state.addLinearMask()
            }
            .accessibilityLabel("Add linear mask")
            .accessibilityIdentifier("editor-mask-add-linear")
            MuiButton(label: "Radial", variant: .secondary, size: .sm, leadingIcon: "plus") {
                state.addRadialMask()
            }
            .accessibilityLabel("Add radial mask")
            .accessibilityIdentifier("editor-mask-add-radial")
            Spacer(minLength: 0)
        }
    }

    // MARK: - Layer list

    private var layerList: some View {
        VStack(spacing: 2) {
            ForEach(Array(layers.enumerated()), id: \.offset) { index, layer in
                MuiListRow(
                    icon: Self.icon(for: layer.mask),
                    label: Self.title(for: layer.mask, index: index),
                    subtitle: Self.subtitle(for: layer),
                    active: state.selectedMaskIndex == index,
                    pressed: { state.selectMask(index) }
                ) {
                    MuiButton(label: "Delete", variant: .ghost, size: .sm, leadingIcon: "trash", iconOnly: true) {
                        state.removeMask(at: index)
                    }
                    .accessibilityLabel("Delete \(Self.title(for: layer.mask, index: index))")
                    .accessibilityIdentifier("editor-mask-delete-\(index)")
                }
                .accessibilityLabel(Self.title(for: layer.mask, index: index))
                .accessibilityAddTraits(state.selectedMaskIndex == index ? .isSelected : [])
                .accessibilityIdentifier("editor-mask-row-\(index)")
            }
        }
        .accessibilityIdentifier("editor-mask-list")
    }

    // MARK: - Shape controls

    @ViewBuilder
    private func shapeControls(_ layer: LocalAdjustment) -> some View {
        MuiLivingSlider(
            label: "Feather",
            value: Binding(
                get: { Self.feather(of: layer.mask) },
                set: { state.setSelectedMaskFeather($0) }),
            range: 0...1, step: 0.01,
            onCommit: { state.endMaskGesture() })
            .accessibilityIdentifier("editor-mask-feather")
        if case .radial(_, _, _, _, let invert) = layer.mask {
            MuiToggle(
                checked: Binding(get: { invert }, set: { state.setSelectedMaskInverted($0) }),
                label: "Invert")
                .accessibilityIdentifier("editor-mask-invert")
        }
    }

    // MARK: - Adjustment sliders

    private var adjustmentSliders: some View {
        VStack(spacing: 8) {
            ForEach(Self.controls) { control in
                MuiLivingSlider(
                    label: control.label,
                    value: Binding(
                        get: { state.maskAdjustment(control.field) },
                        set: { state.setMaskAdjustment(control.field, $0) }),
                    range: control.range,
                    step: control.step,
                    bipolar: true,
                    onCommit: { state.endMaskGesture() })
                    .accessibilityIdentifier("editor-mask-slider-\(control.id)")
            }
        }
    }

    private var footerRow: some View {
        HStack {
            Spacer(minLength: 0)
            MuiButton(label: "Reset", variant: .ghost, size: .sm, leadingIcon: "arrow.counterclockwise") {
                state.resetSelectedMaskAdjustments()
            }
            .accessibilityLabel("Reset mask adjustments")
            .accessibilityIdentifier("editor-mask-reset")
        }
    }

    // MARK: - Labels

    private static func icon(for mask: LocalMask) -> String {
        switch mask {
        case .linear: return "line.diagonal"
        case .radial: return "circle.dashed"
        }
    }

    private static func title(for mask: LocalMask, index: Int) -> String {
        switch mask {
        case .linear: return "Linear \(index + 1)"
        case .radial: return "Radial \(index + 1)"
        }
    }

    private static func subtitle(for layer: LocalAdjustment) -> String? {
        let set = controls.filter { layer.adjustments[keyPath: $0.field] != nil }.count
        let shape: String? = {
            if case .radial(_, _, _, _, true) = layer.mask { return "inverted" }
            return nil
        }()
        let edits = set == 0 ? nil : "\(set) edited"
        let parts = [shape, edits].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func feather(of mask: LocalMask) -> Double {
        switch mask {
        case .linear(_, _, let feather): return feather
        case .radial(_, _, _, let feather, _): return feather
        }
    }
}
