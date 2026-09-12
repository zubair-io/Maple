# @justmaple/maple

The official image processing, development, and export package for Maple — powered by Maple's scene-referred Rust image processing core (`raw-core` and `raw-ffi`).

Provides both a TypeScript/JavaScript programmatic API and a `maple` CLI for headless export, recipe processing, thumbnail extraction, and batch-renaming.

Requires [Bun](https://bun.sh): the native core is loaded through `bun:ffi`, so the library and the CLI both run under Bun, not Node.

## Installation

```bash
bun add @justmaple/maple
# or
npm install @justmaple/maple
```

The matching prebuilt native library (`@justmaple/maple-<platform>`) is installed automatically as an optional dependency for macOS (arm64, x64), Linux (x64, arm64; glibc and musl) and Windows (x64).

## CLI Usage (`npx maple`)

Once `@justmaple/maple` is a dependency of your project, `npx maple` (or `bun x maple`) runs the CLI. For a one-off run without installing, use `bunx @justmaple/maple <command>` or `npx -p @justmaple/maple maple <command>`.

Run headless photo exports directly from your terminal:

```bash
# Export a RAW to JPEG with sRGB (default) or Display P3
npx maple export DSC_0001.NEF -o output.jpg -q 95
npx maple export DSC_0001.NEF -o output.jpg -c display-p3

# Export with custom XMP adjustments applied
npx maple export IMG_001.CR3 -x IMG_001.xmp -o output.jpg

# Export directly to 16-bit TIFF or 8-bit PNG
npx maple export photo.dng -o photo.tif
npx maple export photo.dng -o photo.png

# Export using a Maple ExportRecipe contract
npx maple export photo.dng -r web-sharing.json -o deliverable.jpg

# Batch export an entire folder of RAWs using a recipe
npx maple recipe web-sharing.json ./photos/*.ARW --out-dir ./exports/

# Extract embedded RAW thumbnail to AVIF or JPEG
npx maple thumb photo.dng -o thumb.avif -s 512
npx maple thumb photo.dng -o preview.jpg -s 1280 -f jpeg
```

## Programmatic API

### Fluent Builder API

```typescript
import { maple } from '@justmaple/maple';

// Simple export to JPEG
await maple('input.dng').format('jpeg').quality(92).colorSpace('srgb').toFile('output.jpg');

// Export with XMP adjustments & resize
await maple('input.dng').xmp('input.xmp').maxLongEdge(2048).toFile('web_preview.jpg');

// Batch recipe export
await maple('input.dng').recipe(exportRecipeConfig).toFile('export.jpg');
```

### Direct Export Functions

```typescript
import {
  exportImage,
  exportRecipe,
  renderThumbnail,
  renderPreview,
  renderFilenameTemplate,
  validateFilename,
} from '@justmaple/maple';

// Export an image directly
const result = await exportImage({
  rawPath: '/path/to/source.dng',
  outPath: '/path/to/output.jpg',
  format: 'jpeg',
  quality: 92,
  colorSpace: 'srgb',
});

// Batch template rendering (shared across Maple Apple, Web, and API)
const filename = renderFilenameTemplate({
  template: '{original}_{n}.{ext}',
  originalStem: 'DSC_0001',
  ext: 'jpg',
  capturedAt: '2026:09:09 14:30:00',
  sequenceStart: 1,
  sequenceIndex: 0,
  sequencePadWidth: 4,
});
// filename => { ok: true, name: "DSC_0001_0001.jpg" }
```

### Raw pixels in and out

```typescript
import { maple } from '@justmaple/maple';

// Caller-decoded pixels (e.g. from a PSD/HDR/HEIC decoder) into the same resize/encode path
const avif = await maple({ data: rgb, width, height, channels: 3 })
  .resize({ width: 512, height: 512, fit: 'inside' })
  .toFormat('avif', { quality: 55, effort: 4 })
  .toBuffer();

// Native-size RGB8 for ML alignment / custom sampling
const { data, width: w, height: h } = await maple(jpegBytes).rotate().toRaw();
```

`fit` accepts all five of sharp's modes — `'inside' | 'fill' | 'cover' | 'contain' | 'outside'`. `kernel` (and its alias `filter`) accepts all six kernels — `'nearest' | 'linear' | 'cubic' | 'mitchell' | 'lanczos2' | 'lanczos3'`, with `'bilinear'` accepted as a second spelling of `'linear'`. AVIF `effort` is 0 (fastest) to 9 (slowest), as in sharp. AVIF inputs decode (pure-Rust AV1 decoder); a JPEG truncated in its scan data decodes to the rows that survived.

**`withoutEnlargement` defaults to `true`** here, where sharp defaults it to `false`. A source smaller than the requested box is therefore left at its own size, and in particular `fit: 'cover'` never upscales to fill the box unless you pass `withoutEnlargement: false`. A `width` or `height` of `0` means "keep the source dimension on this axis". `withoutReduction` follows sharp and defaults to `false`.

## sharp parity

| sharp method                         | Maple | Notes                                                                                                                                                                                          |
| :------------------------------------ | :---- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extract()`                     | ✅    | `{ left, top, width, height }`                                                                                                                                                                 |
| `extend()`                      | ✅    | background only — `extendWith: 'copy' \| 'repeat' \| 'mirror'` throws by name                                                                                                                  |
| `rotate(angle)`                 | ✅    | 90/180/270 exact; other angles bilinear into the rotated box                                                                                                                                   |
| `rotate()`                      | ✅    | no argument = EXIF auto-orient, as in sharp                                                                                                                                                    |
| `flip()`                        | ✅    |                                                                                                                                                                                                 |
| `flop()`                        | ✅    |                                                                                                                                                                                                 |
| `trim()`                        | ✅    | `{ background, threshold, margin }` — `margin` is a Maple extension, not in sharp's `trim` options; `lineArt` throws by name; an all-background image is returned unchanged, matching sharp   |
| `composite()`                   | ✅    | `over`, `multiply`, `screen`, `add`, `darken`, `lighten`, `dest-in`, `dest-out`                                                                                                                |
| `flatten()`                     | ✅    | background as `{r,g,b}` or `#rrggbb`                                                                                                                                                           |
| `ensureAlpha()`                 | ✅    |                                                                                                                                                                                                 |
| `removeAlpha()`                 | ✅    |                                                                                                                                                                                                 |
| `greyscale()` / `grayscale()`        | ✅    | Rec.709 luma reduced in linear light (de-gamma, weight, re-gamma), three identical channels |
| `gamma()`                            | ✅    | an assembly-time pair around the `resize` op: `gamma` itself before it, `1/gammaOut` after; residual ≤1 — a single-code artefact at input 255 for `gammaOut` 1/1.5 and 1/3, where libvips' own float chain returns 254 rather than 255 |
| `linear()`                           | ✅    | scalar or per-channel `a` and `b`, on the encoded samples; a 4-element vector is rejected by name (sharp applies the 4th element to alpha on RGBA input — this op never touches alpha) |
| `negate()`                           | ✅    | `{ alpha: false }` spares the alpha channel                                                 |
| `normalise()` / `normalize()`        | ✅    | percentile stretch of CIELAB L\*, chroma preserved                                          |
| `modulate()`                         | ✅    | brightness/lightness on L\*, saturation on C\*, hue rotation, in CIELCh                     |
| `tint()`                             | ✅    | linear-light luma as `greyscale`, then a\*/b\* from the tint; colour as `{r,g,b}` or `#rgb`/`#rrggbb`/`#rrggbbaa` (no CSS names); residual max 3, from the composed CIELAB matrices (#3581) |
| `toColourspace()` / `toColorspace()` | ⚠️    | takes `srgb`, `display-p3`/`p3` and `b-w`; other libvips interpretation names error by name. Closer to sharp's `withIccProfile` than to its `toColourspace`, which takes interpretation names and silently ignores `display-p3`. `'b-w'` raw output is 3 identical bands, like `greyscale()` above — sharp's is 1 band |
| `toFormat('avif')` + `toColourspace('display-p3')` | ❌    | rejected by name. This crate does not write AVIF's `colr` box yet, and an untagged P3 AVIF reads back as sRGB and double-stretches; sharp tags it. Export sRGB, or use JPEG/PNG/TIFF/WebP for a P3 deliverable                  |
| `resize({ fit })`               | ✅\*  | `cover`, `contain`, `fill`, `inside`, `outside`; `contain` letterboxes with `background`                                                                                                       |
| `resize({ position })`          | ✅    | nine gravities and eight `position` spellings; `entropy`/`attention` throw by name                                                                                                             |
| `resize({ kernel })`            | ✅    | `nearest`, `linear`, `cubic`, `mitchell`, `lanczos2`, `lanczos3`; `filter` is an alias; `mks2013`/`mks2021` throw by name                                                                      |
| `resize({ withoutReduction })`  | ✅    | `withoutReduction` wins when both clamps are set, as in sharp                                                                                                                                  |

**\* One known gap, at heavy downscales only.** Everything about how the
target box is chosen matches sharp: the per-axis shrink factors and how each
canvas collapses them, the single-axis rule, both clamps and their
precedence, the round-up bias on a centre crop and the round-down bias on a
letterbox pad, and `contain`'s negative-offset embed when a clamp holds the
scale back. What does not match is the last pixel of the DERIVED axis when
the image is shrunk hard. libvips does not resize in one step — it splits
the scale into an integer `vips_shrink` plus a residual `vips_reduce` and
rounds at each stage — so its second axis can land a pixel away from any
single-step rounding, in either direction: measured against sharp 0.34.5 /
libvips 8.17.3 on a 400x200 source, an `inside` 19x19 box gives 19x10 in
sharp and 19x9 in Maple, while a 31x31 box gives 31x15 in sharp and 31x16
in Maple. Closing it means porting `vips_resize`'s staging rather than
tuning a rounding mode.

`gamma()` and `linear()` operate on the encoded 8-bit samples, matching what
libvips does. `gamma`'s job is to move the **resize** into a different
encoding: the `gamma`/`gammaOut` pair is resolved once the full op list is
known — spliced around the first `resize` op in the final chain, or appended
if there is none — so it lands correctly regardless of whether `.gamma()` is
called before or after `.resize()`. The wire exponents are not sharp's own
`1/gamma`/`gammaOut`: our recipe's `gamma` op is a plain power law rather
than libvips' reciprocal `vips_gamma`, so matching sharp's net effect means
sending `gamma` itself as the pre-resize exponent and `1/gammaOut` as the
post-resize one. `greyscale`/`grayscale` and `tint` both reduce through that
same linear-light luma rather than CIELAB lightness; `modulate` and
`normalise` go through real CIELAB/CIELCh math with a D65 white; and
`toColourspace` rotates primaries in linear light from wherever the image's
primaries currently are — not always from sRGB — so chaining
`.toColourspace('display-p3').toColourspace('srgb')` round-trips the pixels
instead of rotating twice in the same direction.

**`toColourspace` is not a drop-in for sharp's.** sharp's takes libvips
_interpretation_ names (`srgb`, `b-w`, `lab`, `cmyk`, `rgb16`, …) and
measurably **ignores** `'display-p3'` — `AttrAsEnum` falls back to sRGB, so
the bytes come out identical to an untouched image and nothing is tagged.
Maple's method is closer to sharp's `withIccProfile`: it rotates primaries
and tags the file. It takes `'srgb'`, `'display-p3'`/`'p3'` and `'b-w'` (the
greyscale conversion — which is what that name means in sharp too, and the
documented companion to `greyscale()`), and throws by name on any other
interpretation name. Ported code calling `.toColourspace('display-p3')`
therefore gets different — and actually tagged — pixels than it did under
sharp.

Alpha is carried end to end: a 4-channel input, and the alpha item of a decoded
AVIF, survive every op and are written by PNG, WebP and AVIF. JPEG and TIFF have
no alpha channel, so they composite over black — the same thing libvips does —
unless you call `flatten({ background })` first.

```typescript
const badged = await maple(photo)
  .composite([{ input: logoPng, gravity: 'southeast' }])
  .flatten({ background: '#ffffff' })
  .toFormat('jpeg', { quality: 88 })
  .toBuffer();
```

**Op order.** Maple executes ops in the order you call them — the ops list
_is_ the pipeline — with `autoOrient`/`rotate()` always hoisted to run first
regardless of where it appears in the chain. sharp instead applies a fixed
internal order (rotate → resize → composite → flatten → …) no matter how you
call its methods. In practice: `.resize().composite().flatten()` matches
sharp, because that's also sharp's fixed order. `.flatten().resize()` flattens
before resampling — identical to sharp for an opaque source, but the two can
differ slightly at soft/antialiased transparent edges, where flattening
before vs. after the resample blends against a background at a different
resolution. `.composite().resize()` composites the overlay at full size and
then scales the composited result, where sharp always resizes the base first
and composites onto the resized box (and rejects an overlay wider or taller
than the resized base outright); call `.resize()` before `.composite()` if
you want sharp's placement semantics. The remaining geometry ops split
differently: Maple always runs `extract`, `extend`, `rotate(angle)`, `flip`,
`flop` and `trim` at the position where you call them, but sharp only does
that for `extract` — `trim` is pinned to the input stage (it runs before
resize no matter where you write it), and `extend`, `flip`, `flop` and a
non-90° `rotate(angle)` are pinned to run after resize. So `.resize(10, 10, {
fit: 'fill', withoutEnlargement: false }).trim()` on a 5×5 framed source
resizes first in Maple, then trims the already-upscaled result down to 6×6,
where sharp trims the 5×5 source first and resizes the trimmed content up to
10×10 (measured: sharp 10×10, Maple 6×6). `.extend(5).resize(20, 20, { fit: 'fill' })` extends first in Maple,
so 20×20 is the final size, where sharp resizes to 20×20 first and then
extends by 5 on every side (measured: sharp 30×30, Maple 20×20). Call
`.resize()` before `extend`/`flip`/`flop`/`rotate(angle)` and after `trim`
if you want sharp's staging.

Repeated `.resize()` calls are **not** a divergence: sharp has a single
resize stage, so the last call wins, and Maple's `.resize()` drops any
earlier `resize` op for the same reason. Measured on 32x32 noise,
`.resize(16).resize(8)` is byte-identical to `.resize(8)` in both libraries.

The colour ops are fixed stages in sharp too, and this is where call order
bites hardest. Every one of them runs at a fixed point in sharp's pipeline
(`src/pipeline.cc`, line numbers from sharp 0.34.5) while Maple runs it
where you called it. The last column is the measured max per-channel
difference vs sharp on 32x32 colour noise for each order — the "sharp's own
order" figure is what you get by calling the ops in the order sharp would
have applied them, and it is the one to aim for:

| op                           | sharp stage                                   | Maple                                | measured, sharp's own order vs the other one                                                                                                       |
| :--------------------------- | :-------------------------------------------- | :----------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gamma` (in)                 | 364, immediately before resize                | spliced before the first `resize` op | matches (0)                                                                                                                                        |
| `greyscale`                  | 369, after gamma-in, still before resize      | call order                           | `.greyscale().resize(16)` **4**, `.resize(16).greyscale()` **24** (lanczos3; both 1 with `nearest`)                                                |
| `modulate`                   | 625, after resize and composite               | call order                           | `.modulate({saturation:0}).tint(…)` **3**, `.tint(…).modulate({saturation:0})` **151**                                                             |
| `gamma` (out)                | 743, after composite, blur and sharpen        | spliced after that same `resize` op  | `.gamma(3).resize(16).composite(…)` **89** (the composite falls between the pair in sharp; without gamma the same chain is 1)                      |
| `linear`                     | 748, after gamma-out                          | call order                           | `.linear(1.2,-10).negate()` **0**, `.negate().linear(1.2,-10)` **31**                                                                              |
| `normalise`                  | 755, after linear                             | call order                           | `.linear(1.6,-40).normalise()` **1**, `.normalise().linear(1.6,-40)` **42**                                                                        |
| `tint`                       | 781, after normalise                          | call order                           | see `modulate`                                                                                                                                     |
| `toColourspace` + output ICC | 799 / 826, the output stage after every op    | call order                           | `.modulate(…).toColourspace('display-p3')` **1**, `.toColourspace('display-p3').modulate(…)` **21** (vs sharp `.modulate(…).withIccProfile('p3')`) |
| `negate`                     | **840, last of all**, after the ICC transform | call order                           | see `linear`                                                                                                                                       |

The numbers in the last column are the measured max difference on this
README's 32x32 noise fixture specifically, not a property of the op pair
itself — a different fixture gives different magnitudes; treat them as
illustrative of the direction and rough scale of the divergence, not a
budget.

`gamma` is the one op whose position Maple resolves rather than takes
literally, because its whole purpose is to move the resize into a different
encoding. Everything else is call order, so **call the colour ops in the
stage order above** if you are porting a sharp pipeline and want the same
pixels. Resolving the whole op list into sharp's stage order at assembly
time, the way `gamma` already is, is tracked separately.

## Native Core & Linux Support

`@justmaple/maple` connects to `libraw_ffi` via `bun:ffi`.

### Linux Environments (Docker, Server, Cloud)

- **Prebuilt Libc Support**: Supports both `glibc` (Ubuntu 20.04+, Debian 11+, RHEL 8+) and `musl` (Alpine Linux containers).
- **Zero Dependencies**: Pure Rust; dynamically links only the C library itself (`libc`, `libm` and, on glibc, `libpthread`/`libdl`). No C++ runtime (`libstdc++`) or libvips installation required. The publish pipeline audits this with `readelf` on every Linux build.
- **SIMD Hardware Dispatch**: Runtime CPU feature detection enables AVX-512 and AVX2+FMA on x86_64, and NEON on aarch64 (AWS Graviton, Apple Silicon).
- **Library Discovery Ladder**:
  1. `process.env.MAPLE_NATIVE_LIB` (explicit override; the Docker image sets this)
  2. A binary built from the monorepo checkout (`raw-pipeline/target/**/release/`, `src/api/native/`) — only present when running inside the repo
  3. The installed `@justmaple/maple-<platform>` package
  4. Local `./native/libraw_ffi.so`, container path `/app/native/libraw_ffi.so`
  5. System library paths (`/usr/local/lib/`, `/usr/lib/`)

To compile the native Linux shared library:

```bash
# In the raw-pipeline directory
cargo build --release -p raw-ffi --target x86_64-unknown-linux-gnu
# Or using the build script:
./src/api/scripts/build-raw-ffi.sh linux
```

## Performance Goals

Maple is engineered to meet strict latency and throughput budgets:

| Metric                      | Target                                 | Budget             |
| :-------------------------- | :------------------------------------- | :----------------- |
| **CLI Warm Startup**        | `npx maple --version`                  | ≤ 42 ms            |
| **Metadata Probe**          | EXIF & dimension header inspect        | ≤ 0.45 ms          |
| **SIMD Resampling**         | 4K → 512px Thumb (`fast_image_resize`) | ≤ 4.4 ms           |
| **In-Memory Transcoding**   | 1280px AVIF → JPEG 90 (VLM describe)   | ≤ 9.2 ms           |
| **ML Tensor Preparation**   | 4K → 640×640 NCHW float32 (SCRFD face) | ≤ 4.8 ms           |
| **Full RAW Develop**        | 24MP Sony A7 III to full JPEG          | ≤ 80 ms            |
| **Full RAW Develop**        | 100MP Hasselblad L3D-100c              | ≤ 220 ms           |
| **Batch Export Throughput** | Multi-core 8-core rendering            | ≥ 150 MP / sec     |
| **Batch Thumbnailing**      | Multi-core 512px AVIF generation       | ≥ 120 images / sec |
| **Memory RSS Ceiling**      | Peak RAM during 100MP RAW develop      | ≤ 450 MB           |
