# wgpu + WGSL P0 Exposure Spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove one render stage (exposure) runs GPU-resident via `wgpu`+WGSL and matches the Rust CPU reference within 1e-4 on macOS (Metal) and a WebGPU browser — the de-risking spike (P0) for epic [#925](https://github.com/zubair-io/Maple/issues/925).

**Architecture:** A feature-gated `gpu` module in `raw-core` holds a WGSL compute kernel (`rgb *= 2^ev`), a pure-CPU oracle, and a shared async `wgpu` runner. A native parity test runs the kernel on macOS→Metal and asserts max-abs-diff < 1e-4 vs the oracle. `raw-wasm` re-exposes the same runner over `wasm-bindgen`; a static HTML harness runs it on WebGPU. The feature is **off by default**, so all shipping/CI builds are byte-identical to today.

**Tech Stack:** Rust, `wgpu = "23"` (bundles `naga` for WGSL→MSL/SPIR-V), WGSL, `wasm-bindgen`, `wasm-pack`.

**Design doc:** `docs/superpowers/specs/2026-06-07-wgpu-wgsl-gpu-unification-design.md`

**Update 2026-06-07 — iOS deferred to P1:** Per maintainer decision, the iOS-device checkpoint (the "Manual checkpoint" section near the end) is **folded into P1** — validated when P1 builds the GPU display-surface handoff that links `wgpu` into the xcframework. P0 closes on macOS (done) + the WebGPU-browser run. That section is retained as the P1 iOS-validation reference.

**Workspace:** Work in the current worktree (`/Users/riabuz/Projects/_Maple/.claude/worktrees/upbeat-fermi-7dc030`, branch `claude/upbeat-fermi-7dc030`). The design doc + this plan already exist on disk uncommitted; commit them with Task 1.

---

## wgpu version note (read before Task 3)

`wgpu`'s setup API shifts between minor versions. This plan targets **v23**, where:

- `Instance::default()` constructs the instance.
- `instance.request_adapter(&opts).await` returns `Option<Adapter>` → use `.expect(...)`.
- `adapter.request_device(&desc).await` takes **one** arg (the trace path was removed in v22) and returns `Result<(Device, Queue), _>`.
- `device.poll(wgpu::Maintain::Wait)` drives buffer mapping on native.
- `ComputePipelineDescriptor` carries `compilation_options` and `cache` fields; `entry_point` is `Option<&str>`.

If the pinned patch differs, **adjust to the compiler errors** — minor API drift is expected spike iteration, not a plan failure. Confirm against `https://docs.rs/wgpu/23` if needed.

---

## File Structure

| File                                                                    | Responsibility                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/raw-pipeline/raw-core/Cargo.toml` (modify)                         | Add optional `wgpu`, `pollster`, `futures-channel` deps + `gpu` feature  |
| `src/raw-pipeline/raw-core/src/lib.rs` (modify)                         | `#[cfg(feature = "gpu")] pub mod gpu;`                                   |
| `src/raw-pipeline/raw-core/src/gpu/mod.rs` (create)                     | CPU oracle, shared async `wgpu` runner, native sync wrapper, parity test |
| `src/raw-pipeline/raw-core/src/gpu/exposure.wgsl` (create)              | The WGSL compute kernel                                                  |
| `src/raw-pipeline/raw-wasm/Cargo.toml` (modify)                         | Add optional `wgpu`, `wasm-bindgen-futures` + `gpu` feature              |
| `src/raw-pipeline/raw-wasm/src/lib.rs` (modify)                         | `#[cfg(feature = "gpu")] pub mod gpu;`                                   |
| `src/raw-pipeline/raw-wasm/src/gpu.rs` (create)                         | `#[wasm_bindgen] async fn exposure_gpu_parity(...)`                      |
| `src/raw-pipeline/raw-wasm/harness/exposure-webgpu/index.html` (create) | Static WebGPU parity harness page                                        |
| `src/raw-pipeline/raw-wasm/harness/exposure-webgpu/README.md` (create)  | Build + run instructions                                                 |
| `src/raw-pipeline/raw-wasm/harness/exposure-webgpu/.gitignore` (create) | Ignore the built `pkg/`                                                  |

