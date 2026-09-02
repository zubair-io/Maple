// src/apple/Packages/MapleCore/Sources/MapleCloudKit/Pairing/Base32.swift
import Foundation

/// RFC 4648 base32 (uppercase, alphabet `A-Z2-7`), no padding characters —
/// #2137's v2 pairing QR payload is fixed-length, so the decoder always
/// knows exactly how many bytes to expect and never needs `=` padding to
/// find the end of the data.
///
/// Base32 over base64url here isn't about density (base32 is *less* dense —
/// 5 bits/char vs 6) — it's about QR encoding modes. base64url is mixed-case
/// plus `-`/`_`, which forces the QR spec's 8-bit-per-char byte mode.
/// Uppercase base32's alphabet is a subset of QR's alphanumeric charset
/// (`A-Z0-9 $%*+-./:`), which packs 2 characters into 11 bits — dense enough
/// that base32's extra characters (114 vs 95 for the same payload) still
/// produce a *smaller* QR symbol than base64url's byte mode would.
enum Base32 {
  private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
  private static let reverseAlphabet: [Character: UInt8] = {
    var map: [Character: UInt8] = [:]
    for (index, char) in alphabet.enumerated() {
      map[char] = UInt8(index)
    }
    return map
  }()

  /// Packs `data` 5 bits at a time (MSB-first) into base32 characters. The
  /// final partial group (1-4 leftover bits) is left-shifted to fill out a
  /// full 5-bit slot — the standard base32 tail-padding-within-the-symbol
  /// behavior, just without the trailing `=` characters this fixed-length
  /// payload doesn't need.
  static func encode(_ data: Data) -> String {
    var result = ""
    result.reserveCapacity((data.count * 8 + 4) / 5)
    var buffer: UInt64 = 0
    var bitsInBuffer = 0
    for byte in data {
      buffer = (buffer << 8) | UInt64(byte)
      bitsInBuffer += 8
      while bitsInBuffer >= 5 {
        bitsInBuffer -= 5
        let index = Int((buffer >> UInt64(bitsInBuffer)) & 0x1F)
        result.append(alphabet[index])
      }
    }
    if bitsInBuffer > 0 {
      let index = Int((buffer << (5 - bitsInBuffer)) & 0x1F)
      result.append(alphabet[index])
    }
    return result
  }

  /// The exact inverse of `encode(_:)`. Returns `nil` on any character
  /// outside the alphabet — case-sensitive, so lowercase is rejected. That's
  /// deliberate: it's what lets `PairingQRPayload.parse` try base32 first
  /// and fall through to v1's base64url+JSON on failure without ambiguity —
  /// real base64url output is virtually certain to contain a lowercase
  /// letter, `-`, or `_`, none of which are valid base32 characters, so a v1
  /// string can never be mistaken for v2.
  static func decode(_ s: String) -> Data? {
    var buffer: UInt64 = 0
    var bitsInBuffer = 0
    var bytes: [UInt8] = []
    bytes.reserveCapacity(s.count * 5 / 8)
    for char in s {
      guard let value = reverseAlphabet[char] else { return nil }
      buffer = (buffer << 5) | UInt64(value)
      bitsInBuffer += 5
      if bitsInBuffer >= 8 {
        bitsInBuffer -= 8
        bytes.append(UInt8((buffer >> UInt64(bitsInBuffer)) & 0xFF))
      }
    }
    return Data(bytes)
  }
}
