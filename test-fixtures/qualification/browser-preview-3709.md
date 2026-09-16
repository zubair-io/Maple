# Production preview observability — #3709

## Scope and provenance

Production artifact built from base 9e601f937 plus this change; Chrome 152 on Apple M5 Max, macOS/Darwin 25.6. Fresh gpu,parallel WASM was built from e226da2d2 source (raw-pipeline unchanged through the artifact base). Browser fixtures are disposable copies; originals remain untouched. This is browser harness qualification, not a controlled performance ratchet: background ResilioSync was active. Thresholds are unchanged.

The Tailwind shell migration removed selectors used by four production specs. Stable surface, phase and resolved-source attributes now replace those styling selectors. A resolved source is not proof of painted pixels: consumers verify actual image load and geometry. The shared-URL path intentionally reuses the thumbnail element.

Both timing observers are armed before the same click. DOM mutation and image-load events detect readiness, then the observer crosses an animation frame. This avoids adding the initial frame imposed by polling. The clock begins before observer setup/action; no time is subtracted. Cache-hit/no-RAW-read assertions remain intact.

## Executed results

- Angular: 38 tests across preview-shell surface/general/navigation suites passed.
- Seven Hosted production harness flows passed: artifact headers, immutable originals, writable cache creation, preview cache before RAW intake, actual cache-format reuse, sidecar write/reload/recovery, welcome single-file XMP download.
- Browse single-file import → preview → Edit passed, preserving no editor filmstrip and XMP download. Browse imports intentionally enter Preview; Welcome imports intentionally enter Editor.
- X3F thumbnail → preview → editor passed in 4.3 seconds, including nonblank pixel evidence. The previous descendant-canvas selector accidentally selected the transparent mask tint canvas; direct image surfaces exclude overlays.
- Final event-observer cold/warm test passed: cold fast 711.110 ms, subsequent refine 268.160 ms; warm samples 19.005, 14.140, 19.655, 18.190, 18.640 ms; median 18.640 ms against unchanged 35 ms ceiling.
- Earlier frame-polling versions are retained as diagnostic provenance: sequential observation charged another frame (warm median 49.37 ms, failed); concurrent polling yielded 32.885 ms (passed), and the later prearmed polling run yielded 37.460 ms (failed). The final result follows a substantive readiness-observation change, not selection of the best repeated run.

## Remaining qualification gaps

The full Browse actions test now reaches actual Paste, then fails because the injected JavaScript file handle cannot be structured-cloned into the batch worker. Chrome reports Worker.postMessage DataCloneError and the staged target sidecar remains unchanged. This test is still enabled with its assertions intact. Follow-up #3719 tracks real cloneable browser fixtures, including full Copy/Paste/Sync, filters and filmstrip actions. No production worker bypass was added.

Self Hosted RAF byte-failure/retry/reopen was not executed locally in this qualification; the Hosted project explicitly skips that test. No Self Hosted runtime pass is claimed.

Local logs and browser traces were retained under /tmp/maple-3709-* during the run. They are ephemeral diagnostics; the results and limitations above are the durable record.
