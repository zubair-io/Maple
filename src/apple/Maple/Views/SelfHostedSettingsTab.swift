// SelfHostedSettingsTab.swift — Maple Cloud server management.
//
// Extracted from MapleApp.swift (was a `private struct`) by responsive-
// program S8 (#1903) so both the Mac/iPad `SettingsView` modal and the
// iPhone `PhoneSettingsView` push list can instantiate it.

import SwiftUI
import OSLog
import MapleCore

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
    /// Single sheet entry point. `.fresh` for "Add Server…", `.prefilled(host)`
    /// for a per-server "Sign In" (#1381).
    @State private var sheetTarget: AddCloudSheetTarget?
    /// Parallel sheet trigger for "Pair Apple TV…" (#2082) — see
    /// `PairSheetTarget`.
    #if os(iOS)
    @State private var pairSheetTarget: PairSheetTarget?
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

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Maple Cloud Servers")
                .font(.headline)
                // #1954: this header sits outside the `List` below, so on
                // iOS it never picked up the `.listRowBackground(surface)`
                // that #1908 gave every row on this and every other
                // Settings sub-screen — it rendered flat against the page
                // `bg`, breaking parity with Backup/About. macOS keeps its
                // native pane look (`mapleSettingsBackground()` is already
                // a no-op there), so this is iOS-only.
                #if os(iOS)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(MapleTokens.Spacing.rowHorizontal)
                .background(MapleTokens.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                #endif

            if registry.servers.isEmpty {
                VStack(spacing: 6) {
                    Text("No paired servers.")
                        .foregroundStyle(.secondary)
                    Text("Click \"Add Server…\" to pair a Maple Cloud instance.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
                // Same #1954 fix as the header above — the empty state is
                // the only content on screen until a server is paired, so
                // without this it's the most visible instance of the gap.
                #if os(iOS)
                .background(MapleTokens.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                #endif
            } else {
                List {
                    ForEach(registry.servers, id: \.self) { url in
                        HStack {
                            Image(systemName: "server.rack")
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(url.host ?? url.absoluteString)
                                Text(url.absoluteString)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                localAddressStatus(for: url)
                            }
                            Spacer()
                            // Signed out (token cleared by a failed refresh, or
                            // a server signed out) — offer a way back in (#1381).
                            if signedIn[url] == false {
                                Button("Sign In") {
                                    sheetTarget = .prefilled(url.host ?? url.absoluteString)
                                }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.small)
                            }
                            // Per-server administration (#2766). Enabled only
                            // when definitively signed in: `signedIn[url]` is
                            // nil until the Keychain check in `.task` runs, and
                            // `== false` would treat that pending state as
                            // signed-in and let a tokenless admin window open.
                            // Note the Sign In button above deliberately keeps
                            // `== false` — it must NOT flash during the same
                            // pending window, so the two guards are asymmetric
                            // on purpose.
                            Button("Manage…") {
                                #if os(macOS)
                                openWindow(id: "server-admin", value: url)
                                #else
                                adminTarget = AdminSheetTarget(server: url)
                                #endif
                            }
                            .controlSize(.small)
                            .disabled(signedIn[url] != true)
                            .accessibilityIdentifier("cloud.manage.\(url.host ?? url.absoluteString)")
                            Button(role: .destructive) {
                                registry.remove(url)
                            } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.red)
                        }
                        .padding(.vertical, 2)
                        .listRowBackground(MapleTokens.surface)
                    }
                }
                .listStyle(.inset)
                .mapleSettingsBackground()
                .frame(minHeight: 120)
            }

            Spacer()

            HStack {
                Spacer()
                #if os(iOS)
                Button("Pair Apple TV…") { pairSheetTarget = .pairing(PairAppleTVViewModel()) }
                    .accessibilityLabel("Pair Apple TV")
                #endif
                Button("Add Server…") { sheetTarget = .fresh }
                    .keyboardShortcut("n", modifiers: .command)
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
                            try TokenStore.save(tokens, server: url)
                        } catch {
                            selfHostedSettingsLog.error("failed to persist tokens for \(url.absoluteString, privacy: .public): \(error.localizedDescription, privacy: .public)")
                        }
                        registry.register(url)
                        sheetTarget = nil
                        refreshSignedIn()
                    }
                }
            )
        }
        #if os(iOS)
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

    @ViewBuilder
    private func localAddressStatus(for server: URL) -> some View {
        if let status = localNetwork.status(for: server) {
            HStack(spacing: 5) {
                Circle()
                    .fill(status.isConnectedLocally ? Color.green : Color.secondary)
                    .frame(width: 7, height: 7)
                if let localURL = status.localURL {
                    Text("\(localURL.absoluteString) · \(status.isConnectedLocally ? "Connected locally" : "Not connected locally")")
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
