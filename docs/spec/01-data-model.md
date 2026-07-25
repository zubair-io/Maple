# 01 — Data Model

The domain types, their invariants, and their lifecycles. This is the contract every platform, every cache, every sidecar round-trip must respect. See [`00-overview.md`](./00-overview.md) for the philosophy that shaped these choices.

The guiding rule: each type is a plain record of values with no behavior attached. Rendering, serialization, caching, and UI state all hang off these records externally. This is what makes the model portable across Rust, Swift, and TypeScript — and what makes round-tripping with Adobe XMP tractable.

---

## Top-level types

```
ImageAsset          A discoverable image (RAW or rendered) and its identity on disk
AdjustmentModel     The full parameter set for a non-destructive edit
CullingState        Rating, flag, color label (first-class, sidecar-persisted)
SidecarDocument     The parsed-but-not-yet-interpreted form of an .xmp file
EditSession         Transient, per-image UI state for the editor (not persisted)
LibraryIndex        The cached manifest of a folder (performance layer; not authoritative)
```

Each is described below with fields, defaults, invariants, and lifecycle.

---

## `ImageAsset`

Represents an image as it exists in one of the three sources: Apple Photos (PhotoKit), the filesystem, or an SMB share. The asset identity is what the UI treats as "one photo", even when multiple files (the RAW + sidecar + maybe a JPEG) contribute to it.

### Fields

| Field                        | Type          | Notes                                                                                                                                     |
| ---------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | opaque string | Stable across a session. Source-specific: PhotoKit `localIdentifier`, a hash of the absolute filesystem path, or `smb://host/share/path`. |
| `sourceKind`                 | enum          | `photokit`, `filesystem`, `smb`                                                                                                           |
| `primaryURL`                 | URL           | The RAW/JPEG/HEIC the asset is named after.                                                                                               |
| `sidecarURL`                 | URL?          | Where the `.xmp` lives (or would live). See [`08-io.md`](./08-io.md) § Sidecar location.                                                  |
| `filename`                   | string        | Display name.                                                                                                                             |
| `fileSize`                   | UInt64        | Bytes of `primaryURL`.                                                                                                                    |
| `modificationDate`           | Date          | `primaryURL` mtime — not the sidecar's.                                                                                                   |
| `mimeType`                   | string        | `image/x-adobe-dng`, `image/jpeg`, etc.                                                                                                   |
| `isRAW`                      | bool          | True if the format requires demosaic.                                                                                                     |
| `pixelWidth` / `pixelHeight` | UInt32?       | Extracted from metadata; `nil` until decoded once.                                                                                        |
| `ratingStars`                | UInt8         | 0–5. Default 0. **Lives here and in `CullingState` — they are the same field.**                                                           |
| `flag`                       | enum          | `pick`, `reject`, `unflagged`. Default `unflagged`.                                                                                       |
| `colorLabel`                 | enum?         | `red`, `orange`, `yellow`, `green`, `blue`, `purple`, or absent.                                                                          |

### Invariants

1. **`id` is deterministic from `(sourceKind, primaryURL)`** — the same file in the same source always yields the same id across launches. Do not derive `id` from a database primary key.
2. **`sidecarURL` is computed, not stored.** The rule is in [`08-io.md`](./08-io.md); never cache `sidecarURL` in long-lived storage because the user can move files.
3. **A PhotoKit asset has no user-writable `primaryURL`.** Sidecars for PhotoKit assets live under `~/Library/Application Support/MapleMaple/sidecars/{UUID}.xmp`, keyed by the `localIdentifier`.
4. **Culling fields are mirrored to the sidecar.** `ratingStars`, `flag`, and `colorLabel` are persisted; the `ImageAsset` in memory is the fast path, the sidecar is the source of truth on reload.

### Lifecycle

Created lazily by the active source adapter (`FilesystemSource`, `PhotoKitSource`, `SMBSource`). Enumeration of a folder produces `ImageAsset` stubs with just identity and filesystem metadata; pixel dimensions and culling state are populated asynchronously as the UI scrolls. See [`02-pipeline.md`](./02-pipeline.md) § Folder load.

