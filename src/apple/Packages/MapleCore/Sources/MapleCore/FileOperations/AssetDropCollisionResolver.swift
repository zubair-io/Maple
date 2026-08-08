// AssetDropCollisionResolver.swift — the collision ask-flow's exactly-once
// continuation resume (#2646 review follow-up).
//
// `AppShell+AssetDrop.swift`'s routing loop suspends via
// `withCheckedContinuation` while `AssetDropCollisionSheet` is on screen,
// and MUST resume exactly once no matter which path gets there first:
//   - the user taps Skip / Replace / Keep Both
//   - the user dismisses the sheet WITHOUT tapping anything — swipe-down
//     on iPadOS, Escape on macOS
// The button path is easy; the implicit-dismiss path is the bug this type
// exists to close. `.sheet(item:)`'s `onDismiss` fires for BOTH cases (a
// button tap that nils the bound item also triggers it), so without a
// single shared "resolved?" guard a naive implementation either resumes
// twice (a `CheckedContinuation` crash) or — if the button path is coded
// to skip `onDismiss` somehow — never resumes at all on a real swipe/
// Escape, permanently hanging `assetDropTask` and, since
// `performAssetDrop` refuses to start a second drop while one is running,
// silently killing drag-and-drop for the rest of the app session.
//
// Lives in MapleCore (not the Maple app target) specifically so it has
// real `swift test` coverage — the Xcode app target's own test target is
// a stub (see CLAUDE.md's Apple build section).

import Foundation

/// The user's answer to a collision prompt for ONE asset during a
/// drag-onto-source-tree move/copy (#2646) — Skip / Replace / Keep Both,
/// per the design doc's "Move / copy via drag-and-drop" section.
public enum AssetDropCollisionChoice: Sendable {
    case skip
    case replace
    case keepBoth
}

/// Wraps a `CheckedContinuation` and guarantees it resumes EXACTLY once.
/// Every call site — a button's `onChoice`, and the sheet's `onDismiss`
/// fallback — calls `resolve(_:)` unconditionally; only the first call
/// actually resumes the continuation, every subsequent call (including one
/// racing in from the other path) is a silent no-op. An implicit dismissal
/// should call `resolve(.skip)` — the same outcome as the user tapping
/// Skip, which matches intent for a swipe/Escape far better than either a
/// permanently hung drop or trapping the user in the sheet via
/// `.interactiveDismissDisabled()` to protect the continuation.
///
/// `@MainActor`-isolated: every caller (SwiftUI button actions, `.sheet`'s
/// `onDismiss`, and the `AppShell` routing loop that constructs this) is
/// already on the main actor, so a plain (non-atomic) `Bool`-via-Optional
/// guard is safe — there is no cross-thread race to protect against, only
/// the two same-actor call orderings described above.
@MainActor
public final class AssetDropCollisionResolver {
    private var continuation: CheckedContinuation<AssetDropCollisionChoice, Never>?

    public init(continuation: CheckedContinuation<AssetDropCollisionChoice, Never>) {
        self.continuation = continuation
    }

    /// `true` once `resolve(_:)` has fired — exposed for tests that want to
    /// assert a second call was genuinely a no-op rather than just
    /// happening not to crash.
    public var isResolved: Bool { continuation == nil }

    public func resolve(_ choice: AssetDropCollisionChoice) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(returning: choice)
    }
}
