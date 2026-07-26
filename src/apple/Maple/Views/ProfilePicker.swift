// ProfilePicker.swift — two-segment Auto/Neutral picker for AdjustmentModel.profile.
//
// A third profile, AcrMatch (#1722), was never surfaced here — real-image
// validation showed the chart-fitted transform over-exposes real bodies —
// and was retired entirely in #2312.
//
// `.segmented` style so both choices are visible at rest — a menu picker
// would hide Auto behind a tap. Lives in its own file so DetailPanel.swift
// stays under the 600-line file-budget ceiling (CI gate).

import SwiftUI
import MapleCore

struct ProfilePicker: View {
    @Binding var selection: Profile

    var body: some View {
        Picker("Profile", selection: $selection) {
            Text("Auto").tag(Profile.auto)
                .accessibilityLabel("Auto profile")
            Text("Neutral").tag(Profile.neutral)
                .accessibilityLabel("Neutral profile")
        }
        .labelsHidden()
        .pickerStyle(.segmented)
        .accessibilityIdentifier("picker-profile")
        .accessibilityLabel("Profile selector")
    }
}
