// PairAppleTVViewModel.swift
//
// Ticket #2082 (Maple TV epic, milestone C, task C4) — drives the iOS
// "Pair Apple TV" sheet in Settings → Cloud. Consumes MapleCloudKit's
// pairing transport (PairingQRPayload / PairingClient, from milestone B)
// plus AuthClient.mintDeviceSession to turn a scanned QR code into a
// device-scoped session the TV can use.
//
// State machine mirrors the brief: pickServer (skipped when exactly one
// signed-in server is registered) → scan → delivering → done/failed.
// Stale-guarded with a generation counter (docs/best-practices.md §
// "Generation counters for async state") so a slow mint/deliver round-trip
// from an abandoned attempt can't clobber a later retry's state.

import Foundation
import Observation
import MapleCore

@MainActor
@Observable
final class PairAppleTVViewModel {
  enum State: Equatable {
    /// No signed-in Maple Cloud server on this device — pairing is a dead
    /// end until the user signs in via "Add Server…" / "Sign In".
    case noServer
    /// More than one signed-in server is registered; the user must choose
    /// which one the TV should pair against.
    case pickServer
    /// Ready to scan (or paste) the TV's QR code.
    case scan
    /// Minting the device session + delivering the sealed grant to the TV.
    case delivering
    /// Pairing succeeded. Carries the (possibly user-renamed) device label
    /// shown on the TV's "Connected" screen.
    case done(deviceName: String)
    /// Pairing failed. `message` is already user-actionable copy — the view
    /// shows it verbatim.
    case failed(message: String)
  }

  private(set) var state: State
  /// Bound to the sheet's device-name field. Defaults to "Apple TV"; an
  /// empty/whitespace-only value falls back to that default at pair time
  /// rather than sending a blank label to the server.
  var deviceName: String = "Apple TV"
  private(set) var selectedServer: URL?

  private let registry: CloudServerRegistry
  private let mintClientFactory: @Sendable (URL) -> AuthClient

  /// Bumped on every `pair()`/`retry()` call; in-flight closures check this
  /// and drop stale writes.
  private var generation = 0

  init(
    registry: CloudServerRegistry = .shared,
    mintClientFactory: @escaping @Sendable (URL) -> AuthClient = { AuthClient(server: $0) }
  ) {
    self.registry = registry
    self.mintClientFactory = mintClientFactory
    let servers = Self.signedInServers(registry: registry)
    switch servers.count {
    case 0:
      self.state = .noServer
    case 1:
      self.state = .scan
      self.selectedServer = servers[0]
    default:
      self.state = .pickServer
    }
  }

  /// Registered servers with a live token on this device — the only valid
  /// pairing targets. A registered-but-signed-out server can't mint a
  /// device session, so it's excluded here rather than surfaced as a
  /// picker option that fails on selection.
  var availableServers: [URL] {
    Self.signedInServers(registry: registry)
  }

  func selectServer(_ url: URL) {
    selectedServer = url
    state = .scan
  }

  /// Runs the full handshake: load this device's own live tokens, mint a
  /// TV-scoped session from them, seal it to the TV's public key, and
  /// deliver it over the LAN. Any failure lands in `.failed` with copy the
  /// sheet can show directly — no raw error types escape to the view.
  func pair(payload: PairingQRPayload) async {
    guard let server = selectedServer else {
      state = .noServer
      return
    }

    generation &+= 1
    let gen = generation
    state = .delivering

    let trimmedName = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
    let label = trimmedName.isEmpty ? "Apple TV" : trimmedName

    do {
      guard let tokens = try TokenStore.load(server: server) else {
        guard gen == generation else { return }
        state = .failed(message: "You're not signed in on this device — sign in, then retry.")
        return
      }

      let client = mintClientFactory(server)
      let mint = try await client.mintDeviceSession(
        accessToken: tokens.access, refreshToken: tokens.refresh, label: label)
      guard gen == generation else { return }

      let grant = SealedPairingGrant(
        serverURL: server, accessToken: mint.access_token, refreshToken: mint.refresh_token,
        deviceName: label)
      try await PairingClient.deliver(grant: grant, to: payload)
      guard gen == generation else { return }

      state = .done(deviceName: label)
    } catch {
      guard gen == generation else { return }
      state = .failed(message: Self.message(for: error))
    }
  }

  /// Back to `.scan` for another attempt — the common case is a rescan
  /// (expired/used code), and the device-name field / selected server stay
  /// as the user left them.
  func retry() {
    generation &+= 1
    state = .scan
  }

  // MARK: - Error copy

  private static func message(for error: Error) -> String {
    if let authError = error as? AuthClientError {
      switch authError {
      case .unauthorized, .forbidden:
        return "Sign in on this device again, then retry."
      case .network:
        return "Couldn't reach the server — check your connection and try again."
      case .http, .decode:
        return "Something went wrong pairing with the server — try again."
      }
    }
    if let deliveryError = error as? PairingDeliveryError {
      switch deliveryError {
      case .rejected(let body):
        switch body {
        case "expired", "alreadyUsed", "badToken":
          return "The TV's code expired — generate a new one and rescan."
        default:
          return "The TV rejected the pairing code — generate a new one and rescan."
        }
      case .malformedResponse:
        return "Couldn't reach the TV — same Wi-Fi network?"
      case .invalidTVPublicKey:
        return "That doesn't look like a valid Apple TV pairing code — try scanning again."
      }
    }
    if error is URLError {
      return "Couldn't reach the TV — same Wi-Fi network?"
    }
    return "Something went wrong — try again."
  }

  // MARK: - Helpers

  private static func signedInServers(registry: CloudServerRegistry) -> [URL] {
    registry.servers.filter(isSignedIn)
  }

  private static func isSignedIn(_ server: URL) -> Bool {
    ((try? TokenStore.load(server: server)) ?? nil) != nil
  }
}
