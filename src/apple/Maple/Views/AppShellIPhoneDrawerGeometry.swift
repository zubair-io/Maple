// AppShellIPhoneDrawerGeometry.swift — drawer width / scrim / drag math.
//
// Extracted from `AppShellIPhoneDrawer.swift` to keep that file under the
// 400-line soft budget (ticket #604). Same struct, split across files —
// extension here holds the static layout constants, the offset/progress
// math, and the two drag gestures (edge-open + drawer-close).
//
// Access-control note: `dragOffset` / `isDrawerOpen` / `mode` on the
// parent struct are declared `internal` (the Swift default) rather than
// `private` so this extension in a sibling file can read/write them.
// `private` in Swift is file-scoped — it does NOT extend to extensions
// in other files, even of the same type. Widening to internal is the
// minimum-friction split; nothing outside the Maple target sees these
// properties.
//
// Two gestures live here:
//   • `drawerCloseDragGesture` — applied to the drawer view itself. Snaps
//     closed when the user pans left past 30% of drawer width (S1b spec
//     §3.1 — threshold-only contract, velocity dismiss removed).
//   • `edgeOpenDragGesture` — applied to the root ZStack. Opens the
//     drawer when the user starts dragging inside the leftmost 20pt slab
//     AND we're in browse mode (so it doesn't conflict with viewer
//     gestures or grid horizontal scrolls).

#if os(iOS)

import SwiftUI

extension AppShellIPhoneDrawer {

    // MARK: - geometry constants

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

    // MARK: - drawer math

    /// X-translation applied to the drawer view. 0 = fully visible against
    /// the left edge; -drawerWidth = fully off-screen. The in-flight
    /// `dragOffset` is added on top of the snapped state, clamped so the
    /// user can't drag past either end.
    var drawerXOffset: CGFloat {
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
    var drawerProgress: CGFloat {
        let visible = Self.drawerWidth + drawerXOffset
        return max(0, min(1, visible / Self.drawerWidth))
    }

    // MARK: - drawer gestures

    /// Drag gesture on the drawer itself — used to drag the open drawer
    /// back closed. Snaps closed if translation crosses ≥ 30% drawer
    /// width per S1b spec §3.1 (velocity-based dismiss removed; the spec
    /// is explicit about the threshold-only contract).
    var drawerCloseDragGesture: some Gesture {
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
    var edgeOpenDragGesture: some Gesture {
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
}

#endif
