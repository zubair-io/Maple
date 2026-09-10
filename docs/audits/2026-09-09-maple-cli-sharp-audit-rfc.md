# RFC: Maple NPM Package (`@justmaple/maple`), NPX CLI (`npx maple`), and Complete Sharp Elimination

**Status**: Proposed  
**Authors**: Antigravity Pair Programming & Maple Architecture Team  
**Date**: September 9, 2026  
**Target Milestone**: Maple v0.2.0  
**Related Specs & Docs**: `docs/architecture.md`, `docs/pipeline.md`, `docs/export-recipes.md`, `docs/indexer-enrichment.md`

> [!NOTE]
> **Taxonomy & Branding**: **Just Maple** (`justmaple`) is the organization; **Maple** (`maple`) is the product.
> The official package is published to npm as **`@justmaple/maple`** (and aliased as **`maple`**). A single package ships both the programmatic Node/Bun API (`import { maple } from '@justmaple/maple'`) and the command-line interface (`npx maple`), preventing package fragmentation.

---

## 1. Executive Summary

Maple's image processing core (`raw-core`) is a professional-grade, scene-referred engine written in pure Rust with Metal, WebGPU, C-FFI, and WebAssembly bindings. However, the ecosystem has developed an architectural split:

1. **The CLI (`maple-cli`)** is currently a pure Rust developer binary used primarily for color-parity testing and headless RAW development. It requires `cargo run`, accepts only RAW camera files, cannot process standard bitmaps, and cannot be invoked via `npx` in modern JavaScript/TypeScript workflows.
2. **The Server (`src/api`)** depends heavily on **`sharp`** (libvips C++ wrapper) for all non-RAW bitmap processing (thumbnails, previews, orientation correction, format validation, ONNX tensor extraction, video frame resizing, and preview transcoding).
3. **The Export System** is bifurcated: while Maple possesses industry-leading color math and multi-format export recipes (JPEG, PNG, TIFF 16-bit) with embedded ICC color spaces, its Rust core does not decode non-RAW inputs, does not expose general-purpose SIMD resizing, and lacks WebP/AVIF export integration in recipes.

This RFC proposes:

1. **Auditing** all current `maple-cli` capabilities and `sharp` call sites across the codebase.
2. **Closing the functional gaps** in `raw-core` (non-RAW decode, SIMD resampling, WebP/AVIF formats, fast metadata probing, raw RGB tensor extraction).
3. **Introducing `@justmaple/maple`**, an official, zero-C++ dependency, N-API-backed npm package providing unified image processing for both RAW and bitmap formats in Node.js and Bun.
4. **Providing the `npx maple` CLI** directly through the package's bin entry (`maple`), enabling headless CLI image exports, recipe executions, and thumbnailing out of the box.
5. **Completely removing `sharp`** from `src/api`, collapsing duplicate worker pools, eliminating brittle manual `bun:ffi` dylib management, and unifying Maple around its own engine.

---

## 2. Audit: The Current `maple-cli`

### 2.1 Architecture & Implementation

- **Location**: `src/raw-pipeline/maple-cli/`
- **Language & Crates**: Rust, built on `clap`, `serde`, `serde_json`, `tempfile`, and `raw-core` (with optional `maple-pano`).
- **Invocation**: `cargo run --release --bin maple-cli -- <subcommand>`

### 2.2 Subcommands Inventory

| Subcommand              | Arguments                                                                                              | Purpose & Engine Path                                                                                       |
| :---------------------- | :----------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------- |
| `export-recipe`         | `--raw`, `--recipe`, `--params`, `--film-lut-dir`, `--index`                                           | Executes saved `ExportRecipe` JSON against a RAW + XMP. Uses `raw_core::export_recipe::export_with_recipe`. |
| `render`                | `--raw`, `--params`, `--out`, `--format`, `--quality`, `--demosaic`, `--profile`, `--target-primaries` | Renders a single RAW file under XMP adjustments to JPEG, PNG, or TIFF.                                      |
| `batch`                 | `--manifest`, `--out-dir`, `--cases-filter`, `--demosaic`, `--profile`                                 | Batch runner for the end-to-end perceptual parity gate (`test_color_pipeline.sh`).                          |
| `diff`                  | `candidate`, `reference`, `--budget`, `--source-primaries`                                             | Evaluates CIEDE2000 ΔE between candidate and reference images.                                              |
| `inspect`               | `path`                                                                                                 | Dumps parsed XMP adjustments or camera RAW metadata.                                                        |
| `tile`                  | `--raw`, `--params`, `--src-x/y/w/h`, `--out-w/h`, `--out`                                             | Renders a sub-region tile for deep zoom validation.                                                         |
| `extract-preview`       | `--raw`, `--out`                                                                                       | Extracts the camera-embedded JPEG preview from a RAW file.                                                  |
| `auto-tone`             | `--raw`, `--params`                                                                                    | Computes Auto Tone exposure/contrast parameters.                                                            |
| `auto-adjustments`      | `--raw`                                                                                                | Computes all 8 Auto slider parameters from a RAW preview probe.                                             |
| `synthetic`             | `--kind`, `--primary`, `--hue`, `--ev`, `--out`                                                        | Generates synthetic patches and ramps for banding/halo testing.                                             |
| `fit-acr` / `fit-auto2` | Sweep chart inputs                                                                                     | Fits structured ACR-match models and Auto Profile curves.                                                   |
| `auto-tail-ramp`        | `--raw`, `--out-dir`                                                                                   | Generates diagnostic OpenEXR stage dumps.                                                                   |
| `film-pack`             | `--cube-dir`, `--out-dir`, `--catalog-out`                                                             | Ingests `.cube` Resolve LUTs into compressed `.mlut` binary packs.                                          |
| `transcode-dcp`         | `--src`, `--out`, `--out-pool`                                                                         | Transcodes v1 DCP profiles to v3 split layout.                                                              |
| `pano`                  | Pano subcommands                                                                                       | Stitching operator surface for multi-frame panoramas.                                                       |