`ImageAsset` is a value type (Swift `struct`, TypeScript plain object, Rust `#[derive(Clone)]` record). Comparison is by `id` only.

---

## `AdjustmentModel`

The single source of truth for all non-destructive edits. Every platform serializes, deserializes, renders, and round-trips this type. Byte-equivalence of the XMP form after any sequence `model → serialize → parse → model` is a hard test gate; see [`xmp-canonical-format.md`](../xmp-canonical-format.md).

### Structure

The model groups fields by UI panel and by the underlying math, which happen to coincide. The fourteen interactive sliders currently exposed:

**Tone group** (affects luminance):

| Field        | Range          | Default | XMP key              |
| ------------ | -------------- | ------- | -------------------- |
| `exposure`   | −4.0 … +4.0 EV | `0.0`   | `crs:Exposure2012`   |
| `contrast`   | −100 … +100    | `0`     | `crs:Contrast2012`   |
| `highlights` | −100 … +100    | `0`     | `crs:Highlights2012` |
| `shadows`    | −100 … +100    | `0`     | `crs:Shadows2012`    |
| `whites`     | −100 … +100    | `0`     | `crs:Whites2012`     |
| `blacks`     | −100 … +100    | `0`     | `crs:Blacks2012`     |

**White balance group:**

| Field         | Range          | Default | XMP key           |
| ------------- | -------------- | ------- | ----------------- |
| `temperature` | 2000 … 12000 K | `6500`  | `crs:Temperature` |
| `tint`        | −100 … +100    | `0`     | `crs:Tint`        |

**Presence group** (mid-frequency contrast and saturation):

| Field        | Range       | Default | XMP key           |
| ------------ | ----------- | ------- | ----------------- |
| `vibrance`   | −100 … +100 | `0`     | `crs:Vibrance`    |
| `saturation` | −100 … +100 | `0`     | `crs:Saturation`  |
| `clarity`    | −100 … +100 | `0`     | `crs:Clarity2012` |
| `texture`    | −100 … +100 | `0`     | `crs:Texture`     |
| `dehaze`     | −100 … +100 | `0`     | `crs:Dehaze`      |

**Detail group** (capture sharpening + noise reduction):

