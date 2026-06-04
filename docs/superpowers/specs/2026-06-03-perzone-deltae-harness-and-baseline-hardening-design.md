# Per-zone ΔE diagnostics + colorimetric baseline hardening — design

Tickets: to be opened on plan approval (Files board) — a tooling ticket for the per-zone/per-hue ΔE harness, and an ACR-parity ticket for the test_0003 baseline. Originates from the "Hybrid Color Pipeline" RFC v2 (§3.1). Drafted 2026-06-03.

This is a **design** spec. It defines a diagnostic harness extension and an evidence-driven baseline-hardening investigation. It does **not** pre-commit to a specific pixel-level fix for test_0003 — the fix follows the measurement. It is **Feature 1 of two**; Feature 2 (the runtime chroma-match override, RFC §3.2) gets its own spec.

---

## The load-bearing verdict (read this first)

**The RFC's §3.1 "value-collapsed HueSatMap" sub-feature is misaimed against this codebase, and we are not building it. The RFC's _goal_ — per-camera color truth that doesn't fight AgX — is already met by the shipped CM/FM + 2D-HSM path. What is actually missing is the _instrument_ to see where the baseline is still wrong, and an evidence-driven fix on `test_0003` — the path most frames actually take.**

The evidence, established during scoping:

1. **The value-dependence the RFC wants to collapse is not in the HueSatMap.** Every DNG fixture we have carries a **2D** HueSatMap (`ProfileHueSatMapDims` valDivs = 1: test_0000 `36×10×1`, test_0006/0007 `90×30×1`). The value axis lives in the **ProfileLookTable** (test_0006/0007: `ProfileLookTableDims 36 8 16`, valDivs = 16). There is no fixture with a 3D HueSatMap to collapse.
2. **The 2D HueSatMap is already applied** (`color/dcp.rs:285` calls `hsm::apply`), via the source-DNG fallback in `to_dcp_profile` (`color/profile_loader/mod.rs`). It is _not_ gated by #825 (only the _bundle_ shipping HSM is). For embedded-profile DNGs the 2D HSM is live today; for proprietary raws like `test_0003`'s CR2 there is **no HSM at all**.
3. **The ProfileLookTable is deliberately dropped** (#425). It is parsed and stored on `raw.plt` but there is **no PLT apply call anywhere in non-test source** — confirmed by grep. The apply path (`color/dcp.rs:217`) is colorimetry-only (CM/FM + 2D HSM). The PLT is Adobe's _aesthetic look_, calibrated to sit under Adobe's tone curve; it collides with AgX. The stale "PLT stays / ~10 ΔE regression" comment at `profile_loader/mod.rs:199` describes a build-time flag, not the apply path.
4. **The ACR look is already chased from two other stages** — DisplayLookCurve (#519, ~65% of the bias-to-ACR gap) and Auto Profile (#550). A collapsed-PLT correction would be a _third_ overlapping look mechanism on a baseline that is supposed to stay colorimetric.

Conclusion (user-confirmed during scoping): **harden the baseline, don't add a look.** Concretely:

- The harness emits only global `mean / p95 / max / bias` today (`src/scripts/compare_images.py`). It cannot answer "is the error in shadows or highlights, in reds or greens?" — the exact question the RFC's §4/§5 assume a "ΔE-by-tonal-zone harness" can answer, and the exact question needed to diagnose a loose baseline. **Build that instrument first** — it is reused unchanged by Feature 2.
- **test_0003** (Canon EOS 5DS R, CR2) is the **common case**: a proprietary raw with no embedded DCP profile, so its color comes entirely from the **bundled matrices** — with **no HueSatMap applied at all** (the bundle is matrices-only). It sits at **mean ΔE 6.26** against an ACR reference rendered with ACR's default profile for the body. This is the deterministic baseline for the path most frames take (most cameras shoot proprietary raw, not DNG), and it is missing the one per-camera correction the linear matrix cannot express. Use the new instrument to localize the 6.26, then ship what it shows is missing.

---

## Goals / non-goals

**Goals**

- A reusable per-tonal-zone and per-hue ΔE2000 breakdown over any candidate/reference pair, with optional spatial ΔE heatmap for localization. Single source of truth for diff math (the harness stops inlining its own copy).
- A diagnostic mode on `test_color_pipeline.sh` that prints the breakdown for matched cases without changing CI gating.
- A localized diagnosis of test_0003's looseness, an evidence-driven fix (or a documented irreducible floor), and a budget ratcheted down in the same commit.
- Target **test_0003** (Canon EOS 5DS R, CR2) — the bundle/matrices path every non-DNG body uses; existing ACR reference + budget (mean 6.26); no embedded profile to confound the diagnosis. The instrument and the diagnosis itself need **no** bundle work.

**Non-goals**

- **No value-collapsed PLT or HSM.** Not this cycle, not as a baseline layer, not as a look (the look is already covered by #519/#550). (Sole exception: if the 5DS R's sourced HSM turns out 3D, the value-axis decision re-enters for that one table — see Component 2.)
- **No new per-zone CI gates.** Global `mean/p95/max/bias` remain the only gates; the one-way ratchet in `test-fixtures/budgets.json` is untouched. Per-zone/per-hue numbers are diagnostic output only (user-confirmed).
- **No broad HSM rollout.** If the diagnosis points to a missing HueSatMap, Feature 1 ships it for the fixture body (the 5DS R) only and measures the win. Shipping HSM for the full ~1,400-body bundle — its size and lazy delivery — is #828/#829, out of scope here.
- **No Apple/Web wiring this cycle.** A diagnostic harness needs none. _If_ the `test_0003` fix changes GPU-resident constants (a matrix / HSM table), that propagation is a scoped follow-up step (codegen already syncs Rust→Swift→TS constants); a decode/bundle-side fix needs no GPU work at all.
- **Not the chroma override.** RFC §3.2 is Feature 2, a separate spec.

---

## Component 1 — the per-zone / per-hue ΔE instrument

### Where the math lives

Today `src/scripts/compare_images.py` computes the diff (sRGB→XYZ→Lab, per-pixel CIEDE2000, per-channel bias), and `src/scripts/test_color_pipeline.sh` **re-inlines a near-identical copy** of that math in a heredoc (≈ lines 153–177). That duplication is a latent drift bug and blocks a single place to add zones.

**Refactor:** make `compare_images.py` the one implementation. It exposes a `diff(cand_path, ref_path, *, zones=False, hue_bins=0, heatmap=None) -> dict`. The shell harness imports/execs it instead of re-inlining. The global numbers it returns must be **bit-for-bit identical** to today's for the non-zone path (validated below) so the existing budgets keep their meaning.

### What it computes

All binning uses the **reference's** Lab (ground truth), so bin membership is stable regardless of candidate error. The candidate is Lanczos-resized to the reference dims exactly as today before any binning.

- **Luma zones** — partition pixels by reference `L*` into shadow / mid / highlight (default even terciles: `L* < 33.3`, `33.3 ≤ L* < 66.6`, `≥ 66.6`; thresholds are flags). Per zone: `mean / p95 / max` ΔE2000, per-channel bias, pixel count.
- **Hue bins** — partition by reference hue angle `atan2(b*, a*)` into `N` bins (default 12 × 30°). Per bin: mean ΔE2000, mean `a*`/`b*` bias (directional cast), pixel count. Pixels with chroma `C* = hypot(a*, b*)` below a threshold (default 5) are **excluded from hue bins** (their hue is ill-defined) and reported in a separate `neutral` bucket — this is what separates "a global tint" from "a specific hue family is wrong."
- **Zone × hue table** — the cross-tab (zones × hue bins of mean ΔE), emitted in the standalone report. This is the cell that says "reds in highlights are off by ΔE X."
- **Spatial ΔE heatmap** (optional `--heatmap out.png`) — per-pixel ΔE mapped to a fixed scale, for quantitative localization of _where in the frame_ the error concentrates (sky vs. a colored object). A measurement, not a color judgment.

Output: a JSON object (machine-readable, superset of today's keys so nothing downstream breaks) plus a human-readable table. The standalone single-case form: `compare_images.py <cand> <ref> --zones --hue-bins 12 --heatmap /tmp/h.png`.

### Harness mode

`test_color_pipeline.sh` gains `ZONES=1` (env, mirroring `FILTER`/`KEEP_TMP`). When set, after the normal pass/fail table it prints the per-zone + per-hue breakdown for each compared case. **Gating is unchanged** — the verdict still comes only from the global `mean/p95/max/bias` vs budgets.json. Skip-pass-on-missing-fixtures behavior is preserved.

### Validation of the instrument itself

1. **No-drift:** for a sample of cases, the global `mean/p95/max/bias` from the refactored `compare_images.py` must equal the pre-refactor harness output (within f32 tolerance). This is the gate that the refactor didn't move existing budgets.
2. **Self-consistency:** the population-weighted mean of the per-zone means must reconstruct the global mean (within tolerance); same for hue bins + neutral bucket. A unit test asserts this on a fixed pair.
3. **Attribution:** a synthetic test — take a reference, produce a candidate that differs _only_ in (red pixels, highlight zone) by a known ΔE — and assert the harness attributes the ΔE to that zone/hue cell and ~zero elsewhere.

---

## Component 2 — diagnose and harden test_0003

### What's different about this fixture

`test_0003` is a **Canon EOS 5DS R CR2 with no embedded DCP profile** (confirmed: no ColorMatrix / ForwardMatrix / HueSatMap / LookTable tags in the file). Its color is resolved from the **bundled Maple profile** for the body (matrices; the bundle is matrices-only, so **no HueSatMap and no PLT are applied**). The ACR reference was rendered with ACR's _default_ profile for the body (Adobe Color / Adobe Standard / a camera-matching profile — unknown, resolved below). So the gap is cleaner than an embedded-profile DNG: **bundled matrices, no per-camera HueSatMap** vs **ACR's default profile**. The harness and the diagnosis need no bundle work; only the HSM fix-branch would, and that's scoped to the fixture body.

There is no sibling 5DS R fixture to use as a same-body control (`test_0006`/0007 are the 5D Mark III). The profile-target resolution therefore leans on the ACR re-render rather than a tight/loose same-body pair; the 5D Mark III (which _does_ apply its 2D HSM) is available as a weaker cross-body signal for "does HSM close this kind of gap."

### Sequence

1. **Render** test_0003 baseline through `maple-cli batch … --profile neutral`, diff vs `test-fixtures/references/test_0003/down/baseline.png` (mean 6.26 today). **Confirm the resolved profile source first** — bundle hit for the 5DS R vs synthetic fallback, and whether the bundle entry carries a ForwardMatrix or only a ColorMatrix (Bradford path) — via a `maple-cli` inspect / stage-trace; the fix depends on which.
2. **Localize** with the standalone per-zone/per-hue report + heatmap.
3. **Read the signature:**
   - **Error concentrated in specific hue bins (e.g. Canon reds/oranges)** → the missing **per-camera 2D HueSatMap** the bundled matrix can't express (the RFC's named trouble spot). Candidate fix: source the 5DS R's Adobe HueSatMap from your local DCP, apply it (the apply path already exists — `hsm::apply`), and measure the per-hue improvement. If it's a clear win, ship it in the bundle **for the fixture body** (a scoped `convert_dcps.py --include-hsm` for that body). _Risk note:_ a **2D** HSM (expected for Canon Adobe Standard, like the 5D Mark III's `90×30×1`) has no value axis, so #825's valScale / tone-coupling regression does not apply — only the already-shipping dual-illuminant 2D lerp. **If the 5DS R's HSM turns out 3D**, the value-axis question from #825 — and the RFC's value-collapse — re-enter for that one table, surfaced with numbers and decided then.
   - **Broad, ~uniform `a*`/`b*` cast across all hues** → bundled-matrix vs ACR-profile mismatch. **Resolve by ACR re-render** (you confirmed available): render `test_0003` with the profile pinned to Adobe Standard and to Adobe Color; whichever matches the committed reference identifies ACR's target, and the fix is to align Maple's bundled matrices/target (or re-render the reference against a pinned, documented profile).
   - **Broad across hues, concentrated in highlights** → AgX highlight roll-off vs ACR, partly an irreducible view-transform delta. Document the floor, ratchet to it.
4. **Fix** per the evidence; **re-measure**; **ratchet** test_0003's global budget down to the achieved ceiling in the same commit.
5. **No-regression:** run the full `test_color_pipeline.sh` — the fix must not breach any other fixture's existing global budget.

### Honest scope note

This component commits firmly to the **instrument**, the **diagnosis**, and either a **fix** or a **documented irreducible floor with a ratcheted budget**. It does **not** pre-name the fix — naming it before measuring would repeat the RFC's HueSatMap mistake. If the fix is the missing HSM, Feature 1 ships it **for the fixture body only**; broad rollout (bundle size, lazy delivery) stays in #828/#829. The writing-plans step turns Component 1 into concrete tasks; Component 2's fix tasks are written _after_ steps 2–3 produce the signature.

---

## Relationship to Feature 2 (RFC §3.2, next cycle)

Feature 2 is the runtime chroma-match override: extract the embedded JPEG (`test_0003` carries a 3.3 MB preview), solve a scene-linear OKLAB a/b transform, inject before AgX while keeping the RAW's own L. It is genuinely new (the _tone_ half exists as Auto Profile #550; the _chroma_ half does not). It **reuses this harness unchanged** — per-hue ΔE is precisely how you validate an a/b match. Its open decisions (does chroma stack on / replace Auto Profile; does it own tone with AgX; are solved coefficients cached in the XMP sidecar vs the in-memory-only LRU #550 uses) are deferred to that spec. Working space note for Feature 2: it is **Rec.2020 D65**, not ProPhoto as the RFC text says — the common-space conversion before OKLAB is Rec.2020→linear-sRGB→OKLAB (code already provides `rec2020_to_oklab`).

---

## Open questions / risks

- **Profile-target resolution may need the ACR round-trip.** Until resolved, a broad-cast finding on test_0003 is ambiguous between "Maple's bundled matrices are off" and "the ACR reference is on a different default profile." Mitigated: you can run the pinned re-render.
- **The HSM fix-branch depends on sourcing the 5DS R's Adobe DCP** (your local Adobe install) to get the HueSatMap. The diagnosis (render + per-zone localize) does not; only that fix branch does. If the 5DS R's HSM is 3D rather than the expected 2D, the #825 value-axis question and the RFC's value-collapse re-enter for that table — decided with numbers.
- **Heatmap is a localization aid, not evidence.** All claims of improvement are stated as ΔE2000 / per-channel deltas, never visual judgments.
