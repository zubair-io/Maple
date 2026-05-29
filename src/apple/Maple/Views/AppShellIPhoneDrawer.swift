// AppShellIPhoneDrawer.swift — Notion-Mail-style left-side overlay drawer.
//
// As of S1b (epic #577, ticket #598) the drawer is Library-tab-scoped per
// `docs/spec/responsive-program-s1-phone-shell.md` §3. The Library shell
// still composes this view in the same way it always has (one main view +
// one sidebar view, layered in a ZStack), but the drawer's *chrome* now
// owns the LIBRARY eyebrow + connection-identity + search-pill header that
// HTML frame 01 calls out, while the caller still supplies the actual
// source-tree contents (the existing `LibrarySidebar`).
//
// S1b deltas vs the pre-S1b drawer:
//   • Width 280pt → 326pt (HTML spec; ~81% of viewport on a 402pt phone).
//   • Pan-left dismiss threshold ≥ 30% of drawer width (was 33% / velocity).
//   • Trailing edge rounded (top-right + bottom-right 18pt) + 12pt offset /
//     40pt blur drop shadow.
//   • Open transition uses an explicit 240ms cubic-bezier(0.22, 1, 0.36, 1).
//     Once S0a (PR #586) lands, swap to `MapleTokens.Motion.drawer`.
//   • Scrim still 45% black; tap-anywhere dismisses (unchanged).
//   • New header overlay above the supplied sidebar content: LIBRARY eyebrow
//     + close X, connection-identity row, search pill that dismisses the
//     drawer and notifies any listener via `onSearchPillTap` so S7 can
//     switch tabs + focus its search field.
//
// State surface (deliberately tiny):
//   • `@Binding isDrawerOpen` — snapped state. Hamburger writes it; the
//     drawer reads-and-writes it on gesture-end snaps + close button taps.
//   • `mode` (read-only) — gates edge-open so the drawer is unreachable
//     from the viewer (legacy design doc open question 5).
//   • `connectionIdentity` / `tertiarySummary` — display-only strings the
//     caller computes (e.g. `"maple.lawrence.io"` / `"12,481 photos · 2m"`).
//   • `onSearchPillTap` — fired when the user taps the search pill. The
//     drawer dismisses itself first; the caller decides what to do next
//     (S7 listens via Notification → autofocuses its search field).
//   • Two `@ViewBuilder`s: the main content and the sidebar content. The
//     sidebar content is what the user *scrolls* inside the drawer below
//     the chrome header; the chrome is owned here.
//   • `dragOffset` is private @State, purely transient.

#if os(iOS)

import SwiftUI
import MapleCore
import UIKit

// MARK: - Notification names

extension Notification.Name {
    /// Posted when the user taps the source-picker drawer's search pill.
    /// S7 (future) listens on the Search tab so its search field auto-focuses
    /// the moment the tab becomes active. Cheap enough to declare here
    /// alongside the only emitter; no need for a shared service for one event.
    static let mapleFocusSearch = Notification.Name("app.justmaple.aperture.focusSearch")
}

struct AppShellIPhoneDrawer<MainContent: View, SidebarContent: View>: View {
    @Binding var isDrawerOpen: Bool
    let mode: AppShell.Mode
    /// Display-only string in the header (e.g. `"maple.lawrence.io"`).
    /// Empty string hides the row.
    var connectionIdentity: String = ""
    /// Display-only summary under the identity row (e.g. `"12,481 photos · 2m"`).
    /// Empty string hides the row.
    var tertiarySummary: String = ""
    /// Fired when the user taps the search pill. Drawer dismisses itself
    /// first; caller switches to the Search tab and lets S7 take over via
    /// the `.mapleFocusSearch` Notification.
    var onSearchPillTap: () -> Void = {}
    @ViewBuilder let mainContent: () -> MainContent
    @ViewBuilder let sidebarContent: () -> SidebarContent

    /// In-flight finger translation that lets the drawer track the
    /// user's finger during a swipe. Snapped to 0 on gesture-end
    /// (then `isDrawerOpen` flips if the threshold was crossed).
    @State private var dragOffset: CGFloat = 0