---

## Task 1: Add the `gpu` feature to raw-core (off by default)

**Files:**

- Modify: `src/raw-pipeline/raw-core/Cargo.toml`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs:30` (after `pub mod view;`)
- Create: `src/raw-pipeline/raw-core/src/gpu/mod.rs`

- [ ] **Step 1: Add deps + feature to `raw-core/Cargo.toml`**

In `[dependencies]`, add after the `exr` line:

```toml
# GPU spike (epic #925), feature-gated and OFF by default. Pulls in wgpu only
# when the `gpu` feature is enabled, so default + CI-without-GPU builds are
# unchanged. naga (WGSL→MSL/SPIR-V) is bundled inside wgpu.
wgpu = { version = "23", optional = true }
pollster = { version = "0.4", optional = true }
futures-channel = { version = "0.3", optional = true }
```

In `[features]`, add:

```toml
# Epic #925 P0 spike: WGSL exposure kernel + native wgpu parity test. OFF by
# default — enable with `--features gpu`. Build-time only; no default impact.
gpu = ["dep:wgpu", "dep:pollster", "dep:futures-channel"]
```

- [ ] **Step 2: Declare the module in `lib.rs`**

After `pub mod view;` (line 30) add:

```rust
#[cfg(feature = "gpu")]
pub mod gpu;
```

- [ ] **Step 3: Create an empty `gpu/mod.rs`**

```rust
//! GPU compute spike (epic #925, P0). Feature-gated behind `gpu` (OFF by
//! default). Proves one stage (exposure: `rgb *= 2^ev`) runs GPU-resident via
//! wgpu+WGSL and matches the Rust CPU oracle within 1e-4. The CPU path in
//! `raw-core` stays the parity oracle and fallback.
```

- [ ] **Step 4: Verify the default build is unchanged (no wgpu)**

Run (NO output piping — print in full):

```bash
cd src/raw-pipeline && cargo build -p raw-core
```

Expected: builds clean; `cargo tree -p raw-core -i wgpu` reports `wgpu` is **not** in the default tree (errors with "package ID not found", which is the pass condition).

- [ ] **Step 5: Verify the gpu feature compiles**

```bash
cd src/raw-pipeline && cargo build -p raw-core --features gpu
```

Expected: builds clean with wgpu now in the tree.

- [ ] **Step 6: Commit (includes the design doc + this plan)**

```bash
git add docs/superpowers/specs/2026-06-07-wgpu-wgsl-gpu-unification-design.md \
        docs/superpowers/plans/2026-06-07-wgpu-wgsl-p0-exposure-spike.md \
        src/raw-pipeline/raw-core/Cargo.toml \
        src/raw-pipeline/raw-core/src/lib.rs \
        src/raw-pipeline/raw-core/src/gpu/mod.rs
