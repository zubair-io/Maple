# XMP Sidecar Canonical Format

Maple sidecars must round-trip byte-for-byte between the Swift
`XMPSerializer` and the TypeScript `XmpSerializerService`. This doc pins down
the formatting choices that make that possible.

Any deviation on either side is a bug.

---

## File envelope

Every sidecar starts with:

```
<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.com/maple-maple/1.0/"
      xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
      <!-- sorted attributes here -->
      <!-- or: /> for self-close -->
      <!-- or: > ... </rdf:Description> if there are nested children -->
```

Ends with:

```
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
```

Namespace declarations on `rdf:Description` are **always emitted in this exact
order** regardless of whether the namespace is used. They're structural; the
canonical ordering is for fingerprinting stability.

The BOM (`\uFEFF`) inside `xpacket begin` is literal — do not strip it.

## Line endings

- `\n` (LF). Never `\r\n`.
- No trailing newline after `<?xpacket end="w"?>` — file ends with `>`.

## Indentation

- 2 spaces per level.
- `rdf:RDF` indented 2, `rdf:Description` indented 4, attributes on
  `rdf:Description` indented 6, children of `rdf:Description` indented 6.
- Nested element children indent 2 further per level.

## Attribute ordering on `rdf:Description`

Attributes are sorted by:

1. **Namespace priority** (hardcoded):
   - `xmp:` → 0
   - `crs:` → 1
   - `papp:` → 2
   - `xmpMM:` → 3
   - Anything else → 500 (unknown namespaces)
2. **Then alphabetical** within each namespace.

Unknown-namespace attributes (passthrough) sort after all known ones,
alphabetically by fully-qualified name.

## Attribute values

- Always double-quoted.
- XML-escaped: `&` → `&amp;`, `"` → `&quot;`, `<` → `&lt;`, `>` → `&gt;`.
- No single-quote form.

## Element forms

A leaf element (no text, no children) is **self-closing**:

```
<crs:ToneCurvePV2012/>
```

A leaf element with text content uses the **inline** form (no extra whitespace):

```
<rdf:li>128, 140</rdf:li>
```

An element with element children uses the **multi-line** form:

```
<rdf:Seq>
  <rdf:li>0, 0</rdf:li>
  <rdf:li>128, 140</rdf:li>
  <rdf:li>255, 255</rdf:li>
</rdf:Seq>
```

Indentation is relative to the enclosing element. Each child is on its own line.

## Number formatting

Identical on Swift and TypeScript:

- Integer values (where `value === round(value)`) serialize as `String(Int(v))`
  — no trailing `.0`.
- Non-integer values: format to 2 decimal places, then strip trailing zeros and
  any trailing `.`:
  - `0.5` → `"0.5"`
  - `0.50` → `"0.5"`
  - `0.123` → `"0.12"` (truncation at 2 decimals)
  - `-0.1` → `"-0.1"`
- NaN / Infinity: not allowed in sidecar values. Defaults substituted.

## Number fields and defaults

Fields emit **only when non-default** — reduces sidecar size and matches what

| Field            | XMP key                   | Default |
| ---------------- | ------------------------- | ------- |
| `exposure`       | `crs:Exposure2012`        | 0       |
| `contrast`       | `crs:Contrast2012`        | 0       |
| `highlights`     | `crs:Highlights2012`      | 0       |
| `shadows`        | `crs:Shadows2012`         | 0       |
| `whites`         | `crs:Whites2012`          | 0       |
| `blacks`         | `crs:Blacks2012`          | 0       |
| `temperature`    | `crs:Temperature`         | 6500    |
| `tint`           | `crs:Tint`                | 0       |
| `vibrance`       | `crs:Vibrance`            | 0       |
| `saturation`     | `crs:Saturation`          | 0       |
| `clarity`        | `crs:Clarity2012`         | 0       |
| `texture`        | `crs:Texture`             | 0       |
| `dehaze`         | `crs:Dehaze`              | 0       |
| `sharpenAmount`  | `crs:SharpenAmount`       | 0       |
| `sharpenRadius`  | `crs:SharpenRadius`       | 1.0     |
| `sharpenDetail`  | `crs:SharpenDetail`       | 25      |
| `sharpenMasking` | `crs:SharpenEdgeMasking`  | 0       |
| `nrLuminance`    | `crs:LuminanceSmoothing`  | 0       |
| `nrColor`        | `crs:ColorNoiseReduction` | 25      |

