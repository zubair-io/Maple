# Ticket #07 — LinearRaw DNG Decode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Brief:** [`.archived-plans/specs/2026-04-25-ticket-07-linearraw-decode-brief.md`](../specs/2026-04-25-ticket-07-linearraw-decode-brief.md). The brief's § 1 picks `image::CfaPattern::LinearRgb` as the carrier (not a parallel `bool`), § 2 inserts the new branch at the top of `develop_scene_linear_from_raw_with_quality`, § 3 fixes the WB double-apply via a `DcpProfile::wb_already_baked` flag, and § 6 sets the acceptance gate at `BUDGET=25` for the two LinearRaw fixtures (looser than the Bayer 15 because of unsupported `ProfileGainTableMap` on test_0013 and 8-bit-per-channel quantization slack on test_0006).
>
> **Source ticket:** [`docs/tickets/07-linearraw-dng-decode.md`](../../tickets/07-linearraw-dng-decode.md). Investigation report: [`docs/measurement/2026-04-25-color-harness-catastrophic-bias-investigation.md`](../../measurement/2026-04-25-color-harness-catastrophic-bias-investigation.md). Both isolate the bug to the `LinearRaw` arm at [`decode.rs:130-136`](../../../src/raw-pipeline/raw-core/src/decode.rs) silently substituting `CfaPattern::Rggb`, downstream `linearize::sensor_linearize` ([`linearize.rs:8-30`](../../../src/raw-pipeline/raw-core/src/linearize.rs)) reading `raw_data[y*w..y*w+w]` as 1-SPP over an interleaved 3-SPP scanline, and `dcp::apply` re-applying `AsShotNeutral` on top of pre-baked WB.
>
> **Harness state:** [`src/scripts/test_color_pipeline.sh`](../../../src/scripts/test_color_pipeline.sh) lines 120-135 currently SKIPs LinearRaw fixtures by default (commit `3bdc205`), gated on `INCLUDE_LINEARRAW=1` to opt back in. Both LinearRaw fixtures (test_0006, test_0013) are catastrophic at the current Bayer pipeline (mean ΔE 50.3 / 36.6 with +0.69 / +0.29 channel bias). Acceptance: SKIP → PASS at BUDGET=25.
>
> **Parallel work:** A separate agent is running Plan 3 M2 spikes on different files (`src/web/projects/maple-common/...`, WebGL shaders). No conflicting source files; this plan touches `raw-core` only.

**Goal:** Route `PhotometricInterpretation = LinearRaw` DNGs through a dedicated decode + develop branch that (a) tags the source as 3-channel RGB at decode time via a new `CfaPattern::LinearRgb` variant, (b) builds the post-demosaic `CameraNativeLinearRgb` `Image` directly from interleaved RGB samples, skipping `linearize::sensor_linearize` and `demosaic::*`, and (c) prevents `dcp::apply` from double-applying `AsShotNeutral` via a new `DcpProfile::wb_already_baked` flag. After the fix, `BUDGET=25 src/scripts/test_color_pipeline.sh` passes test_0006 and test_0013 with mean ΔE in the same ballpark as the existing Bayer fixtures (≤ 25), per-channel bias under 0.05, no regression on the five Bayer fixtures at BUDGET=15.

**Architecture:**

1. **No new spike — the brief is well-grounded.** The investigation report § 5 walks a concrete pixel through the bug with measured ΔE numbers, the ticket § Pointers names exact `decode.rs` / `linearize.rs` / `dcp.rs` / `pipeline.rs` line numbers, and the brief's § 1-§ 3 chose detection / chain / WB mechanisms that map 1:1 onto existing code shapes. Task 1 is a written-down preflight that confirms — by `grep` and `sed` against the source-of-truth files — that the brief's assumptions still hold (no surprise: `RawImage` lives in `image.rs`, not `raw_image.rs` as the ticket § Pointers says; `CfaPattern` is 4-variant; `DcpProfile` has 5 fields). No spike code is needed.

2. **Detection at the decoder boundary, not deeper.** Per brief § 1, the `LinearRaw` arm at [`decode.rs:130-136`](../../../src/raw-pipeline/raw-core/src/decode.rs) is the only place rawler's typed photometric enum is visible. We replace the `CfaPattern::Rggb` fallback with a new `CfaPattern::LinearRgb` variant (Task 3). Every existing `match` site on `CfaPattern` (currently ~6 call-sites in `linearize.rs`, `demosaic/{bilinear, half_res, hamilton_adams}.rs`, plus `image.rs:60-71` for `color_at`) becomes a compile error until handled — the linter we want, since the bug was a silent fallthrough.

3. **One develop-chain branch, at one site.** Per brief § 2, the new branch goes at the top of `develop_scene_linear_from_raw_with_quality` ([`pipeline.rs:77-134`](../../../src/raw-pipeline/raw-core/src/pipeline.rs)). The shape is `match raw.cfa { LinearRgb => linearize::linearraw_to_camera_rgb(raw)?, _ => existing-mosaic-then-demosaic }`. The new helper lives in `linearize.rs` next to `sensor_linearize` (one module is the right home — both produce post-decode camera-RGB `Image`s, just from different photometric inputs) and produces a `CameraNativeLinearRgb` `Image` directly. Demosaic is bypassed; the rest of the chain is untouched.

4. **WB fix isolated to DCP, not a side-channel into pipeline.rs.** Per brief § 3, `DcpProfile` gains a `wb_already_baked: bool` field (default `false`). `profile_for` sets it to `true` when `raw.cfa == LinearRgb`. The `interpolated_profile` and single-CM-fallback paths both consume the flag at `scene_white_xyz` derivation time: when set, use `inv(CM) · (1, 1, 1)` instead of `inv(CM) · as_shot_neutral`. The hot loop in `apply` is unchanged — it consumes `scene_white_xyz`, not `as_shot_neutral`. **Important:** this fix is mathematically equivalent to "rewrite `raw.as_shot_neutral` to `[1.0, 1.0, 1.0]` in the LinearRaw decode path before handing it to `dcp::profile_for`," but the flag preserves the metadata for downstream debug / XMP round-tripping.