git commit -m "feat(gpu): add feature-gated gpu module scaffold for #925 P0 spike"
```

---

## Task 2: CPU oracle + WGSL kernel (TDD the oracle)

**Files:**

- Modify: `src/raw-pipeline/raw-core/src/gpu/mod.rs`
- Create: `src/raw-pipeline/raw-core/src/gpu/exposure.wgsl`

- [ ] **Step 1: Write the failing oracle test**

Append to `gpu/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposure_gain_doubles_rgb_at_plus_one_ev_and_keeps_alpha() {
        // Two RGBA pixels. +1 EV → gain = 2^1 = 2.0.
        let mut buf = vec![0.1, 0.2, 0.4, 1.0, 0.5, 0.5, 0.5, 0.3];
        apply_exposure_gain(&mut buf, 1.0);
        assert!((buf[0] - 0.2).abs() < 1e-6);
        assert!((buf[1] - 0.4).abs() < 1e-6);
        assert!((buf[2] - 0.8).abs() < 1e-6);
        assert!((buf[3] - 1.0).abs() < 1e-6, "alpha untouched");
        assert!((buf[4] - 1.0).abs() < 1e-6);
        assert!((buf[7] - 0.3).abs() < 1e-6, "alpha untouched");
    }
}
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd src/raw-pipeline && cargo test -p raw-core --features gpu exposure_gain_doubles -- --nocapture
```

Expected: FAIL — `cannot find function apply_exposure_gain`.

- [ ] **Step 3: Implement the oracle**

Add to `gpu/mod.rs` (above the test module):

```rust
/// Scene-linear exposure gain on an interleaved RGBA f32 buffer:
/// `rgb *= 2^ev`, alpha untouched. This is the spike's CPU oracle — it mirrors
/// the `baseline_exposure.exp2()` multiply in `pipeline::develop` (and the
/// additive-EV user exposure), kept standalone so the spike isolates GPU
/// plumbing rather than pipeline integration.
pub fn apply_exposure_gain(buf: &mut [f32], ev: f32) {
    let gain = ev.exp2();
    for px in buf.chunks_exact_mut(4) {
        px[0] *= gain;
        px[1] *= gain;
        px[2] *= gain;
        // px[3] (alpha) untouched
    }
}
```

- [ ] **Step 4: Run it to confirm it passes**

```bash
cd src/raw-pipeline && cargo test -p raw-core --features gpu exposure_gain_doubles -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Create the WGSL kernel**

`src/raw-pipeline/raw-core/src/gpu/exposure.wgsl`:

```wgsl
// exposure.wgsl — scene-linear exposure gain: rgb *= 2^ev, alpha untouched.
// One WGSL source for Metal (Apple) and WebGPU (web). Parity oracle:
// raw-core gpu::apply_exposure_gain (CPU). Epic #925 P0.

struct Params {
    ev: f32,
    count: u32,   // number of RGBA pixels
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= params.count) {
        return;
    }
    let gain = exp2(params.ev);
    let p = input_buf[i];
    output_buf[i] = vec4<f32>(p.rgb * gain, p.a);
}
```

- [ ] **Step 6: Commit**

```bash
git add src/raw-pipeline/raw-core/src/gpu/mod.rs \
        src/raw-pipeline/raw-core/src/gpu/exposure.wgsl
git commit -m "feat(gpu): exposure CPU oracle + WGSL kernel for #925 P0"
```

---

## Task 3: wgpu runner + native parity test (macOS → Metal proof)

**Files:**

- Modify: `src/raw-pipeline/raw-core/src/gpu/mod.rs`

- [ ] **Step 1: Write the failing parity test**

Add inside the `tests` module in `gpu/mod.rs`:

```rust
    /// Deterministic RGBA buffer spanning values < 1, = 1, > 1 (some channels
    /// exceed 1 so the multiply is exercised in scene-linear range).
    fn test_buffer(n: usize) -> Vec<f32> {
        let mut v = Vec::with_capacity(n * 4);
        for i in 0..n {
            let t = i as f32 / (n.max(2) - 1) as f32; // 0..=1
            v.extend_from_slice(&[t * 2.0, t, t * 0.5 + 0.25, 1.0]);
        }
        v
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn wgsl_exposure_matches_cpu_oracle_within_1e_4() {
        let input = test_buffer(256);
        for &ev in &[-3.0_f32, 0.0, 0.5, 4.0] {
            let mut cpu = input.clone();
            apply_exposure_gain(&mut cpu, ev);
            let gpu = run_exposure_gpu(&input, ev);
            let max_diff = cpu
                .iter()
                .zip(&gpu)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f32, f32::max);
            assert!(
                max_diff < 1e-4,
                "ev={ev}: GPU vs CPU max abs diff {max_diff} exceeds 1e-4"
            );
        }
    }
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd src/raw-pipeline && cargo test -p raw-core --features gpu wgsl_exposure_matches -- --nocapture
```

Expected: FAIL — `cannot find function run_exposure_gpu`.

- [ ] **Step 3: Implement the runner**

Add to `gpu/mod.rs` (above the test module). See the **wgpu version note** at the top of this plan; adjust to compiler errors if the pinned patch's API differs.

