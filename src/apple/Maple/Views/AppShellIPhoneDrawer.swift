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
// File split (ticket #604 — soft budget): chrome subviews live in
// `AppShellIPhoneDrawerHeader.swift`; static geometry constants + drag
// math + the two gestures live in `AppShellIPhoneDrawerGeometry.swift`;
// `#Preview` blocks live in `AppShellIPhoneDrawer+Previews.swift`. This
// file owns the top-level view: state surface, body composition, and the
// open/close/snap action helpers.
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
//   • `dragOffset` is transient `@State`. Declared `internal` (not
//     `private`) so the geometry extension in the sibling file can mutate
//     it from gesture closures — `private` is file-scoped in Swift and
//     does not extend to same-type extensions in other files.

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
    /// Declared `internal` so the geometry extension in the sibling file
    /// can mutate it from gesture closures (see file-header note on
    /// `private` semantics).
    @State var dragOffset: CGFloat = 0

    /// Honor the user's reduce-motion preference — swap the timed slide
    /// for an instant snap when the system is set to that mode.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
            AppShellIPhoneDrawerHeader(
                connectionIdentity: connectionIdentity,
                tertiarySummary: tertiarySummary,
                onClose: closeDrawer
            )
            AppShellIPhoneDrawerSearchPill(onTap: handleSearchPillTap)
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

    private func handleSearchPillTap() {
        // Dismiss the drawer first so the Library tab animates out from
        // under the Search tab swap. The post happens on the same hop —
        // S7 reads it after its View mounts, so timing-wise the auto-
        // focus fires once the Search field is in the hierarchy.
        closeDrawer()
        onSearchPillTap()
        NotificationCenter.default.post(name: .mapleFocusSearch, object: nil)
    }

    // MARK: drawer actions

    func openDrawer() {
        runAnimated {
            isDrawerOpen = true
            dragOffset = 0
        }
    }

    func closeDrawer() {
        runAnimated {
            isDrawerOpen = false
            dragOffset = 0
        }
    }

    /// Used after a drag-end that didn't cross the snap threshold —
    /// returns the drawer to its pre-drag snapped state.
    func snapDragOffset() {
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

#endif
