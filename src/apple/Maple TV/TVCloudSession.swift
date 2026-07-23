// src/apple/Maple TV/TVCloudSession.swift
import Foundation
import MapleCloudKit
import Observation

/// Outcome of resolving which library the connected experience should
/// open against. `.many` is the only case that shows a picker — `.one`
/// covers both a single-library account and a returning TV whose
/// previously-selected library still exists on the server. `.failed`
/// carries the transport/decode error so the connected screen can show a
/// distinct error+retry state instead of conflating it with a genuinely
/// empty account (D5 review of D2 — see `resolveLibraries()`).
enum LibraryResolution {
  case none
  case one(CloudFolder)
  case many([CloudFolder])
  case failed(Error)
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
  /// `/api/search` client. Feeds `TVTimelineViewModel` (TV-native, since
  /// `CloudTimelineViewModel` carries a PhotoKit-merge dependency this
  /// target doesn't link) AND — starting with the search screen, #2120 —
  /// MapleCloudKit's own `SearchViewModel` (`Cloud/SearchViewModel.swift`)
  /// used AS-IS, no TV wrapper. Unlike the timeline VM, `SearchViewModel`
  /// has no non-portable dependency: it's built entirely on
  /// `CloudSearchClient` / `SearchParams` / `SearchAsset`, the same
  /// primitives `TVTimelineViewModel` already uses, and
  /// `MapleCloudKitPortabilityTests` already guarantees it carries no
  /// forbidden import. Its debounced `queryChanged()` + generation-guarded
  /// `submit()`/`loadMore()` shape is exactly what a TV search screen
  /// needs (mirrors the desktop `CloudSearchView`'s usage). The search
  /// screen constructs it the same way `TimelineScreen` constructs
  /// `TVTimelineViewModel` — inline in its own `init`, e.g.
  /// `SearchViewModel(server: session.server, libraryID:, searchClient:
  /// session.searchClient)` — rather than through a factory here, matching
  /// this session's existing convention of exposing raw clients and
  /// letting each screen own its VM's construction and lifetime.
  let searchClient: CloudSearchClient
  let thumbClient: CloudThumbClient
  /// Shared across every `TVRemoteImage` this session's screens render
  /// (grid cells, and D6's full-screen viewer once it lands), so the
  /// disk-backed AVIF cache is a single instance per connected session
  /// rather than one per view.
  let thumbCache = CloudThumbCache()
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
      // REQUIRED, not optional. `/api/auth/refresh` ROTATES the refresh token:
      // the old one is consumed server-side the moment a refresh succeeds.
      // Without persisting the rotated pair, `tokensProvider` keeps handing
      // back the now-consumed predecessor from the Keychain, the next refresh
      // replays it, and the server's reuse detection answers 409
      // `rotation_conflict`. 409 is not 401, so the client classifies it
      // `transient` → `AuthenticationError.temporarilyUnavailable` and KEEPS
      // the dead token — meaning Retry replays it forever and only re-pairing
      // recovers. Every other Maple client passes this; the TV relied on the
      // init's no-op default and so silently threw away every rotation.
      onTokensRefreshed: { try TokenStore.save($0, server: server) },
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
  ///   - a network/401/decode failure → `.failed(error)`, so the caller
  ///     can show a distinct error+retry state rather than an empty
  ///     account (D5 review of D2 — this used to collapse into `.none`,
  ///     which looked identical to a genuinely empty account);
  ///   - a previously-selected library that's still present short-circuits
  ///     to `.one`, even when the account now has several libraries — no
  ///     re-picking on every launch;
  ///   - zero folders → `.none` (empty-state screen);
  ///   - exactly one folder → `.one`, and it's persisted as the selection
  ///     so a later multi-library account still remembers this choice;
  ///   - more than one, with no still-valid prior selection → `.many`,
  ///     driving `LibraryPickerScreen`.
  func resolveLibraries() async -> LibraryResolution {
    let folders: [CloudFolder]
    do {
      folders = try await foldersClient.listFolders()
    } catch {
      return .failed(error)
    }

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
