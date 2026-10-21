import Foundation

extension CharacterSet {
  /// What JavaScript's `String.prototype.trim()` strips: ECMAScript
  /// WhiteSpace plus LineTerminator. Foundation's `.whitespacesAndNewlines`
  /// also strips U+0085 and misses U+FEFF, so it cannot stand in for it.
  static let ecmaScriptWhitespace = CharacterSet(
    charactersIn: "\u{9}\u{B}\u{C}\u{20}\u{A0}\u{FEFF}\u{A}\u{D}\u{2028}\u{2029}\u{1680}"
      + "\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}"
      + "\u{200A}\u{202F}\u{205F}\u{3000}")
}
