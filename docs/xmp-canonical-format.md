# XMP Canonical Format

Every edit a user makes in Maple is stored in a plain-text `.xmp` sidecar next to the original file — the original bytes are never touched. This document is the contract for those sidecars: exactly which bytes a Maple writer produces, which attribute names carry which slider, and what a reader must do with content it does not recognise. Four independent implementations must agree on it — Rust (`raw-core`, the render-side reader), Swift (Apple apps), TypeScript (Web and the Bun API), and C# (the Windows shell) — because a photo edited on a Mac, re-opened in a browser and then re-saved from Windows has to come back unchanged. Two of those writers (Swift and TypeScript) are held to a **byte-for-byte** golden document; all four are held to a semantic round trip.

The single rule everything else follows from: a sidecar Maple writes must be a fixed point. Parse it, serialize it again with nothing changed, and you get the identical bytes back — including the parts of the document Maple does not understand.

## Where sidecars live

A sidecar sits beside the file it describes, with two naming rules:

- **Images** swap the extension: `IMG_1234.ARW` → `IMG_1234.xmp`.
- **Videos** keep theirs and append: `clip.mov` → `clip.mov.xmp`.

The split exists for Apple Live Photos, which store the still and the motion clip as two same-stem files (`IMG_1234.HEIC` + `IMG_1234.MOV`); under a stem swap both would target `IMG_1234.xmp` and clobber each other. The rule is implemented twice and must stay in sync: `src/apple/Packages/MapleCore/Sources/MapleCore/SidecarPath.swift` and `xmpSidecarPath()` in `src/api/src/fs/xmp.ts` (whose video-extension list mirrors `VIDEO_EXTS` in `src/api/src/indexer/media-types.ts`).

Writes are atomic — temp file then rename — so a partial write is never visible. On Apple, `XMPSidecarStore` (`src/apple/Packages/MapleCore/Sources/MapleCore/XMPSidecarStore.swift`) debounces saves by 750 ms and offers a `flush()` for close; on the server, `writeSidecarAtomic` in `src/api/src/fs/sidecar-io.ts` does the rename.

## The four implementations

| Language   | Reads | Writes        | Entry points                                                                                                                                                                              |
| ---------- | ----- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust       | yes   | fragment only | `src/raw-pipeline/raw-core/src/xmp/mod.rs` (`parse`), `fields.rs` (the attribute→field match), `tone_curves.rs`, `local_adjustments/`, `black_white.rs`                                   |
| Swift      | yes   | yes           | `src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization.swift` plus its `+Attrs`, `+Canonical`, `+Helpers`, `+ParseAttrs`, `+ToneCurves`, `+Metadata`, `+Passthrough` extensions |
| TypeScript | yes   | yes           | `src/web/projects/maple-common/src/lib/xmp/xmp-parser.service.ts`, `xmp-serializer.service.ts`, `xmp-canonical.ts`, `xmp-fields.ts`                                                       |
| C#         | yes   | yes           | `src/windows/Maple.WinUI/Services/Xmp/XmpParser.cs`, `XmpWriter.cs`, `XmpSidecarDocument.cs`                                                                                              |

Rust is the render-side reader: `raw_core::xmp::parse` is what `maple-cli`, `raw-wasm` and `raw-ffi` call to turn a sidecar into an `AdjustmentModel` before developing pixels. Its `xmp::serialize` emits only an attribute _fragment_ (the Maple-proprietary `papp:` keys plus the parametric, black-and-white, lens and crop groups) and is exercised only by its own tests — full document writing belongs to the three shells.

The Bun API is a fifth, narrower participant: `src/api/src/xmp/metadata-serializer.ts` merges IPTC/EXIF metadata and culling fields into an existing sidecar by targeted attribute substitution rather than rebuilding the document, so it never has to model the develop schema. It is deliberately not byte-canonical.

## Document shape

The envelope is fixed. Line endings are LF; the `<?xpacket begin=…?>` value is a literal U+FEFF byte-order mark.

```xml
<?xpacket begin="<U+FEFF>" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/photo/1.0/"
      xmp:Rating="4"
      crs:Exposure2012="0.5"
      papp:Brightness="6">
      <dc:subject>…</dc:subject>
      <papp:SceneLinearToneCurve>…</papp:SceneLinearToneCurve>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
```

No `x:xmptk` toolkit string is emitted — it identifies the writing platform and would make Apple and Web output differ by construction.

When there are no children, `rdf:Description` self-closes with `/>` on the last attribute line; otherwise the attribute block ends with `>` and the element closes at four spaces.

### Indentation

One ladder, two spaces per level. `rdf:RDF` sits at two spaces, `rdf:Description` at four, and **everything inside `rdf:Description` — namespace declarations, attributes, and child elements alike — sits at six**, stepping two further per nested level (`<rdf:Bag>` at eight, `<rdf:li>` at ten). The constant is `DESCRIPTION_CHILD_INDENT` in `xmp-canonical.ts` and `XMPCanonical.childIndent` in `XMPSerialization+Canonical.swift`; C# spells it `ChildIndent` in `XmpWriter.cs`.

### Namespaces

Three declarations are emitted on every `rdf:Description`, in this exact order, whether or not the payload uses them — a fixed prelude keeps the head of every sidecar byte-stable:

| Prefix | URI                                            |
| ------ | ---------------------------------------------- |
| `xmp`  | `http://ns.adobe.com/xap/1.0/`                 |
| `crs`  | `http://ns.adobe.com/camera-raw-settings/1.0/` |
| `papp` | `http://ns.justmaple.app/photo/1.0/`           |

Conditional declarations follow in a fixed order when the payload needs them: `dc` (`http://purl.org/dc/elements/1.1/`), `exif` (`http://ns.adobe.com/exif/1.0/`), `photoshop` (`http://ns.adobe.com/photoshop/1.0/`), `Iptc4xmpCore` (`http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/`), `xmpRights` (`http://ns.adobe.com/xap/1.0/rights/`). Namespaces required by preserved foreign content come last, sorted by prefix. Re-declaring a prefix the envelope already owns with a _different_ URI is a hard error in the TypeScript writer rather than a silently broken document.

