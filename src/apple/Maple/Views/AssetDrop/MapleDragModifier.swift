// MapleDragModifier.swift — platform copy-modifier detection for a
// `.dropDestination` drop (#2646). Default drag = move; the platform
// copy-modifier = copy, per the design doc.
//
// SwiftUI's `.dropDestination(for:action:isTargeted:)` doesn't hand the
// action closure any keyboard-modifier state, so this reads it directly
// from the platform at the moment the drop lands:
//   - macOS: `NSEvent.modifierFlags` — still valid at drop time, the same
//     way `NSEvent.modifierFlags` is read elsewhere for live Option-key
//     UI state (cursor/menu-item swaps).
//   - iOS/iPadOS: SwiftUI's `DropSession` exposes no modifier-flag API
//     (that's UIKit's `UIDropSession`/`UIKeyModifierFlags`, which
//     `.dropDestination` doesn't bridge). A drag on iPadOS is always a
//     move through this affordance; Copy is still reachable there via the
//     "Copy Selected Here" context-menu item, which needs no modifier key
//     at all.
import Foundation
#if os(macOS)
import AppKit
#endif

enum MapleDragModifier {
    static func isCopyRequested() -> Bool {
        #if os(macOS)
        return NSEvent.modifierFlags.contains(.option)
        #else
        return false
        #endif
    }
}
