# Film Emulation Engine Implementation Plan

This plan is written for task-by-task execution with the superpowers subagent-driven-development or executing-plans workflow; steps use checkbox (`- [ ]`) syntax for progress tracking.

**Goal:** Ship a 100-look film emulation catalog as a non-destructive Maple adjustment (look picker + strength slider) on Apple, Web, and CLI/API, applied as a display-referred 33³ LUT stage between `color_grade` and `grain`.

**Architecture:** One Rust reference stage in raw-core (display-linear Rec.2020 contract, internal sRGB-encoded-domain tetrahedral LUT sample, strength lerp against the original), a WGSL twin following the `ResidualLutPass` storage-buffer pattern, and an ingest tool compiling the acquired `.cube` pack into committed `.mlut` binaries plus a codegen'd catalog. Two new XMP fields (`papp:FilmLook`, `papp:FilmStrength`).

**Tech Stack:** Rust (raw-core, raw-gpu wgpu/WGSL, maple-cli, codegen), C-FFI + wasm-bindgen, SwiftUI, Angular 21 signals.

**Spec:** `docs/superpowers/specs/2026-08-06-film-emulation-engine-design.md` (approved; includes the tetrahedral + static-asset amendments).

## Global Constraints

- File budget: soft 400 / headroom 570 / hard 600 lines per file (`tools/check-file-budget.sh`). Split with real margin.
- Functional immutable style: `let` over `let mut` / `const` over reassigned `let` wherever possible.
- `strength = 0` or empty `film_look` must be a **bit-exact no-op**: the ACR harness (`src/scripts/test_color_pipeline.sh`) budgets must not move at all.
- No allocation in the render loop; the lattice crosses FFI/WASM only on look change (per-tick params carry only scalars + a borrowed pointer, `residual_lut` pattern).
- Interpolation is **tetrahedral** on both CPU and GPU (repo convention, #1737). Lattice layout `((b*N+g)*N+r)*3+c` (red-fastest, matches `.cube` and `residual_lut`).
- `.mlut` and lattice constants: grid N=33, payload f16 LE, ~216 KB/look.
- XMP: fields emit only when non-default (`FilmLook` when non-empty; `FilmStrength` when ≠ 100). Passthrough of unknown attrs stays byte-for-byte.
- Formatting gates: prettier (pinned `src/web/node_modules/.bin/prettier`, from main checkout if worktree lacks node_modules) on all touched web/docs files; lefthook runs swift-format/shfmt on staged files. Repo is NOT rustfmt-clean — match local style, never `cargo fmt` whole files.
- Commit per task with explicit paths (`git add <paths>`, never `git add -A`).
- `PIPELINE_OUTPUT_VERSION` does NOT bump: default-off stage leaves existing sidecars' output unchanged.
- Every PR closes a ticket; PRs open ready-for-review; never merge without explicit user approval.

## Sequencing

- Task 0 → Tasks 1–6 (Phase 1, raw-core + ingest + codegen, sequential) → Tasks 7–9 (Phase 2, GPU/FFI/WASM, sequential) → Tasks 10–11 (Apple) and 12 (Web) may run in parallel worktrees → Task 13 (goldens + final gates).
- PR strategy: Phase 1 = PR 1, Phase 2 = PR 2 (stacked), Apple + Web + goldens = PR 3 (stacked), unless the user asks otherwise. Each PR references the epic ticket.

---

### Task 0: Epic ticket

**Files:** none (GitHub only)

- [ ] **Step 1: Create the epic issue**

```bash
gh issue create --title "Film emulation engine: 100-look catalog, display-referred LUT stage, Film UI" --body "$(cat <<'EOF'
Implements the approved design at docs/superpowers/specs/2026-08-06-film-emulation-engine-design.md.

- raw-core: .mlut codec, film_look stage (tetrahedral, display-referred), papp:FilmLook/papp:FilmStrength XMP fields
- ingest: maple-cli film-pack (.cube -> resources/film-luts/*.mlut + generated catalog), codegen'd Swift/TS catalog
- raw-gpu: FilmLutPass (ResidualLutPass pattern) + parity gate
- FFI/WASM: lattice upload on look change, per-tick scalars only
- Apple + Web: Film section (category picker + strength), XMP writers, lazy asset delivery
- Gates: ACR budgets untouched when off; WGSL parity; 6-look golden ratchet
EOF
)"
```

- [ ] **Step 2: Add it to the Files project board** (feature work → Files, per repo convention): `gh issue edit <N> --add-project Files`. Record the issue number for all commit/PR references below.

---

### Task 1: `.mlut` codec in raw-core

**Files:**

- Create: `src/raw-pipeline/raw-core/src/film.rs` (codec + `FilmLut` + tetra sampler; keep < 400 lines, split tests to `film/tests.rs` if needed)
- Modify: `src/raw-pipeline/raw-core/src/lib.rs` (add `pub mod film;`)

**Interfaces:**

- Produces: `film::FilmLut { size: usize, data: Vec<f32> }` (len = size³·3), `film::encode_mlut(size: usize, data: &[f32]) -> Vec<u8>`, `film::decode_mlut(bytes: &[u8]) -> Result<FilmLut, MlutError>`, `film::tetra_sample(size: usize, data: &[f32], rgb: [f32; 3]) -> [f32; 3]`.
- Format v1: bytes 0–3 magic `b"MLUT"`, 4–5 version u16 LE = 1, 6–7 grid u16 LE, 8.. payload grid³·3 × f16 LE, index `((b*N+g)*N+r)*3+c`.

- [ ] **Step 1: Write failing round-trip + validation tests** (in `film.rs` `#[cfg(test)]`):

```rust
#[test]
fn mlut_round_trip_preserves_f16_exact_values() {
    // k/32 grid values are exact in f16, so identity survives round-trip bitwise.
    let n = 3usize;
    let data: Vec<f32> = (0..n * n * n * 3).map(|i| (i % 32) as f32 / 32.0).collect();
    let lut = decode_mlut(&encode_mlut(n, &data)).unwrap();
    assert_eq!(lut.size, n);
    assert_eq!(lut.data, data);
}

#[test]
fn mlut_rejects_bad_magic_version_and_truncation() {
    let good = encode_mlut(2, &vec![0.5f32; 2 * 2 * 2 * 3]);
    assert!(decode_mlut(&good[1..]).is_err());          // bad magic
    let mut v = good.clone(); v[4] = 9;                  // bad version
    assert!(decode_mlut(&v).is_err());
    assert!(decode_mlut(&good[..good.len() - 2]).is_err()); // truncated payload
}

#[test]
fn tetra_sample_is_exact_at_lattice_nodes_and_monotone_on_diagonal() {
    let n = 5usize;
    // Identity lattice: node (r,g,b) stores (r,g,b)/(n-1).
    let data = identity_lattice(n); // local test helper, built with the layout formula
    for &v in &[0.0f32, 0.25, 0.5, 1.0] {
        let out = tetra_sample(n, &data, [v, v, v]);
        for c in 0..3 { assert!((out[c] - v).abs() < 1e-6); }
    }
    // Off-node point on identity lattice must reproduce the input.
    let out = tetra_sample(n, &data, [0.3, 0.7, 0.1]);
    assert!((out[0] - 0.3).abs() < 1e-6 && (out[1] - 0.7).abs() < 1e-6 && (out[2] - 0.1).abs() < 1e-6);
}
```

- [ ] **Step 2: Run to verify failure:** `cd src/raw-pipeline && cargo test -p raw-core --lib film` → FAIL (module missing).
- [ ] **Step 3: Implement.** Use the `half` crate for f16 (already a workspace dep for the fp16 chain; if raw-core doesn't list it, add `half = { workspace = true }`). Tetrahedral algorithm: copy the exact branch structure from `src/raw-pipeline/raw-gpu/src/residual_lut.wgsl` (the six-tetrahedron decomposition over the unit cube by fractional-coordinate ordering) into scalar Rust — same comparisons, same weights, clamped input `saturate(rgb) * (n-1)`. Do NOT refactor `auto_profile`'s residual CPU path; this is a fresh, self-contained sampler with its own tests, and Task 7's parity gate pins WGSL agreement.
- [ ] **Step 4: Run tests:** `cargo test -p raw-core --lib film` → PASS.
- [ ] **Step 5: Commit:** `git add src/raw-pipeline/raw-core/src/film.rs src/raw-pipeline/raw-core/src/lib.rs && git commit -m "feat(raw-core): .mlut film LUT codec + tetrahedral sampler (#<epic>)"`

---

### Task 2: Adjustment fields `film_look` / `film_strength` + XMP round-trip

**Files:**

- Modify: `src/raw-pipeline/raw-core/src/types/adjustment/mod.rs` (struct fields, after `grain_roughness`)
- Modify: `src/raw-pipeline/raw-core/src/types/adjustment/defaults.rs`
- Modify: `src/raw-pipeline/raw-core/src/types/adjustment/schema/types.rs` (add `FieldKind::String` variant with a doc comment mirroring `ToneCurve`'s "value type is hand-written per platform" note)
- Modify: `src/raw-pipeline/raw-core/src/types/adjustment/schema/mod.rs` (two `FieldSpec` entries, after `grain` entries, position matching struct order — `schema_matches_struct` in `schema/tests.rs` enforces this)
- Modify: `src/raw-pipeline/raw-core/src/xmp/fields.rs` (parse arms) and `src/raw-pipeline/raw-core/src/xmp/mod.rs::serialize` (write arms — these are `papp:` fields with no `crs:` home, so raw-core's partial-seed serializer carries them)
- Modify: `docs/xmp-canonical-format.md` § "Number fields and defaults" (+ a short `FilmLook` note: string attr, emitted when non-empty, unknown ids resolve at render time as identity)

**Interfaces:**

- Produces: `AdjustmentModel.film_look: String` (default `""`), `AdjustmentModel.film_strength: f32` (default `100.0`); XMP attrs `papp:FilmLook`, `papp:FilmStrength`.
- Schema entries (verbatim):

```rust
FieldSpec {
    name: "film_look",
    kind: FieldKind::String,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Film emulation look id from the film catalog (film design 2026-08-06); empty = none. XMP: papp:FilmLook.",
},
FieldSpec {
    name: "film_strength",
    kind: FieldKind::F32,
    range: (0.0, 100.0),
    default_f32: 100.0,
    enum_name: "",
    doc: "Film look blend strength in percent; 100 = full look, lerped in display-linear against the pre-look value. XMP: papp:FilmStrength.",
},
```

- [ ] **Step 1: Write failing XMP round-trip test** (follow the existing per-feature test convention in `xmp/`; put it where grain's round-trip lives or a sibling `#[cfg(test)]`):

```rust
#[test]
fn film_fields_round_trip_and_stay_silent_at_defaults() {
    let mut m = AdjustmentModel::default();
    assert_eq!(m.film_look, "");
    assert_eq!(m.film_strength, 100.0);
    let silent = serialize(&m, ...);
    assert!(!silent.contains("FilmLook") && !silent.contains("FilmStrength"));

    m.film_look = "color_negative_kodak_portra_400".into();
    m.film_strength = 62.0;
    let xml = serialize(&m, ...);
    assert!(xml.contains(r#"papp:FilmLook="color_negative_kodak_portra_400""#));
    assert!(xml.contains(r#"papp:FilmStrength="62""#));
    let back = parse(&xml).unwrap();
    assert_eq!(back.film_look, m.film_look);
    assert_eq!(back.film_strength, 62.0);
}
```

(Adapt `serialize`/`parse` call shapes to the module's existing test helpers — copy a neighboring grain/profile test's scaffolding.)

- [ ] **Step 2: Run:** `cargo test -p raw-core --lib xmp` → FAIL.
- [ ] **Step 3: Implement.** Adding `FieldKind::String` breaks exhaustive matches in `codegen/src/adjustment.rs` — fix them in this task minimally so the workspace compiles: Swift range arm `FieldKind::Enum | FieldKind::ToneCurve | FieldKind::String => {}`; TS interface arm emitting `{camel}: string;`; TS defaults arm emitting `{camel}: '',`; TS ranges arm skips. Parse arms in `fields.rs` (match the file's `set_field` conventions): `"papp:FilmLook" => m.film_look = value.to_string(),` and `"papp:FilmStrength" => m.film_strength = v()?,`. Serialize arms next to `papp:Profile`'s, honoring silence-on-default and attribute-escaping the string.
- [ ] **Step 4: Run:** `cargo test -p raw-core --lib` (full — `schema_matches_struct` and codegen compile included) → PASS.
- [ ] **Step 5: Regenerate + commit codegen outputs:** `tools/codegen.sh`, confirm the two generated files gained `filmLook`/`filmStrength` (Swift `FieldName` cases + range const for strength; TS members + defaults + range). Commit everything: `git add src/raw-pipeline/raw-core/src/types src/raw-pipeline/raw-core/src/xmp src/raw-pipeline/codegen/src/adjustment.rs docs/xmp-canonical-format.md src/apple/Packages/MapleCore/Sources/MapleCore/Generated/AdjustmentModel+Generated.swift src/web/projects/maple-common/src/lib/generated/adjustment-model.generated.ts && git commit -m "feat(raw-core): film_look/film_strength adjustment fields + XMP round-trip (#<epic>)"`

---

### Task 3: The `film_look` stage

**Files:**

- Create: `src/raw-pipeline/raw-core/src/stages/film_look.rs`
- Modify: `src/raw-pipeline/raw-core/src/stages/mod.rs` (register module)
- Modify: `src/raw-pipeline/raw-core/src/view/encode.rs` (factor a `pub fn srgb_degamma(x: f32) -> f32` inverse OETF next to `srgb_gamma` at line ~129 — the two existing private copies in `color/hsm.rs:288` and `color/dcp.rs:2880` stay untouched)
- Modify (only if absent): `src/raw-pipeline/raw-core/src/color/matrices.rs` — `pub const M_SRGB_TO_REC2020: Matrix3`, the exact inverse of `M_REC2020_TO_SRGB`; add a unit test asserting `M_REC2020_TO_SRGB × M_SRGB_TO_REC2020 ≈ I` within 1e-6 per element.

**Interfaces:**

- Consumes: `film::{FilmLut, tetra_sample}` (Task 1), `M_REC2020_TO_SRGB`, `srgb_gamma`, `srgb_degamma`.
- Produces: `pub fn apply(img: &mut Image, lut: &FilmLut, strength: f32)` — asserts `ColorSpace::DisplayLinearRec2020`, identity short-circuit when `strength <= 0.0`.

Per-pixel core (verbatim intent — adapt to the file's Vec3/Matrix3 helpers):

```rust
let original = px;                                    // display-linear Rec.2020
let s_lin = m_rec2020_to_srgb.mul_vec(original);      // linear sRGB (can exceed [0,1])
let enc = [srgb_gamma(s_lin[0]).clamp(0.0, 1.0), ...];// lattice domain
let f_enc = film::tetra_sample(lut.size, &lut.data, enc);
let f_lin = [srgb_degamma(f_enc[0]), ...];
let f_2020 = m_srgb_to_rec2020.mul_vec(f_lin);
let t = (strength / 100.0).clamp(0.0, 1.0);
px = [original[0] + (f_2020[0] - original[0]) * t, ...];
```

- [ ] **Step 1: Write failing stage tests** (`stages/film_look.rs` `#[cfg(test)]`, or sibling `film_look_tests.rs` for budget):

```rust
#[test]
fn strength_zero_is_bit_exact_noop() { /* random DisplayLinearRec2020 image incl. values >1 and <0; apply with any lattice at strength 0.0; assert pixels bitwise-equal via f32::to_bits */ }

#[test]
fn identity_lattice_at_full_strength_is_noop_within_1e6_for_in_gamut() { /* pixels drawn in [0,1] sRGB-gamut range; identity lattice (k/32 values, f16-exact); assert |delta| < 1e-6 */ }

#[test]
fn strength_is_linear_in_display_linear_domain() { /* out50 == 0.5*(out0 + out100) within 1e-6, using a non-trivial synthetic lattice */ }

#[test]
fn bw_lattice_yields_r_eq_g_eq_b() { /* lattice whose every entry is (l,l,l) with l = luma of node; colored input → output channels equal within 1e-6 */ }

#[test]
fn out_of_gamut_input_blends_toward_clamped_film_arm_only() { /* input with a channel at 1.4: at strength 0 unchanged (bitwise); at 100 equals the film arm computed from the clamped encode; at 50 exact midpoint */ }
```

- [ ] **Step 2: Run:** `cargo test -p raw-core --lib film_look` → FAIL.
- [ ] **Step 3: Implement** per the core above; mirror `grain.rs`'s module-doc style (document the domain contract, the clamp semantics, and the tetrahedral/#1737 rationale) and its `assert_space` + early-return shape.
- [ ] **Step 4: Run:** `cargo test -p raw-core --lib` → PASS (including the new matrix inverse test).
- [ ] **Step 5: Commit:** `git add src/raw-pipeline/raw-core/src/stages/film_look.rs src/raw-pipeline/raw-core/src/stages/mod.rs src/raw-pipeline/raw-core/src/view/encode.rs src/raw-pipeline/raw-core/src/color/matrices.rs && git commit -m "feat(raw-core): display-referred film_look stage (#<epic>)"`

---

### Task 4: Render-path insertion + threading `Option<&FilmLut>`

**Files:**

- Modify: `src/raw-pipeline/raw-core/src/pipeline/render/mod.rs` — insert between the `color_grade` stage (lines ~285–288) and the `grain` stage (line ~294):

```rust
if let Some(lut) = film_lut {
    stage("film_look", || film_look::apply(&mut scene, lut, model.film_strength));
    dump_after("16a2_film_look", &scene);
}
```

- Modify: the render entry chain so hosts can pass the lattice. Add a sibling public entry `render_from_raw_with_quality_source_and_film(raw, model, quality, raw_source, film_lut: Option<&film::FilmLut>)`; the existing `render_from_raw_with_quality_and_source` (`render/mod.rs:120-127`) delegates with `None`. Thread the parameter down to `render_display_scene` (follow the compiler; keep every existing public signature unchanged).

**Interfaces:**

- Consumes: Task 1 `FilmLut`, Task 3 `apply`.
- Produces: `render_from_raw_with_quality_source_and_film(...)` — the single entry all hosts (CLI Task 5, FFI Task 8, WASM Task 9) call when a look is active.

- [ ] **Step 1: Write failing pipeline test** (with the synthetic-render test utilities in `pipeline/render/synthetic.rs` / `test_support`): render the synthetic scene twice — `film_lut: None` vs `Some(identity_lattice)` with `model.film_strength = 100` and `model.film_look` set — assert byte-identical output for `None` vs "model fields set but lut None" (missing-asset → identity rule), and ≤1e-5 mean delta for the identity lattice.
- [ ] **Step 2: Run:** FAIL (entry doesn't exist).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -p raw-core --lib` → PASS. Then the no-op regression proof: `FILTER=baseline src/scripts/test_color_pipeline.sh` → identical numbers to a pre-change run (fixtures present locally; if absent, skip-pass is acceptable for the task but the phase-1 PR checklist requires a machine with fixtures).
- [ ] **Step 5: Commit:** `git add src/raw-pipeline/raw-core/src/pipeline && git commit -m "feat(raw-core): film_look render stage between color_grade and grain (#<epic>)"`

---

### Task 5: `maple-cli film-pack` ingest + committed `.mlut` pack + generated catalog

**Files:**

- Create: `src/raw-pipeline/maple-cli/src/commands/film_pack.rs` (`.cube` parser + `.mlut` emit + catalog emit; split `film_pack_tests.rs` as needed)
- Modify: `src/raw-pipeline/maple-cli/src/main.rs` (new `Cmd::FilmPack { cube_dir, out_dir, catalog_out }` clap variant), `src/raw-pipeline/maple-cli/src/commands/mod.rs`
- Modify: `src/raw-pipeline/maple-cli/src/commands/{batch.rs,render.rs}` — add `--film-lut-dir` (default `resources/film-luts` resolved from repo root); when the parsed model has non-empty `film_look`, read `<dir>/<id>.mlut`, `film::decode_mlut`, call the `_and_film` entry from Task 4; missing file → warn to stderr + render with `None`.
- Create (generated): `resources/film-luts/*.mlut` (100 files), `src/raw-pipeline/raw-core/src/film_catalog.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs` (`pub mod film_catalog;`)

**Interfaces:**

- Consumes: `film::{encode_mlut}` (Task 1).
- Produces: `film_catalog::{FilmCategory, FilmLookEntry { id, name, category }, FILM_CATALOG: &[FilmLookEntry]}` — hand-written types at the top of the generated file, table below; file header states "GENERATED by `maple-cli film-pack` from the external cube pack — edit via re-ingest, not by hand; not covered by codegen-drift (CI lacks the source pack)".
- `.cube` parser accepts: `TITLE`, `LUT_3D_SIZE 33`, `DOMAIN_MIN/MAX 0..1`, comment lines (`#`), blank lines, 35 937 whitespace-separated float triples; rejects everything else with file+line context.
- Display name: strip `<category>_` prefix from the stem, split on `_`, title-case each token with an `OVERRIDES` map for known acronyms (`"hp" → "HP"`, `"nc" → "NC"`, `"vc" → "VC"`, `"ns" → "NS"`, `"apx" → "APX"`, `"xpro" → "XPro"`, `"hg" → "HG"`, `"gx" → "GX"`, `"vs" → "VS"`, `"rsx" → "RSX"`, `"fg" → "FG"`, `"sc" → "SC"`, `"vx" → "VX"`, `"t" → "T"`, `"d" → "D"`, `"e" → "E"`), numbers verbatim. Deterministic output: entries sorted by (category, id); fixed formatting so re-runs are byte-stable.

- [ ] **Step 1: Write failing parser/emit tests** (tiny inline `.cube` strings: happy path 2³, comments/blank lines, wrong size, malformed row, non-finite value; name derivation cases incl. `ilford_hp_5 → "Ilford HP 5"`).
- [ ] **Step 2: Run:** `cargo test -p maple-cli` → FAIL.
- [ ] **Step 3: Implement** parser, `.mlut` writer, catalog emitter, CLI wiring, and the `--film-lut-dir` render threading.
- [ ] **Step 4: Run tests** → PASS. Then run the real ingest: `cargo run --release -p maple-cli -- film-pack --cube-dir /Users/riabuz/Projects/MapleCube --out-dir resources/film-luts --catalog-out src/raw-pipeline/raw-core/src/film_catalog.rs`. Verify: exactly 100 `.mlut` files, each ~216 KB; `FILM_CATALOG.len() == 100`; spot-check `film::decode_mlut` on `color_negative_kodak_portra_400.mlut` reproduces the `.cube`'s first/last triples within f16 tolerance (write this as a fixture-gated `#[ignore]`-style test that skips when `resources/film-luts` is absent — it won't be, since the pack is committed).
- [ ] **Step 5: End-to-end smoke:** craft a temp XMP with `papp:FilmLook="slide_fuji_velvia_50"` and render any fixture DNG (or the synthetic input) via `maple-cli render`; assert non-zero pixel delta vs the no-look render of the same input.
- [ ] **Step 6: Commit** (explicit paths; the 100 `.mlut` files are intentional): `git add src/raw-pipeline/maple-cli resources/film-luts src/raw-pipeline/raw-core/src/film_catalog.rs src/raw-pipeline/raw-core/src/lib.rs && git commit -m "feat(cli): film-pack ingest; commit 100-look .mlut pack + generated catalog (#<epic>)"`

---

### Task 6: Catalog codegen → Swift + TS constants

**Files:**

- Create: `src/raw-pipeline/codegen/src/film_catalog.rs` (emitters)
- Modify: `src/raw-pipeline/codegen/src/main.rs` (`--schema film-catalog`, targets swift|ts, dispatch)
- Modify: `tools/codegen.sh` (two invocations, output paths below)
- Create (generated): `src/apple/Packages/MapleCore/Sources/MapleCore/Generated/FilmCatalog+Generated.swift`, `src/web/projects/maple-common/src/lib/generated/film-catalog.generated.ts`

**Interfaces:**

- Consumes: `raw_core::film_catalog::FILM_CATALOG` (codegen links raw-core, same as `ADJUSTMENT_SCHEMA`).
- Produces (Swift): `public enum FilmCategory: String, CaseIterable` (six cases, raw values = snake_case dir names), `public struct FilmLookEntry: Sendable { public let id: String; public let name: String; public let category: FilmCategory }`, `public enum FilmCatalog { public static let all: [FilmLookEntry] }`.
- Produces (TS): `export type FilmCategory = 'black_white' | 'cinema_print' | 'color_negative' | 'consumer_vintage' | 'instant' | 'slide'; export interface FilmLookEntry { readonly id: string; readonly name: string; readonly category: FilmCategory; } export const FILM_CATALOG: readonly FilmLookEntry[]`.

- [ ] **Step 1: Write the emitters** (string-building style copied from `adjustment.rs`; deterministic ordering passes through from the table).
- [ ] **Step 2: Wire CLI + codegen.sh, run `tools/codegen.sh`**, verify both files: 100 entries, compiles (`swift build` deferred to Task 10's cycle; for now `cd src/web && bun x tsc --noEmit -p projects/maple-common` if a project tsconfig check exists — otherwise the Task 12 build covers it).
- [ ] **Step 3: Run the drift gate locally:** re-run `tools/codegen.sh` → `git diff --exit-code` on generated paths → clean.
- [ ] **Step 4: Commit:** `git add src/raw-pipeline/codegen tools/codegen.sh src/apple/Packages/MapleCore/Sources/MapleCore/Generated/FilmCatalog+Generated.swift src/web/projects/maple-common/src/lib/generated/film-catalog.generated.ts && git commit -m "feat(codegen): film catalog Swift/TS emission (#<epic>)"`

**Phase 1 gate (before PR 1):** `cargo test -p raw-core --lib && cargo test -p maple-cli && src/scripts/test_color_pipeline.sh` (fixtures machine) all green; `tools/check-file-budget.sh` clean on new files; prettier on touched web/docs. Open PR 1 (`Closes #<epic>`? No — epic stays open; write `Part of #<epic>`; only the FINAL PR carries `Closes`).

---

### Task 7: GPU `FilmLutPass` + parity gate

**Files:**

- Create: `src/raw-pipeline/raw-gpu/src/film_lut.rs`, `src/raw-pipeline/raw-gpu/src/film_lut.wgsl`, `src/raw-pipeline/raw-gpu/src/film_lut/tests.rs`
- Modify: `src/raw-pipeline/raw-gpu/src/context.rs` + `context_pipelines.rs` (pipeline `OnceCell` + accessor `film_lut_pipeline()`, compiled with `compile_with_matrices` so `generated/color_matrices.wgsl` constants are available)
- Modify: `src/raw-pipeline/raw-gpu/src/full_chain.rs` (`build_split`, unconditional composer) and `src/raw-pipeline/raw-gpu/src/live_chain.rs` (`build_live_split`, insert after the `color_grade_is_identity` block ~line 288, before the grain gate; gate: `inputs.film_lut_size > 0 && inputs.film_strength > SLIDER_EPS`); `active_mask()` next free bit; `chain_signature()` folds `film_lut_key`
- Modify: `src/raw-pipeline/raw-gpu/src/live_chain/tests_gating.rs` (new gating case: film inputs on → pass present + mask bit; default inputs → counts unchanged)
- Modify: `FullChainInputs` (wherever defined per `full_chain.rs`) — add `film_strength: f32`, `film_lut_size: u32`, `film_lut_key: u32`, `film_lut_data: Vec<f32>` (empty = off), mirroring the `residual_lut` fields' shape

**Interfaces:**

- Consumes: `raw_core::stages::film_look::apply` (dev-dep, parity oracle), `raw_core::film::FilmLut`.
- Produces: `FilmLutPass { size: u32, strength: f32, data: Vec<f32> }` implementing `Pass`; WGSL bindings: 0 uniform `Params { count: u32, size: u32, strength: f32, _pad: u32 }`, 1 src storage, 2 dst storage, 3 lut read-only storage (via `pool_data_storage`, 4-byte stride).
- WGSL kernel per texel: rec2020→srgb matrix (from generated matrices; if `M_SRGB_TO_REC2020` is not yet in `color_matrices.wgsl`, extend `codegen/src/color_matrices.rs` to emit it in the same commit), srgb encode/decode fns local to the file (copy the piecewise constants from the existing srgb gamma WGSL), tetrahedral sampler copied from `residual_lut.wgsl` adapted to this lattice, then `mix(original, film, strength/100)`.

- [ ] **Step 1: Write failing parity test** (`film_lut/tests.rs`, mirroring `grain/tests.rs`): deterministic pseudo-random 64×64 DisplayLinearRec2020 image (PCG, fixed seed, include >1 and <0 values) + deterministic pseudo-random 33³ lattice; CPU oracle = `film_look::apply`; assert `max_diff < 1e-4`; second case `strength: 37.0`.
- [ ] **Step 2: Run:** `cargo test -p raw-gpu film_lut` → FAIL.
- [ ] **Step 3: Implement** pass + WGSL + wiring; validate WGSL early with `src/scripts/check_wgsl.sh`.
- [ ] **Step 4: Run:** `cargo test -p raw-gpu` (full crate — chain/gating/oracle tests included) → PASS.
- [ ] **Step 5: Commit:** `git add src/raw-pipeline/raw-gpu src/raw-pipeline/codegen/src/color_matrices.rs <generated wgsl if touched> && git commit -m "feat(raw-gpu): FilmLutPass with tetrahedral WGSL + parity gate (#<epic>)"`

---

### Task 8: FFI surface (Apple): per-tick params + decode entry + full-render sibling

**Files:**

- Modify: `src/raw-pipeline/raw-ffi/src/gpu_live.rs` (`MapleGpuLiveParams` tail append: `film_strength: f32`, `film_lut_size: u32`, `film_lut_key: u32`, `film_lut_ptr: *const f32`, `film_lut_len: usize` — append-only ABI convention)
- Modify: `src/raw-pipeline/raw-ffi/src/gpu_live/params.rs` (`inputs_from_params` maps the new fields into `FullChainInputs`; null/zero ptr → off)
- Create/Modify: `src/raw-pipeline/raw-ffi/src/film.rs` — `#[no_mangle] pub extern "C" fn maple_film_lut_decode(bytes: *const u8, len: usize, out: *mut f32, out_cap: usize) -> i32`: returns grid size N (>0) after writing N³·3 floats, `-1` malformed, `-2` `out_cap` too small (caller sizes as 33³·3 = 107 811; the rc contract mirrors `maple_gpu_fit_auto_profile`'s grow-and-retry)
- Modify: `src/raw-pipeline/raw-ffi/src/render.rs` — locate the full-render entry Apple's refine/export path calls; add an `_with_film` sibling symbol taking `(film_lut_ptr: *const f32, film_lut_len: usize, film_lut_size: u32)` and calling Task 4's `_and_film` core entry; existing symbol delegates with null/None
- Regenerate headers: `cbindgen` runs inside `./src/apple/scripts/build-xcframework.sh` (staleness hash includes `cbindgen.toml`); for the crate-level test cycle `cargo build -p raw-ffi --features gpu` suffices

**Interfaces:**

- Consumes: Tasks 1, 4, 7.
- Produces: the three FFI additions above, consumed by Task 10. `film_lut_key` is any host-stable u32 identifying the loaded look (Task 10 uses the FNV-1a hash of the id string; 0 reserved for "none").

- [ ] **Step 1: Write failing FFI tests** (pattern: `gpu_live_tests.rs` / `render_tests.rs`): decode-entry happy/malformed/too-small cases; a `gpu_live` parity-style test building `MapleGpuLiveParams` with a synthetic lattice and asserting the render differs from film-off and matches the CPU reference within the existing chain tolerance.
- [ ] **Step 2: Run:** `cargo test -p raw-ffi --features gpu` → FAIL, implement, → PASS.
- [ ] **Step 3: Commit:** `git add src/raw-pipeline/raw-ffi && git commit -m "feat(raw-ffi): film LUT decode + per-tick film params + full-render sibling (#<epic>)"`

---

### Task 9: WASM surface (Web): session method + worker protocol

**Files:**

- Modify: `src/raw-pipeline/raw-wasm/src/web_live_session.rs` — `#[wasm_bindgen] pub fn set_film_lut(&mut self, bytes: &[u8], look_key: u32) -> Result<(), JsValue>` (decode via `film::decode_mlut`, store `Vec<f32>` + key + size on the session; `clear_film_lut()` resets); fold the stored fields into the `FullChainInputs` built per tick in `render`/`render_with_params`
- Modify: the wasm full-res/export render path (the non-session `render_bytes`-family entry the worker's export/develop handler calls): additive sibling accepting film lattice bytes, delegating like Task 8's render sibling
- Modify: `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.types.ts` — `SetFilmLutRequest { id, type: 'set-film-lut', lookKey: number, bytes: ArrayBuffer }` (+ empty-bytes = clear) and response; export-request types gain optional `filmLut?: ArrayBuffer`
- Modify: `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.worker.ts` — dispatch case calling `liveSession.set_film_lut(new Uint8Array(bytes), lookKey)` through `enqueueSessionOp`; `postMessage` transfers the buffer in

**Interfaces:**

- Consumes: Tasks 1, 4, 7.
- Produces: worker message `'set-film-lut'` + export-path `filmLut` bytes, consumed by Task 12.

- [ ] **Step 1: Rust-side test** (`raw-wasm` native-target tests where they exist — `cargo test -p raw-wasm --features gpu` pattern from CI): session set/clear round-trip changes the chain signature and render output on the synthetic image.
- [ ] **Step 2: Implement wasm + worker/types; run `cargo test -p raw-wasm --all-features` and `wasm-pack build --target web` + `src/web/scripts/sync-raw-wasm.sh`.**
- [ ] **Step 3: Commit:** `git add src/raw-pipeline/raw-wasm src/web/projects/maple-common/src/lib/raw-pipeline && git commit -m "feat(raw-wasm): film LUT session upload + worker protocol (#<epic>)"`

**Phase 2 gate (before PR 2):** `cargo test -p raw-gpu && cargo test -p raw-ffi --features gpu && cargo test -p raw-wasm --all-features && src/scripts/check_wgsl.sh` green.

---

### Task 10: Apple — assets, session wiring, XMP writers

**Files:**

- Modify: `src/apple/Maple.xcodeproj/project.pbxproj` — folder reference to repo-root `resources/film-luts` in the app target's Resources build phase (the Fonts precedent); loaded via `Bundle.main.url(forResource: id, withExtension: "mlut", subdirectory: "film-luts")`
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FilmLutStore.swift` — `public struct FilmLutStore { public init(bundle: Bundle = .main); public func lattice(for id: String) -> (data: [Float], size: Int, key: UInt32)? }` — reads the `.mlut`, calls `maple_film_lut_decode` (grow-retry per Task 8 contract), caches last-used in a one-entry LRU; FNV-1a(id) as key, never 0
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/GpuLiveSession.swift` — `setFilmLut(data: [Float], size: Int, key: UInt32)` / `clearFilmLut()` cached like `autoProfile`; `withGpuLiveParams` binds `film_lut_ptr/len/size/key + film_strength` each tick from the cache (nested `withUnsafeBufferPointer`, pointer never stored)
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/GpuLiveParams.swift` (`makeGpuLiveParams` maps `model.filmStrength`)
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift` (+ the render extension it delegates to): on `model.filmLook` change, resolve via `FilmLutStore` and update the session before scheduling the render; CPU refine/export path calls the Task 8 `_with_film` sibling with the same cached lattice; missing asset → log + identity (never error)
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift` (`public var filmLook: String = ""`, `public var filmStrength: Double = 100`), `AdjustmentModel+Enums.swift` untouched
- Modify: `XMPSerialization+Attrs.swift` (emit `papp:FilmLook` when non-empty — XML-escaped — and `papp:FilmStrength` when ≠ 100, next to the `papp:Profile` arms) and `XMPSerialization+ParseAttrs.swift` (parse arms)
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FilmLookXMPTests.swift` (mirror `ColorGradingXMPTests.swift`: real-file round-trip in a temp dir — no sidecar mocks; defaults-silent case; unknown-id passthrough-to-model case) and `FilmLutStoreTests.swift` (test bundle with a tiny fixture `.mlut`; missing-id → nil)

**Interfaces:**

- Consumes: Task 6 `FilmCatalog`, Task 8 FFI symbols (rebuild xcframework first: `./src/apple/scripts/build-xcframework.sh` — release, per the pano-perf warning).
- Produces: `FilmLutStore`, session film state — consumed by Task 11's UI.

- [ ] **Step 1: Write the failing Swift tests** (XMP + store), run `cd src/apple/Packages/MapleCore && swift test --filter Film` → FAIL.
- [ ] **Step 2: Implement; rebuild xcframework; tests → PASS.** Full-suite note: `swift test` unfiltered is ~10 min; run filtered locally, full suite once before the PR.
- [ ] **Step 3: Build the app:** `xcodebuild -project src/apple/Maple.xcodeproj -scheme "Maple Exposure" -destination 'platform=macOS' build` → succeeds.
- [ ] **Step 4: Commit:** `git add src/apple && git commit -m "feat(apple): film LUT store, session wiring, XMP fields (#<epic>)"`

---

### Task 11: Apple — Film UI section

**Files:**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Editor/ToolModel.swift` — `case filmLook` in `Tool`, grouped `.effects`, declared between `grain` and `colorGrade` (declaration order = presentation order)
- Create: `src/apple/Maple/Views/FilmSection.swift` — bespoke panel (the `ToneCurveSection.swift` shape, since a 100-item picker has no primary drag-bar field): six category groups from `FilmCatalog.all` (grouped `Dictionary(grouping:by:)`, stable category order matching `FilmCategory.allCases`), look rows with selection state, a "None" row clearing `model.filmLook`, and a strength slider bound to `model.filmStrength` visible only when a look is active. Accessibility identifiers: `editor-dock-tool-filmLook`, `film-look-row-<id>`, `film-look-none`, `slider-film-strength`; every control labelled.
- Modify: whatever switch presents tool panels (follow how `ToneCurveSection` is mounted from the editor chrome — same file set as `GroupTabsView`/`ToolPillRow`)
- Create: `src/apple/MapleUITests/FilmPanelUITests.swift` — presence/reachability test in the `ToneCurvePanelUITests.swift` pattern (arm `editor-dock-tool-filmLook`, assert category groups + a known row + strength slider exist and are labelled). Note: XCUITest automation-mode is blocked on this Mac (#2525) — write the test to the existing pattern; verification on this machine is via the built app's accessibility tree, CI/other-machine for the runner.

**Interfaces:**

- Consumes: Task 6 `FilmCatalog`, Task 10 model fields + wiring (writes to `model.filmLook`/`model.filmStrength` flow through `EditSession.model.didSet` → render + debounced sidecar autosave automatically).

- [ ] **Step 1: Implement the section + tool registration.**
- [ ] **Step 2: Build + launch the macOS app** (open the built `.app` per `docs`/memory playbook), inspect the accessibility tree for the new identifiers, screenshot the Film panel open with a look selected.
- [ ] **Step 3: Functional proof:** select `Kodak Portra 400` on a fixture image, confirm (a) canvas changes, (b) the sidecar `.xmp` on disk gains `papp:FilmLook="color_negative_kodak_portra_400"` after the autosave debounce, (c) relaunch restores the look.
- [ ] **Step 4: Commit:** `git add src/apple && git commit -m "feat(apple): Film section UI with catalog picker + strength (#<epic>)"`

---

### Task 12: Web — XMP fields, asset delivery, Film UI

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/xmp/xmp-fields.ts` (`numericField('papp:FilmStrength', 'filmStrength')`), `xmp-serializer.service.ts` (emit `papp:FilmLook` when non-empty, escaped, beside the `papp:Profile` arm; strength handled by the field table's default suppression — default 100), `xmp-parser.service.ts` (parse both; `filmLook` passes through verbatim)
- Create: `src/web/projects/maple-common/src/lib/xmp/film-look.spec.ts` (serialize→parse round-trip; silent-at-defaults; unknown id preserved)
- Modify: `src/web/projects/maple-common/src/lib/models/adjustment-model.ts` only if the hand-extension needs the new members surfaced (generated interface from Task 2 already carries them)
- Modify: `src/web/angular.json` — both app builds gain an assets entry `{ "glob": "*.mlut", "input": "../../resources/film-luts", "output": "/film-luts" }` (path relative to `src/web`, matching the existing raw-wasm glob's style)
- Modify: `src/web/ngsw-config.json` + `ngsw-config.hosted.json` — `dataGroups` entry `{ "name": "film-luts", "urls": ["/film-luts/*.mlut"], "cacheConfig": { "strategy": "performance", "maxSize": 12, "maxAge": "30d" } }`
- Create: `src/web/projects/maple-common/src/lib/film/film-lut.service.ts` + `film-lut-idb-cache.ts` + specs — `getLattice(lookId): Promise<ArrayBuffer | null>`: IDB cache (`util/idb.ts` primitives, DB `maple-film-lut-cache`, store keyed by id — the `sidecar-idb-cache.ts` shape) → fetch `/film-luts/${id}.mlut` → cache → return; null on 404 (identity + console.warn, never a thrown render error). FNV-1a key helper shared with the worker message.
- Modify: `src/web/projects/maple-common/src/lib/components/editor/control-card.component.ts` (+ `.html`/`.scss`) — `SUBTOOLS.effects` gains `{ id: 'filmLook', label: 'Film' }`
- Create: `src/web/projects/maple-common/src/lib/components/editor/film-panel.component.{ts,html,scss}` + spec — standalone, signals, `input()`/`output()`; category-grouped list from `FILM_CATALOG`, None row, strength slider; selection → `libraryState.updateAdjustment(id, { filmLook })`, slider → `{ filmStrength }` (the existing debounced sidecar-write + preview-persist chain takes over)
- Modify: the canvas/session glue (where the worker client watches `adjustmentFor(id)`) — an effect that, when `filmLook` changes, awaits `FilmLutService.getLattice`, posts `'set-film-lut'` (transferring the buffer — re-fetch from cache per send since transfer detaches), and includes `filmLut` bytes in export/develop requests when active

**Interfaces:**

- Consumes: Task 6 TS catalog, Task 9 worker protocol, Task 2 generated model fields.

- [ ] **Step 1: Write failing specs** (XMP round-trip; film-lut service cache-hit/miss/404 with mocked fetch; panel component renders 6 groups and dispatches `updateAdjustment` on click), run `cd src/web && bun run test` (project `Maple-common`) → FAIL.
- [ ] **Step 2: Implement; specs → PASS.** Worktree provisioning if needed: `HOME=/tmp/x bun install` per memory playbook; sync raw-wasm first.
- [ ] **Step 3: Live verification in the real dev server** (required by repo feedback memory): `bun x ng serve maple`, MAPLE_DEV_AUTH=1 API if needed; load a test DNG, open Effects → Film, select Velvia 50: canvas changes, network shows one `/film-luts/slide_fuji_velvia_50.mlut` fetch (IDB-cached on repeat), XMP PUT carries `papp:FilmLook`. Screenshot as proof.
- [ ] **Step 4: Format + commit:** `bun run format`, then `git add src/web resources 2>/dev/null || git add src/web && git commit -m "feat(web): Film panel, lazy .mlut delivery, XMP fields (#<epic>)"`

---

### Task 13: Golden ratchet + final gates + PR

**Files:**

- Create: `src/scripts/test_film_looks.sh` (pattern: `test_synthetic_grey.sh` — bash, fixture-gated skip-pass, no `timeout` builtin on this Mac)
- Create (generated on first run): `test-fixtures/references/film/test_0017-<look>.png` goldens for six looks (one per category: `black_white_kodak_tri_x_400`-equivalent id from the catalog, `cinema_print` first entry, `color_negative_kodak_portra_400`, `consumer_vintage` first, `instant` first, `slide_fuji_velvia_50` — pin the exact six ids in the script)
- Script behavior: for each look, write a temp XMP (`papp:FilmLook` + strength 100), `maple-cli render` `test-fixtures/raws/test_0017.dng` at fixed size, compare vs the committed golden with `src/scripts/compare_images.py`; budgets mean ≤ 0.5 / max ≤ 2.0 ΔE00 (self-consistency, tight); missing golden → write baseline + fail with "baseline written" (the UITest harness convention); missing fixtures → "skipping" + exit 0

- [ ] **Step 1: Write the script; first run records baselines; eyeball each PNG once (they are creative looks — the eyeball is for "not obviously broken", the gate is the ΔE ratchet); re-run → PASS.** Save renders under `~/Desktop/maple-color-tests/<epic>/` per repo feedback memory.
- [ ] **Step 2: Full gate sweep:** `cargo test -p raw-core --lib`, `cargo test -p raw-gpu`, `cargo test -p raw-ffi --features gpu`, `cargo test -p raw-wasm --all-features`, `src/scripts/test_color_pipeline.sh` (budgets identical to main), `swift test` (full, once), `bun run test`, `bun run format:check`, `tools/codegen.sh` + clean diff, `tools/check-file-budget.sh`.
- [ ] **Step 3: Commit goldens + script; rebase on origin/main (`git fetch origin main && git rebase origin/main`), re-run affected gates, push with `--force-with-lease` if rebased.**
- [ ] **Step 4: Open the final PR** ready-for-review with `Closes #<epic>`, body summarizing the three-layer delivery + gate results, ending with the standard generated-with-Claude-Code footer. Do NOT merge — merging always waits for explicit user approval.

---

## Self-review notes (already applied)

- Spec coverage: stage math/placement (T3–T4), assets+catalog (T5–T6), GPU parity (T7), FFI/WASM once-per-look upload (T8–T9), Apple delivery+UI+XMP (T10–T11), Web delivery+UI+XMP (T12), goldens+regression gates (T13), ticket rules (T0). Dropped-spec items (LogC3, H-D stage, hash21 grain, JSON recipes, viewfinder) intentionally absent per the design doc.
- Type consistency: `FilmLut{size,data}`, `tetra_sample(size,data,rgb)`, `film_lut_key: u32` (FNV-1a, 0=none), worker `'set-film-lut'` — names used identically across tasks.
- Known unknowns delegated with locate-instructions rather than invented signatures: the exact Apple full-render FFI entry name (T8), the wasm export-path entry (T9), the tool-panel mount switch (T11), the canvas/session glue site (T12). Each task says where to look and what precedent to copy.
