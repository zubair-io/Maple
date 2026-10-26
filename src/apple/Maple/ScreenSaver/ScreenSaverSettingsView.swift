// ScreenSaverSettingsView.swift — Settings → Screen Saver on iPhone and iPad
// (#5457). Both preferences are local to this device and apply immediately.

import MapleCore
import MapleUI
import SwiftUI

struct ScreenSaverSettingsView: View {
  @AppStorage(BackupScreenPreferences.keepScreenOnKey) private var keepScreenOn = true
  @AppStorage(BackupScreenPreferences.screenSaverKey) private var screenSaverEnabled = true

  var body: some View {
    Form {
      Section("During backup") {
        MuiToggle(checked: $keepScreenOn, label: "Keep screen on during backup")
          .accessibilityIdentifier("screenSaver.keepScreenOn")
        MuiText(
          "While Maple is open and photos upload, the screen stays awake so the backup keeps running. On battery, it stays awake for up to \(Self.minutes(BackupScreenPolicy.batteryAwakeLimit)) without a touch, then follows your Auto-Lock setting.",
          variant: .body, color: .muted, block: true)
        MuiToggle(
          checked: $screenSaverEnabled, label: "Light Table screen saver", disabled: !keepScreenOn
        )
        .accessibilityIdentifier("screenSaver.lightTable")
        MuiText(
          "While a backup uploads and this device is plugged in and untouched for \(Self.minutes(BackupScreenPolicy.screenSaverDelay)), photos from your library drift across the screen until you touch it.",
          variant: .body, color: .muted, block: true)
      }
      .listRowBackground(MapleTokens.surface)
    }
    .formStyle(.grouped)
    .mapleSettingsBackground()
  }

  private static func minutes(_ seconds: TimeInterval) -> String {
    Duration.seconds(seconds).formatted(.units(allowed: [.minutes], width: .wide))
  }
}

#Preview {
  NavigationStack {
    ScreenSaverSettingsView()
  }
}