```rust
/// Native blocking entry: run the WGSL exposure kernel on the default adapter
/// (Metal on macOS) and return the result buffer. macOS→Metal is the P0 macOS
/// validation. Not compiled for wasm (which awaits the async fn directly).
#[cfg(not(target_arch = "wasm32"))]
pub fn run_exposure_gpu(input: &[f32], ev: f32) -> Vec<f32> {
    pollster::block_on(run_exposure_gpu_async(input, ev))
}

/// Shared async runner used by the native test (via pollster) and the wasm
/// binding (via wasm-bindgen-futures). GPU-resident: upload → dispatch → one
/// readback (readback is test/export-only, never the interactive path).
pub async fn run_exposure_gpu_async(input: &[f32], ev: f32) -> Vec<f32> {
    use wgpu::util::DeviceExt;

    let instance = wgpu::Instance::default();
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .expect("no suitable GPU adapter");
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("maple-gpu-spike"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            memory_hints: wgpu::MemoryHints::default(),
        })
        .await
        .expect("device request failed");

    let pixel_count = (input.len() / 4) as u32;

    #[repr(C)]
    #[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
    struct Params {
        ev: f32,
        count: u32,
        _pad0: u32,
        _pad1: u32,
    }
    let params = Params { ev, count: pixel_count, _pad0: 0, _pad1: 0 };

    let params_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("params"),
        contents: bytemuck::bytes_of(&params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let input_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("input"),
        contents: bytemuck::cast_slice(input),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let byte_len = std::mem::size_of_val(input) as u64;
    let output_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("output"),
        size: byte_len,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: byte_len,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("exposure"),
        source: wgpu::ShaderSource::Wgsl(include_str!("exposure.wgsl").into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("exposure-pipeline"),
        layout: None,
        module: &shader,
        entry_point: Some("main"),
        compilation_options: wgpu::PipelineCompilationOptions::default(),
        cache: None,
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("exposure-bg"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: params_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: input_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: output_buf.as_entire_binding() },
        ],
    });

    let mut encoder =
        device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("exposure-pass"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        let workgroups = pixel_count.div_ceil(64);
        pass.dispatch_workgroups(workgroups, 1, 1);
    }
    encoder.copy_buffer_to_buffer(&output_buf, 0, &readback_buf, 0, byte_len);
    queue.submit(Some(encoder.finish()));

    let slice = readback_buf.slice(..);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    // Native: drive the queue to completion. On wasm this is a no-op and the
    // await below resolves when the browser completes the map.
    #[cfg(not(target_arch = "wasm32"))]
    device.poll(wgpu::Maintain::Wait);
    rx.await.expect("map channel dropped").expect("buffer map failed");

    let data = slice.get_mapped_range();
    let out: Vec<f32> = bytemuck::cast_slice(&data).to_vec();
    drop(data);
    readback_buf.unmap();
    out
}
```

- [ ] **Step 4: Run the parity test (the macOS→Metal proof)**

```bash
cd src/raw-pipeline && cargo test -p raw-core --features gpu wgsl_exposure_matches -- --nocapture
```

Expected: PASS for all four EV values (max abs diff < 1e-4). This runs wgpu→Metal on macOS.

- [ ] **Step 5: Run the full gpu-feature test set**

```bash
cd src/raw-pipeline && cargo test -p raw-core --features gpu
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/raw-pipeline/raw-core/src/gpu/mod.rs
git commit -m "feat(gpu): wgpu exposure runner + native 1e-4 parity test (#925 P0)"
```

---

## Task 4: raw-wasm WebGPU binding

**Files:**

- Modify: `src/raw-pipeline/raw-wasm/Cargo.toml`
- Modify: `src/raw-pipeline/raw-wasm/src/lib.rs`
- Create: `src/raw-pipeline/raw-wasm/src/gpu.rs`

- [ ] **Step 1: Add deps + feature to `raw-wasm/Cargo.toml`**

In the `[target.'cfg(all(target_arch = "wasm32", ...))'.dependencies]` block, add:

