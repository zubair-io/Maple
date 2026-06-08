# WebGPU canvas present proof (#925 P1c)

Standalone harness for the **web present path**: create a `wgpu::Surface` from an
HTML `<canvas>` and **present** a known four-quadrant test pattern with **no CPU
readback**. The web counterpart of the merged Apple P1b `wgpu → CAMetalLayer`
present proof (#988). This is PLUMBING only — the colour-correct display encode
(Rec.2020→display, AgX) is P2 (#990); the live Angular canvas wiring is P4-web.
Nothing here ships: the `gpu` feature is OFF by default (epic decommission is P5).

Sibling of the P0 `exposure-webgpu` harness; same shape (build with `RUSTFLAGS`
override, serve locally, drive WebGPU in a real browser, self-report in-page).

## Build

```bash
cd src/raw-pipeline/raw-wasm
RUSTFLAGS="" wasm-pack build --target web \
    --out-dir harness/present-webgpu/pkg --release -- --features gpu
```

`RUSTFLAGS=""` is the same trick the P0 `exposure-webgpu` harness uses, and for
the same reason. Setting `RUSTFLAGS` in the environment **replaces** (does not
append to) `raw-wasm/.cargo/config.toml`, which compiles the threaded shipping
build with `+atomics,+bulk-memory` + `--shared-memory`. A shared-memory module
only instantiates in a `crossOriginIsolated` page (COOP/COEP headers) — which
`python3 -m http.server` does not send, so `init()` would throw before any WebGPU
code runs. The empty override neutralizes those flags; this harness is
single-threaded (the work is on the GPU) and builds on **stable** with no extra
cfg. The display-p3 re-tag (see below) is done through stable `js_sys`, so — unlike
an earlier draft — it needs **no** `web_sys_unstable_apis` cfg.

## Run

```bash
cd src/raw-pipeline/raw-wasm/harness/present-webgpu
python3 -m http.server 8766
```

Open `http://localhost:8766/` in a **WebGPU-capable browser** (Chrome/Edge ≥ 113,
or Safari Technology Preview).

**What to look for:**

1. The canvas shows the four-quadrant pattern: **red** top-left, **green**
   top-right, **blue** bottom-left, **white** bottom-right. A channel swap or an
   all-grey canvas (the clear colour) = the present FAILED.
2. The text block ends with `OVERALL: PASS (present plumbing)` and prints the
   chosen surface format + the achieved colour-space tag (read back two ways: from
   Rust's `getConfiguration()`, and again independently in plain JS).
3. `window.__MAPLE_PRESENT_RESULT` / `window.__MAPLE_PRESENT_OK` carry the same
   result for automated scraping (mirrors P0's `window.__MAPLE_PARITY_RESULT`).

## Colour-space (`display-p3`)

The live web canvas in this project is tagged **`display-p3`**, NOT `srgb` (the
`maple-common` WebGL pipeline sets `colorSpace: 'display-p3'`; the CLAUDE.md "srgb"
note is stale). This harness targets the same tag.

The wrinkle, and why it's a **maintainer checkpoint** rather than a hard pass:
WebGPU couples `colorSpace` _into_ the `GPUCanvasContext.configure()` call that
wgpu owns, and **wgpu-23 hardcodes it absent** → the browser default `srgb`
(verified in `vendor/wgpu/.../backend/webgpu.rs::surface_configure`, which never
sets `colorSpace`; wgpu exposes no API to plumb it through `Surface::configure`).

So the Rust side re-`configure()`s the _same_ canvas context to `display-p3`
_after_ wgpu (reusing wgpu's own device, read back via `getConfiguration()`). The
re-tag lands before `get_current_texture()`, which only fetches, so it survives to
present.

The whole re-tag is done through **stable `js_sys`** (`Reflect` / `Object` /
`Function`) on untyped `JsValue`s — exactly what a hand-written JS WebGPU app does
(`ctx.configure({ device, format, colorSpace })`). It deliberately does **not** use
the typed `web_sys::Gpu*` bindings: wgpu-23 vendors its _own_ private copy of the
WebGPU bindings, so pulling the public ones in too makes wasm-bindgen reject the
build (`duplicate string enums` for `GpuCanvasAlphaMode` etc). raw-gpu therefore
enables only the `HtmlCanvasElement` web-sys feature.

The re-tag still depends on `getConfiguration()` at **runtime**, which is itself
relatively new (Chrome ~128+, newer than the ≥113 present baseline). The page reads
the achieved tag back (two ways) and shows it — `display-p3` if the re-tag took,
`srgb` if the browser is too old or rejects it. The present proof passes either way.

## Status (what's verified where)

- **Compiles + `wasm-pack`s:** verified locally with `RUSTFLAGS="" … --features
gpu` — the build completes, runs wasm-bindgen + wasm-opt clean, and exports
  `present_gpu(canvas)` → `Promise<PresentResult { format, colorSpace }>`.
- **Default shipping path untouched:** `cargo build -p raw-ffi` stays wgpu/web-sys
  free (the `gpu` feature is off by default).
- **Live browser present:** a **maintainer checkpoint**. CI here has no real
  WebGPU browser (Playwright Chromium is SwiftShader-only). The WebGPU go/no-go
  already passed for P0 on this exact build/serve recipe, so the path is proven;
  the eyeball (four quadrants) + colour-space read-back are the remaining manual
  steps.
