# Film Emulation Engine — Design

**Date:** 2026-08-06
**Status:** Approved (brainstorm 2026-08-06)
**Surfaces:** raw-core, raw-gpu (WGSL), codegen, Apple app, Web app, API/CLI

## Summary

Maple gains a Film section in the editor: a catalog of 100 film-stock looks
(color negative, slide, cinema print, consumer/vintage, instant, black &
white) applied as a non-destructive adjustment with a strength slider. A look
is a 33³ 3D LUT applied in display-referred space after the view transform,
implemented once in raw-core as the cross-platform reference and ported to
WGSL for the live GPU path.

This design supersedes the drafted "Scene-Linear Film Emulation Engine"
product spec where the two disagree. The differences are deliberate and
grounded in what the acquired LUT assets actually are; each is called out
below with its rationale.

## Decisions made during brainstorm

1. **Scope: editor-only.** Film looks are a develop-pipeline feature for
   existing photos on all three surfaces (Apple, Web, API/CLI). The drafted
   spec's live iOS camera viewfinder (AVCaptureSession dual-path) is out of
   scope — Maple has no capture surface, and adding one is a separate
   product decision, not a pipeline stage.
2. **LUT source: the acquired pack.** 100 pre-conditioned `.cube` files
   (33³, `DOMAIN 0..1`, titled "(Maple 33)") in six category directories,
   licensing settled, currently at `~/Projects/MapleCube`. Inspection of the
   neutral diagonal shows the film tone response is **baked in**
   (S-curves; Portra lifts black to ~0.029 and rolls off to ~0.974) — these
   are display-referred LUTs in the RawTherapee film-sim lineage, authored
   for gamma-encoded sRGB input.
3. **Edit model: look + strength, fully orthogonal.** Picking a look writes
   two XMP fields and touches nothing else. Grain remains the existing
   independent grain controls. No preset subsystem, no JSON recipe format.
4. **Approach: post-AgX display-referred application.** The drafted spec's
   pre-AgX LogC3 shaper slot assumed self-authored emulsion LUTs with the
   tone curve stripped. Un-baking tone from a finished 3D lattice is
   ill-posed, and whatever survived would be tone-mapped a second time by
   AgX. The LUTs are applied in the domain they were authored for.
5. **View-transform interaction: stack on the active profile.** The look
   applies on top of whatever view transform the image uses (Auto Profile by
   default, Neutral otherwise). No hidden coupling; selecting a look never
   rewrites another field.

## Architecture

### Pipeline placement

The render path today: scene-linear chain → view transform (AgX /
Auto Profile) → `color_grade` (display-referred split-tone) → `grain`
(display-linear) → encode (target-gamut rotate → Oklab gamut compress →
sRGB gamma encode → dither/quantize).

The film stage inserts **between `color_grade` and `grain`**:

```
view transform → color_grade → film_look → grain → encode
```

Grain stays after the look so its monochromatic noise lands on the
film-rendered image untinted — the same ordering rationale already
documented at the grain call site, and how physical film behaves (the look
is the emulsion; grain is visible on the print).

### The stage: `raw-core/src/stages/film_look.rs`

External contract: display-linear Rec.2020 in/out — identical to grain's.
Internal application, per pixel:

1. Rec.2020 display-linear → linear sRGB (3×3 matrix).
2. sRGB gamma encode (IEC 61966-2-1), clamp to `[0, 1]` — the lattice's
   authored domain.
3. Tri-linear sample of the look's 33³ RGB lattice.
4. sRGB gamma decode → linear sRGB → Rec.2020 display-linear (inverse
   matrix).
5. `out = mix(original, film_result, strength / 100)` — the lerp runs in
   display-linear against the **original, unclamped** input, so
   `strength = 0` is a bit-exact no-op and out-of-sRGB-gamut colors degrade
   gracefully (only the film arm is clamped).

Because the LUT is applied in the sRGB-encoded domain and the result is
color-managed onward by the existing encode path, an sRGB canvas and a
display-P3 canvas show the identical look. Black-and-white stocks need no
special casing: their lattices output R = G = B.

### GPU path

`raw-gpu` gains `film_look.wgsl` plus one `texture_3d<f32>` (uploaded from
the same f16 lattice bytes) and the matching sampler. The WGSL port is
parity-gated against the Rust reference exactly like `grain.wgsl`. The
lattice is uploaded when the look changes, never per tick.

### Dropped from the drafted spec, and why

- **LogC3 shaper pair (pre/post LUT):** tone is baked into the acquired
  lattices; the log slot exists to serve scene-referred emulsion LUTs Maple
  does not have. The stage interface does not foreclose adding a
  log-domain LUT slot later if Maple ever authors its own.
- **Post-AgX H-D curve / `shadowLift`:** baked into the lattices; manual
  lift is the existing blacks slider.
- **`hash21` screen-space grain:** Maple's existing grain stage is already
  the spec's parabolic-weighted film grain, and strictly better —
  deterministic (no RNG), resolution-stable pitch, tile-safe, WGSL
  parity-gated. It is reused unchanged.
- **JSON recipe sidecar:** the XMP sidecar remains the only edit contract.
  Every recipe parameter except the look identifier and strength already
  exists as an XMP adjustment field.
- **PSNR-42dB dual-path acceptance:** collapses into Maple's existing
  preview/export and Rust↔WGSL parity gates.

