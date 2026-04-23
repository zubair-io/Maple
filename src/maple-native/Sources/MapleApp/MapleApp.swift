// Maple app entry — SwiftUI scaffold.
//
// Real implementation (slice 10c plan):
//   - AppShell with three-column NavigationSplitView on Mac/iPad
//   - Bottom-tab single-column collapse on iPhone
//   - Browse / FullImage views wired to EditSession
//   - PhotoKit, filesystem, SMB source adapters
//   - Metal + Core Image render path consuming MapleCore's pipeline

import SwiftUI
import MapleCore

@main
struct MapleApp: App {
    var body: some Scene {
        WindowGroup {
            PlaceholderView()
        }
        #if os(macOS)
        .windowStyle(.hiddenTitleBar)
        #endif
    }
}

struct PlaceholderView: View {
    var body: some View {
        VStack(spacing: 16) {
            Text("Maple")
                .font(.largeTitle)
                .bold()
            Text("Native scaffold — slice 10c")
                .foregroundStyle(.secondary)
            Text(MapleCore.version())
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .frame(minWidth: 480, minHeight: 320)
    }
}
