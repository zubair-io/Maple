# RAW Processing Pipeline: Cross-Platform Architecture

A shared Rust core for RAW image processing, consumed by a Swift app (macOS/iOS) and a web app (WASM + WebGPU).

## Goals

- Single source of truth for image pipeline logic (decode, demosaic, color math)
- Near-real-time editing of 50–100MP images via split preview/export paths
- Platform-native GPU acceleration (Metal on Apple, WebGPU in browser)
- Minimal glue code per platform

## High-Level Architecture

```
                    ┌─────────────────────────┐
                    │     Rust Core Crate     │
                    │                         │
                    │  • RAW decode           │
                    │  • Bilinear demosaic    │
                    │  • Color math (CPU)     │
                    │  • Tile management      │
                    │  • Shared types         │
                    └────────────┬────────────┘
                                 │
                ┌────────────────┼────────────────┐
                │                │                │
          ┌─────▼─────┐    ┌─────▼─────┐    ┌─────▼─────┐
          │  Swift    │    │  Swift    │    │   WASM    │
          │  (macOS)  │    │  (iOS)    │    │ (Browser) │
          │           │    │           │    │           │
          │  Metal    │    │  Metal    │    │  WebGPU   │
          │  shaders  │    │  shaders  │    │  (WGSL)   │
          └───────────┘    └───────────┘    └───────────┘
```

The Rust core owns everything up to "demosaiced linear RGB buffer." Each platform owns its GPU shader pipeline for interactive edits (white balance, exposure, tone curve), because Metal and WebGPU require native shaders anyway and these shaders are tiny (~10 lines each).

## Repository Layout

```
raw-pipeline/
├── Cargo.toml                    # Workspace
├── crates/
│   ├── raw-core/                 # Pure Rust, no platform deps
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── decode.rs         # rawloader wrapper
│   │   │   ├── demosaic.rs       # bilinear + half-res quad
│   │   │   ├── color.rs          # matrix, WB, tone curve
│   │   │   └── tile.rs           # tiled processing
│   │   └── Cargo.toml
│   │
│   ├── raw-ffi/                  # C ABI for Swift
│   │   ├── src/lib.rs            # #[no_mangle] extern "C" fns
│   │   ├── cbindgen.toml
│   │   └── Cargo.toml            # crate-type = ["staticlib"]
│   │
│   └── raw-wasm/                 # wasm-bindgen for browser
│       ├── src/lib.rs
│       └── Cargo.toml            # crate-type = ["cdylib"]
│
├── swift/
│   ├── Package.swift             # Swift Package wrapping raw-ffi
│   └── Sources/
│       ├── RawPipelineC/         # C target (header + .a)
│       └── RawPipeline/          # Swift wrapper API
│
├── web/
│   ├── package.json
│   └── src/                      # TypeScript consuming raw-wasm
│
└── scripts/
    ├── build-apple.sh            # Cargo → xcframework
    └── build-wasm.sh             # wasm-pack build
```

## The Rust Core

`raw-core` is platform-agnostic and contains the expensive, shared logic:

```rust
pub struct RawImage {
    pub width: u32,
    pub height: u32,
    pub cfa_pattern: CfaPattern,      // RGGB, BGGR, etc.
    pub black_level: u16,
    pub white_level: u16,
    pub camera_matrix: [[f32; 3]; 3], // camera space → XYZ
    pub raw_data: Vec<u16>,
}

pub struct DemosaicedImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<f32>,              // linear RGB, interleaved
}

pub fn decode_raw(bytes: &[u8]) -> Result<RawImage, DecodeError>;
pub fn demosaic_bilinear(raw: &RawImage) -> DemosaicedImage;
pub fn demosaic_half_res(raw: &RawImage) -> DemosaicedImage;  // 2x2 quad trick
```

Key dependencies:
- **`rawler`** or **`rawloader`** — RAW container parsing + sensor decompression
- **`rayon`** — parallel scanline processing for CPU demosaic
- **`bytemuck`** — zero-copy buffer casting for FFI

The core never touches the GPU. It outputs a `Vec<f32>` of linear RGB that each platform uploads to its own GPU texture.

## Swift Integration

### FFI crate (`raw-ffi`)

```rust
#[no_mangle]
pub extern "C" fn raw_decode_and_demosaic(
    bytes: *const u8,
    len: usize,
    out: *mut DemosaicedHandle,
) -> i32 {
    // ... decode, demosaic, return opaque handle
}

#[no_mangle]
pub extern "C" fn raw_get_pixels(handle: DemosaicedHandle) -> *const f32 { ... }

#[no_mangle]
pub extern "C" fn raw_free(handle: DemosaicedHandle) { ... }
```

`cbindgen` auto-generates `raw_pipeline.h` from these signatures.

### Build for Apple platforms

```bash
# Add targets once
rustup target add aarch64-apple-darwin x86_64-apple-darwin \
                  aarch64-apple-ios aarch64-apple-ios-sim

# Build for each target
cargo build --release --target aarch64-apple-darwin -p raw-ffi
cargo build --release --target aarch64-apple-ios    -p raw-ffi
cargo build --release --target aarch64-apple-ios-sim -p raw-ffi

# Combine into xcframework
xcodebuild -create-xcframework \
    -library target/aarch64-apple-darwin/release/libraw_ffi.a \
        -headers include/ \
    -library target/aarch64-apple-ios/release/libraw_ffi.a \
        -headers include/ \
    -library target/aarch64-apple-ios-sim/release/libraw_ffi.a \
        -headers include/ \
    -output RawPipeline.xcframework
```

