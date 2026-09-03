// CropToolbar.swift — controls for the crop tool (#638).
//
// Shown in the editor's control stack IN PLACE OF the drag bar while the
// Crop pill is armed: aspect-ratio preset chips, a straighten slider
// (±45°), and Reset / Done. The interactive crop rectangle itself lives in
// `CropOverlay` over the canvas; this is the value/affordance strip beside
// it. Mirrors the web `CropToolbarComponent`.

import SwiftUI
import MapleCore

struct CropToolbar: View {
    @Bindable var state: EditorState

    /// Straighten range in degrees (matches the reference renderer's ±45
    /// band).
    private let straightenMin: Double = -45
    private let straightenMax: Double = 45

    /// Snapshot the model for undo at the start of a straighten drag.
    @State private var straightenEditing = false

    var body: some View {
        VStack(spacing: 8) {
            aspectChips
            HStack(spacing: 12) {
                straightenSlider
                resetButton
                doneButton
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .background(MapleTokens.bg)
        .accessibilityIdentifier("editor-crop-toolbar")
    }

    // MARK: - Aspect presets

    private var aspectChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(CropAspect.presets) { preset in
                    aspectChip(preset)
                }
            }
            .padding(.horizontal, 2)
        }
        .accessibilityIdentifier("editor-crop-aspect-row")
    }

    private func aspectChip(_ preset: CropAspectPreset) -> some View {
        let selected = state.cropAspectId == preset.id
        return Button {
            selectAspect(preset.id)
        } label: {
            Text(preset.label)
                .font(.system(size: 12, weight: selected ? .semibold : .regular))
                .foregroundStyle(selected ? MapleTokens.primary : MapleTokens.textMain)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: MapleTokens.Radius.sm)
                        .fill(selected ? MapleTokens.primary.opacity(0.15) : MapleTokens.surfaceAlt)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: MapleTokens.Radius.sm)
                        .stroke(selected ? MapleTokens.primary : MapleTokens.border, lineWidth: 0.5)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Aspect \(preset.label)")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("editor-crop-aspect-\(preset.id.rawValue)")
    }

    /// Select an aspect-ratio preset. `.free` only unlocks; a fixed ratio
    /// snaps the crop to a centered rect of that ratio (preserving the
    /// angle). Mirrors the web `selectAspect`.
    private func selectAspect(_ id: CropAspectId) {
        state.setCropAspect(id)
        guard id != .free else { return }
        let native = state.session.nativeImageSize
        let imgW = native.width > 0 ? Double(native.width) : 1
        let imgH = native.height > 0 ? Double(native.height) : 1
        guard let ratio = CropAspect.resolveAspect(
            state.cropAspectPreset, imgW: imgW, imgH: imgH
        ) else { return }
        state.commit(kind: .crop, description: "Crop aspect")
        let angle = state.session.model.crop.angle
        state.session.model.crop = CropGeometry.centeredCropForAspect(ratio, imgW, imgH, angle)
        state.session.endEdit()
    }

    // MARK: - Straighten

    private var straightenSlider: some View {
        let binding = Binding<Double>(
            get: { state.session.model.crop.angle },
            set: { newValue in
                if !straightenEditing {
                    straightenEditing = true
                    // One transaction per drag (#2432): opened here, closed
                    // by `onEditingChanged(false)` below.
                    state.commit(kind: .crop, description: "Straighten")
                }
                var crop = state.session.model.crop
                crop.angle = min(max(newValue, straightenMin), straightenMax)
                state.session.model.crop = crop
            }
        )
        return HStack(spacing: 8) {
            Image(systemName: "angle")
                .font(.system(size: 12))
                .foregroundStyle(MapleTokens.textMuted)
            Slider(
                value: binding,
                in: straightenMin...straightenMax,
                onEditingChanged: { editing in
                    if !editing {
                        straightenEditing = false
                        state.session.endEdit()
                    }
                }
            )
            .accessibilityLabel("Straighten")
            .accessibilityValue(Text(angleLabel))
            .accessibilityIdentifier("editor-crop-straighten")
            Text(angleLabel)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(MapleTokens.textMuted)
                .monospacedDigit()
                .frame(width: 44, alignment: .trailing)
        }
        .frame(maxWidth: .infinity)
    }

    private var angleLabel: String {
        String(format: "%.1f°", state.session.model.crop.angle)
    }

    // MARK: - Reset / Done

    private var resetButton: some View {
        Button {
            reset()
        } label: {
            Text("Reset")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(canReset ? MapleTokens.textMain : MapleTokens.textMuted)
        }
        .buttonStyle(.plain)
        .disabled(!canReset)
        .accessibilityLabel("Reset crop")
        .accessibilityIdentifier("editor-crop-reset")
    }

    private var doneButton: some View {
        Button {
            // Exit crop — re-arm Exposure so the canvas renders the cropped
            // result. Matches the web `done()`.
            state.arm(tool: .exposure)
        } label: {
            Text("Done")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(MapleTokens.primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Done cropping")
        .accessibilityIdentifier("editor-crop-done")
    }

    private var canReset: Bool {
        !state.session.model.crop.isIdentity
    }

    private func reset() {
        guard canReset else { return }
        state.commit(kind: .crop, description: "Reset crop")
        state.session.model.crop = .identity
        state.setCropAspect(.free)
        state.session.endEdit()
    }
}
