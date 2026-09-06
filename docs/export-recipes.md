# Export recipes and batch delivery

Export recipes are versioned JSON documents separate from development XMP. The schema and capabilities live in `raw-core/src/export_recipe`; `tools/codegen.sh` generates the TypeScript, Swift and C# mirrors. Every declared field, including nullable fields, must be present. Unknown fields and unsupported schema versions are rejected. Unsupported choice values survive save/import round-trips, but execution reports an actionable capability error.

## Supported output

| Setting           | Supported values                                                               |
| ----------------- | ------------------------------------------------------------------------------ |
| Format and depth  | JPEG 8-bit, TIFF 16-bit, PNG 8-bit                                             |
| JPEG quality      | Integer 1–100; lossless formats require `null`                                 |
| Maximum long edge | Positive integer or `null` for full resolution; never upscales                 |
| Output profile    | `srgb`, `display-p3`; an exact output ICC profile is embedded                  |
| Rendering intent  | `maple-display`, the existing Maple display transform and gamut conversion     |
| Source metadata   | `strip`; camera, GPS and authored metadata are removed, output ICC is retained |
| Watermark         | `null`; watermark rendering is unsupported                                     |

Standard ICC CMS rendering intents, HEIC, other profiles and metadata-copy policies are rejected. The engine does not silently substitute a supported choice. An active film look whose LUT cannot be resolved also fails explicitly.

The shared filename engine handles `{original}`, `{ext}`, `{n}` and `{date:FORMAT}`. Names are checked against the cross-platform filesystem rules; use `{ext}` to preserve the selected encoder's extension. Sequence numbers are fixed when the selection is captured and stay fixed on retries. ISO capture metadata is converted to the camera's EXIF wall-clock text without applying the viewer's timezone. Missing or malformed dates produce the shared `unknown-date` fallback.

## Web

Open **Export recipes** from Browse, or **Saved recipes and export queue** from the focused image's Export dialog. Recipes can be named, saved, selected, deleted, downloaded as JSON, and imported. Saved recipes and the active queue use IndexedDB. Each queued photo captures its complete XMP, film selection, source identity and original sequence index before work starts.

**Browser downloads** runs one full developed-image render at a time in the existing worker. Browser download settings control file naming and collision behavior. A successful handoff does not prove the browser wrote a file. If the tab disappears after handoff begins, that photo becomes an explicit uncertain-download failure; check Downloads before retrying. A source opened through a temporary FileList may need reopening after reload.

**Chosen folder** in a browser workspace uses the File System Access API. Choose a writable destination using the native picker. The recipe stores a device-local handle key; importing it on another device requires choosing a destination there. Original file handles and the destination handle are persisted with the queue. Permission failures are shown; grant access before resuming or retrying. Browsers without writable folder support retain Browser downloads.

**Server directory** in Self Hosted submits a durable `batch_recipe_export` job to the API. The destination must be an existing absolute directory inside an authorized library root. It continues when the browser closes. Reopening the dialog reconnects to the saved job identity; repeating a lost enqueue request is idempotent.

Directory recipes use explicit **error**, **skip**, or **replace** collision policies. Originals are never replaced. Cancellation stops between photos; **Resume remaining** retains completed work, and **Retry failed** creates a run containing only failed photos with their original edits and indices. Summaries retain every failure but display at most five details at once.

## Windows

**Photo → Export** (Ctrl+E) opens the recipe editor, including named save/import/export, a destination picker and the collision policy. **Add to queue** captures the selected photos' complete XMP and original sequence numbers in `%LOCALAPPDATA%/Maple/exports`. Local and cloud selections resolve original bytes and sidecars before enqueue; a missing input aborts preparation with the photo's name.

**Queue…** remains available without a selection. It exposes saved runs, resume, retry failed photos and cancellation before publication. Closing a running queue requests cancellation and waits for the current synchronous native render. A process lock serializes queue execution; durable prepared hashes reconcile publication after restart. Final and staging paths are checked against every selected original. Windows uses the same core recipe validation, filename engine and full developed-image export ABI.

The Windows build and published app include the shared `.mlut` files beside the executable in `film-luts`. Export resolves that directory automatically for a film look captured in XMP. A native queue regression applies a bundled black-and-white look, verifies that its JPEG differs from the no-film output, and preserves the original hash and ICC profile.

## Durable publication

The API extends the existing JobRunner, including lease renewal during long native renders and ownership-fenced checkpoints. The ledger records the unique staging path before native encoding starts, then the prepared output's SHA-256 before publication. Native publication uses an exclusive hard link for error/skip policies or an atomic rename for explicit replacement. Mirror-aware filesystem operations replicate the committed output.

Browser folder delivery journals the destination's before/after hashes before opening a writable stream. The browser commits that stream on close. On recovery, a matching after-hash acknowledges an already-published output; unchanged before-bytes may be rendered again, while a conflicting file is reported for review. A crash during initial file creation can leave an empty destination that requires review/removal before an error-policy retry. Browser Downloads uses the separate uncertain-handoff rule above.

Checks detect intervening output changes before publication. The filesystem APIs do not provide a compare-and-swap operation against arbitrary external applications; users should not concurrently edit a destination being replaced.

## Browser memory ceiling

