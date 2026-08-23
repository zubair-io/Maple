// MuiStructuredDataMath.swift — pure flat-JSON parse/stringify for
// `MuiStructuredDataEditor`. Scoped to the same v1 shape as the web
// reference: a flat object whose leaves are strings, numbers, or booleans —
// no nesting, no arrays. `Foundation.JSONSerialization` round-trips through
// `NSDictionary`, which doesn't preserve key order, so this is a small
// hand-rolled parser/writer instead — proportionate for a grammar this
// narrow, and it keeps field order stable across edits the way the web
// reference's `Object.entries` does.

import Foundation

public enum MuiStructuredDataLeaf: Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)

    public var displayString: String {
        switch self {
        case .string(let value): return value
        case .number(let value): return value.rounded() == value ? String(Int(value)) : String(value)
        case .bool(let value): return value ? "true" : "false"
        }
    }
}

public struct MuiStructuredDataField: Identifiable, Equatable, Sendable {
    public let key: String
    public var value: MuiStructuredDataLeaf
    public var id: String { key }

    public init(key: String, value: MuiStructuredDataLeaf) {
        self.key = key
        self.value = value
    }
}

struct MuiStructuredDataParseError: Error, Equatable, Sendable {
    let message: String
}

enum MuiStructuredDataMath {
    static let flatObjectError = "Value must be a flat object of strings, numbers, or booleans"

    /// Renders `fields` as pretty-printed JSON text, in field order.
    static func jsonText(from fields: [MuiStructuredDataField]) -> String {
        guard !fields.isEmpty else { return "{}" }
        let lines = fields.map { "  \(quote($0.key)): \(encode($0.value))" }
        return "{\n" + lines.joined(separator: ",\n") + "\n}"
    }

    /// Parses `text` as a flat JSON object — `.success` with ordered fields,
    /// or `.failure` with a human-readable message on malformed JSON or a
    /// value that isn't a flat string/number/boolean object.
    static func parseFields(from text: String) -> Result<[MuiStructuredDataField], MuiStructuredDataParseError> {
        var scanner = FlatJSONScanner(text)
        guard let fields = scanner.parseObject() else {
            return .failure(MuiStructuredDataParseError(message: scanner.lastError ?? flatObjectError))
        }
        return .success(fields)
    }

    /// Re-coerces a raw form-field string back to the type `original` had —
    /// a number stays a number, a boolean stays a boolean, everything else
    /// stays a string.
    static func coerceLike(_ original: MuiStructuredDataLeaf, raw: String) -> MuiStructuredDataLeaf {
        switch original {
        case .number: return .number(Double(raw) ?? 0)
        case .bool: return .bool(raw == "true")
        case .string: return .string(raw)
        }
    }

    private static func encode(_ leaf: MuiStructuredDataLeaf) -> String {
        switch leaf {
        case .string(let value): return quote(value)
        case .number(let value): return value.rounded() == value ? String(Int(value)) : String(value)
        case .bool(let value): return value ? "true" : "false"
        }
    }

    private static func quote(_ value: String) -> String {
        "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}

/// A minimal recursive-descent scanner for exactly one grammar rule: a flat
/// `{"key": string|number|bool, ...}` object. Not a general JSON parser —
/// nesting, arrays, and `null` are all rejected as `flatObjectError`, per
/// this editor's documented v1 scope.
private struct FlatJSONScanner {
    private let chars: [Character]
    private var index = 0
    var lastError: String?

    init(_ text: String) {
        self.chars = Array(text)
    }

    mutating func parseObject() -> [MuiStructuredDataField]? {
        skipWhitespace()
        guard consume("{") else { return fail("Expected an object") }
        skipWhitespace()

        var fields: [MuiStructuredDataField] = []
        if peek() == "}" {
            index += 1
            return fields
        }

        while true {
            skipWhitespace()
            guard let key = parseString() else { return fail("Expected a quoted key") }
            skipWhitespace()
            guard consume(":") else { return fail("Expected ':' after key") }
            skipWhitespace()
            guard let leaf = parseLeaf() else { return fail(MuiStructuredDataMath.flatObjectError) }
            fields.append(MuiStructuredDataField(key: key, value: leaf))
            skipWhitespace()

            if consume(",") { continue }
            if consume("}") { break }
            return fail("Expected ',' or '}'")
        }
        skipWhitespace()
        return index == chars.count ? fields : fail("Unexpected trailing characters")
    }

    private mutating func parseLeaf() -> MuiStructuredDataLeaf? {
        guard let c = peek() else { return nil }
        if c == "\"" {
            return parseString().map(MuiStructuredDataLeaf.string)
        }
        if matchesLiteral("true") { index += 4; return .bool(true) }
        if matchesLiteral("false") { index += 5; return .bool(false) }
        if c == "-" || c.isNumber {
            return parseNumber().map(MuiStructuredDataLeaf.number)
        }
        return nil
    }

    private mutating func parseString() -> String? {
        guard consume("\"") else { return nil }
        var result = ""
        while let c = peek() {
            index += 1
            if c == "\"" { return result }
            if c == "\\", let next = peek() {
                index += 1
                result.append(next == "n" ? "\n" : next)
                continue
            }
            result.append(c)
        }
        return nil
    }

    private mutating func parseNumber() -> Double? {
        let start = index
        if peek() == "-" { index += 1 }
        while let c = peek(), c.isNumber || c == "." { index += 1 }
        return Double(String(chars[start..<index]))
    }

    private mutating func skipWhitespace() {
        while let c = peek(), c.isWhitespace { index += 1 }
    }

    private func peek() -> Character? {
        index < chars.count ? chars[index] : nil
    }

    private mutating func consume(_ c: Character) -> Bool {
        guard peek() == c else { return false }
        index += 1
        return true
    }

    private func matchesLiteral(_ literal: String) -> Bool {
        let literalChars = Array(literal)
        guard index + literalChars.count <= chars.count else { return false }
        return Array(chars[index..<(index + literalChars.count)]) == literalChars
    }

    private mutating func fail(_ message: String) -> [MuiStructuredDataField]? {
        lastError = message
        return nil
    }
}
