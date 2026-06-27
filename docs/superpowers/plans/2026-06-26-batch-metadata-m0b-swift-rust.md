# M0b — Swift + Rust XMP metadata parity + codegen

- **Ticket:** #1581
- **Epic:** #1575 (Batch Metadata Editor)
- **Date:** 2026-06-26
- **Status:** Implementation

## Summary

Mirror the TypeScript `XmpMetadata` 21-field set into Swift and verify Rust tolerance. The
canonical reference is `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts` plus
`xmp.types.ts` (merged M0a on main). Parity is **semantic**, not byte-identical.

## What M0a delivered (already on main)

- `XmpMetadata` 21-field interface in TypeScript (`xmp.types.ts`).
- `xmp-metadata.ts` helpers: `gpsToXmp`, `gpsFromXmp`, `altitudeToXmp`, `altitudeFromXmp`,
  `langAltBlock`, `seqBlock`, `metadataAttrParts`, `metadataNestedBlocks`,
  `metadataNamespacePrefixes`, `METADATA_ATTR_KEYS`, `METADATA_NESTED_ELEMENTS`.
- Integration in `xmp-serializer.service.ts` and `xmp-parser.service.ts` (parseMetadata).
- Tests in `xmp-metadata-roundtrip.spec.ts` and `xmp-metadata.spec.ts`.

## M0b scope

### 1. Swift — `XMPSerialization+Metadata.swift`

New file alongside `XMPSerialization.swift` (splits cleanly — follows the existing
`+HSL`, `+Helpers` pattern). Stays under the 600-line budget.

**Struct:**

```swift
public struct XmpMetadata {
    public var gpsLatitude: Double?
    public var gpsLongitude: Double?
    public var gpsAltitude: Double?
    public var dateTimeOriginal: String?
    public var timeZone: String?
    public var sublocation: String?
    public var city: String?
    public var state: String?
    public var country: String?
    public var countryCode: String?
    public var title: String?
    public var caption: String?
    public var headline: String?
    public var instructions: String?
    public var creator: String?
    public var creatorJobTitle: String?
    public var copyrightNotice: String?
    public var copyrightStatus: CopyrightStatus?
    public var usageTerms: String?
    public var credit: String?
    public var source: String?
    public init() {}
}

public enum CopyrightStatus: String {
    case unknown, copyrighted, publicDomain = "public-domain"
}
```

**GPS encoding (mirrors TS):**

- `gpsToXmp(value: Double, axis: GpsAxis) → String`
  - `abs = abs(value)`
  - `roundedMinutes = (abs * 60 * 1e4).rounded() / 1e4`
  - `deg = Int(floor(roundedMinutes / 60))`
  - `min = roundedMinutes - Double(deg) * 60`
  - `positive = (roundedMinutes == 0) ? true : (value >= 0)`
  - hemisphere suffix: lat → N/S, lon → E/W
  - format: `"\(deg),\(String(format: "%.4f", min))\(hemi)"`
- `gpsFromXmp(_ s: String) → Double?`
  - regex `^(\d+),(\d+(?:\.\d+)?)([NSEW])$`
  - sign: S/W → -1, else +1
  - result = sign \* (deg + min/60); if result == 0 → 0 (normalize -0)

**Altitude encoding:**

- `altitudeToXmp(meters: Double) → (value: String, ref: String)`
  - ref: meters < 0 → "1", else "0"
  - thousandths = Int((abs(meters) \* 1000).rounded())
  - value = "\(thousandths)/1000"
- `altitudeFromXmp(value: String, ref: String) → Double?`
  - parse `N/D` rational; nil if denom == 0
  - ref == "1" → negate

**Serialization extension on `XMPSerializer`:**

- `metadataAttrParts(_ m: XmpMetadata) → [(String, String)]` — same field order as TS
- `metadataNestedBlocks(_ m: XmpMetadata) → [String]` — title, creator, description, rights, usageTerms
- `metadataNamespacePrefixes(_ m: XmpMetadata) → Set<String>` — conditional prefix set

Namespace declarations (conditional, same as TS):

```
dc: http://purl.org/dc/elements/1.1/
exif: http://ns.adobe.com/exif/1.0/
photoshop: http://ns.adobe.com/photoshop/1.0/
Iptc4xmpCore: http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/
xmpRights: http://ns.adobe.com/xap/1.0/rights/
```

**Extend `XMPSerializer.serialize` signature:**
Add `metadata: XmpMetadata? = nil` parameter. When present:

1. Add conditional namespace declarations to `rdf:Description`.
2. Append `metadataAttrParts` to the attrs list before passthrough.
3. Append `metadataNestedBlocks` to nested content (before passthrough unknown nodes).

**Extend `_XMPParserDelegate` / `XMPParser.parse`:**
Return type stays `(AdjustmentModel, CullingState)` — add a new
`XMPParser.parseMetadata(_ xml: String) → XmpMetadata` that:

