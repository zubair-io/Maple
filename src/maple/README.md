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

| sharp method                                       | Maple | Notes                                                                                                                                                                                                                                                                                                                                                                    |
| :------------------------------------------------- | :---- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extract()`                                        | ✅    | `{ left, top, width, height }`                                                                                                                                                                                                                                                                                                                                           |
| `extend()`                                         | ✅    | background only — `extendWith: 'copy' \| 'repeat' \| 'mirror'` throws by name                                                                                                                                                                                                                                                                                            |
| `rotate(angle)`                                    | ✅    | 90/180/270 exact; other angles bilinear into the rotated box                                                                                                                                                                                                                                                                                                             |
| `rotate()`                                         | ✅    | no argument = EXIF auto-orient, as in sharp                                                                                                                                                                                                                                                                                                                              |
| `flip()`                                           | ✅    |                                                                                                                                                                                                                                                                                                                                                                          |
| `flop()`                                           | ✅    |                                                                                                                                                                                                                                                                                                                                                                          |
| `trim()`                                           | ✅    | `{ background, threshold, margin }` — `margin` is a Maple extension, not in sharp's `trim` options; `lineArt` throws by name; an all-background image is returned unchanged, matching sharp                                                                                                                                                                              |
| `composite()`                                      | ✅    | `over`, `multiply`, `screen`, `add`, `darken`, `lighten`, `dest-in`, `dest-out`                                                                                                                                                                                                                                                                                          |
| `flatten()`                                        | ✅    | background as `{r,g,b}` or `#rrggbb`                                                                                                                                                                                                                                                                                                                                     |
| `ensureAlpha()`                                    | ✅    |                                                                                                                                                                                                                                                                                                                                                                          |
| `removeAlpha()`                                    | ✅    |                                                                                                                                                                                                                                                                                                                                                                          |
| `metadata()`       | ✅    | plus `hasAlpha`/`hasProfile`/`space`/`depth`/`density`/`size`/`icc`/`exif`/`xmp`; `exif` comes back in the form its container stores it, byte-identical to sharp (see below)             |
| `stats()`          | ✅    | per-channel moments, `isOpaque`, `entropy`, `sharpness`, `dominant`                                                                                                                      |
| `keepMetadata()`   | ✅    | never fails: each container keeps every field it can carry and drops the rest silently, as sharp does — JPEG and PNG keep all four, WebP all but XMP, TIFF ICC only, AVIF EXIF only      |
| `withMetadata()`   | ✅    | `{orientation, density}`, same validation as sharp; `autoOrient`/`.rotate()` neutralises a kept Orientation tag to `1` unless you also pass an explicit `orientation`                    |
| `withExif()`       | ⚠️    | takes a raw EXIF `Buffer`, not sharp's IFD object (`{IFD0: {...}}`) — rejected by name (#3588); not yet supported when developing a RAW file (`.jpg`/etc. from a `.dng` and friends)     |
| `withIccProfile()` | ⚠️    | TAGS without converting, unlike sharp: `'srgb'`, a path, or raw bytes; `'p3'` and `'cmyk'` rejected by name; no ICC on AVIF output (#3580); not yet supported when developing a RAW file |
| `withXmp()`        | ⚠️    | JPEG and PNG only — WebP, TIFF and AVIF have no XMP writer, and asking for one explicitly is a named error (see below); not yet supported when developing a RAW file                     |
| `blur()`                                           | ✅    | no argument = 3x3 box; a sigma = separable Gaussian. Byte-identical to sharp                                                                                                                                                                                                                                                                                             |
| `sharpen()`                                        | ✅    | argument-less kernel and the `{sigma}` Lab mask path both byte-identical                                                                                                                                                                                                                                                                                                 |
| `median()`                                         | ✅    | integer window 1..1000, no wider than the image, every band. Byte-identical                                                                                                                                                                                                                                                                                              |
| `threshold()`                                      | ✅    | literal-`true` `{ greyscale }` rule; libvips' own luma; `0`/`false` is a no-op                                                                                                                                                                                                                                                                                           |
| `convolve()`                                       | ✅    | any kernel; integer `scale` (default kernel sum) and `offset`, non-integers rejected by name                                                                                                                                                                                                                                                                             |
| `greyscale()` / `grayscale()`                      | ✅    | Rec.709 luma reduced in linear light through libvips' own transfer lookups, three identical channels. Byte-identical to sharp over a 14,080-colour sweep of the sRGB cube                                                                                                                                                                                                |
| `gamma()`                                          | ✅    | an assembly-time pair around the `resize` op: `gamma` itself before it, `1/gammaOut` after; residual ≤1 — a single-code artefact at input 255 for `gammaOut` 1/1.5 and 1/3, where libvips' own float chain returns 254 rather than 255                                                                                                                                   |
| `linear()`                                         | ✅    | scalar or per-channel `a` and `b`, on the encoded samples; a 4-element vector is rejected by name (sharp applies the 4th element to alpha on RGBA input — this op never touches alpha)                                                                                                                                                                                   |
| `negate()`                                         | ✅    | `{ alpha: false }` spares the alpha channel                                                                                                                                                                                                                                                                                                                              |
| `normalise()` / `normalize()`                      | ✅    | percentile stretch of CIELAB L\*, chroma preserved                                                                                                                                                                                                                                                                                                                       |
| `modulate()`                                       | ✅    | brightness/lightness on L\*, saturation on C\*, hue rotation, in CIELCh                                                                                                                                                                                                                                                                                                  |
| `tint()`                                           | ✅    | linear-light luma as `greyscale`, then a\*/b\* from the tint; colour as `{r,g,b}` or `#rgb`/`#rrggbb`/`#rrggbbaa` (no CSS names); residual max 3, from the composed CIELAB matrices (#3581)                                                                                                                                                                              |
| `toColourspace()` / `toColorspace()`               | ⚠️    | takes `srgb`, `display-p3`/`p3` and `b-w`; other libvips interpretation names error by name. Closer to sharp's `withIccProfile` than to its `toColourspace`, which takes interpretation names and silently ignores `display-p3`. `'b-w'` is byte-identical to sharp on the same sweep as `greyscale()` above, but its raw output is 3 identical bands where sharp's is 1 |
| `toFormat('avif')` + `toColourspace('display-p3')` | ❌    | rejected by name. This crate does not write AVIF's `colr` box yet, and an untagged P3 AVIF reads back as sRGB and double-stretches; sharp tags it. Export sRGB, or use JPEG/PNG/TIFF/WebP for a P3 deliverable                                                                                                                                                           |
| `resize({ fit })`                                  | ✅\*  | `cover`, `contain`, `fill`, `inside`, `outside`; `contain` letterboxes with `background`                                                                                                                                                                                                                                                                                 |
| `resize({ position })`                             | ✅    | nine gravities and eight `position` spellings; `entropy`/`attention` throw by name                                                                                                                                                                                                                                                                                       |
| `resize({ kernel })`                               | ✅    | `nearest`, `linear`, `cubic`, `mitchell`, `lanczos2`, `lanczos3`; `filter` is an alias; `mks2013`/`mks2021` throw by name                                                                                                                                                                                                                                                |
| `resize({ withoutReduction })`                     | ✅    | `withoutReduction` wins when both clamps are set, as in sharp                                                                                                                                                                                                                                                                                                            |
| `jpeg()`                                           | ✅    | `quality`, `progressive`, `chromaSubsampling`, `optimiseCoding`/`optimizeCoding`; `mozjpeg`, trellis quantisation (either spelling), `overshootDeringing`, `optimiseScans`/`optimizeScans`, `quantisationTable`/`quantizationTable` and `force` throw                                                                                                                    |
| `png()`                                            | ✅    | `compressionLevel`, `adaptiveFiltering`, `palette`, `colours`/`colors`, `dither` (each of those last three implies `palette: true`, as in sharp); `progressive` (Adam7), `quality`, `effort` and `force` throw                                                                                                                                                           |
| `webp()`                                           | ⚠️    | lossless + alpha only — `quality`, `{ lossless: false }`, the animation-only knobs (`smartDeblock`/`loop`/`delay`/`minSize`/`mixed`) and `force` all throw                                                                                                                                                                                                               |
| `avif()`                                           | ⚠️    | `quality`, `effort`, `bitdepth` (8 default, 10; sharp's 12 throws); `chromaSubsampling` and `lossless` only take their defaults (`'4:4:4'` / `false`) — the other value throws; `force` throws; `tune` isn't a real sharp option and is a harmless no-op                                                                                                                 |
| `tiff()`                                           | ✅    | `compression` (none/lzw/deflate/packbits — sharp's own `'jpeg'` default throws), `bitdepth` 8/16, `predictor` (`'horizontal'`/`'none'`; `'float'` throws); tiled/pyramid/bigtiff/resolution/`quality` options throw                                                                                                                                                      |

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
post-resize one. `greyscale`/`grayscale`, `toColourspace('b-w')`, `tint`'s
luminance step and `threshold`'s greyscale decision all reduce through ONE
linear-light luma rather than CIELAB lightness — `vips_col_scRGB2BW` stage
for stage, sharing libvips' own transfer-curve lookups with the Lab chain, so
it is byte-exact rather than merely close (a luma of our own was within a
code but disagreed on 2,308 of 14,080 colours, and through `threshold` one
code flips a whole sample between 0 and 255 — #3572); `modulate` and
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

Every ✅ on the five filters means **byte-identical**: a measured maximum
absolute per-sample difference of **0** against sharp 0.34.5 / libvips
8.17.3, raw pixels in and raw pixels out. The cases measured are `blur` at
sigma 0.5, 1.5, 3 and 10 plus the no-argument box, `median(3)` and
`median(5)`, `threshold` at 100, 128 and 200, `convolve` with a 3x3 sharpen
kernel, a 5x5 box and an all-`-1` kernel with no scale, and `sharpen` both
argument-less and with `{sigma}` — each on 32x32 RGB noise, on a 32x32 RGBA
fixture with a fully transparent quadrant, a 128-alpha quadrant and an
opaque half, and on uniform-alpha RGBA at 255, 200, 128, 64, 16 and 3.
Chains were measured too (`median(3).blur(1.5)`, `blur(1.5).sharpen()`,
`blur(1.5).convolve(box)`, `threshold(128).blur(1.5)`), as were an 8x1
double ramp where every pixel sits at a different partial alpha and an 8x4
fixture that is half opaque and half fully transparent.

Getting there meant following libvips rather than the textbook in three
places, and each is measurable on its own: `blur(sigma)` is `vips_convsep`
at integer precision, two byte passes with libvips' fixed-point mask
arithmetic and its own vector/scalar path selection, not one float pass;
`convolve`, `blur()` and the argument-less `sharpen()` are `vips_conv` at
its default **float** precision, so nothing is rounded or clamped inside
them and the only quantisation is a single truncating cast at the end; and
`sharpen({sigma})` converts through `vips_colourspace(LABS)`, whose round
trip is an exact identity where an approximate CIELAB pair is not — on a
premultiplied image the unpremultiply amplifies a single code of error by
`255/alpha`, which was worth 85 levels at alpha 3.

sharp's deprecated boolean forms work here too, and mean what they mean
there: `blur(true)`/`sharpen(true)` are the mild no-argument paths,
`blur(false)`/`sharpen(false)` do nothing, and `threshold(true)` is 128 while
`threshold(false)` is 0. **A threshold of 0 is a no-op**, not "whiten
everything" — sharp gates the whole stage on `threshold != 0`, so
`threshold(0)` returns the image untouched. `median(size)` is refused when
the window is wider or taller than the image, as `vips_rank` refuses it
("window too large"); clamp-to-edge would have produced a result, which is
why it needs its own check.

Argument validation is sharp's, by name, before anything reaches the native
core: `blur(NaN)`, `blur({})`, `sharpen({ m1: 3 })` (no `sigma`),
`median(3.5)` and `threshold(300)` all throw with the offending field named.
`sharpen(sigma)`, sharp's deprecated positional form, is accepted like
`blur(sigma)` — with one narrowing, since Maple applies the object form's
0.000001-10 sigma domain to both where sharp's positional form allows up to 10000. On a RAW input the develop pipeline runs instead of the bitmap recipe,
so any op that path cannot carry out throws by name rather than being
silently dropped. It carries out exactly two: `resize`, read back as a
long-edge limit, and `toColourspace('srgb'|'display-p3'|'p3')`, which is the
export space (the same thing Tier 1's `colorSpace()` sets).
`toColourspace('b-w')` is not one of them — it is the greyscale conversion,
and the develop pipeline has no greyscale stage.

Two behaviours worth knowing as a caller, both of them sharp's rather than
Maple's: `blur(sigma)` is an **exact no-op** for every sigma up to 0.557,
because libvips truncates the Gaussian mask at 20% of its peak amplitude and
that leaves a 1x1 mask; and on an image with alpha, `blur`, `convolve` and
`sharpen` premultiply, so a partial-alpha value can come back one code
different even where the filter itself changed nothing (a flat
`(80, 80, 80, 200)` field comes back `(79, 79, 79, 200)` from sharp too,
while `median` — which does not premultiply — leaves it at 80). A third,
smaller one: libvips' integer Gaussian does not always have unit gain, so at
sigma 3 a flat field comes back about 0.8% brighter (200 -> 202, 254 -> 255)
in both engines.

Alpha is carried end to end: a 4-channel input, and the alpha item of a decoded
AVIF, survive every op and are written by PNG, WebP, AVIF and TIFF (via an
`ExtraSamples` tag on the options path `.tiff()` drives). JPEG has no alpha
channel, so it composites over black — the same thing libvips does — unless
you call `flatten({ background })` first.

**Per-format options on a RAW develop input.** A RAW file, an `.xmp()`
sidecar or a `.recipe()` routes through the RAW development pipeline, whose
export surface is container + `quality` + colourspace + long-edge cap. So
`maple('photo.dng').jpeg({ quality: 80 })` works, and any other per-format
option — `progressive`, `chromaSubsampling`, `palette`, `compression`,
`effort`, … — throws by name rather than being quietly ignored (see #3579).
Develop to a bitmap first and re-encode it if you need them.

`.quality()` and the per-format methods are last-call-wins in both
directions: `.jpeg().quality(30)` encodes at 30, while `.quality(30).jpeg()`
encodes at `.jpeg()`'s own default of 80. Likewise `.toFormat()` naming a
different container than an earlier `.jpeg()`/`.png()`/… discards that call's
options, and naming the same container keeps them.

On a RAW develop input specifically, calling `.jpeg()`/`.avif()` also sets the
export `quality` to that format's own sharp-matched default (80 / 50) — a bare
`maple('photo.dng').toFile('x.jpg')`, with no `.jpeg()`/`.quality()` call at
all, uses the builder's own long-standing default of 92 instead.

**JPEG is not mozjpeg.** Maple encodes JPEG with the pure-Rust `jpeg-encoder`
crate — progressive scans, 4:2:0/4:4:4 chroma and optimised Huffman tables, but
no trellis quantisation. Measured against mozjpeg at matched quality
(`bun run scripts/bench-jpeg-size.ts <photo>`), files come out larger: worst
case **+45.4%** at quality 75, narrowing to **+14–17%** at quality 90. Closing
that gap would mean linking a C library, which the Linux zero-dependency build
audit forbids.

**AVIF writes 8-bit by default, and 8 is the interoperable choice.**
`avif({ bitdepth: 10 })` produces a genuine 10-bit AV1 bitstream, but
libheif's prebuilt decoders — sharp's included — cannot read one at all, so
`bitdepth` defaults to `8` (as it does in sharp) and every reader in the wild
can decode the output. sharp's third value, `12`, throws: Maple's `ravif`
encoder has no 12-bit path.

**PNG `compressionLevel` collapses onto three zlib tiers.** The pure-Rust
`png` encoder exposes fastest / default / best, not ten levels, so sharp's
0-9 maps as `0` → zlib 1, `1-6` → zlib 6, `7-9` → zlib 9. Within a tier the
number is a no-op: levels 7, 8 and 9 produce byte-identical files, as do 1
through 6. The split is chosen so sharp's own default of `6` means zlib 6 —
asking for the default does not quietly buy you the slowest setting.

**PNG palette output is always 8-bit `PLTE`.** `colours`/`colors`/`dither`
imply `palette: true` just as they do in sharp, and the palette is capped at
256 entries — but Maple always writes bit depth 8, where libvips derives 1, 2
or 4 from the colour count. Measured on a 6-colour flat image: `png({ colours:
4 })` gives Maple 137 B at depth 8 against sharp's 138 B at depth 2 — the
depth gap is real, but it costs one byte, not a meaningfully larger file.

**WebP is lossless only.** No pure-Rust lossy WebP encoder exists, so
`webp({ lossless: false })` throws rather than silently handing back a much
larger lossless file. Use `avif()` when you want a small lossy file.

**TIFF `compression` defaults to `'lzw'`, not sharp's `'jpeg'`.** sharp's
default TIFF compressor is JPEG-in-TIFF; Maple has no JPEG-in-TIFF encoder (the
`tiff` crate this pipeline drives directly supports `none`/`lzw`/`deflate`/
`packbits` only), so `.tiff()` defaults to `'lzw'` instead and rejects
`compression: 'jpeg'` by name rather than silently falling back. `tile`,
`pyramid`, `bigtiff` and the resolution/quality options with no lossless
encoder to apply them to (`quality`, `tileWidth`, `tileHeight`,
`resolutionUnit`, `xres`, `yres`, `miniswhite`) are rejected the same way.
**TIFF `bitdepth` shares sharp's name but not its domain.** Maple accepts `8`
(default) and `16`; sharp accepts `1`, `2`, `4` and `8`, and reaches 16-bit
TIFF through `toColourspace('rgb16')` instead. So `1`/`2`/`4` throw here and
`16` is a Maple extension rather than parity. Maple's widening is `v * 257`,
the exact full-scale map from [0, 255] to [0, 65535] (hand-parsed strip
bytes: `20, 20, 20, 4, 1, 1` → `5140, 5140, 5140, 1028, 257, 257`); libvips'
`rgb16` gives `5120, 5120, 5120, 1024, 511, 511`, roughly ×256 with
rounding.

`predictor` takes sharp's string form (`'horizontal'` default, `'none'`);
`'float'` is a real sharp value the `tiff` crate cannot produce and is also a
named rejection. It is a request rather than a guarantee, and is dropped in
two cases — both of which libvips also drops it in:

- **`compression: 'none'` or `'packbits'`.** TIFF defines tag 317 only for
  LZW and Deflate; libtiff ignores it elsewhere and reads the differenced
  bytes back as pixels, so writing it there would corrupt the image for every
  reader. `sharp().tiff({ compression: 'none' })` omits the tag for the same
  reason.
- **A raster with an alpha channel.** The `tiff` crate's horizontal
  differencing corrupts the extra alpha sample's stride (see
  `raster_encode_tiff.rs`'s module doc for the full explanation).

**Metadata and RAW files.** `keepMetadata()`/`withMetadata()`/`withExif()`/
`withIccProfile()`/`withXmp()` only affect the bitmap recipe pipeline today —
calling any of them before developing an actual RAW file (a `.dng`/etc. path,
or any `.xmp()`/`.recipe()` input) returns/throws a named
`"<method> is not supported when developing a RAW file yet — see #3507"`
error rather than silently dropping the request (#3507).

**Metadata capability matrix.** Which blocks each output container's own
encoder can actually carry — not a policy choice, a limit of the underlying
encoder crate:

| Container | ICC | EXIF | XMP | Density |
| :-------- | :-- | :--- | :-- | :------ |
| JPEG      | yes | yes  | yes | yes     |
| PNG       | yes | yes  | yes | yes     |
| WebP      | yes | yes  | no  | no      |
| TIFF      | yes | no   | no  | no      |
| AVIF      | no  | yes  | no  | no      |

Naming a field a container's encoder can't carry — an explicit `withExif()`,
`withIccProfile()`, `withXmp()` or `withMetadata({ density })` — is a named
error at encode time (e.g. `"TIFF cannot embed EXIF"`), not a silent no-op.

A field you did **not** name is dropped silently instead, which is what sharp
does. `keepMetadata()` and `withMetadata()` sweep up every block the input
carries, so holding the output container to blocks you never mentioned would
fail calls sharp completes: `keepMetadata()` and
`withMetadata({ orientation })` both succeed on all five containers, each
writing what it can carry. The same goes for the default sRGB profile
`keepMetadata()` adds when the input has none, and for the EXIF block
`withMetadata({ orientation })` synthesises to hold the value — neither is
something you asked for, so neither fails a container.

Extending this table — WebP/TIFF/AVIF XMP, AVIF ICC, TIFF EXIF — is real
follow-up work in the underlying `image`/`avif-serialize` crates; AVIF's ICC
gap specifically is tracked as #3580. Where an encoder falls short of sharp,
the content differs even though the call succeeds: a kept XMP packet is
absent from WebP, TIFF and AVIF output, and a TIFF carries neither EXIF nor
an orientation tag.

**Reading metadata back.** `metadata().exif` is the block exactly as its
container stores it — `Exif\0\0` + TIFF header for JPEG, WebP and AVIF, the
bare TIFF header for PNG, and absent for a TIFF, whose IFD0 _is_ its EXIF.
That is byte-for-byte what sharp returns for the same input. Internally every
block is canonicalised to its TIFF header, so a cross-container
`keepMetadata()` (a WebP or AVIF source to JPEG output) writes a block a
reader can parse, and `withExif()` accepts either form.

`metadata().density` follows libvips too: the EXIF `XResolution` wins over a
JFIF or `pHYs` value, a JPEG that states no resolution reports 72, the value
is rounded to a whole number, and anything at or below 25.4 dpi (libvips' own
1 px/mm default) is reported as no density at all. WebP and AVIF never report
one. `withMetadata({ density })` writes the EXIF resolution as well as the
container's own field, so it survives a `keepMetadata()` that brought a
different one along.

**Orientation.** `.rotate()`/`autoOrient` honours the EXIF Orientation
whatever container it is in: a JPEG's APP1, a PNG `eXIf` chunk, a WebP `EXIF`
chunk or a TIFF's own IFD0.

`metadata().orientation` is `undefined` when the container declares none — no
EXIF block, or a block with no Orientation entry — rather than `1`, which is
what sharp reports in that state. A TIFF is the exception and reports `1`
either way, because libvips' TIFF loader always states an orientation;
measured across all five containers, with an orientation of 1, an orientation
of 6, no EXIF block at all, and an EXIF block whose Orientation entry was
removed.

An AVIF is the other exception, and `metadata().orientation` is `undefined`
for one however it was written. Its `irot`/`imir` transform properties are a transform
of the **pixels**, not metadata, so decoding applies them, exactly as libheif
(and therefore sharp) does: a 24×16 AVIF with `irot 3` decodes as the rotated
16×24 image, `metadata()` reports 16×24, and `.rotate()` has nothing further
to do. Its `Exif` item's Orientation tag is not surfaced either, because
libvips does not surface it — and because libvips' own AVIF save writes the
orientation into BOTH the box and the item, so honouring the tag on top of the
baked box would rotate a sharp-written AVIF twice. The tag is still readable
in the `exif` buffer.

Measured against sharp on nine hand-patched AVIFs (`irot` 0..3, `imir` 0/1,
both together, and with and without an `Exif` Orientation): `metadata()`
dimensions and `orientation`, the default output, and `.rotate()`'s output all
match sharp on all nine, pixel for pixel.

**AVIF metadata.** Reading is complete: `metadata()` reports the container's
`irot`/`imir` transform in its dimensions (the transform itself is applied to
the pixels, and `orientation` is `undefined` — see **Orientation** above), and
returns the `Exif` and XMP items. Writing is
EXIF-only: `avif-serialize`, the pure-Rust muxer behind Maple's AVIF encoder,
can write an `Exif` item but has no writer for an ICC `colr` box or an XMP
item (#3580), so an explicit `withIccProfile()` or `withXmp()` on AVIF output
is a named error (`"AVIF cannot embed an ICC profile"` /
`"AVIF cannot embed XMP"`), while the same blocks swept up by
`keepMetadata()` are dropped silently. `withMetadata({ orientation: 6 })
.avif()` writes the value into the `Exif` item, where it stays readable in
`metadata().exif`; the convenience `orientation` field stays `undefined` for
an AVIF, which is what sharp reports too. That is how #3586 closes — matching
sharp: the container transform is baked into the pixels and the EXIF tag is
not surfaced, the same as libvips.

**`stats()` precision.** Two small, known divergences from sharp's own
numbers, both pre-existing and out of scope for this metadata/stats pass:
`entropy` and `sharpness` differ from sharp's own measurements because this
crate's greyscale-luma conversion disagrees with libvips' by ±1 on a minority
of pixels (#3572) — up to 0.06 of a bit of entropy on noise (measured 0.052
on 40×30 RGBA noise, and 4e-8 on an already-grey source, which is what ties
the residual to the luma step); and a
greyscale-plus-alpha (`La8`) PNG or TIFF can report `hasAlpha: true` from
`metadata()` while `stats()` decodes it as fully opaque RGB, because
`decode_raster` currently drops that alpha channel (#3574).

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
internal order (rotate → resize → composite → flatten → … → median →
threshold → blur → convolve → sharpen) no matter how you call its methods.
In practice: `.resize().composite().flatten()` matches sharp, because that's
also sharp's fixed order. `.flatten().resize()` flattens
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

The five filters have their own stage order inside that list — **median →
threshold → blur → convolve → sharpen** — and sharp wraps the whole group in
a single premultiply/unpremultiply pair when the image has alpha. Maple
matches the premultiply part: each run of consecutive filter calls shares one
premultiply, one unpremultiply and one cast back to bytes, so `median` and
`threshold` land inside the sandwich exactly as they do in sharp. It does not
match the reordering. Whenever your call order already agrees with sharp's
stage order the two are byte-identical; when it does not, Maple does what you
wrote. Measured on 32x32 noise: `.threshold(128).blur(1.5)` and
`.blur(1.5).threshold(128)` are byte-identical in sharp and differ by up to
190 in Maple (the first order matches sharp exactly, the second is Maple's own
answer); `.blur(2).sharpen()` versus `.sharpen().blur(2)` is 0 in sharp and up
to 10 in Maple, again with the first order byte-identical. Call them in
sharp's stage order if you want sharp's numbers.

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