## Data model and persistence

Two new codegen'd `AdjustmentModel` fields:

| Field           | Kind                             | Range / default    | XMP                 |
| --------------- | -------------------------------- | ------------------ | ------------------- |
| `film_look`     | String (new `FieldKind::String`) | empty = none       | `papp:FilmLook`     |
| `film_strength` | F32                              | 0–100, default 100 | `papp:FilmStrength` |

`FieldKind::String` follows the `ToneCurve` precedent: codegen emits the
field references (Swift `FieldName` case, TS interface member, defaults);
the value type is the platform string type. The sidecar-schema doc gets a
versioned addition; absent fields default cleanly, so existing sidecars are
untouched and passthrough XML is preserved byte-for-byte.

The look identifier is the pack's stable snake_case id (e.g.
`color_negative_kodak_portra_400`). An identifier that doesn't resolve at
render time (missing pack file, future look on an older install) renders as
identity and surfaces a non-fatal diagnostic — never an error render.

## LUT asset pipeline

A new ingest tool (Rust, invoked via `tools/`, same spirit as
`tools/codegen.sh`) reads the acquired `.cube` pack and:

1. **Validates** each file: `LUT_3D_SIZE 33`, domain `[0,1]`, 35 937
   parseable RGB triples, values finite.
2. **Emits one `.mlut` binary per look**: fixed header (magic, version,
   grid size) + f16 RGB lattice, ~216 KB each, ~22 MB for the catalog,
   committed to a new repo-root `resources/film-luts/` directory (neutral
   ground: Apple references it as a bundle resource, the web build copies
   the requested files into its dist, the API and CLI read it directly).
   The raw
   `.cube` files stay outside the repo; the committed `.mlut` pack is the
   artifact of record.
3. **Regenerates the catalog** through the codegen pipeline: a Rust
   source-of-truth table (id, display name, category) emitting Swift and TS
   constants, so both pickers are generated and covered by the existing
   `codegen-drift` CI job.

## Runtime data flow

The active look's lattice crosses the FFI/WASM boundary **once, on look
change**, and is cached in the render session keyed by look id. Slider
ticks carry only `(look_id, strength)` in the chain params. This honors the
render-loop budgets: no allocation in the loop, no per-tick boundary
crossing.

- **Apple:** `.mlut` pack ships in app resources; MapleCore loads the
  selected look and passes bytes over FFI.
- **Web:** looks are fetched lazily per look over HTTP (API route in Self
  Hosted, static assets in Hosted), cached in IndexedDB, and uploaded once
  to the worker/GPU session on selection.
- **API / maple-cli:** the dylib and CLI read `.mlut` files from the repo
  assets directory on disk, keeping the harness deterministic and headless.

Previews and thumbnails need no new plumbing: the rendered-preview cache
keys on `sidecar_mtime`, so a look change invalidates correctly.

## UI

A **Film** section in the detail inspector on both platforms, built from
the generated catalog constants:

- Category-grouped stock picker (six categories, 100 looks), current look
  highlighted, "None" clears.
- Strength slider (0–100, default 100), live like every other slider.
- Apple: SwiftUI, `@Observable`, in `MapleApp`'s detail panel. Web:
  standalone Angular component in `maple-common`, signals,
  `input()`/`output()`, separate `.ts`/`.html`/`.scss`.

Per repo convention the UI ships in the same epic as the pipeline — no
API-only or core-only landing.

## Testing

1. **Unit (Rust):** tri-linear sampling vs closed form on a synthetic
   lattice; identity lattice ≈ no-op; `strength = 0` bit-exact no-op;
   strength linearity; `.mlut` encode/decode round-trip; `.cube` parser
   edge cases (whitespace, comments, malformed rows); B&W lattice
   neutrality (output stays R = G = B).
2. **Parity:** WGSL film stage vs Rust reference with a budget, same
   harness pattern as grain.
3. **Regression:** the ACR color harness runs with no look active — every
   existing budget must be unaffected. This is the merge gate proving the
   stage is a true no-op when off.
4. **Golden ratchet:** one committed golden per category (6 looks) rendered
   on the synthetic fixture and `test_0017`, CIEDE2000-diffed with tight
   self-consistency budgets. These are regression goldens, not ACR parity —
   ACR has no reference for creative looks.
5. **Performance:** live path adds one 3D-texture sample per pixel on GPU —
   within the 16 ms tick budget; export adds one CPU trilinear per pixel,
   negligible against demosaic.

## Out of scope

- Live camera viewfinder / capture surface (separate product decision).
- Scene-referred (log-domain) emulsion LUT slot — add only if Maple
  authors its own emulsion models.
- Per-look grain defaults or any preset machinery.
- User-imported custom LUTs.

## Dependencies and risks

- **Asset location:** the `.cube` pack currently lives at
  `~/Projects/MapleCube` on one machine. The ingest run commits the
  `.mlut` pack, after which the repo is self-sufficient; re-running ingest
  requires the original pack.
- **Repo weight:** ~22 MB of committed binary assets. Accepted; precedent
  exists (`agx_lut.bin`), and per-look files keep diffs and lazy web
  delivery tractable.
- **`FieldKind::String` is new codegen surface:** Swift/TS emission and XMP
  round-trip for a string field must be built once; `ToneCurve` is the
  template.