    /// Honor the user's reduce-motion preference — swap the timed slide
    /// for an instant snap when the system is set to that mode.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Drawer geometry. 326pt is the HTML mockup's spec — ~81% of a 402pt
    /// iPhone viewport. Wide enough for long folder names without
    /// truncation, narrow enough that the underlying Library grid still
    /// peeks through the trailing scrim so the user knows they're in an
    /// overlay state.
    static var drawerWidth: CGFloat { 326 }
    /// Left-edge horizontal slab where the open-drawer drag gesture
    /// activates. 20pt matches Apple's NavigationStack swipe-back zone.
    static var edgeActivationZone: CGFloat { 20 }
    /// Pan-left translation required to commit a close — 30% of the
    /// drawer width per S1b spec §3.1. Velocity-based dismiss removed;
    /// the spec is explicit about the threshold-only contract.
    static var dismissTranslationThreshold: CGFloat { drawerWidth * 0.30 }
    /// Trailing-edge corner radius — design wants the drawer to feel like
    /// it floats above the grid rather than slicing flush.
    static var trailingCornerRadius: CGFloat { 18 }

    var body: some View {
        GeometryReader { _ in
            ZStack(alignment: .leading) {
                // Base — the actual Library tab content. Wrapped by the
                // caller in a NavigationStack so navigationTitle +
                // toolbar work. Block taps to the base when the drawer
                // is open so a mis-aimed tap behind the drawer doesn't
                // trigger background actions.
                mainContent()
                    .disabled(isDrawerOpen)

                // Dim overlay — fades in proportional to drawer position.
                // Tap-anywhere dismisses. Hidden when fully closed so it
                // doesn't intercept taps on the base layer.
                if drawerProgress > 0.001 {
                    Color.black
                        .opacity(0.45 * drawerProgress)
                        .ignoresSafeArea()
                        .onTapGesture { closeDrawer() }
                        .accessibilityHidden(true)
                }

                // The drawer itself. Chrome header (eyebrow + identity +
                // search pill) is painted here; sidebar content slot fills
                // the rest. `LibrarySidebar` paints its own background
                // (MapleTokens.sidebar), which we extend behind the chrome
                // via the drawer container.
                drawerStack
                    .frame(width: Self.drawerWidth)
                    .frame(maxHeight: .infinity)
                    .background(MapleTokens.sidebar)
                    .clipShape(
                        UnevenRoundedRectangle(
                            topLeadingRadius: 0,
                            bottomLeadingRadius: 0,
                            bottomTrailingRadius: Self.trailingCornerRadius,
                            topTrailingRadius: Self.trailingCornerRadius
                        )
                    )
                    .shadow(
                        color: Color.black.opacity(0.5),
                        radius: 20, // ~ Figma 40px blur → SwiftUI radius 20
                        x: 6,
                        y: 0
                    )
                    .offset(x: drawerXOffset)
                    .gesture(drawerCloseDragGesture)
            }
            // Edge-swipe to open. Only fires from the leftmost 20pt and
            // only when the drawer is closed AND we're in browse mode.
            // `.simultaneousGesture` so it doesn't pre-empt the grid's
            // horizontal scrolls — start-location guard makes off-edge
            // drags fall through.
            .simultaneousGesture(edgeOpenDragGesture)
        }
        .ignoresSafeArea(.keyboard)
    }

    // MARK: drawer chrome + content stack

