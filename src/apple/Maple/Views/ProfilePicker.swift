// ProfilePicker.swift — segmented Auto/Neutral/Match picker for AdjustmentModel.profile.
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
            Text("Match").tag(Profile.acrMatch)
                .accessibilityLabel("Match profile")
        }
        .labelsHidden()
        .pickerStyle(.segmented)
        .accessibilityIdentifier("picker-profile")
        .accessibilityLabel("Profile selector")
    }
}
