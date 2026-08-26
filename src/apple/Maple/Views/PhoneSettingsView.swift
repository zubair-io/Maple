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
import MapleUI

/// The sub-screen pushed by one `PhoneSettingsView` row, driving
/// `.navigationDestination(item:)` below.
private enum SettingsDestination: String, Identifiable {
    case general, backup, cloud, pano, observability, sources, files, about, mapleUIGallery
    var id: String { rawValue }
}

struct PhoneSettingsView: View {
    /// Threaded down to `SelfHostedSettingsTab` so ServerAdmin (#2766)
    /// observes the app's shared per-server `AuthSession`. The default is
    /// the preview fallback, which is not cached across calls.
    var sessionFor: @MainActor (URL) -> AuthSession = AppShell.defaultSessionResolver

    /// Which sub-screen is pushed. Rows use `MuiListRow`'s own `pressed`
    /// closure to set this rather than wrapping each row in a
    /// `NavigationLink` — every `MuiListRow` is itself a `Button`, and
    /// nesting that inside a `NavigationLink`'s label would let the row's
    /// own tap gesture win the hit test and swallow the push.
    @State private var destination: SettingsDestination?

    var body: some View {
        List {
            Section("General") {
                MuiListRow(icon: "gear", label: "General", pressed: { destination = .general }, trailing: chevron)
                MuiListRow(icon: "icloud.and.arrow.up", label: "Backup", pressed: { destination = .backup }, trailing: chevron)
                MuiListRow(icon: "cloud", label: "Cloud", pressed: { destination = .cloud }, trailing: chevron)
                MuiListRow(icon: "photo.stack", label: "Pano", pressed: { destination = .pano }, trailing: chevron)
                    .accessibilityIdentifier("settings.tab.pano")
            }

            Section("Observability") {
                MuiListRow(icon: "waveform.path.ecg", label: "Observability", pressed: { destination = .observability }, trailing: chevron)
            }

            Section("Files") {
                // #2925: the sidebar hides source sections with nothing
                // connected, which takes their "+" buttons with them. This
                // page is where sources are registered and removed instead
                // — and the phone keeps the sidebar behind a drawer, so it
                // matters more here than anywhere.
                MuiListRow(icon: "externaldrive", label: "Sources", pressed: { destination = .sources }, trailing: chevron)
                    .accessibilityIdentifier("settings.tab.sources")
                MuiListRow(icon: "folder", label: "Files", pressed: { destination = .files }, trailing: chevron)
            }

            Section("App") {
                MuiListRow(icon: "info.circle", label: "About", pressed: { destination = .about }, trailing: chevron)
                // Maple UI design-system Apple phase — dev-facing catalog
                // of shipped tokens/atoms; hung off "App" alongside About
                // rather than a new section for one row.
                MuiListRow(icon: "square.grid.2x2", label: "Maple UI Gallery", pressed: { destination = .mapleUIGallery }, trailing: chevron)
            }
        }
        .listStyle(.insetGrouped)
        .mapleSettingsBackground()
        .navigationDestination(item: $destination) { destination in
            screen(for: destination)
        }
    }

    private func chevron() -> some View {
        MuiIcon(name: "chevron.right", size: .sm, color: MuiTokens.textMuted)
    }

    @ViewBuilder
    private func screen(for destination: SettingsDestination) -> some View {
        switch destination {
        case .general:
            GeneralSettingsTab()
                .navigationTitle("General")
                .navigationBarTitleDisplayMode(.inline)
        case .backup:
            BackupSettingsView()
                .navigationTitle("Backup")
                .navigationBarTitleDisplayMode(.inline)
        case .cloud:
            SelfHostedSettingsTab(sessionFor: sessionFor)
                .navigationTitle("Cloud")
                .navigationBarTitleDisplayMode(.inline)
        case .pano:
            PanoSettingsView()
                .navigationTitle("Pano")
                .navigationBarTitleDisplayMode(.inline)
        case .observability:
            ObservabilitySettingsTab()
                .navigationTitle("Observability")
                .navigationBarTitleDisplayMode(.inline)
        case .sources:
            LibrarySourcesSettingsView()
                .navigationTitle("Sources")
                .navigationBarTitleDisplayMode(.inline)
        case .files:
            FileProviderSettingsViewIOS()
                .navigationTitle("Files")
                .navigationBarTitleDisplayMode(.inline)
        case .about:
            AboutView()
                .navigationTitle("About")
                .navigationBarTitleDisplayMode(.inline)
        case .mapleUIGallery:
            MapleUIGalleryView()
                .navigationTitle("Maple UI Gallery")
                .navigationBarTitleDisplayMode(.inline)
        }
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