**Always-emitted attributes** (process-version signaling):

- `crs:Version`
- `crs:ProcessVersion`
- `crs:HasSettings` (value `"True"`)

## Crop fields

All emit together when `crop` is non-identity. `HasCrop="True"` signals crop data.

| Field         | XMP key                   | Notes                        |
| ------------- | ------------------------- | ---------------------------- |
| (marker)      | `crs:HasCrop`             | Always `"True"` when cropped |
| `crop.top`    | `crs:CropTop`             | 0…1                          |
| `crop.left`   | `crs:CropLeft`            | 0…1                          |
| `crop.bottom` | `crs:CropBottom`          | 0…1                          |
| `crop.right`  | `crs:CropRight`           | 0…1                          |
| `crop.angle`  | `crs:CropAngle`           | Only emit if ≠0              |
| (marker)      | `crs:CropConstrainToWarp` | Always `"0"`                 |

## Culling fields

- `xmp:Rating` — only emitted when > 0 (Adobe convention: absence = unrated).
- `papp:Flag` — only emitted when not "unflagged". Values: `pick` or `reject`.
- `papp:ColorLabel` — only emitted when set. Values: `red` / `orange` /
  `yellow` / `green` / `blue`.

## Tone curves

Nested element form. Each curve is a `crs:ToneCurvePV2012*` element containing
an `rdf:Seq` of `rdf:li` strings in the format `"x, y"` (with a space after
the comma).

```xml
<crs:ToneCurvePV2012>
  <rdf:Seq>
    <rdf:li>0, 0</rdf:li>
    <rdf:li>128, 140</rdf:li>
    <rdf:li>255, 255</rdf:li>
  </rdf:Seq>
</crs:ToneCurvePV2012>
```

Only emitted when the curve is non-identity. Child element order:

1. `crs:ToneCurvePV2012`
2. `crs:ToneCurvePV2012Red`
3. `crs:ToneCurvePV2012Green`
4. `crs:ToneCurvePV2012Blue`

## Passthrough

Unknown attributes on `rdf:Description` go into `passthroughFields` and re-emit
sorted alphabetically by full name (including namespace prefix).

Unknown nested elements inside `rdf:Description` go into `passthroughNodes` and
re-emit **in original order** (masks, history, snapshots depend on ordering).

## Version signaling

