# Maple — Product Requirements Document

**Status:** Draft v1
**Owner:** Zubair (zubair@lawrence.io)
**Last updated:** 2026-04-27
**Audience:** Founding team, leadership, prospective hires, design partners, investors

---

## TL;DR

Maple is a professional, non-destructive RAW photo editor by Just Maple. It runs natively on macOS, iPadOS, and iOS through a Swift + SwiftUI shell, and in evergreen browsers through Angular — both backed by a single shared Rust image-processing core. Originals are never modified; every edit is persisted as an XMP sidecar.

The product bar — the thing we will be measured on, the thing that decides whether working photographers adopt us — is exactly two pillars:

1. **Professional color quality.** A scene-referred, linear-Rec.2020-D65 pipeline whose color a working photographer can trust on the first edit, gated by an objective ΔE₀₀ harness against ACR-rendered references on every change.
2. **Performance that disappears.** A slider tick must produce a new preview inside a single 60Hz frame (16ms) on a 100MP RAW. Nothing ships that breaks the budget.

This document is the source-of-truth product brief for Maple as a whole. Detailed feature and UI behavior lives in `docs/spec/12-maple-apps-spec.md` (which supersedes the earlier feature/UI spec drafts removed in #128). Architectural detail lives in `docs/architecture.md`. This PRD ties them together around what we are building, who it serves, and how we know it worked.

---

## 1. Problem statement

Working photographers — wedding, editorial, commercial, fine-art, sports — make their living inside RAW editors. They have two non-negotiables and a long list of frustrations.

The non-negotiables: the color has to be right (predictable, neutral by default, gracefully matching what they saw in-camera or remembered at the scene), and the editor has to feel like an extension of their hands. Sliders that lag, previews that re-render after they've already moved on, beachballs on 100MP files — these are not minor friction. They break flow on the work that pays the bill.

The frustrations: the dominant tools are now subscription-only with deteriorating performance on modern files, lock-in via proprietary catalog formats, opaque color science, and a long tail of "AI" features that distract from the core editing loop. Independent alternatives exist but have either weak color, weak performance, or no presence on iPad / web.

The cost of not solving this: a generation of photographers is captive to tools they actively dislike, and a growing one (mobile-native, hybrid web + desktop, multi-device) has no editor that respects their workflow. The market is large, the incumbents are coasting, and the underlying technology constraints (RAW decode + GPU pipelines + sidecar formats) are tractable for a small, focused team.

---

## 2. Vision

Maple is the editor a working photographer reaches for first because (a) it gets out of the way and (b) the color is right. It runs everywhere they shoot and edit — laptop, desktop, tablet, phone, browser — on the same files, with the same edits, identical to the pixel. Originals stay untouched. Edits live in plain-text XMP sidecars they can read, version, sync, and survive us.

If a photographer pulls a 100MP RAW open in Maple on their iPad on a train, makes a few exposure tweaks, lands at the studio, and opens the same folder on their Mac — the edits are there, the preview is identical, and the slider responds in one frame. That's the product.

---

## 3. Target users

**Primary persona — Working photographer.** Earns money with their camera. Shoots 200–5,000 RAWs in a session. Cares about: color accuracy, speed of culling and editing, lossless workflow, reliable export. Currently uses Lightroom Classic, Capture One, or a hybrid stack. Pain: subscription fatigue, performance regressions, lock-in.

**Secondary persona — Serious enthusiast / prosumer.** Shoots 50–500 RAWs a session, often on weekends. Cares about color, but also about a tool they understand and trust. Currently uses Lightroom CC or Darktable. Pain: complexity, color ambiguity, mobile/desktop fragmentation.

**Tertiary persona — Mobile-first photographer.** iPhone + occasional mirrorless. Wants iPad-first editing with desktop parity for the heavy lifts. Currently uses Lightroom Mobile or Halide + Lightroom. Pain: no editor that's truly first-class on both touch and pointer.

**Out of persona for v1:** retouchers (need pixel-level layers), studio post houses (need full DAM/asset management), social-content creators (need filters/presets-as-product, not RAW workflow).

---

## 4. Goals

### Product goals (user-facing outcomes)

1. **Color a pro will trust on first contact.** A new user opening their own RAWs in Maple, with no edits applied, sees a starting point indistinguishable from a careful neutral edit in Adobe Camera Raw — measured as mean ΔE₀₀ ≤ 5 against ACR-rendered references on the test fixture set, with per-channel bias ≤ 0.05.
2. **A slider that disappears.** Every adjustment slider produces a new on-screen preview in ≤ 16ms on the reference scene set (100MP RAW, supported hardware), with a 50ms hard ceiling no feature is allowed to break.
3. **Originals are sacred.** 100% of edits round-trip through XMP sidecars. The pixels of the original file are never modified by Maple, ever. Verified by hash on every export path.
4. **One file, every device.** A RAW + sidecar opened on macOS, iOS, iPadOS, and the web produces pixel-identical previews — gated by a cross-platform parity harness on every merge.
5. **Edit-to-export under one minute.** From "open RAW" to "export full-resolution JPEG" on a fresh image, p50 ≤ 60s on supported hardware.

### Business goals

6. **Reach paying users.** Convert at least 5% of a 90-day trial cohort to paid annual on Maple Hosted, with a target ARR per converted user benchmarked against Lightroom CC pricing.
7. **Plant the flag on iPad and web.** Be the first editor a "Lightroom on iPad is fine but I want something better" search converts on, and the only credible browser-native pro RAW editor.
8. **Self-hosted as a moat.** Ship Self Hosted (own-your-files, own-your-server) as a credible enterprise/studio offering — an explicit anti-Adobe positioning incumbents structurally cannot match.

### Non-goals (intentionally NOT in this product)

- **Pixel-level retouching with layers and masks.** Out of scope for v1. Local adjustments via parametric masks ship; full Photoshop-style layer compositing does not.
- **Asset management / DAM features beyond the source tree.** Maple is an editor, not a catalog. No proprietary catalog format, no metadata-database lock-in. Source tree + filesystem-native + XMP sidecars.
- **Generative / "AI" features (sky replacement, background removal, generative fill).** Distracting, brittle, and works against the trust pillar. Revisit only after the two core pillars are unambiguous strengths.
- **Video.** Hard no. RAW stills only.
- **Plugin ecosystem at launch.** Will revisit; building the host before defining the API gives us room to choose right.
- **Windows / Linux native at launch.** Web covers them adequately. Native Windows post-PMF if signal warrants.

---

## 5. The two pillars in detail

### 5.1 Pillar one — Professional color quality

**What "professional color quality" means here.**

It does not mean "looks pretty by default." It means: predictable, scene-referred, neutral, and grounded in measurable color science.

- The working color space is **linear Rec.2020 D65 at f32**. Exposure is a linear multiply, not a curve. A single view transform at the very end of the chain compresses scene range into display range. **Nothing before the view transform clips.** This is invariant.
- Calibration matrices, illuminant interpolation, demosaic, and tone mapping all live in the shared Rust core. A change anywhere in that chain regenerates coefficients for both Apple and Web through codegen — platforms cannot drift.
- Every color-pipeline change is gated by `src/scripts/test_color_pipeline.sh` — extracts the DNG embedded preview as ground truth, renders the candidate via `maple-cli`, computes per-fixture mean ΔE₀₀, P95 ΔE₀₀, max ΔE₀₀, and per-channel bias. A change fails CI if any of those exceeds budget.
- Budgets ratchet **down only**. CI rejects a PR that raises a budget. Today's defaults: mean ΔE ≤ 15, P95 ≤ 30, max ≤ 60, bias ≤ 0.05 — current target trajectory is mean ≤ 5 by GA.

**What this requires of the product.**

- Per-fixture ground truth committed to the repo, derived from ACR (`docs/tickets/09-color-harness-acr-ground-truth.md`).
- Independent shader paths for Apple Metal and Web WebGL2, both gated against the Rust reference for parity.
- A documented, photographer-comprehensible color appendix so we can explain (when asked, and we will be asked) exactly what our pipeline does, why neutral looks neutral, and where the AgX view transform sits in the chain.

**Acceptance for the pillar.**

- Mean ΔE₀₀ ≤ 5 on the public reference set at GA.
- Apple ↔ Web pixel parity within ΔE₀₀ ≤ 1 mean across the parity harness, on any merge to main.
- A canonical "neutral" rendering for the most common camera/sensor combinations (Sony, Canon, Fujifilm, Nikon, DJI Hasselblad, iPhone ProRAW) with documented ground truth.

### 5.2 Pillar two — Performance that disappears

**What "performance that disappears" means here.**

The user moves a slider. By the time their eye has finished saccading back to the preview, the new pixels are there. There is no spinner, no quality drop, no debounce wobble that erases their last input.

Specifically:

- **Slider tick budget — 16ms target, 50ms hard limit.** Measured on a reference scene (100MP Hasselblad L3D-100c) on supported hardware (M-series Apple Silicon for native; Apple Silicon Safari/Chrome and recent Intel/AMD discrete-GPU laptops for web).
- **Cold image open (cached) — one frame (~35ms).** Tap a thumb in the grid → pixels in the canvas inside one frame, when the rendered-preview cache hits.
- **Cold image open (uncached) — 250–1000ms.** Show progress. The first preview at viewport resolution arrives fast; the refine pass at full resolution lands within the budget.
- **Two-phase rendering.** Fast phase (viewport resolution, screen-res, cancellable, no allocations on the hot path) then a 150ms-debounced refine phase (full image, full resolution, cancellable on next tick). Implemented identically on Apple and Web.
- **Five caches.** Thumbnail memory, thumbnail disk, rendered-preview (keyed on `(primary_url, primary_mtime, sidecar_mtime, screen_size, adjustment_version, view_transform_version)`), decoded-image (session-scoped, in-memory), remote-source-bytes (network shares). On web, IndexedDB + in-memory equivalents. See `docs/caching.md`.
- **No allocations inside the render loop.** No round-trips across the WASM boundary per slider tick. If a feature regresses either, the feature does not ship.

**What this requires of the product.**

- A render scheduler that owns scene-graph diffing, partial invalidation, and cancellation. Single source of truth on both platforms.
- Profiled-and-defended budgets, not aspirational ones. Every shipped feature gets a perf budget cell in a tracking matrix.
- The `MapleUITests` slider-matrix harness (Ticket 10-C) running on every merge — wall-clock latency is a parity gate, not just a vibes check.

**Acceptance for the pillar.**

- Slider tick p50 ≤ 16ms, p95 ≤ 35ms, p99 ≤ 50ms on the reference scene set.
- Cold cached open p50 ≤ 35ms.
- A merge that pushes any of those above budget on the reference set is auto-blocked by CI.

---

## 6. User stories

### Working photographer (primary)

- As a wedding photographer, I want to cull 1,800 RAWs in a single afternoon so that I can deliver the same evening — meaning grid scroll is smooth, thumbnails render instantly from cache, and rating/picking is a single keystroke with zero perceived latency.
- As an editorial photographer, I want the default rendering of my Sony A7RV files to look correct — not "Adobe-warm," not "Capture-One-saturated," but neutral and trustworthy — so that I can land a finished edit in fewer clicks.
- As a commercial photographer delivering to a brand, I want my edits to round-trip losslessly and be reproducible across machines, so that color decisions on my studio Mac match what my retoucher's iPad shows.
- As a sports photographer culling tethered, I want to mark picks while the camera is still writing the next file, with zero stuttering on scroll or selection.
- As any working photographer, I want to know that the original RAW is never modified, ever — and verify that claim — so that I can trust Maple as my canonical workflow.

### Serious enthusiast (secondary)

- As an enthusiast, I want to open Maple in a browser without installing anything and edit a RAW from my Drive, so that I can try the product on a borrowed machine.
- As an enthusiast, I want the same edits I made on the web to appear on my desktop Mac when I sync the folder, so that I have one workflow across devices.

### Mobile-first (tertiary)

- As an iPad photographer, I want every adjustment to feel native to touch (gestures, hit targets, magic-loupe on long-press), so that the editor doesn't feel ported.
- As an iPhone photographer, I want to triage and lightly edit on phone, then continue on desktop with my edits intact.

### Edge / failure / negative cases

- As any user, when I open a RAW Maple cannot decode (proprietary, corrupt, exotic sensor), I want a clear, specific error and a way to file the file as a sample, not a silent failure or beachball.
- As any user, when my disk fills mid-export, I want a recoverable error, not a corrupted JPEG.
- As any user, when I open a RAW with an XMP sidecar from a different editor (Adobe, Capture One, Darktable), I want Maple to preserve unknown XMP fields byte-for-byte, even if it doesn't interpret them.

---

## 7. Requirements

### P0 — Must have for GA

- **Three-column shell** — sources tree, image grid, detail inspector — on desktop and tablet; single-column adaptive layout on phone. Two modes: Browse and Full image. Per `docs/spec/07-ui-architecture.md` and `docs/spec/12-maple-apps-spec.md` § 09.
- **Non-destructive editing via XMP sidecars.** Unknown XMP fields preserved byte-for-byte through round-trips. Schema versioned. Verified by round-trip tests against real `.xmp` files (no mocks).
- **Scene-referred pipeline.** Linear Rec.2020 D65 f32 working space, single view transform at the end, exposure as linear multiply.
- **Color parity harness** running on every merge. Mean ΔE₀₀ ≤ 5 on public reference fixtures at GA.
- **Cross-platform parity harness** running on every merge. Apple ↔ Web pixel parity within mean ΔE₀₀ ≤ 1 on the parity harness fixtures.
- **Slider tick ≤ 16ms / 50ms on 100MP reference RAW** on supported hardware. Two-phase rendering with cancellable refine pass.
- **Five caches** as specified in `docs/caching.md`.
- **Source tree** — local folders (read-write), browser-native folder picker on web, no proprietary catalog.
- **Adjustments at v1**: white balance (temp/tint), exposure, contrast, highlights/shadows/whites/blacks, presence (texture/clarity/dehaze), color (vibrance/saturation), HSL, curves, sharpening, noise reduction (luminance/color), lens corrections, geometry (crop/rotate/perspective). Each gated by the perf and color budgets.
- **Export** — JPEG, HEIC, TIFF, original-with-sidecar. Full resolution, ICC-tagged, with metadata preserved.
- **Originals untouched, verified.** Hash-on-export check that the source file's bytes are unchanged. CI-enforced.
- **A11y baseline** — every interactive element has an accessibility label; keyboard-navigable; honors macOS / iOS / browser high-contrast and reduce-motion.

### P1 — Nice to have, fast follow

- Tethered shooting (Sony, Canon, Fuji at minimum).
- Local adjustments via parametric masks (radial, linear, color-range, luminance-range, AI-subject as wrapper, not core).
- Histograms (RGB, luminance, waveform) with click-to-pick.
- Presets / develop snapshots.
- Maple Self Hosted (Bun + Elysia + MongoDB stack already scaffolded in `src/api/`) shipped behind an early-access flag.
- Folder watch / auto-import.

### P2 — Future considerations (design decisions today must keep these reachable)

- Brush-based local adjustments (the architecture must support spatially varying parameter maps).
- Multi-image edits / sync-settings (the adjustment-version key must support copy/paste of edit graphs).
- Print module.
- Plugin / extension API (don't block this with private types in the public surface).
- Stacking, panorama merge, HDR merge (panorama design in `docs/tickets/04-maple-panorama-spec.md`).
- Catalog/library mode for users who do want a catalog (opt-in, layered on top of the filesystem-native default).

---

## 8. Success metrics

### Leading indicators (days–weeks post-launch)

- **Color quality (the gate):** mean ΔE₀₀ on the public reference set, P95 ΔE₀₀, max ΔE₀₀, per-channel bias. Target at GA: mean ≤ 5, P95 ≤ 10, max ≤ 25, bias ≤ 0.05. Measured every merge by `test_color_pipeline.sh`.
- **Slider latency p50 / p95 / p99** on the reference scene set, both Apple and Web. Target at GA: p50 ≤ 16ms, p95 ≤ 35ms, p99 ≤ 50ms. Measured every merge by the `SliderMatrixUITests` harness.
- **Cold-cached open p50.** Target ≤ 35ms.
- **Activation rate** — % of trial users who edit and export at least one image within 7 days. Target ≥ 60%.
- **Time to first export** — median minutes from first launch to first JPEG out. Target ≤ 12 minutes.
- **Crash-free session rate** — target ≥ 99.5% on Apple, ≥ 99.0% on Web.

### Lagging indicators (months post-launch)

- **Trial → paid conversion at 90 days.** Target ≥ 5% on Maple Hosted.
- **30-day retention** of paid cohort. Target ≥ 75%.
- **NPS** of working-photographer cohort. Target ≥ 40.
- **Support ticket volume per active user.** Should trend down quarter-over-quarter; specifically zero "color is wrong" tickets that don't reduce to a documented sensor profile gap.
- **Weekly active import volume** (images opened per WAU). Proxy for whether Maple becomes the primary tool, not the curiosity. Target trending up.

### Measurement method

CI-emitted metrics for color and perf land in a metrics store keyed by commit; dashboard surfaces trend and budget headroom. Product metrics (activation, retention, NPS) flow through Amplitude EU. Support volume from the support tool of record. Weekly review against scorecard; budgets ratchet only downward.

---

## 9. Architecture summary

This is a PRD, not an architecture doc — that lives in `docs/architecture.md` — but the decisions below are product-shaping and belong here.

- **One Rust core, three native pipelines.** Color math (decode, demosaic, calibration, LUT generation, dehaze, deconvolution) in `src/raw-pipeline/crates/raw-core`. Compiled once as a static lib for Apple via C-FFI, once as WebAssembly for browsers. Platform GPU paths (Metal, WebGL2) are idiomatic on each platform but gated against the Rust reference. Avoids platform color drift; lets us ship anywhere we have a GPU.
- **Apple shell** — SwiftUI + `@Observable`, SPM-modular (`MapleCore`, `MapleApp`).
- **Web shell** — Angular 21 standalone components, signals + RxJS, separate `.ts`/`.html`/`.scss`.
- **Self Hosted backend** — Bun + Elysia + MongoDB, native dylib via `bun:ffi`. Ships the same Angular bundle.
- **Codegen** — every constant that appears in Rust + Swift + TypeScript is generated by a single Python script in `src/scripts/codegen/`. Golden-file CI test confirms agreement.
- **Sidecars** — XMP, plain text, schema-versioned, unknown fields preserved byte-for-byte. The sidecar is the contract; the pixels are derived.

The architecture is the product. Cross-platform parity, color trust, and perf headroom are all consequences of the shared-core decision. We will not ship features that compromise it.

---

## 10. Open questions

| # | Question | Owner | Blocking? |
|---|----------|-------|-----------|
| Q1 | What is the v1 pricing on Maple Hosted? Single tier? Annual-only? Free read-only viewer? | Founders / GTM | Blocks launch |
| Q2 | Which sensor / camera combinations are the GA reference set, and which is "supported but unverified"? | Color lead | Blocks color GA |
| Q3 | Does Self Hosted ship at GA or post-GA? | Founders / GTM | Affects scope |
| Q4 | How do we handle iPad-only camera connection kit imports vs. desktop import flow — same code path or platform-specific? | Engineering | Non-blocking, can resolve in iPad slice |
| Q5 | What is the minimum supported macOS / iOS / browser version at GA? Driven by Metal feature levels and WebGL2 / WebGPU availability. | Engineering | Blocks marketing copy |
| Q6 | Sidecar schema — do we add a `maple:` namespace at GA or stay strictly within the Adobe-compatible namespace? | Engineering / standards | Blocks v1 schema freeze |
| Q7 | Telemetry policy — what do we collect on the desktop / iOS apps by default, what's opt-in, and what does Self Hosted do? Especially given the "Anti-Adobe" positioning. | Founders / legal | Blocks privacy policy |
| Q8 | At what point do we publish our color science as a paper? `docs/maple-paper.md` is in flight — what's the GA-day disclosure posture? | Founders | Non-blocking, marketing decision |

---

## 11. Timeline considerations

This is not a committed schedule; it's a phasing the spec is consistent with.

- **Now (Q2 2026):** Closing perf headroom (Tickets 10–12, the post-Phase-1 roadmap), tightening the color harness against ACR ground truth (Ticket 09), shipping the iPad slice. Web Milestone 3 in flight. Color budget trajectory: mean ΔE₀₀ from current ~15 toward target 5.
- **Next (Q3 2026):** Public beta of Maple Hosted on web + macOS. iPad in TestFlight. Self Hosted internal dogfooding only.
- **Later (Q4 2026 / Q1 2027):** GA. Maple Hosted paid; Self Hosted in early access; iOS phone alongside iPad. P1 features rolling out behind flags as they clear the budget gates.

Hard dependencies:

- **Color harness ACR ground truth** (Ticket 09) is on the critical path for the color pillar. Until that lands with public reference fixtures, "mean ΔE₀₀ ≤ 5" is an aspiration, not a gate.
- **Web FFI split + Milestone 3 wiring** (the Plan-3 sequence) is on the critical path for Web parity.
- **`build-xcframework.sh` automated in CI** is on the critical path for any Apple release that includes a `raw-core` change.

Phasing rule for any feature: cannot ship behind a flag if it regresses either pillar. If a P0 candidate cannot clear the budgets, it gets cut, not gated.

---

## 12. Risks

- **Color is hard, and "neutral" is a moving target across cameras.** Mitigation: lock ground truth to ACR for v1, document the choice, give power users a calibration knob in v1.1.
- **Perf budgets are easy to set and hard to defend over a 12-month feature roadmap.** Mitigation: budgets are CI-enforced and ratchet down; every feature gets a budget cell; profiling, not vibes.
- **Two-platform UI (SwiftUI + Angular) doubles surface area.** Mitigation: shared Rust core absorbs the hard-to-port logic; everything platform-specific is genuinely platform-idiomatic and small.
- **Web RAW decode is ambitious.** Mitigation: the Rust → WASM path is already shipping; the FFI split (`.archived-plans/specs/2026-04-25-plan-3-web-ffi-split-brief.md`) is the active work.
- **iPad and phone editing has historically been a graveyard.** Mitigation: ship browse + light edit on iPad first, validate the touch model, then layer the heavy edits with the same core.
- **"Pro photographers don't change tools" is partly true.** Mitigation: target the actively-frustrated cohort, not the satisfied one. The pitch is "your edits are yours, the color is right, the slider doesn't lag" — concrete, not aspirational.
- **Anti-Adobe positioning could become anti-Adobe-only positioning.** Mitigation: keep the marketing about photographers, not about competitors. The product wins on its own terms or it doesn't win.

---

## 13. Out of scope (reiterated)

For sharpness, the following are explicitly NOT in this PRD and not in v1:

- Layers, blend modes, pixel-level retouching.
- Catalog / DAM beyond the source tree.
- Generative AI features.
- Video.
- Plugin ecosystem.
- Native Windows / Linux.
- Server-side rendering for large-scale batch (Self Hosted does this in a limited way; commercial-batch render farm is post-GA).

When a feature request lands that fits one of these buckets, the answer is "noted, not v1," and it gets routed to the parking lot, not the backlog.

---

## 14. Appendix

### A. Glossary

- **Scene-referred** — a working color space whose values represent the physical light captured by the sensor, not values prepared for a display. Allows the same edit graph to render correctly to SDR, HDR, or print without redoing the work.
- **View transform** — the single, terminal stage that compresses scene-referred values into display-referred values. Maple uses an AgX-derived transform.
- **Sidecar (XMP)** — a small text file alongside the RAW that holds Maple's edit graph plus standard XMP metadata.
- **Demosaic** — the stage that interpolates a full RGB pixel from the sensor's Bayer / X-Trans mosaic.
- **ΔE₀₀** — CIEDE2000, the perceptual color-difference metric the harness uses. Roughly: 1.0 is a just-noticeable difference; 5.0 is a clearly visible difference.
- **Refine pass** — the second, full-resolution render that lands ~150ms after the user releases a slider.

### B. References

- `docs/spec/12-maple-apps-spec.md` — Maple apps architecture, source of truth for what each surface (Hosted / Self Hosted / Native) does. Supersedes the earlier feature/UI spec drafts removed in #128.
- `docs/spec/07-ui-architecture.md` — UI state model, interaction loops.
- `src/web/projects/maple-common/src/lib/tokens.scss` (+ `tokens.ts`) — canonical visual design tokens (`--mpl-*` CSS custom properties).
- `docs/architecture.md` — system design, scene-linear chain, parity gates.
- `docs/caching.md` — five-cache design.
- `docs/best-practices.md` — Angular and Swift coding standards.
- `docs/sidecar-schema.md` — XMP schema versioning.
- `docs/spec/05-performance.md` — performance invariants.
- `.archived-plans/plans/2026-04-24-post-phase1-roadmap.md` — current execution roadmap.
- `docs/maple-paper.md` — color-science writeup in flight.

---

*End of PRD.*