| Field            | Range     | Default | XMP key                                                                                                                                                                          |
| ---------------- | --------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sharpenAmount`  | 0 … 150   | `0`     | `crs:SharpenAmount`                                                                                                                                                              |
| `sharpenRadius`  | 0.5 … 3.0 | `0.5`   | `crs:SharpenRadius` (PSF Gaussian sigma under RL; semantic meaning differs from Lightroom's unsharp-radius interpretation — see [`03-algorithms.md`](./03-algorithms.md) § 3.10) |
| `sharpenDetail`  | 0 … 100   | `25`    | `crs:SharpenDetail`                                                                                                                                                              |
| `sharpenMasking` | 0 … 100   | `0`     | `crs:SharpenEdgeMasking`                                                                                                                                                         |
| `nrLuminance`    | 0 … 100   | `0`     | `crs:LuminanceSmoothing`                                                                                                                                                         |
| `nrColor`        | 0 … 100   | `25`    | `crs:ColorNoiseReduction`                                                                                                                                                        |

**Geometry group** (crop and rotation):

| Field                                       | Type / Range | Default    | XMP key            | Notes                                                                                         |
| ------------------------------------------- | ------------ | ---------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `crop.top` / `.left` / `.bottom` / `.right` | Float 0…1    | full frame | `crs:CropTop` etc. | Only emitted when crop is non-identity; `crs:HasCrop="True"` marker always emitted alongside. |
| `crop.angle`                                | degrees      | `0.0`      | `crs:CropAngle`    | Only emitted when non-zero.                                                                   |

**Tone curves** — two families, both nested element form, both `Seq` of `x, y` pairs in `0…255`. Emitted only when non-identity. Each family applies at a different pipeline stage; both can coexist on the same image. See [`03-algorithms.md`](./03-algorithms.md) § Tone curve representation and [`09-open-questions.md`](./09-open-questions.md) § 9.50.

_Scene-linear_ (Maple's primary; applied at stage 3 inside `SceneToneControls`; `[0, 255]` maps to scene `[0, ref_max]`):

| Field                        | XMP element                      |
| ---------------------------- | -------------------------------- |
| `sceneLinearToneCurveMaster` | `papp:SceneLinearToneCurve`      |
| `sceneLinearToneCurveRed`    | `papp:SceneLinearToneCurveRed`   |
| `sceneLinearToneCurveGreen`  | `papp:SceneLinearToneCurveGreen` |
| `sceneLinearToneCurveBlue`   | `papp:SceneLinearToneCurveBlue`  |

_Display-referred_ (Lightroom-compatible; applied at stage 12a after AgX; `[0, 255]` maps to display `[0, 1]`):

| Field                        | XMP element                |
| ---------------------------- | -------------------------- |
| `displayReferredCurveMaster` | `crs:ToneCurvePV2012`      |
| `displayReferredCurveRed`    | `crs:ToneCurvePV2012Red`   |
| `displayReferredCurveGreen`  | `crs:ToneCurvePV2012Green` |
| `displayReferredCurveBlue`   | `crs:ToneCurvePV2012Blue`  |

**Version signaling** (always emitted):

- `crs:Version` = `"11.0"`
- `crs:ProcessVersion` = `"11.0"` (Adobe PV11 / Process Version 2022)
- `crs:HasSettings` = `"True"`
- `crs:CropConstrainToWarp` = `"0"` (emitted only when crop is non-identity)

**Culling** (mirrored to `ImageAsset`):

| Field        | XMP key           | Emit rule                                             |
| ------------ | ----------------- | ----------------------------------------------------- |
| `rating`     | `xmp:Rating`      | Only when `> 0`. Adobe convention: absence = unrated. |
| `flag`       | `papp:Flag`       | Only when `pick` or `reject`; absence = unflagged.    |
| `colorLabel` | `papp:ColorLabel` | Only when set.                                        |

**Passthrough buckets** (for lossless round-trip with Lightroom):

| Field               | Type                                                                    | Purpose                                              |
| ------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| `passthroughFields` | `[String: String]` (fully-qualified attribute name → XML-escaped value) | Unknown attributes on `rdf:Description`.             |
| `passthroughNodes`  | ordered list of opaque XML strings                                      | Unknown nested elements (masks, history, snapshots). |

### Invariants

1. **Default model produces identity pipeline.** `AdjustmentModel.default()` renders to the neutral decoded image, byte-for-byte.
2. **Non-default fields only.** Serialization emits a field only when it differs from its default, with three exceptions always emitted: `crs:Version`, `crs:ProcessVersion`, `crs:HasSettings`. This keeps sidecar size reasonable and matches Lightroom behavior.
3. **Crop fields are emitted as a group.** When any of top/left/bottom/right differ from the full-frame identity, all four emit plus `crs:HasCrop="True"` and `crs:CropConstrainToWarp="0"`. `crs:CropAngle` is independently emitted only when non-zero.
4. **Tone-curve identity test is structural.** `[(0,0), (255,255)]` — any sequence with only two endpoints exactly at the corners is identity. Any other shape serializes.
5. **Passthrough nodes preserve order.** Mask groups, history entries, and snapshots rely on element order; re-emission must be stable.
6. **Passthrough fields emit alphabetically by fully-qualified name**, after all known `crs:` / `xmp:` / `papp:` / `xmpMM:` attributes, to keep the byte form stable regardless of input order.
7. **Numbers are canonical.** Integers emit as `String(Int(v))` (no trailing `.0`). Non-integers emit at 2 decimal places, then trailing zeros and a trailing `.` are stripped: `0.50 → "0.5"`, `0.123 → "0.12"`. NaN / Infinity are replaced with the field's default. See [`xmp-canonical-format.md`](../xmp-canonical-format.md).

### Lifecycle

```
Sidecar (.xmp on disk)
    ↓ parse