Wrap in a Swift Package so both macOS and iOS apps consume it the same way:

```swift
// Sources/RawPipeline/RawPipeline.swift
import RawPipelineC

public final class DemosaicedImage {
    let handle: OpaquePointer
    
    public init(rawData: Data) throws {
        // call raw_decode_and_demosaic
    }
    
    public var mtlBuffer: MTLBuffer { /* wrap pointer as Metal buffer */ }
    
    deinit { raw_free(handle) }
}
```

The Swift app then writes Metal shaders for the interactive edit pipeline.

## Web Integration

### WASM crate (`raw-wasm`)

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmDemosaiced {
    inner: DemosaicedImage,
}

#[wasm_bindgen]
impl WasmDemosaiced {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<WasmDemosaiced, JsValue> { ... }
    
    pub fn pixels(&self) -> *const f32 { self.inner.pixels.as_ptr() }
    pub fn width(&self) -> u32 { self.inner.width }
    pub fn height(&self) -> u32 { self.inner.height }
}
```

### Build for web

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

wasm-pack build crates/raw-wasm --target web --release
```

Output is a `pkg/` directory with `.wasm` + TypeScript bindings, ready to `import`.

The web app uses WebGPU for the edit pipeline. The WGSL shaders mirror the Metal ones — same math, different syntax.

## GPU Edit Pipeline (Per Platform)

Both platforms run the same conceptual fused shader on the demosaiced buffer:

### Metal (Swift side)

```metal
kernel void edit_pipeline(
    device const float3* input   [[buffer(0)]],
    device       float3* output  [[buffer(1)]],
    constant     Params& params  [[buffer(2)]],
    uint2 gid                    [[thread_position_in_grid]]
) {
    float3 px = input[gid.y * params.width + gid.x];
    px *= params.wb;                              // white balance
    px = params.color_matrix * px;                // camera → sRGB
    px *= params.exposure;                        // 2^EV
    px = sample_tone_curve(params.lut, px);       // tone curve
    output[gid.y * params.width + gid.x] = px;
}
```

### WGSL (Web side)

```wgsl
@compute @workgroup_size(8, 8)
fn edit_pipeline(@builtin(global_invocation_id) gid: vec3<u32>) {
    var px = input[gid.y * params.width + gid.x];
    px *= params.wb;
    px = params.color_matrix * px;
    px *= params.exposure;
    px = sample_tone_curve(px);
    output[gid.y * params.width + gid.x] = px;
}
```

These run in under 1ms on a 25MP preview buffer. Slider drags re-run only this shader; the demosaiced buffer stays cached on the GPU.

## Performance Strategy (Recap)

| Path        | Demosaic           | Resolution       | Target latency |
|-------------|--------------------|------------------|----------------|
| Preview     | Bilinear or half-res quad | Screen-matched (~8MP) | <30ms open, <1ms edit |
| Export      | AMaZE / AHD        | Full sensor      | 1–3s (one-shot) |

The export-quality demosaic can live in the Rust core as a feature flag (`--features high-quality-demosaic`), since it's shared logic, even though it only runs on export.

## Build Matrix

| Target                     | Triple                      | Output               |
|----------------------------|-----------------------------|----------------------|
| macOS (Apple Silicon)      | `aarch64-apple-darwin`      | `.a` → xcframework   |
| macOS (Intel)              | `x86_64-apple-darwin`       | `.a` → xcframework   |
| iOS device                 | `aarch64-apple-ios`         | `.a` → xcframework   |
| iOS sim (Apple Silicon)    | `aarch64-apple-ios-sim`     | `.a` → xcframework   |
| Web                        | `wasm32-unknown-unknown`    | `.wasm` via wasm-pack |

## Platform-Specific Considerations

**iOS memory pressure.** A 100MP image at f32 linear RGB = 1.2GB. iOS will kill the app. Use the half-res quad trick (drops to 300MB) and tile-based processing for export. The tile manager lives in `raw-core/tile.rs` so both platforms benefit.

**WASM memory.** WASM32 has a 4GB address space ceiling and browsers enforce tighter limits in practice. Same tiling strategy applies. Consider streaming the decode — `rawler` supports reading from a `Read + Seek` source.

**WebGPU availability.** Not universally shipped yet (Safari support is landing). For broader reach, have a WebGL2 fallback that runs the same shader logic in GLSL, or fall back to a Rust SIMD CPU path via `wide` or `std::simd`.

**Metal 3 features.** If you want Metal Performance Shaders for high-quality demosaic on Apple, that stays in Swift — but it's only relevant for the export path, which can also just use the Rust CPU version.

## Open Questions for Later

- Whether to put AMaZE/AHD demosaic in Rust (portable, slower) or platform GPU shaders (faster, duplicated logic)
- Color management: embed LCMS2 in Rust core, or use platform-native (ColorSync on Apple, CSS color on web)?
- Do we need a Rust CPU fallback path for the edit pipeline, or is GPU always available on our targets?

## First Milestone

1. `raw-core` with `rawler` decode + bilinear demosaic, tested with sample files
2. `raw-ffi` + minimal Swift wrapper that loads a RAW and displays it via Metal (no edits yet)
3. Add the fused Metal edit shader with WB + exposure sliders
4. Port to `raw-wasm` + WebGPU once the Apple path is working

Getting the Swift+Metal path fully working first lets the WASM port be a pure translation exercise rather than a design exercise.