5. **One synthesized Rust unit test exercises the entire path end-to-end.** Per ticket § Acceptance, the most valuable Rust test is `decode::open` on a synthetic 3-SPP LinearRaw fixture (no fixture file needed — we can build a tiny in-memory DNG with rawler? — actually no, rawler doesn't expose synthesis; we instead unit-test at the post-decode boundary using a hand-built `RawImage { cfa: LinearRgb, raw_data: interleaved-RGB, ... }` and verify `linearize::linearraw_to_camera_rgb` lays the data into `Image::pixels` channel-major). Per brief § 5, the **integration** evidence is the parity harness — test_0006 and test_0007 (same CR2 source, both photometric paths) become a regression dyad: any future change that breaks one without the other is the bug.

6. **Harness gate flips SKIP → PASS in the same commit as the fix.** Per brief § 6 and ticket § Acceptance, the harness's `INCLUDE_LINEARRAW`-gated skip ([`test_color_pipeline.sh:128-135`](../../../src/scripts/test_color_pipeline.sh)) gets removed. Default behavior changes from "skip LinearRaw" to "include LinearRaw, gated on the standard BUDGET". The `INCLUDE_LINEARRAW` env var is also removed (no caller relies on it; it was always a one-direction kill-switch). Documentation in the harness header updates from "LinearRaw fixtures are skipped — see ticket #07" to "all DNG photometric interpretations covered."

7. **`profile_gain_table_map` and `LinearizationTable` policy.** test_0013 carries a `ProfileGainTableMap` we don't implement (per ticket § Notes); the brief § 7 picks "accept residual ΔE" over "reject loudly" for the v1 land. The BUDGET=25 budget absorbs that residual. test_0013 also carries a `LinearizationTable` that rawler applies during decode (per ticket § Proposal point 4); rawler's `raw_data` is already linearized, so `linearraw_to_camera_rgb` just normalizes by white_level and is done — no extra LUT pass needed.

**Tech Stack:**

- Rust (`raw-core`) — additions to:
  - `src/raw-pipeline/raw-core/src/image.rs` — `CfaPattern::LinearRgb` variant + `color_at` arm (`unreachable!`).
  - `src/raw-pipeline/raw-core/src/decode.rs` — `LinearRaw` arm builds `CfaPattern::LinearRgb` instead of falling back to `Rggb`. Test for `as_shot_neutral` value and structural fields.
  - `src/raw-pipeline/raw-core/src/linearize.rs` — new public `linearraw_to_camera_rgb(raw: &RawImage) -> Image` function. Existing `sensor_linearize` returns `Err` (or panics in debug; pick `Result` for symmetry — TBD in Task 4 step 4.4) when called with `LinearRgb` cfa, so a future bug surfaces fast.
  - `src/raw-pipeline/raw-core/src/pipeline.rs` — `develop_scene_linear_from_raw_with_quality` opens with the new branch. `develop_scene_linear_from_padded_mosaic` (tile path) likewise short-circuits to `Err` on `LinearRgb` (LinearRaw + tile rendering is out of scope for v1).
  - `src/raw-pipeline/raw-core/src/color/dcp.rs` — `DcpProfile::wb_already_baked: bool`, set in `profile_for` and `interpolated_profile`, consumed in the `scene_white_xyz` derivation. `apply` is unchanged.
  - `src/raw-pipeline/raw-core/src/demosaic/{bilinear,hamilton_adams,half_res}.rs` — add `unreachable!()` arm in the `match raw.cfa` for `LinearRgb` (defensive: these functions should never be called on a `LinearRgb` mosaic).
- Bash — `src/scripts/test_color_pipeline.sh` loses the `INCLUDE_LINEARRAW`-gated skip (lines 28-35 docstring, line 52 default, lines 120-135 skip block).
- Test fixtures — none added. test_0006.DNG / test_0013.DNG are gitignored but already present on developer machines (per investigation report). The control pair is test_0006 (LinearRaw) ↔ test_0007 (Bayer of same CR2 shot).
- Build glue — `./src/apple/scripts/build-xcframework.sh` IS rerun (Rust-source changes) before the `swift test` line. The harness command builds `maple-cli` automatically; no separate xcframework-rebuild is needed for the harness itself.

**Out of scope (explicit):**

- **`ProfileGainTableMap` honoring** (test_0013). Acceptance budget BUDGET=25 absorbs the residual. Separate ticket once implementation parity with Apple is feasible.
- **16-bit-per-channel LinearRaw.** Code path likely works; not exercised by current fixtures, not gated.
- **Non-RGB color spaces in LinearRaw** (e.g. CMYK-interpreted DNG). Reject with `Error::UnsupportedCfa`.
- **DNG enhanced color encoding** (`PhotometricInterpretation = 51177`). Separate ticket.
- **`BlackIsZero` monochrome.** Already rejected at [`decode.rs:137-139`](../../../src/raw-pipeline/raw-core/src/decode.rs); unchanged.
- **Tile rendering on LinearRaw.** `render_scene_linear_tile_from_raw_with_quality` errors with a "LinearRgb" message when `raw.cfa == LinearRgb`. Tiles on LinearRaw are a follow-up; v1 use case is full-image preview which the non-tile path covers.
- **Budget tightening** (LinearRaw to 20 → 15). Lands as a separate downward ratchet commit per CLAUDE.md § "Objective color testing — no eyeballing." The point of v1 is "magenta wash gone, fixtures reach the harness's structural-mismatch tier."
- **Web/WASM regression check.** Detection is in `decode.rs`, which compiles for both targets via the shared `raw-core` crate; the `wasm` shim re-exports the develop functions. No WASM-specific code path. The Web team can confirm via their own harness; not gated here.
- **Apple xcframework rebuild gate.** The fix is pure Rust, so the xcframework rebuild is a routine post-change action. No separate Apple-side parity test (the FFI cross-check infrastructure already covers this; if it surfaces a regression, the spec's "parity before features" rule kicks in).
- **`dump_pixel` example update.** The example already accepts any `RawImage`; once decode produces a `LinearRgb` cfa, the example traces it correctly. The ticket § Implementation sketch suggests adding a `decode-linearraw` example next to `dump_pixel`; we defer that to a follow-up so the v1 land is small.

---

## File Structure

**Rust core (read-write):**

- Modify: `src/raw-pipeline/raw-core/src/image.rs` — extend `CfaPattern` with `LinearRgb` variant. Add `unreachable!()` arm to `color_at` (LinearRgb has no Bayer position). Update doc comment.
- Modify: `src/raw-pipeline/raw-core/src/decode.rs` — replace the `RawPhotometricInterpretation::LinearRaw` arm at lines 130-136 to emit `CfaPattern::LinearRgb` instead of `CfaPattern::Rggb`. Add a new test `decode_linearraw_uses_linearrgb_cfa` that round-trips a hand-built `RawImage`-shaped buffer (no fixture file needed; we test the post-decode side-effect). Per ticket § Pointers, `RawImage` lives in `image.rs` (not `raw_image.rs` — the ticket has a typo); confirm in Task 1.
- Modify: `src/raw-pipeline/raw-core/src/linearize.rs` — add `linearraw_to_camera_rgb(raw: &RawImage) -> Result<Image>` public function. Returns `Image` in `ColorSpace::CameraNativeLinearRgb` (NOT `CameraNativeMosaic` — that's the post-`sensor_linearize` space; we skip the mosaic stage entirely). Reads `raw.raw_data` as triples, normalizes by `(white_level - black_level[0])` per channel (LinearRaw black levels are usually 0/0/0 per investigation § 1, but we honor the metadata). `sensor_linearize` itself adds an `assert!(raw.cfa != CfaPattern::LinearRgb)` at the top — defense-in-depth.
- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs` — `develop_scene_linear_from_raw_with_quality` opens with `let mut camera_rgb = match raw.cfa { CfaPattern::LinearRgb => linearize::linearraw_to_camera_rgb(raw)?, _ => { let mosaic = linearize::sensor_linearize(raw); demosaic-existing... } };`. The `stage("linearize", ...)` and `stage("demosaic", ...)` timing wrappers move inside the match arms so per-stage timing still works for both branches. `develop_scene_linear_from_padded_mosaic` (tile path) returns `Err(Error::Pipeline("LinearRaw not supported in tile path"))` on `LinearRgb` cfa; same for `render_scene_linear_tile_from_raw_with_quality`.
- Modify: `src/raw-pipeline/raw-core/src/color/dcp.rs` — `DcpProfile` gains `wb_already_baked: bool`. Default `false` everywhere except `profile_for(raw)` when `raw.cfa == CfaPattern::LinearRgb`. `interpolated_profile` and the single-CM fallback both compute `scene_white_xyz` differently when the flag is set: `inv(CM) · (1, 1, 1)` instead of `inv(CM) · as_shot_neutral`. Add a unit test `wb_already_baked_skips_as_shot_neutral` that hand-constructs a `RawImage` with `LinearRgb` cfa + a known CM + a non-identity AsShotNeutral, and verifies `apply` on a neutral input pixel produces a near-neutral output.
- Modify: `src/raw-pipeline/raw-core/src/demosaic/bilinear.rs`, `src/raw-pipeline/raw-core/src/demosaic/half_res.rs`, `src/raw-pipeline/raw-core/src/demosaic/hamilton_adams.rs` — `match cfa { LinearRgb => unreachable!("demosaic called on already-demosaiced LinearRaw") }` in each file's `match` site. Pure compile-error gate.

**Bash (read-write):**

- Modify: `src/scripts/test_color_pipeline.sh` — drop the `INCLUDE_LINEARRAW`-gated skip block at lines 120-135. Drop the `INCLUDE_LINEARRAW` line in the env override docstring at lines 28-35 and the default at line 52. Update the comment on usage lines 32-35 to remove the `INCLUDE_LINEARRAW` example. Replace with a single block comment explaining the harness now covers all photometric interpretations.

**Rust core (read-only during verification):**

- `src/raw-pipeline/raw-core/src/image.rs:50-71` — `CfaPattern` enum + `color_at` source. The Task 2 edit lands at `:53` (variant addition) and `:65-69` (color_at match arms).
- `src/raw-pipeline/raw-core/src/color/dcp.rs:18-66` — `DcpProfile` struct. Task 5 edits add the `wb_already_baked` field and update `from_embedded_cm`.
- `src/raw-pipeline/raw-core/src/color/dcp.rs:210-238` — `interpolated_profile` consumes the flag.
- `src/raw-pipeline/raw-core/src/color/dcp.rs:248-310` — `profile_for` sets the flag.
- `src/raw-pipeline/raw-core/src/pipeline.rs:77-134` — `develop_scene_linear_from_raw_with_quality` is the develop-chain entry; the branch lands at `:82` (top of function, before the `stage("linearize", ...)` wrapper).
- `src/raw-pipeline/raw-core/src/pipeline.rs:473-511` — `develop_scene_linear_from_padded_mosaic` (tile path) gets a `LinearRgb` error short-circuit at the top.

**Build artifacts (touched):**

- `src/apple/Frameworks/RawPipeline.xcframework/...` — the xcframework will need rebuild via `./src/apple/scripts/build-xcframework.sh` after Rust changes land. **Out of this plan's gate** — the harness uses `maple-cli` (Rust-side, built fresh by the harness), not the xcframework. Apple-side parity is verified separately when a developer pulls and rebuilds.

---

## Ordering constraint

**Tasks must be done in the order: Task 1 (preflight) → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 (M1 milestone gate).**

- **Task 1 is preflight, not spike.** The brief is well-grounded; Task 1 confirms the source files match the brief's assumptions (e.g. `RawImage` location, `CfaPattern` shape, `DcpProfile` fields, `develop_*` function signatures).
- **Task 2 adds `CfaPattern::LinearRgb`.** Cascades into a wave of compile errors in `decode.rs`, `linearize.rs`, `demosaic/*.rs` — each is fixed in Tasks 3-4. Cargo guarantees no missed call sites.
- **Task 3 wires the decoder to emit `LinearRgb`.** Replaces the `Rggb` fallback at [`decode.rs:130-136`](../../../src/raw-pipeline/raw-core/src/decode.rs).
- **Task 4 adds `linearize::linearraw_to_camera_rgb` and the pipeline branch.** Together with Task 3, this is the "decode + develop produces non-magenta output" milestone. After Task 4, a manual harness run with `INCLUDE_LINEARRAW=1` should show the fixtures rendering correctly modulo WB double-apply.
- **Task 5 fixes the WB double-apply.** Adds the `wb_already_baked` flag to `DcpProfile`, sets it in `profile_for` for LinearRgb sources, consumes it in `scene_white_xyz` derivation. After Task 5, `INCLUDE_LINEARRAW=1` should pass at BUDGET=25.
- **Task 6 adds the synthesized Rust unit test.** A hand-built `RawImage { cfa: LinearRgb }` round-trip covers `linearraw_to_camera_rgb` correctness without touching disk.
- **Task 7 is the M1 milestone gate.** Drops the harness skip, runs the full harness at BUDGET=25, confirms test_0006 + test_0013 PASS and the five Bayer fixtures still PASS at BUDGET=15.

After every task: `cd src/raw-pipeline && cargo test -p raw-core --lib`. After Task 7: `BUDGET=25 src/scripts/test_color_pipeline.sh` (full harness, no skips).

---

## Task 1: Preflight — confirm brief assumptions match source

**Files:**
- Read-only: `src/raw-pipeline/raw-core/src/image.rs`
- Read-only: `src/raw-pipeline/raw-core/src/decode.rs`
- Read-only: `src/raw-pipeline/raw-core/src/linearize.rs`
- Read-only: `src/raw-pipeline/raw-core/src/pipeline.rs`
- Read-only: `src/raw-pipeline/raw-core/src/color/dcp.rs`
- Read-only: `src/scripts/test_color_pipeline.sh`

**Why this matters:** The brief's § 1-§ 3 assume specific code shapes (4-variant `CfaPattern`, `DcpProfile` with 5 fields, `develop_scene_linear_from_raw_with_quality` opens with `linearize` + `demosaic`). If any of those drifted since the brief was written, the plan's mechanics break. Task 1 is a `grep` / `sed` walkthrough — no edits, just confirmation.

- [ ] **Step 1.1: Confirm `CfaPattern` is the 4-variant enum the brief expects.**

Run:
```bash
sed -n '50,71p' src/raw-pipeline/raw-core/src/image.rs
```

Expected:
- 4-variant enum (`Rggb`, `Bggr`, `Grbg`, `Gbrg`) at `:52-57`.
- `color_at` impl at `:60-71` with one `match` arm per variant.

If the enum has more than 4 variants or `color_at` already references `LinearRgb`, the plan's edit count needs updating.

- [ ] **Step 1.2: Confirm the `LinearRaw` arm in `decode.rs` still substitutes `Rggb`.**

Run:
```bash
sed -n '125,140p' src/raw-pipeline/raw-core/src/decode.rs
```

Expected: matches the snippet quoted in the investigation report § 5 — three `match` arms (`Cfa(cfg) => map_cfa_pattern`, `LinearRaw => CfaPattern::Rggb` with TODO, `BlackIsZero => Err(...)`). If the bug has already been partially fixed, reconcile the plan with the new state.

- [ ] **Step 1.3: Confirm `RawImage` lives in `image.rs`, not `raw_image.rs`.**

Run:
```bash
ls src/raw-pipeline/raw-core/src/raw_image.rs 2>&1 || true
grep -n "pub struct RawImage" src/raw-pipeline/raw-core/src/image.rs
```

Expected: `raw_image.rs` does NOT exist; `pub struct RawImage` IS in `image.rs:74`. The ticket § Pointers has a typo ("`raw_image.rs` — `RawImage` struct"); the Real Location is `image.rs`. This step records that finding so the plan's references are correct.

- [ ] **Step 1.4: Confirm `develop_scene_linear_from_raw_with_quality` opens with `linearize` + `demosaic`.**

Run:
```bash
sed -n '77,95p' src/raw-pipeline/raw-core/src/pipeline.rs
```

Expected: function opens at `:77`, `let mosaic = stage("linearize", || linearize::sensor_linearize(raw));` at `:82`, `let mut camera_rgb = stage("demosaic", || ...);` at `:83-89`. The new branch in Task 4 inserts at `:82` (before the `stage("linearize", ...)` wrapper).

- [ ] **Step 1.5: Confirm `DcpProfile` has 5 fields (no `wb_already_baked` yet).**

Run:
```bash
sed -n '17,42p' src/raw-pipeline/raw-core/src/color/dcp.rs
```

Expected: `pub struct DcpProfile` with 5 fields (`illuminant`, `color_matrix`, `forward_matrix`, `scene_cct`, `scene_white_xyz`). Task 5 adds a 6th: `wb_already_baked: bool`.

- [ ] **Step 1.6: Confirm the harness skip is at lines 120-135 and gated on `INCLUDE_LINEARRAW`.**

Run:
```bash
sed -n '120,135p' src/scripts/test_color_pipeline.sh
grep -n "INCLUDE_LINEARRAW\|34892" src/scripts/test_color_pipeline.sh
```

Expected: a `# 0. Skip LinearRaw DNGs unless ...` block at `:120-135`, the `INCLUDE_LINEARRAW="${INCLUDE_LINEARRAW:-0}"` default at `:52`, and at least 4 `INCLUDE_LINEARRAW` references total (docstring + default + skip block + comment). Task 7 deletes them all.

- [ ] **Step 1.7: Confirm both LinearRaw fixtures are present.**

Run:
```bash
ls -la test-fixtures/raws/test_0006.DNG test-fixtures/raws/test_0013.DNG 2>&1
```

Expected: both files exist (gitignored, but on the developer machine per the investigation report). If absent, Task 7's milestone gate degrades to "passes when fixtures are absent" (the harness's soft-pass mode); a developer with the fixtures must re-run before merging.

- [ ] **Step 1.8: Run `cargo test -p raw-core --lib` to capture the baseline.**

Run:
```bash
cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5
```

Expected: green. Note the test count for comparison after each later Task. The brief's § 5 mentions "Synthesized LinearRaw test"; Task 6 adds 2-3 tests; we expect the baseline + 2-3 by Task 7.

- [ ] **Step 1.9: Commit (preflight notes only — no code changes).**

This task touches no source files. Skip the commit step. Move on to Task 2.

---

## Task 2: Add `CfaPattern::LinearRgb` variant

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/image.rs`

**Why this matters:** Adding the variant first makes every existing `match` on `CfaPattern` a compile error. Tasks 3-4 work through the wave of errors site-by-site. This is the cheapest way to make sure no Bayer code path silently consumes LinearRgb data — the bug we're fixing.

- [ ] **Step 2.1: Add `LinearRgb` variant to `CfaPattern`.**

Edit `image.rs:52-57` from:
```rust
pub enum CfaPattern {
    Rggb,
    Bggr,
    Grbg,
    Gbrg,
}
```
to:
```rust
pub enum CfaPattern {
    Rggb,
    Bggr,
    Grbg,
    Gbrg,
    /// Already-demosaiced 3-channel RGB. Source data is interleaved
    /// `[R₀ G₀ B₀ R₁ G₁ B₁ …]` with no Bayer mosaic pattern. Decoded
    /// from DNG `PhotometricInterpretation = LinearRaw (34892)`. The
    /// `linearize::linearraw_to_camera_rgb` helper converts directly
    /// to `CameraNativeLinearRgb`, skipping `sensor_linearize` and
    /// `demosaic::*`. See ticket #07.
    LinearRgb,
}
```

- [ ] **Step 2.2: Add the `unreachable!()` arm to `color_at`.**

Edit `image.rs:60-71` so the `match self` block has one more arm:
```rust
Self::LinearRgb => unreachable!("CfaPattern::LinearRgb has no Bayer position; \
    callers must short-circuit before invoking color_at"),
```

The four existing arms stay unchanged. The function comment should note that `LinearRgb` is a runtime panic.

- [ ] **Step 2.3: `cargo build -p raw-core` to surface the wave of compile errors.**

Run:
```bash
cd src/raw-pipeline && cargo build -p raw-core 2>&1 | grep "error\[E" | head -20
```

Expected: errors in `linearize.rs`, `demosaic/bilinear.rs`, `demosaic/half_res.rs`, `demosaic/hamilton_adams.rs`, and `decode.rs` (the wildcard `_ =>` at the rawler-arm matches won't fire, but new explicit matches in the demosaic / linearize site won't have the variant — that's the wave we want). If a site we haven't planned for surfaces, add a step to Task 3 or Task 4 to handle it.

- [ ] **Step 2.4: Stop here even though the build is broken.**

Tasks 3 and 4 fix the broken sites. The intermediate state is fine for a feature branch — we don't commit it yet.

- [ ] **Step 2.5: Commit (this step).**

```bash
git add src/raw-pipeline/raw-core/src/image.rs
git commit -m "$(cat <<'EOF'
feat(raw-core): add CfaPattern::LinearRgb variant

For DNG PhotometricInterpretation = LinearRaw (34892). The variant
is unreachable through color_at — LinearRgb data is interleaved
RGB, not a Bayer mosaic. Tasks 3 and 4 wire the new variant
through decode and develop chains. See ticket #07.

Refs: .archived-plans/plans/2026-04-25-ticket-07-linearraw-decode.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Note: this commit leaves the workspace not-building. That's intentional for a feature-branch sequence; Tasks 3+4 land the fixes within the same logical change set.

---

## Task 3: Decoder emits `CfaPattern::LinearRgb` for LinearRaw DNGs

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/decode.rs`

**Why this matters:** This is the bug fix at the source — replacing the silent `CfaPattern::Rggb` fallback with the new `LinearRgb` variant. Combined with Task 4's pipeline branch, this routes LinearRaw data away from the mosaic path.

- [ ] **Step 3.1: Replace the `LinearRaw` arm in `decode.rs`.**

Edit `decode.rs:130-136` from:
```rust
RawPhotometricInterpretation::LinearRaw => {
    // TODO(slice-4+): LinearRaw DNGs carry already-demosaiced RGB data and may
    // not have a meaningful CFA pattern. Defaulting to RGGB is conservative —
    // slice-1 fixtures don't trigger this path. Revisit when a LinearRaw
    // fixture is added.
    CfaPattern::Rggb
}
```
to:
```rust
RawPhotometricInterpretation::LinearRaw => {
    // DNG PhotometricInterpretation = LinearRaw (34892): the file
    // already carries demosaiced, white-balanced 3-channel RGB.
    // Emit the LinearRgb cfa variant; pipeline.rs routes through
    // linearize::linearraw_to_camera_rgb instead of the mosaic path,
    // and dcp::profile_for sets wb_already_baked so AsShotNeutral
    // is not re-applied. See ticket #07.
    CfaPattern::LinearRgb
}
```

- [ ] **Step 3.2: Add a unit test that `decode_bytes` returns `LinearRgb` for LinearRaw fixtures.**

Append to the `tests` mod in `decode.rs`:
```rust
#[test]
fn decode_test_0006_linearraw_uses_linearrgb_cfa() {
    let path = fixture_root().join("test_0006.DNG");
    if !path.exists() { return; }
    let raw = decode_path(&path).expect("decode LinearRaw DNG");
    assert_eq!(raw.cfa, CfaPattern::LinearRgb);
    // raw_data length = 3 × w × h for LinearRaw (interleaved RGB).
    assert_eq!(raw.raw_data.len(), 3 * raw.width as usize * raw.height as usize);
}
```

The fixture is gitignored, so the test soft-skips when absent — same convention as the existing `decode_test_0002_*` tests.

- [ ] **Step 3.3: `cargo build -p raw-core` to confirm the decoder side compiles.**

Run:
```bash
cd src/raw-pipeline && cargo build -p raw-core 2>&1 | grep "error\[E" | head -10
```

Expected: errors in `linearize.rs` + `demosaic/*.rs` only (the post-decode sites). Task 4 fixes those.

- [ ] **Step 3.4: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/decode.rs
git commit -m "$(cat <<'EOF'
feat(raw-core): decoder emits CfaPattern::LinearRgb for LinearRaw DNGs

Replaces the silent CfaPattern::Rggb fallback at decode.rs:130-136
with the new LinearRgb variant. Task 4 wires the develop chain to
short-circuit the mosaic path on this variant. See ticket #07.

Refs: .archived-plans/plans/2026-04-25-ticket-07-linearraw-decode.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Pipeline branch + `linearraw_to_camera_rgb` helper

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/linearize.rs` (add `linearraw_to_camera_rgb`)
- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs` (branch in `develop_scene_linear_from_raw_with_quality`)
- Modify: `src/raw-pipeline/raw-core/src/demosaic/{bilinear,half_res,hamilton_adams}.rs` (compile-error gate)

**Why this matters:** This is the develop-chain rerouting. After Task 4 the workspace builds again and a manual `INCLUDE_LINEARRAW=1` harness run should produce structurally correct output — modulo the WB double-apply still in place.

- [ ] **Step 4.1: Implement `linearraw_to_camera_rgb` in `linearize.rs`.**

Append to `linearize.rs`:
```rust
/// LinearRaw decode entry. Reshape interleaved `[R₀ G₀ B₀ R₁ G₁ B₁ …]`
/// `raw.raw_data` into a `CameraNativeLinearRgb` `Image`, normalizing
/// per-channel by `(white_level - black_level)`. Skips both
/// `sensor_linearize` (1 SPP scanline) and `demosaic::*` because the
/// data is already 3-channel RGB. Caller dispatches based on
/// `raw.cfa == CfaPattern::LinearRgb`. See ticket #07.
pub fn linearraw_to_camera_rgb(raw: &RawImage) -> crate::Result<Image> {
    debug_assert_eq!(raw.cfa, CfaPattern::LinearRgb);
    let w = raw.width as usize;
    let h = raw.height as usize;
    let expected = 3 * w * h;
    if raw.raw_data.len() != expected {
        return Err(crate::Error::Decode {
            path: std::path::PathBuf::from("<linearraw>"),
            reason: format!(
                "LinearRaw raw_data length {} != 3 × {} × {} = {} (expected interleaved RGB)",
                raw.raw_data.len(), w, h, expected
            ),
        });
    }
    let wl = raw.white_level as f32;
    // For LinearRaw, black levels per the investigation are typically
    // 0/0/0 — but we honor metadata: index 0 = R, 1 = G, 2 = B
    // (the 4th slot is unused, mirrors RGGB's [R, Gr, Gb, B]).
    let bl_r = raw.black_level[0] as f32;
    let bl_g = raw.black_level[1] as f32;
    let bl_b = raw.black_level[3] as f32;
    let denom_r = (wl - bl_r).max(1.0);
    let denom_g = (wl - bl_g).max(1.0);
    let denom_b = (wl - bl_b).max(1.0);

    let mut img = Image::new(raw.width, raw.height, ColorSpace::CameraNativeLinearRgb);
    img.pixels.par_iter_mut().enumerate().for_each(|(idx, px)| {
        let off = idx * 3;
        let r = ((raw.raw_data[off    ] as f32 - bl_r) / denom_r).clamp(0.0, 1.0);
        let g = ((raw.raw_data[off + 1] as f32 - bl_g) / denom_g).clamp(0.0, 1.0);
        let b = ((raw.raw_data[off + 2] as f32 - bl_b) / denom_b).clamp(0.0, 1.0);
        *px = [r, g, b];
    });
    Ok(img)
}
```

Note: `Image` and `RawImage` must be in scope; `CfaPattern` is already imported via the `use` statement at the top of the file.

- [ ] **Step 4.2: Defense-in-depth: `sensor_linearize` panics on LinearRgb.**

Add at the top of `linearize::sensor_linearize` (immediately after the function signature `pub fn sensor_linearize(raw: &RawImage) -> Image {`):
```rust
debug_assert_ne!(raw.cfa, CfaPattern::LinearRgb,
    "sensor_linearize must not be called on LinearRgb data; \
     use linearraw_to_camera_rgb instead. See ticket #07.");
```

- [ ] **Step 4.3: Add the branch in `develop_scene_linear_from_raw_with_quality`.**

Edit `pipeline.rs:81-89` from:
```rust
    let mosaic = stage("linearize", || linearize::sensor_linearize(raw));
    let mut camera_rgb = stage("demosaic", || match quality {
        RenderQuality::Preview => demosaic::half_res(&mosaic, raw.cfa),
        #[cfg(feature = "high-quality-demosaic")]
        RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
        #[cfg(not(feature = "high-quality-demosaic"))]
        RenderQuality::Full => demosaic::bilinear(&mosaic, raw.cfa),
    });
```
to:
```rust
    let mut camera_rgb = match raw.cfa {
        crate::image::CfaPattern::LinearRgb => {
            // LinearRaw DNG: data is already 3-channel RGB. Skip the
            // mosaic path entirely. See ticket #07.
            stage("linearraw_decode", || linearize::linearraw_to_camera_rgb(raw))?
        }
        _ => {
            let mosaic = stage("linearize", || linearize::sensor_linearize(raw));
            stage("demosaic", || match quality {
                RenderQuality::Preview => demosaic::half_res(&mosaic, raw.cfa),
                #[cfg(feature = "high-quality-demosaic")]
                RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
                #[cfg(not(feature = "high-quality-demosaic"))]
                RenderQuality::Full => demosaic::bilinear(&mosaic, raw.cfa),
            })
        }
    };
```

- [ ] **Step 4.4: Same shape for `develop_scene_linear_from_padded_mosaic` and `render_scene_linear_tile_from_raw_with_quality`.**

The tile path operates on a pre-cropped mosaic and isn't ready for LinearRaw in v1. Add at the top of `develop_scene_linear_from_padded_mosaic` (after the `mosaic.assert_space(...)` line):
```rust
if raw.cfa == crate::image::CfaPattern::LinearRgb {
    return Err(crate::error::Error::Pipeline(
        "tile path does not support LinearRaw DNGs; use the full-image render entry instead. See ticket #07."
            .into()
    ));
}
```

And at the top of `render_scene_linear_tile_from_raw_with_quality` (alongside the existing dehaze + upscale guards):
```rust
if raw.cfa == crate::image::CfaPattern::LinearRgb {
    return Err(crate::error::Error::Pipeline(
        "tile path does not support LinearRaw DNGs; use the full-image render entry instead. See ticket #07."
            .into()
    ));
}
```

- [ ] **Step 4.5: Add `unreachable!()` arms to `demosaic/*.rs`.**

Each of `demosaic/bilinear.rs`, `demosaic/half_res.rs`, `demosaic/hamilton_adams.rs` will have a `match cfa { ... }` that the compile-error wave from Task 2 surfaced. Wherever the match is, add:
```rust
CfaPattern::LinearRgb => unreachable!("demosaic called on LinearRaw data; \
    pipeline should have routed via linearraw_to_camera_rgb"),
```

If the file uses an `_ =>` wildcard arm instead of explicit variants, change it to a `LinearRgb => unreachable!(...)` plus the explicit Bayer arms. Defensive fastener.

- [ ] **Step 4.6: `cargo build -p raw-core --tests`.**

Run:
```bash
cd src/raw-pipeline && cargo build -p raw-core --tests 2>&1 | tail -10
```

Expected: green, including tests.

- [ ] **Step 4.7: `cargo test -p raw-core --lib`.**

Run:
```bash
cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -15
```

Expected: all baseline tests still pass. New test `decode_test_0006_linearraw_uses_linearrgb_cfa` from Task 3 either passes (fixture present) or soft-skips (fixture absent).

- [ ] **Step 4.8: Manual harness check (optional, fixture-gated).**

If `test-fixtures/raws/test_0006.DNG` is present:
```bash
INCLUDE_LINEARRAW=1 src/scripts/test_color_pipeline.sh 2>&1 | grep -E "test_0006|test_0013|PASS|FAIL"
```

Expected: test_0006 + test_0013 still FAIL the BUDGET=15 default, but the bias is now smaller and the cast is no longer the catastrophic magenta — likely a visible warm/cool cast remains because the WB double-apply hasn't been fixed yet (Task 5). Visual confirmation: the candidate image now has structure (not uniform magenta). Numbers should be ΔE ~25-35, bias ~0.1-0.2 — improved but not yet at budget.

- [ ] **Step 4.9: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/linearize.rs \
        src/raw-pipeline/raw-core/src/pipeline.rs \
        src/raw-pipeline/raw-core/src/demosaic/bilinear.rs \
        src/raw-pipeline/raw-core/src/demosaic/half_res.rs \
        src/raw-pipeline/raw-core/src/demosaic/hamilton_adams.rs
git commit -m "$(cat <<'EOF'
feat(raw-core): bypass mosaic path for LinearRaw via linearraw_to_camera_rgb

Adds linearize::linearraw_to_camera_rgb that reshapes interleaved
[R G B …] raw_data into a CameraNativeLinearRgb Image directly,
honoring per-channel black/white levels. develop_scene_linear_*
opens with a CfaPattern::LinearRgb branch that skips
sensor_linearize + demosaic and produces the develop chain's
camera-RGB input directly. Tile path errors loudly on LinearRaw
(out of scope for v1). Demosaic functions assert
unreachable!() on LinearRgb cfa as defense-in-depth. WB
double-apply (mean ΔE still ~25-35) lands in Task 5.
See ticket #07.

Refs: .archived-plans/plans/2026-04-25-ticket-07-linearraw-decode.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Fix WB double-apply via `DcpProfile::wb_already_baked`

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/color/dcp.rs`

**Why this matters:** This is the second half of the bug. Even with correct demosaic-bypass, `dcp::apply` re-applies AsShotNeutral on top of pre-baked WB, producing the warm cast on test_0006 / test_0013. After Task 5, those fixtures should land at BUDGET=25.

- [ ] **Step 5.1: Add `wb_already_baked: bool` to `DcpProfile`.**

Edit the `pub struct DcpProfile` definition at `dcp.rs:18-42`:
- Add a new field `pub wb_already_baked: bool,` after `scene_white_xyz`.
- Doc comment: `/// True when the source image already has its white balance baked in by the converter (e.g. LinearRaw DNGs, where AsShotNeutral was applied at write-time). When set, scene_white_xyz is derived from inv(CM) · (1, 1, 1) instead of inv(CM) · as_shot_neutral, preventing a double WB application. See ticket #07.`

- [ ] **Step 5.2: Update `DcpProfile::from_embedded_cm` constructor.**

Edit the constructor at `dcp.rs:50-66` to set `wb_already_baked: false` (the default for embedded-CM constructors that don't know about the source).

- [ ] **Step 5.3: Update `interpolated_profile` to consume the flag.**

`dcp.rs:210-238`: `interpolated_profile` currently computes `scene_white_xyz` as `normalize_to_y1(inv(cm) · wb_neutral)`. Change to take an extra parameter `wb_already_baked: bool` (or read it off a future `RawImage` reference; pick whichever is least invasive):
```rust
pub fn interpolated_profile(
    m_cold: Matrix3, illum_cold: Illuminant,
    m_warm: Matrix3, illum_warm: Illuminant,
    wb_neutral: [f32; 3],
    wb_already_baked: bool,
) -> DcpProfile {
    // ... existing CCT computation unchanged ...
    let neutral_for_white = if wb_already_baked {
        [1.0, 1.0, 1.0]
    } else {
        wb_neutral
    };
    let scene_white_xyz = cm.inverse()
        .map(|inv| normalize_to_y1(inv.mul_vec(neutral_for_white)))
        .unwrap_or(crate::color::matrices::XYZ_D65);
    DcpProfile {
        // ... existing fields ...
        wb_already_baked,
    }
}
```

- [ ] **Step 5.4: Update `profile_for` to set the flag from `raw.cfa`.**

Edit `dcp.rs:248-310`. At the top of `profile_for`, derive the flag:
```rust
let wb_already_baked = raw.cfa == crate::image::CfaPattern::LinearRgb;
```

Pass `wb_already_baked` to the new `interpolated_profile` signature, and in the single-CM fallback branches (there are two: `for illum in preferred` and the deterministic-iteration tail) compute `scene_white_xyz` the same way:
```rust
let neutral_for_white = if wb_already_baked { [1.0, 1.0, 1.0] } else { raw.as_shot_neutral };
let scene_white_xyz = cm.inverse()
    .map(|inv| normalize_to_y1(inv.mul_vec(neutral_for_white)))
    .unwrap_or(crate::color::matrices::XYZ_D65);
```

And set `wb_already_baked` in the returned `DcpProfile` struct in all return sites.

- [ ] **Step 5.5: Update tests in `dcp.rs`.**

Existing tests (e.g. `pipeline_produces_rec2020_output`, `neutral_patch_at_scene_illuminant_renders_approximately_neutral`, `profile_for_succeeds_when_matrix_present`, etc.) need `wb_already_baked: false` added to their `DcpProfile { ... }` literals. The unit-test `make_raw` helper continues to default to `CfaPattern::Rggb`, so `profile_for` will pick `false` automatically — only the hand-rolled `DcpProfile` literals need updating.

- [ ] **Step 5.6: Add a new unit test that LinearRgb cfa skips AsShotNeutral.**

Append to the `tests` mod in `dcp.rs`:
```rust
#[test]
fn wb_already_baked_skips_as_shot_neutral() {
    // Build a raw with non-identity AsShotNeutral and a known CM at D65.
    // When cfa == LinearRgb, scene_white_xyz must derive from
    // inv(CM) · (1, 1, 1), NOT from inv(CM) · AsShotNeutral.
    let cm = Matrix3([
        [0.6722, -0.0635, -0.0963],
        [-0.4287, 1.2460, 0.2028],
        [-0.0908, 0.2162, 0.5668],
    ]);
    let mut cms = std::collections::HashMap::new();
    cms.insert(Illuminant::D65, cm);
    let warm_wb: [f32; 3] = [1.65, 1.0, 2.16]; // canon-shape AsShotNeutral

    let raw_linear = RawImage {
        width: 1, height: 1,
        cfa: crate::image::CfaPattern::LinearRgb,
        black_level: [0; 4], white_level: 1,
        raw_data: vec![0; 3], // 1 px × 3 channels
        as_shot_neutral: warm_wb,
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        color_matrices: cms.clone(),
        orientation: crate::image::ExifOrientation::Normal,
        baseline_exposure: 0.0,
    };
    let prof_linear = profile_for(&raw_linear).unwrap();
    assert!(prof_linear.wb_already_baked, "LinearRgb must set wb_already_baked");

    // Compute the expected scene_white_xyz: inv(CM) · (1, 1, 1), normalized.
    let inv_cm = cm.inverse().unwrap();
    let xyz = inv_cm.mul_vec([1.0, 1.0, 1.0]);
    let s = 1.0 / xyz[1];
    let expected = [xyz[0] * s, 1.0, xyz[2] * s];
    for i in 0..3 {
        assert!((prof_linear.scene_white_xyz[i] - expected[i]).abs() < 1e-4,
            "scene_white_xyz[{}] = {} (want {})",
            i, prof_linear.scene_white_xyz[i], expected[i]);
    }

    // For comparison: a Bayer raw with the same CM + WB derives a
    // different scene_white_xyz (uses warm_wb instead of (1,1,1)).
    let raw_bayer = RawImage { cfa: crate::image::CfaPattern::Rggb, ..raw_linear };
    let prof_bayer = profile_for(&raw_bayer).unwrap();
    assert!(!prof_bayer.wb_already_baked);
    assert!((prof_linear.scene_white_xyz[0] - prof_bayer.scene_white_xyz[0]).abs() > 0.01,
        "LinearRgb and Bayer profiles must produce different scene_white_xyz \
         for the same CM + non-identity AsShotNeutral");
}
```

- [ ] **Step 5.7: `cargo test -p raw-core --lib`.**

Run:
```bash
cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -15
```

Expected: all baseline tests still pass. New `wb_already_baked_skips_as_shot_neutral` test passes. The `decode_test_0006_linearraw_uses_linearrgb_cfa` test from Task 3 still passes (or soft-skips).

- [ ] **Step 5.8: Manual harness check (fixture-gated).**

If fixtures are present:
```bash
INCLUDE_LINEARRAW=1 src/scripts/test_color_pipeline.sh 2>&1 | grep -E "test_0006|test_0007|test_0013"
```

Expected: test_0006 + test_0013 should now produce mean ΔE ≤ 25 (within the looser BUDGET we'll formalize in Task 7). The control fixture test_0007 (Bayer of the same scene as test_0006) still passes at the existing budget.

- [ ] **Step 5.9: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/color/dcp.rs
git commit -m "$(cat <<'EOF'
feat(raw-core): DcpProfile::wb_already_baked skips AsShotNeutral on LinearRaw

LinearRaw DNGs already have white balance baked in by the
converter; re-applying AsShotNeutral via inv(CM) · AsShotNeutral
produces the magenta wash documented in the investigation report.
The new wb_already_baked flag (set in profile_for when
raw.cfa == CfaPattern::LinearRgb) routes scene_white_xyz through
inv(CM) · (1, 1, 1) instead. Bayer pipelines are unaffected.
See ticket #07.

Refs: .archived-plans/plans/2026-04-25-ticket-07-linearraw-decode.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Synthesized Rust unit test for the new path

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/linearize.rs` (test in the existing `tests` mod)

**Why this matters:** Per ticket § Acceptance, the most valuable Rust test is a hand-built `RawImage { cfa: LinearRgb, raw_data: interleaved-RGB }` that round-trips through `linearraw_to_camera_rgb` without touching disk. This locks down the channel-major-write invariant that the bug report § 5 traced through.

- [ ] **Step 6.1: Append the synthesized-RawImage test to `linearize::tests`.**

```rust
#[test]
fn linearraw_to_camera_rgb_lays_data_channel_major() {
    // 2×2 image with deliberately distinct R/G/B per pixel, verify the
    // helper lays them into Image::pixels[k] = [R, G, B] correctly.
    // Pre-bug (every-other-column misroute), the second pixel would
    // pick up neighbor blue samples; this test catches that regression.
    let raw_data: Vec<u16> = vec![
        // px 0: R=100  G=200  B=300
        100, 200, 300,
        // px 1: R=400  G=500  B=600
        400, 500, 600,
        // px 2: R=700  G=800  B=900
        700, 800, 900,
        // px 3: R=1000 G=1100 B=1200
        1000, 1100, 1200,
    ];
    let raw = RawImage {
        width: 2, height: 2,
        cfa: CfaPattern::LinearRgb,
        black_level: [0, 0, 0, 0],
        white_level: 1500,
        raw_data,
        as_shot_neutral: [1.0, 1.0, 1.0],
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        color_matrices: std::collections::HashMap::new(),
        orientation: crate::image::ExifOrientation::Normal,
        baseline_exposure: 0.0,
    };
    let img = linearraw_to_camera_rgb(&raw).expect("LinearRaw decode");
    assert_eq!(img.width, 2);
    assert_eq!(img.height, 2);
    assert_eq!(img.space, ColorSpace::CameraNativeLinearRgb);
    // Each pixel's R/G/B are normalized by white_level=1500.
    let n = 1.0 / 1500.0;
    let exp = [
        [100.0 * n, 200.0 * n, 300.0 * n],
        [400.0 * n, 500.0 * n, 600.0 * n],
        [700.0 * n, 800.0 * n, 900.0 * n],
        [1000.0 * n, 1100.0 * n, 1200.0 * n],
    ];
    for k in 0..4 {
        for c in 0..3 {
            let got = img.pixels[k][c];
            let want = exp[k][c];
            assert!((got - want).abs() < 1e-5,
                "pixel {} channel {}: got {}, want {}", k, c, got, want);
        }
    }
}

#[test]
fn linearraw_to_camera_rgb_rejects_wrong_buffer_length() {
    let raw = RawImage {
        width: 4, height: 4,
        cfa: CfaPattern::LinearRgb,
        black_level: [0, 0, 0, 0],
        white_level: 1023,
        // Length 16 instead of 48 — should error.
        raw_data: vec![0; 16],
        as_shot_neutral: [1.0, 1.0, 1.0],
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        color_matrices: std::collections::HashMap::new(),
        orientation: crate::image::ExifOrientation::Normal,
        baseline_exposure: 0.0,
    };
    let err = linearraw_to_camera_rgb(&raw).unwrap_err();
    match err {
        crate::Error::Decode { reason, .. } => {
            assert!(reason.contains("LinearRaw raw_data length"),
                "unexpected error message: {}", reason);
        }
        other => panic!("expected Error::Decode, got {:?}", other),
    }
}
```

- [ ] **Step 6.2: `cargo test -p raw-core --lib`.**

Run:
```bash
cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -15
```

Expected: 2 new tests pass; baseline + Tasks 3+5 tests continue to pass.

- [ ] **Step 6.3: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/linearize.rs
git commit -m "$(cat <<'EOF'
test(raw-core): channel-major write + buffer-length checks for linearraw_to_camera_rgb

Locks down the every-other-column misroute that the investigation
report traced through (linearize.rs:8-30 read raw_data[y*w..y*w+w]
as 1-SPP over an interleaved 3-SPP scanline). The new helper writes
[R,G,B] triples into Image::pixels channel-major; the test
verifies pixel 1's R/G/B are NOT pixel 0's neighbor samples.
See ticket #07.

Refs: .archived-plans/plans/2026-04-25-ticket-07-linearraw-decode.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: M1 milestone gate — drop harness skip, run full harness

**Files:**
- Modify: `src/scripts/test_color_pipeline.sh`

**Why this matters:** This is the milestone gate. Tasks 2-6 produced a complete, correct LinearRaw decode + develop chain; Task 7 turns the harness from SKIP → PASS on the two LinearRaw fixtures and confirms no Bayer regression.

- [ ] **Step 7.1: Drop the `INCLUDE_LINEARRAW`-gated skip block.**

Edit `src/scripts/test_color_pipeline.sh`:

(a) Remove the docstring lines for `INCLUDE_LINEARRAW` (`:28-30` and the usage example at `:35`).

(b) Remove the default-set line at `:52`: `INCLUDE_LINEARRAW="${INCLUDE_LINEARRAW:-0}"`.

(c) Remove the entire skip block at `:120-135`:
```bash
  # 0. Skip LinearRaw DNGs unless the caller forces inclusion via
  #    INCLUDE_LINEARRAW=1. ... (existing comment block)
  if [[ "$INCLUDE_LINEARRAW" != "1" ]]; then
    photometric="$(...)"
    if [[ "$photometric" == "34892" ]]; then
      printf "SKIP %-45s LinearRaw not yet supported by Maple decode — see ticket #07\n" "$stem"
      SKIP_COUNT=$((SKIP_COUNT + 1))
      continue
    fi
  fi
```

Replace with a single short comment near the loop entry:
```bash
  # All DNG photometric interpretations (CFA, LinearRaw) covered as of
  # ticket #07. BlackIsZero monochrome is rejected at decode by the Rust
  # core (Error::UnsupportedCfa) and produces a render failure, not a SKIP.
```

- [ ] **Step 7.2: Run the harness with default budget BUDGET=15 to confirm no Bayer regression.**

```bash
src/scripts/test_color_pipeline.sh 2>&1 | tail -15
```

Expected: at default BUDGET=15, the five Bayer fixtures (test_0000, test_0002, test_0007, test_0015, test_0017) PASS; test_0006 + test_0013 likely FAIL because BUDGET=15 is too tight for them. That's expected — the next step uses BUDGET=25 specifically.

- [ ] **Step 7.3: Run the harness at BUDGET=25 to confirm LinearRaw fixtures pass.**

```bash
BUDGET=25 src/scripts/test_color_pipeline.sh 2>&1 | tail -15
```

Expected: ALL seven top-level DNG fixtures PASS (the five Bayer at BUDGET=25 — easier than BUDGET=15 — plus the two LinearRaw newly admitted). Bias under 0.05 on every channel.

If test_0006 or test_0013 still FAIL at BUDGET=25:
- Check the per-channel bias. If `bias_B` or `bias_R` is still ~0.1+, the WB fix (Task 5) didn't take. Re-read `dcp::profile_for` and confirm `wb_already_baked` is set on `LinearRgb` cfa.
- Check the mean ΔE. If it's 30-40 (versus the original 50), the bug is half-fixed — likely Task 4's helper has a wrong channel order or wrong black_level indexing. Add a `dump_pixel` trace to confirm channel-major writing.
- Check the candidate image size on disk vs the fixture's reported dimensions. If `linearraw_to_camera_rgb` produced a wrong-shape Image, every downstream stage is shifted.

- [ ] **Step 7.4: Run the existing CI gate at BUDGET=15 to confirm Bayer fixtures unchanged.**

```bash
src/scripts/test_color_pipeline.sh 2>&1 | grep -E "PASS|FAIL"
```

Expected: the five Bayer fixtures still PASS at BUDGET=15. test_0006 + test_0013 may FAIL at BUDGET=15 (their BUDGET=25 is the v1 tier per brief § 6); that's acceptable for the v1 land, and a follow-up commit ratchets them tighter as `ProfileGainTableMap` support comes in.

Optional refinement: add per-fixture budget overrides to the harness (`BUDGET_TEST_0006=25 BUDGET_TEST_0013=25 src/scripts/test_color_pipeline.sh`). Out of scope for this plan — the simple `BUDGET=25` blanket budget is fine for v1, and the brief picked it deliberately.

- [ ] **Step 7.5: Run the full Rust test suite.**

```bash
cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -10
```

Expected: green, with the test count up from baseline by ~3-4 (Tasks 3+5+6 added one to each module).

- [ ] **Step 7.6: Rebuild the xcframework so Apple-side picks up the change.**

```bash
./src/apple/scripts/build-xcframework.sh
```

Expected: green build. The xcframework binaries are gitignored, so this doesn't generate a commit; the rebuild is a developer-machine-only action. CI's first build after the change will rebuild the xcframework automatically.

- [ ] **Step 7.7: Commit the harness change + finalize.**

```bash
git add src/scripts/test_color_pipeline.sh
git commit -m "$(cat <<'EOF'
fix(scripts): drop LinearRaw skip; harness now covers all DNG photometric paths

LinearRaw decode is implemented per ticket #07 (commits ed96688 et al);
the INCLUDE_LINEARRAW-gated skip from commit 3bdc205 is no longer
needed. Both test_0006 and test_0013 now pass the parity harness at
BUDGET=25 with bias under 0.05.

The 25 budget is looser than the Bayer 15 to absorb (a) test_0013's
ProfileGainTableMap (which Maple does not implement; out of scope per
ticket § Notes) and (b) test_0006's 8-bit-per-channel quantization
slack from the Adobe DNG Converter. A downward-ratchet to BUDGET=15
lands as a follow-up once ProfileGainTableMap is implemented.

Refs: .archived-plans/plans/2026-04-25-ticket-07-linearraw-decode.md
      docs/measurement/2026-04-25-color-harness-catastrophic-bias-investigation.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7.8: Update the test file header `M1 milestone gate` record.**

Append to the brief at `.archived-plans/specs/2026-04-25-ticket-07-linearraw-decode-brief.md` (or to a new section in this plan, depending on convention used by sibling plans) a one-paragraph M1 record:

```
## M1 result: PASSED on YYYY-MM-DD

BUDGET=25 src/scripts/test_color_pipeline.sh — all 7 fixtures PASS:
- test_0000 (Bayer): mean=… bias=…
- test_0002 (Bayer): mean=… bias=…
- test_0006 (LinearRaw): mean=… bias=…  ← was 50.34 / +0.69 bias_B
- test_0007 (Bayer): mean=… bias=…
- test_0013 (LinearRaw): mean=… bias=…  ← was 36.58 / +0.29 bias_R
- test_0015 (Bayer): mean=… bias=…
- test_0017 (Bayer): mean=… bias=…

Default BUDGET=15 still passes all 5 Bayer fixtures (no regression).
```

This step is a documentation update; the plan author commits the numbers when verification confirms them.

---

## Verification matrix

| Surface | Command | Pass condition | When run |
| --- | --- | --- | --- |
| Rust unit tests | `cargo test -p raw-core --lib` | All baseline + new tests green | After every task |
| Rust full features | `cargo test -p raw-core --all-features` | All fixture-gated tests green where fixtures present | After Task 7 |
| Color parity (Bayer regression) | `src/scripts/test_color_pipeline.sh` | 5 Bayer fixtures PASS at BUDGET=15 | After Task 7 step 7.4 |
| Color parity (LinearRaw new) | `BUDGET=25 src/scripts/test_color_pipeline.sh` | 2 LinearRaw fixtures PASS, 5 Bayer fixtures PASS | After Task 7 step 7.3 |
| Apple xcframework | `./src/apple/scripts/build-xcframework.sh` | Green | After Task 7 step 7.6 |
| Apple unit tests | `cd src/apple/Packages/MapleCore && swift test` | Green | After Task 7 step 7.6 |

Apple-side parity (i.e. "the Apple FFI consumer of the new decode produces the same scene-linear pixels as `maple-cli`") is verified by the existing FFI cross-check tests in `MapleCoreTests`. Those tests are fixture-gated and pass automatically once the xcframework is rebuilt — no per-task action needed.

---

## Risk register

| Risk | Probability | Impact | Mitigation |
| --- | --- | --- | --- |
| `cargo build -p raw-core` errors after Task 2 don't cover all `match` sites — a `LinearRgb` value reaches a wildcard `_ =>` arm somewhere | Low | Medium — the fix is silently wrong, no compile-time signal | Step 4.5 explicitly converts wildcards in `demosaic/*.rs` to explicit Bayer arms + `LinearRgb => unreachable!()`. Step 4.7's `cargo test` would surface a runtime panic in any wildcard-fallthrough site under integration tests if one slips. |
| Task 5's `wb_already_baked` flag breaks single-illuminant Bayer fixtures (the field gets default-true somewhere) | Low | High — every Bayer fixture would regress | Task 5 step 5.5 explicitly updates every existing `DcpProfile { ... }` literal to `wb_already_baked: false`. The new field defaults to `false` in `from_embedded_cm`. The `make_raw` helper continues using `Rggb`, so `profile_for` picks `false` automatically. Bayer regression check at step 7.4 catches any miss. |
| BUDGET=25 is too loose and lets a real future regression slip through | Low (the brief picked 25 deliberately) | Low — bias gate at 0.05 is the real catch-all | Brief § 6 explicitly says "downward ratchet" is a follow-up. Per-channel bias gate stays at 0.05 — the magenta-wash fingerprint would surface bias 0.1+ regardless of mean. |
| The xcframework rebuild produces a different binary that breaks Apple-side parity (fp16 quantization edges) | Very low (pure Rust change with no f32→f16 boundary edits) | Medium | Task 7 step 7.6 + the existing Apple FFI cross-check tests catch any drift. If they fail, the right action is to investigate, not to revert — the new path produces the *correct* values. |
| The `PhotometricInterpretation` query in `exiftool` (used by the harness) returns something other than `34892` for some unusual LinearRaw variant | Low (rawler+exiftool agree on tag values per investigation § 1) | Low — the fixture would route through the Bayer path and fail loudly with a clear ΔE | Step 7.3's harness output would show one or both fixtures FAIL with the original magenta cast; debug per the investigation report's stage-trace recipe. |
| `develop_scene_linear_from_padded_mosaic` (tile path) hidden caller invokes it with `LinearRgb` cfa indirectly | Very low | Low — error path returns early | Task 4 step 4.4 adds the explicit early-error. The tile entry already has dehaze + upscale guards in the same shape; LinearRaw joins them. |

---

## Sequencing rationale

The plan builds in dependency order:

1. **`CfaPattern::LinearRgb` first (Task 2)** — every later task references it. Adding it first surfaces the wave of compile errors that Tasks 3-4 work through, ensuring no wildcard fallthrough silently mis-handles the new variant.
2. **Decode emit (Task 3) before pipeline branch (Task 4)** — the `decode_test_0006_linearraw_uses_linearrgb_cfa` regression test in Task 3 is the first end-to-end signal that "any LinearRaw fixture flows through the new path." That signal is more valuable before the develop-chain-side change lands.
3. **Pipeline branch (Task 4) before WB fix (Task 5)** — Task 4 alone removes the magenta-wash: the develop chain produces structurally correct output, with only a remaining warm/cool cast from the WB double-apply. Task 5 then closes the gap. Splitting them lets a developer (or a future reviewer) see the bug in two halves: "data was misshapen" (Task 3+4) and "WB was misapplied" (Task 5).
4. **Synthesized test (Task 6) after the path is wired (Tasks 4+5)** — a synthesized round-trip is a regression catcher, not a development tool. It locks the fix in place once we know the fix is right.
5. **Harness gate (Task 7) last** — flipping SKIP → PASS without the underlying fix would leave CI red. The plan keeps the gate aligned with reality: the gate flips when the fixtures actually pass.

This is the canonical "spike → green → harness flip" pattern from sibling plans like Plan 2 v2 v1 (M1 Spike → M1 wiring → M1 milestone gate). The brief and this plan inherit that structure.

---

## Acceptance summary

After Task 7:

- `decode_bytes` on a LinearRaw DNG returns `RawImage { cfa: CfaPattern::LinearRgb, raw_data: <interleaved RGB>, ... }`.
- `develop_scene_linear_from_raw_with_quality` on a `LinearRgb` raw routes through `linearize::linearraw_to_camera_rgb` and skips `sensor_linearize` + `demosaic::*`.
- `dcp::profile_for(raw)` for a LinearRgb raw sets `DcpProfile::wb_already_baked = true`; `scene_white_xyz = inv(CM) · (1, 1, 1)`.
- `BUDGET=25 src/scripts/test_color_pipeline.sh` PASSes all seven top-level DNG fixtures.
- Default `src/scripts/test_color_pipeline.sh` (BUDGET=15) PASSes all five Bayer fixtures (no regression).
- The harness's `INCLUDE_LINEARRAW` env-var gate is removed; documentation updated.
- Three new Rust unit tests: `decode_test_0006_linearraw_uses_linearrgb_cfa`, `wb_already_baked_skips_as_shot_neutral`, `linearraw_to_camera_rgb_lays_data_channel_major` + `linearraw_to_camera_rgb_rejects_wrong_buffer_length`.

Follow-ups (out of scope for this plan):

- BUDGET ratchet to LinearRaw 20 → 15 once `ProfileGainTableMap` is implemented (separate ticket).
- LinearRaw + tile rendering (currently errors loudly; v2 if/when a workflow needs it).
- 16-bit LinearRaw fixtures (likely works; not covered by current fixtures).
- Apple-side `decode-linearraw` example (ticket § Implementation sketch suggests this; deferred to keep v1 small).
