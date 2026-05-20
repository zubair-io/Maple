# Clipping & artifacting remediation plan

**Status:** Draft
**Owner:** Zubair
**Last updated:** 2026-04-27
**Related:** [user-story-edit-flow.md](../../user-story-edit-flow.md), [edit-flow-remediation.md](2026-04-27-edit-flow-remediation.md)

## TL;DR

Three independent bugs in the develop pipeline produce the visible "color is off" / "artifacts on highlights" problems. Fix in this order:

1. **AgX per-channel clipping** — the largest user-visible win. Saturated highlights hue-rotate (red→pink, blue→magenta, green→yellow-lime) because the per-channel sigmoid clamps each channel independently. Add scene-linear pre-formation rolloff before the sigmoid.
2. **Sensor-clip on highlights** — `highlight_recovery` exists but defaults to `Off`. Default it to `Blend` for RAW. Recovers ~1–1.5 EV of clipped highlight detail.
3. **Negative-channel handling after DCP** — out-of-gamut camera colors produce negative scene-linear values that flow through the chain unguarded. Add a soft floor at the DCP exit.

WB cool-cast fix already shipped in this branch (`parseSidecarModel` now seeds `decodedAtModel` from as-shot CCT/tint). This plan sits on top of that.

## Context

`dump_pixel` against test_0002 confirms the post-DCP scene-linear output is faithful (neutrals round-trip neutrally, modulo the actual scene). The artifacts the user sees are introduced **downstream** of DCP, primarily by AgX's naive per-channel implementation:

```
camera-native RGB                (0.2853, 0.6582, 0.5340)
post-DCP scene-linear Rec.2020   (0.6349, 0.6683, 0.6692)   ← within reasonable bounds
post-AgX per-channel             ???                         ← clamps + hue shifts here
```

The single biggest contributor to user-perceived "wrong color" is per-channel AgX. Every saturated highlight in every fixture is affected. Pre-formation rolloff is the canonical Sobotka/Blender-AgX way to handle this.

## Bug map (as currently shipped)

| Stage | Code | Symptom |
|---|---|---|
| `linearize.rs:134-136` | `clamp(0.0, 1.0)` per channel before demosaic | Hard sensor highlight clip — sun/specular reflections lose all detail. `highlight_recovery::apply` exists but `model.highlight_recovery = Off` by default. |
| `dcp.rs` (camera→XYZ) | No clip on output | Saturated camera colors → negative scene-linear values that flow unguarded into AgX. |
| `agx.rs:67-77` | Per-channel sigmoid + 5 clamp ops per pixel | Per-channel hue shift on saturated highlights. The big one. |
| Apple side: Rec.2020 → P3 | Implicit by CoreImage | Wide-gamut colors outside P3 lose differentiation. |

## Phase 1 — AgX pre-formation rolloff (3–4 days)

**Goal:** every saturated highlight preserves hue through the view transform. No per-channel hue rotation.

### What to implement

The canonical AgX Open Domain rolloff: before per-channel sigmoid, compute a saturation desaturation map that pulls high-luminance pixels (where any channel is far above mid-gray) toward neutral by an amount proportional to how far out-of-gamut they are. This makes the per-channel sigmoid input live in a "renderable subset" so all three channels reach the shoulder together → no hue shift.

Reference implementations:
- Troy Sobotka's AgX (Blender 4.0+): `node_shader_agx` source. Pre-formation in scene-linear before LUT.
- `colour-science` Python reference, `colour.colorimetry.AGX_FILMIC` family.

### Files to touch

