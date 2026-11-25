// SelfHostedSettingsTab.swift — Maple Cloud server management.
//
// Extracted from MapleApp.swift (was a `private struct`) by responsive-
// program S8 (#1903) and unified in #4253 so the shared responsive
// `SettingsView` can instantiate it across all Apple platforms.

import MapleCore
import MapleUI
import OSLog
import SwiftUI

#if os(iOS)
  import WatchConnectivity
#endif

private let selfHostedSettingsLog = Logger(subsystem: "app.justmaple.aperture", category: "signin")

#if os(iOS)
  /// Backing value for the "Pair Apple TV…" `.sheet(item:)` (#2082, C4
  /// review) — mirrors `AddCloudSheetTarget`. Unlike that enum, this one
  /// carries the view model itself rather than a plain marker case, so the
  /// view model is constructed exactly once per presentation (at the button
  /// tap) instead of being rebuilt every time the sheet's content closure
  /// re-evaluates.
  enum PairSheetTarget: Identifiable {
    case pairing(PairAppleTVViewModel)

    var id: ObjectIdentifier {
      switch self {
      case .pairing(let viewModel): return ObjectIdentifier(viewModel)
      }
    }
  }
#endif

/// Lists registered servers (`CloudServerRegistry`) and lets the user add
/// new ones via `AddMapleCloudSheet` or remove existing ones.
struct SelfHostedSettingsTab: View {
  /// Resolves the shared per-server `AuthSession` so ServerAdmin (#2766)
  /// observes the same instance as the rest of the shell. The default is
  /// the preview/test fallback and is deliberately NOT cached across
  /// calls — every production construction site passes the real resolver
  /// from `MapleApp`, or sign-out stops propagating.
  var sessionFor: @MainActor (URL) -> AuthSession = AppShell.defaultSessionResolver

  @State private var registry = CloudServerRegistry.shared
  @State private var localNetwork = LocalNetworkResolver.shared
  /// Single sheet entry point. `.fresh` for "Add Server…", `.prefilled(serverText)`
  /// for a per-server "Sign In" (#1381).
  @State private var sheetTarget: AddCloudSheetTarget?
  /// Parallel sheet trigger for "Pair Apple TV…" (#2082) — see
  /// `PairSheetTarget`.
  #if os(iOS)
    @State private var pairSheetTarget: PairSheetTarget?
    @State private var showsWatchPairing = false
  #endif
  /// Per-server signed-in state, derived from Keychain token presence. This
  /// is a separate macOS Settings scene, so it can't observe the app's
  /// AuthSession cache — but a failed refresh clears the tokens, so token
  /// presence is an accurate "signed in?" signal. Refreshed on appear, on
  /// registry changes, and after the sign-in sheet closes.
  @State private var signedIn: [URL: Bool] = [:]
  #if os(macOS)
    @Environment(\.openWindow) private var openWindow
  #else
    /// Server whose admin sheet is presented. `URL` isn't `Identifiable`,
    /// so it travels wrapped for `.sheet(item:)`.
    @State private var adminTarget: AdminSheetTarget?

    struct AdminSheetTarget: Identifiable {
      let server: URL
      var id: URL { server }
    }
  #endif

