// Preset.swift — develop presets (#1115, spec §10.7).
//
// A preset is a named, schema-versioned SPARSE AdjustmentModel:
//
//   { "schemaVersion": 1, "name": "Flat", "fields": { "contrast": -50 } }
//
// `fields` keys are the canonical snake_case names from raw-core's
// `ADJUSTMENT_SCHEMA` — the same stable strings the generated
// `AdjustmentModel.FieldName` enum carries — so a preset document written
// by any platform (web/API or Apple) parses on every other one.
//
// Passthrough rule (the XMP philosophy applied to presets): unknown
// `fields` keys from newer schema versions are PRESERVED on round-trip
// and SKIPPED on apply. Unknown TOP-LEVEL document keys are captured in
// `extra` at decode and re-emitted at encode, so an uplevel client's
// document survives a downlevel client byte-semantically.
//
// Field values are JSON scalars only (number / string / bool) — the same
// restriction the API's create-validation enforces, so the contract is
// cross-platform: a non-scalar field value fails decode loudly instead of
// silently degrading.

import Foundation

/// Preset document schema version this client writes.
public let presetSchemaVersion = 1

// MARK: - PresetFieldValue

/// A sparse-field value: a JSON scalar. Mirrors the web `PresetFields`
/// value type (`number | string | boolean`).
public enum PresetFieldValue: Equatable, Sendable, Hashable {
    case number(Double)
    case string(String)
    case bool(Bool)

    public var numberValue: Double? {
        if case .number(let v) = self { return v }
        return nil
    }

    public var stringValue: String? {
        if case .string(let v) = self { return v }
        return nil
    }
}

extension PresetFieldValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        // Bool first — JSONDecoder happily reads `true` as a Bool but would
        // not reach here as a Double; trying Bool before Double keeps the
        // scalar kinds distinct.
        if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "preset field values must be JSON scalars (number/string/bool)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .number(let v): try container.encode(v)
        case .string(let v): try container.encode(v)
        case .bool(let v):   try container.encode(v)
        }
    }
}

// MARK: - PresetJSONValue

/// Arbitrary JSON for preserved unknown TOP-LEVEL keys (`Preset.extra`).
/// Field values stay scalar (`PresetFieldValue`); top-level extras from
/// newer schema versions can be any JSON shape and must round-trip.
public indirect enum PresetJSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([PresetJSONValue])
    case object([String: PresetJSONValue])
}

extension PresetJSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([PresetJSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: PresetJSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:              try container.encodeNil()
        case .bool(let v):       try container.encode(v)
        case .number(let v):     try container.encode(v)
        case .string(let v):     try container.encode(v)
        case .array(let v):      try container.encode(v)
        case .object(let v):     try container.encode(v)
        }
    }
}

// MARK: - Preset

/// A develop preset document. `builtIn` is a runtime-only marker (never
/// encoded): bundled presets are read-only — no delete, no overwrite.
public struct Preset: Identifiable, Equatable, Sendable {
    /// Stable identity — lowercase UUID for user presets (also the on-disk
    /// filename stem), or the bundled `builtin-*` id.
    public let id: String
    public var schemaVersion: Int
    public var name: String
    /// Sparse adjustment fields: canonical snake_case key → scalar value.
    /// Unknown keys (newer schema versions) ride along untouched.
    public var fields: [String: PresetFieldValue]
    /// Unknown top-level document keys, preserved verbatim on round-trip.
    public var extra: [String: PresetJSONValue]
    /// Runtime-only: true for bundled presets. Not part of the document.
    public var builtIn: Bool

    public init(
        id: String,
        schemaVersion: Int = presetSchemaVersion,
        name: String,
        fields: [String: PresetFieldValue],
        extra: [String: PresetJSONValue] = [:],
        builtIn: Bool = false
    ) {
        self.id = id
        self.schemaVersion = schemaVersion
        self.name = name
        self.fields = fields
        self.extra = extra
        self.builtIn = builtIn
    }

    // MARK: Name validation (mirrors the web `normalizePresetName`)

    public static let nameMaxLength = 120

    /// Trimmed name, or nil when invalid (empty / too long / control chars).
    public static func normalizeName(_ raw: String) -> String? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= nameMaxLength else { return nil }
        let hasControl = name.unicodeScalars.contains {
            $0.value < 0x20 || $0.value == 0x7f
        }
        return hasControl ? nil : name
    }
}

// MARK: - Codable (unknown top-level keys preserved)

extension Preset: Codable {
    /// Dynamic key so unknown top-level keys can be enumerated + re-emitted.
    private struct DynamicKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    /// Top-level keys owned by this schema version; everything else is
    /// preserved in `extra`.
    private static let ownedKeys: Set<String> = ["id", "schemaVersion", "name", "fields"]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DynamicKey.self)
        self.id = try container.decode(String.self, forKey: DynamicKey(stringValue: "id"))
        self.schemaVersion = try container.decode(
            Int.self, forKey: DynamicKey(stringValue: "schemaVersion")
        )
        self.name = try container.decode(String.self, forKey: DynamicKey(stringValue: "name"))
        self.fields = try container.decode(
            [String: PresetFieldValue].self, forKey: DynamicKey(stringValue: "fields")
        )
        var extra: [String: PresetJSONValue] = [:]
        for key in container.allKeys where !Self.ownedKeys.contains(key.stringValue) {
            extra[key.stringValue] = try container.decode(PresetJSONValue.self, forKey: key)
        }
        self.extra = extra
        self.builtIn = false
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynamicKey.self)
        try container.encode(id, forKey: DynamicKey(stringValue: "id"))
        try container.encode(schemaVersion, forKey: DynamicKey(stringValue: "schemaVersion"))
        try container.encode(name, forKey: DynamicKey(stringValue: "name"))
        try container.encode(fields, forKey: DynamicKey(stringValue: "fields"))
        for (key, value) in extra {
            try container.encode(value, forKey: DynamicKey(stringValue: key))
        }
        // `builtIn` is runtime-only — deliberately not encoded.
    }
}