### 2.3 Limitations of `maple-cli` Today

1. **Strictly RAW-Only**: Every rendering entry point (`render`, `export-recipe`, `tile`) invokes `raw_core::decode::decode_bytes()`, which directly calls `rawler::decode()`. Providing a non-RAW file (JPEG, PNG, WebP, AVIF, HEIC, TIFF) fails immediately with a decode error.
2. **Not in the NPM Ecosystem**: Developers and CI scripts outside Rust cannot run `npx maple export ...`. It requires a full Rust toolchain (`cargo`, `rustc` 1.83+) and manual compilation.
3. **No General Bitmap Utilities**: Cannot resize, crop, rotate, transcode, or inspect arbitrary non-RAW images.
4. **File-Bound I/O**: Operates strictly on disk paths with atomic `.tmp` renames; cannot pipe image streams or return memory buffers for use in scripts.

---

## 3. Audit: Where `sharp` Is Used

`sharp` is used **exclusively on the Self Hosted server (`src/api`)**. It is not used in Apple (`src/apple`), Web (`src/web`), or Cloudflare (`src/cloudflare`).

### 3.1 Call Sites in `src/api`

```
src/api/
├── package.json                   # "sharp": "^0.34.5"
├── scripts/
│   └── check-worker-isolation.sh  # Enforces sharp is only imported in child processes
├── src/
│   ├── thumbs/
│   │   ├── render.ts              # PRIMARY: 512px AVIF thumbnails & 1280px JPEG previews
│   │   ├── avif-checks.ts         # Validation: container format, dimensions, orientation, pixel decode
│   │   └── apply-orientation.ts   # In-place EXIF orientation normalization
│   ├── video/
│   │   └── frame-extract.ts       # ffmpeg raw frame -> JPEG resizing & encoding
│   ├── enrichment/
│   │   └── face-detector.ts       # ONNX prep: decode -> sRGB -> strip alpha -> raw RGB tensor
│   └── workers/stages/
│       ├── describe.ts            # Transcode 1280px AVIF preview -> JPEG buffer for VLM
│       └── describe.fixtures.ts   # Generates test AVIF buffers
```

### 3.2 Detailed Functional Breakdown of `sharp` Usage

#### 1. Thumbnail & Preview Rendering (`src/api/src/thumbs/render.ts`)

- **Formats handled**: JPEG, PNG, WebP, TIFF, AVIF, HEIC/HEIF (pre-converted to JPEG by `heic-convert`), PSD/PSB (pre-decoded to RGBA by `ag-psd`), and HDR (pre-decoded by `hdr`).
- **Operations**:
  - `.rotate()` to honour EXIF orientation.
  - `.resize(sizePx, sizePx, { fit: 'inside', withoutEnlargement: true })` (512px for grid thumbnails, 1280px for VLM previews).
  - `.avif({ quality: 55, effort: 4 })` for thumbnails.
  - `.jpeg({ quality, mozjpeg: true })` for describe previews.
  - Raw raster ingestion via `sharp(raster.data, { raw: { width, height, channels: 4 } })`.

#### 2. AVIF Output Validation (`src/api/src/thumbs/avif-checks.ts`)

- **Operations**:
  - `image.metadata()` checks container format (`meta.format === 'heif' && meta.compression === 'av1'`).
  - Dimension bounds check (`DIMENSION_TOLERANCE_PX`).
  - Orientation tag verification (must be stripped / 1).
  - Color space verification (must be sRGB, untagged ICC).
  - Full pixel decode integrity check via `image.raw().toBuffer()` to catch truncated files where headers are valid but `mdat` payloads are corrupt.

