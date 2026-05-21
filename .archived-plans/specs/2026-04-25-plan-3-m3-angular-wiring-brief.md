# Plan 3 M3 — Angular Wiring of the WebGL2 Dev-Chain Brief

> Brainstorm output, 2026-04-25. Becomes input to a future writing-plans session for Plan 3 M3.
> Cross-links: [Plan 3 brief (umbrella)](./2026-04-25-plan-3-web-ffi-split-brief.md), [Plan 3 M2 brief](./2026-04-25-plan-3-m2-webgl-shaders-brief.md), [Plan 3 M2 plan](../plans/2026-04-25-plan-3-m2-webgl-shaders.md).

Plan 3 M1 shipped `RawPipelineService.decodeSceneLinear` returning Rec.2020 fp16 RGBA (`raw-pipeline.service.ts:188-242`, `raw-pipeline.types.ts:103-109`). Plan 3 M2.1 (planned) ships a hand-rolled `Pipeline` class at `src/web/projects/maple-common/src/lib/webgl/pipeline.ts` plus five GLSL frags and a dev-only test page (M2 plan lines 60-85). M3 replaces the production paint path in `image-canvas.component.ts` (today: `decode → imageDataToBitmap → drawImage`, `image-canvas.component.ts:140-157`) with `decodeSceneLinear → Pipeline.render(...) → canvas`.

## 1. Component surgery scope

`image-canvas.component.ts:73-124` already separates "decode on focused-asset change" (`decodeEff`) from "redraw on view-state change" (`drawEff`). M3 rewires both:

- **decodeEff** (`:85-106`): `pipeline.decode → imageDataToBitmap` becomes `pipeline.decodeSceneLinear`. Result (`fp16Rgba`, `w`, `h`) held in a new field `cachedSceneLinear`. Bitmap signal stays for the legacy fallback (§ 4).
- **drawEff** (`:110-123`): becomes the per-tick render. Reads the focused asset's `AdjustmentModel` via `state.adjustmentFor(id)()` (`library-state.service.ts:660-662`) and calls `pipeline.render(cachedSceneLinear, model)`. The existing `effect()` retracks every signal accessed in its body, so adding `adjustmentFor` to the body re-fires on every slider tick — no new observable plumbing.
- **New component state:** a `Pipeline | null` (lazy on first decode), the `cachedSceneLinear` field, a `legacyFallback: boolean` flag. Pipeline owns the `WebGL2RenderingContext` and all GL objects.
- **Lifecycle:** `ngAfterViewInit` calls `Pipeline.create(canvasRef.nativeElement)`; `ngOnDestroy` (`:126-131`) calls `pipeline.dispose()`.

## 2. AdjustmentModel propagation

The Web architecture diverges from Apple's `EditSession`: there is no per-edit-session object. The full `AdjustmentModel` (`models/adjustment-model.ts:15-41`) is stored per-asset in `LibraryStateService.adjustmentModels: Signal<Map<AssetId, AdjustmentModel>>` (`library-state.service.ts:204-205`). Sliders patch via `state.updateAdjustment(id, patch)` (`:664-674`). The chain slider `valueChange` (`slider.component.ts:97`) → section `patch()` (`tone-section.component.ts:71-74`) → `updateAdjustment` → signal → `drawEff` is fully Signal-driven; no RxJS in the slider→canvas hot path.

Apple's `EditSession` caches the decoded `CIImage` alongside the model. On Web, the decoded fp16 buffer lives in the component as `cachedSceneLinear` (transient, lost on navigation) — the model itself persists in `LibraryStateService`. Promote to a service later if the editor begins prefetching.

## 3. Decode/render decoupling

Mirror Apple's split: decode once per asset open, render every slider tick.

- **Decode once** — guarded by `currentAssetId` (`image-canvas.component.ts:51, :94`). `decodeSceneLinear(bytes, ext)` runs in the worker; cache the result on the component, then `pipeline.uploadInput(fp16Rgba, w, h)` once. Ping-pong `RGBA16F` FBOs and the AgX LUT texture are owned by the Pipeline and persist across ticks.
- **Render per tick** — `pipeline.render(model)` reads the uploaded input texture, runs five passes, blits. **No texture re-upload per tick.** Each tick = N uniform writes + 5 fullscreen draws + 1 blit, all GPU-resident.

