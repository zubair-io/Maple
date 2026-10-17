// XMPPassthroughScanner.swift — verbatim source capture of `rdf:Description`'s
// child elements (#2233).
//
// Why a scanner and not the `XMLParser` walk that reads everything else: the
// passthrough contract is about BYTES, and a SAX re-serialization cannot
// reproduce them. `XMLParser` hands a start tag's attributes back as a Swift
// `Dictionary`, whose iteration order is undefined, so rebuilding a Lightroom
// mask entry from parse events would reshuffle its attributes on every save —
// the sidecar would churn forever and never reach a fixed point.
// `XMLDocument`, which does preserve order, is macOS-only and Maple ships on
// iOS. Slicing the original text is therefore the only way to hand back
// exactly what the author wrote, and it also beats the web's `outerHTML`,
// which re-serializes through the DOM.
//
// The scanner is deliberately narrow: it finds the first `rdf:Description`
// and records the source range of each direct child element. It never decodes
// text, resolves entities, or interprets attributes — `XMLParser` still owns
// all of that. Its one production caller, `XMPParser.parsePassthrough`, runs
// the document through its own `XMLParser.parse()` and bails to `.empty`
// before reaching the scanner, so anything this code sees on the write path is
// already known well-formed.

import Foundation

/// Source ranges of `rdf:Description`'s direct children.
enum XMPChildElementScanner {

  /// One direct child of `rdf:Description`.
  struct Child {
    /// Qualified name as written (`crs:MaskGroupBasedCorrections`).
    let qName: String
    /// The element's source text, from its opening `<` through the `>` of
    /// its end tag (or of the self-closing tag).
    let source: String
    let byteRange: Range<Int>
  }

  private static let lt = UInt8(ascii: "<")
  private static let gt = UInt8(ascii: ">")
  private static let slash = UInt8(ascii: "/")
  private static let bang = UInt8(ascii: "!")
  private static let question = UInt8(ascii: "?")
  private static let doubleQuote = UInt8(ascii: "\"")
  private static let singleQuote = UInt8(ascii: "'")

  /// Scan `xml` and return every direct child element of same-subject
  /// top-level `rdf:Description` elements, in document order (#4690).
  static func descriptionChildren(in xml: String) -> [Child] {
    let descriptions = elementChildren(in: xml, rootLocalName: "RDF")
      .filter { isLocalName($0.qName, "Description") }
    guard let first = descriptions.first else {
      return elementChildren(in: xml, rootLocalName: "Description")
    }
    return
      descriptions
      .filter { sharesContext($0.source, with: first.source) }
      .flatMap { elementChildren(in: $0.source, rootLocalName: "Description") }
  }

  /// Direct child elements of the first `rdf:Description` only.
  static func firstDescriptionChildren(in xml: String) -> [Child] {
    let descriptions = elementChildren(in: xml, rootLocalName: "RDF")
      .filter { isLocalName($0.qName, "Description") }
    guard let first = descriptions.first else {
      return elementChildren(in: xml, rootLocalName: "Description")
    }
    return elementChildren(in: first.source, rootLocalName: "Description")
  }

  /// True when two `rdf:Description` elements share `rdf:about`, `xml:lang`,
  /// and `xml:base` context.
  static func sharesContext(_ source: String, with primary: String) -> Bool {
    let lhs = XMPMaskGroupSources.rootAttributes(source)
    let rhs = XMPMaskGroupSources.rootAttributes(primary)
    let about: ([String: String]) -> String = { attrs in
      attrs["rdf:about"]
        ?? attrs.first { $0.key == "about" || $0.key.hasSuffix(":about") }?.value
        ?? ""
    }
    return about(lhs) == about(rhs)
      && (lhs["xml:lang"] ?? "") == (rhs["xml:lang"] ?? "")
      && (lhs["xml:base"] ?? "") == (rhs["xml:base"] ?? "")
  }