```toml
# GPU spike (#925 P0). wgpu targets WebGPU on wasm. Optional + gated by `gpu`.
wgpu = { version = "23", optional = true }
wasm-bindgen-futures = { version = "0.4", optional = true }
```

In `[features]`, add:

```toml
# Epic #925 P0: WebGPU exposure parity binding. OFF by default.
gpu = ["raw-core/gpu", "dep:wgpu", "dep:wasm-bindgen-futures"]
```

- [ ] **Step 2: Declare the module in `lib.rs`**

After `pub mod auto_tone;` add:

```rust
#[cfg(feature = "gpu")]
pub mod gpu;
```

- [ ] **Step 3: Create the wasm binding `src/gpu.rs`**

```rust
//! WebGPU parity binding for the #925 P0 spike. Builds the same deterministic
//! buffer as the native test, runs the WGSL exposure kernel on WebGPU via
//! raw-core's shared async runner, and returns the max abs diff vs the CPU
//! oracle so the browser harness can assert the 1e-4 gate.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub async fn exposure_gpu_parity(n_pixels: u32, ev: f32) -> Result<f32, JsError> {
    let n = n_pixels as usize;
    let mut input = Vec::with_capacity(n * 4);
    for i in 0..n {
        let t = i as f32 / (n.max(2) - 1) as f32;
        input.extend_from_slice(&[t * 2.0, t, t * 0.5 + 0.25, 1.0]);
    }
    let gpu = raw_core::gpu::run_exposure_gpu_async(&input, ev).await;
    let mut cpu = input.clone();
    raw_core::gpu::apply_exposure_gain(&mut cpu, ev);
    let max_diff = cpu
        .iter()
        .zip(&gpu)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0_f32, f32::max);
    Ok(max_diff)
}
```

- [ ] **Step 4: Verify default wasm build unchanged + gpu build compiles**

```bash
cd src/raw-pipeline && cargo build -p raw-wasm --target wasm32-unknown-unknown
cargo build -p raw-wasm --target wasm32-unknown-unknown --features gpu
```

Expected: both compile. (First proves the default surface is untouched; second proves the WebGPU binding builds.)

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/raw-wasm/Cargo.toml \
        src/raw-pipeline/raw-wasm/src/lib.rs \
        src/raw-pipeline/raw-wasm/src/gpu.rs
git commit -m "feat(gpu): raw-wasm WebGPU exposure parity binding (#925 P0)"
```

---

## Task 5: WebGPU harness page + validation attempt

**Files:**

- Create: `src/raw-pipeline/raw-wasm/harness/exposure-webgpu/index.html`
- Create: `src/raw-pipeline/raw-wasm/harness/exposure-webgpu/README.md`
- Create: `src/raw-pipeline/raw-wasm/harness/exposure-webgpu/.gitignore`

- [ ] **Step 1: Create the harness page**

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Maple — WGSL exposure WebGPU parity (#925 P0)</title>
  </head>
  <body>
    <h1>WGSL exposure WebGPU parity</h1>
    <pre id="out">running…</pre>
    <script type="module">
      import init, { exposure_gpu_parity } from './pkg/raw_wasm.js';
      const out = document.getElementById('out');
      if (!('gpu' in navigator)) {
        out.textContent = 'WebGPU not available in this browser (navigator.gpu missing).';
        window.__MAPLE_PARITY_RESULT = 'NO_WEBGPU';
      } else {
        await init();
        const lines = [];
        let allPass = true;
        for (const ev of [-3, 0, 0.5, 4]) {
          const d = await exposure_gpu_parity(256, ev);
          const pass = d < 1e-4;
          allPass = allPass && pass;
          lines.push(`ev=${ev}: max abs diff ${d.toExponential(3)} ${pass ? 'PASS' : 'FAIL'}`);
        }
        lines.push(allPass ? 'OVERALL: PASS' : 'OVERALL: FAIL');
        out.textContent = lines.join('\n');
        window.__MAPLE_PARITY_RESULT = lines.join('\n');
      }
    </script>
  </body>
</html>
```

