// MapleApp.swift — Entry point: SwiftUI App with three-column shell.
//
// Mac/iPad: NavigationSplitView (AppShell).
// iPhone: TabView collapse in AppShell.
//
// Slice 10c — all 10 phases.

import SwiftUI
import MapleCore

@main
struct MapleApp: App {
    var body: some Scene {
        WindowGroup {
            AppShell()
        }
        #if os(macOS)
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified(showsTitle: true))
        .defaultSize(width: 1280, height: 800)
        #endif

        #if os(macOS)
        // Settings scene
        Settings {
            SettingsView()
        }
        #endif
    }
}

// MARK: - SettingsView (macOS)

#if os(macOS)
struct SettingsView: View {
    var body: some View {
        Form {
            Text("Maple \(MapleCore.version())")
                .foregroundStyle(Color.secondary)
        }
        .frame(width: 360, height: 120)
        .padding()
    }
}
#endif
