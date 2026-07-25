// HSLSection.swift — 8-band hue / saturation / luminance panel (#274).
//
// Replaces the group's living-slider stack while the HSL tool is armed,
// exactly as `CropToolbar` does for Crop. HSL has no single primary
// drag-bar field (24 sub-params, `ToolValueMapping.displayRange` is nil
// for it), so this section IS its control surface:
//
//   ┌────────────────────────────────────────────────┐
//   │  ● ● ● ● ● ● ● ●        Red                    │  ← band chips + name
//   │  Hue          ──────●──────────────      +12   │
//   │  Saturation   ────────●────────────       +4   │
//   │  Luminance    ──────●──────────────        0   │
//   └────────────────────────────────────────────────┘
//
// The band list, the labels and the 24 key paths come from
// `HSLBand.all` / `HSLChannel` in MapleCore, which in turn take their
// band ORDER from raw-core's `HUE_CENTERS_DEG` — the same table the
// Oklab stage and the WGSL kernel use, so the chips can't drift from the
// pipeline's notion of which band is which.
//
// Every edit routes through `EditorState`'s sub-param value pipe
// (`arm(subParamId:)` + `setArmedDisplayValue`), the same path the drag
// bar and wheel nudge use — so the value HUD, undo boundaries and the
// per-sub-param modified dots all follow a slider drag here.

import SwiftUI
import MapleCore

// MARK: - HSLSection

struct HSLSection: View {
    @Bindable var state: EditorState

    /// The band whose three sliders are shown. Derived from the armed
    /// sub-param so it survives an image switch through
    /// `ToolSubParamMemory` and stays in sync with the value HUD.
    private var selectedBand: HSLBand {
        let armed = state.armedSubParamId
        let match = HSLBand.all.first { band in
            HSLChannel.allCases.contains { channel in
                Tool.hslSubParamId(channel: channel, band: band) == armed
            }
        }
        return match ?? HSLBand.all[0]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            bandChips
            VStack(spacing: 10) {
                ForEach(HSLChannel.allCases, id: \.self) { channel in
                    channelSlider(channel, band: selectedBand)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor-hsl-section")
    }

    // MARK: - Band chips

    private var bandChips: some View {
        HStack(spacing: 6) {
            ForEach(HSLBand.all) { band in
                HSLBandChip(
                    band: band,
                    isSelected: band.id == selectedBand.id,
                    isModified: isModified(band),
                    action: { select(band) }
                )
            }
            Spacer(minLength: 6)
            Text(selectedBand.label.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(MapleTokens.textMuted)
                .lineLimit(1)
        }
        .accessibilityIdentifier("editor-hsl-bands")
    }

    /// Arm the picked band, keeping the currently-armed channel so
    /// stepping across bands compares like with like.
    private func select(_ band: HSLBand) {
        state.arm(subParamId: Tool.hslSubParamId(channel: armedChannel, band: band))
    }

    /// The channel the armed sub-param belongs to; Hue when nothing in
    /// this tool is armed yet.
    private var armedChannel: HSLChannel {
        let armed = state.armedSubParamId
        let match = HSLChannel.allCases.first { channel in
            HSLBand.all.contains { Tool.hslSubParamId(channel: channel, band: $0) == armed }
        }
        return match ?? .hue
    }

    /// True when any of the band's three fields is off its 0 default —
    /// drives the chip's modified ring.
    private func isModified(_ band: HSLBand) -> Bool {
        HSLChannel.allCases.contains { channel in
            abs(state.session.model[keyPath: channel.keyPath(for: band)]) > 1e-6
        }
    }

    // MARK: - Per-channel slider

    private func channelSlider(_ channel: HSLChannel, band: HSLBand) -> some View {
        let keyPath = channel.keyPath(for: band)
        let subParamId = Tool.hslSubParamId(channel: channel, band: band)
        return LivingSlider(
            label: channel.displayName,
            value: Binding(
                get: { state.session.model[keyPath: keyPath] },
                set: { newValue in
                    // Arm before writing so the HUD, the undo burst and
                    // `resetArmedTool` all target THIS (band, channel).
                    if state.armedTool != .hsl { state.arm(tool: .hsl) }
                    if state.armedSubParamId != subParamId {
                        state.arm(subParamId: subParamId)
                    }
                    state.setArmedDisplayValue(newValue)
                }
            ),
            range: channel.range(for: band),
            isBipolar: true,
            defaultValue: 0,
            gradient: GradientCatalog.stops(for: .hsl, subParamId: subParamId),
            onCommit: { state.commit() }
        )
        .accessibilityIdentifier("editor-hsl-\(subParamId)")
    }
}

// MARK: - HSLBandChip

/// One circular band swatch. Selected state gets an accent ring; a band
/// with any non-default field gets a filled dot below it.
private struct HSLBandChip: View {
    let band: HSLBand
    let isSelected: Bool
    let isModified: Bool
    let action: () -> Void

    private var swatchColor: Color {
        Color(
            red: Double((band.swatch >> 16) & 0xFF) / 255,
            green: Double((band.swatch >> 8) & 0xFF) / 255,
            blue: Double(band.swatch & 0xFF) / 255
        )
    }

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Circle()
                    .fill(swatchColor)
                    .frame(width: 18, height: 18)
                    .overlay(
                        Circle().stroke(
                            isSelected ? MapleTokens.primary : MapleTokens.border,
                            lineWidth: isSelected ? 2 : 0.5
                        )
                    )
                Circle()
                    .fill(isModified ? MapleTokens.primary : Color.clear)
                    .frame(width: 3, height: 3)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(band.label)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("editor-hsl-band-\(band.id)")
    }
}

// MARK: - Preview

#if DEBUG
#Preview("HSLSection") {
    let state = EditorState(session: EditSession.preview())
    return HSLSection(state: state)
        .frame(width: 320)
        .padding()
        .background(MapleTokens.bg)
}
#endif