- `src/raw-pipeline/raw-core/src/view/agx.rs` — add `preform_rolloff(scene: [f32; 3]) -> [f32; 3]` that desaturates high-luminance out-of-gamut input. Insert call before per-channel sigmoid in `apply()`.
- `src/raw-pipeline/raw-core/src/view/agx.rs` — replace per-channel `agx_per_channel` with a vector form that takes the rolloff result.
- `src/scripts/derive_agx_lut.py` — verify the LUT is still parametrically right (it should be — the LUT is post-rolloff sigmoid).
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/AgX.metal` (or wherever the Metal AgX kernel lives) — the canonical Rust math is the source of truth; Metal mirrors it. Codegen-from-Rust constants if any new ones.
- `src/web/projects/maple-common/src/lib/webgl/shaders/agx.frag` (or equivalent) — same mirror update.

### Tests

- New unit test in `agx.rs`: `pre_formation_preserves_hue_on_saturated_highlight`. Input pixel `[20.0 * AGX_MID_GRAY, 0.5 * AGX_MID_GRAY, 0.5 * AGX_MID_GRAY]` (saturated red), output should have R/G ratio ≈ R/B ratio ≈ same as input (within 5%). Currently that ratio shifts by 30%+.
- Update `per_channel_gamut_compression_reduces_saturation_on_blown_channels` to assert hue preservation, not just bounded spread.
- Cross-platform parity gate: Rust output, Metal output, WebGL output identical to ≤ 1e-4 ΔE on a 16-color saturated test set.

### Exit criteria

- `BaselineMatrixUITests` mean ΔE drops on every fixture (every fixture has saturated highlights → every fixture benefits).
- Visual: pure-red specular highlights stay red instead of shifting orange-pink.
- Slider-matrix harness saturation-min/max cases preserve hue.

## Phase 2 — Highlight recovery on by default for RAW (1 day)

**Goal:** sensor-clipped highlights get reconstructed from neighboring channels by default. Currently the user has to dig into the sidecar to enable this.

### What to implement

Change `AdjustmentModel::default()` to set `highlight_recovery: HighlightRecoveryMode::Blend`. The `Blend` mode recovers detail in pixels where one or two channels clipped but at least one didn't. Already implemented in `stages/highlight_recovery.rs` — just needs to be the default.

Caveat: enabling by default for non-RAW (HEIF/JPEG) is wasted work and may introduce subtle changes. Gate the default to RAW path:
- `pipeline.rs:render_from_raw_with_quality` already runs highlight_recovery; just bump the default model.
- For non-RAW (`processSceneLinearNonRaw` on the Apple side), continue to skip — non-RAW is already display-encoded.

### Files to touch

- `src/raw-pipeline/raw-core/src/xmp.rs` — change `AdjustmentModel::default()` to `highlight_recovery: HighlightRecoveryMode::Blend`.
- `src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift` — mirror the Swift default.
- `src/web/projects/maple-common/src/lib/models/adjustment-model.ts` — mirror the TS default.

### Tests

- Update `defaults_highlight_recovery_is_off` → `defaults_highlight_recovery_is_blend`.
- Re-run color parity harness — most fixtures should improve on `max ΔE` because clipped specular regions now have data instead of flat 1.0.

### Exit criteria

- Sensor highlight clip no longer flat-blocks at 1.0 by default. Test_0002 sequins and white-background-with-window-light should show texture instead of flat white.

## Phase 3 — Scene-linear extension above 1.0 (2 days)

**Goal:** sensor data above white_level is preserved through the linearize stage and shaped by AgX's pre-formation rolloff (Phase 1). Right now `linearize.rs:134-136` hard-clamps at `1.0`, so highlight_recovery only has the clipped-then-blended data to work with — it can't recover values that genuinely exceeded white_level.

### What to implement

Remove the `clamp(0.0, 1.0)` in `linearize.rs` for highlight_recovery-enabled paths. Let `(raw - black) / (white - black)` produce values > 1.0 when the raw count exceeds white_level (which can happen due to A/D headroom on some sensors). Keep the lower clamp at 0.0 to avoid negative noise.

`highlight_recovery::apply` already handles values > 1.0 (per the inline comment at line 129). The pipeline is ready; just stop pre-clamping.

### Files to touch

- `src/raw-pipeline/raw-core/src/linearize.rs:134-136` — change `.clamp(0.0, 1.0)` → `.max(0.0)`. Same change at `linearize.rs:58` for the LinearRaw path.
- Add a new test that decodes a synthesized RAW with raw counts above white_level and verifies the post-linearize value exceeds 1.0.

### Exit criteria

- Specular highlights on chrome/sun/sequins reach scene-linear values like 1.5–2.0× mid-gray instead of being clipped to 1.0.
- Combined with Phase 1's pre-formation rolloff, those highlights desaturate gracefully into the display gamut instead of clipping to white.

## Phase 4 — Negative-channel handling after DCP (1 day)

**Goal:** out-of-gamut camera colors produce well-defined output, not negative scene-linear values flowing into AgX (which doesn't handle negatives — `scene.max(floor)` at agx.rs:70 is the only protection).

### What to implement

After `dcp::apply` outputs scene-linear Rec.2020, soft-clip negative channels:

```rust
// Soft floor — preserve hue when one channel goes slightly negative
// (out-of-gamut color from camera CM). Replaces `(0.0, 1.0)` hard clamp
// at agx::apply with a hue-preserving floor that pulls all channels up
// proportionally when any one goes below 0.
fn soft_floor(p: [f32; 3]) -> [f32; 3] {
    let min = p[0].min(p[1]).min(p[2]);
    if min >= 0.0 { return p; }
    let lift = -min;
    [p[0] + lift, p[1] + lift, p[2] + lift]
}
```

This is a cheap per-pixel pass that runs in DCP's exit before scene-linear is published. Cleaner than clipping at AgX entry.

### Files to touch

- `src/raw-pipeline/raw-core/src/color/dcp.rs` — call `soft_floor` in `apply_with_post_pro`'s exit path.
- Tests in `dcp.rs` — verify a synthetic out-of-gamut camera input produces non-negative output without hue change.

### Exit criteria

- No negative scene-linear values reach AgX.
- Saturated colors at gamut boundaries don't lose hue.

## Phase 5 — Apple-side gamut handling (Rec.2020 → Display P3) (1 day)

**Goal:** wide-gamut Rec.2020 colors that exceed Display P3 gamut are gracefully gamut-mapped, not implicit-clipped by CoreImage.

### What to implement

`CIImageView.body` currently does `Self.context.createCGImage(image, from: ..., format: .RGBA16, colorSpace: outputColorSpace)` where `outputColorSpace = displayP3`. CoreImage will hard-clip Rec.2020-out-of-P3 values during this conversion.

Options:
- Implement gamut-mapped Rec.2020→P3 in a dedicated MTL kernel (preserve hue, compress saturation). This is what Apple's own raw-development pipeline does.
- Or: render to an extended-range P3 colorspace and let the display map.

Lower priority than Phases 1–4 because the gamut clip primarily affects extreme primaries (saturated test charts, neon signs) — not common photographic content.

### Files to touch

- `src/apple/Maple/Views/FullImageView.swift:CIImageView.body` — swap `outputColorSpace` to extendedLinear P3, OR add a gamut-map kernel before the createCGImage.
- Mirror in `MapleExporter.swift` for export paths.

## Phase 6 — Validation & tracking

After each phase, re-run:

```bash
# Rust-side numerical gate
src/scripts/test_color_pipeline.sh