SidecarDocument (intermediate)
    ↓ interpret
AdjustmentModel (in memory)
    ↓ EditSession mutates in response to slider changes
AdjustmentModel (dirty)
    ↓ 500ms debounce
SidecarDocument (re-built)
    ↓ serialize
Sidecar (.xmp on disk, byte-canonical)
```

`AdjustmentModel` is a value type. Copy-paste of adjustments between images is literally a struct copy with the `crop` and passthrough buckets cleared. Undo/redo is a stack of `AdjustmentModel` snapshots; see [`07-ui-architecture.md`](./07-ui-architecture.md).

---

## `CullingState`

The subset of `AdjustmentModel` that lives on `ImageAsset` as a fast path for grid rendering. It is duplicated — not a reference — because grid cells must render without opening the sidecar.

| Field        | Type        | Default     | XMP                                         |
| ------------ | ----------- | ----------- | ------------------------------------------- |
| `rating`     | UInt8 (0–5) | `0`         | `xmp:Rating` attribute on `rdf:Description` |
| `flag`       | enum        | `unflagged` | `papp:Flag` attribute (see below)           |
| `colorLabel` | enum?       | absent      | `papp:ColorLabel` / `xmp:Label` attribute   |
| `keywords`   | `[String]`  | `[]`        | `dc:subject` nested element (see below)     |

The flag and the colour label are separate fields with separate attributes. `xmp:Label` is Adobe's colour word and is read as a colour label only. Apple sidecars written before #2221 overloaded `xmp:Label` for the flag (`"Red"` for a pick, `"Rejected"` for a reject); the Apple parser still accepts those two spellings so existing files keep their flags, but nothing writes them any more, and `papp:Flag` wins whenever both appear. See `docs/xmp-canonical-format.md` § "Culling fields".

### Invariants

1. **Sidecar is authoritative on load.** On app start, `CullingState` on the in-memory `ImageAsset` is repopulated from the sidecar, not from any database.
2. **Writes go to both in lockstep.** Any UI action that changes culling updates the `ImageAsset` immediately (for grid refresh) and queues a sidecar write in the same transaction.

### Keywords (`dc:subject`)

IPTC keywords (#632) round-trip through the Dublin Core `dc:subject` element rather than an `rdf:Description` attribute, because the XMP specification requires a `<rdf:Bag>` of `<rdf:li>` items:

```xml
<rdf:Description ...
    xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:subject>
    <rdf:Bag>
      <rdf:li>travel</rdf:li>
      <rdf:li>paris</rdf:li>
    </rdf:Bag>
  </dc:subject>
</rdf:Description>
```

Emit rules:

1. **Empty list omits the element.** No `<dc:subject>`, no `xmlns:dc=…` declaration — the default round-trip is `keywords: []` → no element → `keywords: []`. This matches the rating/flag pattern (defaults are not emitted) and the absent-by-default sidecar shape.
2. **Order preserved on write.** `dc:subject` is semantically an unordered Bag, but every consumer (Lightroom, Maple's parsers, the reference renderer) reads `rdf:li` children in source order; emitting them in the order the user typed keeps the chip row stable across reload.
3. **XML text-content escaping.** `&`, `<`, `>` are escaped on the write path and decoded on read. Attribute-only escapes (`"`, `'`) are not required for `rdf:li` text content.
4. **Blank entries dropped on read and write.** Whitespace-only `<rdf:li>` content is filtered out — neither path is allowed to surface an empty keyword to the model.
5. **Passthrough exclusion.** Parsers must not collect `dc:subject` into the `unknownNodes` passthrough bucket; the canonical block from `culling.keywords` would otherwise be emitted alongside a passthrough copy on the next write, producing two `<dc:subject>` siblings on disk.

