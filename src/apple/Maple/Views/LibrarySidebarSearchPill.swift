// LibrarySidebarSearchPill.swift — tablet/desktop sidebar search pill
// (S7 follow-up, #645).
//
// Pill-shaped button that mirrors the iPhone-drawer
// `AppShellIPhoneDrawerSearchPill`. Tapping it presents the search
// `<app-search>` equivalent as an anchored overlay (Apple side: a
// SwiftUI overlay built by `mapleAnchoredOverlay`). The pill ships in
// the cross-platform `LibrarySidebar` so Mac + iPad tablet/desktop
// layouts pick it up automatically — `AppShellMacLayout` and
// `AppShellSidebar` already render `LibrarySidebar` as the leading
// column of `NavigationSplitView`.
//
// Until S7 (#629) merges, the overlay content is a placeholder. Flipping
// to the real `SearchView()` is a one-line change at the call site below.
//
// Why its own file: `LibrarySidebar.swift` is already over the file-size
// soft budget (~870 LOC). New leaf views go in their own files, matching
// the `AppShellIPhoneDrawerHeader.swift` extraction pattern.

import SwiftUI

struct LibrarySidebarSearchPill: View {
    /// Two-way open-state for the anchored overlay. Hosted on
    /// `LibrarySidebar` so its lifetime matches the sidebar.
    @Binding var isPresented: Bool
    /// Overlay width — 320 on tablet, 480 on desktop. Today we always pass
    /// 320 from `LibrarySidebar` because SwiftUI doesn't expose the
    /// horizontal-size-class on macOS in a way that maps cleanly to the
    /// tablet/desktop split. Apple's spec deviation is documented in the
    /// PR body; lock it to 320 here until the breakpoint plumbing lands.
    let widthPt: CGFloat

    var body: some View {
        Button(action: { isPresented.toggle() }) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12, weight: .regular))
                    .foregroundStyle(MapleTokens.textMuted)
                Text("Search photos")
                    .font(MapleTokens.Typography.body)
                    .foregroundStyle(MapleTokens.textMuted)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(MapleTokens.inputBg)
            .overlay(
                Capsule().stroke(MapleTokens.border, lineWidth: 0.5)
            )
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Search photos")
        .accessibilityIdentifier("library-sidebar-search-pill")
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .mapleAnchoredOverlay(isPresented: $isPresented, widthPt: widthPt) {
            // Placeholder content — swap for `SearchView()` once #629
            // merges. The primitive is exercised end-to-end even before
            // S7 lands so the dismissal + positioning paths are live.
            VStack(alignment: .leading, spacing: 12) {
                Text("Search photos")
                    .font(MapleTokens.Typography.sheetTitle)
                    .foregroundStyle(MapleTokens.textMain)
                Text("Search content lands when S7 (#629) merges.")
                    .font(MapleTokens.Typography.body)
                    .foregroundStyle(MapleTokens.textMuted)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

#if DEBUG
#Preview("Pill — closed") {
    StateWrapper(initial: false) { binding in
        LibrarySidebarSearchPill(isPresented: binding, widthPt: 320)
            .frame(width: 220)
            .background(MapleTokens.sidebar)
    }
}

#Preview("Pill — open") {
    StateWrapper(initial: true) { binding in
        LibrarySidebarSearchPill(isPresented: binding, widthPt: 320)
            .frame(width: 220, height: 600)
            .background(MapleTokens.sidebar)
    }
}

private struct StateWrapper<Content: View>: View {
    @State private var value: Bool
    let content: (Binding<Bool>) -> Content

    init(initial: Bool, @ViewBuilder content: @escaping (Binding<Bool>) -> Content) {
        _value = State(initialValue: initial)
        self.content = content
    }

    var body: some View { content($value) }
}
#endif
