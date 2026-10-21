#if os(watchOS)
  import Foundation
  import Observation
  import WatchConnectivity

  /// Owns the single Watch login. Requests are explicitly initiated on the Watch;
  /// a late reply after disconnect, cancellation or a new attempt cannot sign in.
  @MainActor
  @Observable
  public final class WatchPairingClient: NSObject, WCSessionDelegate {
    public static let shared = WatchPairingClient()
    public private(set) var server: URL?
    public private(set) var isConnecting = false
    public private(set) var message: String?

    private var attempt = WatchPairingAttempt()
    private let defaults = UserDefaults.standard
    private let serverKey = "watch.pairedServer"
    private let requestKey = "watch.pairingRequestID"
    private let receiptKey = "watch.pairingReceiptID"

    private override init() {
      super.init()
      if let value = defaults.string(forKey: serverKey), let url = URL(string: value),
        (try? TokenStore.load(server: url)) != nil
      {
        server = url
        defaults.removeObject(forKey: requestKey)
      }
    }

    public func start() {
      // Keychain can be unavailable during launch while the Watch is locked.
      // Reconcile on foreground before allowing another pairing to replace it.
      if server == nil, let value = defaults.string(forKey: serverKey),
        let url = URL(string: value), (try? TokenStore.load(server: url)) != nil
      {
        server = url
        defaults.removeObject(forKey: requestKey)
      }
      guard WCSession.isSupported() else {
        message = "Pair this Watch with an iPhone to connect Maple."
        return
      }
      let session = WCSession.default
      session.delegate = self
      session.activate()
    }

    public func connect() {
      guard server == nil, !isConnecting else { return }
      let session = WCSession.default
      if session.activationState != .activated { start() }
      guard server == nil else { return }
      guard session.activationState == .activated, session.isReachable else {
        message =
          "Open Maple on your iPhone and choose Connect Apple Watch in Self Hosted settings."
        return
      }
      let id = defaults.string(forKey: requestKey).flatMap(UUID.init(uuidString:)) ?? UUID()
      defaults.set(id.uuidString, forKey: requestKey)
      attempt.begin(id: id)
      let current = attempt.generation
      isConnecting = true
      message = nil
      do {
        let data = try JSONEncoder().encode(WatchPairingMessage(kind: "pair", requestID: id))
        session.sendMessageData(
          data,
          replyHandler: { [weak self] reply in
            Task { @MainActor in self?.accept(reply, id: id, generation: current) }
          },
          errorHandler: { [weak self] _ in
            Task { @MainActor in
              guard let self, self.attempt.accepts(id: id, generation: current) else { return }
              self.isConnecting = false
              self.message = "Couldn't reach your iPhone. Keep both apps open and try again."
            }
          })
      } catch {
        isConnecting = false
        message = "Couldn't start pairing. Try again."
      }
    }

    public func cancel() {
      attempt.cancel()
      isConnecting = false
      defaults.removeObject(forKey: requestKey)
      message = nil
    }

    /// Retains no request nonce, so a reply in flight cannot restore this login.
    public func disconnect() {
      cancel()
      if let server {
        // Reserved now, so a re-pair saved before this clear runs is kept and a
        // refresh finishing after it is dropped; async, so the UI never waits on
        // the refresh lock.
        let generation = TokenStore.reserveMutationGeneration(for: server)
        Task { await TokenStore.clearAsync(server: server, generation: generation) }
      }
      server = nil
      defaults.removeObject(forKey: serverKey)
      defaults.removeObject(forKey: receiptKey)
    }

    private func accept(_ data: Data, id: UUID, generation current: Int) {
      guard attempt.accepts(id: id, generation: current), server == nil,
        defaults.string(forKey: requestKey) == id.uuidString
      else { return }
      isConnecting = false
      do {
        let reply = try JSONDecoder().decode(WatchPairingReply.self, from: data)
        guard let grant = reply.grant else {
          message = reply.error ?? "Allow pairing in Maple on your iPhone, then try again."
          return
        }
        guard grant.id == id, grant.isValid else {
          message = "The pairing response wasn't valid. Try again."
          return
        }
        // Record the server first: if the process exits after the keychain write,
        // bootstrap finds those credentials and never reinstalls the original pair.
        defaults.set(grant.server.absoluteString, forKey: serverKey)
        defaults.set(id.uuidString, forKey: receiptKey)
        try TokenStore.save(grant.tokens, server: grant.server)
        defaults.removeObject(forKey: requestKey)
        server = grant.server
        attempt.cancel()
        message = nil
        acknowledge()
      } catch {
        // Without saved credentials, a recorded server could adopt older ones still
        // in the keychain on the next launch.
        defaults.removeObject(forKey: serverKey)
        defaults.removeObject(forKey: receiptKey)
        message = "Couldn't securely save the connection. Try again."
      }
    }

    private func acknowledge() {
      guard server != nil, WCSession.default.isReachable,
        let value = defaults.string(forKey: receiptKey), let id = UUID(uuidString: value),
        let data = try? JSONEncoder().encode(WatchPairingMessage(kind: "ack", requestID: id))
      else { return }
      WCSession.default.sendMessageData(
        data,
        replyHandler: { [weak self] data in
          guard let reply = try? JSONDecoder().decode(WatchPairingReply.self, from: data),
            reply.error == nil
          else { return }
          Task { @MainActor in
            guard let self, self.defaults.string(forKey: self.receiptKey) == value else { return }
            self.defaults.removeObject(forKey: self.receiptKey)
          }
        },
        errorHandler: { _ in
          // Keep the receipt for the next activation/reachability callback.
        })
    }

    nonisolated public func session(
      _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
      error: Error?
    ) {
      Task { @MainActor in
        if error != nil {
          message = "Couldn't connect to the iPhone. Try opening Maple on both devices."
        }
        acknowledge()
      }
    }

    nonisolated public func sessionReachabilityDidChange(_ session: WCSession) {
      Task { @MainActor in acknowledge() }
    }
  }
#endif
