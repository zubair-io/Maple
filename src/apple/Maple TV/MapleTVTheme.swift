// src/apple/Maple TV/MapleTVTheme.swift
import SwiftUI

/// Maple's dark palette, ported locally for tvOS. MapleCloudKit is
/// deliberately UI-framework-free (no SwiftUI import — see the
/// portability guard test), so these tokens can't live there; they're a
/// small, local restatement of the same values other Maple UIs use, not a
/// generalized cross-platform token system (that's `codegen`'s job for
/// values shared across three languages — not worth it for six colors
/// used by one tvOS target).
enum MapleTVTheme {
  static let background = Color(red: 0x1c / 255, green: 0x19 / 255, blue: 0x17 / 255)
  static let surface = Color(red: 0x26 / 255, green: 0x25 / 255, blue: 0x24 / 255)
  static let border = Color(red: 0x44 / 255, green: 0x40 / 255, blue: 0x3c / 255)
  static let textPrimary = Color(red: 0xe7 / 255, green: 0xe5 / 255, blue: 0xe4 / 255)
  static let textMuted = Color(red: 0xa8 / 255, green: 0xa2 / 255, blue: 0x9e / 255)
  static let primary = Color(red: 0xc4 / 255, green: 0x49 / 255, blue: 0x3a / 255)
  /// Star-rating gold, used by the Timeline cell's focused caption
  /// (#2102).
  static let star = Color(red: 0xef / 255, green: 0x9f / 255, blue: 0x27 / 255)
}
