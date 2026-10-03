// src/apple/MapleTopShelf/TopShelfSession.swift
//
// Credentials and clients for a Top Shelf refresh, read out of state the TV
// app already maintains. Mirrors `MapleWidget/WidgetSession.swift` — same
// problem, same shape: an extension with no UI to sign in with, discovering
// the paired server from the shared App Group and its tokens from the shared
// Keychain access group.
//
// Returns nil rather than throwing when the Apple TV isn't paired or hasn't
// picked a library. That is the normal state of a fresh install, not an
// error, and the correct Top Shelf response to it is the static app icon.

import Foundation
import MapleCloudKit

struct TopShelfSession {
  let server: URL
  let libraryID: String
  let generatedSearch: GeneratedSearchClient
  let search: CloudSearchClient
  let thumbs: CloudThumbClient

  @MainActor
  static func current() -> TopShelfSession? {
    // The same App Group suite (and migration) the app's own singleton uses,
    // so app and extension can never read different domains.
    let registry = CloudServerRegistry(defaults: CloudServerRegistry.appGroupDefaults())
    guard let server = registry.servers.first(where: { (try? TokenStore.load(server: $0)) != nil }),
      let libraryID = registry.selectedLibraryID(for: server)
    else { return nil }

    let httpClient = AuthenticatedHTTPClient(
      server: server,
      urlSession: .shared,
      tokensProvider: { try? TokenStore.load(server: server) },
      onTokensRefreshed: { try TokenStore.save($0, server: server) },
      onSignOut: {
        // Deliberately does NOT clear the Keychain — same reasoning as
        // WidgetSession. A Top Shelf refresh runs unattended, and treating
        // one failed refresh as "sign out everywhere" would log the viewer
        // out of the app from the background.
      }
    )

    return TopShelfSession(
      server: server,
      libraryID: libraryID,
      generatedSearch: GeneratedSearchClient(server: server, httpClient: httpClient),
      search: CloudSearchClient(server: server, httpClient: httpClient),
      thumbs: CloudThumbClient(server: server, httpClient: httpClient)
    )
  }
}
