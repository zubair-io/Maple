# Canonical 100 MP browser intake — #3669

## What was executed

Production `maple-syrup` built from `9169b88bd73ff14324a9a7712c98992db7275864`, with this PR's test-only bounded folder-picker bridge and `raw-100mp.spec.ts`. The Rust/WASM was built with the repository wrapper (`gpu,parallel`, pinned nightly, `-Z build-std`) and synced before the Angular production build. No production image-processing code, reference image or budget was changed.

The fixture was the repository's canonical `dji-mavic3pro-100mp.dng` alias of `test_0000.DNG`: **12288 × 8192**, **129,467,390 bytes**, SHA-256 `f4b60b3672bdf7ff7f4376fba9da1b1d22c925ebc3e16baa5fd4a64fa1045aa5`. It was copied to a disposable directory. The browser assembled the entire file through messages capped at **4 MiB of binary data each**, then independently matched its size and SHA-256 before the real folder → preview → editor flow. File metadata remains lazy; warm-cache identity checks do not transfer RAW bytes.

[Machine-readable evidence](browser-100mp-3669.json) records the final local run on 2026-09-16. Apple M5 Max, 128 GiB RAM, Darwin 25.6.0; installed Chrome 152.0.7977.84; WebGPU vendor `apple`, architecture `metal-3`, non-fallback adapter. Chrome did not expose a device name. Eight Rayon workers were active.

| Measurement | Observed |
| --- | ---: |
| Full-file bridge transfer plus SHA-256 verification | 1,947.01 ms |
| Folder click through completed editor session lookup | 13,712 ms |
| Worker `maple:session-open` interval | 1,604.00 ms |
| Viewport worker-render mean, 16 samples after 4 warm-ups | 0.615 ms |
| Viewport worker-render p95 / max | 0.770 / 0.770 ms |
| Presented canvas screenshot | 1080 × 720; non-dark fraction 0.9997 |

The test passed the existing worker-render ceilings (mean 16 ms, p95 35 ms, max 50 ms) and nonblank-pixel checks. These are **viewport worker intervals**, not input-to-display measurements or a full-resolution 100 MP render. The folder-to-editor interval includes browser fixture I/O, discovery and processing, so it is not the cached-open metric. Background Resilio Sync consumed roughly one CPU core during the initial recording; no sibling agent compilation was active. This is functional qualification and descriptive timing, **not a quiet-machine performance ratchet**.

An initial run also passed (bridge 2,011.76 ms, editor 14,020 ms, worker open 1,706.23 ms, render mean 0.629 ms / p95 0.720 ms); the final run added stricter nonblank-pixel assertions, exact one-render-per-tick checks and explicit source provenance. It was not selected by performance.

## Regression checks and limits

- Existing smaller `test_0006.DNG` threaded-Chromium/WebGPU test: **passed**. Eight threads, worker open 1,464.13 ms; viewport render mean 0.794 ms, p95/max 1.060 ms.
- Existing cold/warm preview test: **failed** before measuring its budgets because `.preview-img` and `.preview-img--full` no longer exist in the production shell. The same selectors affect several existing suites. This pre-existing observation defect is tracked as high-priority [#3709](https://github.com/zubair-io/Maple/issues/3709), not waived or called a pass.
- The Canon 52.7 MP CPU-fallback regression remains unchanged apart from its stale explanatory comment; it was not rerun for this WebGPU intake qualification. The new canonical test does not establish 100 MP CPU-fallback or native-resolution refine qualification.
- The canonical test explicitly skips when its named gitignored fixture is absent. It never substitutes a smaller file. Failure attachments identify the last stage (`intake`, `editor-open`, `slider-ticks`, or completed measurements) and preserve the error.
- Focused TypeScript checking of the new spec and support imports passed. Source RAW hashes are checked separately from derived artifacts; originals are not modified.

## Reproduction

With RAW/reference fixtures installed, build WASM via `src/raw-pipeline/raw-wasm/build.sh`, sync it with `src/web/scripts/sync-raw-wasm.sh`, and run from `src/web`:

```sh
bun run e2e:production -- raw-100mp.spec.ts --project=chrome-hosted
```

The local qualification used an already-built production artifact, the existing `serve-dist-coep.mjs` static server on port 4769, and the existing config/artifact-only test options to avoid starting an unrelated API/Mongo stack:

```sh
DIST=dist/maple-syrup/browser PORT=4769 bun scripts/serve-dist-coep.mjs
MAPLE_E2E_CONFIG_ONLY=1 MAPLE_E2E_ARTIFACT_ONLY=1 MAPLE_E2E_HOSTED_PORT=4769 \
  ./node_modules/.bin/playwright test raw-100mp.spec.ts \
  --config playwright.production.config.ts --project=chrome-hosted
```
