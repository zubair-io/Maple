import MapleCore
import MapleUI
import SwiftUI

struct WhiteBalanceControls: View {
  let state: EditorState
  private var picker: WhiteBalancePicker { state.whiteBalancePicker }
  @State private var presetTask: Task<Void, Never>?

  private var presetSelection: Binding<WhiteBalancePreset> {
    Binding(
      get: { picker.selectedPreset },
      set: { preset in
        presetTask?.cancel()
        let editor = state
        presetTask = Task { @MainActor in await editor.applyWhiteBalancePreset(preset) }
      })
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        Picker("White balance", selection: presetSelection) {
          ForEach(WhiteBalancePreset.allCases, id: \.self) { preset in
            Text(preset.rawValue).tag(preset)
              .disabled(
                (preset == .auto && !state.session.asset.isRaw)
                  || (preset == .asShot
                    && (state.session.asShotCCT == nil || state.session.asShotTint == nil))
              )
          }
        }
        .pickerStyle(.menu)
        .frame(minHeight: 34)
        .disabled(state.autoInProgress || state.session.showingOriginal)
        .accessibilityIdentifier("editor-wb-preset")

        Spacer(minLength: 4)

        MuiButton(
          label: picker.isArmed ? "Cancel pick" : "Pick WB",
          variant: .ghost,
          leadingIcon: "eyedropper",
          disabled: !state.session.asset.isRaw || state.session.showingOriginal
            || state.autoInProgress
        ) {
          if picker.isArmed {
            picker.cancel()
          } else {
            state.arm(tool: .temp)
            picker.arm()
          }
        }
        .accessibilityLabel(picker.isArmed ? "Cancel pick" : "Pick white balance")
        .accessibilityIdentifier("editor-wb-eyedropper")

        if state.session.asShotCCT != nil, state.session.asShotTint != nil {
          MuiButton(label: "As Shot", variant: .ghost) { picker.resetToAsShot() }
            .disabled(state.autoInProgress || state.session.showingOriginal)
            .accessibilityLabel("Reset white balance to as-shot")
            .accessibilityIdentifier("editor-as-shot-wb")
        }
      }
      Text(picker.provenance)
        .font(.caption2)
        .foregroundStyle(MapleTokens.textMuted)
        .lineLimit(1)
        .minimumScaleFactor(0.85)
        .accessibilityIdentifier("editor-wb-provenance")
      if !state.session.asset.isRaw {
        Text("The eyedropper requires a RAW photo.")
          .font(.caption2)
          .foregroundStyle(MapleTokens.textMuted)
      }
    }
    .onDisappear { presetTask?.cancel() }
    .onChange(of: ObjectIdentifier(state.session)) { _, _ in presetTask?.cancel() }
  }
}
