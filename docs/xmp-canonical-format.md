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

The default codec for numeric attribute values and tone-curve coordinates:

- integers emit bare — `0`, `6`, `-6`, `5200`, `255`;
- non-integers round to two decimals with trailing zeros trimmed — `0.5`, `0.12` (from `0.123`), `-14.5`, `1.4`;
- non-finite values are not representable and are never written.

Normalized spatial coordinates need greater precision: the crop group uses six fixed decimals (`%.6f` / `toFixed(6)`), and linear/radial mask coordinates use six decimals with trailing zeros trimmed. Two decimals would quantize their geometry to whole percents of the frame. Local fraction-scaled sliders have their separate four-decimal codec described below.

Implementations: `numericSerializer` in `xmp-fields.ts`, `XMPSerializer.fmtNum` in `XMPSerialization+Helpers.swift`, `XmpSchema.FormatNumber` in `XmpSidecarDocument.cs`, `fmt_coord` in `raw-core/src/xmp/tone_curves.rs`.

Escaping is minimal and differs by position: attribute values escape `&`, `<`, `>`, `"`; element text escapes only `&`, `<`, `>`.

### Always-emitted attributes

Three bookkeeping attributes are written unconditionally by all three shells. They tell Lightroom the sidecar carries develop settings at all:

```
crs:Version="11.0"  crs:ProcessVersion="11.0"  crs:HasSettings="True"
```

An imported sidecar's own `crs:Version` / `crs:ProcessVersion` strings are retained rather than overwritten on the Windows side (`XmpSidecarDocument`).

