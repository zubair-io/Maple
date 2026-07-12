// PhoneSettingsView.swift — iPhone Settings tab root (responsive program
// S8, #1903). Replaces the S1a placeholder (`SettingsView()`, itself a
// `TabView` with its own `.tabItem`s) which produced a second, nested
// footer tab bar stacked underneath the app's real Library/Settings bar
// on iPhone. This is a single grouped `List` — icon tile + label + system
// chevron per row — that pushes each sub-screen onto the Settings tab's
// own `NavigationStack` (wired up in `PhoneTabShell`).
//
// Sub-screens are the same standalone views the Mac/iPad `SettingsView`
// modal already uses (`GeneralSettingsTab`, `BackupSettingsView`,
// `SelfHostedSettingsTab`, `PanoSettingsView`, `ObservabilitySettingsTab`,
// `FileProviderSettingsViewIOS`) plus a new `AboutView` — see
// docs/design/responsive-program/s8-settings.md §3.
//
// Tablet/desktop keep the existing `SettingsView()` TabView-in-modal
// unchanged; `PhoneTabShell` (this view's sole consumer) is `#if os(iOS)`,
// and `.listStyle(.insetGrouped)` below is iOS-only, so this whole file is
// guarded the same way.

#if os(iOS)

import SwiftUI
import MapleCore

struct PhoneSettingsView: View {
    var body: some View {
        List {
            Section("General") {
                NavigationLink {
                    GeneralSettingsTab()
                        .navigationTitle("General")
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    SettingsMenuRow(icon: "gear", label: "General")
                }
                NavigationLink {
                    BackupSettingsView()
                        .navigationTitle("Backup")
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    SettingsMenuRow(icon: "icloud.and.arrow.up", label: "Backup")
                }
                NavigationLink {
                    SelfHostedSettingsTab()
                        .navigationTitle("Cloud")
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    SettingsMenuRow(icon: "cloud", label: "Cloud")
                }
                NavigationLink {
                    PanoSettingsView()
                        .navigationTitle("Pano")
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    SettingsMenuRow(icon: "photo.stack", label: "Pano")
                }
                .accessibilityIdentifier("settings.tab.pano")
            }

            Section("Observability") {
                NavigationLink {
                    ObservabilitySettingsTab()
                        .navigationTitle("Observability")
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    SettingsMenuRow(icon: "waveform.path.ecg", label: "Observability")
                }
            }

            Section("Files") {
                NavigationLink {
                    FileProviderSettingsViewIOS()
                        .navigationTitle("Files")
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    SettingsMenuRow(icon: "folder", label: "Files")
                }
            }

            Section("App") {
                NavigationLink {
                    AboutView()
                        .navigationTitle("About")
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    SettingsMenuRow(icon: "info.circle", label: "About")
                }
            }
        }
        .listStyle(.insetGrouped)
        .mapleSettingsBackground()
    }
}

/// One row of `PhoneSettingsView`: a colored icon tile, the row label, and
/// (supplied automatically by the enclosing `NavigationLink` in a `List`)
/// a trailing chevron.
private struct SettingsMenuRow: View {
    let icon: String
    let label: String

    var body: some View {
        HStack(spacing: MapleTokens.Spacing.iconLabelGap) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(MapleTokens.primary)
                .frame(width: 32, height: 32)
                .overlay {
                    Image(systemName: icon)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.white)
                }
            Text(label)
                .font(MapleTokens.Typography.rowLabel)
                .foregroundStyle(MapleTokens.textMain)
        }
        .padding(.vertical, 4)
        .listRowBackground(MapleTokens.surfaceAlt)
    }
}

#Preview {
    NavigationStack {
        PhoneSettingsView()
            .navigationTitle("Settings")
    }
    .preferredColorScheme(.dark)
}

#endif