---

## `SidecarDocument`

An intermediate representation sitting between the parsed XML and the interpreted `AdjustmentModel`. It exists because XMP's element vs attribute vs nested-sequence vs passthrough distinctions need to survive parsing and serialization without being flattened into typed fields prematurely.

### Structure (conceptual)

```
SidecarDocument {
    envelope: XmpEnvelope      // xpacket header, namespaces in canonical order
    attributes: ordered [(qualifiedName, value)]   // attributes on rdf:Description
    elements: ordered [SidecarElement]             // nested <crs:ToneCurve...>, masks, etc.
}

SidecarElement = LeafText { name, text }
              | SelfClosing { name, attributes }
              | Container { name, children: [SidecarElement] }
              | OpaqueXml { raw: String }          // passthrough
```

### Invariants

1. **Round-trip is exact.** `bytes → parse → SidecarDocument → serialize → bytes` must produce the same byte string, modulo whitespace normalization for known elements. Unknown elements (`OpaqueXml`) must re-emit their raw source verbatim.
2. **Serialization order is canonical**, not input order, for known fields. Attribute order is by namespace priority (`xmp:` → 0, `crs:` → 1, `papp:` → 2, `xmpMM:` → 3, unknown → 500), then alphabetical within each namespace. Element children order for tone curves is fixed: master, red, green, blue.
3. **BOM is literal.** The U+FEFF inside `<?xpacket begin="\ufeff" id="..."?>` is not stripped. Line endings are LF only. File ends with `>`, no trailing newline.

### Lifecycle

A `SidecarDocument` is usually invisible outside the sidecar layer. `XMPParser.parse(data: Data) → SidecarDocument`, then `SidecarDocument.interpret() → (AdjustmentModel, cullingState, passthroughBuckets)`. Writing reverses: `AdjustmentModel + passthrough → SidecarDocument → XMPSerializer → Data`.

---

## `EditSession`

Per-image transient state for the editor. **Not persisted.** Lives only while the editor is open on one image, dies when the user navigates away.

### Fields

| Field                | Type                | Notes                                                                                            |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `asset`              | `ImageAsset`        | The image being edited.                                                                          |
| `model`              | `AdjustmentModel`   | Live, mutable. Debounced writer watches this.                                                    |
| `originalModel`      | `AdjustmentModel`   | What was loaded from the sidecar. Used by "Revert".                                              |
| `decodedImage`       | GPU image handle    | The output of `raw-core` (Rust) or `CIRAWFilter` (Swift fallback). Cached until session ends.    |
| `renderedPreview`    | GPU image handle?   | The current output of the filter chain. Invalidated on every slider change.                      |
| `renderPhase`        | enum                | `fast` (50ms target) or `refine` (300ms target). See [`05-performance.md`](./05-performance.md). |
| `zoom`               | `ZoomState`         | Scale, pan offset, pixel-perfect flag. See [`zoom.md`](../zoom.md).                              |
| `wbEyedropperSample` | `CGPoint?`          | Set when the user clicks the image in WB-sample mode.                                            |
| `undoStack`          | `[AdjustmentModel]` | Bounded to N snapshots. Push on commit boundaries, not on every slider tick.                     |
| `redoStack`          | `[AdjustmentModel]` | Cleared on any non-undo commit.                                                                  |
| `isEditingSlider`    | bool                | `true` while the user is mid-drag; commit to undo stack on release.                              |
| `isDirty`            | bool                | `model != originalModel`. Drives the "unsaved" indicator.                                        |

### Invariants

1. **`originalModel` never changes during the session.** "Revert" restores `model = originalModel`.
2. **Undo snapshots are coarse.** Committed on slider release, WB preset, eyedropper sample, copy-paste, and keyboard-shortcut culling — not on every intermediate slider value.
3. **`endEditing` is synchronous.** On navigation away, the sidecar flush is awaited before the `EditSession` is torn down. No fire-and-forget writes.
4. **`decodedImage` is session-scoped.** Never written to any persistent cache; the rendered-preview cache caches the final filtered output, not the decoded input. See [`05-performance.md`](./05-performance.md) § RenderedPreviewCache.

