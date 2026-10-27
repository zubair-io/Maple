// Read-side repair for a start tag that repeats an attribute (#5475).
// Mirrors `xmp-duplicate-attributes.ts`.

import Foundation

enum XMPDuplicateAttributes {
  /// `xml` with every repeat of an attribute name within one start tag
  /// removed, the first occurrence kept: the serializer lists the model's
  /// attributes before passthrough and the canonical sort is stable, so the
  /// first copy is the edit. Nil when nothing repeats or the markup cannot be
  /// tokenized (a DOCTYPE, an unterminated comment or tag), so the caller
  /// keeps its original parse error.
  static func removingRepeats(in xml: String) -> String? {
    let bytes = Array(xml.utf8)
    var removals: [Range<Int>] = []
    var cursor = bytes.firstIndex(of: lessThan)
    while let start = cursor {
      guard let end = markupEnd(bytes, at: start, removals: &removals) else { return nil }
      cursor = end < bytes.count ? bytes[end...].firstIndex(of: lessThan) : nil
    }
    guard !removals.isEmpty else { return nil }
    let kept = removals.reversed().reduce(into: bytes) { $0.removeSubrange($1) }
    return String(decoding: kept, as: UTF8.self)
  }

  private static let lessThan = UInt8(ascii: "<")
  private static let greaterThan = UInt8(ascii: ">")
  private static let slash = UInt8(ascii: "/")
  private static let equals = UInt8(ascii: "=")
  private static let quotes: Set<UInt8> = [UInt8(ascii: "\""), UInt8(ascii: "'")]
  private static let spaces: Set<UInt8> = [0x20, 0x09, 0x0A, 0x0D]

  private static func markupEnd(_ b: [UInt8], at lt: Int, removals: inout [Range<Int>]) -> Int? {
    for (open, close) in [("<!--", "-->"), ("<![CDATA[", "]]>"), ("<?", "?>"), ("</", ">")]
    where b[lt...].starts(with: open.utf8) {
      return end(of: Array(close.utf8), in: b, from: lt + open.utf8.count)
    }
    if b[lt...].starts(with: "<!".utf8) { return nil }
    return startTagEnd(b, at: lt, removals: &removals)
  }

  private static func end(of terminator: [UInt8], in b: [UInt8], from: Int) -> Int? {
    guard from <= b.count else { return nil }
    var i = from
    while i + terminator.count <= b.count {
      if b[i..<(i + terminator.count)].elementsEqual(terminator) { return i + terminator.count }
      i += 1
    }
    return nil
  }

  private static func skipping(_ set: Set<UInt8>, in b: [UInt8], from: Int) -> Int {
    b[from...].firstIndex { !set.contains($0) } ?? b.count
  }

  private static func nameEnd(_ b: [UInt8], from: Int) -> Int {
    b[from...].firstIndex {
      spaces.contains($0) || $0 == equals || $0 == slash || $0 == greaterThan
    }
      ?? b.count
  }

  private static func startTagEnd(_ b: [UInt8], at lt: Int, removals: inout [Range<Int>]) -> Int? {
    let tagNameEnd = nameEnd(b, from: lt + 1)
    guard tagNameEnd > lt + 1 else { return nil }
    var seen = Set<ArraySlice<UInt8>>()
    var i = tagNameEnd
    while true {
      let nameStart = skipping(spaces, in: b, from: i)
      guard nameStart < b.count else { return nil }
      if b[nameStart] == greaterThan { return nameStart + 1 }
      if b[nameStart] == slash {
        return nameStart + 1 < b.count && b[nameStart + 1] == greaterThan ? nameStart + 2 : nil
      }
      let attrNameEnd = nameEnd(b, from: nameStart)
      guard nameStart > i, attrNameEnd > nameStart else { return nil }
      let equalsAt = skipping(spaces, in: b, from: attrNameEnd)
      guard equalsAt < b.count, b[equalsAt] == equals else { return nil }
      let quoteAt = skipping(spaces, in: b, from: equalsAt + 1)
      guard quoteAt < b.count, quotes.contains(b[quoteAt]),
        let closeQuote = b[(quoteAt + 1)...].firstIndex(of: b[quoteAt])
      else { return nil }
      if !seen.insert(b[nameStart..<attrNameEnd]).inserted { removals.append(i..<(closeQuote + 1)) }
      i = closeQuote + 1
    }
  }
}
