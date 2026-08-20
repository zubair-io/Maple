// WidgetSession.swift
//
// Resolves the credentials and clients a widget refresh needs, out of state
// the main app already maintains.
//
// The widget has no UI to sign in with, so everything here is read-only
// discovery: which server the app is signed into (`CloudServerRegistry`,
// backed by the App Group's shared UserDefaults) and which library is
// selected. Tokens come from the shared Keychain access group, which every
// Maple target already joins.
//
// Returns nil rather than throwing whenever the app isn't signed in or hasn't
// picked a library — that is a normal state for a freshly-installed widget,
// not an error worth surfacing.

import Foundation
import MapleCloudKit

struct WidgetSession {
  let generatedSearch: GeneratedSearchClient
  let thumbs: CloudThumbClient
  let libraryID: String

  /// The App Group container both the app and this extension can see.
  /// Matches the `com.apple.security.application-groups` entitlement.
  static let appGroup = "group.app.justmaple.aperture"

  /// Build a session from whatever the app last persisted, or nil when the
  /// widget has nothing to show yet.
  static func current() -> WidgetSession? {
    guard let defaults = UserDefaults(suiteName: appGroup) else { return nil }

    // Read the registry out of the SHARED suite, not `.standard`: an
    // extension gets its own defaults domain, so the app's `.standard`
    // entries are invisible here.
    let registry = CloudServerRegistry(defaults: defaults)
    guard let server = registry.servers.first,
          let libraryID = registry.selectedLibraryID(for: server)
    else { return nil }

    // No `onTokensRefreshed` persistence problem to solve differently here:
    // TokenStore writes to the shared Keychain access group, so a rotation
    // performed during a widget refresh is visible to the app too. Rotation
    // consumes the old refresh token server-side, so NOT persisting would
    // leave the app replaying a dead token.
    let httpClient = AuthenticatedHTTPClient(
      server: server,
      urlSession: .shared,
      tokensProvider: { try? TokenStore.load(server: server) },
      onTokensRefreshed: { try TokenStore.save($0, server: server) },
      onSignOut: {
        // Deliberately does NOT clear the Keychain. A widget refresh runs
        // unattended and on a stale network; treating one failed refresh as
        // "sign the user out everywhere" would log them out of the app from
        // the background. The app's own sign-out path owns that decision.
      }
    )

    return WidgetSession(
      generatedSearch: GeneratedSearchClient(server: server, httpClient: httpClient),
      thumbs: CloudThumbClient(server: server, httpClient: httpClient),
      libraryID: libraryID
    )
  }
}
