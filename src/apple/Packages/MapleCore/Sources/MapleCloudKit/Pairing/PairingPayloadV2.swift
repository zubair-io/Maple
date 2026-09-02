// src/apple/Packages/MapleCore/Sources/MapleCloudKit/Pairing/PairingPayloadV2.swift
import Foundation

/// Wire format 2 (#2137): binary-packed fields, base32-encoded, instead of
/// JSON base64url-encoded. JSON's key names/quotes and base64url's double
/// encoding (a `Data` field base64s once via `JSONEncoder`, then the whole
/// blob base64urls again) both waste QR capacity on a payload whose shape
/// never varies — see the ticket for the measured before/after.
///
/// Layout, 71 bytes total, big-endian where multi-byte:
/// `version(1) | ipv4(4) | port(2) | token(32, raw) | tvPublicKey(32, raw)`.
/// `ip` must be a dotted-quad IPv4 address (the TV's `primaryIPv4Address()`
/// only ever produces one); `token`/`tvPublicKey` must be the fixed 32-byte
/// lengths `TVPairingSession` generates. Every production call site
/// controls those values, so a throw from `qrStringV2()` means a real bug
/// upstream, not untrusted input — untrusted input is `parseV2`'s problem,
/// and it never throws.
public enum PairingPayloadV2EncodingError: Error, Equatable, Sendable {
  case invalidIPv4Address
  case invalidTokenLength
  case invalidPublicKeyLength
}

extension PairingQRPayload {
  static let v2VersionByte: UInt8 = 2
  private static let v2IPv4ByteCount = 4
  private static let v2TokenByteCount = 32
  private static let v2PublicKeyByteCount = 32
  private static let v2TotalByteCount = 1 + v2IPv4ByteCount + 2 + v2TokenByteCount + v2PublicKeyByteCount

  /// The v2 QR string: binary-pack the fields, then base32-encode.
  public func qrStringV2() throws -> String {
    guard let ipOctets = Self.packIPv4(ip) else {
      throw PairingPayloadV2EncodingError.invalidIPv4Address
    }
    // `token` is stored as the base64url string `TVPairingSession` already
    // produces (the same field v1 uses) — decode it back to raw bytes for
    // binary packing rather than generating/threading a second
    // representation through the session.
    guard let tokenData = Data(base64URLEncoded: token), tokenData.count == Self.v2TokenByteCount else {
      throw PairingPayloadV2EncodingError.invalidTokenLength
    }
    guard tvPublicKey.count == Self.v2PublicKeyByteCount else {
      throw PairingPayloadV2EncodingError.invalidPublicKeyLength
    }
    var bytes = Data(capacity: Self.v2TotalByteCount)
    bytes.append(Self.v2VersionByte)
    bytes.append(contentsOf: ipOctets)
    bytes.append(UInt8((port >> 8) & 0xFF))
    bytes.append(UInt8(port & 0xFF))
    bytes.append(tokenData)
    bytes.append(tvPublicKey)
    return Base32.encode(bytes)
  }

  /// The exact inverse of `qrStringV2()`. `nil` — never throws — on
  /// malformed base32, the wrong decoded length, or a version byte other
  /// than `2`: same "untrusted camera input" contract as `parse(_:)`, which
  /// tries this first and falls back to v1 on `nil`.
  static func parseV2(_ s: String) -> PairingQRPayload? {
    guard let bytes = Base32.decode(s), bytes.count == v2TotalByteCount else { return nil }
    guard bytes[0] == v2VersionByte else { return nil }
    let ip = bytes[1...4].map { String($0) }.joined(separator: ".")
    let port = (UInt16(bytes[5]) << 8) | UInt16(bytes[6])
    let tokenData = Data(bytes[7..<39])
    let publicKeyData = Data(bytes[39..<71])
    return PairingQRPayload(
      v: 2,
      ip: ip,
      port: port,
      token: tokenData.base64URLEncodedString(),
      tvPublicKey: publicKeyData
    )
  }

  /// Parses a dotted-quad IPv4 string (`"192.168.1.5"`) into its 4 raw
  /// octets. `nil` on anything else — IPv6, a hostname, malformed input.
  private static func packIPv4(_ ip: String) -> [UInt8]? {
    let parts = ip.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return nil }
    var octets: [UInt8] = []
    octets.reserveCapacity(4)
    for part in parts {
      guard let value = UInt8(part) else { return nil }
      octets.append(value)
    }
    return octets
  }
}
