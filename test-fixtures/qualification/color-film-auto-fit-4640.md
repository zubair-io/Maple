# Film input isolation for Auto fitting — #4640

## Defect

The shared display renderer applies an externally supplied film LUT before its
Auto tail. Its fast path previously reused that display buffer for fitting whenever
the adjustment model matched the pinned default model. A film LUT is a separate
argument and need not have a corresponding non-default field in that model. The
fast path could therefore train Auto on film-modified pixels and cache the result
under the same RAW, quality and render-size key as a no-film render.

Expanded native WASM binding tests exposed this as a parallel failure of the
empty-film identity test. The same test passed alone. A deterministic physical
regression then rendered the same RAW without a film on a cold cache, cleared the
cache, rendered with a supplied film, and rendered without it again. Before the
fix, the film-first order changed **1,319,446** no-film channel samples, with a
maximum difference of **47/255**.

## Correction

`run_auto_profile_stage` receives the existing external film-LUT argument. It only
reuses the current display buffer when no LUT was supplied and the model matches
the pinned fit model. Otherwise it uses the existing pinned-develop path, which
fits without film and reuses a complete cached fit when available. The film still
changes the actual render. Cache keys retain their intended RAW/model-independent
meaning; no film-specific cache or per-slider GPU work is added.

This fixes the shared core path used by native CPU, WASM fallback and FFI renders.
GPU hosts already obtain their fit through the pinned helper; there is no changed
per-pixel shader math to mirror. Pipeline output version **33** invalidates affected
derivatives, and Auto-fit model version **5** invalidates fitted artifacts.

## Regression evidence

The physical regression uses the real `test_0002.dng`, a 768-pixel AMaZE render,
and an ordinary 17³ film lattice. It asserts all of the following without relaxing
any tolerance:

- Auto fitting actually engages.
- Cold and warm film renders are byte-identical.
- Film-first and no-film-first orders produce byte-identical no-film renders.
- The film still visibly changes the output.
- The original RAW bytes are unchanged.

The test is explicitly fixture-gated and was invoked with the physical fixture;
a missing fixture fails that explicit invocation. This evidence is separate from
the full ACR color gate and does not waive its remaining failures.

## Qualification on the corrected source

| Check                                                   | Result                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Physical cold/warm and film/no-film ordering regression | Passed; zero changed channels                                                          |
| Full raw-core library                                   | 2,803 passed; 100 fixture-gated ignores (new physical regression run explicitly above) |
| Full raw-gpu library on Metal                           | 285 passed; four existing ignores                                                      |
| Full raw-wasm GPU-enabled native suite, parallel        | Three runs, each 72 passed and eight existing ignores                                  |
| Full raw-ffi library                                    | 258 passed; one existing ignore                                                        |
| Cross-language generation                               | Passed                                                                                 |
| Source identity before/after qualification              | All 21 changed source/generated files unchanged                                        |

The original red run, corrected run, repeated binding logs and source patch are
retained in the task's `film-auto-fit-cache` qualification archive. The complete
physical color corpus is still being repaired and qualified separately. No ACR
reference, RAW, authored XMP, numerical budget or required case was changed here.
