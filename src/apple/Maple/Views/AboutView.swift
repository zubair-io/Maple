// AboutView.swift — About sub-screen for PhoneSettingsView (responsive
// program S8, #1903). Version display extracted out of `GeneralSettingsTab`
// per docs/design/responsive-program/s8-settings.md §3, risk #2: the
// desktop "General" tab's version row becomes the phone "About" row.
//
// Also wired into the macOS/iPad `SettingsView`'s "About" tab (#1804) — the
// content here is plain cross-platform SwiftUI (`Form`/`Section`/
// `LabeledContent`), so the same view serves both without an `#if os` split.

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
                // Build provenance (#1804): the git SHA + build date this
                // running build was compiled from, so a device screenshot is
                // attributable to a commit at a glance instead of triage
                // stalling on "which commit is in this TestFlight build?".
                LabeledContent("Commit") {
                    Text(BuildProvenance.gitSHA)
                        .foregroundStyle(.secondary)
                        .monospaced()
                }
                .accessibilityIdentifier("about.buildCommit")
                LabeledContent("Build date") {
                    Text(BuildProvenance.buildDate)
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("about.buildDate")
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