- [ ] **Step 2: Create `.gitignore` (the built pkg is an artifact)**

```
pkg/
```

- [ ] **Step 3: Create `README.md`**

````markdown
# WebGPU exposure parity harness (#925 P0)

Validates the WGSL exposure kernel on WebGPU against the CPU oracle (1e-4 gate).

## Build

```bash
cd src/raw-pipeline/raw-wasm
wasm-pack build --target web --out-dir harness/exposure-webgpu/pkg -- --features gpu
```

## Run

```bash
cd src/raw-pipeline/raw-wasm/harness/exposure-webgpu
python3 -m http.server 8765
```

Open `http://localhost:8765/` in a **WebGPU-capable browser** (Chrome/Edge ≥ 113,
or Safari Technology Preview). Each EV row must read `PASS`; the page ends with
`OVERALL: PASS`. `window.__MAPLE_PARITY_RESULT` carries the same text for
automated scraping.
````

- [ ] **Step 4: Build the harness wasm**

```bash
cd src/raw-pipeline/raw-wasm
wasm-pack build --target web --out-dir harness/exposure-webgpu/pkg -- --features gpu
```

Expected: `pkg/raw_wasm.js` + `.wasm` emitted, no errors.

- [ ] **Step 5: Attempt automated WebGPU validation**

Serve the harness (`python3 -m http.server 8765` from the harness dir, backgrounded) and load `http://localhost:8765/` in a **WebGPU-capable** browser, then read the page text / `window.__MAPLE_PARITY_RESULT`.

- If a WebGPU browser is reachable: record the result. Expected: `OVERALL: PASS`.
- **If no WebGPU browser is available in this environment:** do NOT fail the task. Record `NO_WEBGPU` and flag web validation for the human checkpoint. The harness + binding are the deliverable; the run is the checkpoint.

- [ ] **Step 6: Commit**

```bash
git add src/raw-pipeline/raw-wasm/harness/exposure-webgpu/index.html \
        src/raw-pipeline/raw-wasm/harness/exposure-webgpu/README.md \
        src/raw-pipeline/raw-wasm/harness/exposure-webgpu/.gitignore
git commit -m "feat(gpu): WebGPU exposure parity harness page (#925 P0)"
```

---

## Task 6: Open the PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin claude/upbeat-fermi-7dc030
```

- [ ] **Step 2: Open the PR (ready, not draft)** — replace `<P0_TICKET>` with the filed P0 issue number.

```bash
gh pr create --title "feat(gpu): P0 wgpu+WGSL exposure spike (#925)" --body "$(cat <<'EOF'
## Summary

P0 spike for epic #925 — proves one render stage (exposure, `rgb *= 2^ev`) runs
GPU-resident via `wgpu`+WGSL and matches the Rust CPU oracle within 1e-4.

- `gpu` feature in `raw-core` + `raw-wasm`, **OFF by default** (CI-without-GPU
  and all shipping builds are unchanged).
- WGSL kernel (one source for Metal + WebGPU), CPU oracle, shared async wgpu
  runner.
- Native parity test (macOS→Metal): `cargo test -p raw-core --features gpu`.
- WebGPU browser harness under `raw-wasm/harness/exposure-webgpu/`.

## Validation

- [x] Native exposure parity < 1e-4 on macOS (wgpu→Metal).
- [x] Default builds unchanged; `--features gpu` compiles (native + wasm).
- [ ] WebGPU browser harness PASS  <!-- check, or note "checkpoint: no WebGPU browser in CI env" -->
- [ ] iOS-device parity (manual checkpoint — see plan)

## Design / plan

- Design: `docs/superpowers/specs/2026-06-07-wgpu-wgsl-gpu-unification-design.md`
- Plan: `docs/superpowers/plans/2026-06-07-wgpu-wgsl-p0-exposure-spike.md`

Closes #<P0_TICKET>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Manual checkpoint (NOT dispatchable): iOS-device parity

Per the repo's iOS setup, device deploy is manual (devicectl tunnel; device logs
not capturable). To validate the spike on an iOS device:

