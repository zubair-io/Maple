import MapleCore
import MapleUI
import SwiftUI

struct WhiteBalanceControls: View {
  let state: EditorState
  private var picker: WhiteBalancePicker { state.whiteBalancePicker }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        MuiButton(
          label: picker.isArmed ? "Cancel pick" : "Pick white balance",
          variant: .ghost,
          leadingIcon: "eyedropper",
          disabled: !state.session.asset.isRaw || state.session.showingOriginal
        ) {
          if picker.isArmed {
            picker.cancel()
          } else {
            state.arm(tool: .temp)
            picker.arm()
          }
        }
        .accessibilityIdentifier("editor-wb-eyedropper")
        Spacer(minLength: 0)
        if state.session.asShotCCT != nil, state.session.asShotTint != nil {
          MuiButton(label: "As Shot", variant: .ghost) { picker.resetToAsShot() }
            .accessibilityLabel("Reset white balance to as-shot")
            .accessibilityIdentifier("editor-as-shot-wb")
        }
      }
      Text(picker.provenance)
        .font(.caption2)
        .foregroundStyle(MapleTokens.textMuted)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("editor-wb-provenance")
      if !state.session.asset.isRaw {
        Text("The eyedropper requires a RAW photo.")
          .font(.caption2)
          .foregroundStyle(MapleTokens.textMuted)
      }
    }
  }
}
