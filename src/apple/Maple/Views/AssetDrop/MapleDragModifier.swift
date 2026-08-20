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
import SwiftUI
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

extension View {
    /// OS file/folder URL drop target (#2649). Wraps
    /// `dropDestination(for: URL.self)` with the closure explicitly typed to
    /// pin the Bool-returning overload: iOS 26 added a Void `DropSession`
    /// variant that otherwise wins overload resolution for single-expression
    /// closures and silently discards the handled flag (it's also
    /// unavailable before macOS 26 — this repo targets 14). Route every URL
    /// drop target through here so a new call site can't silently bind the
    /// wrong overload (#2950).
    func urlDropDestination(
        isTargeted: @escaping (Bool) -> Void = { _ in },
        perform handler: @escaping ([URL]) -> Bool
    ) -> some View {
        dropDestination(
            for: URL.self,
            action: { (urls: [URL], _: CGPoint) -> Bool in handler(urls) },
            isTargeted: isTargeted
        )
    }
}
