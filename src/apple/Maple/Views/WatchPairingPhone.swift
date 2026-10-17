#if os(iOS)
  import Foundation
  import MapleCore
  import Observation
  import WatchConnectivity
  import UIKit

  @MainActor
  @Observable
  final class WatchPhonePairing: NSObject {
    static let shared = WatchPhonePairing()

    private(set) var message = "Choose a server, then allow your Watch to connect."
    private(set) var busy = false
    private(set) var completed = false
    private(set) var hasPendingAttempt = false
    private(set) var authorizedServer: URL?
    private var sheetOpen = false
    private var generation = 0
    private let pending = WatchPairingPending()
    @ObservationIgnored private var pairingTask: Task<Void, Never>?

    var availableServers: [URL] {
      CloudServerRegistry.shared.servers.filter { (try? TokenStore.load(server: $0)) != nil }
    }

    func start() {
      guard WCSession.isSupported() else { return }
      WCSession.default.delegate = self
      WCSession.default.activate()
    }

    func open() {
      start()
      generation &+= 1
      sheetOpen = true
      completed = false
      authorizedServer = nil
      message = "Choose a server, then allow your Watch to connect."
      let current = generation
      Task {
        do {
          let record = try await pending.pending()
          guard current == generation, sheetOpen else { return }
          hasPendingAttempt = record != nil
          if let record {
            message =
              record.grant == nil
              ? WatchPairingPending.PairingError.uncertain.localizedDescription
              : "A pairing is waiting to finish. Select \(record.server.host ?? record.server.absoluteString), tap Allow Pairing, then retry on your Watch."
          }
        } catch {
          guard current == generation, sheetOpen else { return }
          message = "Unlock your iPhone to read the saved pairing attempt."
        }
      }
    }

    func close() {
      generation &+= 1
      sheetOpen = false
      authorizedServer = nil
      // Do not cancel a mint: retain any credentials the server already created.
    }

    func selectServer() {
      generation &+= 1
      authorizedServer = nil
      completed = false
      message = "Tap Allow Pairing for the selected server."
    }

    func allow(server: URL) {
      guard sheetOpen, !busy, availableServers.contains(server) else { return }
      guard WCSession.isSupported(), WCSession.default.isPaired,
        WCSession.default.isWatchAppInstalled
      else {
        message = "Install Maple on your paired Apple Watch first."
        return
      }
      generation &+= 1
      authorizedServer = server
      completed = false
      message = "Open Maple on your Watch and tap Connect to iPhone. Keep this screen open."
    }

    func resetAttempt() {
      guard !busy else { return }
      generation &+= 1
      let current = generation
      authorizedServer = nil
      busy = true
      Task {
        defer { busy = false }
        do {
          try await pending.clear()
          guard current == generation, sheetOpen else { return }
          hasPendingAttempt = false
          message = "Pairing attempt reset. Tap Allow Pairing, then retry on your Watch."
        } catch {
          guard current == generation, sheetOpen else { return }
          message = "Couldn't clear the saved attempt. Unlock your iPhone and try again."
        }
      }
    }

    private func authorized(server: URL, generation expected: Int) -> Bool {
      sheetOpen && UIApplication.shared.applicationState == .active
        && generation == expected && authorizedServer == server
        && availableServers.contains(server)
    }

    private func receive(_ data: Data, reply: @escaping (Data) -> Void) {
      guard let request = try? JSONDecoder().decode(WatchPairingMessage.self, from: data) else {
        respond(error: "Invalid Watch pairing request.", reply: reply)
        return
      }
      if request.kind == "ack" {
        let current = generation
        Task {
          do {
            let server = try await pending.acknowledge(id: request.requestID)
            if current == generation, sheetOpen, let server, authorizedServer == server {
              hasPendingAttempt = false
              completed = true
              authorizedServer = nil
              message = "Your Apple Watch is connected."
            }
            respond(reply: reply)
          } catch {
            respond(error: "Couldn't confirm pairing. Retry on your Watch.", reply: reply)
          }
        }
        return
      }
      guard request.kind == "pair", let server = authorizedServer,
        authorized(server: server, generation: generation)
      else {
        respond(
          error: WatchPairingPending.PairingError.authorizationEnded.localizedDescription,
          reply: reply)
        return
      }
      guard !busy else {
        respond(error: "Pairing is still in progress. Retry in a moment.", reply: reply)
        return
      }
      let current = generation
      busy = true
      message = "Connecting your Apple Watch…"
      pairingTask = Task {
        defer {
          busy = false
          pairingTask = nil
        }
        do {
          let grant = try await pending.grant(id: request.requestID, server: server) {
            [weak self] in
            self?.authorized(server: server, generation: current) == true
          }
          guard authorized(server: server, generation: current),
            WatchPairingPending.belongsToCurrentAccount(grant)
          else {
            respond(
              error: WatchPairingPending.PairingError.authorizationEnded.localizedDescription,
              reply: reply)
            return
          }
          hasPendingAttempt = true
          message = "Finishing setup on your Apple Watch…"
          respond(grant: grant, reply: reply)
        } catch {
          let record = try? await pending.pending()
          guard authorized(server: server, generation: current) else {
            respond(
              error: WatchPairingPending.PairingError.authorizationEnded.localizedDescription,
              reply: reply)
            return
          }
          hasPendingAttempt = record != nil
          if let pairingError = error as? WatchPairingPending.PairingError {
            message = pairingError.localizedDescription
          } else if record?.grant == nil && record != nil {
            message = WatchPairingPending.PairingError.uncertain.localizedDescription
          } else if let authError = error as? AuthClientError, authError.isAuthFailure {
            message = "Sign in to this server again on your iPhone, then retry pairing."
          } else {
            message = "Couldn't complete pairing. Check your connection and retry on your Watch."
          }
          respond(error: message, reply: reply)
        }
      }
    }

    private func respond(
      grant: WatchPairingGrant? = nil, error: String? = nil, reply: (Data) -> Void
    ) {
      // These values contain only strings, URL and UUID, so JSON encoding cannot fail.
      let response = WatchPairingReply(grant: grant, error: error)
      if let data = try? JSONEncoder().encode(response) { reply(data) }
    }
  }

  extension WatchPhonePairing: WCSessionDelegate {
    nonisolated func session(
      _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
      error: Error?
    ) {
      guard error != nil else { return }
      Task { @MainActor in
        guard sheetOpen else { return }
        message = "Couldn't connect to your Watch. Reopen this screen and try again."
      }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {
      Task { @MainActor in close() }
    }

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
      session.activate()
    }

    nonisolated func session(
      _ session: WCSession, didReceiveMessageData messageData: Data,
      replyHandler: @escaping (Data) -> Void
    ) {
      Task { @MainActor in receive(messageData, reply: replyHandler) }
    }
  }
#endif
