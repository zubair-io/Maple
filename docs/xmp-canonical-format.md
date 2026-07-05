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
Lightroom does for `crs:` fields.

| Field                          | XMP key                              | Default |
| ------------------------------ | ------------------------------------ | ------- |
| `exposure`                     | `crs:Exposure2012`                   | 0       |
| `brightness`                   | `papp:Brightness`                    | 0       |
| `contrast`                     | `crs:Contrast2012`                   | 0       |
| `highlights`                   | `crs:Highlights2012`                 | 0       |
| `shadows`                      | `crs:Shadows2012`                    | 0       |
| `whites`                       | `crs:Whites2012`                     | 0       |
| `blacks`                       | `crs:Blacks2012`                     | 0       |
| `temperature`                  | `crs:Temperature`                    | 6500    |
| `tint`                         | `crs:Tint`                           | 0       |
| `vibrance`                     | `crs:Vibrance`                       | 0       |
| `saturation`                   | `crs:Saturation`                     | 0       |
| `clarity`                      | `crs:Clarity2012`                    | 0       |
| `texture`                      | `crs:Texture`                        | 0       |
| `dehaze`                       | `crs:Dehaze`                         | 0       |
| `sharpenAmount`                | `crs:SharpenAmount`                  | 0       |
| `sharpenRadius`                | `crs:SharpenRadius`                  | 1.0     |
| `sharpenDetail`                | `crs:SharpenDetail`                  | 25      |
| `sharpenMasking`               | `crs:SharpenEdgeMasking`             | 0       |
| `nrLuminance`                  | `crs:LuminanceSmoothing`             | 0       |
| `nrColor`                      | `crs:ColorNoiseReduction`            | 25      |
| `chromaPrefilter`              | `papp:ChromaPrefilter`               | 0       |
| `deepDenoise`                  | `papp:DeepDenoise`                   | 0       |
| `vignetteAmount`               | `crs:PostCropVignetteAmount`         | 0       |
| `vignetteFeather`              | `crs:PostCropVignetteFeather`        | 0       |
| `grainAmount`                  | `crs:GrainAmount`                    | 0       |
| `grainSize`                    | `crs:GrainSize`                      | 0       |
| `grainRoughness`               | `crs:GrainFrequency`                 | 0       |
| `splitToneShadowHue`           | `crs:SplitToningShadowHue`           | 0       |
| `splitToneShadowSaturation`    | `crs:SplitToningShadowSaturation`    | 0       |
| `splitToneHighlightHue`        | `crs:SplitToningHighlightHue`        | 0       |
| `splitToneHighlightSaturation` | `crs:SplitToningHighlightSaturation` | 0       |
| `splitToneBalance`             | `crs:SplitToningBalance`             | 0       |
| `hueAdjustmentRed`             | `crs:HueAdjustmentRed`               | 0       |
| `hueAdjustmentOrange`          | `crs:HueAdjustmentOrange`            | 0       |
| `hueAdjustmentYellow`          | `crs:HueAdjustmentYellow`            | 0       |
| `hueAdjustmentGreen`           | `crs:HueAdjustmentGreen`             | 0       |
| `hueAdjustmentAqua`            | `crs:HueAdjustmentAqua`              | 0       |
| `hueAdjustmentBlue`            | `crs:HueAdjustmentBlue`              | 0       |
| `hueAdjustmentPurple`          | `crs:HueAdjustmentPurple`            | 0       |
| `hueAdjustmentMagenta`         | `crs:HueAdjustmentMagenta`           | 0       |
| `saturationAdjustmentRed`      | `crs:SaturationAdjustmentRed`        | 0       |
| `saturationAdjustmentOrange`   | `crs:SaturationAdjustmentOrange`     | 0       |
| `saturationAdjustmentYellow`   | `crs:SaturationAdjustmentYellow`     | 0       |
| `saturationAdjustmentGreen`    | `crs:SaturationAdjustmentGreen`      | 0       |
| `saturationAdjustmentAqua`     | `crs:SaturationAdjustmentAqua`       | 0       |
| `saturationAdjustmentBlue`     | `crs:SaturationAdjustmentBlue`       | 0       |
| `saturationAdjustmentPurple`   | `crs:SaturationAdjustmentPurple`     | 0       |
| `saturationAdjustmentMagenta`  | `crs:SaturationAdjustmentMagenta`    | 0       |
| `luminanceAdjustmentRed`       | `crs:LuminanceAdjustmentRed`         | 0       |
| `luminanceAdjustmentOrange`    | `crs:LuminanceAdjustmentOrange`      | 0       |
| `luminanceAdjustmentYellow`    | `crs:LuminanceAdjustmentYellow`      | 0       |
| `luminanceAdjustmentGreen`     | `crs:LuminanceAdjustmentGreen`       | 0       |
| `luminanceAdjustmentAqua`      | `crs:LuminanceAdjustmentAqua`        | 0       |
| `luminanceAdjustmentBlue`      | `crs:LuminanceAdjustmentBlue`        | 0       |
| `luminanceAdjustmentPurple`    | `crs:LuminanceAdjustmentPurple`      | 0       |
| `luminanceAdjustmentMagenta`   | `crs:LuminanceAdjustmentMagenta`     | 0       |

