// AboutView.swift — About sub-screen for PhoneSettingsView (responsive
// program S8, #1903). Version display extracted out of `GeneralSettingsTab`
// per docs/design/responsive-program/s8-settings.md §3, risk #2: the
// desktop "General" tab's version row becomes the phone "About" row.

import SwiftUI
import MapleCore

struct AboutView: View {
    var body: some View {
        Form {
            Section {
                LabeledContent("Version") {
                    Text(MapleCore.version())
                        .foregroundStyle(.secondary)
                }
                LabeledContent("Bundle ID") {
                    Text(Bundle.main.bundleIdentifier ?? "app.justmaple.aperture")
                        .foregroundStyle(.secondary)
                }
            }
            .listRowBackground(MapleTokens.surface)
        }
        .formStyle(.grouped)
        .mapleSettingsBackground()
    }
}

#Preview {
    NavigationStack {
        AboutView()
    }
}