`crs:` is Adobe's Camera Raw schema — Maple uses Adobe's own key wherever Adobe has an equivalent control, so a Maple sidecar opens sensibly in Lightroom and vice versa. `papp:` is Maple's own namespace, used for controls Adobe has no equivalent for (capture sharpening, deep denoise, film looks) or where reusing Adobe's key would corrupt interop (`papp:Brightness` rather than `crs:Brightness`, which is Adobe's process-version-2010 control with different semantics and a default of +50).

**The `papp:` prefix, not the URI, is what parsers key on.** All four readers match qualified attribute names byte-wise (`papp:Profile`) rather than resolving namespace URIs, which is why the Apple writer could be moved onto the canonical URI without stranding a single sidecar already on disk. The older Apple URI `http://ns.justmaple.app/1.0/` is still accepted by the readers that resolve URIs at all (`PAPP_NAMESPACES` in `xmp-dom-utils.ts`, `PappNsLegacy` in `XmpSidecarDocument.cs`), along with an even older `maple:` binding at `https://maple.app/ns/1.0/`. Writers always emit the canonical URI.

### Attribute ordering on `rdf:Description`

Attributes sort by namespace priority first, then alphabetically by fully-qualified name inside each namespace:

`xmp` (0) → `crs` (1) → `papp` (2) → `dc` (3) → `exif` (4) → `photoshop` (5) → `Iptc4xmpCore` (6) → `xmpRights` (7) → everything else (500).

Unknown namespaces sort last, so an imported sidecar's foreign attributes stay out of the middle of Maple's own block. Names are ASCII XML NCNames, where JavaScript code-unit ordering, Swift's `<`, and C#'s `StringComparer.Ordinal` all agree. The three writers implement this identically in `sortCanonicalAttributes` (TS), `XMPCanonical.sorted` (Swift) and `SortedAttributeParts` (C#).

### Number formatting

One codec for every numeric attribute value and every tone-curve coordinate:

- integers emit bare — `0`, `6`, `-6`, `5200`, `255`;
- non-integers round to two decimals with trailing zeros trimmed — `0.5`, `0.12` (from `0.123`), `-14.5`, `1.4`;
- non-finite values are not representable and are never written.

The one documented exception is the crop group, which uses six decimals (`%.6f` / `toFixed(6)`) because crop edges are normalized fractions and two decimals would quantize the rect to whole percents of the frame.

Implementations: `numericSerializer` in `xmp-fields.ts`, `XMPSerializer.fmtNum` in `XMPSerialization+Helpers.swift`, `XmpSchema.FormatNumber` in `XmpSidecarDocument.cs`, `fmt_coord` in `raw-core/src/xmp/tone_curves.rs`.

Escaping is minimal and differs by position: attribute values escape `&`, `<`, `>`, `"`; element text escapes only `&`, `<`, `>`.

### Always-emitted attributes

Three bookkeeping attributes are written unconditionally by all three shells. They tell Lightroom the sidecar carries develop settings at all:

```
crs:Version="11.0"  crs:ProcessVersion="11.0"  crs:HasSettings="True"
```

An imported sidecar's own `crs:Version` / `crs:ProcessVersion` strings are retained rather than overwritten on the Windows side (`XmpSidecarDocument`).

### Omit-on-default

Every other field is written **only when it differs from its canonical default**, so a sidecar for an untouched panel stays byte-identical to what a build without that slider produced. Two details matter:

- The comparison is between _serialized wire forms_, not raw floats. Gating on the raw value would emit `="0"` for a slider sitting at 0.004, churning otherwise-identical sidecars on every save.
- The write-omit sentinel is sourced from the generated model defaults, not hand-typed. Hand-typed sentinels had previously drifted from the real defaults for `crs:Sharpness` and `crs:SharpenRadius`, which silently dropped a user's "Sharpen Amount = 0" on save and restored 40 on the next load.

**Known divergence:** the Apple writer emits the core numeric block (`crs:Exposure2012` through `crs:ColorNoiseReduction`, plus `crs:WhiteBalance="Custom"` and the WB pair) unconditionally, where the Web and Windows writers omit them at default. The byte-parity golden therefore sets every unconditionally-emitted field to a non-default value, so both writers produce the same attribute set for it.

## The field table

The schema's single source of truth is `ADJUSTMENT_SCHEMA` in `src/raw-pipeline/raw-core/src/types/adjustment/schema/` (with the HSL and colour-grading blocks in sibling `hsl.rs` / `color_grade.rs`). `tools/codegen.sh` emits the Swift and TypeScript mirrors from it — `AdjustmentModel+Generated.swift`, `adjustment-model.generated.ts`, `adjustment-tables.generated.ts` — and the `codegen-drift` CI job re-generates them to prove the committed copies match. Ranges and defaults below are read from that table; see [pipeline](pipeline.md) for what each control actually does to pixels.

| XMP key                                   | Model field                          | Range                             | Default               |
| ----------------------------------------- | ------------------------------------ | --------------------------------- | --------------------- |
| `crs:WhiteBalance`                        | `whiteBalancePreset`                 | preset name                       | `As Shot`             |
| `crs:Temperature`                         | `temperature`                        | 2000 – 12000 K                    | 6500                  |
| `crs:Tint`                                | `tint`                               | −150 – 150                        | 0                     |
| `papp:WbScaleVersion`                     | `wbScaleVersion`                     | `1`–`5`                           | 5                     |
| `papp:WbMethod`                           | `wbMethod`                           | `Cat16` \| `DiagonalRec2020`      | `Cat16`               |
| `crs:Exposure2012`                        | `exposure`                           | −4 – 4 EV                         | 0                     |
| `papp:Brightness`                         | `brightness`                         | −100 – 100                        | 0                     |
| `crs:Contrast2012`                        | `contrast`                           | −100 – 100                        | 0                     |
| `crs:Highlights2012`                      | `highlights`                         | −100 – 100                        | 0                     |
| `crs:Shadows2012`                         | `shadows`                            | −100 – 100                        | 0                     |
| `crs:Whites2012`                          | `whites`                             | −100 – 100                        | 0                     |
| `crs:Blacks2012`                          | `blacks`                             | −100 – 100                        | 0                     |
| `crs:ParametricHighlights`                | `parametricHighlights`               | −100 – 100                        | 0                     |
| `crs:ParametricLights`                    | `parametricLights`                   | −100 – 100                        | 0                     |
| `crs:ParametricDarks`                     | `parametricDarks`                    | −100 – 100                        | 0                     |
| `crs:ParametricShadows`                   | `parametricShadows`                  | −100 – 100                        | 0                     |
| `papp:AutoExposure`                       | `autoExposure`                       | `On` \| `Off`                     | `On`                  |
| `papp:ToneCurveMode`                      | `toneCurveMode`                      | `PerChannel` \| `RatioPreserving` | `PerChannel`          |
| `crs:Vibrance`                            | `vibrance`                           | −100 – 100                        | 0                     |
| `crs:Saturation`                          | `saturation`                         | −100 – 100                        | 0                     |
| `crs:Clarity2012`                         | `clarity`                            | −100 – 100                        | 0                     |
| `crs:Texture`                             | `texture`                            | −100 – 100                        | 0                     |
| `crs:Dehaze`                              | `dehaze`                             | −100 – 100                        | 0                     |
| `crs:Sharpness`                           | `sharpenAmount`                      | 0 – 150                           | 40                    |
| `crs:SharpenRadius`                       | `sharpenRadius`                      | 0.5 – 3                           | 1                     |
| `crs:SharpenDetail`                       | `sharpenDetail`                      | 0 – 100                           | 25                    |
| `crs:SharpenEdgeMasking`                  | `sharpenMasking`                     | 0 – 100                           | 0                     |
| `papp:CaptureSharpeningAmount`            | `captureSharpeningAmount`            | 0 – 100                           | 0                     |
| `papp:CaptureSharpeningSigma`             | `captureSharpeningSigma`             | 0.5 – 2                           | 1                     |
| `papp:CaptureSharpeningRadius`            | _(legacy read-only alias for sigma)_ | 0.5 – 2                           | 1                     |
| `crs:LuminanceSmoothing`                  | `nrLuminance`                        | 0 – 100                           | 0                     |
| `crs:ColorNoiseReduction`                 | `nrColor`                            | 0 – 100                           | 25                    |
| `papp:ChromaPrefilter`                    | `chromaPrefilter`                    | 0 – 100                           | 0                     |
| `papp:DeepDenoise`                        | `deepDenoise`                        | 0 – 100                           | 0                     |
| `papp:HotPixelSuppression`                | `hotPixelSuppression`                | `On` \| `Off`                     | `Off`                 |
| `papp:HighlightRecoveryMode`              | `highlightRecovery`                  | see enums below                   | `ChromaticAdaptation` |
| `crs:HueAdjustment{Band}` ×8              | `hueAdjustment*`                     | −100 – 100                        | 0                     |
| `crs:SaturationAdjustment{Band}` ×8       | `saturationAdjustment*`              | −100 – 100                        | 0                     |
| `crs:LuminanceAdjustment{Band}` ×8        | `luminanceAdjustment*`               | −100 – 100                        | 0                     |
| `crs:ConvertToGrayscale`                  | `blackWhite`                         | `True` \| `False`                 | `Off`                 |
| `crs:GrayMixer{Band}` ×8                  | `grayMixer*`                         | −100 – 100                        | 0                     |
| `crs:SplitToningShadowHue`                | `splitToneShadowHue`                 | 0 – 360°                          | 0                     |
| `crs:SplitToningShadowSaturation`         | `splitToneShadowSaturation`          | 0 – 100                           | 0                     |
| `crs:SplitToningHighlightHue`             | `splitToneHighlightHue`              | 0 – 360°                          | 0                     |
| `crs:SplitToningHighlightSaturation`      | `splitToneHighlightSaturation`       | 0 – 100                           | 0                     |
| `crs:SplitToningBalance`                  | `splitToneBalance`                   | −100 – 100                        | 0                     |
| `crs:ColorGradeShadowLum`                 | `colorGradeShadowLuminance`          | −100 – 100                        | 0                     |
| `crs:ColorGradeMidtoneHue`                | `colorGradeMidtoneHue`               | 0 – 360°                          | 0                     |
| `crs:ColorGradeMidtoneSat`                | `colorGradeMidtoneSaturation`        | 0 – 100                           | 0                     |
| `crs:ColorGradeMidtoneLum`                | `colorGradeMidtoneLuminance`         | −100 – 100                        | 0                     |
| `crs:ColorGradeHighlightLum`              | `colorGradeHighlightLuminance`       | −100 – 100                        | 0                     |
| `crs:ColorGradeGlobalHue`                 | `colorGradeGlobalHue`                | 0 – 360°                          | 0                     |
| `crs:ColorGradeGlobalSat`                 | `colorGradeGlobalSaturation`         | 0 – 100                           | 0                     |
| `crs:ColorGradeGlobalLum`                 | `colorGradeGlobalLuminance`          | −100 – 100                        | 0                     |
| `crs:PostCropVignetteAmount`              | `vignetteAmount`                     | −100 – 100                        | 0                     |
| `crs:PostCropVignetteFeather`             | `vignetteFeather`                    | 0 – 100                           | 50                    |
| `crs:GrainAmount`                         | `grainAmount`                        | 0 – 100                           | 0                     |
| `crs:GrainSize`                           | `grainSize`                          | 0 – 100                           | 25                    |
| `crs:GrainFrequency`                      | `grainRoughness`                     | 0 – 100                           | 50                    |
| `papp:FilmLook`                           | `filmLook`                           | catalog id (free-form)            | `""`                  |
| `papp:FilmStrength`                       | `filmStrength`                       | 0 – 100                           | 100                   |
| `papp:Profile`                            | `profile`                            | `Auto` \| `Neutral`               | `Auto`                |
| `papp:Look`                               | `look`                               | `Default` \| `Neutral`            | `Default` (legacy)    |
| `crs:LensProfileEnable`                   | `lensProfileEnable`                  | `1` \| `0`                        | `On`                  |
| `crs:LensProfileDistortionScale`          | `lensCorrectionDistortion`           | 0 – 100                           | 100                   |
| `crs:LensProfileChromaticAberrationScale` | `lensCorrectionCa`                   | 0 – 100                           | 100                   |
| `crs:LensProfileVignettingScale`          | `lensCorrectionVignetting`           | 0 – 100                           | 100                   |

Band suffixes are `Red`, `Orange`, `Yellow`, `Green`, `Aqua`, `Blue`, `Purple`, `Magenta` for all four eight-band groups. Crop, culling, metadata, the point tone curves and local adjustments have their own sections below.

One `papp:` key is read by `raw-core` alone and is unmodelled everywhere else, so it survives a Swift/TypeScript/C# read-modify-write through passthrough rather than through the model: `papp:InpaintRemovals` (an array of baked-removal records — region, patch content hash, model id, bake grade; the patch pixels live out of band in `.maple/inpaint/`; `raw-core/src/types/inpaint.rs`). It uses a _tolerant_ reader: an element this build does not recognise is skipped so a sidecar from a newer build still opens, while a recognised shape with a corrupt field fails loudly. Local adjustments used to be the second member of this pair (`papp:LocalAdjustments`, a compact-JSON attribute); #358 moved it onto a canonical, nested-element wire form — see "Local adjustments" below.

## Enum fields and parse strictness

The wire spelling of every enum is the canonical variant name (`ChromaticAdaptation`, `RatioPreserving`, `DiagonalRec2020`), except `crs:ConvertToGrayscale` (Adobe's `True`/`False`) and `crs:LensProfileEnable` (Adobe's `1`/`0`).

| Field                        | Variants                                                                   |
| ---------------------------- | -------------------------------------------------------------------------- |
| `papp:HighlightRecoveryMode` | `Off`, `Blend`, `Luminance`, `ChromaticAdaptation`, `OklabChromaReduction` |
| `papp:Profile`               | `Auto`, `Neutral` (plus legacy `AcrMatch` → `Auto`)                        |
| `papp:Look`                  | `Neutral`, `Default` (retired; read-only migration into `Profile`)         |
| `papp:WbMethod`              | `Cat16`, `DiagonalRec2020`                                                 |
| `papp:AutoExposure`          | `On`, `Off`                                                                |
| `papp:HotPixelSuppression`   | `On`, `Off`                                                                |
| `papp:ToneCurveMode`         | `PerChannel`, `RatioPreserving`                                            |
| `crs:ConvertToGrayscale`     | `True`/`true`/`TRUE`/`1`, `False`/`false`/`FALSE`/`0`                      |
| `crs:LensProfileEnable`      | `1`/`true`/`True`/`on`/`On`, `0`/`false`/`False`/`off`/`Off`               |

**The four readers deliberately disagree on unknown values.** `raw-core` **rejects** an unrecognised enum value — the whole parse returns an error (`unknown HighlightRecoveryMode: …`, `unknown Profile: …`, `unknown WbScaleVersion: …`, `unknown ConvertToGrayscale: …`). It also rejects a non-numeric or non-finite value on any numeric key, rather than letting `NaN` propagate through a whole render before being zeroed pixel-by-pixel. The Swift, TypeScript and C# readers **drop** an unrecognised enum value and leave the field at its default, so a sidecar written by a newer build still loads in the UI. The practical consequence: an uplevel sidecar opens in the editor with the unknown control neutralized, but fails the render-side parse if the value ever reaches `raw-core`. Two exceptions are shared by all four: `papp:FilmLook` is free-form text and passes through verbatim (an id the catalog does not recognise resolves as identity at render time), and `papp:Profile="AcrMatch"` migrates to `Auto` rather than erroring.

Unknown _attribute names_, as opposed to unknown values, are never an error anywhere — they go to passthrough.

### Legacy aliases and precedence

Two keys have a canonical spelling that must win over a legacy one **regardless of document order**, because Swift's `XMLParser` and C#'s attribute dictionaries iterate unordered:

- `papp:CaptureSharpeningSigma` beats `papp:CaptureSharpeningRadius` (the PSF changed from a tripled box blur to a true Gaussian; the value is not rescaled).
- `papp:Profile` beats the `papp:Look` → `Profile` migration (`Default`/`Auto` → `Auto`, `Neutral` → `Neutral`).
- `papp:Flag` beats the legacy `xmp:Label` cull-flag spelling.

Each reader implements this with a per-element "seen" flag or a two-pass walk (`sigma_seen` / `profile_seen` in `fields.rs`, `captureSharpeningSigmaSeen` / `profileSeen` / `cullFlagSeen` in `XMPSerialization.swift`, the `legacyDeferred` second pass in `xmp-parser.service.ts`). The flags are scoped to a single element so a second `rdf:Description` is judged on its own attribute set. The legacy keys are read-only: no writer emits them.

## White balance

`crs:WhiteBalance` names a preset. Six names resolve to a temperature/tint pair on read — Daylight (5500/10), Cloudy (6500/10), Shade (7500/10), Tungsten (2850/0), Fluorescent (3800/21), Flash (5500/0). `As Shot`, `Auto` and `Custom` resolve to nothing and leave the model defaults, because an explicit `crs:Temperature`/`crs:Tint` pair (which always wins) is what actually carries the value.

`raw-core` tracks whether each component was _explicitly present_ (`temperature_seen` / `tint_seen`). An absent `crs:Temperature` means "as shot" — the develop chain substitutes the camera's own value — which is materially different from an explicit `6500`, which since camera-space white balance means "Custom WB dialed to D65". This is why the Web writer skips the pair entirely for an As-Shot model (emitting the display seed would demote a real as-shot render into a float-rounded explicit target), and why the Apple decode path has an internal `omitWhiteBalance` mode that persisted saves can never reach.

### WB slider-scale versioning

What a stored `crs:Temperature`/`crs:Tint` pair _means_ has changed five times, so the scale is stamped on the sidecar as `papp:WbScaleVersion`:

| Stamp | Meaning                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------ |
| `1`   | Pre-camera-space scale: post-DCP CAT16 adaptation relative to a 6500 K / 0 identity.                               |
| `2`   | Camera calibration-frame coordinates with the tint axis **inverted** relative to Adobe.                            |
| `3`   | Calibration-frame coordinates, Adobe's tint direction, at the legacy 1e-4 uv-per-unit magnitude.                   |
| `4`   | Adobe's direction and magnitude, but evaluated on the Hernández-Andrés daylight locus. Never shipped in a release. |
| `5`   | Robertson-native — the pair means exactly what Adobe Camera Raw's own displayed pair means. Current default.       |

Resolution rule, implemented identically in all four readers: an explicit stamp wins. Failing that, a document that carries the Maple `papp:` namespace **and** an explicit authored `crs:Temperature`/`crs:Tint` predates the versioning and is V1. Everything else — no `papp:` namespace at all (an Adobe-authored sidecar, already in Robertson coordinates) or no authored white balance (nothing to convert) — is V5.

V2, V3 and V4 pairs **load-normalize to V5**: the pair is converted _jointly_ through physical chromaticity (evaluate on the legacy locus at that version's axis and magnitude, then invert through Robertson), because the two loci differ — even a temperature-only authored value moves slightly in both components. The in-memory model and every subsequent save are then uniformly V5. V1 deliberately does **not** load-normalize: its conversion needs the image's calibration frame, so `raw-core` converts it at develop time and the sidecar round-trips as V1. Writers therefore stamp only `1` or `5`, and clamp to that set so a corrupted model field can never produce a stamp `raw-core` would hard-fail on.

Implementations: `authored_pair_to_v5` in raw-core's white-balance stage, `xmp-wb-scale.ts` (Web), `WbDngTemperature.authoredPairToV5` (Swift), `XmpWbScaleVersionTests.cs` pins the Windows half.

## Tone curves

Two independent mechanisms, both PV2012-shaped.

**Parametric region sliders** are four ordinary `crs:` attributes — `ParametricHighlights`, `ParametricLights`, `ParametricDarks`, `ParametricShadows`. Adobe's three split-point keys (`ParametricShadowSplit`/`MidtoneSplit`/`HighlightSplit`) map to `parametric_{shadow,midtone,highlight}_split` (#2320; Windows since #3223), `[0, 100]` with per-field defaults 25/50/75 — omitted at _that_ default rather than at 0. raw-core's curve builder and the GPU-live params (`MapleGpuLiveParams`, all hosts) consume them; the scalars-only CPU fallback params (`MapleAdjustmentParams`) carry no split-point fields yet, so Windows' CPU per-tick chain still renders with the 25/50/75 constants.

**Point curves** are the one part of the schema that is not a flat attribute, and there are two independent FAMILIES of them — both structurally modelled, both PV2012-shaped, applied at different points in the pipeline. Eight parent elements in canonical emit order, each wrapping an `rdf:Seq` of `rdf:li` leaves holding `"x, y"` text:

- Scene-linear (`#365`, `#273`): `papp:SceneLinearToneCurve` (luma), `…Red`, `…Green`, `…Blue`. Applied _pre-view-transform_, in scene-linear light, luma-coupled for the luma curve (hue-preserving).
- Display-referred (`#2232`): `crs:ToneCurvePV2012` (master), `…Red`, `…Green`, `…Blue`. Applied _post-AgX_, in display-linear `[0, 1]`, evaluated independently per R/G/B channel — matching Adobe Camera Raw's own point-curve behaviour, not luma-coupled.

```xml
      <papp:SceneLinearToneCurve>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>127.5, 140.25</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </papp:SceneLinearToneCurve>
      <crs:ToneCurvePV2012>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>128, 150</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </crs:ToneCurvePV2012>
```

Coordinates are stored on the model in `[0, 1]` and written in PV2012's `[0, 255]` wire domain (the SAME wire convention for both families), rescaled at the serializer boundary and passed through the same two-decimal number codec. (Windows is the exception: `AdjustmentState` stores curve points already in the wire domain, so its writer skips the rescale.) **Identity is silence** — an identity curve is the empty point list and emits no element at all, not an empty `rdf:Seq`, so an unedited sidecar keeps the bytes it had before point curves existed. A malformed `rdf:li` is dropped rather than failing the parse. Readers match `rdf:li` on its local name so a sidecar that binds RDF to a different prefix still parses.

The two families are different QUANTITIES, not different spellings of the same one: the `papp:` curves apply pre-view-transform in scene-linear light, while a `crs:ToneCurvePV2012` curve was authored against Lightroom's own display transform and only means anything after one. Before `#2232`, `crs:ToneCurvePV2012*` rode the unknown-node passthrough bucket, re-emitted verbatim but never rendered; `#2232` gives it a real pipeline slot (`stages::display_tone_curve`, post-AgX) and moves it off the passthrough pipe onto the `display_tone_curve_*` model fields — a Lightroom-authored curve now renders in Maple rather than surviving only as inert bytes. The two families can coexist on one image: a Lightroom import keeps its `crs:` curve until the user re-authors in Maple's own scene-linear editor.

## Local adjustments

Masked, per-region edits (linear "gradient" and radial "circular gradient" masks; #280/#358) are the one field the schema table above deliberately excludes — `local_adjustments` is a `Vec<LocalAdjustment>` with its own nested shape, not a flat attribute, and the schema-drift test in `types/adjustment/schema/tests.rs` allow-lists it for exactly that reason.

**Wire form is the canonical Adobe Camera Raw shape**, not a Maple-private one, so a Maple-authored sidecar opens with its masked edits intact in Lightroom/ACR and vice versa: `crs:GradientBasedCorrections` (linear) and `crs:CircularGradientBasedCorrections` (radial), each an `rdf:Seq` of `rdf:li` → `rdf:Description` "corrections" carrying the slider values, with one nested `crs:CorrectionMasks > rdf:Seq > rdf:li` holding the mask geometry:

```xml
<crs:GradientBasedCorrections>
  <rdf:Seq>
    <rdf:li>
      <rdf:Description
        crs:What="Correction"
        crs:CorrectionAmount="1"
        crs:CorrectionActive="True"
        crs:LocalExposure2012="0.5"
        crs:LocalContrast2012="10">
        <crs:CorrectionMasks>
          <rdf:Seq>
            <rdf:li
              crs:What="Mask/Gradient"
              crs:MaskValue="1"
              crs:ZeroX="0.2" crs:ZeroY="0.3"
              crs:FullX="0.8" crs:FullY="0.7"
              papp:LocalFeather="0.5"/>
          </rdf:Seq>
        </crs:CorrectionMasks>
      </rdf:Description>
    </rdf:li>
  </rdf:Seq>
</crs:GradientBasedCorrections>
```

`crs:What="Correction"` is Adobe bookkeeping, written unconditionally and ignored on read (same role as the top-level `crs:Version`/`crs:HasSettings` trio). `crs:CorrectionAmount` and `crs:CorrectionActive` are **not** ignored — Maple's own writer always emits `"1"` / `"True"`, but the reader honours both for third-party input: `CorrectionActive="False"` drops the whole correction (Lightroom's own "disabled pin" semantics — Maple has no present-but-inactive layer state to preserve it as), and `CorrectionAmount` (Adobe's 0–1 overall-strength dial) scales every wired slider by that amount at parse time, the same effect Adobe's own Amount slider has on its stored per-control deltas.

**Slider mapping.** Every `PartialAdjustments` field has a direct Adobe key (`crs:Local{Exposure,Contrast,Highlights,Shadows,Whites,Blacks}2012`, `crs:LocalSaturation`, `crs:Local{Temperature,Tint}`) except `vibrance`: Adobe's local-correction struct has no vibrance control, only saturation, so it rides Maple's own `papp:LocalVibrance` — the same "papp: for what Adobe has no equivalent for" rule the top-level schema follows. Only fields actually set (`Some`) are written; an absent key reads back as `None`, not zero.

**Mask geometry.** A linear mask's `start`/`end` map directly onto Adobe's `ZeroX/ZeroY` (0%-effect line) → `FullX/FullY` (100%-effect line); these four are **required** on a recognized mask — missing or non-numeric is a hard parse error rather than a silently invented `0`/`1` default, since that would place a plausible-looking mask in the wrong spot with no signal anything was wrong. Adobe's linear mask carries no separate feather magnitude — the Zero→Full distance _is_ its transition — so Maple's `feather` (independent of the endpoints) rides `papp:LocalFeather`; a foreign gradient without that attribute defaults to `0.5`. A radial mask maps onto Adobe's bounding-box form: `crs:Top/Left/Bottom/Right` (also required) = `center ± radii`, `crs:Angle` in degrees, `crs:Feather` 0–100, `crs:Flipped` = `invert`. Adobe's `crs:Roundness` (ellipse-vs-rounded-rect blend) and `crs:Midpoint` (where the falloff begins) have no Maple equivalent: the writer fixes them at `"0"` (pure ellipse) and `"50"` (Adobe's own default) and the reader ignores both — a foreign radial mask with non-zero roundness imports as the nearest ellipse. `crs:MaskValue="1"` and `crs:What` (`Mask/Gradient` or `Mask/CircularGradient`) are the other Adobe bookkeeping attributes on the mask `rdf:li`; a mask leaf is always written self-closing but a reader accepts either XML shape for it (`<rdf:li .../>` or the equivalent no-text `<rdf:li ...></rdf:li>` pair).

**Cross-type order.** Adobe's schema keeps linear and radial corrections in two separate top-level arrays, so a document with layers interleaved in the model (linear, radial, linear, …) round-trips through the wire form as two contiguous runs — all `GradientBasedCorrections` layers, then all `CircularGradientBasedCorrections` — rather than preserving the original interleaving. No UI writes this format yet, so nothing observes the reordering today.

**Tolerant reader**, matching the JSON-era contract this format replaces: a `crs:CorrectionMasks` entry whose `crs:What` isn't `Mask/Gradient` or `Mask/CircularGradient` (a brush, range, or AI mask — none of which Maple models) drops that one correction rather than failing the whole subtree or the parse. A _recognized_ mask's required geometry, or a correction's known numeric attributes, failing to parse as a finite number is a hard parse error, matching every other numeric key in the schema.

**Migration.** Slice 1 of #280 shipped a stop-gap wire format: a single `papp:LocalAdjustments` attribute holding compact JSON (`raw-core/src/types/local_adjustment/wire.rs`). #358 replaced the write side with the canonical nested form above; the JSON attribute is still _read_ — so a hand-authored pre-#358 fixture still loads — but no writer emits it anymore. If a document somehow carries both (a hand-edited fixture; never Maple's own output), **the canonical nested form wins**: `raw_core::xmp::parse` applies the legacy attribute first, wherever it appears in document order, then overwrites `model.local_adjustments` with whatever the canonical-form walker collected, provided that walker found at least one layer.

**Modeled only in Rust, today.** Like `papp:InpaintRemovals`, no UI exists yet on Apple or Web for local adjustments, so `XMPSerializer` (Swift) and `XmpSerializerService` (TypeScript) do not model `crs:GradientBasedCorrections`/`crs:CircularGradientBasedCorrections` as first-class fields — they carry the whole subtree through the generic unknown-child-element passthrough (§ "Passthrough", bucket 2) unchanged, the same mechanism that already preserves Lightroom's `crs:MaskGroupBasedCorrections`. `raw_core::xmp::parse` is the only reader that turns the elements into a model, because it's the only consumer that needs to (rendering the masked pixels). C# does not model it either, for the same reason.

Implementation: `raw-core/src/xmp/local_adjustments/` — `mod.rs` (`LocalAdjustmentsWalker`, the document-structure state machine), `parse.rs` (attribute-level parsing), `serialize.rs` (`serialize_local_adjustments`, the fragment emitter).

## Crop fields

The crop rect is normalized `[0, 1]` edges, origin top-left, with `crs:CropAngle` in degrees (positive = clockwise). The group is emitted only when non-identity, at six decimals:

```
crs:HasCrop="True" crs:CropTop="0.100000" crs:CropLeft="0.050000"
crs:CropBottom="0.900000" crs:CropRight="0.950000" crs:CropConstrainToWarp="0"
crs:CropAngle="2.500000"
```

Two rules govern reading. The four edges are **gated by `crs:HasCrop`** — when the marker is `False` or absent, any `crs:Crop*` edge values are ignored and the identity default stands; each reader does a two-pass walk over the element so attribute order is irrelevant. `crs:CropAngle` is **independent** of that gate, because a pure straighten with no rect trim is valid and emits the angle alone. `crs:HasCrop` and `crs:CropConstrainToWarp` are accepted and consumed but carry no model state.

## Culling fields

| Attribute         | Values                                               | Written when                                          |
| ----------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| `xmp:Rating`      | `1`–`5`                                              | rating > 0 (Adobe's absence-means-unrated convention) |
| `papp:Flag`       | `pick`, `reject`                                     | flagged                                               |
| `papp:ColorLabel` | `red`, `orange`, `yellow`, `green`, `blue`, `purple` | set                                                   |
| `papp:Hidden`     | `true`, `false`                                      | explicitly touched (tri-state; absent ≠ false)        |
| `dc:subject`      | nested `rdf:Bag` of `rdf:li` keywords                | any keyword present                                   |

The colour-label vocabulary is matched case-sensitively against that exact six-word list; an out-of-vocabulary value leaves the label unset rather than storing a string no other platform would accept. The web reader additionally maps Adobe's `xmp:Label` colour words (`Red`…`Purple`) onto colour labels, with `papp:ColorLabel` winning when both are present. Apple's reader does _not_ — the same attribute was historically overloaded there for the pick/reject flag (`Red` / `Rejected`), so reading Adobe colour words out of it would turn every legacy pick into a red label; it reads `xmp:Label` only as a legacy flag alias, and never writes it.

Keywords are deduplicated at parse time (first occurrence wins, source order preserved) and blank entries dropped, on every platform, because the UIs iterate the list by value identity.

`papp:IsScreenshot` is written and read only by the API's metadata route; the other implementations carry it through passthrough.

## Metadata block

The IPTC/EXIF batch-metadata fields ride the same document. Simple attributes: `exif:GPSLatitude`, `exif:GPSLongitude`, `exif:GPSAltitude`, `exif:GPSAltitudeRef`, `exif:DateTimeOriginal`, `papp:TimeZone`, `Iptc4xmpCore:Location`, `Iptc4xmpCore:CountryCode`, `photoshop:City`, `photoshop:State`, `photoshop:Country`, `photoshop:Headline`, `photoshop:Instructions`, `photoshop:AuthorsPosition`, `photoshop:Credit`, `photoshop:Source`, `xmpRights:Marked`. Nested lang-alt/seq elements: `dc:title`, `dc:creator`, `dc:description`, `dc:rights`, `xmpRights:UsageTerms`. GPS uses the standard XMP rational encoding (`deg,min.mmmmH`); altitude is `thousandths/1000` with a `0`/`1` sign reference.

Child elements sit in fixed slots so the order is stable: title/creator/description, then `dc:subject`, then rights/usage terms, then the point tone curves, then preserved unknown nodes last.

## Passthrough

**A Maple writer must not destroy anything it does not understand.** A Lightroom sidecar carries mask groups, history, snapshots and `xmpMM:` document IDs; all of it has to survive a Maple save. (`crs:ToneCurvePV2012*` used to be a passthrough example too — since `#2232` it round-trips structurally instead, onto `display_tone_curve_*`, the same way the `papp:` point curves already did per `#365`.)

Three buckets, each with its own rule:

1. **Unknown attributes on `rdf:Description`** are captured as decoded `(name, value)` pairs and re-emitted through the canonical attribute sort, where the unknown-namespace rank (500) places them after every known attribute. Values are re-escaped on write. Source order is not preserved — it is unrecoverable from an unordered attribute dictionary and moot anyway, since every attribute is re-sorted.
2. **Unknown child elements of `rdf:Description`** are preserved as **verbatim source text** in **original document order**. Order is load-bearing: mask groups, history entries and snapshots are ordered stacks. Only the first line of each node is re-indented onto the canonical ladder; the interior keeps the whitespace its author wrote, which is what makes the region byte-identical across a read-modify-write. The Apple reader uses a source-slicing scanner (`XMPPassthroughScanner.swift`) rather than re-serializing parse events, precisely so a foreign subtree's attribute order is not reshuffled.
3. **Siblings of `rdf:Description` inside `rdf:RDF`, and siblings of `rdf:RDF` inside `x:xmpmeta`**, preserved verbatim and re-indented at their own levels.

Namespace declarations needed by preserved content ride along: a `<xmpMM:History>` subtree re-emitted without its `xmlns:xmpMM` would produce a document a namespace-aware reader rejects. Declarations for prefixes the canonical envelope emits itself are dropped instead, so the output can never carry a duplicate `xmlns:` on one start tag; a default (`xmlns=`) declaration is likewise dropped, since it would change how every unprefixed name in the document resolves.

The "known" set each implementation subtracts is hand-maintained (`XMPKnownFields` in `XMPPassthrough.swift`, `KNOWN_ATTRIBUTES` in `xmp-passthrough.ts`, `ConsumedAttributes` in `XmpParser.cs`) and must include read-only legacy aliases — a name missing from it would be emitted twice, once from the model and once from the passthrough pipe. Apple's suite asserts the serializer's own output is a subset of its known set for exactly this reason.

A document that will not parse yields an empty passthrough bucket: malformed bytes are not trustworthy to carry forward, and the caller is about to replace the file either way.

## Schema versioning

Four independent version numbers appear in or around a sidecar, and they mean different things:

- **`crs:Version` / `crs:ProcessVersion` (`"11.0"`)** — Adobe process-version signalling, written unconditionally, retained from an import.
- **`papp:WbScaleVersion` (`1`–`5`)** — the only _semantics_ version in the schema; see above. An unknown value is a hard parse error in `raw-core`.
- **`PIPELINE_OUTPUT_VERSION`** (`raw_core::version`, mirrored into `adjustment-model.generated.ts`) — not written to the sidecar. It is folded into every rendered-output cache key so a change that alters pixels for the same (RAW, sidecar) input invalidates stale entries on all platforms. See [caching](caching.md).
- **`"schema": 2`** inside the `papp:InpaintRemovals` JSON payload — versioning local to that payload.

New fields are added by extending `ADJUSTMENT_SCHEMA`, regenerating with `tools/codegen.sh`, and mirroring the key in all writers; because absent attributes read back as the canonical default and defaults are omitted on write, a new field costs nothing in existing sidecars. Removing a field is the harder direction — the reader arm has to stay (as `papp:Look`'s does) or old sidecars stop round-tripping.

Presets are **not** stored in XMP. A preset is a named, schema-versioned _sparse_ adjustment model living in its own MongoDB collection (`src/api/src/routes/presets.ts`, `src/api/src/presets/preset-validation.ts`); applying one writes the resolved field values into the sidecar like any other slider move. Preset validation follows the same philosophy as passthrough: unknown fields from a newer schema version are accepted and preserved verbatim rather than rejected. Film looks likewise store only the catalog id in `papp:FilmLook` — the `.mlut` payloads ship with the app (`raw-core/src/film_catalog.rs`).

## Test contract

Six claims, tested per platform:

1. **The canonical envelope** — namespace URIs and order, no `x:xmptk`, attribute sort order, the six-space indent ladder.
2. **The number codec** — the table in "Number formatting", case by case.
3. **The cross-engine golden** — Swift and TypeScript each assert their own writer reproduces a byte-identical golden document, from an identical fixture model, duplicated verbatim in `XMPCanonicalFormatTests.swift` and `xmp-canonical.spec.ts`. A divergence on either side fails that side's suite; this is the zero-byte-diff check without a build that runs both languages in one process. Any change to the canonical format updates both copies **and this document** in the same commit.
4. **Write → parse → write is a fixed point** — a canonical sidecar re-saves to identical bytes.
5. **Field-level round trip** — every modeled field survives serialize → parse with its value intact.
6. **Passthrough preservation** — a real Lightroom sidecar (masks, history, snapshots, `xmpMM:` ids) survives a Maple edit with every unknown node byte-identical, and legacy-layout sidecars (old `papp:` URI, unsorted attributes, no `rdf:about`) still parse and upgrade on the next save. `crs:ToneCurvePV2012*` round-trips structurally (§ "Tone curves") rather than through this bucket, and renders.

What the byte-parity claim does **not** cover: whole-document equality for arbitrary round-tripped sidecars. Both writers preserve unknown content, but they capture it differently (a DOM re-serialization on the web, a source slice on Apple), so a document carrying foreign nested fields survives on both without the preserved bytes matching each other. It also excludes `papp:Hidden` (no web writer) and default-valued sliders (Apple emits its core block unconditionally, the web writer omits it).

Windows is held to a weaker but honest bar: `AdjustmentState` is a structural subset of the cross-platform model (no crop, no keywords, no metadata block, no white-balance preset), so its suite asserts a fixed point of _meaning_ — parse → serialize → re-parse yields an equal model — plus passthrough preservation, with attribute passthrough compared order-insensitively and node passthrough compared as an exact ordered sequence.

| Platform   | Test files                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rust       | `src/raw-pipeline/raw-core/src/xmp/tests.rs`, `tests_detail.rs`, `tests_effects.rs`, `tests_lens.rs`, `tests_local_adjustments.rs`, `tests_metadata.rs`, `tests_modes.rs`, `tests_payloads.rs`, `tests_profile.rs`, `tests_tone_curves.rs`, `tests_wb_scale.rs`; schema drift in `types/adjustment/schema/tests.rs`                                                                                                                        |
| Swift      | `XMPCanonicalFormatTests.swift`, `XMPPassthroughTests.swift`, `XMPSerializationTests.swift`, `ToneCurveXMPTests.swift`, `XMPCullFlagTests.swift`, `XMPMetadataTests.swift`, `XMPSerializationBlackWhiteTests.swift`, `XMPSerializationAutoExposureTests.swift`, `XMPSerializationStageKnobTests.swift`, `ColorGradingXMPTests.swift`, `FilmLookXMPTests.swift`, plus the adapter contract suite seeded from `SidecarContractSupport.swift` |
| TypeScript | `xmp-canonical.spec.ts`, `xmp-fields.spec.ts`, `point-tone-curve.spec.ts`, `parametric-tone-curve.spec.ts`, `enum-modes.spec.ts`, `wb-scale-version.spec.ts`, `wb-dng-temperature.spec.ts`, `wb-as-shot-gate.spec.ts`, `black-white.spec.ts`, `color-grading.spec.ts`, `film-look.spec.ts`, `lens-correction.spec.ts`, `s5-effects.spec.ts`, `keywords.spec.ts`, `xmp-metadata*.spec.ts`, `sidecar.store.spec.ts`                          |
| C#         | `XmpCanonicalEnvelopeTests.cs`, `XmpNumberFormatTests.cs`, `XmpRoundTripTests.cs`, `XmpPassthroughTests.cs`, `XmpParserLegacyLayoutTests.cs`, `XmpWbScaleVersionTests.cs`, `SidecarStoreRoundTripTests.cs`, `SidecarCorpusRoundTripTests.cs`                                                                                                                                                                                               |
| API        | `src/api/src/xmp/metadata-parser.test.ts`, `metadata-serializer.test.ts`, `color-label.test.ts`                                                                                                                                                                                                                                                                                                                                            |

`SidecarCorpusRoundTripTests.cs` is the only suite driven by a shared on-disk corpus — every `.xmp` under `test-fixtures/sidecars/` (golden Maple sidecars, Lightroom sidecars with masks and history, synthetic edge cases). That directory is gitignored, so the test skip-passes with a message when it is absent, mirroring the color harness's "no fixtures, skipping" convention.

```bash
# Rust
cd src/raw-pipeline && cargo test -p raw-core --lib

# Swift
cd src/apple/Packages/MapleCore && swift test

# Web (the XMP suite lives in the shared library project)
cd src/web && bun x ng test Maple-common

# Windows
dotnet test src/windows/Maple.WinUI.Tests/Maple.WinUI.Tests.csproj -c Release

# API
cd src/api && bun test

# Regenerate the Swift/TS mirrors after a schema change (CI job `codegen-drift`)
bash tools/codegen.sh
```

See [testing](testing.md) for the full gate list and [architecture](architecture.md) for where the sidecar sits in the system.
