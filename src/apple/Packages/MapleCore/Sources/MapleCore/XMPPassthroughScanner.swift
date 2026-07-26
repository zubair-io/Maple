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
// all of that, and a document this scanner runs over has already been proven
// well-formed by `XMPParser.parse`.

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
    }

    private static let lt = UInt8(ascii: "<")
    private static let gt = UInt8(ascii: ">")
    private static let slash = UInt8(ascii: "/")
    private static let bang = UInt8(ascii: "!")
    private static let question = UInt8(ascii: "?")
    private static let doubleQuote = UInt8(ascii: "\"")
    private static let singleQuote = UInt8(ascii: "'")

    /// Scan `xml` and return every direct child element of the first
    /// `rdf:Description`, in document order.
    ///
    /// Returns an empty list for a self-closing or absent `rdf:Description` —
    /// the shape every sidecar Maple has written to date takes when the model
    /// carries no keywords and no tone curves.
    static func descriptionChildren(in xml: String) -> [Child] {
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
                        children.append(Child(
                            qName: childName,
                            source: String(decoding: bytes[start..<tag.end], as: UTF8.self)))
                        childStart = nil
                    }
                }
                index = tag.end
                continue
            }

            let tag = readTag(bytes, from: index)
            if !insideDescription {
                if isLocalName(tag.qName, "Description") {
                    if tag.selfClosing { break }
                    insideDescription = true
                    depth = 0
                }
                index = tag.end
                continue
            }
            if depth == 0 {
                if tag.selfClosing {
                    children.append(Child(
                        qName: tag.qName,
                        source: String(decoding: bytes[index..<tag.end], as: UTF8.self)))
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
