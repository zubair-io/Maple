// BrowseGrid+VM.swift — Pure-function view-model helpers for BrowseGrid.
//
// Co-located sibling of BrowseGrid.swift. Holds derivations and copy
// selectors that take typed inputs and return typed outputs — no SwiftUI,
// no @State, no view-builder closures. The view file calls these helpers
// and feeds the returned values into its body.
//
// Pattern (issue #192): every SwiftUI view with non-trivial derivation
// gets a sibling `+VM.swift` whose contents are unit-testable in
// isolation. To preserve that guarantee this file MUST NOT
// `import SwiftUI` — a grep gate in CI enforces it. If a helper needs
// `View` context (or UIKit/AppKit image types) it doesn't belong here.

import Foundation
import MapleCore

// MARK: - BrowseGridVM

/// Namespace for pure BrowseGrid derivations. A caseless enum keeps the
/// helpers grouped without ever being instantiated. All members are
/// static.
enum BrowseGridVM {

    // MARK: - Empty state

    /// Inputs to the BrowseEmptyState selectors. The empty-state overlay
    /// only takes over when the folder has zero folders and zero images
    /// (the caller already checks that), so these inputs describe the
    /// reason the folder is empty rather than whether it is.
    struct EmptyStateInputs {
        let photosAuthNeeded: Bool
        /// True while PhotoKit is `.notDetermined` — the one state where the
        /// system prompt can still be raised. Once the user has declined,
        /// iOS never shows that prompt again, so a Connect button would be a
        /// dead end and the panel offers Settings instead. Only read when
        /// `photosAuthNeeded` is true.
        let photosAuthCanRequest: Bool
        let isLoading: Bool
        let hasLoadError: Bool
        let hasCurrentSource: Bool
    }

    /// SF Symbol shown above the primary title. `lock.shield` for the
    /// "Photos access not granted" branch, the generic photo icon for
    /// every other branch.
    static func emptyStateIconName(photosAuthNeeded: Bool) -> String {
        photosAuthNeeded ? "lock.shield" : "photo.on.rectangle.angled"
    }

    // MARK: - Photos permission panel (#2454)

    /// Title for the Photos-permission panel. Splits on whether the system
    /// prompt is still available: an undecided user is being invited to
    /// connect, a declined one is being told where the switch now lives.
    static func photosAuthTitle(canRequest: Bool) -> String {
        canRequest ? "Connect your Photos library" : "Photos access is turned off"
    }

    /// Body copy for the Photos-permission panel. The `canRequest` branch
    /// says what Maple does with the library and reassures on the
    /// non-destructive invariant; the declined branch explains that the
    /// choice was already made and is reversible in Settings.
    static func photosAuthBody(canRequest: Bool) -> String {
        canRequest
            ? "Maple reads the photos and RAW files in your library so you can browse and edit them here. Your originals are never modified — every edit is saved alongside them."
            : "Maple was declined access to your photo library, and iOS won't ask again. You can turn it back on in Settings."
    }

    /// Label for the panel's action button.
    static func photosAuthButtonTitle(canRequest: Bool) -> String {
        canRequest ? "Connect" : "Open Settings"
    }

    /// Primary line of the empty-state overlay. Branches only on whether
    /// the user still owes Maple Photos access — every other branch
    /// shares the "No assets yet" copy and is differentiated by the
    /// secondary line below.
    static func emptyStatePrimaryTitle(photosAuthNeeded: Bool, photosAuthCanRequest: Bool) -> String {
        photosAuthNeeded ? photosAuthTitle(canRequest: photosAuthCanRequest) : "No assets yet"
    }

    /// Classifies which secondary line the empty-state view should
    /// render. The view's @ViewBuilder then maps this case to the right
    /// SwiftUI subtree. Priority order matches the original `if / else
    /// if` chain so behavior is byte-for-byte identical:
    ///
    ///   1. `photosAuthNeeded` → permission CTA
    ///   2. `isLoading` → spinner + "Loading…"
    ///   3. `hasLoadError` → error text + retry
    ///   4. `hasCurrentSource` → "no supported RAW files"
    ///   5. otherwise → "pick a folder / Photos filter"
    enum EmptyStateSecondary: Equatable {
        /// Undecided — the panel invites the user to Connect, which raises
        /// the system prompt.
        case photosAuthConnect
        /// Declined or restricted — the prompt is spent, so the panel sends
        /// the user to Settings instead of offering a button that would do
        /// nothing.
        case photosAuthSettings
        case loading
        case loadError
        case sourceHasNoRaws
        case noSourcePicked
    }

    /// Pure selector for `EmptyStateSecondary`. The view doesn't reach
    /// into `BrowseViewModel` directly any more — it lifts the four
    /// inputs out and asks this function which branch to render.
    static func emptyStateSecondary(_ inputs: EmptyStateInputs) -> EmptyStateSecondary {
        if inputs.photosAuthNeeded {
            return inputs.photosAuthCanRequest ? .photosAuthConnect : .photosAuthSettings
        }
        if inputs.isLoading { return .loading }
        if inputs.hasLoadError { return .loadError }
        if inputs.hasCurrentSource { return .sourceHasNoRaws }
        return .noSourcePicked
    }

    // MARK: - Merged timeline cell

    /// Display name for a merged timeline cell. Mirrors the original
    /// view-private `displayName` switch — `.localOnly` and `.cloudOnly`
    /// surface the wrapped ref's name; `.synced` prefers the local ref
    /// (the local PhotoKit name is what the user already sees in
    /// Apple Photos).
    static func mergedCellDisplayName(_ cell: MergedTimelineCell) -> String {
        switch cell {
        case .localOnly(let r), .cloudOnly(let r): return r.displayName
        case .synced(let local, _): return local.displayName
        }
    }

    /// SF Symbol for the small status badge in the bottom-trailing
    /// corner of a merged cell.
    ///
    ///   - `.synced`     → `checkmark.icloud.fill` (present everywhere)
    ///   - `.cloudOnly`  → `icloud.fill` (server has it, this device doesn't)
    ///   - `.localOnly`  → `icloud.and.arrow.up` (not backed up yet)
    static func mergedCellBadgeIconName(_ cell: MergedTimelineCell) -> String {
        switch cell {
        case .synced:     return "checkmark.icloud.fill"
        case .cloudOnly:  return "icloud.fill"
        case .localOnly:  return "icloud.and.arrow.up"
        }
    }
}