#### 3. In-Place Orientation Normalization (`src/api/src/thumbs/apply-orientation.ts`)

- **Operations**:
  - Checks `meta.orientation`. If > 1, physically bakes rotation into pixels with `.rotate()` and re-encodes to AVIF.

#### 4. Video Frame Pre-Processing (`src/api/src/video/frame-extract.ts`)

- **Operations**:
  - Receives temporary JPEG dumps from ffmpeg.
  - Resizes to `MODEL_FRAME_MAX_DIMENSION` and re-encodes as mozjpeg for VLM video understanding.

#### 5. Face Detection & Recognition Pre-Processing (`src/api/src/enrichment/face-detector.ts`)

- **Operations**:
  - `jpegToInputTensor()`: Reads image bytes, gets dimensions, resizes to 640×640 (`fit: 'fill'`), converts to sRGB (`.toColourspace('srgb')`), strips alpha (`.removeAlpha()`), extracts raw interleaved bytes via `.raw().toBuffer()`, and reshapes to an NCHW `Float32Array` tensor for the SCRFD face detector.
  - `alignFaceCrop()`: Extracts raw RGB pixel buffers for 5-point landmark similarity transforms (Umeyama SVD) and bilinear sampling for ArcFace embeddings.

#### 6. In-Memory VLM Describe Transcoding (`src/api/src/workers/stages/describe.ts`)

- **Operations**:
  - In-memory buffer transcoding: `sharp(avifBytes).jpeg({ quality: 90, mozjpeg: true }).toBuffer()` because upstream VLM endpoints (Qwen2.5-VL, OpenAI) require `image/jpeg`.

### 3.3 Architectural Liabilities of `sharp` on the Server

- **Heavy C++ Dependencies**: Sharp bundles `libvips`, `libjpeg-turbo`, `libpng`, `libwebp`, `libspng`, `libheif`, and `libhwy`.
- **Process Instability & GC Hazards**: Under Bun, native C++ thread-pool memory combined with Bun's JSC garbage collector historically triggered memory leaks and segfaults.
- **Complex Isolation Workarounds**: Forced the creation of `check-worker-isolation.sh` and child process pools (`imgdecode.child.ts`, `face-pool.child.ts`) to ensure that a libvips crash does not terminate the HTTP server.
- **Large Distribution Footprint**: Downloads architecture-specific binaries (`@img/sharp-darwin-*`, `@img/sharp-linux-*`, `@img/sharp-libvips-*`) that take up ~120 MB in `node_modules`.

---

## 4. Gap Analysis: Why Can't We Use Maple Only Right Now?

Maple already has world-class export capabilities in `raw-core::export` (JPEG with mozjpeg-quality quantization, 16-bit TIFF, PNG, and AVIF via `raw-core::avif`). However, **six specific technical gaps** currently prevent Maple from completely replacing Sharp:

| Capability Required by Server | Current State in Maple Core                   |
| :---------------------------- | :-------------------------------------------- |
| 1. Non-RAW Decode             | Fails. `decode_bytes()` only supports rawler. |
| 2. Arbitrary SIMD Resizing    | Pipeline only resizes RAW at demosaic time.   |
| 3. AVIF / WebP in Recipes     | Recipes only support JPEG, PNG, TIFF 16.      |
| 4. Fast Metadata Probing      | `read_exif` only reads TIFF/RAW EXIF tags.    |
| 5. Raw Buffer / Tensor Export | FFI only outputs encoded image files.         |
| 6. In-Memory Transcoding      | FFI is file-to-file only (to dodge GC bugs).  |

### Detailed Gap Breakdown:

1. **Non-RAW Input Decoding in Rust Core**:
   - `raw-core` has no non-RAW decode path.
   - In Web, this was bypassed by using the browser's `createImageBitmap()` + Canvas 2D.
   - In Apple, this was bypassed by using `CIImage` / `ImageIO`.
   - On the server, there was no native non-RAW decoder, so `sharp` was imported.
   - **What is missing**: A unified `decode_image(bytes, ext)` in `raw-core` that uses `rawler` for RAW files and the Rust `image` crate (or `zune-jpeg`/`png`/`rav1e`) for bitmap formats.

2. **Standalone SIMD Image Resizing**:
   - Maple only downsizes during RAW develop (early-downsample develop chain for viewport speed).
   - It has no standalone resizer for a 6000×4000 JPEG or PNG to produce a 512px thumb or 640×640 square tensor.
   - **What is missing**: Integration of a high-performance SIMD resizing engine in Rust (such as `fast_image_resize`, which benchmarks faster than libvips/sharp).

