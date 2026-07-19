// src/apple/Maple TV/ConnectedScreen.swift
import MapleCloudKit
import SwiftUI

/// Root of the connected (paired + authenticated) experience. Builds this
/// server's `TVCloudSession`, resolves which library to open
/// (`TVCloudSession.resolveLibraries()`), and routes to whichever screen
/// that resolution calls for:
///   - `.one` → straight to the `TimelineScreen` grid;
///   - `.many` → `LibraryPickerScreen`, then the Timeline once a pick
///     lands in `session.selectedLibraryID`;
///   - `.none` → an empty-account state;
///   - `.failed` → an error state with Retry (D5 review of D2 — see
///     `TVCloudSession.resolveLibraries()`; this used to be
///     indistinguishable from `.none`).
/// "Forget this server" (milestone C's pairing-reversal path) stays
/// reachable from every one of those states.
struct ConnectedScreen: View {
  let server: URL
  let onForgotten: () -> Void

  @State private var session: TVCloudSession?
  @State private var resolution: LibraryResolution?
  /// Guards against a rapid double-tap on Retry spawning two concurrent
  /// `resolve()` calls that race to set `session`/`resolution`.
  @State private var isResolving = false

  private var displayHost: String {
    CloudHost.parse(server.absoluteString)?.displayHost ?? server.host ?? server.absoluteString
  }

  private var displayName: String {
    CloudServerRegistry.shared.displayName(for: server) ?? displayHost
  }

  /// Every folder this connected server has told us about across the
  /// most recent `.one`/`.many` resolution. Used to look up the display
  /// name of whichever folder `session.selectedLibraryID` now points at
  /// — that id can flip after this state was captured (the picker calls
  /// `session.select(_:)` directly), so this reads from the last
  /// resolution rather than assuming `.one`'s payload is still current.
  private var knownFolders: [CloudFolder] {
    // `guard let` first (rather than switching directly on `resolution:
    // LibraryResolution?`) so the switch below matches on the unwrapped
    // `LibraryResolution` — its own `.none` case would otherwise be
    // ambiguous with `Optional.none` (nil).
    guard let resolution else { return [] }
    switch resolution {
    case .one(let folder): return [folder]
    case .many(let folders): return folders
    case .none, .failed: return []
    }
  }

  var body: some View {
    ZStack {
      MapleTVTheme.background.ignoresSafeArea()
      content
    }
    .task { await resolve() }
  }

  @ViewBuilder
  private var content: some View {
    // Checked FIRST and independent of the `switch` below: once a
    // library is selected — whether by an implicit `.one` auto-select or
    // a `LibraryPickerScreen` tap — this is the steady state to show,
    // regardless of what `resolution` itself last held. (Deliberately
    // `if let resolution` rather than `switch resolution` further down:
    // `LibraryResolution` has its own case named `.none`, which is
    // ambiguous with `Optional.none` when switching directly over the
    // `LibraryResolution?` — unwrapping first avoids that footgun.)
    if let session, let libraryID = session.selectedLibraryID,
       let folder = knownFolders.first(where: { $0.id == libraryID }) {
      TimelineScreen(
        session: session,
        libraryID: libraryID,
        libraryName: folder.displayName,
        onForgotten: forget
      )
      .id(libraryID)
    } else if let resolution {
      switch resolution {
      case .none:
        emptyView
      case .failed(let error):
        errorView(error)
      case .many(let folders):
        if let session {
          LibraryPickerScreen(session: session, folders: folders)
        } else {
          loadingView
        }
      case .one:
        // `session.selectedLibraryID` is seeded from CloudServerRegistry
        // at `TVCloudSession` init, so it's already non-nil here whether
        // or not this `resolveLibraries()` pass itself called `select(_:)`
        // — this is a one-frame transitional state, not a steady one.
        loadingView
      }
    } else {
      loadingView
    }
  }

  private var loadingView: some View {
    ProgressView("Connecting…")
      .tint(MapleTVTheme.textPrimary)
      .foregroundStyle(MapleTVTheme.textPrimary)
      .accessibilityLabel("Connecting to \(displayName)")
  }

  private var emptyView: some View {
    VStack(spacing: 24) {
      Image(systemName: "photo.on.rectangle.angled")
        .font(.system(size: 64))
        .foregroundStyle(MapleTVTheme.textMuted)
        .accessibilityHidden(true)
      Text("No libraries yet")
        .font(.system(size: 32, weight: .semibold))
        .foregroundStyle(MapleTVTheme.textPrimary)
      Text("Register a folder on \(displayName) to see photos here.")
        .font(.system(size: 20))
        .foregroundStyle(MapleTVTheme.textMuted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 560)
      forgetButton
    }
    .padding(72)
  }

  private func errorView(_ error: Error) -> some View {
    VStack(spacing: 24) {
      Image(systemName: "wifi.exclamationmark")
        .font(.system(size: 64))
        .foregroundStyle(MapleTVTheme.primary)
        .accessibilityHidden(true)
      Text("Couldn't reach \(displayName)")
        .font(.system(size: 32, weight: .semibold))
        .foregroundStyle(MapleTVTheme.textPrimary)
      Text(error.localizedDescription)
        .font(.system(size: 20))
        .foregroundStyle(MapleTVTheme.textMuted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 560)
      HStack(spacing: 24) {
        Button("Retry") { Task { await resolve() } }
          .accessibilityLabel("Retry connecting to \(displayName)")
        forgetButton
      }
    }
    .padding(72)
  }

  private var forgetButton: some View {
    Button("Forget this server", role: .destructive, action: forget)
      .accessibilityLabel("Forget this server")
  }

  /// Reuses the existing session (if any) rather than rebuilding it, so
  /// Retry re-resolves against the same `AuthenticatedHTTPClient` and
  /// preserves whatever `selectedLibraryID` was already persisted.
  private func resolve() async {
    guard !isResolving else { return }
    isResolving = true
    defer { isResolving = false }
    let activeSession = session ?? TVCloudSession(server: server, onSignOut: onForgotten)
    session = activeSession
    resolution = await activeSession.resolveLibraries()
  }

  private func forget() {
    // CloudServerRegistry.remove already clears TokenStore for this
    // server (see CloudServerRegistry.swift) — only the user-info cache
    // needs an explicit clear here.
    CloudServerRegistry.shared.remove(server)
    AuthUserCache.clear(server: server)
    onForgotten()
  }
}