### Lifecycle

```
User opens image
    ↓
EditSession created with model=parseSidecar(asset), originalModel=copy
    ↓
RAW decode kicked off on Task.detached (background)
    ↓
decodedImage populated → triggers first render
    ↓
User moves a slider → model mutated → render invalidated
    ↓ (on slider release)
Snapshot pushed to undoStack; debounced sidecar write scheduled
    ↓ (on navigate away)
endEditing(): await sidecar flush; tear down
```

See [`07-ui-architecture.md`](./07-ui-architecture.md) for the full state machine.

---

## `LibraryIndex`

A per-folder cache of asset metadata. **Non-authoritative.** The source adapter (filesystem/PhotoKit/SMB) is always allowed to disagree with the index; the index is strictly a speedup for cold folder open.

### Structure

```
LibraryIndex {
    folderURL: URL
    schemaVersion: Int                   // bump on breaking changes
    assets: [AssetRecord]                // one per image file found
    lastFullScan: Date
}

AssetRecord {
    filename: String
    fileSize: UInt64
    modificationDate: Date
    cullingState: CullingState
    thumbnailHash: String?               // points into ThumbnailDiskCache
    pixelWidth: UInt32?
    pixelHeight: UInt32?
    isRAW: Bool
}
```

### Invariants

1. **Conflict resolution favors the filesystem.** If `AssetRecord.modificationDate ≠ disk mtime`, the index entry is refreshed from disk and sidecar.
2. **Missing files are pruned lazily.** If an `AssetRecord` points to a file that no longer exists, drop it on next scan; don't fail.
3. **Added files are folded in incrementally.** A full re-scan is not required on every folder visit; compare directory mtime or use filesystem events when available.
4. **The index is disposable.** If it corrupts, delete it — the next folder open rebuilds it from sidecars.

### Location

- Filesystem: `{folder}/.maple/index.json` — hidden sibling.
- SMB: same, `.maple/index.json` on the share.
- PhotoKit: `~/Library/Application Support/MapleMaple/photokit-index.json` (one global).

See [`08-io.md`](./08-io.md) § Library index.

---

## Type parity across platforms

A rewrite must hit these invariants regardless of language:

| Type              | Rust                                 | Swift                             | TypeScript                                                  |
| ----------------- | ------------------------------------ | --------------------------------- | ----------------------------------------------------------- |
| `AdjustmentModel` | `#[derive(Clone, PartialEq)]` struct | `struct` with `Equatable`         | `interface` + helpers; structural equality via deep compare |
| `CullingState`    | enum + UInt8                         | `enum` + `UInt8`                  | string-literal union + number                               |
| `ImageAsset`      | not needed in Rust core              | `struct`                          | `interface`                                                 |
| Tone curve        | `Vec<(u8, u8)>`                      | `[CGPoint]` or `[(UInt8, UInt8)]` | `Array<[number, number]>`                                   |

The XMP byte form is the wire protocol. Two platforms disagree on model semantics only if their serialization output disagrees on bytes. A golden-file corpus of Lightroom-written and Maple-written sidecars is round-tripped through every platform in CI. See [`06-cross-platform.md`](./06-cross-platform.md) § Test contract.

---

## What this document does not define

- **The filter execution order.** See [`02-pipeline.md`](./02-pipeline.md).
- **How a slider value is translated into a CIFilter / WebGL uniform / Metal param.** See [`03-algorithms.md`](./03-algorithms.md).
- **Where sidecars live on disk.** See [`08-io.md`](./08-io.md).
- **Which colorspace a pixel is in at a given moment.** See [`04-color-management.md`](./04-color-management.md).
- **Whether a masks field exists.** Phase 4 addition; the `passthroughNodes` bucket is the forward-compat mechanism. See [`09-open-questions.md`](./09-open-questions.md).
