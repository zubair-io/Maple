// MaskPanel.swift — the Mask tool's control surface (#3275, spec §3.2): a
// layer list plus, for the selected layer, its seventeen sliders — the
// eleven point controls, then the six spatial ones (#3407) — and its
// colour-range controls (`MaskRangeSection`, #362). Mounted as a
// full-surface swap in both control layouts (StackedAdjustmentsPanel,
// MobileControlBar) the way ColorGrade/HSL already are, since Mask has no
// single primary field for the generic slider grid to key off.

import MapleCore
import SwiftUI

struct MaskPanel: View {
    @Bindable var state: EditorState
    @State private var showingPeoplePicker = false

    private var layers: [LocalAdjustment] { state.session.model.localAdjustments }
    private var selected: LocalAdjustment? { layers.first { $0.id == state.session.selectedMaskId } }

    var body: some View {
        VStack(spacing: 0) {
            header
            List {
                ForEach(layers) { layer in
                    MaskListRow(
                        layer: layer,
                        isSelected: layer.id == state.session.selectedMaskId,
                        isEnabled: state.session.isMaskEnabled(id: layer.id),
                        onSelect: { state.session.selectedMaskId = layer.id },
                        onToggleEnabled: { state.session.setMaskEnabled(id: layer.id, enabled: $0) },
                        onDelete: { state.session.deleteMask(id: layer.id) }
                    )
                    .listRowInsets(EdgeInsets())
                }
            }
            .listStyle(.plain)
            .frame(height: min(CGFloat(layers.count) * 44 + 8, 160))

            if let selected {
                Divider()
                sliders(for: selected)
            }
        }
        .accessibilityIdentifier("editor-mask-panel")
        .sheet(isPresented: $showingPeoplePicker) { PeoplePickerSheet(state: state) }
    }

