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
    var inheritedNamespaces: [String: String] = [:]
  }

  private static let lt = UInt8(ascii: "<")
  private static let gt = UInt8(ascii: ">")
  private static let slash = UInt8(ascii: "/")
  private static let bang = UInt8(ascii: "!")
  private static let question = UInt8(ascii: "?")
  private static let doubleQuote = UInt8(ascii: "\"")
  private static let singleQuote = UInt8(ascii: "'")
  private static let canonicalNamespaces: [String: Set<String>] = [
    "rdf": ["http://www.w3.org/1999/02/22-rdf-syntax-ns#"],
    "xmp": ["http://ns.adobe.com/xap/1.0/"],
    "crs": ["http://ns.adobe.com/camera-raw-settings/1.0/"],
    "papp": ["http://ns.justmaple.app/photo/1.0/", "http://ns.justmaple.app/1.0/"],
    "maple": ["https://maple.app/ns/1.0/"],
    "dc": ["http://purl.org/dc/elements/1.1/"],
    "exif": ["http://ns.adobe.com/exif/1.0/"],
    "photoshop": ["http://ns.adobe.com/photoshop/1.0/"],
    "Iptc4xmpCore": ["http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"],
    "xmpRights": ["http://ns.adobe.com/xap/1.0/rights/"],
  ]

  /// Scan `xml` and return every direct child element of same-subject
  /// top-level `rdf:Description` elements, in document order (#4690).
  static func descriptionChildren(in xml: String) -> [Child] {
    let envelope = rdfEnvelope(in: xml)
    guard let primary = primaryDescription(in: envelope) else {
      return elementChildren(in: xml, rootLocalName: "Description")
    }
    return
      envelope.rdfChildren
      .filter {
        isRdfElement($0, localName: "Description", inherited: envelope.fullRdfNamespaces)
          && primary.matches(child: $0, inherited: envelope.fullRdfNamespaces)
      }
      .flatMap { description in
        let scope = XMPMaskGroupSources.scope(
          envelope.fullRdfNamespaces,
          attributes: XMPMaskGroupSources.rootAttributes(description.source))
        return elementChildren(in: description.source, rootLocalName: "Description").map {
          var child = $0
          child.inheritedNamespaces = scope
          return child
        }
      }
  }

  /// Direct child elements of the primary `rdf:Description` only.
  static func firstDescriptionChildren(in xml: String) -> [Child] {
    let envelope = rdfEnvelope(in: xml)
    guard let primary = primaryDescription(in: envelope)?.child else {
      return elementChildren(in: xml, rootLocalName: "Description")
    }
    let scope = XMPMaskGroupSources.scope(
      envelope.fullRdfNamespaces, attributes: XMPMaskGroupSources.rootAttributes(primary.source))
    return elementChildren(in: primary.source, rootLocalName: "Description").map {
      var child = $0
      child.inheritedNamespaces = scope
      return child
    }
  }

  static func canonicalQualifiedName(_ qName: String, namespaces: [String: String]) -> String? {
    let parts = qName.split(separator: ":", maxSplits: 1).map(String.init)
    guard parts.count == 2 else { return qName }
    guard let uri = namespaces[parts[0]],
      let prefix = canonicalNamespaces.first(where: { $0.value.contains(uri) })?.key
    else { return nil }
    return prefix + ":" + parts[1]
  }

  private static func isRdfElement(
    _ child: Child, localName: String, inherited: [String: String]
  ) -> Bool {
    let scoped = XMPMaskGroupSources.scope(
      inherited, attributes: XMPMaskGroupSources.rootAttributes(child.source))
    return XMPMaskGroupNamespaces.matches(child.qName, "rdf:" + localName, namespaces: scoped)
  }

  private static func rdfEnvelope(in xml: String) -> (
    xmpmetaChildren: [Child],
    rdfElement: Child?,
    rdfChildren: [Child],
    xmpmetaNamespaces: [String: String],
    rdfNamespaces: [String: String],
    fullRdfNamespaces: [String: String]
  ) {
    let xmpmetaChildren = elementChildren(in: xml, rootLocalName: "xmpmeta")
    let fullXmpmeta = XMPMaskGroupSources.scope(
      [:], attributes: XMPMaskGroupSources.rootAttributes(xml))
    let rdfElement = xmpmetaChildren.first {
      isRdfElement($0, localName: "RDF", inherited: fullXmpmeta)
    }
    let rdfSource = rdfElement?.source ?? xml
    let fullRdf = XMPMaskGroupSources.scope(
      fullXmpmeta, attributes: XMPMaskGroupSources.rootAttributes(rdfSource))
    return (
      xmpmetaChildren: xmpmetaChildren,
      rdfElement: rdfElement,
      rdfChildren: elementChildren(in: rdfSource, rootLocalName: "RDF"),
      xmpmetaNamespaces: fullXmpmeta.filter { $0.key != "x" },
      rdfNamespaces: fullRdf.filter { $0.key != "rdf" && $0.key != "x" },
      fullRdfNamespaces: fullRdf
    )
  }

  struct DescriptionContext: Equatable {
    let about: String?
    let nodeID: String?
    let lang: String
    let base: String

    var hasExplicitSubject: Bool { about != nil || nodeID != nil }
    var subjectTier: Int {
      if nodeID != nil { return 0 }
      guard let about else { return 1 }
      return about.isEmpty ? 2 : 0
    }
  }

  struct PrimaryDescription {
    let index: Int
    let child: Child
    let context: DescriptionContext

    func matches(index candidateIndex: Int, context candidateContext: DescriptionContext) -> Bool {
      candidateIndex == index || (context.hasExplicitSubject && candidateContext == context)
    }

    func matches(child candidate: Child, inherited: [String: String]) -> Bool {
      if candidate.byteRange == child.byteRange { return true }
      let attrs = XMPMaskGroupSources.rootAttributes(candidate.source)
      let scope = XMPMaskGroupSources.scope(inherited, attributes: attrs)
      return context.hasExplicitSubject
        && descriptionContext(attributes: attrs, namespaces: scope) == context
    }
  }

  static func descriptionContext(
    attributes: [String: String], namespaces: [String: String]
  ) -> DescriptionContext {
    let rdfAttr: (String) -> String? = { local in
      attributes.first {
        canonicalQualifiedName($0.key, namespaces: namespaces) == "rdf:" + local
      }?.value ?? attributes[local]
    }
    return DescriptionContext(
      about: rdfAttr("about"),
      nodeID: rdfAttr("nodeID"),
      lang: attributes["xml:lang"] ?? "",
      base: attributes["xml:base"] ?? "")
  }

  static func primaryDescription(in xml: String) -> PrimaryDescription? {
    primaryDescription(in: rdfEnvelope(in: xml))
  }

  private static func primaryDescription(
    in env: (
      xmpmetaChildren: [Child], rdfElement: Child?, rdfChildren: [Child],
      xmpmetaNamespaces: [String: String], rdfNamespaces: [String: String],
      fullRdfNamespaces: [String: String]
    )
  ) -> PrimaryDescription? {
    let descriptions = env.rdfChildren.filter {
      isRdfElement($0, localName: "Description", inherited: env.fullRdfNamespaces)
    }
    var best: (index: Int, child: Child, context: DescriptionContext, score: Int)?
    for (index, candidate) in descriptions.enumerated() {
      let attrs = XMPMaskGroupSources.rootAttributes(candidate.source)
      let scope = XMPMaskGroupSources.scope(env.fullRdfNamespaces, attributes: attrs)
      let context = descriptionContext(attributes: attrs, namespaces: scope)
      let attrScore = attrs.keys.filter { key in
        guard key != "xmlns", !key.hasPrefix("xmlns:"),
          let name = canonicalQualifiedName(key, namespaces: scope)
        else { return false }
        return name != "rdf:about"
      }.count
      let childScore = elementChildren(in: candidate.source, rootLocalName: "Description")
        .filter { child in
          let childScope = XMPMaskGroupSources.scope(
            scope, attributes: XMPMaskGroupSources.rootAttributes(child.source))
          guard let name = canonicalQualifiedName(child.qName, namespaces: childScope) else {
            return false
          }
          return name != "rdf:about"
        }.count
      let score = attrScore + childScore
      if let current = best {
        let tierDiff = context.subjectTier - current.context.subjectTier
        if tierDiff > 0 || (tierDiff == 0 && score > current.score) {
          best = (index, candidate, context, score)
        }
      } else {
        best = (index, candidate, context, score)
      }
    }
    return best.map { PrimaryDescription(index: $0.index, child: $0.child, context: $0.context) }
  }

  /// Sibling children of `rdf:RDF` (including secondary `rdf:Description`
  /// elements with modelled attributes/children stripped) and non-`rdf:RDF`
  /// children of `x:xmpmeta` (#4690).
  static func preservedDocumentNodes(
    in xml: String,
    groups: XMPMaskGroupSources.Collection,
    isPassthroughChild: (Child) -> Bool
  ) -> (rdfNodes: [String], xmpmetaNodes: [String]) {
    let env = rdfEnvelope(in: xml)
    let primary = primaryDescription(in: env)
    let rdfNodes =
      env.rdfChildren
      .filter { $0.byteRange != primary?.child.byteRange }
      .map { child -> String in
        if isRdfElement(child, localName: "Description", inherited: env.fullRdfNamespaces),
          let primary
        {
          let descNamespaces = XMPMaskGroupSources.scope(
            env.fullRdfNamespaces, attributes: XMPMaskGroupSources.rootAttributes(child.source))
          let stripped = withoutModeledFields(
            child.source,
            sharesPrimaryContext: primary.matches(child: child, inherited: env.fullRdfNamespaces),
            namespaces: descNamespaces,
            isPassthroughChild: isPassthroughChild,
            unownedGroupSources: groups.unownedGroupSources)
          return XMPMaskGroupSources.explicitNamespaces(stripped, namespaces: env.rdfNamespaces)
        }
        return XMPMaskGroupSources.explicitNamespaces(child.source, namespaces: env.rdfNamespaces)
      }
    let xmpmetaNodes =
      env.xmpmetaChildren
      .filter { $0.byteRange != env.rdfElement?.byteRange }
      .map { XMPMaskGroupSources.explicitNamespaces($0.source, namespaces: env.xmpmetaNamespaces) }
    return (rdfNodes, xmpmetaNodes)
  }

  private static func withoutModeledFields(
    _ source: String,
    sharesPrimaryContext: Bool,
    namespaces: [String: String],
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
    .filter { attr in
      guard let canonical = canonicalQualifiedName(attr.name, namespaces: namespaces) else {
        return false
      }
      return XMPKnownFields.isModeledDescriptionAttribute(canonical)
    }
    .map { (range: $0.range, replacement: "") }

    if !openTag.selfClosing {
      for child in elementChildren(in: source, rootLocalName: "Description") {
        let childNamespaces = XMPMaskGroupSources.scope(
          namespaces, attributes: XMPMaskGroupSources.rootAttributes(child.source))
        let canonicalQName = canonicalQualifiedName(child.qName, namespaces: childNamespaces)
        let resolvedChild = canonicalQName.map {
          Child(
            qName: $0, source: child.source, byteRange: child.byteRange,
            inheritedNamespaces: namespaces)
        }
        if let resolvedChild, !isPassthroughChild(resolvedChild) {
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
