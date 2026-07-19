// src/apple/Maple TV/TVCloudSession.swift
import Foundation
import MapleCloudKit
import Observation

/// Outcome of resolving which library the connected experience should
/// open against. `.many` is the only case that shows a picker — `.one`
/// covers both a single-library account and a returning TV whose
/// previously-selected library still exists on the server.
enum LibraryResolution: Equatable {
  case none
  case one(CloudFolder)
  case many([CloudFolder])
}

/// Post-pairing service factory for the connected experience. Builds the
/// single `AuthenticatedHTTPClient` (401-refresh coalescer, App-Group
/// locked — see `AuthenticatedHTTPClient`) this session's search/thumb/
/// folders clients share for their lifetime, mirroring the shape of
/// iOS's `AppShell+CloudActions.makeAuthenticatedHTTPClient(server:)`.
///
/// Owns library resolution: `resolveLibraries()` fetches the server's
/// registered folders and maps the result to a `LibraryResolution`,
/// persisting/reading the chosen library id via `CloudServerRegistry` so
/// a returning TV skips the picker.
@MainActor
@Observable
final class TVCloudSession {
  let server: URL
  let searchClient: CloudSearchClient
  let thumbClient: CloudThumbClient
  private let foldersClient: CloudFoldersClient

  private(set) var selectedLibraryID: String?

  /// - Parameter onSignOut: called after credentials are cleared (either
  ///   because a request 401'd and the refresh was rejected, or because
  ///   the proactive-refresh path decided the token is dead) so the root
  ///   view can route back to `PairingScreen` — the same seam
  ///   `TVRootState.refresh()` exposes to `ConnectedScreen`'s "Forget
  ///   this server" affordance.
  init(server: URL, onSignOut: @escaping () -> Void) {
    self.server = server
    self.selectedLibraryID = CloudServerRegistry.shared.selectedLibraryID(for: server)

    let httpClient = AuthenticatedHTTPClient(
      server: server,
      urlSession: .shared,
      tokensProvider: { try? TokenStore.load(server: server) },
      onSignOut: {
        // AuthenticatedHTTPClient's onSignOut fires off the actor's own
        // isolation, not necessarily the main actor — clearing the
        // Keychain is thread-safe (Security framework), but the
        // caller-supplied routing closure must hop back to the main
        // actor before touching any SwiftUI state.
        TokenStore.clear(server: server)
        Task { @MainActor in onSignOut() }
      }
    )
    self.searchClient = CloudSearchClient(server: server, httpClient: httpClient)
    self.thumbClient = CloudThumbClient(server: server, httpClient: httpClient)
    self.foldersClient = CloudFoldersClient(server: server, httpClient: httpClient)
  }

  /// Fetches the server's registered folders (`GET /api/folders`) and
  /// maps the result to a `LibraryResolution`:
  ///   - a previously-selected library that's still present short-circuits
  ///     to `.one`, even when the account now has several libraries — no
  ///     re-picking on every launch;
  ///   - zero folders → `.none` (empty-state screen, D's next task);
  ///   - exactly one folder → `.one`, and it's persisted as the selection
  ///     so a later multi-library account still remembers this choice;
  ///   - more than one, with no still-valid prior selection → `.many`,
  ///     driving `LibraryPickerScreen`.
  ///
  /// A transport/decode failure resolves to `.none` rather than throwing —
  /// callers have no richer error UI to show yet (D5's screen owns that);
  /// the empty-state path is the safe fallback here.
  func resolveLibraries() async -> LibraryResolution {
    guard let folders = try? await foldersClient.listFolders() else { return .none }

    if let selectedLibraryID,
       let stillPresent = folders.first(where: { $0.id == selectedLibraryID }) {
      return .one(stillPresent)
    }

    switch folders.count {
    case 0:
      return .none
    case 1:
      select(folders[0])
      return .one(folders[0])
    default:
      return .many(folders)
    }
  }

  /// Records the user's (or the single-library auto-resolve's) choice,
  /// persisted per-server via `CloudServerRegistry` so it survives past
  /// this session.
  func select(_ folder: CloudFolder) {
    selectedLibraryID = folder.id
    CloudServerRegistry.shared.setSelectedLibraryID(folder.id, for: server)
  }
}