## 4. Capability fallback

Probe at Pipeline init: `Pipeline.create(canvas)` returns `null` when `EXT_color_buffer_half_float` or `OES_texture_float_linear` is absent (M2 plan line 20 throws; M3 swaps throw for `null`-return per brief § 7). On `null`: set `legacyFallback = true`, `console.warn` once, decode via existing `pipeline.decode(...)`, paint with the existing `imageBitmap`-driven `draw()` (`image-canvas.component.ts:172-231`).

The fallback is **not** a feature flag — it's the negative branch of a feature detect. Both paths coexist permanently. Both `decodeSceneLinear` and `decode` already share the worker's serialization gate (`raw-pipeline.service.ts:128-137`).

## 5. Two-way slider binding

Slider → `valueChange.emit(Number(v))` (`slider.component.ts:97-101`) → `patch()` → `updateAdjustment` → signal mutation re-fires `drawEff` synchronously in the same microtask cluster.

Debounce decision: **don't add one for M3.** A 5-pass fp16 GPU chain on a viewport-sized texture is well under 16ms (CLAUDE.md § "Performance invariants"). Effect-driven render is already animation-frame-aligned via Angular's rendering microtask queue. Apple's 250ms refine exists because Apple's Full pipeline is heavy; the Web Pipeline has no Full/Preview split today (M4 territory). Revisit after first profile.

## 6. Performance budget

CLAUDE.md target: 16ms slider tick, 50ms hard limit.

- **decodeSceneLinear** (one-shot, worker): 250–1000ms uncached, never blocks the slider.
- **Pipeline.render(model)** (per tick): expected ~3–6ms for a 4K-edge fp16 input on M-series Macs; budget **8ms**. Where it can break:
  - Full-res 100MP RAW input (M2.4 fixture). M1's `qualityPreview: true` ships half-res; full-res stays export-only.
  - FBO realloc on `canvas` resize (`image-canvas.component.ts:175-177`); the Pipeline must guard with a "size unchanged → reuse" check.
  - Re-uploading the input texture on slider tick (bug; design must keep it sticky per asset).

## 7. Sequencing

Smallest viable first commit: see § 9. **No URL feature flag.** The capability probe (§ 4) is the natural off-switch — browsers without fp16 silently keep the legacy path. A `?webgl=1` flag would create a third state (gate-off but capable) nobody validates, and M2.1's dev page already proves the chain on supported hardware.

## 8. Open questions

Pin these before locking M3 tasks:

1. **Zoom/viewport — Pipeline parameter or canvas-size encapsulation?** `effectivePx()` (`image-canvas.component.ts:58-71`) writes `canvasW/canvasH` to `canvas.width/height` (`:175-177`). Pipeline treats input fp16 as source and canvas size as output viewport. M1's preview-sized fp16 means zoom past 1.0× relies on `OES_texture_float_linear` upscaling — verify cleanliness; Lanczos lands in M4 if not.
2. **CSS scaling vs pixel scaling.** No CSS `width/height` scaling today (`transform: translate(...)` only, `:179-180`). Confirm no `devicePixelRatio` multiplier hides in `wrap` styles before M3 locks viewport math.
3. **Cache lifecycle across navigation.** `currentAssetId` (`:51`) gates re-decode within one component instance; nav away-and-back triggers a fresh decode. M3 keeps that; service-level LRU is M-future.

## 9. Recommended cut

**One commit, ~two files touched.** In `image-canvas.component.ts`:

1. `decodeEff` calls `pipeline.decodeSceneLinear` (legacy `pipeline.decode` only when `legacyFallback === true`).
2. `drawEff` reads `state.adjustmentFor(id)()` and calls `pipeline.render(model)`.
3. Pipeline created lazily in `ngAfterViewInit`, disposed in `ngOnDestroy`.
4. Capability probe is the only fallback gate. No URL flag, no service-injected boolean.
5. Public re-export of `Pipeline` is added to `maple-common/src/public-api.ts` (already on M2.1's "Public API" modify list, M2 plan line 90).

Defer to follow-on M3.x: prefetch on filmstrip hover, service-level decoded-fp16 cache, full-resolution Full pipeline, viewport-window rendering. Each is its own writing-plans run after the basic chain ships.