1. Rebuild the xcframework so the staticlib includes the `gpu`-feature symbols:
   the spike's wgpu path must be reachable from a device build. (For P0 this can
   be a temporary in-app debug call to `run_exposure_gpu` behind a debug flag, or
   deferred to the P1 surface-handoff work — confirm with the maintainer which is
   wanted before adding app-side code.)
2. Deploy to the paired device and run the parity check; surface the max-diff
   in-app (device logs aren't capturable).

This step is owned by the maintainer + assistant together, not the dispatched
agent. It must be green before P0 is considered fully closed.

---

## Roadmap — P1–P5 (planned; each gets its own spec → plan → PR after P0)

These are **not** built now. P0 must land (and the iOS checkpoint pass) before
P1 starts, because each phase depends on the prior. Detail firms up per phase;
the design doc table is the canonical summary.

- **P1 — Resource layer.** Upload-once + ping-pong buffer pool; display straight
  from the GPU texture (no readback); preview vs full-res; two-phase fast/refine
  wiring. Likely extract a `raw-gpu` crate here. _Acceptance:_ a multi-stage
  chain runs GPU-resident with a single upload and zero intermediate readback;
  display-from-texture verified on macOS + WebGPU.
- **P2 — Scene-linear chain → WGSL** (re-scopes #662). Port WB, scene tone
  controls, tone curves, vibrance, saturation, clarity, texture, dehaze, AgX,
  Rec.2020→sRGB encode, Auto Profile curve + residual LUT — each parity-gated
  vs its Rust stage. **Extend codegen** (`src/raw-pipeline/codegen/`) with a
  `Wgsl` target so matrices/LUTs stay single-source; add a golden-file check.
  Fan out one agent per stage. _Acceptance:_ every ported stage < its parity
  budget on macOS + WebGPU; codegen golden green.
- **P3 — Spatial filters → WGSL compute** (folds in #312). NLM noise reduction
  (luma + color), sharpen / capture-sharpen (Richardson-Lucy). _Acceptance:_
  parity vs CPU NLM/sharpen within budget; preview-res within the slider budget.
- **P4 — Wire into live paths** (closes #661; substrate for #394/#819). Apple:
  replace the FFI-CPU chain + remaining MSL kernels with the wgpu path. Web:
  replace the WASM-CPU live path with WebGPU; retain CPU + WebGL2 fallback.
  _Acceptance:_ web meets 16 ms slider target at preview res with a real fast
  phase and no per-tick readback; Apple holds/improves latency, no live readback.
- **P5 — Decommission.** Retire the redundant MSL + GLSL implementations once
  parity holds everywhere. _Acceptance:_ MSL/GLSL render code removed; all parity
  gates green on every target.

---

## Self-Review

**Spec coverage:** P0 design § deliverables 1–5 → Tasks 1–5. Feature-off-by-default
→ Task 1 Steps 4 + Task 4 Step 4. Native macOS-Metal parity → Task 3. Web harness
→ Task 5. iOS checkpoint → Manual checkpoint section. Codegen-WGSL correctly
deferred to P2 (roadmap). Epic acceptance criteria map to per-phase acceptance in
the roadmap. No gaps.

**Placeholder scan:** The only intentional placeholder is `<P0_TICKET>` in the PR
body (filled at dispatch once the issue is created) and the iOS in-app-call
decision (explicitly flagged as maintainer-gated, not a silent gap). No vague
"add error handling" steps. The wgpu runner is complete code with an explicit
version-drift note — not a placeholder.

**Type consistency:** `apply_exposure_gain(&mut [f32], f32)`, `run_exposure_gpu(&[f32], f32) -> Vec<f32>`, `run_exposure_gpu_async(&[f32], f32) -> impl Future<Output = Vec<f32>>`, and `exposure_gpu_parity(u32, f32) -> Result<f32, JsError>` are used consistently across Tasks 2–5. WGSL bindings (0=params uniform, 1=input storage, 2=output storage) match the bind-group entries in the runner. `Params { ev, count, _pad0, _pad1 }` matches between Rust and WGSL.