# Apple-side visual gate (the matrix we built today)
xcodebuild test -only-testing:MapleUITests/BaselineMatrixUITests/testBaselineMatrixVsReferences \
    -project src/apple/Maple.xcodeproj -scheme Maple -destination 'platform=macOS'

# Per-pixel heatmap on a flagship fixture
python3 src/scripts/diff_heatmap.py /tmp/maple-baselines/test_0002.png \
    test-fixtures/references/test_0002/down/baseline.png /tmp/diff-test_0002
```

Track per-fixture mean ΔE in a CSV: today's baseline / after Phase 1 / after Phase 2 / etc. The matrix has 17 fixtures; we'll know which fixtures benefit most from each phase.

## Out of scope

- AgX bias (the post-unwind 1.5 EV difference vs ACR). Architectural decision; not part of clipping.
- Per-camera DCP profile loading. Today Maple uses embedded camera matrices; richer profiles (Adobe DCPs) would help test_0001 and other format-specific outliers but isn't a clipping fix.
- Slider performance work from the [edit-flow-remediation plan](2026-04-27-edit-flow-remediation.md). Color/clipping fixes are independent of the slider hot-path work; both can ship in parallel.

## Open questions

1. **Pre-formation rolloff: Sobotka 1.x or 2.x?** Sobotka shipped Open Domain rolloff in AgX 1.x and ImageFormation in AgX 2.x. They differ in the exact desaturation curve. Pick one and document the choice.
2. **Highlight recovery default for RAW: `Blend` or `Luminance`?** `Blend` recovers via neighboring channels (faithful color), `Luminance` smooths magnitude only. ACR's default is closer to Luminance. Need a decision.
3. **Default contrast slider value?** Currently 0 (neutral sigmoid). If we add pre-formation rolloff, the perceived contrast at 0 may drop because saturated highlights no longer hue-shift to "punchier" colors. May want to nudge default contrast.
