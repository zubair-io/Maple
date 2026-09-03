// VectorscopeHud.swift — canvas-corner skin-tone vectorscope HUD (#3277,
// spec §3.1, §4). Same slot/treatment as GpuFrameTimeHud: mounted top-
// trailing over the canvas by EditorView+Canvas.swift's `vectorscopeHud`,
// toggled by the pill's "Scope" button (PillHeader.swift).
//
// Arms `session.scopeEnabled` on appear / disarms on disappear — the GPU-live
// present (EditSession+GpuLive.swift) and the CPU fallback
// (EditSession+ScopeCpu.swift) both gate their work on that flag, so the HUD
// showing is what turns the producer on, not a separate switch.

import SwiftUI
import MapleCore
import MapleUI

struct VectorscopeHud: View {
    @Bindable var state: EditorState
    @AppStorage("editor.showSkinToneLine") private var showSkinToneLine = false
    @AppStorage("editor.redAt3OClock") private var redAt3OClock = false

    private var selectedMaskName: String? {
        guard let id = state.session.selectedMaskId,
              let layer = state.session.model.localAdjustments.first(where: { $0.id == id })
        else { return nil }
        switch layer.mask {
        case .bitmap, .everywhere: return "Skin"
        case .linear: return "Gradient"
        case .radial: return "Radial"
        }
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if let name = selectedMaskName {
                Text("Scope: \(name)")
                    .font(.system(size: 9, weight: .regular, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.55))
            }
            MuiVectorscope(
                samples: [],
                size: 96,
                bins: state.session.scopeSample?.bins,
                showSkinToneLine: showSkinToneLine,
                redAt3OClock: redAt3OClock
            )
            .contextMenu {
                Toggle("Show skin tone line", isOn: $showSkinToneLine)
                Toggle("Red at 3 o'clock", isOn: $redAt3OClock)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(.black.opacity(0.62), in: RoundedRectangle(cornerRadius: MapleTokens.Radius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: MapleTokens.Radius.sm)
                .strokeBorder(Color.white.opacity(0.2), lineWidth: 1)
        )
        .padding(.trailing, 12)
        .accessibilityIdentifier("editor-vectorscope-hud")
        .accessibilityLabel("Skin tone vectorscope")
        .accessibilityValue(state.session.scopeSample != nil ? "has data" : "no data")
        .onAppear { state.session.scopeEnabled = true }
        .onDisappear { state.session.scopeEnabled = false }
    }
}