3. **Format Support Gaps (AVIF & WebP)**:
   - **AVIF**: `raw-core` has `raw_core::avif::encode` (using `ravif`/`rav1e`), but it is hardcoded to 8-bit sRGB thumbnailing and is **not an option in `ExportFormat` or `ExportRecipe`**.
   - **WebP**: Completely missing across the entire Rust core.
   - **What is missing**: Adding `ExportFormat::Avif` and `ExportFormat::Webp` to `raw-core::export` and `ExportRecipe`.

4. **Fast Metadata & Header Probing**:
   - Sharp inspects image dimensions and EXIF in < 1 ms without allocating or decoding pixel buffers.
   - Maple's `read_exif` only parses TIFF-style EXIF headers from RAW files.
   - **What is missing**: A lightweight `probe_metadata(bytes)` in `raw-core` for all supported formats.

5. **Raw Tensor / Pixel Buffer Extraction for AI/ML**:
   - The SCRFD face detector and ArcFace models need raw pixel arrays (`Float32Array` NCHW or `Uint8Array` interleaved RGB) normalized to [0, 1] or [-1, 1], with alpha removed and converted to sRGB.
   - **What is missing**: An export method that delivers raw pixel slices rather than compressed file bytes.

6. **Memory Safety & In-Memory Transcoding in Node/Bun**:
   - The server previously suffered from Bun FFI pointer double-free segfaults when returning memory buffers from Rust to JavaScript. This forced all FFI operations to be file-based (`renderThumbnailAvifToFile`, `maple_export_recipe_to_file`).
   - **What is missing**: Moving from raw `bun:ffi` to **Node-API (`napi-rs`)**, which provides safe, lifecycle-managed `Buffer` handoffs without disk serialization.

---

## 5. Proposed Architecture: The `@justmaple/maple` Package

We will introduce a unified npm package under the organization: **`@justmaple/maple`** (also accessible via **`maple`** on npm, implemented at `src/maple/`).

Rather than splitting the codebase into artificial sub-packages (e.g. `@justmaple/core` vs `@justmaple/cli`), Maple is treated as the single, cohesive product of the **Just Maple** organization. The package ships both the programmatic Node/Bun API and the top-level `npx maple` CLI binary.

### 5.1 Technology Choice: `napi-rs`

- **Cross-Runtime**: Works natively and identically on **Node.js 18+**, **Bun**, and **Deno**.
- **Memory Safety**: Solves the Bun FFI pointer GC crash once and for all. Native Buffers are created with external allocators and proper garbage collector hooks.
- **Multi-Threaded**: Automatically executes image processing on libuv/worker thread pools without blocking the main JavaScript event loop.
- **Prebuilt Binary Distribution**: Packaged using standard npm platform-specific packages:
  - `@justmaple/maple-darwin-arm64` (macOS Apple Silicon)
  - `@justmaple/maple-darwin-x64` (macOS Intel)
  - `@justmaple/maple-linux-x64-gnu` / `musl` (Linux x86_64)
  - `@justmaple/maple-linux-arm64-gnu` / `musl` (Linux ARM64)
  - `@justmaple/maple-win32-x64-msvc` (Windows x64)

### 5.2 TypeScript API Specification

```typescript
import { maple, exportRecipe, type MapleImage, type ImageMetadata } from '@justmaple/maple';

// 1. Fast Metadata Probing
const meta: ImageMetadata = await maple('photo.cr3').metadata();
// Returns: { width, height, format, hasAlpha, orientation, colorSpace, isRaw }

// 2. Thumbnailing / Preview Generation (Unified for RAW and Bitmap)
await maple('photo.dng')
  .rotate() // Automatically bakes EXIF orientation
  .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
  .toFormat('avif', { quality: 55, speed: 6 })
  .toFile('.maple/thumbs/thumb.avif');

// 3. In-Memory Transcoding (Replaces Sharp in describe.ts)
const jpegBuffer: Buffer = await maple(avifBytes)
  .toFormat('jpeg', { quality: 90, mozjpeg: true })
  .toBuffer();

// 4. ML / ONNX Tensor Preparation (Replaces Sharp in face-detector.ts)
const { data, width, height } = await maple(jpegBytes)
  .resize({ width: 640, height: 640, fit: 'fill' })
  .toColourspace('srgb')
  .removeAlpha()
  .toRawRgb({ layout: 'nchw', normalize: 'insightface' });
// data is a Float32Array ready for onnxruntime tensor creation!

// 5. Full-Resolution Recipe Export
await maple('photo.arw')
  .applyXmp(xmpString)
  .exportRecipe(recipeJsonObject)
  .toFile('deliverable.jpg');
```

---

## 6. Proposed Architecture: The `npx maple` CLI

