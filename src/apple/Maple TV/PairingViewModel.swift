// src/apple/Maple TV/PairingViewModel.swift
import Darwin
import Foundation
import MapleCloudKit
import Observation

/// Drives the pairing screen: owns one `TVPairingSession` + one
/// `TVPairingListener` at a time, renders the pair as a QR/manual code,
/// regenerates on a 5-minute expiry, and — on a successful redeem —
/// validates the sealed grant against the server before persisting
/// anything. `@MainActor` because every property here feeds SwiftUI and
/// `onPaired` runs off the listener's private serial queue.
@MainActor
@Observable
final class PairingViewModel {
  enum Phase: Equatable {
    case idle
    case ready(qrString: String, expiresAt: Date)
    case failed(String)
  }

  private static let codeLifetime: TimeInterval = 5 * 60

  private(set) var phase: Phase = .idle

  private let onPaired: () -> Void
  private let now: () -> Date

  private var session: TVPairingSession?
  private var listener: TVPairingListener?
  private var expiryTask: Task<Void, Never>?

  init(onPaired: @escaping () -> Void, now: @escaping () -> Date = Date.init) {
    self.onPaired = onPaired
    self.now = now
  }

  /// (Re)starts a pairing attempt: tears down any previous session/listener,
  /// mints a fresh `TVPairingSession`, binds a fresh `TVPairingListener`,
  /// and composes the payload actually shown to the user.
  ///
  /// The composed payload is NOT `session.qrPayload` verbatim — per the C2
  /// review, `session.qrPayload.port` is whatever placeholder port the
  /// session was constructed with, not the listener's real bound port
  /// (`NWListener` binds `.any` and the OS assigns the port at `start()`).
  /// Using the session's port here would produce a QR code phones can
  /// never connect through.
  func start() {
    stop()

    guard let ip = Self.primaryIPv4Address() else {
      phase = .failed(
        "Couldn't find this Apple TV's network address. Make sure it's connected to Wi-Fi or Ethernet, then try again."
      )
      return
    }

    let session = TVPairingSession(ip: ip, port: 0, now: now)
    let listener = TVPairingListener(session: session) { [weak self] grant in
      Task { @MainActor in
        self?.handlePaired(grant)
      }
    }
    self.session = session
    self.listener = listener

    do {
      let boundPort = try listener.start()
      let payload = PairingQRPayload(
        v: 1,
        ip: ip,
        port: boundPort,
        token: session.qrPayload.token,
        tvPublicKey: session.qrPayload.tvPublicKey
      )
      let qrString = try payload.qrString()
      let expiresAt = now().addingTimeInterval(Self.codeLifetime)
      phase = .ready(qrString: qrString, expiresAt: expiresAt)
      scheduleExpiry(at: expiresAt)
    } catch {
      self.listener = nil
      self.session = nil
      phase = .failed("Couldn't start the pairing listener: \(error.localizedDescription)")
    }
  }

  func stop() {
    expiryTask?.cancel()
    expiryTask = nil
    listener?.stop()
    listener = nil
    session = nil
  }

  private func scheduleExpiry(at expiresAt: Date) {
    expiryTask?.cancel()
    expiryTask = Task { [weak self] in
      guard let self else { return }
      let interval = expiresAt.timeIntervalSince(self.now())
      if interval > 0 {
        try? await Task.sleep(nanoseconds: UInt64(max(interval, 0) * 1_000_000_000))
      }
      guard !Task.isCancelled else { return }
      self.start()
    }
  }

  /// Runs on a successful listener redeem. The redeem itself (token
  /// match, expiry, single-use, decryption) already happened inside
  /// `TVPairingSession`; this validates the resulting credentials
  /// actually work against the real server before the TV commits to
  /// them — an attacker who somehow produced a well-formed sealed grant
  /// for the wrong server should fail here, not silently register.
  private func handlePaired(_ grant: SealedPairingGrant) {
    expiryTask?.cancel()
    expiryTask = nil
    Task {
      do {
        let client = AuthClient(server: grant.serverURL)
        let me = try await client.me(accessToken: grant.accessToken)
        try TokenStore.save(
          AuthTokens(access: grant.accessToken, refresh: grant.refreshToken),
          server: grant.serverURL
        )
        AuthUserCache.save(me.user, server: grant.serverURL)
        CloudServerRegistry.shared.register(grant.serverURL)
        CloudServerRegistry.shared.setDisplayName(grant.deviceName, for: grant.serverURL)
        onPaired()
      } catch {
        phase = .failed("Pairing didn't validate: \(error.localizedDescription)")
        start()
      }
    }
  }

  // MARK: - LAN address discovery

  /// The device's LAN IPv4 address on `en0` (Apple TV's primary network
  /// interface, Wi-Fi or Ethernet depending on model/configuration) — the
  /// address a phone on the same network needs to open a TCP connection
  /// back to the pairing listener. Falls back to the first up,
  /// non-loopback IPv4 interface if `en0` isn't present, since some
  /// configurations (e.g. certain simulators) don't expose it under that
  /// name.
  private static func primaryIPv4Address() -> String? {
    var ifaddrPointer: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddrPointer) == 0 else { return nil }
    defer { freeifaddrs(ifaddrPointer) }

    let candidates = Self.ipv4Candidates(from: ifaddrPointer)
    return candidates.first { $0.name == "en0" }?.address ?? candidates.first?.address
  }

  private static func ipv4Candidates(
    from head: UnsafeMutablePointer<ifaddrs>?
  ) -> [(name: String, address: String)] {
    var results: [(name: String, address: String)] = []
    var cursor = head
    while let current = cursor {
      let interface = current.pointee
      cursor = interface.ifa_next

      let flags = Int32(interface.ifa_flags)
      guard flags & IFF_UP == IFF_UP, flags & IFF_LOOPBACK == 0 else { continue }
      guard let addrPointer = interface.ifa_addr,
        addrPointer.pointee.sa_family == UInt8(AF_INET)
      else { continue }

      var hostBuffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      let status = getnameinfo(
        addrPointer, socklen_t(addrPointer.pointee.sa_len),
        &hostBuffer, socklen_t(hostBuffer.count),
        nil, 0, NI_NUMERICHOST
      )
      guard status == 0 else { continue }

      let name = String(cString: interface.ifa_name)
      let address = String(cString: hostBuffer)
      results.append((name: name, address: address))
    }
    return results
  }
}