  /// #1954: gates the header/empty-state card background below. This
  /// view backs both the iPhone push list (reached
  /// only when `MapleShellKind.current == .phoneTab` — see
  /// `AppShell.body`) and the wide `SettingsView` layout, and `#if
  /// os(iOS)` alone can't tell those apart: iPadOS compiles under
  /// `os(iOS)` too, so a compile-time check would leak the phone's
  /// list-row card styling into the iPad modal, which #1908 deliberately
  /// left with its native pane look (same reason `mapleSettingsBackground()`
  /// is a no-op there). `MapleShellKind` is the codebase's own
  /// idiom-derived shell selector for exactly this distinction — see its
  /// doc comment ("do not call `UIDevice.userInterfaceIdiom` directly
  /// elsewhere").
  private var isPhoneShell: Bool { MapleShellKind.current == .phoneTab }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      // This header sits outside the `List` below, so it never
      // picked up the `.listRowBackground(surface)` that #1908 gave
      // every row on this and every other Settings sub-screen — it
      // rendered flat against the page `bg`, breaking parity with
      // Backup/About on the phone shell.
      Group {
        let label = header
        if isPhoneShell {
          // Padding insets the text FIRST, then the frame
          // stretches that already-padded content to the full
          // available width — reversing this order (frame, then
          // padding) would add padding OUTSIDE an already
          // full-width view instead of inside it, growing the
          // card past its container (review on #1954).
          label
            .padding(.horizontal, MapleTokens.Spacing.rowHorizontal)
            .padding(.vertical, MapleTokens.Spacing.rowVertical)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
              MapleTokens.surface,
              in: RoundedRectangle(
                cornerRadius: MapleUI.MapleUITokens.radiusMd, style: .continuous))
        } else {
          label
        }
      }

      if registry.servers.isEmpty {
        // Same #1954 fix as the header above — the empty state is
        // the only content on screen until a server is paired, so
        // without this it's the most visible instance of the gap.
        Group {
          let emptyState = VStack(spacing: 6) {
            Text("No paired servers.")
              .foregroundStyle(.secondary)
            Text("Click \"Add Server…\" to pair a Maple Cloud instance.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 24)
          if isPhoneShell {
            emptyState
              .background(
                MapleTokens.surface,
                in: RoundedRectangle(
                  cornerRadius: MapleUI.MapleUITokens.radiusMd, style: .continuous))
          } else {
            emptyState
          }
        }
        Spacer()
      } else {
        List {
          ForEach(registry.servers, id: \.self) { url in
            serverRow(url)
              .padding(.vertical, 4)
              .listRowBackground(MapleTokens.surface)
          }
        }
        .listStyle(.inset)
        .mapleSettingsBackground()
        .frame(minHeight: 120)
      }
    }
    #if os(macOS)
      .padding(24)
    #else
      .padding(.horizontal, 16)
      .padding(.top, 16)
    #endif
    .mapleSettingsBackground()
    .task(id: registry.servers) {
      refreshSignedIn()
      await refreshLocalAddresses()
    }
    .sheet(item: $sheetTarget) { target in
      AddMapleCloudSheet(
        prefilledDomain: target.prefill,
        onDismiss: { sheetTarget = nil },
        onSignedIn: { url, tokens, _ in
          Task { @MainActor in
            // Don't swallow a save failure: if the token can't be
            // persisted the app silently keeps using whatever was
            // stored before (e.g. a stale token from before a
            // server rebuild), which surfaces as "bad signature"
            // 401s with no obvious cause.
            do {
              try await TokenStore.saveAsync(tokens, server: url)
            } catch {
              selfHostedSettingsLog.error(
                "failed to persist tokens for \(url.absoluteString, privacy: .public): \(error.localizedDescription, privacy: .public)"
              )
            }
            registry.register(url)
            sheetTarget = nil
            refreshSignedIn()
          }
        }
      )
    }
    #if os(iOS)
      .sheet(isPresented: $showsWatchPairing) { WatchPairingSheet() }
      .sheet(item: $pairSheetTarget) { target in
        switch target {
        case .pairing(let viewModel):
          PairAppleTVSheet(
            viewModel: viewModel,
            onDismiss: { pairSheetTarget = nil }
          )
        }
      }
    #endif
    #if !os(macOS)
      // ServerAdminView supplies its own NavigationStack on iOS, so a
      // sheet works identically from the iPhone push list and from the
      // iPad Settings modal (which has no stack to push onto).
      .sheet(item: $adminTarget) { target in
        ServerAdminView(server: target.server, session: sessionFor(target.server))
      }
    #endif
  }

  /// Title plus the add/pair actions, so the actions sit with the list
  /// they act on instead of pinned to the bottom of the pane. Falls back to
  /// a stacked layout when the row is too narrow (iPhone).
  private var header: some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        headerTitle
        Spacer(minLength: 12)
        headerActions
      }
      VStack(alignment: .leading, spacing: 8) {
        headerTitle
        HStack(spacing: 12) { headerActions }
      }
    }
  }

  private var headerTitle: some View {
    Text("Maple Cloud Servers")
      .font(.headline)
      .lineLimit(1)
      .fixedSize()
  }

  @ViewBuilder
  private var headerActions: some View {
    #if os(iOS)
      if WatchPhonePairing.isEntryEnabled, WCSession.isSupported() {
        Button("Connect Apple Watch…") { showsWatchPairing = true }
          .accessibilityLabel("Connect Apple Watch")
          .fixedSize()
      }
      Button("Pair Apple TV…") { pairSheetTarget = .pairing(PairAppleTVViewModel()) }
        .accessibilityLabel("Pair Apple TV")
        .fixedSize()
    #endif
    Button("Add Server…") { sheetTarget = .fresh }
      .keyboardShortcut("n", modifiers: .command)
      .fixedSize()
  }

  /// Name, addresses and actions share the server name's baseline; the
  /// per-server toggle spans the full row so its switch lines up with the
  /// row's trailing edge rather than floating mid-row.
  private func serverRow(_ url: URL) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        MuiIcon(name: "dns", size: .sm)
          .foregroundStyle(.secondary)
        VStack(alignment: .leading, spacing: 2) {
          Text(url.host ?? url.absoluteString)
          Text(url.absoluteString)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
          localAddressStatus(for: url)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        serverActions(url)
      }
      if signedIn[url] == true {
        ServerStackToggle(server: url, session: sessionFor(url))
      }
    }
  }

  @ViewBuilder
  private func serverActions(_ url: URL) -> some View {
    // Signed out (token cleared by a failed refresh, or a server signed
    // out) — offer a way back in (#1381).
    if signedIn[url] == false {
      Button("Sign In") {
        sheetTarget = .prefilled(CloudHost.signInPrefill(for: url))
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.small)
      .fixedSize()
    }
    // Per-server administration (#2766). Enabled only when definitively
    // signed in: `signedIn[url]` is nil until the Keychain check in `.task`
    // runs, and `!= true` keeps a tokenless admin window from opening in
    // that pending state. Sign In above deliberately uses `== false` so it
    // doesn't flash during the same window — the asymmetry is on purpose.
    Button("Manage…") {
      #if os(macOS)
        openWindow(id: "server-admin", value: url)
      #else
        adminTarget = AdminSheetTarget(server: url)
      #endif
    }
    .controlSize(.small)
    .fixedSize()
    .disabled(signedIn[url] != true)
    .accessibilityIdentifier("cloud.manage.\(url.host ?? url.absoluteString)")
    Button(role: .destructive) {
      registry.remove(url)
    } label: {
      MuiIcon(name: "delete", size: .sm)
    }
    .buttonStyle(.plain)
    .foregroundStyle(.red)
    .accessibilityLabel("Remove \(url.host ?? url.absoluteString)")
  }

  @ViewBuilder
  private func localAddressStatus(for server: URL) -> some View {
    if let status = localNetwork.status(for: server) {
      HStack(alignment: .firstTextBaseline, spacing: 5) {
        Circle()
          .fill(status.isConnectedLocally ? Color.green : Color.secondary)
          .frame(width: 7, height: 7)
          .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
        if let localURL = status.localURL {
          Text(
            "\(status.isConnectedLocally ? "Connected locally" : "Not connected locally") · \(localURL.absoluteString)"
          )
          .lineLimit(1)
          .truncationMode(.middle)
        } else {
          Text("No local address available")
        }
      }
      .font(.caption)
      .foregroundStyle(status.isConnectedLocally ? .primary : .secondary)
      .accessibilityElement(children: .combine)
    } else {
      Text("Checking local address…")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  private func refreshLocalAddresses() async {
    await withTaskGroup(of: Void.self) { group in
      for server in registry.servers {
        group.addTask {
          guard !Task.isCancelled else { return }
          await localNetwork.resolve(identity: server)
        }
      }
    }
  }

  /// Re-read Keychain token presence for every registered server.
  private func refreshSignedIn() {
    var map: [URL: Bool] = [:]
    for url in registry.servers {
      // Distinguish "no entry" (definitively signed out → offer Sign In)
      // from a transient Keychain read failure (locked Keychain /
      // errSecInteractionNotAllowed). On a read failure, assume signed in
      // so we don't flash a spurious Sign In button — mirrors the
      // transient-vs-definitive handling in AuthSession.bootstrapAndRestore.
      do {
        map[url] = try TokenStore.load(server: url) != nil
      } catch {
        map[url] = true
      }
    }
    signedIn = map
  }
}