The `@justmaple/maple` package declares the binary `"maple": "./bin/maple.js"` in its `package.json`, enabling immediate command-line execution without global installation:

### 6.1 Invocation

Users can run commands via npm or Bun:

```bash
npx maple <command> [options]
# Or scoped:
npx @justmaple/maple <command> [options]
# Or with Bun:
bun x maple <command> [options]
```

### 6.2 CLI Subcommands & Flag Specification

#### 1. `npx maple export`

Develops and exports any image (RAW or bitmap) using Maple's color engine:

```bash
# Export a RAW file with XMP adjustments to Display P3 JPEG
npx maple export photo.dng \
  --xmp photo.xmp \
  --out exported.jpg \
  --format jpeg \
  --quality 92 \
  --target-primaries p3 \
  --max-edge 2048

# Export using a saved Maple recipe JSON
npx maple export photo.arw \
  --recipe web-sharing.json \
  --out-dir ./dist/
```

#### 2. `npx maple recipe`

Batch executes a Maple export recipe across multiple files or directories:

```bash
npx maple recipe export-recipe.json ./photos/*.CR3 --out-dir ./exports/
```

#### 3. `npx maple thumb`

Generates optimized thumbnails and previews (replaces server-side ad-hoc scripts):

```bash
npx maple thumb input.raw --out thumb.avif --size 512 --format avif
```

#### 4. `npx maple inspect`

Prints structured technical details for any photo or sidecar:

```bash
npx maple inspect photo.nef
# Outputs: Dimensions, Sensor Type, CFA Pattern, Camera Profile, Embedded Preview dimensions, EXIF tags
```

---

## 7. Migration Plan: Replacing `sharp` in `src/api`

By adopting `@justmaple/maple`, the Maple server eliminates `sharp`, removes duplicate worker pools, and unifies all image processing under the product's own engine.

### Step-by-Step Migration Table

| File in `src/api`             | Current Sharp Call                               | `@justmaple/maple` Replacement                                                                                                 |
| :---------------------------- | :----------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| `thumbs/render.ts`            | `sharp(src).rotate().resize().avif().toBuffer()` | `maple(src).rotate().resize({ width: sizePx, height: sizePx, fit: 'inside' }).toFormat(format, { quality }).toFile(thumbPath)` |
| `thumbs/avif-checks.ts`       | `sharp(file).metadata()` and `.raw().toBuffer()` | `maple(file).metadata()` and `maple(file).validateIntegrity()`                                                                 |
| `thumbs/apply-orientation.ts` | `sharp(path).rotate().avif().toBuffer()`         | `maple(path).normalizeOrientationInPlace()`                                                                                    |
| `video/frame-extract.ts`      | `sharp(raw).resize().jpeg().toBuffer()`          | `maple(raw).resize({ width: maxDim, height: maxDim, fit: 'inside' }).toFormat('jpeg', { quality }).toBuffer()`                 |
| `enrichment/face-detector.ts` | `sharp(buf).resize(640).toColourspace().raw()`   | `maple(buf).resize({ width: 640, height: 640, fit: 'fill' }).toRawRgb({ layout: 'nchw', normalize: 'insightface' })`           |
| `workers/stages/describe.ts`  | `sharp(avif).jpeg({ quality: 90 }).toBuffer()`   | `maple(avif).toFormat('jpeg', { quality: 90 }).toBuffer()`                                                                     |
| `export/export-files.ts`      | `ffiPool().exportRecipeToFile(...)`              | `maple(target.path).applyXmp(target.xmp).exportRecipe(recipe).toFile(tempPath)`                                                |

### Cleanup & Deletions

1. **Remove Dependencies**:
   - Remove `sharp` from `src/api/package.json` and `bun.lock`.
   - Drop transitive `@img/sharp-*` platform dependencies.
2. **Collapse Worker Pools**:
   - Retire `imgdecode-pool.ts` and `imgdecode.child.ts` since `@justmaple/maple` executes safely off the main JS thread via N-API thread pools.
   - Unify `thumbnailer.ts` and `previewer.ts` to call a single unified API instead of branching between `ffiPool()` and `imgdecodePool`.
3. **Remove Shell Build Scripts**:
   - Deprecate `src/api/scripts/build-raw-ffi.sh` and brittle native dylib path sniffing.
   - Simplify `src/api/scripts/check-worker-isolation.sh` to reflect that native Rust memory is managed safely.

---

## 8. Linux Support & Cross-Platform Distribution Matrix

Linux is the primary production deployment target for Maple Self Hosted (Docker containers, headless server nodes, and cloud instances). Full first-class Linux support is therefore an invariant for `@justmaple/maple` and `npx maple`.

### 8.1 Linux Target Matrix