    private var header: some View {
        HStack {
            Text("Masks").font(.system(size: 13, weight: .semibold))
            Spacer()
            Menu {
                Button("People…") { showingPeoplePicker = true }
                Button("Linear (coming in #355)") {}.disabled(true)
                Button("Radial (coming in #355)") {}.disabled(true)
            } label: {
                Image(systemName: "plus.circle")
            }
            .accessibilityIdentifier("editor-mask-add-menu")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private func sliders(for layer: LocalAdjustment) -> some View {
        VStack(spacing: 4) {
            rows(MaskSlider.pointControls, for: layer)
            // The spatial group is a separate pass in the render stage and a
            // separate block in Lightroom's own panel, so it reads as its
            // own run here rather than continuing the tone/colour list.
            Divider().padding(.vertical, 2)
            rows(MaskSlider.spatialControls, for: layer)
            // Colour range (#362): the refinement's enable toggle,
            // eyedropper and five sliders, under the adjustment sliders.
            MaskRangeSection(state: state, layerId: layer.id)
                .padding(.horizontal, 14)
                .padding(.top, 4)
        }
        .padding(.vertical, 6)
        // A disabled mask is present-but-inert (`setMaskEnabled`): its
        // sliders read as zero and any drag would write into the live
        // layer only to be overwritten by the stash on re-enable, so they
        // are not interactable until the toggle is back on (#3291 review).
        .disabled(!state.session.isMaskEnabled(id: layer.id))
        .opacity(state.session.isMaskEnabled(id: layer.id) ? 1 : 0.45)
    }

    private func rows(_ sliders: [MaskSlider], for layer: LocalAdjustment) -> some View {
        ForEach(sliders) { slider in
            MaskSliderRow(state: state, layerId: layer.id, slider: slider)
                .padding(.horizontal, 14)
        }
    }
}

/// The per-mask controls: the eleven point controls in the order spec §3.2
/// lists them, then the six spatial ones (#3407) in Lightroom's own panel
/// order. Declaration order is emission order — `pointControls` and
/// `spatialControls` split `allCases` on `isSpatial`.
enum MaskSlider: String, CaseIterable, Identifiable {
    case hue, temperature, tint, saturation, vibrance, exposure, contrast, highlights, shadows, whites, blacks
    case texture, clarity, dehaze, sharpness, luminanceNoise, defringe

    static let pointControls = allCases.filter { !$0.isSpatial }
    static let spatialControls = allCases.filter(\.isSpatial)

    var id: String { rawValue }

    /// True for the six controls that read a neighbourhood rather than a
    /// single pixel, which raw-core runs as one grouped pass after the
    /// point group (`PartialAdjustments.spatialIsEmpty`).
    var isSpatial: Bool {
        switch self {
        case .texture, .clarity, .dehaze, .sharpness, .luminanceNoise, .defringe: return true
        default: return false
        }
    }

    var label: String {
        switch self {
        // "Noise" is what Lightroom's panel calls the luminance-noise
        // control; the model field keeps the unambiguous name.
        case .luminanceNoise: return "Noise"
        default: return rawValue.prefix(1).uppercased() + rawValue.dropFirst()
        }
    }

    var range: ClosedRange<Double> {
        switch self {
        case .hue: return -100...100
        case .temperature: return -1000...1000
        case .tint: return -150...150
        // EV, like the global tool (`ToolValueMapping`) — the stage applies
        // it as `exp2(ev)`, so a ±100 range would be nonsense (#3291 review).
        case .exposure: return -4...4
        // Noise reduction and defringe are one-sided: there is no
        // "negative denoise", matching their global counterparts.
        case .luminanceNoise, .defringe: return 0...100
        default: return -100...100
        }
    }
}

/// A plain `Slider`, not `LivingSliderRow` — the per-mask sub-param does not
/// route through `EditorState`'s tool-level value pipe (`arm(subParamId:)` /
/// `setArmedDisplayValue`): that pipe is keyed on a single `WritableKeyPath
/// <AdjustmentModel, Double>` per sub-param, and a mask's controls live
/// inside an array element, not a top-level model field. `EditSession
/// .beginEdit()` (the undo push) fires once per gesture via `onEditingChanged`
/// rather than per drag sample — matching `LivingSliderRow`'s `onCommit`
/// boundary (`EditorState.commit()` → `session.beginEdit()`), just without
/// that view's `gestureActive`/`deferredDisplayValue` write-coalescing (which
/// exists to skip a full re-decode per sample for a decode-product field;
/// a mask slider write is a cheap in-memory array mutation, so every sample
/// writing straight to `session.model` costs nothing extra to skip).
private struct MaskSliderRow: View {
    @Bindable var state: EditorState
    let layerId: UUID
    let slider: MaskSlider

    private var value: Double {
        guard let layer = state.session.model.localAdjustments.first(where: { $0.id == layerId }) else { return 0 }
        return keyPath(layer.adjustments) ?? 0
    }

    private func keyPath(_ a: PartialAdjustments) -> Double? {
        switch slider {
        case .hue: return a.hue
        case .temperature: return a.temperature
        case .tint: return a.tint
        case .saturation: return a.saturation
        case .vibrance: return a.vibrance
        case .exposure: return a.exposure
        case .contrast: return a.contrast
        case .highlights: return a.highlights
        case .shadows: return a.shadows
        case .whites: return a.whites
        case .blacks: return a.blacks
        case .texture: return a.texture
        case .clarity: return a.clarity
        case .dehaze: return a.dehaze
        case .sharpness: return a.sharpness
        case .luminanceNoise: return a.luminanceNoise
        case .defringe: return a.defringe
        }
    }

    var body: some View {
        HStack {
            Text(slider.label).font(.system(size: 11)).frame(width: 90, alignment: .leading)
            Slider(
                value: Binding(
                    get: { value },
                    set: { newValue in
                        guard let idx = state.session.model.localAdjustments.firstIndex(where: { $0.id == layerId })
                        else { return }
                        setKeyPath(&state.session.model.localAdjustments[idx].adjustments, newValue)
                    }
                ),
                in: slider.range,
                // `beginEdit()` snapshots `model` onto the undo stack; its
                // own contract ("push the current model... BEFORE a user
                // gesture") and `undo()`'s mechanics (restores the popped
                // snapshot directly into `model`) both require this to fire
                // at drag START, before this row's `set` closure has
                // written anything — not at release, when `model` would
                // already hold the new value and undo would be a no-op.
                // Opens the transaction at drag start and CLOSES it at drag
                // end, and drives the overlay's hide-while-adjusting (#3364)
                // — `onEditingChanged` is the only start/end signal a plain
                // `Slider` gives, and both need both ends (#3453 review).
                onEditingChanged: { editing in state.session.setMaskDragActive(editing) }
            )
            // The row's `Text` is a sibling of the control, not its name, so
            // VoiceOver needs the label spelled out on the slider itself.
            .accessibilityLabel(slider.label)
            Text(String(format: slider == .exposure ? "%.2f" : "%.0f", value))
                .font(.system(size: 11).monospacedDigit())
                .frame(width: 36, alignment: .trailing)
        }
        .accessibilityIdentifier("editor-mask-slider-\(slider.rawValue)")
    }

    /// `nil`, not `0`, is the wire no-op: `PartialAdjustments.isEmpty` (and
    /// raw-core's `is_empty`) skip the whole mask evaluation for a layer
    /// with nothing set, so a slider dragged back to zero must clear the
    /// field rather than store a zero (#3291 review).
    private func setKeyPath(_ a: inout PartialAdjustments, _ raw: Double) {
        let v: Double? = raw == 0 ? nil : raw
        switch slider {
        case .hue: a.hue = v
        case .temperature: a.temperature = v
        case .tint: a.tint = v
        case .saturation: a.saturation = v
        case .vibrance: a.vibrance = v
        case .exposure: a.exposure = v
        case .contrast: a.contrast = v
        case .highlights: a.highlights = v
        case .shadows: a.shadows = v
        case .whites: a.whites = v
        case .blacks: a.blacks = v
        case .texture: a.texture = v
        case .clarity: a.clarity = v
        case .dehaze: a.dehaze = v
        case .sharpness: a.sharpness = v
        case .luminanceNoise: a.luminanceNoise = v
        case .defringe: a.defringe = v
        }
    }
}
