// AppShellIPhoneDrawerHeader.swift — chrome subviews for the iPhone source-picker drawer.
//
// Extracted from `AppShellIPhoneDrawer.swift` to keep that file under the
// 400-line soft budget (ticket #604). Same pattern as PR #566's
// `ProfilePicker` extraction — leaf views with no fileprivate access live
// in their own files so the parent's body reads as composition.
//
// Two views here:
//   • `AppShellIPhoneDrawerHeader` — LIBRARY eyebrow + close X +
//     connection-identity row + tertiary summary row.
//   • `AppShellIPhoneDrawerSearchPill` — search-pill button that dismisses
//     the drawer and notifies any S7 search-tab listener.
//
// Both are pure inputs/outputs — no shared state with the parent. The
// parent owns dismissal (`onClose`) and the search callback
// (`onSearchPillTap`); these views just render and forward taps.

#if os(iOS)

import SwiftUI
import MapleCore

/// LIBRARY eyebrow + close button + optional connection-identity row +
/// optional tertiary summary row. Painted at the top of the drawer chrome
/// above the source-tree content. Matches HTML mockup frame 01.
struct AppShellIPhoneDrawerHeader: View {
    /// Display-only string (e.g. `"maple.lawrence.io"`). Empty hides the row.
    let connectionIdentity: String
    /// Display-only summary (e.g. `"12,481 photos · 2m"`). Empty hides the row.
    let tertiarySummary: String
    /// Fired when the user taps the close X button.
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center) {
                Text("LIBRARY")
                    .font(MapleTokens.Typography.sectionHeader)
                    .tracking(1.4) // ~0.14em on 10pt
                    .foregroundStyle(MapleTokens.textMuted)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(MapleTokens.textMuted)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close library")
                .accessibilityIdentifier("source-picker-drawer-close")
            }
            if !connectionIdentity.isEmpty {
                HStack(spacing: 4) {
                    Text(connectionIdentity)
                        .font(MapleTokens.Typography.row)
                        .foregroundStyle(MapleTokens.textMain)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    // Chevron is a stub for v0.1 — Maple-instance switcher
                    // is out of scope for S1b. Tappable but no-op so the
                    // visual matches the mockup without enabling a half-
                    // built flow.
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(MapleTokens.textMuted)
                }
            }
            if !tertiarySummary.isEmpty {
                Text(tertiarySummary)
                    .font(MapleTokens.Typography.meta)
                    .foregroundStyle(MapleTokens.textMuted)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 12)
    }
}

/// Pill-shaped button that visually mimics a search input but acts as a
/// navigation trigger — tapping it dismisses the drawer and hands off to
/// the parent's `onTap` callback. The parent is responsible for switching
/// tabs / posting the focus notification.
struct AppShellIPhoneDrawerSearchPill: View {
    /// Fired when the user taps the pill. The parent dismisses the drawer
    /// and decides what to do next (e.g. switch to the Search tab).
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(MapleTokens.textMuted)
                Text("Search photos")
                    .font(MapleTokens.Typography.row)
                    .foregroundStyle(MapleTokens.textMuted)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(MapleTokens.inputBg)
            .overlay(
                RoundedRectangle(cornerRadius: 999, style: .continuous)
                    .stroke(MapleTokens.border, lineWidth: 0.5)
            )
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Search photos")
        .accessibilityIdentifier("source-picker-drawer-search-pill")
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
    }
}

#endif
