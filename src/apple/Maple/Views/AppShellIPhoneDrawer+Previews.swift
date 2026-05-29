// AppShellIPhoneDrawer+Previews.swift — SwiftUI previews for the drawer.
//
// Extracted from `AppShellIPhoneDrawer.swift` to keep that file under the
// 400-line soft budget (ticket #604). Same pattern as
// `DetailPanel+Previews.swift`.

#if os(iOS)

import SwiftUI
import MapleCore

#Preview("Default — closed") {
    struct Wrapper: View {
        @State var open = false
        var body: some View {
            AppShellIPhoneDrawer(
                isDrawerOpen: $open,
                mode: .browse,
                connectionIdentity: "maple.lawrence.io",
                tertiarySummary: "12,481 photos · synced 2m ago",
                onSearchPillTap: {},
                mainContent: {
                    ZStack {
                        MapleTokens.bg.ignoresSafeArea()
                        VStack {
                            Button("Open drawer") { open = true }
                                .foregroundStyle(MapleTokens.textMain)
                        }
                    }
                },
                sidebarContent: {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("FOLDERS").font(MapleTokens.Typography.eyebrow)
                                .foregroundStyle(MapleTokens.textMuted)
                                .tracking(1.4)
                            ForEach(["Trip 2026", "Wedding · Aug", "Studio · Sept"], id: \.self) {
                                Text($0).font(MapleTokens.Typography.rowLabel)
                                    .foregroundStyle(MapleTokens.textMain)
                            }
                        }
                        .padding(16)
                    }
                }
            )
        }
    }
    return Wrapper()
}

#Preview("Open") {
    struct Wrapper: View {
        @State var open = true
        var body: some View {
            AppShellIPhoneDrawer(
                isDrawerOpen: $open,
                mode: .browse,
                connectionIdentity: "maple.lawrence.io",
                tertiarySummary: "12,481 photos · synced 2m ago",
                onSearchPillTap: {},
                mainContent: {
                    ZStack {
                        MapleTokens.bg.ignoresSafeArea()
                        Text("Grid placeholder")
                            .foregroundStyle(MapleTokens.textMuted)
                    }
                },
                sidebarContent: {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("FOLDERS").font(MapleTokens.Typography.eyebrow)
                                .foregroundStyle(MapleTokens.textMuted)
                                .tracking(1.4)
                            ForEach(["Trip 2026", "Wedding · Aug", "Studio · Sept"], id: \.self) {
                                Text($0).font(MapleTokens.Typography.rowLabel)
                                    .foregroundStyle(MapleTokens.textMain)
                            }
                        }
                        .padding(16)
                    }
                }
            )
        }
    }
    return Wrapper()
}

#endif
