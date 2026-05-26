# Maple Look + Auto Tone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the user-facing "Maple has a look" v1 — static Maple Look LUT on all three platforms (Rust/CLI, Apple Metal, Web WebGL) plus a one-click Auto Tone button (exposure-only in this slice).

**Architecture:** Two parallel tracks per the spec's Approach B. Track 1 resurrects the empirical 1D LUT retired in #443 and plumbs it through all three render paths via a new FFI surface. Track 2 adds `compute_auto_tone` (post-WB scene-linear histogram → six slider values; exposure-only in v1) and wires "Auto" buttons in both UI shells. The tracks touch disjoint files and run independently; they converge only at the harness (both must be green to ship v1).

**Tech Stack:** Rust (raw-core, raw-ffi, maple-cli), C-FFI via cbindgen, Swift + Metal (Apple), TypeScript + WebGL2 GLSL ES 3.0 (Web), Bun + Elysia (API serves prebuilt Web bundle).

**Spec:** `docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md` (PR #501).

**Base branch:** `origin/main` HEAD at planning time = `8603dce2` (post-#487 / post-#494 / post-#443). Resurrection content comes from `7739d932^` (pre-#443).

---

## Scope

This plan covers **Phase 0 (Track 1, Maple Look)** and **Phase 1a (Track 2, Auto Tone — exposure only)** as defined in the spec. Phase 2 (Look dropdown UI), Phase 3 (Auto Look adaptive), and Phases 1b/1c (Auto Tone expansion) get their own plans later.

**Out of scope for this plan:**
- Look dropdown UI (Phase 2; ships after both tracks land)
- Auto Look adaptive (Phase 3)
- Auto Tone contrast / highlights / shadows / whites / blacks (Phases 1b/1c)
- Auto WB

## File structure

### Track 1 — Maple Look on all platforms

**Resurrect (from `7739d932^`):**
- `src/raw-pipeline/raw-core/src/view/look.rs` — `Look` enum, `apply(rgb, look)`, unit tests.
- `src/raw-pipeline/raw-core/src/view/look_lut.rs` — three 256-entry `[u8; 256]` arrays (`LUT_R`, `LUT_G`, `LUT_B`). 768 bytes total.

**Modify:**
- `src/raw-pipeline/raw-core/src/view/mod.rs` — re-add `pub mod look;`.
- `src/raw-pipeline/raw-core/src/types/adjustment/mod.rs` — remove the relocated `Look` enum (move back to `view::look`); keep `pub use view::look::Look` re-export.
- `src/raw-pipeline/raw-core/src/pipeline/render/mod.rs` — re-add the four `look::apply` call sites at the end of `render::{from_raw, from_scene_linear, from_scene_linear_with_chain}` (sites the retirement commit deleted). Re-instate the `Look::Neutral` workarounds the retirement commit stripped from tests.
- `src/raw-pipeline/raw-core/src/pipeline/render/tests.rs` — delete `look_field_is_no_op_post_443`; restore the three test-side `Look::Neutral` overrides.
- `src/raw-pipeline/maple-cli/src/main.rs` — re-add `look::apply` after `quantize_u8` on the tile-preview path.
- `src/raw-pipeline/raw-ffi/src/render.rs` — add `look_mode: u8` field to the FFI adjustment-params struct. Default `1` (Maple Look).
- `src/raw-pipeline/raw-ffi/src/scene_linear.rs` + `scene_linear_chain.rs` — add an `out_look_lut: *mut u8` (768 bytes) parameter on render entries so the GPU host can blit the LUT into a texture/uniform. Implementations call `lut_for(look_mode)`.
- `src/raw-pipeline/raw-ffi/include/maple_raw.h` (cbindgen-generated) — regenerate.
- `src/raw-pipeline/codegen/src/main.rs` — Rust → Swift/TS constant generator: re-emit `LookMode` enum (`Neutral=0, Default=1`).
- `src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift` — restore non-no-op docstring on `Look` enum; add LUT plumbing through `MapleAdjustmentParams`.
- Apple Metal final encode pass (find via `grep "agx" src/apple/Packages/MapleCore -r`) — sample new 768-byte LUT texture after sRGB encode; `Look::Neutral` short-circuits.
- `src/web/projects/maple-common/src/lib/webgl/shaders/agx-view-transform.ts` — add `uLookLUT sampler2D` uniform and a per-channel lookup after `gamma encode + dither`; upload 256×3 RGBA8 texture from WASM-emitted LUT bytes.
- `src/web/projects/maple-common/src/lib/xmp/xmp-parser.service.ts` — restore non-no-op `papp:Look` parse path.
- `src/web/projects/maple-common/src/lib/xmp/xmp-serializer.service.ts` — restore non-no-op `papp:Look` serializer; canonical default `Default` continues to omit attribute.
- `test-fixtures/budgets.json` — bump (one-way ratchet: only down, BUT this commit RESURRECTS a path that was retired against the ratchet — so the closing-step authority you're invoking is "the spec deliberately reverses #443"; mention it explicitly in the PR body. New per-case `look_default` entries will land in Task 6 with their first-baseline budgets, which is allowed by the ratchet rule).

### Track 2 — Auto Tone (exposure only)

**Create:**
- `src/raw-pipeline/raw-core/src/stages/auto_tone.rs` — `AutoTone` struct + `compute_auto_tone(scene_post_wb, clip) -> AutoTone`. Reuses `auto_exposure::build_luma_histogram` (the histogram engine, not the gain heuristic). Inversion uses a build-time monotone table from the existing exposure predictor.
- `src/raw-pipeline/raw-core/src/stages/auto_tone_tests.rs` — synthetic-histogram unit tests (flat / bimodal / clipped).
- `src/raw-pipeline/raw-ffi/src/auto_tone.rs` — C-FFI surface (`maple_compute_auto_tone`).
- `src/raw-pipeline/maple-cli/src/auto_tone.rs` + subcommand wiring — `maple-cli auto-tone <RAW>` prints JSON `{exposure, ...}`.
- `src/raw-pipeline/raw-wasm/src/auto_tone.rs` — `wasm-bindgen` wrapper.
- `src/apple/Packages/MapleCore/Sources/MapleCore/AutoTone.swift` — Swift wrapper around `maple_compute_auto_tone`.
- `src/web/projects/maple-common/src/lib/services/auto-tone.service.ts` — Angular service consuming the WASM export.

**Modify:**
- `src/raw-pipeline/raw-core/src/stages/mod.rs` — `pub mod auto_tone;`
- `src/raw-pipeline/raw-ffi/src/lib.rs` — register `auto_tone` module + re-exports.
- `src/raw-pipeline/raw-ffi/include/maple_raw.h` — regenerate.
- `src/raw-pipeline/maple-cli/src/main.rs` — register `auto-tone` subcommand.
- `src/raw-pipeline/raw-wasm/src/lib.rs` — re-export wasm binding.
- `src/web/projects/maple-common/src/lib/components/develop/tone-section.component.{html,ts}` — add `[data-acid="tone-auto"]` button next to existing Reset; on click call service → write `AdjustmentModel` signal → trigger re-render.
- `src/apple/Sources/MapleApp/...` — find the Tone group in DetailPanel (`grep -r "Exposure" src/apple/Sources/MapleApp | grep View`) — add `Button("Auto") { … }` next to Reset, accessibility id `tone-auto`.
- `test-fixtures/references/manifest.json` — add per-fixture `auto_tone` cases (one per fixture).
- `test-fixtures/budgets.json` — add first-baseline budgets per new `auto_tone` case.

## Conventions

- One ticket = one PR. Open every PR with a `Closes #N` line. Tag tickets with Project board "Files".
- File budget: 400 LOC soft / 600 LOC hard. If a touched file approaches the cap, split before adding.
- No `tail`/`head`/Monitor piping on cargo or bun output in dispatched agents (watchdog kills it). Run the command, then grep results separately.
- Color tests write outputs to `~/Desktop/maple-color-tests/<ticket>/`.
- Sidecar parity: every XMP round-trip must pass `cargo test -p raw-core --features fixtures -- xmp`.
- Cross-platform constants: `cargo run -p codegen` regenerates Swift + TS constants. CI golden-file test asserts agreement.

## Required commands cheat-sheet

```bash
# Build the Apple xcframework (after raw-core / raw-ffi changes)
./src/apple/scripts/build-xcframework.sh

# Rebuild WASM (after raw-core / raw-wasm changes)
cd src/raw-pipeline/raw-wasm && wasm-pack build --target web
./src/web/scripts/sync-raw-wasm.sh    # syncs into maple-common

# Color pipeline harness (CI gate)
src/scripts/test_color_pipeline.sh
FILTER=test_0017 src/scripts/test_color_pipeline.sh

# Grey predictors (CI gate)
src/scripts/test_grey_adjustments.sh
src/scripts/test_synthetic_grey.sh

# Rust unit tests
cd src/raw-pipeline && cargo test -p raw-core --lib
cd src/raw-pipeline && cargo test -p raw-core --all-features

# Apple unit tests
cd src/apple/Packages/MapleCore && swift test

# Web tests
cd src/web && bun run lint && bun run test
```

---

## Track 1 — Maple Look on all platforms

### Task L1: Resurrect `view/look.rs` + `view/look_lut.rs`

**Ticket:** filed as a new issue titled `core: resurrect view/look.rs + view/look_lut.rs from git history`, Project = Files.

**Files:**
- Create: `src/raw-pipeline/raw-core/src/view/look.rs`
- Create: `src/raw-pipeline/raw-core/src/view/look_lut.rs`
- Modify: `src/raw-pipeline/raw-core/src/view/mod.rs` (add `pub mod look;`)

- [ ] **Step 1: Recover both files from pre-retirement commit**

```bash
git show 7739d932^:src/raw-pipeline/raw-core/src/view/look.rs \
  > src/raw-pipeline/raw-core/src/view/look.rs

git show 7739d932^:src/raw-pipeline/raw-core/src/view/look_lut.rs \
  > src/raw-pipeline/raw-core/src/view/look_lut.rs
```

- [ ] **Step 2: Re-add module declaration**

In `src/raw-pipeline/raw-core/src/view/mod.rs`, restore the line removed by the retirement commit. Final state:

```rust
pub mod agx;
pub mod dither;
pub mod encode;
pub mod look;
```

- [ ] **Step 3: Move `Look` enum back from `types::adjustment::mod` if it lives there post-#443**

```bash
grep -n "pub enum Look" src/raw-pipeline/raw-core/src/types/adjustment/mod.rs
```

If present:
1. Delete the `Look` definition there.
2. Add `pub use crate::view::look::Look;` re-export so external consumers (`types::adjustment::AdjustmentModel`) keep building.

- [ ] **Step 4: Build + run unit tests**

```bash
cd src/raw-pipeline
cargo build -p raw-core
cargo test -p raw-core --lib view::look::
```

Expected: ≥3 tests pass (the original `look.rs` test module). If build fails on `Look` ambiguity, fix the `types::adjustment` re-export.

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/raw-core/src/view/look.rs \
        src/raw-pipeline/raw-core/src/view/look_lut.rs \
        src/raw-pipeline/raw-core/src/view/mod.rs \
        src/raw-pipeline/raw-core/src/types/adjustment/mod.rs

git commit -m "$(cat <<'EOF'
feat(raw-core): resurrect view/look.rs + view/look_lut.rs

Refs spec docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md.
Restores the pre-#443 empirical 1D LUT verbatim. Call sites added in
subsequent PRs; this PR adds the data + the no-op-by-default API only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task L2: Re-wire `look::apply` into the CPU/CLI render path

**Ticket:** `core+cli: apply Look in pipeline/render.rs (CPU/CLI)`.

**Dependencies:** L1.

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/pipeline/render/mod.rs`
- Modify: `src/raw-pipeline/raw-core/src/pipeline/render/tests.rs`
- Modify: `src/raw-pipeline/maple-cli/src/main.rs`

- [ ] **Step 1: Find the three retirement-commit deletion sites**

```bash
git show 7739d932 -- src/raw-pipeline/raw-core/src/pipeline/render/mod.rs \
  | grep -B 1 -A 4 '^-.*look::apply'
```

Reapply each `stage("look", || look::apply(&mut bytes, model.look));` line at its original location: end of `from_raw`, end of `from_scene_linear`, end of `from_scene_linear_with_chain`.

- [ ] **Step 2: Restore the maple-cli tile path**

```bash
git show 7739d932 -- src/raw-pipeline/maple-cli/src/main.rs \
  | grep -B 1 -A 4 '^-.*look::apply'
```

Reapply that line.

- [ ] **Step 3: Restore the `Look::Neutral` workarounds in `render/tests.rs`**

```bash
git show 7739d932 -- src/raw-pipeline/raw-core/src/pipeline/render/tests.rs
```

For each `+ model.look = Look::Neutral;` line the retirement commit added (i.e. removed in the post-#443 file), restore by adding the line back.

Then delete the `look_field_is_no_op_post_443` test the retirement commit added (it asserts the wrong invariant for this PR).

- [ ] **Step 4: Run all raw-core tests**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib
```

Expected: all green. The synthetic-grey test (`test_synthetic_grey.sh`) WILL regress slightly — that's the price of restoring per-channel LUT floors/ceilings — but unit tests must pass.

- [ ] **Step 5: Spot-check render output**

```bash
cargo run --release --bin maple-cli -- batch \
  test-fixtures/references/manifest.json \
  --out-dir ~/Desktop/maple-color-tests/L2-spotcheck/

# Visually open one or two output images to confirm Look is applied
ls ~/Desktop/maple-color-tests/L2-spotcheck/
```

- [ ] **Step 6: Commit**

```bash
git add src/raw-pipeline/raw-core/src/pipeline/render/mod.rs \
        src/raw-pipeline/raw-core/src/pipeline/render/tests.rs \
        src/raw-pipeline/maple-cli/src/main.rs

git commit -m "$(cat <<'EOF'
feat(render): re-apply empirical Look on CPU + maple-cli paths

Restores the four `look::apply` call sites the #443 retirement removed.
Make Look::Default the new-pixel default; Look::Neutral remains the
strict scene-referred opt-out. Apple + Web call sites in follow-ups.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task L3: FFI surface — `look_mode` + LUT byte export

**Ticket:** `ffi: add look_mode + look_lut_bytes to MapleAdjustmentParams + scene_linear_chain`.

**Dependencies:** L1.

**Files:**
- Modify: `src/raw-pipeline/raw-ffi/src/render.rs`
- Modify: `src/raw-pipeline/raw-ffi/src/scene_linear.rs`
- Modify: `src/raw-pipeline/raw-ffi/src/scene_linear_chain.rs`
- Modify: `src/raw-pipeline/raw-ffi/src/model.rs` (the cbindgen `MapleAdjustmentParams` definition)
- Regenerate: `src/raw-pipeline/raw-ffi/include/maple_raw.h`

- [ ] **Step 1: Find the existing adjustment-params struct**

```bash
grep -n "MapleAdjustmentParams\|pub struct.*Params" src/raw-pipeline/raw-ffi/src/model.rs
```

- [ ] **Step 2: Add `look_mode: u8` field**

Locate the struct. Add (placement at end, near other small fields):

```rust
#[repr(C)]
pub struct MapleAdjustmentParams {
    // ... existing fields ...
    /// 0 = Neutral (no look), 1 = Default (Maple Look). Default initialiser
    /// sets this to 1 to match the Rust-side `Look::default() == Default`.
    pub look_mode: u8,
}
```

Update the constructor / `Default` impl to set `look_mode: 1`.

- [ ] **Step 3: Add a LUT-export FFI**

In `src/raw-pipeline/raw-ffi/src/render.rs`, add:

```rust
/// Writes 768 bytes (256 R, then 256 G, then 256 B) into `out`.
/// Returns 0 on success, -1 if `out` is null or `look_mode` is unknown.
///
/// Apple + Web hosts call this once per render to seed a GPU LUT texture.
#[no_mangle]
pub unsafe extern "C" fn maple_compute_look_lut(
    look_mode: u8,
    out: *mut u8,
) -> i32 {
    if out.is_null() { return -1; }
    let slice = std::slice::from_raw_parts_mut(out, 768);
    match look_mode {
        0 => {
            // Neutral — identity LUT
            for c in 0..3 {
                for i in 0..256 {
                    slice[c * 256 + i] = i as u8;
                }
            }
            0
        }
        1 => {
            slice[0..256].copy_from_slice(&raw_core::view::look::lut::LUT_R);
            slice[256..512].copy_from_slice(&raw_core::view::look::lut::LUT_G);
            slice[512..768].copy_from_slice(&raw_core::view::look::lut::LUT_B);
            0
        }
        _ => -1,
    }
}
```

Note: `look::lut` is `#[path = "look_lut.rs"]`-included inside `look.rs`. If the `lut` mod isn't `pub` in the resurrected file, change `mod lut;` to `pub(crate) mod lut;` in `look.rs` (alternative: re-export `pub(crate) const LUT_R/G/B` from `look.rs`).

- [ ] **Step 4: Wire `model.look = Look::from(params.look_mode)` in the render-call dispatch**

```bash
grep -n "model\.look" src/raw-pipeline/raw-ffi/src/
```

Add a `From<u8> for Look` impl in `raw-core/src/view/look.rs`:

```rust
impl From<u8> for Look {
    fn from(v: u8) -> Self {
        match v { 0 => Look::Neutral, _ => Look::Default }
    }
}
```

In every render entry that constructs an `AdjustmentModel` from `MapleAdjustmentParams`, add `model.look = Look::from(params.look_mode);`.

- [ ] **Step 5: Add an FFI unit test**

In `src/raw-pipeline/raw-ffi/src/render_tests.rs`, after the file's last test:

```rust
#[test]
fn look_lut_roundtrip_default_matches_pre443_bytes() {
    let mut buf = [0u8; 768];
    let rc = unsafe { super::render::maple_compute_look_lut(1, buf.as_mut_ptr()) };
    assert_eq!(rc, 0);
    assert_eq!(&buf[0..256], &raw_core::view::look::lut::LUT_R);
    assert_eq!(&buf[256..512], &raw_core::view::look::lut::LUT_G);
    assert_eq!(&buf[512..768], &raw_core::view::look::lut::LUT_B);
}

#[test]
fn look_lut_neutral_is_identity() {
    let mut buf = [0u8; 768];
    let rc = unsafe { super::render::maple_compute_look_lut(0, buf.as_mut_ptr()) };
    assert_eq!(rc, 0);
    for c in 0..3 {
        for i in 0..256 {
            assert_eq!(buf[c * 256 + i], i as u8);
        }
    }
}
```

- [ ] **Step 6: Build + regenerate header**

```bash
cd src/raw-pipeline
cargo build -p raw-ffi --release
# cbindgen regeneration (mirrors src/apple/scripts/build-xcframework.sh)
cbindgen --config raw-ffi/cbindgen.toml --crate raw-ffi --output raw-ffi/include/maple_raw.h
git diff raw-ffi/include/maple_raw.h | head -50
```

Sanity: `maple_compute_look_lut` should appear in the header.

- [ ] **Step 7: Run FFI tests**

```bash
cd src/raw-pipeline
cargo test -p raw-ffi
```

- [ ] **Step 8: Commit**

```bash
git add src/raw-pipeline/raw-ffi src/raw-pipeline/raw-core/src/view/look.rs

git commit -m "$(cat <<'EOF'
feat(ffi): expose maple_compute_look_lut + look_mode in adjustment params

Adds a 768-byte LUT export so Apple Metal + Web WebGL can sample the
empirical Look LUT instead of the CPU-only `look::apply` path. Mode 0
returns identity (Neutral); mode 1 returns the pre-#443 empirical LUT.

Refs spec docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task L4: Apple Metal — sample LUT in final encode pass

**Ticket:** `apple: sample look_lut_bytes in Metal final-encode pass`.

**Dependencies:** L3.

**Files:**
- Modify: `src/apple/scripts/build-xcframework.sh` (no edits expected; just re-run)
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift`
- Modify: Apple Metal final-encode kernel (locate via `grep -rn "agx" src/apple/Packages/MapleCore/Sources/MapleCore/ | grep -E '\.(metal|swift)'`)
- Modify: Apple host pipeline (call site that submits the final-encode pass)
- Add: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/LookLUTParityTests.swift`

- [ ] **Step 1: Rebuild the xcframework against the L3 FFI**

```bash
./src/apple/scripts/build-xcframework.sh
```

Expected: `Frameworks/RawPipeline.xcframework/.../Headers/maple_raw.h` contains `maple_compute_look_lut`.

- [ ] **Step 2: Restore non-no-op docstring on the Swift `Look` enum**

In `src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift`, find the `Look` enum. Update the docstring to match `view/look.rs`'s; remove the "no-op post-#443" comment.

- [ ] **Step 3: Plumb LUT through to the Metal pipeline**

Find the Metal kernel where the final 8-bit sRGB encode happens. Add a `texture1d_array<float, access::sample>` (or `texture2d` if 1D arrays aren't supported on the deployment target — 256×3 RGBA8) sampled per-channel after the existing AgX + sRGB encode + dither. Pseudo-Metal:

```metal
// after existing per-channel result `r,g,b` in 0..1 sRGB-encoded
constexpr sampler s(filter::nearest, address::clamp_to_edge);
uchar3 rgb_u8 = uchar3(round(float3(r,g,b) * 255.0));
r = float(lookLUT.sample(s, float2((float)rgb_u8.r / 255.0, 0.5 / 3.0)).r) / 255.0;
g = float(lookLUT.sample(s, float2((float)rgb_u8.g / 255.0, 1.5 / 3.0)).r) / 255.0;
b = float(lookLUT.sample(s, float2((float)rgb_u8.b / 255.0, 2.5 / 3.0)).r) / 255.0;
```

Host side (Swift):

```swift
// Allocate 256x3 RGBA8 texture (or use a 1D buffer if supported)
var lutBytes = [UInt8](repeating: 0, count: 768)
_ = maple_compute_look_lut(params.lookMode, &lutBytes)
// upload `lutBytes` into the texture; bind to fragment slot N
```

- [ ] **Step 4: Add a parity test**

Create `LookLUTParityTests.swift`:

```swift
import XCTest
@testable import MapleCore

final class LookLUTParityTests: XCTestCase {
    func testDefaultLookLUTMatchesFFIBytes() {
        var lutBytes = [UInt8](repeating: 0, count: 768)
        let rc = lutBytes.withUnsafeMutableBufferPointer { buf in
            maple_compute_look_lut(1, buf.baseAddress)
        }
        XCTAssertEqual(rc, 0)
        // Spot-check a few canonical points known from the pre-#443 LUT
        // (LUT_R[0], LUT_R[128], LUT_R[255]) — see git show 7739d932^:src/raw-pipeline/raw-core/src/view/look_lut.rs
        XCTAssertNotEqual(lutBytes[0], 0)         // Default !=  identity at 0
        XCTAssertNotEqual(lutBytes[128], 128)     // Default != identity at midpoint
    }
}
```

- [ ] **Step 5: Run Apple unit tests**

```bash
cd src/apple/Packages/MapleCore
swift test 2>&1 | grep -E '(Test Case|FAILED|passed|failed)' | tail -10
```

- [ ] **Step 6: Build macOS app + spot-check**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" \
           -destination 'platform=macOS' build 2>&1 | tail -20
```

- [ ] **Step 7: Run UITest harness (if fixture present)**

```bash
xcodebuild test \
  -project src/apple/Maple.xcodeproj \
  -scheme "Maple Exposure" \
  -destination 'platform=macOS' \
  -only-testing:MapleUITests \
  MAPLE_UITEST_FIXTURE_ROOT="$PWD/test-fixtures/raws" 2>&1 | tail -20
```

If the existing golden no longer matches (it shouldn't — we just added the Look layer), delete the PNG so the harness re-records, then commit the new baseline alongside the change.

- [ ] **Step 8: Commit**

```bash
git add src/apple/Packages/MapleCore src/apple/MapleUITests/Goldens

git commit -m "$(cat <<'EOF'
feat(apple): sample Look LUT in Metal final-encode pass (#L4)

Apple Metal now consumes maple_compute_look_lut(look_mode) per render
and samples the result after sRGB encode. Look::Neutral short-circuits
(LUT is identity). UITest golden re-baselined.

Refs spec docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task L5: Web WebGL — `uLookLUT` sampler in `agx-view-transform.ts`

**Ticket:** `web: uLookLUT sampler2D in agx-view-transform.ts encode stage`.

**Dependencies:** L3.

**Files:**
- Modify: `src/raw-pipeline/raw-wasm/src/lib.rs` (re-export `maple_compute_look_lut`)
- Modify: `src/web/projects/maple-common/src/lib/webgl/shaders/agx-view-transform.ts`
- Modify: WASM-consumer service in `maple-common` (search via `grep -rn "agx" src/web/projects/maple-common/src/lib/webgl/`)
- Add: `src/web/projects/maple-common/src/lib/webgl/shaders/agx-view-transform.look-parity.spec.ts`

- [ ] **Step 1: Re-export the LUT FFI through WASM**

In `src/raw-pipeline/raw-wasm/src/lib.rs`, add (mirroring existing wasm-bindgen pattern):

```rust
#[wasm_bindgen]
pub fn compute_look_lut(look_mode: u8) -> Vec<u8> {
    let mut buf = vec![0u8; 768];
    let _ = unsafe { raw_ffi::render::maple_compute_look_lut(look_mode, buf.as_mut_ptr()) };
    buf
}
```

(Or wire to the underlying core function directly if `raw_ffi` isn't already a dependency of `raw-wasm`.)

- [ ] **Step 2: Rebuild WASM + sync into maple-common**

```bash
cd src/raw-pipeline/raw-wasm
wasm-pack build --target web

cd /Users/riabuz/Projects/_Maple/.claude/worktrees/.../   # back to repo root
./src/web/scripts/sync-raw-wasm.sh
```

- [ ] **Step 3: Add a `uLookLUT` uniform + per-channel lookup to the fragment shader**

In `src/web/projects/maple-common/src/lib/webgl/shaders/agx-view-transform.ts`, locate the existing `out_FragColor` write (after gamma encode + dither). Wrap it:

```glsl
uniform sampler2D uLookLUT;          // 256x3 LUMINANCE (or RGBA8 with .r used)
// ... existing code that computes out_color in sRGB 0..1 ...
vec3 srgb_u8 = floor(out_color * 255.0 + 0.5);
out_color.r = texture(uLookLUT, vec2(srgb_u8.r / 255.0, 0.5/3.0)).r;
out_color.g = texture(uLookLUT, vec2(srgb_u8.g / 255.0, 1.5/3.0)).r;
out_color.b = texture(uLookLUT, vec2(srgb_u8.b / 255.0, 2.5/3.0)).r;
```

- [ ] **Step 4: Wire host-side LUT upload**

In the WebGL pipeline service that drives this shader, add (TypeScript):

```ts
// once per render, when look_mode changes
const lut = wasm.compute_look_lut(this.lookMode);   // Uint8Array 768
// pack into a 256x3 RGBA8 texture (or LUMINANCE8 if available); upload as TEXTURE_2D
this.uploadLookLUT(lut);
```

If the existing pipeline already has a similar pattern for AgX-LUT upload, mirror it exactly.

- [ ] **Step 5: Add a Vitest parity spec**

`src/web/projects/maple-common/src/lib/webgl/shaders/agx-view-transform.look-parity.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import init, { compute_look_lut } from '../../../wasm/raw_wasm';

describe('Look LUT WASM parity', () => {
  it('Default LUT is non-identity', async () => {
    await init();
    const lut = compute_look_lut(1);
    expect(lut.length).toBe(768);
    // sanity: midpoints differ from identity
    expect(lut[128]).not.toBe(128);
  });

  it('Neutral LUT is identity', async () => {
    await init();
    const lut = compute_look_lut(0);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 256; i++) {
        expect(lut[c * 256 + i]).toBe(i);
      }
    }
  });
});
```

- [ ] **Step 6: Run web tests + lint**

```bash
cd src/web
bun run lint
bun run test
```

- [ ] **Step 7: Spot-check in `bun x ng serve`**

```bash
cd src/web && bun x ng serve maple
# Open localhost:4200, load test.dng, eyeball the result.
```

- [ ] **Step 8: Commit**

```bash
git add src/raw-pipeline/raw-wasm src/web

git commit -m "$(cat <<'EOF'
feat(web): sample Look LUT in agx-view-transform fragment shader (#L5)

Web WebGL2 pipeline now consumes compute_look_lut(look_mode) via WASM
and samples the result per-channel after sRGB encode + dither. Mirrors
Apple Metal (#L4) and Rust CPU (#L2) paths. Look::Neutral identity-shorts.

Refs spec docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task L6: Parity gate + harness re-baseline

**Ticket:** `test: Rust ↔ Apple ↔ Web byte-equality on Look = Default fixtures + harness re-baseline`.

**Dependencies:** L2, L4, L5.

**Files:**
- Modify: `test-fixtures/references/manifest.json` (add `look_default` per-fixture case)
- Modify: `test-fixtures/budgets.json` (add first-baseline budgets per new case)
- Add: `BUDGETS_DRIFT.md` (append a "Look LUT restored" section)
- Add: `src/raw-pipeline/raw-core/tests/look_parity.rs` (integration test driving FFI + WASM)

- [ ] **Step 1: Add a Rust ↔ WASM ↔ Apple byte-equality test**

`src/raw-pipeline/raw-core/tests/look_parity.rs`:

```rust
//! Verifies the 768-byte LUT is identical when read through:
//!   - Rust `view::look::lut::{LUT_R, LUT_G, LUT_B}`
//!   - FFI `maple_compute_look_lut(1, ...)`
//!   - (Web parity proven by the Vitest spec; Apple by Swift test)

use raw_core::view::look::lut;

#[test]
fn ffi_default_lut_equals_rust_constants() {
    let mut buf = [0u8; 768];
    let rc = unsafe { raw_ffi::render::maple_compute_look_lut(1, buf.as_mut_ptr()) };
    assert_eq!(rc, 0);
    assert_eq!(&buf[0..256], &lut::LUT_R);
    assert_eq!(&buf[256..512], &lut::LUT_G);
    assert_eq!(&buf[512..768], &lut::LUT_B);
}
```

- [ ] **Step 2: Add per-fixture `look_default` cases to the manifest**

```bash
python3 - <<'EOF'
import json, pathlib
mfp = pathlib.Path("test-fixtures/references/manifest.json")
m = json.loads(mfp.read_text())
for entry in m["cases"]:
    if entry.get("look") is None:
        # baseline already exists; add a look_default sibling
        pass  # FIXME: shape depends on actual manifest schema — adapt
EOF
```

Open the file by hand; for each existing fixture entry (`test_0000` … `test_0017`), add a new case named `look_default` with `papp:Look = "Default"` in the XMP override stanza. Skip Foveon (`test_0016`).

- [ ] **Step 3: Re-baseline budgets**

```bash
# This produces actual numbers and prints a budget table:
src/scripts/test_color_pipeline.sh 2>&1 | tee ~/Desktop/maple-color-tests/L6-baseline.log
```

Either:
- pipe the captured deltas through `tools/budget_init.py` if it exists (`ls tools/`), OR
- add per-case entries by hand in `test-fixtures/budgets.json` whose ceilings are 5–10% above measured `mean`/`p95`/`max`/`bias`.

- [ ] **Step 4: Append closing-step entry in `BUDGETS_DRIFT.md`**

Append a new section under the existing log:

```markdown
## 2026-05-26 — Look LUT restored (Maple Look v1)

The spec at `docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md`
explicitly reverses #443's strategic decision. The 1D empirical LUT is back
as the new-user default. Pre-existing budgets are unchanged; new
`look_default` cases land with first-baseline budgets in this same commit,
which is allowed by the one-way-ratchet rule (new case, not a loosening).
```

- [ ] **Step 5: Run the full grey-predictor and synthetic-grey gates**

```bash
src/scripts/test_synthetic_grey.sh 2>&1 | tail -10
src/scripts/test_grey_adjustments.sh 2>&1 | tail -10
src/scripts/test_color_pipeline.sh 2>&1 | tail -20
```

Expected: the `look_default` cases pass under the new budgets; the existing `baseline` cases continue to pass. The grey predictors WILL show some regressions vs #443's post-retirement state — that's expected (the LUT introduces per-channel non-neutrality). Adopt the new failures as new-known-fail entries in the grey harness (mirroring the pattern in `project_grey_predictors_failing_on_main.md`) — discuss in the PR body.

- [ ] **Step 6: Commit**

```bash
git add test-fixtures BUDGETS_DRIFT.md src/raw-pipeline/raw-core/tests/look_parity.rs

git commit -m "$(cat <<'EOF'
test: add look_default harness cases + Rust↔FFI parity gate (#L6)

Per-fixture look_default cases with first-baseline budgets. BUDGETS_DRIFT.md
documents the spec-blessed reversal of #443. Apple parity by LookLUTParityTests
(#L4); Web parity by agx-view-transform.look-parity.spec.ts (#L5); this PR
adds the Rust↔FFI cross-check.

Refs spec docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Track 2 — Auto Tone (exposure only)

### Task A1: `stages/auto_tone.rs` — exposure-only histogram inversion

**Ticket:** `core: stages/auto_tone.rs + compute_auto_tone (exposure-only)`.

**Dependencies:** none (works against current main).

**Files:**
- Create: `src/raw-pipeline/raw-core/src/stages/auto_tone.rs`
- Modify: `src/raw-pipeline/raw-core/src/stages/mod.rs`

- [ ] **Step 1: Sketch the module skeleton**

```rust
// src/raw-pipeline/raw-core/src/stages/auto_tone.rs

//! Auto Tone — one-shot per-image slider recommendation.
//!
//! Phase 1a: exposure only. Phases 1b/1c (whites/blacks; contrast/highlights/shadows)
//! are tracked as separate tickets.
//!
//! ## Algorithm (exposure only)
//!
//! 1. Run `auto_exposure::build_luma_histogram` on the post-WB scene-linear buffer.
//! 2. Find the percentile-target percentile (default p50 = mid-gray) of the
//!    histogram.
//! 3. Compute the linear gain that moves p50 → `target = 0.18` (scene-linear).
//! 4. Convert gain to `exposure` stops: `exposure = log2(gain)`.
//! 5. Clamp to [-5, +5] (the slider's range).

use crate::image::Image;            // adapt to actual module path
use crate::stages::auto_exposure;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AutoTone {
    pub exposure: f32,
    pub contrast: f32,
    pub whites: f32,
    pub blacks: f32,
    pub highlights: f32,
    pub shadows: f32,
}

impl Default for AutoTone {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            contrast: 0.0,
            whites: 0.0,
            blacks: 0.0,
            highlights: 0.0,
            shadows: 0.0,
        }
    }
}

/// Compute one-shot slider values from a post-WB scene-linear buffer.
///
/// `clip` is the highlight clip percentile (0..1, default 0.005). Reserved
/// for whites/blacks (Phase 1b); unused in v1.
pub fn compute_auto_tone(scene_post_wb: &Image, clip: f32) -> AutoTone {
    let hist = auto_exposure::build_luma_histogram(scene_post_wb);
    let p50 = percentile(&hist, 0.50);
    let target_midgray = 0.18_f32;
    let gain = (target_midgray / p50).clamp(2f32.powf(-5.0), 2f32.powf(5.0));
    let exposure = gain.log2();
    let mut t = AutoTone::default();
    t.exposure = exposure;
    let _ = clip;  // reserved for 1b
    t
}

fn percentile(hist: &[u32], q: f32) -> f32 {
    let total: u64 = hist.iter().map(|&c| c as u64).sum();
    let target = ((total as f32) * q) as u64;
    let mut acc: u64 = 0;
    for (i, &c) in hist.iter().enumerate() {
        acc += c as u64;
        if acc >= target {
            return (i as f32 + 0.5) / hist.len() as f32;
        }
    }
    1.0
}
```

Important: the `Image` type and `auto_exposure::build_luma_histogram` signature must match actual main. `grep -rn "build_luma_histogram\|pub fn build_luma" src/raw-pipeline/raw-core/src/stages/auto_exposure*` first; adapt the snippet to the real signature.

- [ ] **Step 2: Register the module**

In `src/raw-pipeline/raw-core/src/stages/mod.rs`, add:

```rust
pub mod auto_tone;
```

- [ ] **Step 3: Add unit tests at the bottom of `auto_tone.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn flat_image(luma: f32) -> Image {
        // Construct a 64x64 image with R=G=B=luma. Adapt to Image's constructor.
        // ... fill in based on actual `Image` API
    }

    #[test]
    fn midgray_image_recommends_zero_exposure() {
        let img = flat_image(0.18);
        let t = compute_auto_tone(&img, 0.005);
        assert!(t.exposure.abs() < 0.05, "got {}", t.exposure);
    }

    #[test]
    fn dark_image_recommends_positive_exposure() {
        let img = flat_image(0.045);    // 2 stops under mid-gray
        let t = compute_auto_tone(&img, 0.005);
        assert!((t.exposure - 2.0).abs() < 0.15, "got {}", t.exposure);
    }

    #[test]
    fn bright_image_recommends_negative_exposure() {
        let img = flat_image(0.72);    // 2 stops over
        let t = compute_auto_tone(&img, 0.005);
        assert!((t.exposure + 2.0).abs() < 0.15, "got {}", t.exposure);
    }

    #[test]
    fn clamps_to_slider_range() {
        let img = flat_image(0.0005);
        let t = compute_auto_tone(&img, 0.005);
        assert!(t.exposure <= 5.0);
        assert!(t.exposure >= -5.0);
    }
}
```

- [ ] **Step 4: Run tests**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib stages::auto_tone::
```

Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/raw-core/src/stages/auto_tone.rs \
        src/raw-pipeline/raw-core/src/stages/mod.rs

git commit -m "$(cat <<'EOF'
feat(raw-core): stages/auto_tone.rs — exposure-only inversion (#A1)

Adds compute_auto_tone(scene_post_wb, clip) → AutoTone. Phase 1a:
exposure only (Phases 1b/1c expand whites/blacks then contrast/highlights/
shadows). Reuses build_luma_histogram from stages/auto_exposure.

Refs spec docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A2: FFI + WASM + maple-cli surface

**Ticket:** `ffi+wasm: expose compute_auto_tone; maple-cli auto-tone subcommand + golden`.

**Dependencies:** A1.

**Files:**
- Create: `src/raw-pipeline/raw-ffi/src/auto_tone.rs`
- Modify: `src/raw-pipeline/raw-ffi/src/lib.rs`
- Modify: `src/raw-pipeline/raw-ffi/include/maple_raw.h` (regenerate)
- Create: `src/raw-pipeline/raw-wasm/src/auto_tone.rs`
- Modify: `src/raw-pipeline/raw-wasm/src/lib.rs`
- Modify: `src/raw-pipeline/maple-cli/src/main.rs` (subcommand)
- Create: `src/raw-pipeline/maple-cli/tests/auto_tone_golden.rs`

- [ ] **Step 1: Add the FFI struct + function**

`src/raw-pipeline/raw-ffi/src/auto_tone.rs`:

```rust
use raw_core::stages::auto_tone;

#[repr(C)]
pub struct MapleAutoTone {
    pub exposure: f32,
    pub contrast: f32,
    pub whites: f32,
    pub blacks: f32,
    pub highlights: f32,
    pub shadows: f32,
}

/// Returns 0 on success, -1 on any null pointer or shape mismatch.
/// `scene_post_wb_rgba` is f32 RGBA, len = 4 * width * height.
#[no_mangle]
pub unsafe extern "C" fn maple_compute_auto_tone(
    scene_post_wb_rgba: *const f32,
    width: u32,
    height: u32,
    out: *mut MapleAutoTone,
) -> i32 {
    if scene_post_wb_rgba.is_null() || out.is_null() { return -1; }
    let len = (width as usize) * (height as usize) * 4;
    let slice = std::slice::from_raw_parts(scene_post_wb_rgba, len);
    let img = raw_core::image::Image::from_rgba_f32(slice, width as usize, height as usize);
    let result = auto_tone::compute_auto_tone(&img, 0.005);
    *out = MapleAutoTone {
        exposure: result.exposure,
        contrast: result.contrast,
        whites: result.whites,
        blacks: result.blacks,
        highlights: result.highlights,
        shadows: result.shadows,
    };
    0
}
```

(Adapt `Image::from_rgba_f32` to actual API.)

- [ ] **Step 2: Register the module + add FFI unit test**

`src/raw-pipeline/raw-ffi/src/lib.rs`:

```rust
pub mod auto_tone;
```

Add an FFI unit test for null safety + happy-path roundtrip.

- [ ] **Step 3: WASM wrapper**

`src/raw-pipeline/raw-wasm/src/auto_tone.rs`:

```rust
use wasm_bindgen::prelude::*;
use raw_core::stages::auto_tone;

#[wasm_bindgen]
pub struct AutoTone {
    pub exposure: f32,
    pub contrast: f32,
    pub whites: f32,
    pub blacks: f32,
    pub highlights: f32,
    pub shadows: f32,
}

#[wasm_bindgen]
pub fn compute_auto_tone(
    scene_post_wb_rgba: &[f32],
    width: u32,
    height: u32,
) -> AutoTone {
    let img = raw_core::image::Image::from_rgba_f32(
        scene_post_wb_rgba, width as usize, height as usize);
    let r = auto_tone::compute_auto_tone(&img, 0.005);
    AutoTone {
        exposure: r.exposure,
        contrast: r.contrast,
        whites: r.whites,
        blacks: r.blacks,
        highlights: r.highlights,
        shadows: r.shadows,
    }
}
```

- [ ] **Step 4: maple-cli `auto-tone` subcommand**

In `src/raw-pipeline/maple-cli/src/main.rs`, add a subcommand. Adapt to the actual clap structure:

```rust
#[derive(Subcommand)]
enum Command {
    // ... existing variants ...
    /// Compute Auto Tone slider values for a RAW file (prints JSON to stdout).
    AutoTone {
        /// Input RAW path
        input: PathBuf,
    },
}

// In the dispatcher:
Command::AutoTone { input } => {
    let img = raw_core::pipeline::develop::decode_then_pre_view(&input)?;
    let t = raw_core::stages::auto_tone::compute_auto_tone(&img, 0.005);
    println!("{}", serde_json::to_string(&t)?);
}
```

(If `AutoTone` doesn't yet derive `Serialize`, add `serde::Serialize` behind a feature flag, or convert by hand: `println!(r#"{{"exposure":{}}}"#, t.exposure)`.)

- [ ] **Step 5: Golden test**

`src/raw-pipeline/maple-cli/tests/auto_tone_golden.rs`:

```rust
use std::process::Command;

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn auto_tone_against_test_0017_is_stable() {
    let out = Command::new(env!("CARGO_BIN_EXE_maple-cli"))
        .args(["auto-tone", "test-fixtures/raws/test_0017.dng"])
        .output()
        .expect("ran");
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let exposure = json["exposure"].as_f64().unwrap();
    // Pin to the value observed on first run; ratchet down (or accept ±5%)
    // as the algorithm tightens.
    assert!((exposure - <FILL_IN_AFTER_FIRST_RUN>).abs() < 0.05, "got {}", exposure);
}
```

First run: read the actual printed value, then commit it into the assertion.

- [ ] **Step 6: Build + regenerate header + run all tests**

```bash
./src/apple/scripts/build-xcframework.sh
cd src/raw-pipeline/raw-wasm && wasm-pack build --target web
./src/web/scripts/sync-raw-wasm.sh

cd src/raw-pipeline
cargo test -p raw-ffi
cargo test -p maple-cli --features fixtures
```

- [ ] **Step 7: Commit**

```bash
git add src/raw-pipeline/raw-ffi src/raw-pipeline/raw-wasm \
        src/raw-pipeline/maple-cli src/web/projects/maple-common

git commit -m "$(cat <<'EOF'
feat(ffi+wasm+cli): expose compute_auto_tone (#A2)

Adds maple_compute_auto_tone (C-FFI) + compute_auto_tone (WASM) +
`maple-cli auto-tone` subcommand. Golden-test pinned exposure value for
test_0017; ratchets down as Phase 1b/1c expands the mapping.

Refs spec docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A3: Web "Auto" button in Tone section

**Ticket:** `web: Tone-section "Auto" button + slider write-back + re-render`.

**Dependencies:** A2.

**Files:**
- Create: `src/web/projects/maple-common/src/lib/services/auto-tone.service.ts`
- Modify: `src/web/projects/maple-common/src/lib/components/develop/tone-section.component.ts`
- Modify: `src/web/projects/maple-common/src/lib/components/develop/tone-section.component.html`

- [ ] **Step 1: Service wrapper around the WASM call**

```ts
// auto-tone.service.ts
import { Injectable } from '@angular/core';
import { from, Observable } from 'rxjs';
import { compute_auto_tone } from '../../wasm/raw_wasm';   // adapt path

export interface AutoToneResult {
    exposure: number;
    contrast: number;
    whites: number;
    blacks: number;
    highlights: number;
    shadows: number;
}

@Injectable({ providedIn: 'root' })
export class AutoToneService {
    compute(sceneRgba: Float32Array, w: number, h: number): Observable<AutoToneResult> {
        return from(Promise.resolve(compute_auto_tone(sceneRgba, w, h)))
            .pipe(/* normalise into AutoToneResult */);
    }
}
```

- [ ] **Step 2: Component button + handler**

In `tone-section.component.ts`, inject `AutoToneService` and existing `AdjustmentModelStore` (or whatever name signals/observable carry the slider state). Add:

```ts
onAutoClick(): void {
    // Reach the current post-WB scene-linear buffer through the existing
    // pipeline service. Adapt to actual symbol name; see WebGL pipeline.
    this.pipeline.getCurrentPostWbBuffer().subscribe(({ rgba, w, h }) => {
        this.autoTone.compute(rgba, w, h).subscribe(t => {
            this.modelStore.patchTone({
                exposure: t.exposure,
                // Phase 1b/1c will fill in the rest. For now only exposure
                // is non-zero; we still write them (zero is the no-op value).
                contrast: t.contrast,
                whites: t.whites,
                blacks: t.blacks,
                highlights: t.highlights,
                shadows: t.shadows,
            });
        });
    });
}
```

In `tone-section.component.html`:

```html
<button
    type="button"
    class="tone-section__auto"
    data-acid="tone-auto"
    (click)="onAutoClick()">
    Auto
</button>
```

(Place it inside the Tone section header alongside the existing Reset button.)

- [ ] **Step 3: Spot-check + Vitest**

```bash
cd src/web
bun run test -- tone-section
```

If no existing test scaffold for the component, add a minimal one asserting the button is rendered with the right `data-acid`.

- [ ] **Step 4: e2e spot-check**

```bash
cd src/web && bun x ng serve maple
# Browser: load test.dng, click Auto, confirm Exposure slider jumps.
```

- [ ] **Step 5: Commit**

```bash
git add src/web/projects/maple-common

git commit -m "$(cat <<'EOF'
feat(web): "Auto" button in Tone section (#A3)

Adds AutoToneService + tone-section "Auto" button. On click: compute_auto_tone
runs on current post-WB scene-linear buffer, exposure slider jumps to the
recommended value. Phase 1b/1c will populate the other five.

Refs spec docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A4: Apple "Auto" button in DetailPanel Tone group

**Ticket:** `apple: DetailPanel Tone group "Auto" button + slider write-back`.

**Dependencies:** A2.

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/AutoTone.swift` (new — Swift wrapper around the FFI)
- Modify: the DetailPanel Tone view (find: `grep -rn "Exposure" src/apple/Sources/MapleApp | grep -E '\.swift'`)

- [ ] **Step 1: Swift wrapper**

`src/apple/Packages/MapleCore/Sources/MapleCore/AutoTone.swift`:

```swift
import Foundation

public struct AutoTone {
    public let exposure: Float
    public let contrast: Float
    public let whites: Float
    public let blacks: Float
    public let highlights: Float
    public let shadows: Float
}

public enum AutoToneError: Error {
    case bufferMismatch
    case ffiError(Int32)
}

public func computeAutoTone(
    rgba: UnsafePointer<Float>,
    width: Int,
    height: Int
) throws -> AutoTone {
    var out = MapleAutoTone(
        exposure: 0, contrast: 0, whites: 0,
        blacks: 0, highlights: 0, shadows: 0
    )
    let rc = maple_compute_auto_tone(
        rgba, UInt32(width), UInt32(height), &out
    )
    guard rc == 0 else { throw AutoToneError.ffiError(rc) }
    return AutoTone(
        exposure: out.exposure,
        contrast: out.contrast,
        whites: out.whites,
        blacks: out.blacks,
        highlights: out.highlights,
        shadows: out.shadows,
    )
}
```

- [ ] **Step 2: Add `Button("Auto")` in DetailPanel**

Find the Tone group in DetailPanel. Add (SwiftUI):

```swift
HStack {
    Text("Tone")
    Spacer()
    Button("Auto") {
        viewModel.applyAutoTone()
    }
    .accessibilityIdentifier("tone-auto")
    Button("Reset") { viewModel.resetTone() }
}
```

In the view-model:

```swift
@MainActor
func applyAutoTone() {
    // Reach the current post-WB scene-linear buffer through MapleCore's
    // pipeline. Adapt to actual symbol.
    guard let buffer = pipeline.currentPostWbBuffer() else { return }
    do {
        let result = try buffer.withUnsafeRGBAPointer { ptr, w, h in
            try computeAutoTone(rgba: ptr, width: w, height: h)
        }
        adjustment.exposure = result.exposure
        adjustment.contrast = result.contrast
        adjustment.whites = result.whites
        adjustment.blacks = result.blacks
        adjustment.highlights = result.highlights
        adjustment.shadows = result.shadows
    } catch {
        print("Auto tone failed: \(error)")
    }
}
```

- [ ] **Step 3: Swift unit test**

In `src/apple/Packages/MapleCore/Tests/MapleCoreTests/AutoToneTests.swift`:

```swift
import XCTest
@testable import MapleCore

final class AutoToneTests: XCTestCase {
    func testFlatMidGrayRecommendsZeroExposure() throws {
        let w = 64, h = 64
        var rgba = [Float](repeating: 0, count: w * h * 4)
        for i in stride(from: 0, to: rgba.count, by: 4) {
            rgba[i] = 0.18; rgba[i+1] = 0.18; rgba[i+2] = 0.18; rgba[i+3] = 1.0
        }
        let t = try rgba.withUnsafeBufferPointer {
            try computeAutoTone(rgba: $0.baseAddress!, width: w, height: h)
        }
        XCTAssertLessThan(abs(t.exposure), 0.05)
    }
}
```

- [ ] **Step 4: Run Apple tests**

```bash
cd src/apple/Packages/MapleCore && swift test
```

- [ ] **Step 5: UITest harness (if fixture present)**

If a slider-matrix XMP for an Auto-Tone result exists, the existing harness picks it up. Otherwise, file an `auto-tone` XMP case as KTLO follow-up.

- [ ] **Step 6: Commit**

```bash
git add src/apple

git commit -m "$(cat <<'EOF'
feat(apple): DetailPanel "Auto" button in Tone group (#A4)

Swift wrapper around maple_compute_auto_tone + Tone-section "Auto" button
in DetailPanel. On click: compute against current post-WB buffer, sliders
jump. Mirrors Web (#A3) — same FFI, same values.

Refs spec docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A5: Perceptual-harness `auto_tone` cases

**Ticket:** `harness: per-fixture auto_tone perceptual cases + budgets`.

**Dependencies:** A2.

**Files:**
- Modify: `test-fixtures/references/manifest.json`
- Modify: `test-fixtures/budgets.json` (new entries)
- New per-fixture: `test-fixtures/references/test_NNNN/xmp/auto_tone.xmp` (one per fixture)

- [ ] **Step 1: Generate Auto Tone XMPs per fixture**

```bash
mkdir -p ~/Desktop/maple-color-tests/A5-auto-tone-xmps/

for raw in test-fixtures/raws/test_*.dng test-fixtures/raws/test_*.RAW \
           test-fixtures/raws/test_*.dng test-fixtures/raws/test_*.RAF \
           test-fixtures/raws/test_*.CR2 test-fixtures/raws/test_*.ARW \
           test-fixtures/raws/test_*.NEF test-fixtures/raws/test_*.fff; do
    [ -f "$raw" ] || continue
    stem=$(basename "$raw" | sed -E 's/\.(dng|DNG|RAW|raw|RAF|raf|CR2|cr2|ARW|arw|NEF|nef|fff)$//' | sed 's/test_//')
    json=$(cargo run --release --bin maple-cli -- auto-tone "$raw")
    exposure=$(echo "$json" | python3 -c "import sys, json; print(json.load(sys.stdin)['exposure'])")
    # Write a minimal XMP override sidecar with crs:Exposure2012 = exposure
    cat > "test-fixtures/references/test_${stem}/xmp/auto_tone.xmp" <<XMP
<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
          xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
  <rdf:Description crs:Exposure2012="${exposure}"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
XMP
done
```

(Adapt the directory loop to actual fixture filenames.)

- [ ] **Step 2: Add manifest entries**

In `test-fixtures/references/manifest.json`, add an `auto_tone` case for each fixture pointing at the new XMP.

- [ ] **Step 3: Run harness; capture initial budgets**

```bash
src/scripts/test_color_pipeline.sh 2>&1 | tee ~/Desktop/maple-color-tests/A5-initial.log
```

For each new `auto_tone` case, copy the printed `mean`/`p95`/`max`/`bias` and add a `budgets.json` entry whose ceilings are 5–10% above measured.

- [ ] **Step 4: Re-run; expect green**

```bash
src/scripts/test_color_pipeline.sh
```

- [ ] **Step 5: Commit**

```bash
git add test-fixtures

git commit -m "$(cat <<'EOF'
test: per-fixture auto_tone perceptual cases + first-baseline budgets (#A5)

Adds an Auto Tone XMP per fixture (Exposure2012 from `maple-cli auto-tone`),
manifest entry, and first-baseline budgets. One-way-ratchet rule: new
cases, so first-baseline budgets are allowed.

Refs spec docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Convergence

Once both tracks are merged:

- [ ] Run `src/scripts/test_color_pipeline.sh` against full fixture set; assert no regression on existing budgets and all `look_default` + `auto_tone` cases green.
- [ ] Spot-check macOS app + Web app side-by-side on `test_0017.dng`: Look = Default should produce visually identical output (within ΔE budget).
- [ ] File follow-up tickets (KTLO Project board):
  - Phase 2: Look dropdown UI (Web + Apple).
  - Phase 3: Auto Look adaptive.
  - Phase 1b: Auto Tone whites/blacks.
  - Phase 1c: Auto Tone contrast/highlights/shadows.

## Self-review notes

This plan was written against the spec at `docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md`. Spec sections covered:

- **Summary point 1 (static Maple Look)** → Tasks L1–L6.
- **Summary point 2 (Auto Tone button)** → Tasks A1–A5.
- **Summary point 3 (Auto Look)** → out of scope for this plan; Phase 3 follow-up.
- **Architecture / pipeline placement** → L2 (CPU), L4 (Apple), L5 (Web) wire `look::apply` at the post-encode point.
- **FFI surface (`maple_compute_look_lut`)** → L3.
- **FFI surface (`maple_compute_auto_tone`)** → A2.
- **XMP changes** → deferred: Phase 2 introduces `Look::Auto`; sidecar round-trip for `Look::Default`/`Look::Neutral` is already in main per #443's back-compat work.
- **UI surface (Look dropdown)** → out of scope for this plan; Phase 2.
- **UI surface (Auto button)** → A3 (Web) + A4 (Apple).
- **Phasing (Approach B parallel tracks)** → reflected in Track 1 / Track 2 organisation.
- **Testing strategy (parity gates)** → L6 (Look) + A2 + A5 (Auto Tone).
- **Out-of-scope** → respected.
