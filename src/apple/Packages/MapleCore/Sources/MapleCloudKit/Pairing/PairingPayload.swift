// src/apple/Packages/MapleCore/Sources/MapleCloudKit/Pairing/PairingPayload.swift
import Foundation

/// The payload encoded into the QR code the TV shows during pairing. `v` is a
/// wire-format version gate — `parse` rejects anything that isn't exactly `1`,
/// so a future format change can ship a new version without a phone on the old
/// app version silently misinterpreting the fields.
public struct PairingQRPayload: Codable, Equatable, Sendable {
  public let v: Int
  public let ip: String
  public let port: UInt16
  public let token: String
  public let tvPublicKey: Data

  public init(v: Int, ip: String, port: UInt16, token: String, tvPublicKey: Data) {
    self.v = v
    self.ip = ip
    self.port = port
    self.token = token
    self.tvPublicKey = tvPublicKey
  }

  /// Compact, stable-ordered JSON (`.sortedKeys`, so the same payload always
  /// produces the same QR image — useful for tests and for not re-rendering
  /// the code on every redraw) base64url-encoded (no padding) for QR capacity.
  public func qrString() throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(self)
    return data.base64URLEncodedString()
  }

  /// The exact inverse of `qrString()`. Returns `nil` — never throws — on
  /// malformed base64url, malformed JSON, or a version other than `1`: a
  /// scanned QR code is untrusted input from a camera, so every failure mode
  /// collapses to "not a valid pairing code" for the caller.
  public static func parse(_ s: String) -> PairingQRPayload? {
    guard let data = Data(base64URLEncoded: s) else { return nil }
    guard let payload = try? JSONDecoder().decode(PairingQRPayload.self, from: data) else { return nil }
    guard payload.v == 1 else { return nil }
    return payload
  }
}

/// The credentials the TV receives once pairing succeeds — everything it needs
/// to talk to the server as its own device-scoped session. Sealed in transit
/// by `PairingCrypto`; never sent or stored in the clear.
public struct SealedPairingGrant: Codable, Equatable, Sendable {
  public let serverURL: URL
  public let accessToken: String
  public let refreshToken: String
  public let deviceName: String

  public init(serverURL: URL, accessToken: String, refreshToken: String, deviceName: String) {
    self.serverURL = serverURL
    self.accessToken = accessToken
    self.refreshToken = refreshToken
    self.deviceName = deviceName
  }
}

extension Data {
  /// Base64url (RFC 4648 §5) with padding stripped — safe inside a QR string
  /// and a URL path/query without percent-escaping `+`, `/`, or `=`.
  func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// The exact inverse of `base64URLEncodedString()` — restores the alphabet
  /// and re-pads to a multiple of 4 before handing off to the standard decoder.
  init?(base64URLEncoded s: String) {
    let restored = s
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    let remainder = restored.count % 4
    let padded = remainder == 0 ? restored : restored + String(repeating: "=", count: 4 - remainder)
    self.init(base64Encoded: padded)
  }
}