| Target Triple                | Environment                                          | Libc          | Priority         | Notes                                             |
| :--------------------------- | :--------------------------------------------------- | :------------ | :--------------- | :------------------------------------------------ |
| `x86_64-unknown-linux-gnu`   | Ubuntu 20.04+, Debian 11+, RHEL 8+, Arch             | glibc >= 2.28 | Tier 1 (Primary) | Standard cloud VM, server, and Docker deployments |
| `aarch64-unknown-linux-gnu`  | AWS Graviton (2/3/4), Ampere Altra, Raspberry Pi 4/5 | glibc >= 2.28 | Tier 1 (Primary) | ARM64 Linux servers and cloud instances           |
| `x86_64-unknown-linux-musl`  | Alpine Linux x86_64, distroless                      | musl >= 1.2   | Tier 1           | Ultra-lightweight Docker containers (< 80 MB)     |
| `aarch64-unknown-linux-musl` | Alpine Linux ARM64                                   | musl >= 1.2   | Tier 1           | Lightweight ARM64 Docker containers               |

### 8.2 Zero-Dependency Runtime Constraint

Unlike `sharp`—which introduces a fragile dynamic linking dependency tree consisting of `libvips.so`, `libjpeg-turbo.so`, `libpng.so`, `libspng.so`, `libheif.so`, and `libstdc++.so.6`—the Maple native core enforces a **strict zero-external-dependency rule** on Linux:

1. **Pure C/Math Linkage**: The shared library links **only** against `libc.so.6` and `libm.so.6`.
2. **No C++ Standard Library Dependency**: Written in pure Rust; no `libstdc++.so` or `libc++.so` version mismatch issues across disparate Linux distributions.
3. **No GUI or Windowing Dependencies**: Completely headless; zero linkages to X11, Wayland, Mesa, or Fontconfig.
4. **Static Internal Codecs**: All image codecs (JPEG, PNG, TIFF, AVIF via rav1e, WebP) are statically linked into the Rust binary.

### 8.3 SIMD Hardware Dispatch on Linux

Vectorized image math in `raw-core` and the resizer automatically probes hardware capabilities at runtime to guarantee both maximum throughput on modern CPUs and safe execution on older or virtualized environments:

- **x86_64**: Uses dynamic CPUID probing (`std::arch::is_x86_feature_detected!`):
  - **AVX-512 (F, BW, DQ, VL)**: Engaged for 32-bit float demosaicing and 16-bit raster color transforms on modern AMD Zen 4/5 and Intel Xeon Scalable processors.
  - **AVX2 + FMA**: Primary workhorse for high-speed matrix multiplications, Lanczos resampling, and tone-curve evaluations.
  - **SSE4.1**: Baseline fallback for legacy x86_64 hardware.
  - **Scalar**: Fail-safe fallback.
- **aarch64**:
  - **NEON**: Always-on 128-bit vector arithmetic for ARM64.
  - **FP16 & DotProd**: Probed via `getauxval(AT_HWCAP)` for accelerated color matrix multiplies on AWS Graviton 3/4 and Apple Silicon.

### 8.4 Binary Distribution & Packaging Architecture

For seamless execution via `npm install` and `npx maple`, Maple follows the modern optionalDependencies distribution pattern pioneered by `@swc/core` and `esbuild`:

```
@justmaple/
├── maple/                       # Main package (programmatic API + npx maple bin runner)
├── maple-linux-x64-gnu/         # Prebuilt libraw_ffi.so for glibc x86_64
├── maple-linux-x64-musl/        # Prebuilt libraw_ffi.so for musl (Alpine) x86_64
├── maple-linux-arm64-gnu/       # Prebuilt libraw_ffi.so for glibc ARM64
├── maple-linux-arm64-musl/      # Prebuilt libraw_ffi.so for musl ARM64
├── maple-darwin-arm64/          # Prebuilt libraw_ffi.dylib for Apple Silicon
├── maple-darwin-x64/            # Prebuilt libraw_ffi.dylib for Intel Mac
└── maple-win32-x64-msvc/        # Prebuilt raw_ffi.dll for Windows x64
```

**Dynamic Fallback Search Ladder**:
If optional platform packages are excluded (e.g. via `--no-optional` or in monorepo development), `findNativeLib()` executes an exhaustive discovery ladder:

1. `process.env.MAPLE_NATIVE_LIB` (explicit override)
2. `path.join(packageRoot, 'native', libName)` (pre-bundled release)
3. `path.join(process.cwd(), 'native', libName)` (Docker `/app/native`)
4. `/app/native/${libName}` (standard Docker container path)
5. `target/release/${libName}` and target-specific dirs (`target/x86_64-unknown-linux-gnu/release/`)
6. `/usr/local/lib/${libName}` and `/usr/lib/${libName}` (system-installed libraries)

