// Bundled Google Material Symbols Rounded: 400 weight, 24 optical size,
// unfilled, grade 0. CoreText reads outlines from the package's own font;
// no process-wide font registration, ligature shaping or network requests.

import CoreText
import SwiftUI

enum MuiMaterialSymbols {
  private final class Outline: NSObject {
    let path: Path
    init(_ path: Path) { self.path = path }
  }

  private static let outlines = NSCache<NSString, Outline>()

  static let glyphs: [String: CGGlyph] = {
    let url = resource("glyphs", extension: "json")
    do {
      let data = try Data(contentsOf: url)
      return try JSONDecoder().decode([String: CGGlyph].self, from: data)
    } catch {
      preconditionFailure("Invalid bundled Material Symbols glyph map: \(error)")
    }
  }()

  private static let font = loadFont("Rounded")
  private static let filledFont = loadFont("RoundedFilled")

  private static func loadFont(_ name: String) -> CTFont {
    let url = resource(name, extension: "ttf")
    guard let provider = CGDataProvider(url: url as CFURL), let font = CGFont(provider) else {
      preconditionFailure("Invalid bundled Material Symbols font: \(name)")
    }
    return CTFontCreateWithGraphicsFont(font, 24, nil, nil)
  }

  /// Filled outline in a 24×24 design space, ready for inherited tint.
  static func path(for name: String, filled: Bool = false) -> Path? {
    guard let glyph = glyphs[name] else { return nil }
    let key = (filled ? "filled:\(name)" : name) as NSString
    if let cached = outlines.object(forKey: key) { return cached.path }
    var transform = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: 24)
    guard let outline = CTFontCreatePathForGlyph(filled ? filledFont : font, glyph, &transform)
    else {
      preconditionFailure("Missing bundled Material Symbols outline: \(name)")
    }
    let path = Path(outline)
    outlines.setObject(Outline(path), forKey: key)
    return path
  }

  private static func resource(_ name: String, extension ext: String) -> URL {
    guard
      let url = Bundle.module.url(
        forResource: name, withExtension: ext, subdirectory: "MaterialSymbols")
    else { preconditionFailure("Missing bundled Material Symbols resource: \(name).\(ext)") }
    return url
  }
}
