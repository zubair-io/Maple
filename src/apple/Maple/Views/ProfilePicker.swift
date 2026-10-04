// ProfilePicker.swift — two-segment Auto/Neutral picker for AdjustmentModel.profile.
//
// A third profile, AcrMatch (#1722), was never surfaced here — real-image
// validation showed the chart-fitted transform over-exposes real bodies —
// and was retired entirely in #2312.
//
// `.segmented` style so both choices are visible at rest — a menu picker
// would hide Auto behind a tap. Lives in its own file so DetailPanel.swift
// stays under the 600-line file-budget ceiling (CI gate).

import MapleCore
import SwiftUI

struct ProfilePicker: View {
  @Binding var selection: Profile
  var autoFitStatus: AutoFitStatus

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Picker("Profile", selection: $selection) {
        Text("Auto").tag(Profile.auto)
          .accessibilityLabel("Auto profile")
        Text("Neutral").tag(Profile.neutral)
          .accessibilityLabel("Neutral profile")
      }
      .labelsHidden()
      .pickerStyle(.segmented)
      .frame(maxWidth: 160)
      .accessibilityIdentifier("picker-profile")
      .accessibilityLabel("Profile selector")
      .accessibilityValue(autoFitStatus.description(profile: selection))
      Text(autoFitStatus.description(profile: selection))
        .font(.caption)
        .foregroundStyle(MapleTokens.textMuted)
        .accessibilityIdentifier("profile-auto-fit-status")
    }
  }
}
