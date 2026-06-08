# wgpu + WGSL P1b — Apple display-from-texture + iOS on-device — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. This is a **platform spike** — the wgpu↔Metal/CAMetalLayer interop and the iOS cross-compile have real unknowns; iterate against the compiler/linker/device like P0 did with the wgpu API. Steps use `- [ ]`.

**Goal:** Prove `wgpu` (a) **compiles + links into the Apple xcframework** for all four slices — especially **`aarch64-apple-ios`** — and (b) **runs and presents** on Metal: an on-device P1a-chain parity check, plus a passthrough display proof (a known image presented through a wgpu→`CAMetalLayer` surface with the correct color-space tag, no CPU readback). This retires the epic's **#1 risk**. P1b of epic [#925](https://github.com/zubair-io/Maple/issues/925); closes [#988](https://github.com/zubair-io/Maple/issues/988).

**Depends on P1a (`raw-gpu`, on this branch's base).** Stacked on PR #996 → #978.

**Scope discipline:** debug/validation surface only. Do NOT wire the live edit path (P4). The `gpu` feature stays **OFF in the default/shipping/CI xcframework** (nothing ships till P5). Display **encode math** (Rec.2020→display, AgX) stays in P2 — P1b proves the surface _tag_ + the plumbing, NOT a color-correct render.

---

## CRITICAL build reality — read before Task 2 (this is where the #1 risk lives)

`src/apple/scripts/build-xcframework.sh` builds **`--package raw-ffi`** for 4 targets (`aarch64-apple-ios`, `aarch64-apple-ios-sim`, `aarch64-apple-darwin`, `x86_64-apple-darwin`) **offline, from `src/raw-pipeline/vendor/`** (`cargo build --offline --config source.crates-io.replace-with="vendored-sources" ...`). Consequences:

- Building `raw-ffi --features gpu --offline` will **fail** unless wgpu's (large) dep tree is in `vendor/`. Two paths:
  - **For P1b validation (recommended): build the gpu variant NON-offline (crates.io)** — i.e. the gpu code path in the script drops `--offline` + the vendored-source `--config` flags and resolves from crates.io. This proves wgpu compiles/links for all 4 slices (incl. ios-arm64) and runs/presents, **without** bloating `vendor/`.
  - **For CI/shipping (a SEPARATE decision, do NOT do silently): `cargo vendor`** to add wgpu's tree to `vendor/`. wgpu's tree is **large** — measure and **report the vendor-size delta**; do not commit a multi-tens-of-MB vendor bloat without flagging it.
- **Keep the DEFAULT build path unchanged** (offline, vendored, wgpu-free). Add the gpu variant as an **opt-in** (`MAPLE_XCFRAMEWORK_GPU=1` env or a `--gpu` flag) that enables `--features gpu` on the raw-ffi builds.
- The script sets `IPHONEOS_DEPLOYMENT_TARGET=17.0` / `MACOSX_DEPLOYMENT_TARGET=14.0`, forces a rebuild with `FORCE_XCFRAMEWORK_REBUILD=1` / `--force`, and runs a **symbol guard** that derives expected `maple_*` symbols from the generated header — your new FFI symbols must be exported and present in every gpu-variant slice.

**FAIL-FAST:** if `wgpu` will not cross-compile for **`aarch64-apple-ios`** after reasonable iteration (its `metal`/`objc`/`raw-window-handle` deps are the risk), **STOP and report** — that is an epic-reshaping finding, not something to hack around.

---

## De-risking order (do in this order)

1. **Link + run** (the #1 risk): wgpu compiles into the ios-arm64 xcframework slice, and a parity FFI runs on-device. Prove this FIRST.
2. **Present** (display-from-texture): wgpu presents to a `CAMetalLayer`, passthrough color-space proof.

---

## Task 1 — raw-ffi `gpu` feature + on-device parity FFI

**Files:** `raw-ffi/Cargo.toml`, `raw-ffi/src/gpu.rs` (create), `raw-ffi/src/lib.rs`.

- [ ] Add to `raw-ffi/Cargo.toml`: `[features]` → `gpu = ["raw-core/gpu"]` (raw-gpu arrives transitively via raw-core's `gpu`). Confirm `raw-core` exposes `gpu` → `raw-gpu` (from P1a).
- [ ] Add a C-ABI parity entry mirroring the wasm binding (`raw-gpu`'s `run_exposure_gpu` + `apply_exposure_gain`), e.g.:
      `#[no_mangle] pub extern "C" fn maple_gpu_exposure_parity(n_pixels: u32, ev: f32, out_max_diff: *mut f32) -> i32` — builds the same deterministic buffer, runs the GPU chain via `raw_gpu::run_exposure_gpu`, compares to the CPU oracle, writes max-diff, returns 0/!0. Gate the whole module behind `#[cfg(feature = "gpu")]`.
- [ ] Verify the host build: `cd src/raw-pipeline && cargo build -p raw-ffi --features gpu` (NO output piping; generous timeout — first wgpu compile). Confirm `cargo build -p raw-ffi` (default) is unchanged (no wgpu).
- [ ] Commit (every commit ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`).

## Task 2 — xcframework gpu variant (the link proof, incl. ios-arm64)

**Files:** `src/apple/scripts/build-xcframework.sh`.

- [ ] Add an opt-in gpu variant (`MAPLE_XCFRAMEWORK_GPU=1` or `--gpu`): when set, pass `--features gpu` to each `cargo build`, and (per the build-reality note) **drop `--offline` + the vendored-source `--config`** for the gpu variant (resolve from crates.io) so vendoring isn't required for validation. Leave the DEFAULT path byte-for-byte unchanged.
- [ ] Build the gpu xcframework: `MAPLE_XCFRAMEWORK_GPU=1 FORCE_XCFRAMEWORK_REBUILD=1 ./src/apple/scripts/build-xcframework.sh --release`. **All 4 slices must build; the `aarch64-apple-ios` slice is the proof.** The symbol guard must pass with the new `maple_gpu_*` symbol(s).
- [ ] If the ios-arm64 build fails: iterate on wgpu deps/features (e.g. wgpu backends) reasonably; if fundamentally blocked, STOP + report (fail-fast above).
- [ ] Commit. **Record the vendor-size delta** estimate for the eventual CI/shipping vendoring decision (do not vendor now).

## Task 3 — Swift debug view (flag-gated, OFF in shipping)

**Files:** a new debug SwiftUI view under the app; a Swift bridge for the new FFI; a debug flag.

- [ ] Bridge `maple_gpu_exposure_parity` into Swift (MapleCore). Note from P1a: `GpuContext` is `!Send`/`!Sync` (OnceCell pipeline cache) — keep all GPU calls on a single owner/thread (or wrap), don't share across threads.
- [ ] A SwiftUI debug view behind a debug flag (e.g. a launch-arg / `#if DEBUG` + setting, OFF in shipping — tracked by #988): runs the parity FFI and shows max-diff (device logs aren't capturable on-device, so surface it **in-app**).
- [ ] Add the present path: host a `CAMetalLayer` (via `NSViewRepresentable`/`UIViewRepresentable`) and a wgpu surface created from it (design the interop against the platform APIs — raw-window-handle / `wgpu::Surface` from the `CAMetalLayer`; spike iteration expected). Present a **known reference image** with the correct color-space tag (no CPU readback) — the **passthrough proof**.
- [ ] Commit.

## Task 4 — macOS validation

- [ ] Build the macOS app against the gpu xcframework (`-scheme "Maple Exposure" -destination 'platform=macOS'`). A clean build links wgpu into the Apple build — a large part of the #1 risk retired on macOS.
- [ ] Run the parity in the debug view on macOS (wgpu→Metal) → max-diff `< 1e-4`.
- [ ] Passthrough display proof on macOS: prefer a `MapleUITests` screenshot of the debug view's presented texture diffed (CIEDE2000) vs the reference. **Note:** the UITest runner needs interactive keychain/TouchID on first run (per CLAUDE.md) — if that blocks a headless run, build + commit the test and report it as a **macOS UITest checkpoint** (don't fake a pass).

## Task 5 — iOS on-device (USER CHECKPOINT — not agent-closable)

- [ ] Document the exact steps: `MAPLE_XCFRAMEWORK_GPU=1 ... --release` xcframework, deploy via devicectl tunnel, open the debug view, confirm parity max-diff `< 1e-4` and the passthrough image displays with no color shift. Device logs are not capturable → everything surfaces in-app. **Owned by maintainer + assistant.**

## Task 6 — PR

- [ ] Push `claude/wgpu-p1b-apple-ios`; open the PR **ready (not draft)**, `Closes #988`, **base `claude/wgpu-p1a-resource-core`** (stacked on #996 → #978; note rebase order to `main`). Body: the ios-arm64 link result, macOS parity number, passthrough-proof status, the vendor-size delta finding, and which items are pending checkpoints (macOS UITest auth if blocked; iOS device).

## Acceptance

- gpu xcframework builds for all 4 slices, **incl. `aarch64-apple-ios`** (or a clear fail-fast finding).
- Default/shipping/CI xcframework unchanged (offline, vendored, wgpu-free).
- macOS: wgpu parity `< 1e-4` (link+run proven); passthrough proof green or a stated UITest checkpoint.
- iOS device: parity + passthrough confirmed (user checkpoint).
- Vendor-size delta for CI vendoring reported (decision deferred).

## Don'ts

No live-edit wiring (P4). No `gpu` in the default xcframework. No silent vendor bloat. No `tail`/pipe on build output. Don't merge.