Maple writes `crs:Version` and `crs:ProcessVersion` with the same value,
currently hardcoded to `"11.0"` (Adobe's Process Version 2022 / PV11).
Imported sidecars retain their original version string.

---

---

## `papp:Panorama` schema (T5.6)

Defined in
[`Sources/MapleCore/Sidecar/PanoramaSidecar.swift`](../src/apple/Packages/MapleCore/Sources/MapleCore/Sidecar/PanoramaSidecar.swift).

### Namespace disambiguation

The `papp:` prefix (`http://ns.justmaple.app/1.0/`) is already used for
flat scalar attributes (`papp:HighlightRecoveryMode`, `papp:Flag`,
`papp:ColorLabel`). Panorama metadata uses the same URI but expresses itself
as a **nested element** child of `rdf:Description` — not as additional
flat attributes — so there is no name collision. No new namespace URI is
required.

### Structure

```xml
<papp:Panorama>

  <papp:PanoSourceList>
    <rdf:Seq>
      <rdf:li rdf:parseType="Resource">
        <papp:SourcePath>/abs/path/to/frame.dng</papp:SourcePath>
        <!-- papp:SourceBookmark is optional (base64 security-scoped bookmark) -->
        <papp:SourceBookmark>YmFzZTY0…</papp:SourceBookmark>
        <papp:SourceHash>sha256hexdigest</papp:SourceHash>
        <papp:FocalLength>50</papp:FocalLength>
        <papp:ExposureValue>0</papp:ExposureValue>
      </rdf:li>
      <!-- one <rdf:li> per source image -->
    </rdf:Seq>
  </papp:PanoSourceList>

  <papp:PanoAlignment rdf:parseType="Resource">
    <papp:Homography>
      <rdf:Seq>
        <!-- 9 elements, row-major 3×3 float; identity = 1 0 0 / 0 1 0 / 0 0 1 -->
        <rdf:li>1</rdf:li>
        <rdf:li>0</rdf:li>
        <!-- … 7 more … -->
      </rdf:Seq>
    </papp:Homography>
    <papp:BAResidual>0.42</papp:BAResidual>
  </papp:PanoAlignment>

  <papp:PanoOutput rdf:parseType="Resource">
    <papp:OutputWidth>8192</papp:OutputWidth>
    <papp:OutputHeight>2048</papp:OutputHeight>
    <!-- rectilinear | cylindrical | spherical -->
    <papp:OutputProjection>cylindrical</papp:OutputProjection>
  </papp:PanoOutput>

  <!-- Quick | Quality -->
  <papp:PanoPreset>Quality</papp:PanoPreset>

</papp:Panorama>
```

### Field definitions

| Field | Type | Notes |
|---|---|---|
| `papp:SourcePath` | string | Absolute filesystem path at stitch time |
| `papp:SourceBookmark` | string (base64) | Security-scoped bookmark; optional |
| `papp:SourceHash` | string (hex) | SHA-256 of the source image bytes |
| `papp:FocalLength` | float (mm) | From EXIF; 0 if unknown |
| `papp:ExposureValue` | float (EV) | From EXIF; 0 if unknown |
| `papp:Homography` | rdf:Seq of 9 floats | Row-major 3×3; identity when alignment not computed |
| `papp:BAResidual` | float | Mean BA reprojection residual in pixels; 0 when not computed |
| `papp:OutputWidth` | uint32 | Stitched panorama width in pixels |
| `papp:OutputHeight` | uint32 | Stitched panorama height in pixels |
| `papp:OutputProjection` | string | `rectilinear`, `cylindrical`, or `spherical` |
| `papp:PanoPreset` | string | `Quick` (Vision fast path) or `Quality` (Rust pano-core) |

### Number formatting

Same rules as the top-level number-formatting section: integer when whole
(`"1"`, `"50"`), otherwise 2 decimal places with trailing zeros stripped
(`"0.42"`, `"0.5"`).

### Round-trip contract

`PanoramaXMPSerializer.serialize(_:)` → `PanoramaXMPParser.parse(_:)` must
reproduce the original `PanoramaSidecar` struct with field-level equality.
Idempotency: serialize → parse → serialize must produce byte-identical XML.
Verified by `PappSchemaTests` in `Tests/MapleCoreTests/`.

### Passthrough

The `papp:Panorama` element is treated as an unknown nested element by the
existing `XMPParser` / `XMPSerializer` (which handle `AdjustmentModel` and
`CullingState`). It survives round-trips through those parsers via the
`passthroughNodes` mechanism described in the "Passthrough" section above.

---

## Test contract

Both parsers must produce the same `AdjustmentModel` from any valid input, and
both serializers must produce the same bytes from any equal model. The test
matrix:

1. **Self round-trip (Swift)**: Swift serialize → Swift parse → assert
   AdjustmentModel equality
2. **Self round-trip (TS)**: TS serialize → TS parse → assert equality
3. **Cross round-trip**: Swift serialize → TS parse → TS serialize → Swift
   parse → assert equality; bytes should also be identical
4. **Fixture parse**: parse a real sidecar, re-emit,
   byte-compare against the original (allowing only whitespace normalization)
5. **Nested-mask survival**: a sidecar with 10 `crs:MaskGroupBasedCorrections`
   entries; write → parse → write must be byte-equal

Any canonical-format change requires updating both implementations **and** this
document in the same commit.
