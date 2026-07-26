# XMP Sidecar Canonical Format

Maple sidecars must round-trip byte-for-byte between the Swift
`XMPSerializer` and the TypeScript `XmpSerializerService`. This doc pins down
the formatting choices that make that possible.

Any deviation on either side is a bug.

The two implementations of this document are
`src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+Canonical.swift`
and `src/web/projects/maple-common/src/lib/xmp/xmp-canonical.ts` (#1577). The
zero-byte-diff gate is the shared golden literal duplicated between
`XMPCanonicalFormatTests.swift` and `xmp-canonical.spec.ts`.

## What the parity claim covers

Byte identity holds for **the canonical document produced from a model both
writers emit the same field set for**. It is deliberately not a claim about
arbitrary round-tripped documents, because the two writers do not model the
same things:

- The TypeScript writer preserves unknown attributes and unknown nested nodes;
  Apple's `XMPSerializer` has no passthrough at all (**#2233**). A sidecar
  carrying foreign fields therefore cannot be byte-equal across the two.
- `papp:Hidden` has no TypeScript writer, and `papp:WbMethod` /
  `papp:ToneCurveMode` have no Apple model field (**#2216**).
- The ~20 sliders Apple authors unconditionally are omitted at their defaults
  by the web writer, so the two attribute sets converge only once those fields
  are authored. The shared golden fixture sets every one of them to a
  non-default value for exactly this reason.

Everything else — envelope, namespace URIs and declaration order, indentation,
attribute ordering, number formatting, nested-child shape and order — is
identical, and a change to any of it must land on both sides and in this
document in the same commit.

---

## File envelope

Every sidecar starts with:

```
<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/photo/1.0/"
      <!-- conditional namespaces here, in the order: -->
      <!--   dc, exif, photoshop, Iptc4xmpCore, xmpRights -->
      <!-- then sorted attributes -->
      <!-- then: /> for self-close -->
      <!-- or:   > ... </rdf:Description> if there are nested children -->
```

Ends with:

```
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
```

The three core namespace declarations are **always emitted in this exact
order** regardless of whether the namespace is used. They're structural; the
canonical ordering is for fingerprinting stability. The metadata namespaces
below them are conditional — declared only when the payload uses them — and
keep their fixed relative order.

`rdf:about=""` rides on the `rdf:Description` open tag and is not part of the
sorted attribute list. It is structural (RDF requires it, and every Adobe
writer emits it), not payload.

No `x:xmptk` toolkit attribute is written. A toolkit string names the
producing platform, which is precisely what the canonical form must not depend
on; the TypeScript writer emitted `Maple Hosted 0.1.0` before #1577 and Apple
emitted none.

### The `papp:` namespace URI

`http://ns.justmaple.app/photo/1.0/`. Before #1577 the TypeScript writer and
the API used that value while Apple used `http://ns.justmaple.app/1.0/`, and
this document claimed a third (`http://ns.justmaple.com/maple-maple/1.0/`)
that no writer has ever produced.

Picking one is safe because **no parser on any platform resolves the URI**:
raw-core's `xmp::parse` matches attribute names byte-wise (`papp:Profile`),
Apple's `XMLParser` runs with namespace processing off so `attributeDict` is
keyed on qualified names, and the TypeScript parser compares `attr.name`,
which is also the qualified name. The `papp:` **prefix** is the discriminator
everywhere — including the WB slider-scale authorship heuristic below, which
is documented as keying on the prefix for this exact reason. Sidecars already
on disk under the old Apple URI keep parsing unchanged and pick up the
canonical URI the next time they are saved. Nothing rewrites them in place.

The BOM (`\uFEFF`) inside `xpacket begin` is literal — do not strip it.

## Line endings

- `\n` (LF). Never `\r\n`.
- No trailing newline after `<?xpacket end="w"?>` — file ends with `>`.

## Indentation

- 2 spaces per level.
- `rdf:RDF` indented 2, `rdf:Description` indented 4, namespace declarations
  and attributes on `rdf:Description` indented 6, children of
  `rdf:Description` indented 6.
- Nested element children indent 2 further per level. This is one ladder for
  every child: the `dc:subject` keyword bag, the `papp:SceneLinearToneCurve*`
  blocks, and the metadata `dc:title` / `dc:creator` / `dc:description` /
  `dc:rights` / `xmpRights:UsageTerms` blocks (which used 2/3/4 before #1577).

## Attribute ordering on `rdf:Description`

Attributes are sorted by:

1. **Namespace priority** (hardcoded):
   - `xmp:` → 0
   - `crs:` → 1
   - `papp:` → 2
   - `dc:` → 3
   - `exif:` → 4
   - `photoshop:` → 5
   - `Iptc4xmpCore:` → 6
   - `xmpRights:` → 7
   - Anything else → 500 (unknown namespaces)
2. **Then alphabetical** within each namespace, by fully-qualified name.

Unknown-namespace attributes (passthrough) sort after all known ones,
alphabetically by fully-qualified name. Attribute names are ASCII XML NCNames,
so Swift's string ordering and JavaScript's UTF-16 code-unit ordering agree.

Attribute order carries no meaning on read: all three parsers resolve
legacy-alias precedence (capture-sharpening sigma, `papp:Profile` over
`papp:Look`, `papp:Flag` over `xmp:Label`) and the `crs:HasCrop` gate with
explicit pre-passes rather than by relying on document order, so sorting is
free.

## Attribute values

- Always double-quoted.
- XML-escaped: `&` → `&amp;`, `"` → `&quot;`, `<` → `&lt;`, `>` → `&gt;`.
- No single-quote form.

## Element forms

A leaf element (no text, no children) is **self-closing**:

```
<crs:Snapshots/>
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

Every numeric attribute goes through this codec — `numericSerializer` in
TypeScript, `XMPSerializer.fmtNum` in Swift. Before #1577 the Swift writer used
a per-field `%.0f` / `%.1f` / `%.2f`, which both diverged from the web writer
(`"1.50"` vs `"1.5"`, `"2.0"` vs `"2"`) and quantized fractional slider values
on every re-save.

The one exception is the crop group, which formats at six decimals on both
sides (`fmtCrop` / `_fmtCrop`): crop edges are normalized fractions of the
frame, where two decimals would quantize the rect to whole percents.

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
| `parametricHighlights`         | `crs:ParametricHighlights`           | 0       |
| `parametricLights`             | `crs:ParametricLights`               | 0       |
| `parametricDarks`              | `crs:ParametricDarks`                | 0       |
| `parametricShadows`            | `crs:ParametricShadows`              | 0       |
| `temperature`                  | `crs:Temperature`                    | 6500    |
| `tint`                         | `crs:Tint`                           | 0       |
| `vibrance`                     | `crs:Vibrance`                       | 0       |
| `saturation`                   | `crs:Saturation`                     | 0       |
| `clarity`                      | `crs:Clarity2012`                    | 0       |
| `texture`                      | `crs:Texture`                        | 0       |
| `dehaze`                       | `crs:Dehaze`                         | 0       |
| `sharpenAmount`                | `crs:Sharpness`                      | 40      |
| `sharpenRadius`                | `crs:SharpenRadius`                  | 1.0     |
| `sharpenDetail`                | `crs:SharpenDetail`                  | 25      |
| `sharpenMasking`               | `crs:SharpenEdgeMasking`             | 0       |
| `captureSharpeningAmount`      | `papp:CaptureSharpeningAmount`       | 0       |
| `captureSharpeningSigma`       | `papp:CaptureSharpeningSigma`        | 1.0     |
| `nrLuminance`                  | `crs:LuminanceSmoothing`             | 0       |
| `nrColor`                      | `crs:ColorNoiseReduction`            | 25      |
| `chromaPrefilter`              | `papp:ChromaPrefilter`               | 0       |
| `deepDenoise`                  | `papp:DeepDenoise`                   | 0       |
| `vignetteAmount`               | `crs:PostCropVignetteAmount`         | 0       |
| `vignetteFeather`              | `crs:PostCropVignetteFeather`        | 50      |
| `grainAmount`                  | `crs:GrainAmount`                    | 0       |
| `grainSize`                    | `crs:GrainSize`                      | 25      |
| `grainRoughness`               | `crs:GrainFrequency`                 | 50      |
| `splitToneShadowHue`           | `crs:SplitToningShadowHue`           | 0       |
| `splitToneShadowSaturation`    | `crs:SplitToningShadowSaturation`    | 0       |
| `splitToneHighlightHue`        | `crs:SplitToningHighlightHue`        | 0       |
| `splitToneHighlightSaturation` | `crs:SplitToningHighlightSaturation` | 0       |
| `splitToneBalance`             | `crs:SplitToningBalance`             | 0       |
| `colorGradeShadowLuminance`    | `crs:ColorGradeShadowLum`            | 0       |
| `colorGradeMidtoneHue`         | `crs:ColorGradeMidtoneHue`           | 0       |
| `colorGradeMidtoneSaturation`  | `crs:ColorGradeMidtoneSat`           | 0       |
| `colorGradeMidtoneLuminance`   | `crs:ColorGradeMidtoneLum`           | 0       |
| `colorGradeHighlightLuminance` | `crs:ColorGradeHighlightLum`         | 0       |
| `colorGradeGlobalHue`          | `crs:ColorGradeGlobalHue`            | 0       |
| `colorGradeGlobalSaturation`   | `crs:ColorGradeGlobalSat`            | 0       |
| `colorGradeGlobalLuminance`    | `crs:ColorGradeGlobalLum`            | 0       |
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
| `grayMixerRed`                 | `crs:GrayMixerRed`                   | 0       |
| `grayMixerOrange`              | `crs:GrayMixerOrange`                | 0       |
| `grayMixerYellow`              | `crs:GrayMixerYellow`                | 0       |
| `grayMixerGreen`               | `crs:GrayMixerGreen`                 | 0       |
| `grayMixerAqua`                | `crs:GrayMixerAqua`                  | 0       |
| `grayMixerBlue`                | `crs:GrayMixerBlue`                  | 0       |
| `grayMixerPurple`              | `crs:GrayMixerPurple`                | 0       |
| `grayMixerMagenta`             | `crs:GrayMixerMagenta`               | 0       |

**HSL band mapping** (#1112): All 24 `crs:Hue/Saturation/LuminanceAdjustment*` keys are
ACR-compatible. All default to 0; any field equal to 0 is omitted on write.
Range −100…+100. The stage runs in scene-linear Oklab after the saturation pass.

**Black & white mix** (#276): The eight `crs:GrayMixer*` keys are the per-band
luminance weights of the monochrome conversion, over the same eight hue bands
and the same raised-cosine partition as the HSL block above. Range −100…+100,
default 0, omitted on write when 0. They only affect the render while the
`crs:ConvertToGrayscale` toggle below is `True`; a sidecar may carry a mix
alongside a colour render without changing it.

**Enum fields** (emit only when non-default, string-valued):

- `papp:HotPixelSuppression` — `Off` (default) / `On`. Pre-demosaic
  hot/dead-pixel suppression inside the decode product (#1106).
- `papp:HighlightRecoveryMode` — `ChromaticAdaptation` (default) / `Off` /
  `Blend` / `Luminance` / `OklabChromaReduction`. Highlight reconstruction
  mode (spec § 3.3a). Case-insensitive on read. TS wiring added in #2214.
- `papp:AutoExposure` — `On` (default) / `Off`. Decode-time scalar mid-gray
  anchor gain (#429; Swift model mirror #1387). Case-insensitive on read.
  TS wiring added in #2214.
- `papp:WbMethod` — `Cat16` (default) / `DiagonalRec2020`. User white-balance
  method (#431). Case-insensitive on read (raw-core also accepts `CAT16`).
  TS wiring added in #2214.
- `papp:ToneCurveMode` — `PerChannel` (default) / `RatioPreserving`.
  Tone-curve application mode (#436). Case-insensitive on read. TS wiring
  added in #2214.
- `crs:ConvertToGrayscale` — `False` (default) / `True`. Black & white
  conversion (#276); ACR-compatible, so the toggle interchanges with
  Lightroom along with the `crs:GrayMixer*` weights. Written as `True` only,
  since `False` is the default and is omitted. Read accepts `true`/`false`
  in any case plus `1`/`0`; an unrecognised spelling is a parse ERROR rather
  than a silent `Off`, so a sidecar we do not understand is never rendered
  in colour by mistake. While `True`, the 24 HSL keys above are inert.

**Always-emitted attributes** (process-version signaling):

- `crs:Version`
- `crs:ProcessVersion`
- `crs:HasSettings` (value `"True"`)

Apple additionally authors white balance unconditionally on every save —
`crs:WhiteBalance="Custom"`, `crs:Temperature`, `crs:Tint` and the
`papp:WbScaleVersion` stamp — because its model has no white-balance preset
field and the render contract depends on an explicit pair (#1883). The web
writer omits all four while its preset is `As Shot`, since emitting the
estimator's as-shot seed would demote the As-Shot sentinel into an authored
target (#1892). Apple's `crs:WhiteBalance="Custom"` is the truthful label for
an always-explicit pair and is what the web parser already infers from one; it
reads back as a no-op on Apple.

Apple also emits every remaining slider in the group above unconditionally,
while the web writer omits those at their defaults. That is the one content
difference left between the two writers for a shared model, and it is why the
parity fixture authors all of them.

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
- `papp:Flag` — only emitted when not "unflagged". Values: `pick` or `reject`,
  matched case-sensitively on read by all three parsers.
  **Legacy read-only alias (#2221):** Apple sidecars written before this
  ticket carried the flag as `xmp:Label="Red"` (pick) / `xmp:Label="Rejected"`
  (reject) instead. The Apple parser still accepts `red` / `pick` /
  `reject` / `rejected` from `xmp:Label` (case-insensitive) so those files
  keep their flags, and a normal save rewrites them to `papp:Flag`; no
  serializer emits the alias any more, and `papp:Flag` takes precedence when
  both attributes are present. The web/API parsers never read the alias —
  they treat `xmp:Label` as a colour word only (see below).
- `papp:ColorLabel` — only emitted when set. Values: `red` / `orange` /
  `yellow` / `green` / `blue` / `purple` (the six-color vocabulary
  settled in #1657; this line still listed the pre-#1657 five when Apple
  gained the field in #1656). The web parser also reads Adobe's `xmp:Label`
  colour word (`Red` / `Orange` / … ) as a colour label for Lightroom-authored
  sidecars, preferring `papp:ColorLabel` when both are present.
- `papp:Hidden` — `"true"` or `"false"`. Explicit user override for the
  hidden-image feature; absence means no override (the effective hidden
  state falls back to the describe stage's nudity verdict — see
  `AssetDoc.hidden` in `db/schema.ts`). Apple only emits the attribute when
  `true` (parity note: both platforms treat an absent attribute as
  `false`/no-override).

## Tone curves

The **parametric region sliders** (`parametricHighlights/Lights/Darks/Shadows`)
are NOT part of this nested form — they are flat PV2012 `crs:Parametric*`
attributes, listed in the number-fields table above (#365).

**Point curves** use the nested element form. Each curve is a
`papp:SceneLinearToneCurve*` element containing an `rdf:Seq` of `rdf:li`
strings in the format `"x, y"` (with a space after the comma).

```xml
<papp:SceneLinearToneCurve>
  <rdf:Seq>
    <rdf:li>0, 0</rdf:li>
    <rdf:li>128, 140</rdf:li>
    <rdf:li>255, 255</rdf:li>
  </rdf:Seq>
</papp:SceneLinearToneCurve>
```

Only emitted when the curve is non-identity. Child element order:

1. `papp:SceneLinearToneCurve` → `toneCurveLuma`
2. `papp:SceneLinearToneCurveRed` → `toneCurveRed`
3. `papp:SceneLinearToneCurveGreen` → `toneCurveGreen`
4. `papp:SceneLinearToneCurveBlue` → `toneCurveBlue`

Coordinates are stored on the model in `[0, 1]` and written in PV2012's
`[0, 255]` domain; the scale factor is applied at the parser/serializer
boundary only, and the coordinate strings go through the same number codec as
attribute values (integers bare, non-integers at two decimals with trailing
zeros stripped). **The identity curve is the empty control-point list, and it
emits no element at all** — never an empty `rdf:Seq` — so a sidecar for an
image with no authored curve is byte-identical to what the pre-#365 writers
produced.

### Namespace decision (#365)

Maple's point curves live under `papp:`, not Adobe's `crs:ToneCurvePV2012*`,
because the two are **different quantities** rather than two spellings of the
same one (`docs/maple-paper.md` § 3, "tone curve families"):

- `papp:SceneLinearToneCurve*` is **scene-linear**. The #273 pipeline
  foundation applies these curves _before_ the AgX view transform, with the
  curve's `[0, 255]` authoring domain mapped onto scene `[0, 4.0]`.
- `crs:ToneCurvePV2012*` is **display-referred**. Those curves were authored
  against Lightroom's own (proprietary, version-dependent) view transform and
  only mean anything _after_ a view transform.

Consequently `crs:ToneCurvePV2012*` is **not parsed into `toneCurve*`** on any
platform. Applying a display-referred shape to scene-linear light would render
an imported Lightroom curve visibly wrong, and re-deriving one as a
scene-linear curve would require inverting Lightroom's view transform — lossy
even when it is possible. Nor is there a second display-referred storage slot
today: nothing in the pipeline consumes one yet, so adding one would be
speculative. Instead, `crs:ToneCurvePV2012*` rides the **unknown-node
passthrough** — it is preserved verbatim across a read-modify-write, so an
imported Lightroom sidecar keeps the curve intact for the round trip back.

Real display-referred (post-AgX) tone-curve support — a pipeline slot plus the
storage that goes with it — is tracked as **#2232**.

Passthrough coverage differs by platform today. The TypeScript writer
implements both halves (`PassthroughBucket.unknownAttributes` and
`.unknownNodes`, the latter re-emitted verbatim from the source element's
serialized form), so a Lightroom curve survives the Hosted/Self-Hosted write
path byte-for-byte. Apple's `XMPSerializer` has **no passthrough at all** —
neither attributes nor nested nodes — which predates this ticket and applies
to every unmodelled field, not just tone curves; that gap is tracked as
**#2233**. Rust ships only a fragment serializer (`xmp::serialize` for
attributes, `xmp::serialize_tone_curves` for the curve block) and never writes
a whole document, so it has nothing to preserve.

## Passthrough

Unknown attributes on `rdf:Description` go into `passthroughFields` and re-emit
sorted alphabetically by full name (including namespace prefix).

Unknown nested elements inside `rdf:Description` go into `passthroughNodes` and
re-emit **in original order** (masks, history, snapshots depend on ordering).

The TypeScript writer implements both halves. Apple's has neither — its parser
returns only `(AdjustmentModel, CullingState)` and its serializer rebuilds the
document from those, so a Lightroom sidecar loses masks, history and snapshots
on the first Apple edit. That predates this format and is tracked as **#2233**;
it is also why the byte-parity claim above is scoped to documents without
foreign fields.

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

## WB slider-scale versioning (#1756, #1780, #1875)

PR #1756 changed what stored `crs:Temperature` / `crs:Tint` numbers MEAN:
they are now interpreted in ACR's calibration frame
(`raw-core stages::wb_camera::SliderFrame`, identity at the image's as-shot
CCT) instead of the pre-#1756 post-DCP CAT16 scale (identity at
6500 K / tint 0). #1875 then fixed the tint AXIS of that frame scale: the
#1756–#1875 interpretation rendered positive tint green-ward — the
opposite of ACR's convention (and of the slider gradient), where positive
tint pushes the image toward magenta. Both are schema-semantics changes,
versioned on the sidecar:

- **Stamp:** `papp:WbScaleVersion` — `"1"` (pre-#1756 scale), `"2"`
  (#1756–#1875 frame scale, tint axis inverted vs ACR), or `"3"`
  (frame scale, ACR tint direction — current). Both the Swift and
  TypeScript writers emit the stamp whenever they write an explicit
  `crs:Temperature` / `crs:Tint` (the Swift writer emits those
  unconditionally, so it always stamps). A version-1 sidecar re-saves as
  version 1 so its stored numbers keep their meaning; everything else is
  written as version 3 — the Swift and TS parsers normalize a loaded V2
  model to V3 (negating an explicitly authored `crs:Tint`, which
  preserves the authored look exactly since the two axis orientations are
  the same line with opposite sign). Fresh models are version 3.
- **Absent stamp:** decided by authorship. A document that carries the
  Maple `papp:` namespace (every Maple writer declares it unconditionally
  — the _prefix_ is the discriminator, since the three writers bind it to
  different URIs) AND an explicit `crs:Temperature`/`crs:Tint` predates
  the versioning and reads as **1**. Everything else reads as **3**: a
  document with no `papp:` namespace at all (ACR/Lightroom-authored) is
  expressed in ACR's own convention — which V3 matches — and a document
  with no authored WB has nothing to convert (as-shot renders identically
  on every scale).
- **Conversion happens in raw-core** (`wb_camera::resolve_target_versioned`
  for the calibrated tiers, `white_balance::resolve_wb` for the fallback
  tier): version-1 values with an explicit authored Temperature/Tint are
  re-expressed in the current frame at develop time, and version-2
  authored tints are negated into the V3 axis, so the rendered look is
  preserved; the stored numbers are never rewritten by raw-core. (The
  Swift/TS loaders additionally normalize V2 → V3 in-memory so slider
  display, live render params, and re-saves are uniformly V3.)
- All three parsers (Rust `xmp::parse`, Swift `XMPParser`, TS
  `XmpParserService`) implement the same stamp-else-heuristic rule, and
  the platform models carry the version (`wb_scale_version` /
  `wbScaleVersion`) so host-serialized documents (e.g. the Apple render
  path's temp sidecar) keep it intact.

---

## What does not live in XMP

XMP is the contract for **user-authored** adjustments, culling, crop, and metadata. Derived metadata — values produced by deterministic re-runnable enrichment passes — stays in MongoDB. The line is the same one drawn for face detections and reverse-geocoded place data today, and it now also covers the structured `vision.*` subdoc.

The `vision.*` data (is_screenshot, nudity, caption, subjects, scene_type, setting, activity, time_of_day, lighting, weather, mood, colors, composition, text_visible, notable_objects, shot_type) is **never** written to the sidecar. The reason is that it is fully reproducible from `(model, prompt_version)` — the two fields carried in `vision_meta` — and the indexer already re-runs the describe stage automatically when either is bumped. Burning it into the XMP sidecar would mean a sidecar write on every re-caption (each prompt bump re-touches every asset), ~1 KB of sidecar bloat per asset, and a backwards-compat question every time the structured schema gains or renames a field.

User-authored captions still round-trip via the existing free-text `description` and keyword paths — those are authored content, not derived, and they belong in the sidecar. The new structured `vision.*` doc is database-only. See `docs/indexer-enrichment.md` § "Vision (structured)" for the full field list and the OCR mirroring rule (`ocr_text` is populated from `vision.text_visible` on every describe pass).

---

## Test contract

Both parsers must produce the same `AdjustmentModel` from any valid input, and
both serializers must produce the same bytes from any model whose field set
they share (see "What the parity claim covers" above). What is in place today:

1. **Cross-engine zero-byte diff** — `XMPCanonicalFormatTests.swift` and
   `xmp-canonical.spec.ts` build the same fully-authored model and assert
   their own serializer reproduces the same golden document, character for
   character. The literal is duplicated verbatim in both files, the shape
   #365 established for the tone-curve block. There is no build that runs
   Swift and TypeScript in one process, so duplicating the literal is the
   diff: a divergence on either platform fails that platform's suite.
2. **Canonical invariants**, asserted separately from the golden so a
   regression names itself: the `papp:` URI, namespace declaration order, the
   absence of `x:xmptk`, namespace-priority-then-alphabetical attribute order,
   and the single six-space child-indent ladder.
3. **Legacy-layout parse** — a sidecar in the pre-#1577 Apple layout (old
   `papp:` URI, `crs, xmp, papp` declaration order, no `rdf:about`, unsorted
   attributes) parses to the expected model and culling on both platforms. On
   Swift it is written to a real file in a temp directory and read back from
   disk, per CLAUDE.md's no-mocks-for-sidecars rule.
4. **Write → parse → write is a fixed point** on both platforms, through real
   files on Swift.
5. **Per-field round-trips** — the existing per-feature suites
   (`keywords.spec.ts`, `cull-flag.spec.ts`, `ToneCurveXMPTests.swift`, …)
   continue to cover each field's own semantics.

Still open: nested-mask survival cannot be tested cross-platform until Apple
grows a passthrough (#2233).

Any canonical-format change requires updating both implementations, both
golden literals, **and** this document in the same commit.