  /// Sibling children of `rdf:RDF` (including secondary `rdf:Description`
  /// elements with modelled attributes/children stripped) and non-`rdf:RDF`
  /// children of `x:xmpmeta` (#4690).
  static func preservedDocumentNodes(
    in xml: String,
    groups: XMPMaskGroupSources.Collection,
    isPassthroughChild: (Child) -> Bool
  ) -> (rdfNodes: [String], xmpmetaNodes: [String]) {
    let xmpmetaChildren = elementChildren(in: xml, rootLocalName: "xmpmeta")
    let xmpmetaNamespaces = XMPMaskGroupSources.scope(
      [:], attributes: XMPMaskGroupSources.rootAttributes(xml)
    ).filter { $0.key != "x" }
    let rdfElement = xmpmetaChildren.first { isLocalName($0.qName, "RDF") }
    let rdfSource = rdfElement?.source ?? xml
    let rdfNamespaces = XMPMaskGroupSources.scope(
      xmpmetaNamespaces, attributes: XMPMaskGroupSources.rootAttributes(rdfSource)
    ).filter { $0.key != "rdf" && $0.key != "x" }
    let rdfChildren = elementChildren(in: xml, rootLocalName: "RDF")
    let firstDescription = rdfChildren.first { isLocalName($0.qName, "Description") }
    let rdfNodes =
      rdfChildren
      .filter { $0.byteRange != firstDescription?.byteRange }
      .map { child -> String in
        if isLocalName(child.qName, "Description"), let primary = firstDescription {
          let stripped = withoutModeledFields(
            child.source,
            sharesPrimaryContext: sharesContext(child.source, with: primary.source),
            isPassthroughChild: isPassthroughChild,
            unownedGroupSources: groups.unownedGroupSources)
          return XMPMaskGroupSources.explicitNamespaces(stripped, namespaces: rdfNamespaces)
        }
        return XMPMaskGroupSources.explicitNamespaces(child.source, namespaces: rdfNamespaces)
      }
    let xmpmetaNodes =
      xmpmetaChildren
      .filter { !isLocalName($0.qName, "RDF") }
      .map { XMPMaskGroupSources.explicitNamespaces($0.source, namespaces: xmpmetaNamespaces) }
    return (rdfNodes, xmpmetaNodes)
  }

  private static func withoutModeledFields(
    _ source: String,
    sharesPrimaryContext: Bool,
    isPassthroughChild: (Child) -> Bool,
    unownedGroupSources: [String: String]
  ) -> String {
    guard sharesPrimaryContext else { return source }
    let bytes = Array(source.utf8)
    guard !bytes.isEmpty else { return source }
    let openTag = readTag(bytes, from: 0)
    var edits: [(range: Range<Int>, replacement: String)] = rootAttributeRanges(
      bytes, openTagEnd: openTag.end
    )
    .filter { XMPKnownFields.isModeledDescriptionAttribute($0.name) }
    .map { (range: $0.range, replacement: "") }

    if !openTag.selfClosing {
      for child in elementChildren(in: source, rootLocalName: "Description") {
        if !isPassthroughChild(child) {
          var start = child.byteRange.lowerBound
          while start > openTag.end && (bytes[start - 1] == 0x20 || bytes[start - 1] == 0x09) {
            start -= 1
          }
          if start > openTag.end && bytes[start - 1] == 0x0A {
            start -= 1
            if start > openTag.end && bytes[start - 1] == 0x0D { start -= 1 }
          } else {
            start = child.byteRange.lowerBound
          }
          edits.append((range: start..<child.byteRange.upperBound, replacement: ""))
        } else if let replacement = unownedGroupSources[child.source] {
          edits.append((range: child.byteRange, replacement: replacement))
        }
      }
    }
    guard !edits.isEmpty else { return source }
    var result = ""
    var cursor = 0
    for edit in edits {
      result += String(decoding: bytes[cursor..<edit.range.lowerBound], as: UTF8.self)
      result += edit.replacement
      cursor = edit.range.upperBound
    }
    result += String(decoding: bytes[cursor..<bytes.count], as: UTF8.self)
    return result
  }

  private static func rootAttributeRanges(
    _ bytes: [UInt8], openTagEnd: Int
  ) -> [(name: String, range: Range<Int>)] {
    var i = 1
    while i < openTagEnd, !isNameTerminator(bytes[i]) { i += 1 }
    var spans: [(name: String, range: Range<Int>)] = []
    let eq = UInt8(ascii: "=")
    while i < openTagEnd {
      let wsStart = i
      while i < openTagEnd, isWhitespace(bytes[i]) { i += 1 }
      if i >= openTagEnd || bytes[i] == gt || bytes[i] == slash { break }
      let nameStart = i
      while i < openTagEnd, !isWhitespace(bytes[i]), bytes[i] != eq, bytes[i] != gt,
        bytes[i] != slash
      {
        i += 1
      }
      let name = String(decoding: bytes[nameStart..<i], as: UTF8.self)
      while i < openTagEnd, isWhitespace(bytes[i]) { i += 1 }
      guard i < openTagEnd, bytes[i] == eq else { break }
      i += 1
      while i < openTagEnd, isWhitespace(bytes[i]) { i += 1 }
      guard i < openTagEnd, bytes[i] == doubleQuote || bytes[i] == singleQuote else { break }
      let quote = bytes[i]
      i += 1
      while i < openTagEnd, bytes[i] != quote { i += 1 }
      if i < openTagEnd { i += 1 }
      spans.append((name: name, range: wsStart..<i))
    }
    return spans
  }