    @ViewBuilder
    private var drawerStack: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            searchPill
            // Hairline that visually separates the chrome from the source
            // tree below — matches HTML frame 01.
            Rectangle()
                .fill(MapleTokens.border)
                .frame(height: 0.5)
                .padding(.horizontal, 16)
                .padding(.top, 8)
            sidebarContent()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center) {
                Text("LIBRARY")
                    .font(MapleTokens.Typography.sectionHeader)
                    .tracking(1.4) // ~0.14em on 10pt
                    .foregroundStyle(MapleTokens.textMuted)
                Spacer()
                Button(action: { closeDrawer() }) {
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

    private var searchPill: some View {
        // Visually a pill input but it's a Button — the actual search
        // surface lives in S7's Search tab. Tap dismisses the drawer,
        // delegates to `onSearchPillTap`, and posts `.mapleFocusSearch`
        // so the Search field can auto-focus on mount.
        Button(action: handleSearchPillTap) {
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

    private func handleSearchPillTap() {
        // Dismiss the drawer first so the Library tab animates out from
        // under the Search tab swap. The post happens on the same hop —
        // S7 reads it after its View mounts, so timing-wise the auto-
        // focus fires once the Search field is in the hierarchy.
        closeDrawer()
        onSearchPillTap()
        NotificationCenter.default.post(name: .mapleFocusSearch, object: nil)
    }

    // MARK: drawer math

    /// X-translation applied to the drawer view. 0 = fully visible against
    /// the left edge; -drawerWidth = fully off-screen. The in-flight
    /// `dragOffset` is added on top of the snapped state, clamped so the
    /// user can't drag past either end.
    private var drawerXOffset: CGFloat {
        if isDrawerOpen {
            // Open — only allow leftward drag (negative). Right-drag is a
            // no-op since the drawer is already fully visible.
            return min(0, dragOffset)
        } else {
            // Closed — only allow rightward drag (positive), capped at
            // drawerWidth so the open animation doesn't overshoot.
            return -Self.drawerWidth + max(0, min(Self.drawerWidth, dragOffset))
        }
    }

    /// 0 when the drawer is fully off-screen, 1 when fully visible.
    /// Drives the dim-overlay opacity so the dim fades in/out smoothly
    /// alongside the slide.
    private var drawerProgress: CGFloat {
        let visible = Self.drawerWidth + drawerXOffset
        return max(0, min(1, visible / Self.drawerWidth))
    }

    // MARK: drawer gestures

    /// Drag gesture on the drawer itself — used to drag the open drawer
    /// back closed. Snaps closed if translation crosses ≥ 30% drawer
    /// width per S1b spec §3.1 (velocity-based dismiss removed; the spec
    /// is explicit about the threshold-only contract).
    private var drawerCloseDragGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                guard isDrawerOpen else { return }
                dragOffset = value.translation.width
            }
            .onEnded { value in
                guard isDrawerOpen else {
                    snapDragOffset()
                    return
                }
                let translation = value.translation.width
                if translation <= -Self.dismissTranslationThreshold {
                    closeDrawer()
                } else {
                    snapDragOffset()
                }
            }
    }

    /// Drag gesture on the root ZStack — opens the drawer when the user
    /// starts dragging from the left edge. Confined to the leftmost
    /// `edgeActivationZone` AND to browse mode so we don't conflict with
    /// the viewer's own gestures or the grid's horizontal scroll.
    private var edgeOpenDragGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard !isDrawerOpen,
                      mode == .browse,
                      value.startLocation.x < Self.edgeActivationZone else { return }
                dragOffset = max(0, value.translation.width)
            }
            .onEnded { value in
                guard !isDrawerOpen,
                      mode == .browse,
                      value.startLocation.x < Self.edgeActivationZone else {
                    snapDragOffset()
                    return
                }
                let translation = value.translation.width
                let velocity = value.predictedEndTranslation.width
                if translation > Self.drawerWidth / 3 || velocity > 200 {
                    openDrawer()
                } else {
                    snapDragOffset()
                }
            }
    }

    // MARK: drawer actions

    private func openDrawer() {
        runAnimated {
            isDrawerOpen = true
            dragOffset = 0
        }
    }

    private func closeDrawer() {
        runAnimated {
            isDrawerOpen = false
            dragOffset = 0
        }
    }

    /// Used after a drag-end that didn't cross the snap threshold —
    /// returns the drawer to its pre-drag snapped state.
    private func snapDragOffset() {
        runAnimated { dragOffset = 0 }
    }

    /// Runs the closure inside the S1b open-transition curve, OR instantly
    /// if the user has reduce-motion enabled. The curve is `cubic-bezier
    /// (0.22, 1, 0.36, 1)` at 240ms — the spec's `MapleTokens.Motion
    /// .drawer` token (S0a PR #586). Once that PR merges, swap the literal
    /// for `MapleTokens.Motion.drawer.animation`.
    private func runAnimated(_ work: () -> Void) {
        if reduceMotion {
            work()
        } else {
            withAnimation(.timingCurve(0.22, 1, 0.36, 1, duration: 0.24), work)
        }
    }
}

// MARK: - Previews

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
                            Text("FOLDERS").font(MapleTokens.Typography.sectionHeader)
                                .foregroundStyle(MapleTokens.textMuted)
                                .tracking(1.4)
                            ForEach(["Trip 2026", "Wedding · Aug", "Studio · Sept"], id: \.self) {
                                Text($0).font(MapleTokens.Typography.row)
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
                            Text("FOLDERS").font(MapleTokens.Typography.sectionHeader)
                                .foregroundStyle(MapleTokens.textMuted)
                                .tracking(1.4)
                            ForEach(["Trip 2026", "Wedding · Aug", "Studio · Sept"], id: \.self) {
                                Text($0).font(MapleTokens.Typography.row)
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
