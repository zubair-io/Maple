import Foundation

/// Decision logic for re-presenting sign-in after a cloud request (#1381).
///
/// Kept as a pure function — no SwiftUI, no `AuthSession` — so it's
/// unit-testable. The surrounding view wiring (presenting the sheet, replaying
/// the pending folder) is the part Apple CI can't exercise; this is the part
/// that can.
public enum ReauthDecision {
  /// Whether the UI should present sign-in after a cloud load attempt.
  ///
  /// - Parameters:
  ///   - isSignedIn: the server's `AuthSession.isSignedIn` *after* the attempt.
  ///     A failed token refresh during the load clears credentials, flipping
  ///     this to `false`.
  ///   - loadError: the error the load surfaced, if any.
  /// - Returns: `true` when the session is no longer authenticated, or the load
  ///   failed with an auth error (401/403). Transient failures (offline, 5xx,
  ///   decode, or any non-`AuthClientError`) return `false` — the credentials
  ///   may still be valid, so we must not throw the user into a sign-in sheet.
  public static func needsSignIn(isSignedIn: Bool, loadError: Error?) -> Bool {
    if !isSignedIn { return true }
    if let authError = loadError as? AuthClientError, authError.isAuthFailure {
      return true
    }
    return false
  }
}
