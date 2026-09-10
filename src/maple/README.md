# maple

The official image processing, development, and export package for Maple — powered by Maple's scene-referred Rust image processing core (`raw-core` and `raw-ffi`).

Provides both a TypeScript/JavaScript programmatic API and an `npx` CLI runner for headless export, recipe processing, thumbnail extraction, and batch-renaming.

## Installation

```bash
npm install maple
# or
bun add maple
```

## CLI Usage (`npx maple`)

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
import { maple } from 'maple';

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
} from 'maple';

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

## Native Core & Linux Support

`maple` connects to `libraw_ffi` via `bun:ffi` or Node-API.

### Linux Environments (Docker, Server, Cloud)

- **Prebuilt Libc Support**: Supports both `glibc` (Ubuntu 20.04+, Debian 11+, RHEL 8+) and `musl` (Alpine Linux containers).
- **Zero Dependencies**: Pure Rust; dynamically links only `libc.so.6` and `libm.so.6`. No C++ runtime (`libstdc++`) or libvips installation required.
- **SIMD Hardware Dispatch**: Runtime CPU feature detection enables AVX-512 and AVX2+FMA on x86_64, and NEON on aarch64 (AWS Graviton, Apple Silicon).
- **Library Discovery Ladder**:
  1. `process.env.MAPLE_NATIVE_LIB`
  2. Local `./native/libraw_ffi.so`
  3. Container path `/app/native/libraw_ffi.so`
  4. Monorepo release `../../raw-pipeline/target/release/libraw_ffi.so`
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
