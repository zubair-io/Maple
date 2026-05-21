// AppShellIPhoneDrawer.swift — Notion-Mail-style left-side overlay
// drawer for the iPhone shell. Extracted from AppShell.swift as part
// of the multi-PR split tracked in #123 (slice 4).
//
// What's in here:
//   • `AppShellIPhoneDrawer` — the ZStack that composes the base
//     content with the dim overlay and the slide-in sidebar drawer.
//   • Drawer geometry math (offset / progress).
//   • Drag gestures: a close-drag attached to the drawer itself, and
//     an edge-open drag attached simultaneously to the root ZStack.
//   • Spring-vs-instant snap selection driven by reduce-motion.
//
// State surface (deliberately tiny):
//   • `@Binding isDrawerOpen` — snapped state. The hamburger button in
//     `iPhoneMain` (AppShell side) writes it directly; the drawer
//     reads-and-writes it on gesture-end snaps.
//   • `mode` (read-only) — gates edge-open so the drawer is
//     unreachable from the viewer (design doc open question 5).
//   • Two `@ViewBuilder`s: the main content and the sidebar. Composed
//     in the ZStack so we keep z-order correct (sidebar above dim,
//     dim above main).
//   • `dragOffset` stays as private @State — purely transient,
//     never read outside this struct.

#if os(iOS)

import SwiftUI
import MapleCore
import UIKit

struct AppShellIPhoneDrawer<MainContent: View, SidebarContent: View>: View {
    @Binding var isDrawerOpen: Bool
    let mode: AppShell.Mode
    @ViewBuilder let mainContent: () -> MainContent
    @ViewBuilder let sidebarContent: () -> SidebarContent

    /// In-flight finger translation that lets the drawer track the
    /// user's finger during a swipe. Snapped to 0 on gesture-end
    /// (then `isDrawerOpen` flips if the threshold was crossed).
    @State private var dragOffset: CGFloat = 0

    /// Honor the user's reduce-motion preference — swap the spring
    /// slide for an instant snap when the system is set to that mode.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Drawer geometry. 280pt is wide enough to fit the longest folder
    /// names in the LibrarySidebar tree without truncation, narrow
    /// enough that ~70pt of the underlying browse grid still peeks
    /// through on a 6.1" iPhone.
    static var drawerWidth: CGFloat { 280 }
    /// Left-edge horizontal slab where the open-drawer drag gesture
    /// activates. 20pt matches Apple's NavigationStack swipe-back zone.
    static var edgeActivationZone: CGFloat { 20 }

    var body: some View {
        GeometryReader { _ in
            ZStack(alignment: .leading) {
                // Base — the actual content of the app. Wrapped by the
                // caller in a NavigationStack so navigationTitle +
                // toolbar work. Block taps to the base when the drawer
                // is open so a mis-aimed tap behind the drawer doesn't
                // trigger background actions.
                mainContent()
                    .disabled(isDrawerOpen)

                // Dim overlay — fades in proportional to drawer
                // position. Tap to close. Hidden when drawer is closed
                // so it doesn't intercept taps on the base layer.
                if drawerProgress > 0.001 {
                    Color.black
                        .opacity(0.45 * drawerProgress)
                        .ignoresSafeArea()
                        .onTapGesture { closeDrawer() }
                        .accessibilityHidden(true)
                }

                // The drawer itself. LibrarySidebar paints its own
                // bg (MapleTokens.sidebar), so no extra background
                // needed here.
                sidebarContent()
                    .frame(width: Self.drawerWidth)
                    .frame(maxHeight: .infinity)
                    .offset(x: drawerXOffset)
                    .gesture(drawerCloseDragGesture)
            }
            // Edge-swipe to open. Only fires from the leftmost 20pt
            // and only when the drawer is closed AND we're in browse
            // mode — keeps gestures unambiguous w.r.t. the viewer's
            // own swipe handling.
            //
            // `.simultaneousGesture` (NOT `.gesture`) so the recognizer
            // doesn't pre-empt normal horizontal scrolls in child
            // views (the grid, the FullImage filmstrip) when the drag
            // starts outside the edge zone. The gesture's onChanged /
            // onEnded already short-circuit when the start location is
            // past `edgeActivationZone`, so attaching simultaneously
            // means rejected drags fall through to whichever child
            // gesture wants them.
            .simultaneousGesture(edgeOpenDragGesture)
        }
        .ignoresSafeArea(.keyboard)
    }

    // MARK: drawer math

    /// X-translation applied to the drawer view. 0 = fully visible
    /// against the left edge; -drawerWidth = fully off-screen. The
    /// in-flight `dragOffset` is added on top of the snapped state,
    /// clamped so the user can't drag past either end.
    private var drawerXOffset: CGFloat {
        if isDrawerOpen {
            // Open — only allow leftward drag (negative). Right-drag
            // is a no-op since the drawer is already fully visible.
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

    /// Drag gesture on the drawer itself — used to drag the open
    /// drawer back closed. Snaps closed if translation crosses 1/3
    /// width OR velocity goes leftward fast (>200pt/s).
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
                let velocity = value.predictedEndTranslation.width
                if translation < -Self.drawerWidth / 3 || velocity < -200 {
                    closeDrawer()
                } else {
                    snapDragOffset()
                }
            }
    }

    /// Drag gesture on the root ZStack — opens the drawer when the
    /// user starts dragging from the left edge. Confined to the leftmost
    /// `edgeActivationZone` AND to browse mode so we don't conflict
    /// with the viewer's own gestures or the grid's horizontal scroll.
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

    /// Runs the closure inside a spring animation, OR instantly if the
    /// user has reduce-motion enabled. The spring matches the timing
    /// the design doc calls out (response 0.3 / damping 0.85).
    private func runAnimated(_ work: () -> Void) {
        if reduceMotion {
            work()
        } else {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.85), work)
        }
    }
}

#endif
