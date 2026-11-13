// LightTablePalette.swift
//
// The Light Table's colours, in a light and a dark variant that follow the
// system appearance. The light variant is the original warm paper under a
// lamp. MapleCloudKit cannot reach the generated Maple UI tokens, so each app
// builds its dark variant from the tokens it already has and hands it to
// `LightTableView`.

import SwiftUI

public struct LightTablePalette: Equatable, Sendable {
  public let paperTop: Color
  public let paperBottom: Color
  public let ink: Color
  public let mat: Color

  public init(paperTop: Color, paperBottom: Color, ink: Color, mat: Color) {
    self.paperTop = paperTop
    self.paperBottom = paperBottom
    self.ink = ink
    self.mat = mat
  }

  public static let warmPaper = LightTablePalette(
    paperTop: Color(red: 0xfd / 255, green: 0xfc / 255, blue: 0xf9 / 255),
    paperBottom: Color(red: 0xe6 / 255, green: 0xe1 / 255, blue: 0xd5 / 255),
    ink: Color(red: 0x1c / 255, green: 0x19 / 255, blue: 0x17 / 255),
    mat: .white)

  public static func forScheme(_ scheme: ColorScheme, dark: LightTablePalette)
    -> LightTablePalette
  {
    scheme == .dark ? dark : .warmPaper
  }
}

private struct LightTablePaletteKey: EnvironmentKey {
  static let defaultValue = LightTablePalette.warmPaper
}

extension EnvironmentValues {
  /// The palette the enclosing `LightTableView` resolved, for the photo
  /// content each app draws inside a print.
  public var lightTablePalette: LightTablePalette {
    get { self[LightTablePaletteKey.self] }
    set { self[LightTablePaletteKey.self] = newValue }
  }
}
