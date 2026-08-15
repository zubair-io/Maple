// MapAvailability.swift — pure selector for what the Map surface should
// render when it has no `MapViewModel` to show (#2848).
//
// `AppShell.openMap()` (Maple app target, `AppShell+Map.swift`) is the sole
// caller: it resolves the account + post-bootstrap sign-in status, feeds
// them through `MapAvailability.reason`, and stores the result in
// `AppShell.mapUnavailableReason` for `AppShellCenterColumn` to render via
// `MapEmptyState` — on BOTH the Mac/iPad sidebar's MAP row and the iPhone
// Map tab. Lives in MapleCloudKit (re-exported through MapleCore) rather
// than the app target so the selection logic is unit-testable via
// `swift test` without linking RawPipeline.xcframework or SwiftUI.
//
// `.connecting` is NOT produced by `reason(hasAccount:isSignedIn:)` below —
// it's the transient state `openMap()` sets directly while
// `AuthSession.bootstrapAndRestore()` is in flight, before either terminal
// case (`.noAccount` is known synchronously; `.signInRequired` only after
// the bootstrap await resolves) is known. Modelling it as a third case of
// the same enum keeps `AppShellCenterColumn` / `MapEmptyState` down to a
// single switch instead of an `Optional<Optional<Reason>>` for "not
// resolved yet" vs "resolved to nothing."
public enum MapUnavailableReason: Equatable, Sendable {
    /// A resolved account's persisted token is still being restored.
    case connecting
    /// `resolveMapServerURL()` found no connected cloud account at all.
    case noAccount
    /// An account is connected, but its persisted token didn't restore a
    /// signed-in session — needs fresh credentials, which `openMap()` does
    /// not prompt for (see that file's doc comment on why).
    case signInRequired
}

/// Namespace for the terminal (post-bootstrap) Map-availability selector.
/// A caseless enum keeps it grouped without ever being instantiated.
public enum MapAvailability {
    /// `nil` → ready, `MapView` should render normally. Non-nil → the Map
    /// surface should render `MapEmptyState(reason:)` instead.
    ///
    /// `isSignedIn` is read AFTER `bootstrapAndRestore()` has already run —
    /// bootstrap only restores an already-persisted token, so a false here
    /// means fresh sign-in is genuinely required, not merely "not checked
    /// yet."
    public static func reason(hasAccount: Bool, isSignedIn: Bool) -> MapUnavailableReason? {
        guard hasAccount else { return .noAccount }
        return isSignedIn ? nil : .signInRequired
    }
}