### 8.5 Docker & Containerization Contract

- **Container Multi-Stage Build**: `src/api/Dockerfile` builds `libraw_ffi.so` inside a Rust builder stage and drops it into `/app/native/libraw_ffi.so` in the runtime Bun image.
- **Alpine Support**: Works cleanly on `alpine:3.20` base images without `gcompat` or `libc6-compat` hacks when using the `musl` build slice.
- **Non-Root Execution**: Runs under standard unprivileged container users (`USER bun` / `USER 1000:1000`).

---

## 9. Performance Goals & Benchmarking Contract

In accordance with Maple Principle #5 ("Performance is a product feature"), `@justmaple/maple` and `npx maple` must not only match Sharp's speed on common raster tasks, but drastically outperform it on end-to-end RAW development and batch workflows while enforcing a predictable memory budget.

### 9.1 Quantitative Latency Budgets (P50, P95, P99)

All budgets are measured on reference hardware (Apple M3/M4 Pro or AMD Ryzen 9 7950X / EPYC 8-core Linux VM) against reference corpora (`test-fixtures/raws/`):

| Operation                | Input Specification               | P50 Budget | P95 Budget | P99 Budget | Target vs Sharp                         |
| :----------------------- | :-------------------------------- | :--------- | :--------- | :--------- | :-------------------------------------- |
| **CLI Warm / NPX Start** | `npx maple --version`             | ≤ 30 ms    | ≤ 42 ms    | ≤ 55 ms    | N/A (CLI responsiveness)                |
| **Fast Metadata Probe**  | Non-RAW JPEG/PNG/WebP header      | ≤ 0.25 ms  | ≤ 0.45 ms  | ≤ 0.80 ms  | **1.8× faster than Sharp** (0.8 ms)     |
| **Preview Extraction**   | 45MP Nikon Z7 / 100MP Hasselblad  | ≤ 8.0 ms   | ≤ 12.0 ms  | ≤ 18.0 ms  | **Instantaneous** (Rust parser)         |
| **Bitmap SIMD Resize**   | 4K (3840×2160) → 512px Thumb      | ≤ 3.2 ms   | ≤ 4.4 ms   | ≤ 6.0 ms   | **1.5× faster than Sharp** (6.8 ms)     |
| **In-Memory Transcode**  | 1280px AVIF → JPEG 90 (describe)  | ≤ 6.5 ms   | ≤ 9.2 ms   | ≤ 12.5 ms  | **2.0× faster than Sharp** (14.2 ms)    |
| **ML Tensor Extract**    | 4K JPEG → 640×640 NCHW Float32    | ≤ 3.5 ms   | ≤ 4.8 ms   | ≤ 6.5 ms   | **2.5× faster than Sharp** (11.0 ms)    |
| **Full RAW Develop**     | 24MP Sony A7 III (Demosaic + AgX) | ≤ 60 ms    | ≤ 80 ms    | ≤ 105 ms   | Maple Unique (Sharp cannot develop RAW) |
| **Full RAW Develop**     | 45MP Nikon Z7 (Demosaic + AgX)    | ≤ 95 ms    | ≤ 125 ms   | ≤ 160 ms   | Maple Unique                            |
| **Full RAW Develop**     | 100MP Hasselblad L3D-100c         | ≤ 180 ms   | ≤ 220 ms   | ≤ 275 ms   | Maple Unique                            |

### 9.2 Throughput Targets

- **Batch RAW Export**: ≥ **150 Megapixels / second** on an 8-core CPU (equivalent to ≥ 6.25 full-resolution 24MP RAW files per second, or ≥ 1.5 100MP Hasselblad frames per second).
- **Batch Thumbnail Generation**: ≥ **120 images / second** on 8 cores for 512px AVIF thumbnails from embedded RAW previews or bitmap originals.
- **ML Tensor Batch Throughput**: ≥ **250 FPS** on 8 cores for continuous facial detection and recognition indexing pipelines.

### 9.3 Memory Footprint & Resource Budgets

1. **Peak Resident Set Size (RSS)**:
   - **100MP RAW Decode & Export**: Peak RSS must not exceed **450 MB** (measured against libvips/Sharp which spikes to 650–800 MB on 100MP rasters due to intermediate uncompressed tile buffers).
   - **Bitmap Resizing**: Memory overhead capped at **≤ 1.25× input buffer size**.
2. **Zero-Copy Node/Bun Buffer Handoff**:
   - Rust-allocated memory returned to JavaScript via Node-API uses `napi_create_external_buffer` with custom finalizers, eliminating intermediate copies and double-free hazards.
3. **Long-Running Memory Stability**:
   - **Zero Leak Rate**: 0 bytes growth per cycle over 100,000 consecutive image transforms. Verified via Valgrind on Linux and heap profiling in Bun.