**HSL band mapping** (#1112): All 24 `crs:Hue/Saturation/LuminanceAdjustment*` keys are
ACR-compatible. All default to 0; any field equal to 0 is omitted on write.
Range −100…+100. The stage runs in scene-linear Oklab after the saturation pass.

**Enum fields** (emit only when non-default, string-valued):

- `papp:HotPixelSuppression` — `Off` (default) / `On`. Pre-demosaic
  hot/dead-pixel suppression inside the decode product (#1106).

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
- `papp:Hidden` — `"true"` or `"false"`. Explicit user override for the
  hidden-image feature; absence means no override (the effective hidden
  state falls back to the describe stage's nudity verdict — see
  `AssetDoc.hidden` in `db/schema.ts`). Apple only emits the attribute when
  `true` (parity note: both platforms treat an absent attribute as
  `false`/no-override).

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

## Capture-sharpening sigma migration (#456, #464)

PR #452 swapped the capture-sharpening PSF from an integer-radius
tripled-box-blur to a true Gaussian parameterised by float sigma, but kept
the XMP key as `papp:CaptureSharpeningRadius` — a silent semantic shift.
Ticket #456 separated the legacy alias from the new canonical key, and
#464 retired the legacy write path on Swift + TypeScript:

- **Canonical key:** `papp:CaptureSharpeningSigma` (float, pixels). All
  three writers (Rust, Swift, TypeScript) emit this key exclusively.
  Writes flow to `AdjustmentModel::capture_sharpening_sigma`.
- **Legacy key:** `papp:CaptureSharpeningRadius` is **read-only** on every
  platform. The legacy value is routed into `capture_sharpening_sigma`
  **unchanged** — no rescale. No shipping sidecar carries a non-zero
  capture-sharpening amount (the slider is off by default), so any
  rescale would be a guess. Authors who want the old box-blur look back
  must re-tune the slider after the schema change.
- **Precedence:** when both keys are present on the same
  `rdf:Description`, `papp:CaptureSharpeningSigma` always wins,
  regardless of document order. Each platform implements this through a
  small precedence flag (raw-core's `sigma_seen`, Swift's
  `captureSharpeningSigmaSeen`, TypeScript's `canonicallyApplied` set)
  so the rule is source-order independent.

## WB slider-scale versioning (#1756, #1780)

PR #1756 changed what stored `crs:Temperature` / `crs:Tint` numbers MEAN:
they are now interpreted in ACR's calibration frame
(`raw-core stages::wb_camera::SliderFrame`, identity at the image's as-shot
CCT) instead of the pre-#1756 post-DCP CAT16 scale (identity at
6500 K / tint 0). That is a schema-semantics change, versioned on the
sidecar:

- **Stamp:** `papp:WbScaleVersion` — `"1"` (pre-#1756 scale) or `"2"`
  (ACR calibration-frame scale). Both the Swift and TypeScript writers
  emit the stamp whenever they write an explicit `crs:Temperature` /
  `crs:Tint` (the Swift writer emits those unconditionally, so it always
  stamps), carrying the version the model was loaded with — a version-1
  sidecar re-saves as version 1 so its stored numbers keep their meaning.
  Fresh models are version 2.
- **Absent stamp:** decided by authorship. A document that carries the
  Maple `papp:` namespace (every Maple writer declares it unconditionally
  — the _prefix_ is the discriminator, since the three writers bind it to
  different URIs) AND an explicit `crs:Temperature`/`crs:Tint` predates
  the versioning and reads as **1**. Everything else reads as **2**: a
  document with no `papp:` namespace at all (ACR/Lightroom-authored) was
  always expressed in ACR's own slider scale — exactly the scale #1756
  adopted — and a document with no authored WB has nothing to convert
  (as-shot renders identically on either scale).
- **Conversion happens in raw-core only** (`wb_camera::
resolve_target_versioned`): version-1 values with an explicit authored
  Temperature/Tint are re-expressed in the version-2 frame at develop
  time so the rendered look is preserved; the stored numbers are never
  rewritten. Sidecars without an explicit Temperature/Tint follow as-shot
  on both scales and are untouched.
- All three parsers (Rust `xmp::parse`, Swift `XMPParser`, TS
  `XmpParserService`) implement the same stamp-else-heuristic rule, and
  the platform models carry the version (`wb_scale_version` /
  `wbScaleVersion`) so host-serialized documents (e.g. the Apple render
  path's temp sidecar) keep it intact.

---

## What does not live in XMP

XMP is the contract for **user-authored** adjustments, culling, crop, and metadata. Derived metadata — values produced by deterministic re-runnable enrichment passes — stays in MongoDB. The line is the same one drawn for face detections and reverse-geocoded place data today, and it now also covers the structured `vision.*` subdoc.

The `vision.*` data (caption, subjects, scene_type, setting, activity, mood, colors, composition, text_visible, notable_objects, shot_type, indoor_outdoor) is **never** written to the sidecar. The reason is that it is fully reproducible from `(model, prompt_version)` — the two fields carried in `vision_meta` — and the indexer already re-runs the describe stage automatically when either is bumped. Burning it into the XMP sidecar would mean a sidecar write on every re-caption (each prompt bump re-touches every asset), ~1 KB of sidecar bloat per asset, and a backwards-compat question every time the structured schema gains or renames a field.

User-authored captions still round-trip via the existing free-text `description` and keyword paths — those are authored content, not derived, and they belong in the sidecar. The new structured `vision.*` doc is database-only. See `docs/indexer-enrichment.md` § "Vision (structured)" for the full field list and the OCR mirroring rule (`ocr_text` is populated from `vision.text_visible` on every describe pass).

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
