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
import OSLog
import MapleCore

private let pairAppleTVLog = Logger(subsystem: "app.justmaple.aperture", category: "PairAppleTV")

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
  /// rather than sending a blank label to the server. Edited after a failed
  /// delivery invalidates any held `pendingMint` — it was minted under the
  /// old label.
  var deviceName: String = "Apple TV" {
    didSet {
      guard deviceName != oldValue else { return }
      pendingMint = nil
    }
  }
  private(set) var selectedServer: URL?

  private let registry: CloudServerRegistry
  private let mintClientFactory: @Sendable (URL) -> AuthClient

  /// Bumped on every `pair()`/`retry()` call; in-flight closures check this
  /// and drop stale writes.
  private var generation = 0

  /// A mint that succeeded but whose delivery to the TV then failed —
  /// retained so a same-server, same-label retry redelivers this credential
  /// instead of minting a fresh one. Minting on every retry would leave a
  /// live, orphaned "Apple TV" device session server-side for each flake;
  /// the phone can't revoke it (DELETE is step-up-gated), so each accumulates
  /// until someone finds it in web Settings → Account and removes it by
  /// hand — that panel remains the v1 cleanup path for anything this cache
  /// doesn't catch. Cleared on success, or when the server/label changes
  /// (a stale mint is scoped to the label/server it was minted for).
  private var pendingMint: (server: URL, label: String, mint: DeviceSessionMint)?

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
    if url != selectedServer {
      pendingMint = nil
    }
    selectedServer = url
    state = .scan
  }

  /// Runs the full handshake: refresh this device's own live tokens (an
  /// access token can be up to 15 minutes stale by the time the user
  /// actually scans a TV's code, and this flow has no proactive refresh —
  /// minting with a stale token 401s and, without this step, every retry
  /// re-reads the same stale token from disk and 401s again), mint a
  /// TV-scoped session from the rotated pair, seal it to the TV's public
  /// key, and deliver it over the LAN. Any failure lands in `.failed` with
  /// copy the sheet can show directly — no raw error types escape to the
  /// view.
  func pair(payload: PairingQRPayload) async {
    // Cheap in-flight guard: closes the double-submission window at the
    // source (paste "Pair" has no button-disable of its own) rather than
    // relying solely on the generation counter to sort out the race
    // downstream (C4 re-review).
    guard state != .delivering else { return }

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
      guard let stored = try TokenStore.load(server: server) else {
        guard gen == generation else { return }
        state = .failed(message: "You're not signed in on this device — sign in, then retry.")
        return
      }

      let client = mintClientFactory(server)

      let mint: DeviceSessionMint
      if let held = pendingMint, held.server == server, held.label == label {
        // A previous attempt for this exact server+label already minted a
        // device session but failed to deliver it — reuse that mint rather
        // than minting another one. Minting on every retry would leave a
        // live, orphaned "Apple TV" credential server-side per flake, and
        // the phone can't revoke it (DELETE is step-up-gated); the v1
        // cleanup path for anything this cache doesn't catch is the web
        // Settings → Account panel, where abandoned sessions stay visible
        // and revocable.
        mint = held.mint
      } else {
        let refreshed: AuthTokens
        do {
          refreshed = try await client.refreshTokens(refreshToken: stored.refresh)
        } catch {
          guard gen == generation else { return }
          state = .failed(message: Self.refreshFailureMessage(for: error))
          return
        }
        // Persist the rotated pair IMMEDIATELY and UNCONDITIONALLY — the
        // server has already invalidated `stored.refresh`, so any error (or
        // stale-generation return) between here and the next successful
        // save would otherwise strand the on-disk copy on a dead token (see
        // AuthClient.refreshTokens doc comment). Server-committed state must
        // never be discarded by a stale-task guard (C4 re-review): this
        // write happens whether or not `gen` is still current, and a save
        // failure doesn't abort this attempt either (the in-memory
        // `refreshed` pair is still good for the mint call below) — it's
        // logged so a silently-stale Keychain entry isn't a total mystery
        // later.
        do {
          try TokenStore.save(refreshed, server: server)
        } catch {
          pairAppleTVLog.error("failed to persist refreshed tokens for \(server.absoluteString, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }

        // The just-rotated refresh token is this device's live primary
        // token — exactly what the server's mint-proof check wants (see
        // AuthClient.mintDeviceSession doc comment).
        mint = try await client.mintDeviceSession(
          accessToken: refreshed.access, refreshToken: refreshed.refresh, label: label)
        // Same unconditional-persistence reasoning as the token save above:
        // cache the mint BEFORE the generation check, or a stale task would
        // leave a truly untracked orphaned device session server-side
        // (C4 re-review).
        pendingMint = (server: server, label: label, mint: mint)
        guard gen == generation else { return }
      }

      let grant = SealedPairingGrant(
        serverURL: server, accessToken: mint.access_token, refreshToken: mint.refresh_token,
        deviceName: label)
      try await PairingClient.deliver(grant: grant, to: payload)
      guard gen == generation else { return }

      pendingMint = nil
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

  /// Distinct copy for a failed `refreshTokens` call — unlike a mint or
  /// delivery failure, a 401/unauthorized here means the refresh token
  /// itself is dead, so "retry" genuinely can't succeed without a fresh
  /// sign-in; the generic `message(for:)` copy ("sign in again, then
  /// retry") would be a lie in this specific spot, since Try Again just
  /// re-attempts the same doomed refresh.
  private static func refreshFailureMessage(for error: Error) -> String {
    if let authError = error as? AuthClientError {
      switch authError {
      case .unauthorized, .forbidden:
        return "Your session on this device has expired — sign in again from Settings → Cloud."
      case .network:
        return "Couldn't reach the server — check your connection and try again."
      case .http, .decode:
        return "Something went wrong pairing with the server — try again."
      }
    }
    if error is URLError {
      return "Couldn't reach the server — check your connection and try again."
    }
    return "Something went wrong — try again."
  }

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
    // Distinguish "no entry" (definitively signed out) from a transient
    // Keychain read failure (locked Keychain / errSecInteractionNotAllowed).
    // On a read failure, assume signed in so a paired server doesn't
    // spuriously drop out of the picker — mirrors
    // SelfHostedSettingsTab.refreshSignedIn's transient-vs-definitive
    // handling (itself mirroring AuthSession.bootstrapAndRestore).
    do {
      return try TokenStore.load(server: server) != nil
    } catch {
      return true
    }
  }
}