4. **Distribution Size**:
   - Native binary size per platform must remain **≤ 25 MB** compressed (compared to `@img/sharp-*` + `libvips` which totals ~120 MB across dependencies).

### 9.4 Parallelism & Core Scaling

- **Rayon Thread Pool Efficiency**: Linear scaling up to 16 cores with ≥ **85% parallel efficiency**.
- **Event Loop Non-Blocking**: All image compute runs on dedicated Rust worker threads. The Node.js / Bun JavaScript event loop latency must not exceed **2 ms** during full-load background batch exports.

### 9.5 Head-to-Head Benchmarking Matrix (Maple Core vs Sharp / libvips)

| Benchmark Scenario                      | Sharp (libvips C++) | `@justmaple/maple` (Rust Core) | Target Delta                                  |
| :-------------------------------------- | :------------------ | :----------------------------- | :-------------------------------------------- |
| **1. 4K Bitmap → 512px AVIF Thumb**     | ~18 ms              | **~11 ms**                     | **39% faster** (SIMD resizer + rav1e speed 6) |
| **2. In-Memory 1280px AVIF → JPEG**     | ~14 ms              | **~7 ms**                      | **50% faster** (zero-copy buffer decode)      |
| **3. 4K → 640×640 NCHW Float32 Tensor** | ~11 ms              | **~4 ms**                      | **63% faster** (direct SIMD normalization)    |
| **4. 100MP RAW Develop → Full JPEG**    | Unsupported (fails) | **~195 ms**                    | Infinite (complete non-destructive pipeline)  |
| **5. Memory RSS (16 Concurrent Tasks)** | ~1.4 GB             | **~680 MB**                    | **51% lower memory consumption**              |
| **6. Total Dependency Footprint**       | ~120 MB             | **~24 MB**                     | **80% smaller footprint**                     |

---

## 10. Implementation Roadmap

### Phase 1: Rust Core Enhancements (`raw-core`)

1. **Non-RAW Decoder**: Add unified decode module in `raw-core` supporting JPEG, PNG, WebP, and TIFF alongside RAW.
2. **SIMD Resizer**: Integrate `fast_image_resize` into `raw-core` for arbitrary image downsampling/upsampling.
3. **Format Support**: Extend `raw_core::export` and `ExportRecipe` to include `ExportFormat::Avif` and `ExportFormat::Webp`.
4. **Raw Buffer Extraction**: Add `to_raw_rgb()` with planar NCHW / interleaved HWC tensor export options.

### Phase 2: Node-API Binding Crate & Package (`@justmaple/maple`)

1. Set up Node-API bindings using `napi-rs` in `src/maple/`.
2. Implement TypeScript class `MapleImage` with chaining methods (`resize`, `rotate`, `toFormat`, `toBuffer`, `toFile`, `toRawRgb`).
3. Set up CI matrix to cross-compile prebuilt binaries for Darwin (`arm64`, `x64`), Linux (`x64-gnu`, `x64-musl`, `arm64-gnu`, `arm64-musl`), and Windows (`x64`).
4. Wire CLI binary `bin/maple.js` directly into the package (`npx maple`).

### Phase 3: Server Integration & Sharp Deprecation (`src/api`)

1. Add `@justmaple/maple` to `src/api/package.json`.
2. Migrate `thumbs/render.ts`, `thumbs/avif-checks.ts`, and `thumbs/apply-orientation.ts`.
3. Migrate `enrichment/face-detector.ts`, `video/frame-extract.ts`, and `workers/stages/describe.ts`.
4. Migrate `export/export-files.ts` to use `@justmaple/maple`.
5. Remove `sharp` and unneeded child isolation infrastructure; verify all unit and integration tests pass.

---

## 11. Verification & Parity Gates

1. **Color Parity**:
   - All recipe exports generated via `@justmaple/maple` and `npx maple export` must pass the exact same perceptual parity CIEDE2000 budgets as `maple-cli` (`src/scripts/test_color_pipeline.sh`).
2. **Thumbnail Fidelity**:
   - Generated 512px AVIF thumbnails must match existing Sharp output within PSNR > 42 dB and pass `checkAvifOutput()` validation checks.
3. **Face Detection Tensor Parity**:
   - Face detection confidence and landmark coordinates from `jpegToInputTensor` and `alignFaceCrop` must match existing SCRFD/ArcFace embeddings bit-for-bit.
4. **Performance Gate**:
   - Automated benchmark suite verifying the latency budgets and throughput targets defined in Section 9. No PR may merge that regresses latency budgets by > 5%.
5. **Linux Cross-Platform CI**:
   - Full test execution across `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, and `x86_64-unknown-linux-musl` (Alpine) inside GitHub Actions containerized runners.