Browser export preserves requested dimensions. It uses the existing CPU renderer budget: full resolution through 32 million sensor pixels; larger sensors require an explicit maximum long edge no greater than `min(sensor long edge / 2, 4096)`. The guard reads actual decoded sensor dimensions and rejects before RGB demosaic/stage allocations. It never silently lowers the requested size. Sized export already downsamples early in the canonical develop path. Native Windows, API and CLI exports do not have this wasm32 limit.

The worker awaits initialization even when a batch is started without opening the editor. Export releases the native-detail viewer's retained sensor mosaic first. An unexpected WASM trap terminates the poisoned worker before the next photo and reports recovery options.

Legacy `batch_jpeg_export` jobs use this same developed-image pipeline. The adapter captures real sidecar XMP once into the durable ledger, including across cancellation/restart; it no longer routes export through a thumbnail renderer.

## CLI and API

Save/download a directory recipe, then run:

```sh
maple-cli export-recipe /photos/IMG_0001.dng --recipe recipe.json --params /photos/IMG_0001.xmp --index 0
```

`--params` explicitly selects the immutable edit snapshot; omit it for defaults. `--film-lut-dir` selects an installed LUT directory when a film look is active. Output uses the full-resolution shared `export_from_raw_with_film` path, with the recipe's size cap applied by the canonical encoder.

`POST /api/jobs` accepts `kind: "batch_recipe_export"`, a caller-generated 24-character hexadecimal `requestId`, and `payload: { recipe, targets }`. Each target supplies `id`, absolute `path`, immutable `xmp`, zero-based `index`, and nullable `capturedAt`. Requests are limited to 2,000 targets and a 12 MB snapshot payload, leaving MongoDB document space for the journal. `GET /api/jobs/:id?summary=1`, `POST /:id/cancel`, `POST /:id/resume`, and `POST /:id/retry-failed` use the existing authenticated job routes. Reusing a request ID with different content returns 409.

The C ABI exposes `maple_validate_export_recipe`, `maple_export_recipe_filename_buf`, and `maple_export_recipe_to_file`. The render call creates an exclusive staging file; the host owns final publication and the durable ledger. Validation and filename calls are cheap synchronous preflights and return same-thread last-error text on failure.

## Verification

Core tests render synthetic DNG data through all three encoders and both profiles, inspect dimensions/bit depth/ICC/source-metadata removal, and compare decoded PNG pixels with the full display pipeline. The source parsers first confirm real EXIF capture time, ISO, GPS, Artist and XMP in the synthetic input. Every output must strip those carriers while matching the fixed [ICC goldens](../test-fixtures/export-recipes/README.md) byte for byte. CLI tests invoke the real binary. API integration tests use temporary original files, a private MongoDB database and the actual native child; they cover failure continuation, immutable legacy snapshots, retry identity, collision handling, original protection and crash recovery. JobRunner tests cover lease renewal and ownership loss. Windows filesystem/snapshot tests exercise queue recovery, source protection and immutable cloud selection; the actual C ABI test exports a 2.8 MP synthetic DNG with ICC while preserving the original SHA-256. A Release WinUI build validates the UI integration; native window interaction was not automated.

`bun run check:export-recipe-storage` runs Chromium with an isolated profile and real IndexedDB/FileSystemHandles (OPFS). It verifies recipe/handle persistence across reload, hash recovery, collision policies, original protection, checkpoint failure, cancellation and external-change conflicts. The delivery harness intentionally isolates delivery from encoding; it does not claim to qualify image quality or the native folder picker UI. Web contract/component tests and both production builds validate the consuming UI. A separate isolated Chrome run opened a synthetic 64×48 DNG through the built Hosted app and exported it from the recipe dialog; Pillow confirmed a 64×48 JPEG with the embedded 6,684-byte ICC profile.

`bun run check:export-recipe-memory /path/to/100mp.dng [dist/browser] [cap]` requires an explicit large synthetic fixture and never skip-passes. Against the production GPU/parallel WASM build, a 12288×8192 DNG was rejected at full resolution in 0.9–1.9 seconds. The same cold worker then encoded JPEG at 2048×1365 (89,594 bytes, 11.3 seconds total) and, in a separate run, 4096×2731 (323,667 bytes, 20.2 seconds total). Chrome decoded both outputs, their ICC markers were present, and the original SHA-256 was unchanged. This qualifies capped export of this synthetic source, not full-resolution 100 MP browser export.

A native Windows release C ABI run exported that 12288×8192 source at full resolution with exposure +0.70, contrast +12, JPEG quality 92 and Display P3. On an Intel Core i7-1255U (12 logical CPUs, default Rayon pool), source read/decode/render/encode/fsync took 95.05 seconds. Peak process working set was 8.424 GiB; at least 4.636 GiB of system RAM remained available, and process residency fell to 31.33 MiB afterward. Pillow fully decoded the 2,805,163-byte JPEG, matched its 6,688-byte ICC to the fixed Display P3 golden, and confirmed 12288×8192 dimensions and no EXIF. The source SHA-256 remained unchanged. Source hashing warmed the filesystem cache; DLL loading and post-export validation are excluded from the timing. This is a single synthetic native feasibility measurement, not a cold-storage or real-camera performance qualification.

Synthetic tests do not establish physical-camera RAW color quality, paired ACR parity, or a native performance budget across the reference scene set. Those remain fixture-dependent acceptance gates under #2438.
