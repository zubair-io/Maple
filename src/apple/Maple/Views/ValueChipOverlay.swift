// ValueChipOverlay.swift — responsive-program S5a (#625).
//
// Pill that floats top-center, 14pt above the canvas. Sticky-glass
// background (`rgba(15,13,11,0.6)` + 6pt blur). Contents (per spec §2):
//     LIGHT │ EXPOSURE  +0.25 EV
//   group   │ tool       signed value, tabular nums
// Always rendered — even at value 0. While a multi-param tool is armed
// (#1108, spec §10.0) a third eyebrow names the armed sub-param:
//     DETAIL │ SHARPEN │ RADIUS  1.0
//
// Display formatting per ToolValueMapping rules (EV for exposure, K for
// temp, integer otherwise); sub-params carry their own format.
//
// Spec: docs/design/responsive-program/s5-editor.md §2.

import SwiftUI
import MapleCore

struct ValueChipOverlay: View {
    @Bindable var state: EditorState

    private var formattedValue: String {
        let v = state.armedDisplayValue
        // Sub-params (#1108) format per descriptor: decimals; unsigned
        // for one-sided ranges (spec §10.0 "FEATHER · 35", "RADIUS · 1.0").
        if let sub = state.armedSubParam {
            return sub.format(v)
        }
        switch state.armedTool {
        case .exposure:
            return String(format: "%+0.2f EV", v)
        case .temp:
            return "\(Int(v.rounded())) K"
        case .captureSigma:
            // 0.5..2.0 px sub-integer band — integer rounding would
            // collapse it to "1"/"2", so show two decimals + a px unit.
            return String(format: "%.2f px", v)
        default:
            return String(format: "%+d", Int(v.rounded()))
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            if state.session.isResolvingFirstFrame {
                // Cold-open state — the chain hasn't published a frame yet, so the
                // slider value is stale (still on the previous asset's last value,
                // or `.default` for a fresh session). Show LOADING in place of the
                // group/tool/value triplet so the chip doesn't claim "+0.00 EV" on
                // an image that hasn't rendered yet.
                ProgressView()
                    .controlSize(.mini)
                    .tint(MapleTokens.textMuted)
                Text("LOADING")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(MapleTokens.textMuted)
                    .accessibilityIdentifier("editor-value-chip-loading")
            } else {
                Text(state.armedGroup.displayName.uppercased())
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(MapleTokens.textMuted)
                chipDivider
                Text(state.armedTool.displayName.uppercased())
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(MapleTokens.textMuted)
                if let sub = state.armedSubParam {
                    chipDivider
                    Text(sub.label.uppercased())
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundStyle(MapleTokens.textMuted)
                        .accessibilityIdentifier("editor-value-chip-subparam")
                }
                Text(formattedValue)
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .monospacedDigit()
                    .foregroundStyle(MapleTokens.primary)
                // Render-path indicator — surfaces whether the canvas is being
                // driven by the wgpu live chain (`GPU`) or the CPU
                // `processSceneLinear` + Metal fallback (`CPU`). `gpuFramePresented`
                // latches the first successful GPU present; until then the only
                // image on screen is the CPU `renderedPreview` (or the embedded-
                // JPEG seed). Useful for triaging slider responsiveness on iPad
                // (#1240 follow-up — iOS-device GPU correctness is still gated by
                // #1028-A4 / #992, so the chip naming the active path is the
                // fastest in-app signal of which chain rendered the frame).
                chipDivider
                Text(state.session.gpuFramePresented ? "GPU" : "CPU")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(MapleTokens.textMuted)
                    .accessibilityIdentifier("editor-value-chip-render-path")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            Color.black.opacity(0.6),
            in: Capsule()
        )
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("editor-value-chip")
    }

    private var chipDivider: some View {
        Rectangle()
            .fill(MapleTokens.textMuted.opacity(0.4))
            .frame(width: 1, height: 10)
    }
}