  /// Used by the mask-group reader to capture direct entries and foreign
  /// component children without reserializing their source bytes.
  static func elementChildren(in xml: String, rootLocalName: String) -> [Child] {
    let bytes = Array(xml.utf8)
    var children: [Child] = []
    var index = 0
    var insideDescription = false
    /// Nesting depth below `rdf:Description`: 0 while sitting between its
    /// children, 1 inside a direct child, deeper inside that child.
    var depth = 0
    var childStart: Int? = nil
    var childName = ""

    while index < bytes.count {
      guard bytes[index] == lt else {
        index += 1
        continue
      }
      if let skipped = skipNonElement(bytes, from: index) {
        index = skipped
        continue
      }
      if index + 1 < bytes.count, bytes[index + 1] == slash {
        let tag = readTag(bytes, from: index)
        if insideDescription {
          if depth == 0 { break }  // </rdf:Description> — done.
          depth -= 1
          if depth == 0, let start = childStart {
            children.append(
              Child(
                qName: childName,
                source: String(decoding: bytes[start..<tag.end], as: UTF8.self),
                byteRange: start..<tag.end))
            childStart = nil
          }
        }
        index = tag.end
        continue
      }

      let tag = readTag(bytes, from: index)
      if !insideDescription {
        if isLocalName(tag.qName, rootLocalName) {
          if tag.selfClosing { break }
          insideDescription = true
          depth = 0
        }
        index = tag.end
        continue
      }
      if depth == 0 {
        if tag.selfClosing {
          children.append(
            Child(
              qName: tag.qName,
              source: String(decoding: bytes[index..<tag.end], as: UTF8.self),
              byteRange: index..<tag.end))
        } else {
          childStart = index
          childName = tag.qName
          depth = 1
        }
      } else if !tag.selfClosing {
        depth += 1
      }
      index = tag.end
    }
    return children
  }

  // MARK: - Tag scanning

  private struct Tag {
    let qName: String
    /// Index just past the tag's closing `>`.
    let end: Int
    let selfClosing: Bool
  }

  /// Skip a construct that is not an element tag — processing instruction,
  /// comment, CDATA section or doctype — returning the index just past it,
  /// or nil when `index` opens a real tag.
  private static func skipNonElement(_ bytes: [UInt8], from index: Int) -> Int? {
    guard index + 1 < bytes.count else { return nil }
    let next = bytes[index + 1]
    if next == question { return skip(bytes, from: index + 2, until: "?>") }
    guard next == bang else { return nil }
    if matches(bytes, at: index + 2, "--") { return skip(bytes, from: index + 4, until: "-->") }
    if matches(bytes, at: index + 2, "[CDATA[") {
      return skip(bytes, from: index + 9, until: "]]>")
    }
    return skip(bytes, from: index + 2, until: ">")
  }

  private static func matches(_ bytes: [UInt8], at index: Int, _ literal: String) -> Bool {
    guard index >= 0 else { return false }
    var offset = 0
    for expected in literal.utf8 {
      let position = index + offset
      guard position < bytes.count, bytes[position] == expected else { return false }
      offset += 1
    }
    return true
  }

  /// Index just past the next occurrence of `terminator`, or the end of the
  /// buffer when it never appears (a truncated document — the caller simply
  /// stops finding children).
  private static func skip(_ bytes: [UInt8], from index: Int, until terminator: String) -> Int {
    let length = terminator.utf8.count
    var i = max(index, 0)
    while i + length <= bytes.count {
      if matches(bytes, at: i, terminator) { return i + length }
      i += 1
    }
    return bytes.count
  }

  /// Read the tag opening at `index` (`<name …>`, `<name …/>` or `</name>`).
  ///
  /// Attribute values are skipped as opaque quoted runs so a `>` inside one
  /// — legal, and common in Lightroom's history strings — never ends the tag
  /// early.
  private static func readTag(_ bytes: [UInt8], from index: Int) -> Tag {
    var i = index + 1
    if i < bytes.count, bytes[i] == slash { i += 1 }
    let nameStart = i
    while i < bytes.count, !isNameTerminator(bytes[i]) { i += 1 }
    let qName = String(decoding: bytes[nameStart..<i], as: UTF8.self)

    var quote: UInt8? = nil
    var lastSignificant: UInt8 = 0
    while i < bytes.count {
      let byte = bytes[i]
      if let open = quote {
        if byte == open { quote = nil }
        i += 1
        continue
      }
      if byte == doubleQuote || byte == singleQuote {
        quote = byte
        lastSignificant = byte
        i += 1
        continue
      }
      if byte == gt { break }
      if !isWhitespace(byte) { lastSignificant = byte }
      i += 1
    }
    return Tag(qName: qName, end: min(i + 1, bytes.count), selfClosing: lastSignificant == slash)
  }

  private static func isNameTerminator(_ byte: UInt8) -> Bool {
    isWhitespace(byte) || byte == gt || byte == slash
  }

  private static func isWhitespace(_ byte: UInt8) -> Bool {
    byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D
  }

  /// True when `qName` is `local` under any namespace prefix — sidecars are
  /// free to bind `rdf` to something other than `rdf`.
  private static func isLocalName(_ qName: String, _ local: String) -> Bool {
    qName == local || qName.hasSuffix(":" + local)
  }
}