All four writers also always emit `papp:Profile="Auto"` or `papp:Profile="Neutral"` (#2441). This records the render intent explicitly without changing the default: an older sidecar with no profile still reads as Auto, except that legacy `papp:Look="Neutral"` migrates to Neutral. Re-saving makes that interpretation explicit. No new profile token or schema version is needed; all four readers already accept both values.

### Omit-on-default

Every field other than the always-emitted attributes above is written **only when it differs from its canonical default**, so a sidecar for an untouched panel stays byte-identical to what a build without that slider produced. Two details matter:

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
| `papp:Demosaic`                           | `demosaic`                           | see enums below                   | `Auto`                |
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
| `papp:LensProfile`                        | `lensProfile`                        | LCP reference (free-form, #2435)  | `""`                  |
| `papp:FilmStrength`                       | `filmStrength`                       | 0 – 100                           | 100                   |
| `papp:Profile`                            | `profile`                            | `Auto` \| `Neutral`               | `Auto`                |
| `papp:Look`                               | `look`                               | `Default` \| `Neutral`            | `Default` (legacy)    |
| `crs:LensProfileEnable`                   | `lensProfileEnable`                  | `1` \| `0`                        | `On`                  |
| `crs:LensProfileDistortionScale`          | `lensCorrectionDistortion`           | 0 – 100                           | 100                   |
| `crs:LensProfileChromaticAberrationScale` | `lensCorrectionCa`                   | 0 – 100                           | 100                   |
| `crs:LensProfileVignettingScale`          | `lensCorrectionVignetting`           | 0 – 100                           | 100                   |
| `crs:PerspectiveVertical`                 | `perspectiveVertical`                | −100 – 100                        | 0                     |
| `crs:PerspectiveHorizontal`               | `perspectiveHorizontal`              | −100 – 100                        | 0                     |
| `crs:PerspectiveRotate`                   | `perspectiveRotate`                  | −10 – 10°                         | 0                     |
| `crs:PerspectiveScale`                    | `perspectiveScale`                   | 50 – 150 %                        | 100                   |
| `crs:PerspectiveAspect`                   | `perspectiveAspect`                  | −100 – 100                        | 0                     |
| `crs:PerspectiveX`                        | `perspectiveX`                       | −100 – 100                        | 0                     |
| `crs:PerspectiveY`                        | `perspectiveY`                       | −100 – 100                        | 0                     |
| `crs:AutoLateralCA`                       | `autoLateralCa`                      | `1` \| `0`                        | `Off`                 |
| `crs:DefringePurpleAmount`                | `defringePurpleAmount`               | 0 – 20                            | 0                     |
| `crs:DefringePurpleHueLo`                 | `defringePurpleHueLo`                | 0 – 100                           | 30                    |
| `crs:DefringePurpleHueHi`                 | `defringePurpleHueHi`                | 0 – 100                           | 70                    |
| `crs:DefringeGreenAmount`                 | `defringeGreenAmount`                | 0 – 20                            | 0                     |
| `crs:DefringeGreenHueLo`                  | `defringeGreenHueLo`                 | 0 – 100                           | 40                    |
| `crs:DefringeGreenHueHi`                  | `defringeGreenHueHi`                 | 0 – 100                           | 60                    |

`crs:Highlights2012` (`highlights`) follows Adobe direction (positive brightens). Flipped 2026-09 without migration; sidecars written by earlier Maple builds with a non-zero value render in the opposite direction from how they were authored. Shared grid thumbnails and 1280 px previews of assets already edited with a non-zero Highlights are not version-keyed and show the old direction until the asset's next edit (#3594).

The seven `crs:Perspective*` keys (#3410) are Adobe's own, read and written **unrescaled**: a Lightroom sidecar's `crs:PerspectiveVertical="-20"` loads as −20 and saves back as −20. What one unit buys geometrically is Maple's own decision — Adobe documents no mapping — and is pinned by the constants in `raw-core/src/stages/perspective/matrix.rs`; see [pipeline](pipeline.md) § Geometry tail. Swift groups the seven under one nested `Perspective` value type where the other three implementations keep them flat, purely to fit `AdjustmentModel.swift` inside the file budget — the wire form, the field names and the copy/paste group are identical everywhere.

Band suffixes are `Red`, `Orange`, `Yellow`, `Green`, `Aqua`, `Blue`, `Purple`, `Magenta` for all four eight-band groups. Crop, culling, metadata, the point tone curves and local adjustments have their own sections below.

One `papp:` key is read by `raw-core` alone and is unmodelled everywhere else, so it survives a Swift/TypeScript/C# read-modify-write through passthrough rather than through the model: `papp:InpaintRemovals` (an array of baked-removal records — region, patch content hash, model id, bake grade; the patch pixels live out of band in `.maple/inpaint/`; `raw-core/src/types/inpaint.rs`). It uses a _tolerant_ reader for unknown element kinds, while a recognized removal with corrupt fields or an unsupported explicit schema version fails loudly. The reader accepts legacy schema `2` (including records with no schema stamp) and accepted-edit schema `3`; other explicit versions fail. Schema 3 adds the immutable original and fixed decode-anchor digests, source dimensions, intent-mask digest, native patch/context windows, exact model/recipe digests and ordered preceding context dependencies. Every content identity is a lowercase `blake3:` digest. Both companions must pass checksum and native-geometry validation; selected intent pixels require opaque replacement coverage. Changing a context dependency marks the later edit for review while retaining its accepted pixels. Shared preparation preserves unknown element kinds when appending a record. Regions must be finite, non-empty and inside the normalized source frame. Bake-grade values must be finite, and patch/model identities must be non-empty. The shared encoder returns an error rather than writing invalid metadata. This reader/codec foundation is not an editor authoring flow; completion is tracked by #1472. Local adjustments used to be the second member of this pair (`papp:LocalAdjustments`, a compact-JSON attribute); #358 moved it onto a canonical, nested-element wire form — see "Local adjustments" below.

### Removal publication and confirmed saving

The local Apple and browser-folder persistence boundaries (#3940) publish and
verify companions before changing XMP. They recheck the original's digest and
the expected removal-stack text at the commit boundary. A missing or corrupt
prior companion, replaced original, or stale stack refuses the save. Publication
may leave unreferenced immutable blobs after cancellation or a failed commit;
those bytes must not be treated as a saved edit or deleted as cache entries.

Apple writers use a persistent advisory `.photo.xmp.lock` file, synchronize new
assets and the accepted sidecar, and publish through atomic filesystem operations.
Browser folder writes coordinate through Web Locks, close each companion before
committing XMP, and verify the reopened bytes. Ordinary local writes reread
passthrough XMP so an old in-memory snapshot cannot erase a newly accepted stack.
These locks coordinate cooperating writers: browser Web Locks cannot acquire
Apple's filesystem advisory lock, and the File System Access API exposes no
atomic compare-and-swap against another application. Cross-application conflict
handling, server/SMB publication, portable packages and editor integration remain
part of #3940 and #1472; these storage APIs do not enable authoring on their own.

## Enum fields and parse strictness

The wire spelling of every enum is the canonical variant name (`ChromaticAdaptation`, `RatioPreserving`, `DiagonalRec2020`), except `crs:ConvertToGrayscale` (Adobe's `True`/`False`) and the two ACR checkboxes `crs:LensProfileEnable` and `crs:AutoLateralCA` (Adobe's `1`/`0`).

| Field                        | Variants                                                                   |
| ---------------------------- | -------------------------------------------------------------------------- |
| `papp:HighlightRecoveryMode` | `Off`, `Blend`, `Luminance`, `ChromaticAdaptation`, `OklabChromaReduction` |
| `papp:Profile`               | `Auto`, `Neutral` (plus legacy `AcrMatch` → `Auto`)                        |
| `papp:Look`                  | `Neutral`, `Default` (retired; read-only migration into `Profile`)         |
| `papp:WbMethod`              | `Cat16`, `DiagonalRec2020`                                                 |
| `papp:AutoExposure`          | `On`, `Off`                                                                |
| `papp:HotPixelSuppression`   | `On`, `Off`                                                                |
| `papp:Demosaic`              | `Auto`, `Amaze`, `Rcd`, `DualAmaze`, `DualRcd`, `Lmmse`                    |
| `papp:ToneCurveMode`         | `PerChannel`, `RatioPreserving`                                            |
| `crs:ConvertToGrayscale`     | `True`/`true`/`TRUE`/`1`, `False`/`false`/`FALSE`/`0`                      |
| `crs:LensProfileEnable`      | `1`/`true`/`True`/`on`/`On`, `0`/`false`/`False`/`off`/`Off`               |
| `crs:AutoLateralCA`          | `1`/`true`/`True`/`on`/`On`, `0`/`false`/`False`/`off`/`Off`               |

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

All three editors offer these nine choices (#3307; Windows since #2434's sub-issue). The six illuminant pairs are single-sourced in `raw-core/src/types/adjustment/white_balance_presets.rs` and generated for Swift/TypeScript, so a picker and a name-only imported sidecar resolve identically. They are Robertson slider coordinates evaluated through the camera's existing DCP/`SliderFrame` calibration, not fixed RGB gains. The table preserves the existing XMP interpretation; the ACR corpus contains Daylight, Cloudy, Shade, Tungsten and Flash renders across 18 fixtures. Fluorescent retains the existing 3800/+21 fallback; the corpus has no Fluorescent render and this mode does not claim a measured ACR match.

A named choice writes its explicit numerical pair with `papp:WbScaleVersion="5"` and `papp:WbSource="Preset"`. Custom preserves the current pair and its existing scale version; a manual numerical edit clears the named choice. As Shot restores the current asset's camera reading. These are single undoable actions. Absolute WB transfer keeps a preset's name and pair while clearing any old sample point and derivation version.

An imported foreign sidecar with an authored temperature or tint and a Custom (or absent) preset name is shown as Manual provenance. Maple-authored sidecars keep their existing source semantics, including legacy AsShot omission; an explicit `papp:WbSource` always wins. This inference changes the label, never the stored pair or its scale.

AUTO now writes its corrected #2247 estimate, `crs:WhiteBalance="Auto"`, `papp:WbSource="Auto"`, and `papp:WbAlgorithmVersion` from `auto_adjustments::AUTO_WB_ALGORITHM_VERSION`. Algorithm versions are scoped by `WbSource`: the point sampler has its own `white_balance_sample::WB_ALGORITHM_VERSION`. A stored pair is authoritative and is never silently re-estimated on open. Global AUTO changes exposure/tone/WB together and turns AE Off; the WB picker's Auto changes only WB and preserves tone/AE. Neither path commits a failed, cancelled, or stale recommendation.

Windows models the name and all four provenance attributes too (`XmpWhiteBalance.cs`, consumed on read rather than passthrough), so a sidecar sampled on Web or Apple no longer re-saves its stale `Sampled` label and sample point after a Windows edit of the pair. A Temp/Tint slider write there clears them to Manual/Custom; AUTO stamps `Auto` with the same `AUTO_WB_ALGORITHM_VERSION`, generated into `WhiteBalancePresets.g.cs` alongside the preset vocabulary and pairs. Windows' own eyedropper (`Services/WhiteBalanceSampler.cs`, through `maple_sample_white_balance_oriented`) writes `Sampled` with the point and the sampler's version, and its picker writes the six illuminant pairs as `Preset`, Custom as Manual and As Shot as AsShot — the same choices and provenance as the other two editors.

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

Complete V2, V3 and V4 pairs **load-normalize to V5**: the pair converts jointly through physical chromaticity (evaluate on the legacy locus, then invert through Robertson). V1 retains its established post-DCP meaning and resolves through the image's actual calibration metadata at develop time.

Apple and Web preserve a partial imported pair independently from its numerical display values (#3434). Missing Temperature or Tint is distinct from an explicit `6500` or `0`. Current-scale calibrated imports fill the absent axis from the actual decoded camera frame; V2–V4 imports fill it before joint conversion. V1 and uncalibrated/SDR imports retain the core's established resolver behavior. Apple resolves the cold imported live pair through Rust once, including V1; Web's full-XMP WASM render preserves the original presence and scale; the GPU binding resolves that model through a camera calibration cached at session open and applies the same frame delta as Apple. This adds no XMP field or new color math.

Unrelated saves emit only the originally present axis with its original scale (including V2–V4). Actual WB authors replace that intent with their authoritative values; an explicit complete Custom pair writes both axes even at their defaults. Undo snapshots restore the original intent. Ordinary complete-pair writers stamp `1` or `5`; partial imports retain their valid original `1`–`5` stamp.

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

Coordinates are stored on the model in `[0, 1]` and written in PV2012's `[0, 255]` wire domain (the SAME wire convention for both families), rescaled at the serializer boundary and passed through the same two-decimal number codec. **Identity is silence** — an identity curve is the empty point list and emits no element at all, not an empty `rdf:Seq`, so an unedited sidecar keeps the bytes it had before point curves existed. A malformed `rdf:li` is dropped rather than failing the parse. Readers match `rdf:li` on its local name so a sidecar that binds RDF to a different prefix still parses.

The two families are different QUANTITIES, not different spellings of the same one: the `papp:` curves apply pre-view-transform in scene-linear light, while a `crs:ToneCurvePV2012` curve was authored against Lightroom's own display transform and only means anything after one. Before `#2232`, `crs:ToneCurvePV2012*` rode the unknown-node passthrough bucket, re-emitted verbatim but never rendered; `#2232` gives it a real pipeline slot (`stages::display_tone_curve`, post-AgX) and moves it off the passthrough pipe onto the `display_tone_curve_*` model fields — a Lightroom-authored curve now renders in Maple rather than surviving only as inert bytes. The two families can coexist on one image: a Lightroom import keeps its `crs:` curve until the user re-authors in Maple's own scene-linear editor.

## Local adjustments

Masked, per-region edits (linear "gradient" masks, radial "circular gradient" masks, and — #3271 — host-supplied bitmap masks and the whole-image "Everywhere" fallback) are the one field the schema table above deliberately excludes — `local_adjustments` is a `Vec<LocalAdjustment>` with its own nested shape, not a flat attribute, and the schema-drift test in `types/adjustment/schema/tests.rs` allow-lists it for exactly that reason. `mask_rasters` (the bitmap masks' pixel data, resolved from the host's raster registry — see below) sits beside it on the same allow-list for the same reason: structured, non-scalar data, never copied by paste.

**Wire form uses the Adobe Camera Raw correction structure** for geometry and ordered masks. This establishes structural interchange; the independent ACR pixel reference required by #1478 remains separate: `crs:GradientBasedCorrections` (linear) and `crs:CircularGradientBasedCorrections` (radial), each an `rdf:Seq` of `rdf:li` → `rdf:Description` "corrections" carrying the slider values, with one nested `crs:CorrectionMasks > rdf:Seq > rdf:li` holding the mask geometry:

The normalized gradient endpoints (`ZeroX`, `ZeroY`, `FullX`, `FullY`) and radial bounds (`Top`, `Left`, `Bottom`, `Right`) round to six decimals, halfway away from zero, with trailing zeros and the trailing decimal point trimmed; rounded zero emits `0`. Thus `0.300698` survives a save, while `0.3` retains its existing spelling. This precision repair uses the existing fields and readers, with no schema-version change. Angle, feather, correction sliders and range refinement keep their existing codecs. Four-host regression fixtures cover fine endpoints and a narrow radial mask over repeated round trips (#3875).

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

**Slider mapping.** Every `PartialAdjustments` field has a direct Adobe key (`crs:Local{Exposure,Contrast,Highlights,Shadows,Whites,Blacks}2012`, `crs:LocalSaturation`, `crs:Local{Temperature,Tint}`) except `vibrance`: Adobe's local-correction struct has no vibrance control, only saturation, so it rides Maple's own `papp:LocalVibrance` — the same "papp: for what Adobe has no equivalent for" rule the top-level schema follows. `hue` maps to `crs:LocalHue` on Adobe's own ±1 scale (Maple's slider is ±100, so the writer divides by 100 and the reader multiplies back), written at **four** decimals rather than the canonical two on every platform so a fractional slider value survives the scale change (−42.5 → `-0.425`; two decimals would persist `-0.43` and read back −43 — the shared fixture's linear layer carries exactly that value to pin it, #3400); the exact Adobe scale is best-effort until a Lightroom-authored sidecar carrying a hue-adjusted local correction exists as a fixture to pin against. Only fields actually set (`Some`) are written; an absent key reads back as `None`, not zero.

**Spatial sliders (#3407).** The six spatial controls carry Adobe's own keys: `crs:LocalTexture`, `crs:LocalClarity2012`, `crs:LocalDehaze`, `crs:LocalSharpness`, `crs:LocalLuminanceNoise`, `crs:LocalDefringe`. All six use the ±1 FRACTION scale Lightroom writes — the `crs:LocalHue` convention, not the 1:1 convention the ten older keys use — so a Lightroom Clarity of +35 stores as `"0.35"`, and Maple's writer divides its ±100 slider by 100 through the same four-decimal formatter `crs:LocalHue` uses. Two decimals would quantise the ±100 slider to whole units. Maple emits them in that order, after `crs:LocalHue` and before the `papp:Range*` block. `crs:CorrectionAmount` scales them like every other stored delta, and omit-on-default applies: an unset control emits no key at all, so an unedited correction re-saves byte-identically. The shared cross-language fixture's radial layer carries all six at non-default values (18 / 35 / −22.5 / 66 / 40 / 75) so the four writers are pinned on the keys, the scale and the order together.

**Range refinement.** A correction may carry a colour-range refinement (#3270) that narrows its primary mask further — a per-pixel factor multiplied into the mask weight, evaluated on the pixel entering the local-adjustments stage so it tracks upstream exposure and white balance instead of chasing the layer's own edit. It has no Adobe schema to borrow (Adobe's own range masks are undocumented), so it is Maple-private by design: seven `papp:Range*` attributes on the SAME `rdf:Description` the sliders live on — `papp:RangeKind="Color"`, then `papp:RangeHue`, `papp:RangeHueWidth`, `papp:RangeChromaMin`, `papp:RangeLMin`, `papp:RangeLMax`, `papp:RangeFeather`. Absent entirely (no `papp:RangeKind`) means no refinement; a reader that doesn't understand these attributes still applies the correction through the primary mask alone, which is the graceful degradation. A `papp:RangeKind` value other than `"Color"` is treated the same as absent (forward-compat with a future range shape). Both UI hosts author these attributes from the mask panel's Colour range block (#362) — web and Apple; Windows models the fields but has no control for them. The eyedropper seeds `papp:RangeHue`, `papp:RangeChromaMin`, `papp:RangeLMin` and `papp:RangeLMax` from a clicked pixel and rounds them to the two decimals these writers emit (`raw_core::stages::mask_range_sample`), so what the panel holds after a pick is byte-for-byte what the sidecar says; `papp:RangeHueWidth` and `papp:RangeFeather` are only ever moved by their sliders.

Web and Windows model both `hue` and the Color range on linear/radial layers (#3335), so reading an Apple-authored correction, changing an unrelated global control, and saving preserves them. The shared two-layer canonical fixture includes hue (including explicit zero) and all six Color coordinates on both mask kinds. `CorrectionAmount` scales hue along with the other sliders; it never scales the range coordinates. Missing Color coordinates use raw-core's defaults (55°, 25°, 0.02, 0.15, 0.95, 0.3); a present corrupt coordinate neutralizes the range in these tolerant UI readers. Canonical writers emit every coordinate. These are existing wire fields, so this host-model repair introduces no schema or pipeline-output version change.

**Bitmap and Everywhere masks (#3271).** A host-supplied raster selection (a Vision person/skin mask today) and the "apply everywhere" fallback share a third container, `crs:MaskGroupBasedCorrections` — Lightroom 11+'s own shape for its AI masks (Select Subject, Select Sky, …), reused here rather than inventing a Maple-private one. Each mask leaf is `crs:What="Mask/Image"`; a Maple-authored one additionally carries `papp:MaskSource`, which is what makes it recognized:

```xml
<rdf:li
  crs:What="Mask/Image"
  crs:MaskSubType="1"
  crs:MaskValue="1"
  papp:MaskSource="PersonSkin"
  papp:MaskPerson="0"
  papp:MaskFacialSkin="True"
  papp:MaskBodySkin="True"
  papp:MaskModel="apple-vision-person-instance/1"
  papp:MaskDigest="a1b2c3d4e5f60718"/>
```

`papp:MaskSource="Everywhere"` needs no other attribute (weight 1 everywhere; the no-person-detected fallback). `papp:MaskSource="PersonSkin"` requires `papp:MaskDigest` — 16 lowercase hex chars identifying the raster in the host's process-wide registry — as a **hard parse error** if absent, the same "no silently-invented default" rule the geometric masks' required coordinates follow: an unregistered digest can never resolve to pixels, so a default there would render as permanently nothing with no signal anything was wrong. `papp:MaskPerson` (which detected person, `0`-indexed), `papp:MaskFacialSkin`, and `papp:MaskBodySkin` (which sub-regions the recipe includes) default to `0`/`True`/`True` when absent; `papp:MaskModel` (the segmentation model identifier) defaults to empty.

**The sidecar never carries raster pixels, only the recipe.** `raw_core::types::local_adjustment::Mask::Bitmap`'s `raster_id` — the in-process handle a render actually samples — is **not** written to XMP at all; it always parses to `0` (unresolved) and is resolved afterward against whichever raster the host has registered under `papp:MaskDigest`, by the host's own raster registry (`maple_mask_raster_register` / `_release`; see `docs/pipeline.md`'s FFI table). A digest with no matching registered raster resolves to weight 0 — never a silent fallback to a global correction — so a sidecar opened on a device that hasn't (yet) regenerated the mask renders its OTHER edits normally, with just the masked region inert until the raster is available again.

**Mask geometry.** A linear mask's `start`/`end` map directly onto Adobe's `ZeroX/ZeroY` (0%-effect line) → `FullX/FullY` (100%-effect line); these four are **required** on a recognized mask — missing or non-numeric is a hard parse error rather than a silently invented `0`/`1` default, since that would place a plausible-looking mask in the wrong spot with no signal anything was wrong. Adobe's linear mask carries no separate feather magnitude — the Zero→Full distance _is_ its transition — so Maple's `feather` (independent of the endpoints) rides `papp:LocalFeather`; a foreign gradient without that attribute defaults to `0.5`. A radial mask maps onto Adobe's bounding-box form: `crs:Top/Left/Bottom/Right` (also required) = `center ± radii`, `crs:Angle` in degrees, `crs:Feather` 0–100, `crs:Flipped` = `invert`. Adobe's `crs:Roundness` (ellipse-vs-rounded-rect blend) and `crs:Midpoint` (where the falloff begins) have no Maple equivalent: the writer fixes them at `"0"` (pure ellipse) and `"50"` (Adobe's own default) and the reader ignores both — a foreign radial mask with non-zero roundness in these older individual containers imports as the nearest ellipse. Group-container readers reject unsupported roundness or midpoint instead of approximating it. The feather/inversion mapping here is the version-1 convention; version-2 radial leaves use the mapping documented below. `crs:MaskValue="1"` and `crs:What` (`Mask/Gradient` or `Mask/CircularGradient`) are the other Adobe bookkeeping attributes on the mask `rdf:li`; a mask leaf is always written self-closing but a reader accepts either XML shape for it (`<rdf:li .../>` or the equivalent no-text `<rdf:li ...></rdf:li>` pair).

**Cross-type order.** Adobe's schema keeps each mask kind in its own top-level array, so a document with layers interleaved in the model (linear, bitmap, radial, …) round-trips through the wire form as up to three contiguous runs — all `GradientBasedCorrections` layers, then all `CircularGradientBasedCorrections`, then all `MaskGroupBasedCorrections` — rather than preserving the original interleaving. No UI writes this format yet, so nothing observes the reordering today.

**Indentation** follows the one document-wide ladder (§ "Indentation"): the container sits with the other children of `rdf:Description` at six spaces, and every nested level — `rdf:Seq`, `rdf:li`, the correction's `rdf:Description` and its attributes, `crs:CorrectionMasks`, its `rdf:Seq`, the mask leaf and its attributes — steps two further. In the whole-document writers the containers come after the point tone curves and before the passthrough nodes; the Windows writer additionally remembers where each container sat relative to passthrough content on read and puts it back there on write, exactly as it does for the tone-curve blocks (§ "Passthrough" / `ChildSlot` in `XmpSidecarDocument.cs`).

**Tolerant reader**, matching the JSON-era contract this format replaces: a `crs:CorrectionMasks` entry whose `crs:What` isn't one Maple recognizes (`Mask/Gradient`, `Mask/CircularGradient`, or `Mask/Image` WITH a recognized `papp:MaskSource`) drops that one correction rather than failing the whole subtree or the parse. That last clause matters for `Mask/Image` specifically: Lightroom's own AI masks carry that same `crs:What` with a `crs:MaskDigest` but no `papp:` recipe at all — Maple has no way to regenerate pixels it never computed, so those are tolerated exactly like a brush or range mask, dropped rather than erroring. The four readers then split the same way they do on unknown enum values (§ "Enum fields and parse strictness"): in `raw-core` a _recognized_ mask's required geometry (or, for `Mask/Image`, its required `papp:MaskDigest`), or a correction's known numeric attributes, failing to parse as a finite number is a hard parse error, matching every other numeric key in the schema; the Swift, TypeScript and C# readers instead **drop** a correction whose required geometry is missing or corrupt (never invent a `0`/`1` placement) and read a corrupt slider value on an otherwise valid correction as "not set", so the sidecar still opens in the editor with everything else intact.

**Migration.** Slice 1 of #280 shipped a stop-gap wire format: a single `papp:LocalAdjustments` attribute holding compact JSON (`raw-core/src/types/local_adjustment/wire.rs`). #358 replaced the write side with the canonical nested form above; the JSON attribute is still _read_ — so a hand-authored pre-#358 fixture still loads — but no writer emits it anymore. If a document somehow carries both (a hand-edited fixture; never Maple's own output), **the canonical nested form wins**: `raw_core::xmp::parse` applies the legacy attribute first, wherever it appears in document order, then overwrites `model.local_adjustments` with whatever the canonical-form walker collected, provided that walker found at least one layer.

**Modeled on all four platforms.** Unlike `papp:InpaintRemovals`, the two containers are first-class fields everywhere: each host carries a hand-written `LocalAdjustment` / `LocalMask` / `PartialAdjustments` mirror on its model (`local-adjustment.ts`, `LocalAdjustment.swift`, `Models/LocalAdjustment.cs` — hand-written because `local_adjustments` is deliberately outside `ADJUSTMENT_SCHEMA` codegen) and all four serializers emit the block above byte-for-byte from the same layers, pinned by one shared two-layer literal duplicated across `tests_local_adjustments.rs`, `LocalAdjustmentXMPTests.swift`, `local-adjustments.spec.ts` and `XmpLocalAdjustmentsTests.cs`. Both container names are therefore in every reader's managed-child set (`XMPKnownFields.managedChildElements`, `localAdjustmentContainerKind` in `xmp-passthrough.ts`, `XmpLocalAdjustments.ContainerTagFor` in `XmpParser.cs`) so they hydrate the model and never also ride the passthrough pipe. The consequence of modeling rather than passing through: a Lightroom correction inside these two containers is re-emitted from Maple's model, so its attributes Maple has no field for (`crs:LocalClarity2012`, `crs:MaskName`, `crs:CorrectionRangeMask`, …) do not survive a Maple save, while `crs:PaintBasedCorrections` (unmodeled everywhere) still passes through verbatim.

**Ordered groups (#3408).** A geometric composition uses `crs:MaskGroupBasedCorrections`, with every component inside the correction's `crs:CorrectionMasks > rdf:Seq`. Components are evaluated in order from weight zero: Add `w + (1 - w) * c`, Subtract `w * (1 - c)`, Intersect `w * c`. Component inversion replaces `c` with `1 - c` first; group inversion replaces the final weight with `1 - w`, then clamped per-layer opacity multiplies it. The correction's controls run once with that composed coverage and any range refinement. Empty groups, non-finite group opacity, and a group missing any bitmap raster contribute zero, including when inverted; an unresolved subtract component cannot widen the correction.

The committed Lightroom Classic 15.6 / Camera Raw 18.7 exports under `test-fixtures/local-adjustments/` establish the actual Adobe wire fields: Add is `MaskBlendMode=0`, `MaskValue=1`; Subtract is `MaskBlendMode=1`, `MaskValue=0`, `MaskInverted=false`; Intersect uses the same mode/value with `MaskInverted=true`. `MaskSubType` does not encode these geometric operations. Maple writes an explicit `papp:MaskCombine="Add|Subtract|Intersect"` so each operation retains independent inversion, plus `papp:MaskGroupVersion="1"`, `papp:MaskGroupOpacity` and `papp:MaskGroupInverted` on the correction. Unknown versions remain opaque on the hosts. Geometric group coordinates and opacity use round-trip numeric precision; the older linear/radial canonical literals remain unchanged.

Modern radial leaves (`crs:Version="2"`) use `Feather / 50` and the opposite `Flipped` sense from version 1 or version-absent leaves (`Feather / 100`). Group readers accept only the modeled ellipse (`Roundness=0`, `Midpoint=50`, defaults when absent). Unsupported shape parameters, inactive components, unknown blend operations and invalid boolean flags leave the whole correction unmodeled, preserving its source XML on the hosts. The exports prove serialization, not Adobe soft-edge pixel equivalence. Local slider calibration against Adobe, including the exposure unit mapping, remains part of #1478; these fixtures do not qualify it.

**The third container, per host (#3271, #3282, #3300, #3408).** Rust, Apple and Web support geometric groups and the existing bitmap/everywhere leaves. Windows models geometric groups; a group containing a bitmap, Everywhere or another unsupported leaf remains opaque in its entirety.

| Host    | Group model and wire                                      | Raster registry                 | Raster source                           |
| ------- | --------------------------------------------------------- | ------------------------------- | --------------------------------------- |
| Rust    | `Mask::Group`, `raw_core::xmp::local_adjustments`         | raw-ffi or raw-wasm registry    | supplied by the host                    |
| Apple   | `LocalMask.group`, `XMPSerialization+MaskGroups.swift`    | raw-ffi                         | Vision person/skin segmentation (#3284) |
| Web     | `LocalMask` `group`, `xmp-local-adjustments.ts`           | raw-wasm worker registry        | segmentation source remains #3300       |
| Windows | `MaskGroup`, `XmpMaskGroups.cs` / `XmpMaskGroupWriter.cs` | geometric groups need no raster | no bitmap source                        |

Web and Apple expose ordered component selection, add/subtract/intersect, inversion, feather and opacity; Apple additionally shows selected geometric handles and the group's composed coverage. Windows exposes geometric component authoring with the same operations and selected-component handles, reads and saves those groups, and passes their complete flat representation to Rust.

Host group templates keep opaque corrections beside modeled layers with stable host-only slot IDs, so deleting an earlier layer cannot move a surviving layer across a foreign pin. New layers append inside the existing sequence when it accepts entries. Unknown correction/component attributes and child nodes travel with their modeled owner through edits. Apple and Windows keep opaque correction source fragments byte-for-byte, adding inherited namespace bindings where needed; Web follows its existing DOM normalization contract, then subsequent saves are fixed points. The existing bitmap/everywhere canonical fixture is unchanged. Raw-core's fragment serializer has no source template and only emits modeled corrections. A Web bitmap remains inert until its raster is registered; when it is inside a group, the entire group remains inert until all required rasters resolve.

Implementation: `raw-core/src/xmp/local_adjustments/` — `mod.rs` (`LocalAdjustmentsWalker`, the document-structure state machine), `parse.rs` (attribute-level parsing), `serialize.rs` (`serialize_local_adjustments`, the fragment emitter); `xmp-local-adjustments.ts` (Web), `XMPSerialization+LocalAdjustments.swift` (Apple), `XmpLocalAdjustments.cs` (Windows).

## Repair spots

The clone / heal brush (#3409) stores an ordered list of circular spots in Adobe's own `crs:RetouchAreas` container, so a spot authored in Maple renders in Lightroom and a Lightroom-authored spot loads here. Each entry is an `rdf:li` → `rdf:Description` naming the spot type and the source point, with the destination disc carried by a nested `crs:Masks` circular leaf:

```xml
<crs:RetouchAreas>
  <rdf:Seq>
    <rdf:li>
      <rdf:Description
        crs:SpotType="heal"
        crs:SourceState="sourceSetExplicitly"
        crs:Method="circle"
        crs:SourceX="0.750000"
        crs:SourceY="0.500000"
        crs:Opacity="1.000000"
        crs:Feather="0.500000"
        crs:Seed="0">
        <crs:Masks>
          <rdf:Seq>
            <rdf:li
              crs:What="Mask/CircularGradient"
              crs:MaskValue="1"
              crs:X="0.250000"
              crs:Y="0.500000"
              crs:Radius="0.050000"
              crs:Flow="1"
              crs:CenterWeight="0"/>
          </rdf:Seq>
        </crs:Masks>
      </rdf:Description>
    </rdf:li>
  </rdf:Seq>
</crs:RetouchAreas>
```

**Coordinates and radius.** `crs:X`/`crs:Y` (destination) and `crs:SourceX`/`crs:SourceY` are normalized `[0, 1]` full-frame coordinates, origin top-left — the same convention masks use. `crs:Radius` is deliberately NOT: it is a fraction of the image **width**, applied to both axes, so the disc is a circle in pixels. A mask's "circular" radial shape is an ellipse on a non-square frame and that is fine for a gradient; a clone patch copied through an elliptical stencil would not be the shape the user drew.

**Number formatting.** Six decimals, like `crs:Crop*` and like Adobe's own retouch output — not the two-decimal precision the local-adjustment sliders use, which would quantize a spot centre to 1 % of the frame, coarser than the dust spots this tool exists for.

**Fixed attributes.** `crs:SourceState="sourceSetExplicitly"`, `crs:Method="circle"`, `crs:MaskValue="1"`, `crs:Flow="1"`, `crs:CenterWeight="0"` and `crs:Seed="0"` are written as constants: Maple always stores the source the user placed (never a re-derived one) and only models the circular brush, so emitting Adobe's own values keeps the document readable in Lightroom without claiming behaviour Maple does not have. On read they are accepted and ignored.

**Source as an offset.** Adobe also writes the source as a delta — `crs:OffsetX`/`crs:OffsetY` from the destination. Every reader accepts either spelling and resolves both to the same stored point; `crs:SourceX`/`crs:SourceY` win when both are present.

**Legacy form.** Older Lightroom versions wrote `crs:RetouchInfo`: an `rdf:Seq` of `centerX = …, centerY = …, radius = …, sourceState = …, sourceX = …, sourceY = …, spotType = …` strings. That form is READ so an old sidecar's spots survive an import, and never written. A document carrying both resolves to the struct container — the same precedence rule local adjustments apply to their own legacy attribute.

**Tolerant reader.** A correction whose `crs:SpotType` this build does not model, or whose mask leaf is not `Mask/CircularGradient` (a Lightroom brush stroke is `Mask/Paint`), is dropped: that loses one spot rather than failing the document. In `raw-core` a _recognized_ leaf carrying a malformed number is a hard parse error, matching the strictness rule the rest of the schema follows; the TypeScript and Swift readers drop that spot instead, matching their own posture everywhere else.

**Render meaning.** The list is a decode-product edit: `stages::retouch` applies it in scene-linear Rec.2020 after DCP colorimetry and before the chroma pre-filter, spots in list order, so a later spot may source from an earlier spot's result. Changing the list invalidates the decoded-image caches exactly as `papp:DeepDenoise` does (see `docs/caching.md`), and no per-tick chain re-runs it.

Windows models the container as immutable repair state while retaining the complete XML subtree (#3888). Editing a known circular spot updates its owned attributes and retains unknown spots, attributes and children; unrelated edits re-emit the retained subtree. Legacy entries are imported when no structured container exists, with their source XML retained for unmodeled data. The Heal/Clone canvas maps the stored decode-frame fractions through EXIF orientation and perspective; its parent visual supplies crop, straighten and zoom. Numeric point controls use oriented coordinates. `XmpRetouchTests.cs` and `RetouchAuthoringTests.cs` cover preservation, source-offset precedence, edit snapshots and the native decode boundary. `RetouchExportNativeTests.cs` compares shared canonical repairs, Windows-authored repairs and reopened repairs through the native TIFF export path.

Implementation: `raw-core/src/xmp/retouch/` — `mod.rs` (`RetouchWalker`), `parse.rs`, `serialize.rs` (`serialize_retouch_areas`); `xmp-retouch.ts` (Web), `XMPSerialization+Retouch.swift` (Apple).

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

An ordinary Web adjustment save preserves the source metadata XML, including language alternatives and multiple creators, through passthrough. Only an explicit metadata replacement removes the modeled metadata attributes and direct children from the source RDF descriptions before emitting the replacement; namespace aliases are resolved by URI, and same-named foreign fields survive. An explicitly empty replacement clears the modeled fields. An authoritative missing-sidecar response clears cached source XML so a later edit cannot restore remotely deleted metadata.

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

Presets are **not** stored in XMP. A preset is a named, schema-versioned _sparse_ adjustment model living in its own `presets` table (`src/api/src/routes/presets.ts`, `src/api/src/presets/preset-validation.ts`); applying one writes the resolved field values into the sidecar like any other slider move. Preset validation follows the same philosophy as passthrough: unknown fields from a newer schema version are accepted and preserved verbatim rather than rejected. Film looks likewise store only the catalog id in `papp:FilmLook` — the `.mlut` payloads ship with the app (`raw-core/src/film_catalog.rs`).

### Workflow storage and XMP bindings (#4035, #4036; workflow UI under #2437)

Selected-variant stores also provide confirmed semantic commit, immutable
snapshot and restore operations (#4045). Each requires the exact complete XMP
last observed by the caller, with explicit `null` for an absent primary. A stale
writer fails before publication. A successful response is the complete XML
actually written; reopening reconstructs its snapshots and bounded history.
Commit merges new adjustment XML with the currently stored authoring record.
Apple coordinates cooperating store instances with `NSFileCoordinator`, Hosted
Web uses Web Locks, and Self Hosted serializes writers by resolved sidecar path.
These coordination contracts do not promise compare-and-swap against unrelated
applications that write outside them. Editor transaction hooks and one-step
Undo remain under #2437.

Self Hosted file operations pair canonical UUID sibling sidecars with the original
for browse, relocate, trash, verified restore, duplicate quarantine, and purge
(#4044). Renaming changes only the primary stem; the variant UUID and XML bytes
stay intact. Video branches retain the full video filename (including a changed
extension). Orphan branches occupy a restore destination, preventing accidental
association with a different original. Foreign version suffixes and backups are
excluded. UUID branch pairing preserves the exact original stem case (#4050), so
a differently cased original cannot claim another asset's branch on a
case-sensitive filesystem. Apple asset-level variant relocation still follows
under #2437.

`raw-core::workflow` declares the versioned variant identity/name, named checkpoint,
and committed semantic history wire records. `tools/codegen.sh` generates the
Apple, Web and API records and bounds from that declaration. Each checkpoint
carries the complete adjustment XMP string, preserving foreign children and
partial white-balance intent instead of copying a second adjustment schema.

Rust validates the complete checkpoint XML and rejects recursive `papp:Workflow`
elements. The generated host parsers guard wire fields, versions, identities,
semantic actions and bounds; they do not replace the Rust checkpoint validator.
History retains at most 32 independent complete checkpoints, retiring oldest
entries earlier when needed to fit the byte bound. Named snapshots are never
silently removed; an oversized new checkpoint/snapshot fails without changing
the existing record. Renderer and cache events are not semantic actions.

The shared `from_xmp` / `embed_in_xmp` converter stores the record as a
`papp:Workflow` resource with named scalar fields and RDF sequences for snapshots
and history. Complete checkpoint XMP is escaped text, so the normal development
reader never mistakes checkpoint adjustments for the current photo. Replacement
preserves surrounding bytes; unsupported versions, unknown owned content,
duplicate records and recursive checkpoints fail before publication. The final
sidecar also has the 256 KiB bound, including XML escaping and the outer document.

Current adjustment readers treat the `papp:Workflow` subtree as opaque (#4043),
including its scoped namespace declaration. Adding authoring metadata to a foreign
unstamped ACR/Lightroom sidecar cannot mark its current WB as legacy Maple scale.
Existing Maple-authorship markers and explicit scale stamps outside that subtree
keep their previous behavior. Checkpoint/history attributes never affect current
development parameters.

Apple's actor and Web's per-asset write chain publish through their existing
atomic sidecar contracts. The API exposes authorized `PATCH /api/xmp/workflow`
and protects workflow records through ordinary primary-sidecar writes. Apple C,
browser WASM, and Bun/N-API call the same Rust converter; host wire parsers remain
additional boundary checks. These operations run at confirmed save, never during
slider rendering. Existing primary sidecar paths stay in use.

`raw-core::workflow::variant_filename` (#4039) maps an already resolved primary
basename to a sibling keyed by its canonical lowercase UUID. `primary` returns
the existing basename byte-for-byte; additional variants use
`<primary stem>.v<UUID>.xmp`. Thus `IMG_1234.xmp` and `IMG_1234.MOV.xmp` keep
independent siblings. Display names never enter filenames. Traversal, invalid
identities, nonportable characters and names exceeding 255 UTF-8 bytes fail;
no truncation or fallback to primary is allowed. Apple `SidecarPath.variantURL`
and the browser/Bun bindings call the same Rust operation.

`SidecarWorkflow::checkpoint_xmp` captures the full current document by removing
only the successfully validated owned Workflow resource. All other bytes remain
unchanged, including foreign metadata, masks and white-balance intent. A document
without that resource is returned byte-for-byte. Future, malformed or rebound
owned resources fail instead of being erased. The Apple, browser WASM and
Bun/N-API bindings share this operation. Native capabilities load separately,
so adding these functions does not invalidate earlier workflow operations in
an older native library.

Sibling storage (#4040) is reconstructed from committed XMP by Apple's
`WorkflowVariantStore`, Web's `WorkflowVariantStoreService`, and the authorized
server endpoints below. Creating a sibling requires a committed source sidecar;
cloning an edited sibling carries its complete current document. Saving one
identity preserves its authoring record through ordinary adjustment writes and
leaves other branches and the original untouched. Discovery reports missing
primary state explicitly. A missing named sibling, mismatched identity, future
schema, or lost write access fails without silently falling back to primary.

- `GET /api/xmp/variants?path=…` discovers the primary and UUID siblings.
- `GET /api/xmp/variant?path=…&variantId=…` reads one exact identity.
- `POST /api/xmp/variants?path=…&sourceVariantId=…` creates from the committed
  source using a generated workflow wire record; source defaults to `primary`.
- `PUT /api/xmp/variant?path=…&variantId=…` saves the selected complete XML.

Apple and server creation publish with create-only filesystem links, so an
existing UUID cannot be overwritten by a concurrent creator. Web coordinates
cooperating tabs with a UUID Web Lock and publishes using the existing writable
File System Access stream-close contract. This is not an OS-wide create-only
operation against other applications. Portable Web writes require a native
writable folder handle; copied-file fallback is read-only. These operations run
outside rendering, using the shared Rust filename and XML validators.

The shared semantic operations (#4042) accept generated `WorkflowHistoryEntry`
and `WorkflowSnapshot` records. Commit and snapshot creation require their
checkpoint to equal the current complete XMP after validated Workflow removal,
allowing only the exact self-closing Description expansion produced by the shared
embedding implementation (#4052); stale or forged input fails. Adjustment fields,
foreign bytes and surrounding whitespace are never normalized. Restore requires an exact checkpoint already stored
in the selected variant's snapshots or retained history and a corresponding
`snapshot-restore` or `history-restore` action. It keeps the current variant
identity and named snapshots while appending one committed restore entry.
Compaction checks both JSON and the final escaped sidecar bound, retiring only
oldest independent history entries. A newest state that cannot fit fails without
publication. Snapshot creation never silently removes other snapshots or history.
In a full Description envelope, insertion changes only the owned Workflow region,
so foreign bytes and existing surrounding whitespace survive restore exactly;
a self-closing Description expands to contain the Workflow resource. The stored
complete checkpoint itself is never rewritten.

The C-FFI, WASM and Bun/N-API implementations call these same pure Rust operations
at the save boundary. Native symbols load separately, preserving all existing
operations when an older installed binary lacks these new capabilities.
Native filesystem and PhotoKit editor transactions now persist one semantic checkpoint per
changed gesture, with explicit Undo/Redo entries (#4046). Preview ticks and no-op
transactions do not enter history. Complete captured checkpoints survive a failed
publication for retry; the shared core compacts the oldest retained entries and
keeps named snapshots. Ordinary and semantic local writes coordinate on the same
sidecar across store instances. PhotoKit uses the same writer at the canonical
App Support sidecar path used by backup companion upload (#4047); asset bytes and
raw-adjacent sidecars are not written.
Hosted Web filesystem editor gestures capture source folder, model and culling at
commit, with explicit Undo/Redo history (#4049). Ordinary primary saves and semantic
history publication share the selected-variant Web Lock and read current source XML
inside it. Failed captured actions remain queued for flush or subsequent preview
save; changing folders cannot redirect a previous gesture's sidecar. Named records
in a primary sidecar and unsupported Workflow records fail without publication.
Server primary ordinary and selected semantic saves share one canonical-path
sequencing barrier (#4051). Ordinary saves retain the latest persisted Workflow
record even if incoming XML carries an older copy. Successful selected-primary
write, commit, snapshot and restore operations publish the library sidecar state
and change feed; named-variant operations leave the primary index unchanged.
Self Hosted Web editor gestures capture their actual source path and authored
model/culling intent (#4053). Confirmed API commits share the ordinary save chain,
and caches ingest the published XML. Native API editors use the same confirmed
primary endpoint for filesystem and catalog references (#4056), retaining failed
captures and recognizing an accepted action after a lost acknowledgement.
Native filesystem, PhotoKit and API primary hydration reject unsupported Workflow
records or mismatched named identities before caching current adjustments (#4057).
Local ordinary saves and explicit primary workflow publication validate identity
again at the coordinated write boundary; a failed save keeps its pending intent
for retry after the sidecar is repaired. Legacy sidecars without Workflow markup
retain their existing read/write behavior. SMB native editor history still needs
connected-share qualification under #2437.

Web primary-branch snapshots/history controls use the same real filesystem/API
stores (#4060). Named snapshots, saved history, restore confirmation and retry
work in writable Hosted folders and Self Hosted libraries. A confirmed restore
enters the existing 32-action Undo ring with two complete checkpoint documents,
including foreign XML and culling/metadata. Undo/Redo publish those documents
through current-source CAS before moving the ring; a failed publication retains
the action and its retry identity. Checkpoints omit Workflow markup, so Undo never
recursively captures history. The adjustment-diff wire version remains unchanged;
complete XML is a local ring payload backed by the shared versioned Workflow schema.
Reopening the editor reloads portable history and snapshots; its local Undo ring
starts empty, as it does on every image binding. Copied single-file imports need
their writable source to use these controls. A first snapshot uses a null-XMP
precondition plus its captured initial checkpoint; the initial primary and snapshot
publish together, without a separate baseline write or invented history entry.
Concurrent first writers have one winner and stale commands cannot replace it.
Apple primary snapshot/history controls (#4062) read and publish through the actual
filesystem, PhotoKit App Support and authenticated API writers. The More menu
opens named snapshots, portable history, explicit restore confirmation, and Refresh.
Complete-XMP restores join each writer's ordinary-save queue, validate the primary
identity and current bytes, and change the model and bounded Undo ring only after
confirmed publication. Undo/Redo retain the action and immutable retry ID through
failed or lost acknowledgements; session navigation invalidates late UI publication.
Restored culling, metadata and foreign XML become the next ordinary write's base.
The shared converter's required expansion of a self-closing Description is ignored
when detecting an unchanged restore on Apple and Web; it does not create a false
history entry or Undo action. Checkpoint payloads retain their original XML.

Cache-aware named variant switching, deletion/recovery and connected SMB
qualification remain acceptance requirements under #2437.
`tools/qualification/workflow-roundtrip.sh` runs the committed XMP corpus through
Rust → generated Swift → generated Web/API TypeScript → Rust and checks identical
final serialization. It writes only its own temporary files.

## Test contract

Six claims, tested per platform:

1. **The canonical envelope** — namespace URIs and order, no `x:xmptk`, attribute sort order, the six-space indent ladder.
2. **The number codec** — the table in "Number formatting", case by case.
3. **The cross-engine golden** — Swift and TypeScript each assert their own writer reproduces a byte-identical golden document, from an identical fixture model, duplicated verbatim in `XMPCanonicalFormatTests.swift` and `xmp-canonical.spec.ts`. A divergence on either side fails that side's suite; this is the zero-byte-diff check without a build that runs both languages in one process. Any change to the canonical format updates both copies **and this document** in the same commit.
4. **Write → parse → write is a fixed point** — a canonical sidecar re-saves to identical bytes.
5. **Field-level round trip** — every modeled field survives serialize → parse with its value intact.
6. **Passthrough preservation** — a real Lightroom sidecar (masks, history, snapshots, `xmpMM:` ids) survives a Maple edit with every unknown node byte-identical, and legacy-layout sidecars (old `papp:` URI, unsorted attributes, no `rdf:about`) still parse and upgrade on the next save. `crs:ToneCurvePV2012*` round-trips structurally (§ "Tone curves") rather than through this bucket, and renders.

What the byte-parity claim does **not** cover: whole-document equality for arbitrary round-tripped sidecars. Both writers preserve unknown content, but they capture it differently (a DOM re-serialization on the web, a source slice on Apple), so a document carrying foreign nested fields survives on both without the preserved bytes matching each other. It also excludes `papp:Hidden` (no web writer) and default-valued sliders (Apple emits its core block unconditionally, the web writer omits it).

Windows is held to a weaker but honest bar: `AdjustmentState` is a structural subset of the cross-platform model (no keywords, no metadata block), so its suite asserts a fixed point of _meaning_ — parse → serialize → re-parse yields an equal model — plus passthrough preservation, with attribute passthrough compared order-insensitively and node passthrough compared as an exact ordered sequence.

| Platform   | Test files                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust       | `src/raw-pipeline/raw-core/src/xmp/tests.rs`, `tests_detail.rs`, `tests_effects.rs`, `tests_lens.rs`, `tests_local_adjustments.rs`, `tests_metadata.rs`, `tests_modes.rs`, `tests_payloads.rs`, `tests_profile.rs`, `tests_tone_curves.rs`, `tests_wb_scale.rs`; schema drift in `types/adjustment/schema/tests.rs`                                                                                                                                                         |
| Swift      | `XMPCanonicalFormatTests.swift`, `XMPPassthroughTests.swift`, `XMPSerializationTests.swift`, `ToneCurveXMPTests.swift`, `LocalAdjustmentXMPTests.swift`, `XMPCullFlagTests.swift`, `XMPMetadataTests.swift`, `XMPSerializationBlackWhiteTests.swift`, `XMPSerializationAutoExposureTests.swift`, `XMPSerializationStageKnobTests.swift`, `ColorGradingXMPTests.swift`, `FilmLookXMPTests.swift`, plus the adapter contract suite seeded from `SidecarContractSupport.swift` |
| TypeScript | `xmp-canonical.spec.ts`, `xmp-fields.spec.ts`, `point-tone-curve.spec.ts`, `local-adjustments.spec.ts`, `parametric-tone-curve.spec.ts`, `enum-modes.spec.ts`, `wb-scale-version.spec.ts`, `wb-dng-temperature.spec.ts`, `wb-as-shot-gate.spec.ts`, `black-white.spec.ts`, `color-grading.spec.ts`, `film-look.spec.ts`, `lens-correction.spec.ts`, `s5-effects.spec.ts`, `keywords.spec.ts`, `xmp-metadata*.spec.ts`, `sidecar.store.spec.ts`                              |
| C#         | `XmpCanonicalEnvelopeTests.cs`, `XmpNumberFormatTests.cs`, `XmpRoundTripTests.cs`, `XmpLocalAdjustmentsTests.cs`, `XmpPassthroughTests.cs`, `XmpParserLegacyLayoutTests.cs`, `XmpWbScaleVersionTests.cs`, `SidecarStoreRoundTripTests.cs`, `SidecarCorpusRoundTripTests.cs`                                                                                                                                                                                                 |
| API        | `src/api/src/xmp/metadata-parser.test.ts`, `metadata-serializer.test.ts`, `color-label.test.ts`                                                                                                                                                                                                                                                                                                                                                                             |

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