- Parses using `XMLParser` with `_XMPMetadataDelegate`
- Reads all 17 simple attributes off `rdf:Description` attributes
- Reads 5 nested elements (lang-alt/seq) — extracts first `rdf:li` text content
- Empty/whitespace-only strings → nil (matches TS contract)

**Managed element exclusion from existing passthrough:**
The existing parser/serializer do NOT yet have a passthrough bucket in Swift (the passthrough
is TS-only). So no passthrough-exclusion logic is needed in Swift at this stage — it will be
wired when passthrough is added in a future slice. No double-emit risk yet.

### 2. Rust tolerance — `src/raw-pipeline/raw-core/src/xmp/tests.rs`

Add `parse_ignores_metadata_fields` test:

- Build an inline XMP string carrying all 17 metadata attributes + the 5 managed
  nested elements (dc:title, dc:creator, dc:description, dc:rights, xmpRights:UsageTerms)
- Call `parse(&xml)` and assert `Ok(model)` where `model == AdjustmentModel::default()`
  (the `_ => {}` catch-all already handles these)

The Rust parser does NOT need code changes — this test confirms tolerance.

### 3. Codegen assessment

Review what might be shared across languages:

- **Namespace URIs:** currently hard-coded in TS (`xmp-metadata.ts`). Only used in TS and will
  be used in Swift. No Rust usage. Adding them to codegen would require a new codegen template
  for Swift string constants. The benefit is low (5 URIs, stable, copy is readable). **Decision:
  do not codegen** — YAGNI; the URIs are stable XMP spec values not Maple-invented constants.
- **Copyright tri-state mapping:** `CopyrightStatus` to `xmpRights:Marked` True/False. In TS
  as a Record literal in `xmp-metadata.ts`. In Swift as a switch. No Rust usage. **Decision:
  do not codegen** — only two values, trivially mirrored, no drift risk.

Codegen is **not needed** for M0b. The existing codegen emits color matrices and UI tokens.

### 4. Tests (Swift)

File: `MapleCoreTests/XMPMetadataTests.swift`

Tests (all real `.xmp` round-trips via `XMPParser.parseMetadata` and `XMPSerializer.serialize`):

1. `testGpsEncodeEdgeCases` — boundary values: zero-magnitude, negative, near-boundary carry
2. `testGpsRoundTrip` — `gpsToXmp` → `gpsFromXmp` recovers value within 1e-4 degrees
3. `testAltitudeEncodeDecodeRoundTrip` — positive + negative meters
4. `testMetadataAttrPartsFixedOrder` — fixed field order (matches TS order)
5. `testMetadataAllFieldsSerializeParseRoundTrip` — 21 fields, serialize → parseMetadata → verify
6. `testMetadataAbsentFieldsOmitted` — default XmpMetadata() emits nothing
7. `testMetadataNamespacesDeclaredConditionally` — only used namespaces appear
8. `testMetadataCopyrightStatusEncoding` — tri-state: unknown omits, copyrighted→True, publicDomain→False
9. `testMetadataLangAltXmlEscaping` — `&`, `<`, `>` in title/caption/etc
10. `testMetadataCoexistsWithAdjustmentFields` — metadata + adjustment fields in same sidecar
11. `testMetadataByteStableRoundTrip` — serialize → parse → serialize = same string (per-platform byte-stable)
12. `testCrossParserSemanticParity` — TS-serialized sidecar (embedded fixture string) parses correctly in Swift

### 5. Tests (Rust)

Addition to `src/raw-pipeline/raw-core/src/xmp/tests.rs`:

- `parse_ignores_metadata_fields` — confirm parse of a metadata-carrying sidecar does not error

## File changes

| File                                                                             | Action                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+Metadata.swift` | **Create**                                                      |
| `src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPMetadataTests.swift`       | **Create**                                                      |
| `src/raw-pipeline/raw-core/src/xmp/tests.rs`                                     | **Edit** (add 1 test)                                           |
| `XMPSerialization.swift`                                                         | **Edit** (add `metadata:` param + emit namespaces/attrs/nested) |

## GPS edge cases (from TS source)

These must match exactly:

- `gpsToXmp(0, 'lat')` → `"0,0.0000N"` (zero-magnitude → positive hemisphere N not S)
- `gpsToXmp(-0.0, 'lat')` → `"0,0.0000N"` (same — normalize -0)
- Near-boundary: a value where `abs * 60 * 1e4` rounds to exactly 60.0000 — e.g. some value
  that produces roundedMinutes = 3600 → deg=60, min=0.0000 (carry into degrees, never emits 60 as minutes)
- Negative: `gpsToXmp(-33.8688, 'lat')` → `"33,52.1280S"`

## Verification gates

- `swift test` (from `src/apple/Packages/MapleCore`) — all green
- `cargo test -p raw-core --lib` — no regressions
- `tools/codegen.sh` — no drift (codegen not changed, but run to confirm)
