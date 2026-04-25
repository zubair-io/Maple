# Open-Path Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the cold-open RAW pipeline by removing wasted work that lands on the user's awaited path. Three fixes, in order of effort: detach the JPEG-encode write-back from the awaited decode, persist the rendered preview after the fast phase when refine will be skipped (so re-opens hit the cache), and stop the Rust preview path from upsampling and shipping ~300MB across the FFI when a half-res buffer is sufficient. Plus one regression test for the existing embedded-preview-first invariant.

**Architecture:**
- All three perf changes preserve existing call sites and don't change the FFI struct shape.
- The Rust pipeline still emits half-res for `Quality::Preview`; the `upsample_2x_nearest_rgb8` step is dropped. Swift's existing `decodedForNativeCanvas` (CIImage transform — lazy, fuses with the filter chain) handles the resolution gap on the Apple side.
- `RenderedPreviewCache` writes happen on refine *and* on fit-mode-fast (i.e. when `_scheduleRefine` short-circuits). Slider-drag fast renders still don't write — only the "final" render for a given user-state does.
- `DecodedBufferCache.storeDecoded` moves into a `Task.detached(priority: .utility)` so the JPEG encode of a 100MP buffer no longer holds up the published `decodedImage`.

**Tech Stack:** Rust (`raw-core`), Swift (`MapleCore`), CoreImage, existing on-disk JPEG caches under `<folder>/.maple/`.

**Verified findings (each maps to a task):**

1. **`DecodedBufferCache.storeDecoded` blocks the awaited decode.** [EditSession.swift:894-907](src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift:894) wraps `decoded(for:)` and `storeDecoded(_:for:)` in a single `Task.detached`, then awaits its full completion at line 911. JPEG-encoding 100MP × 3 bytes adds ~1–2s before `decodedImage` is published.
2. **`RenderedPreviewCache.storePreview` only fires on `phase == .refine`.** [EditSession.swift:823-839](src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift:823) gates the write on refine; [EditSession.swift:728-734](src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift:728) short-circuits refine when refine target ≤ fast target (i.e. fit mode). Fit-to-window users never populate the cache; re-opens always pay the full Rust decode.
3. **Rust preview path runs at half-res, then 2× upsamples and ships ~300MB across FFI.** [pipeline.rs:101-112](src/raw-pipeline/raw-core/src/pipeline.rs:101) + `upsample_2x_nearest_rgb8` at [pipeline.rs:118-143](src/raw-pipeline/raw-core/src/pipeline.rs:118). The upsample carries no extra detail; Apple's `decodedForNativeCanvas` ([EditSession.swift:574-615](src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift:574)) already handles the half-vs-native gap via lazy CIImage transform.
4. (Already implemented) **First paint via embedded JPEG / cached preview.** `seedFromCachedPreview` ([EditSession.swift:621-636](src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift:621)) and `seedFromEmbeddedPreview` ([EditSession.swift:643-661](src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift:643)) run before the Rust decode in `openAssetPipelineAsync` ([EditSession.swift:528-563](src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift:528)). No change needed; add a regression test only.

**Out of scope (explicit):**
- Splitting `maple_render_file` into decode-once + apply-adjustments. Larger architectural change; separate plan.
- Switching the working color space from `extendedLinearSRGB` to Rec.2020. Parity issue, not a perf issue; separate plan.
- Pre-compiling Metal kernels at app launch (~50ms first-slider stall). Separate small plan.
- Web side. Current gaps (no GPU pipeline, no two-phase render) need their own plan once the GPU path lands.

---

## File Structure

**Rust:**
- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs` — drop the 2× upsample in the `Preview` branch; return the half-res buffer directly.

**Swift:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift` — detach `storeDecoded`; add `persistCurrentPreviewToCache`; call it from the `_scheduleRefine` skip branch.
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/EditSessionTests.swift` — add tests covering the new persist-on-skip path and the embedded-preview-first invariant.

---

## Task 1: Detach `DecodedBufferCache.storeDecoded` from the awaited decode

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift` (lines 894-907 in the `sharedDecode` Task body)

**Why this matters:** JPEG-encoding a 100MP CIImage is ~1–2s. Today it sits on the awaited path between Rust returning and `decodedImage` being published, so users see that delay even when the decode itself is fast.

- [ ] **Step 1: Read the current `sharedDecode` body to confirm the structure.**

Run: `sed -n '870,931p' src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`

Confirm: there's a `Task.detached(priority: .userInitiated)` containing the disk-cache check, the Rust decode call, and an `await DecodedBufferCache.shared.storeDecoded(decoded, for: url)` on the same task before returning the decoded buffer.

- [ ] **Step 2: Update the task body so `storeDecoded` runs in a fire-and-forget child task.**

Replace this block (around lines 894-907):

```swift
let task: Task<CIImage?, Never> = Task.detached(priority: .userInitiated) { [pipeline] in
    // Disk-cache fast path. Skips the Rust pipeline entirely when
    // the asset's mtime matches the cached key.
    if let url = asset.primaryURL,
       let cached = await DecodedBufferCache.shared.decoded(for: url) {
        return cached
    }
    // Cache miss — Rust decode, then write-back for the next open.
    guard let decoded = await pipeline.decode(asset: asset) else { return nil }
    if let url = asset.primaryURL {
        await DecodedBufferCache.shared.storeDecoded(decoded, for: url)
    }
    return decoded
}
```

with:

```swift
let task: Task<CIImage?, Never> = Task.detached(priority: .userInitiated) { [pipeline] in
    // Disk-cache fast path. Skips the Rust pipeline entirely when
    // the asset's mtime matches the cached key.
    if let url = asset.primaryURL,
       let cached = await DecodedBufferCache.shared.decoded(for: url) {
        return cached
    }
    // Cache miss — Rust decode, then write-back for the next open.
    guard let decoded = await pipeline.decode(asset: asset) else { return nil }
    if let url = asset.primaryURL {
        // Fire-and-forget. JPEG-encoding a 100 MP CIImage takes ~1–2 s;
        // gating `task.value` on it pushes that delay onto the
        // published `decodedImage`. The cache is purely a perf assist
        // for the next cold open — losing one write on app crash is
        // fine, blocking the user is not.
        let captured = decoded
        Task.detached(priority: .utility) {
            await DecodedBufferCache.shared.storeDecoded(captured, for: url)
        }
    }
    return decoded
}
```

- [ ] **Step 3: Build to confirm.**

Run: `cd src/apple/Packages/MapleCore && swift build 2>&1 | tail -5`
Expected: `Build complete!` with no warnings/errors related to this change.

- [ ] **Step 4: Run the existing test suite.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed" | tail -3`
Expected: all tests still pass; total count unchanged.

- [ ] **Step 5: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift
git commit -m "$(cat <<'EOF'
perf(apple): detach DecodedBufferCache.storeDecoded from the awaited decode

JPEG-encoding a 100 MP CIImage is ~1–2 s on its own; gating
`task.value` on it pushed the same delay onto the published
`decodedImage`. The cache is a perf assist for the next cold open
— losing one write on app crash is fine, blocking the user is not.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Persist rendered preview after fast render when refine is skipped

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/EditSessionTests.swift`

**Why this matters:** Fit-to-window is the default on every open (`pixelScale = 0`). In fit mode, `_scheduleRefine` short-circuits because `refinedTargetSize` floors at `fastTargetSize`. Today the cache write is gated on `phase == .refine`, so fit-mode users never populate the cache and every cold re-open redoes the Rust pipeline. The previous app handled this with a `persistCurrentPreviewToCache()` helper called from both the refine path and the refine-skip branch. Port that pattern.

- [ ] **Step 1: Write the failing test first.**

Open `src/apple/Packages/MapleCore/Tests/MapleCoreTests/EditSessionTests.swift`. Add this test (alongside the existing tests):

```swift
    /// Fit-to-window opens are the common case; if `RenderedPreviewCache`
    /// only writes on `phase == .refine` then those opens never populate
    /// the cache and every re-open redoes the Rust pipeline. Verify that
    /// after a fast pass completes in fit mode, the cache file appears
    /// on disk for the asset.
    func testFitModeRenderPersistsToPreviewCacheAfterFastPass() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        // Configure the cache against the temp dir so the write lands
        // somewhere the test can observe.
        await RenderedPreviewCache.shared.configure(folderURL: tmp)

        // A real .dng under tmp so EditSession's `assetURL` is valid for
        // mtime keying. Empty bytes are fine — the test seeds
        // `renderedPreview` directly rather than running Rust; we're
        // testing the persist path, not decode.
        let assetURL = tmp.appendingPathComponent("test.dng")
        try Data([0x44, 0x4E, 0x47]).write(to: assetURL)

        let asset = AssetRef(url: assetURL)
        let session = await EditSession(asset: asset)

        // Manually drive a fast-only render: previewSize set, pixelScale=0
        // (fit mode), seed `renderedPreview`, then exercise the public
        // render path. After the 250 ms refine debounce + the detached
        // cache write, the file should exist on disk.
        await MainActor.run {
            session.previewSize = CGSize(width: 800, height: 600)
            session.pixelScale = 0  // fit mode
            session.renderedPreview = CIImage(color: .red)
                .cropped(to: CGRect(x: 0, y: 0, width: 800, height: 600))
        }

        // Trigger persist via the public render path. This kicks
        // _scheduleRender(.fast) → fast publish → _scheduleRefine →
        // skip branch → persistCurrentPreviewToCache.
        await session.ensureRenderStarted()

        // Allow the 250 ms refine sleep + the utility-priority cache write
        // to land. Generous — cache write is ~10 ms but CI varies.
        try await Task.sleep(for: .milliseconds(1500))

        let mapleDir = tmp.appendingPathComponent(".maple/previews")
        let files = (try? FileManager.default.contentsOfDirectory(atPath: mapleDir.path)) ?? []
        XCTAssertFalse(files.isEmpty, "RenderedPreviewCache should have written a file under .maple/previews")
    }
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testFitModeRenderPersistsToPreviewCacheAfterFastPass 2>&1 | tail -10`
Expected: FAIL with `XCTAssertFalse failed: RenderedPreviewCache should have written a file under .maple/previews`. This confirms today's fit-mode path doesn't populate the cache.

- [ ] **Step 3: Add a `persistCurrentPreviewToCache` helper above `_scheduleRender`.**

Open `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`. Find the `// MARK: - Private render scheduling` line (around line 688). Insert this helper immediately above it:

```swift
    // MARK: - Cache persistence

    /// Snapshot the current `renderedPreview` into `RenderedPreviewCache`
    /// so a future cold open of this asset can paint pixels instantly.
    /// Called from both the refine path (after refine publishes) and the
    /// refine-skip branch in `_scheduleRefine` — without the latter,
    /// fit-to-window opens (the most common case) never populate the
    /// cache and every cold re-open redoes the Rust pipeline.
    @MainActor
    private func persistCurrentPreviewToCache() {
        guard let url = asset.primaryURL,
              let preview = renderedPreview else { return }
        let capturedImage = preview
        let capturedWidth = Int(max(previewSize.width, 1))
        Task.detached(priority: .utility) {
            await RenderedPreviewCache.shared.storePreview(
                capturedImage, for: url, screenWidth: capturedWidth
            )
        }
    }
```

- [ ] **Step 4: Replace the inline cache write inside `decodeAndRender`'s refine branch with a call to the helper.**

Find the block in `decodeAndRender` that runs after a successful `phase == .refine` publish (around lines 823-839):

```swift
            // Refresh the on-disk thumbnail so the browse grid reflects the
            // user's develop (not the camera's embedded preview). Only on
            // the refine pass — the fast pass is viewport-sized and blurry
            // when downscaled to 256 px. Filesystem assets only: sourceless
            // assets don't have a stable URL to key off of.
            if phase == .refine, let url = asset.primaryURL {
                Task.detached(priority: .utility) {
                    await ThumbnailLoader.shared.updateThumbnailFromRender(image, for: url)
                }
                // Persist a viewport-sized JPEG to the preview cache so a
                // cold re-open of this asset paints instantly via
                // `loadCachedPreviewIfAvailable`. Only after refine — the
                // fast pass ran at viewport resolution already; caching
                // after refine captures the final develop output.
                let capturedImage = image
                let capturedWidth = Int(max(previewSize.width, 1))
                Task.detached(priority: .utility) {
                    await RenderedPreviewCache.shared.storePreview(
                        capturedImage, for: url, screenWidth: capturedWidth
                    )
                }
            }
```

Replace with:

```swift
            // Refresh the on-disk thumbnail so the browse grid reflects the
            // user's develop (not the camera's embedded preview). Only on
            // the refine pass — the fast pass is viewport-sized and blurry
            // when downscaled to 256 px. Filesystem assets only: sourceless
            // assets don't have a stable URL to key off of.
            if phase == .refine, let url = asset.primaryURL {
                Task.detached(priority: .utility) {
                    await ThumbnailLoader.shared.updateThumbnailFromRender(image, for: url)
                }
                persistCurrentPreviewToCache()
            }
```

- [ ] **Step 5: Update `_scheduleRefine` to persist on the skip branch.**

Find `_scheduleRefine` (around lines 722-737):

```swift
    private func _scheduleRefine(gen requested: UInt64? = nil) {
        refineTask?.cancel()
        let gen = requested ?? renderGeneration
        refineTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            guard gen == renderGeneration, !Task.isCancelled else { return }
            // Short-circuit when refine would render at the same (or smaller)
            // target as the most recent fast pass. Avoids a wasted CoreImage
            // pipeline build when the user hasn't actually zoomed in.
            if let fast = fastTargetSize, let refine = refinedTargetSize,
               refine.width <= fast.width + 1 && refine.height <= fast.height + 1 {
                return
            }
            await decodeAndRender(targetSize: refinedTargetSize, phase: .refine, gen: gen)
        }
    }
```

Replace the early-return so it persists the just-finished fast render before bailing:

```swift
    private func _scheduleRefine(gen requested: UInt64? = nil) {
        refineTask?.cancel()
        let gen = requested ?? renderGeneration
        refineTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            guard gen == renderGeneration, !Task.isCancelled else { return }
            // Short-circuit when refine would render at the same (or smaller)
            // target as the most recent fast pass. Avoids a wasted CoreImage
            // pipeline build when the user hasn't actually zoomed in. Persist
            // the fast result first so a cold re-open can paint from the
            // cache — without this, fit-to-window opens (the common case)
            // never populate `RenderedPreviewCache`.
            if let fast = fastTargetSize, let refine = refinedTargetSize,
               refine.width <= fast.width + 1 && refine.height <= fast.height + 1 {
                persistCurrentPreviewToCache()
                return
            }
            await decodeAndRender(targetSize: refinedTargetSize, phase: .refine, gen: gen)
        }
    }
```

- [ ] **Step 6: Run the test to verify it passes.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testFitModeRenderPersistsToPreviewCacheAfterFastPass 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 7: Run the full suite.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed" | tail -3`
Expected: all tests pass; new test included.

- [ ] **Step 8: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/EditSessionTests.swift
git commit -m "$(cat <<'EOF'
perf(apple): persist preview cache after fast render when refine skips

Fit-to-window is the default on every open and refine short-circuits
in fit mode, so the previous `phase == .refine` gate meant
RenderedPreviewCache was never populated for the common case. Port
the previous app's `persistCurrentPreviewToCache` pattern: persist
on refine *and* on the refine-skip branch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Drop the 2× upsample from the Rust preview pipeline

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs`

**Why this matters:** The `Preview` branch runs every stage at half-res (the win), then `upsample_2x_nearest_rgb8` doubles the buffer back to native dimensions before returning. For a 100MP RAW that ships ~300MB across the FFI per cold open and forces Swift to copy + wrap a buffer that carries no extra detail. Apple's `decodedForNativeCanvas` already handles half-vs-native via a lazy CIImage transform that fuses with the filter chain — moving the resolution gap to that lazy path costs nothing.

- [ ] **Step 1: Read the current preview branch and the upsample helper.**

Run: `sed -n '95,143p' src/raw-pipeline/raw-core/src/pipeline.rs`

Confirm: the match arm for `RenderQuality::Preview` calls `upsample_2x_nearest_rgb8(&bytes, w, h)` and returns the doubled buffer. The helper is defined in the same file.

- [ ] **Step 2: Update the preview branch to return the half-res buffer directly.**

Replace this block:

```rust
    match quality {
        RenderQuality::Full => Ok((w, h, bytes)),
        RenderQuality::Preview => {
            // The half-res quad demosaic emits a buffer at (w/2, h/2). Every
            // downstream stage ran on 4× fewer pixels — that's the perf win.
            // Before handing the buffer back to the caller we pixel-double
            // it so the app's zoom / fit math sees the original sensor
            // dimensions. Nearest-neighbour (no filtering) is fine: CoreImage
            // or WebGL will resample for display anyway, and a filter here
            // would just launder the same information through math.
            let (out_w, out_h, out_bytes) = upsample_2x_nearest_rgb8(&bytes, w, h);
            Ok((out_w, out_h, out_bytes))
        }
    }
```

with:

```rust
    // Both branches return the buffer at its actual sensor dimensions —
    // the `Preview` branch is half-res in both axes (because of
    // `demosaic::half_res`), and Apple/Web consumers handle the
    // resolution gap via their lazy display transform (CIImage scale on
    // Apple; texture upload on Web). Pixel-doubling here added ~300 MB
    // of FFI traffic and 4× the allocator pressure on a 100 MP RAW for
    // no extra information.
    Ok((w, h, bytes))
```

- [ ] **Step 3: Delete the now-unused `upsample_2x_nearest_rgb8` helper and its rayon import.**

Verified by `grep` against the current file: `rayon::prelude` is imported only at line 13 and used only inside this helper (line 127). After removal both are dead.

Open `src/raw-pipeline/raw-core/src/pipeline.rs` and:

1. Delete line 13: `use rayon::prelude::*;`
2. Delete lines 115-143 — the doc comment and the `fn upsample_2x_nearest_rgb8` body, ending at the closing `}` after `(dw as u32, dh as u32, out)`.

Run: `grep -n "upsample_2x_nearest_rgb8\|rayon::prelude" src/raw-pipeline/raw-core/src/pipeline.rs`
Expected: no matches.

- [ ] **Step 4: Run the raw-core pipeline tests.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib pipeline 2>&1 | tail -10`
Expected: existing pipeline tests still pass. The `bytes.len() == w * h * 3` assertion holds at half-res because `w` and `h` are now the half-res values.

- [ ] **Step 5: Run the full raw-core test suite.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5`
Expected: all passing.

- [ ] **Step 6: Verify the parity gate still passes (it diffs against an upscaled embedded preview — both sides resize to a common target, so half-res output is still comparable).**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -10`
Expected: PASS with mean ΔE within budget. If the harness fails because it assumes native dimensions explicitly, check `src/scripts/compare_images.py` — it should resize both inputs to a common target before comparing.

- [ ] **Step 7: Rebuild the xcframework so Apple picks up the new Rust output.**

Run: `./src/apple/scripts/build-xcframework.sh 2>&1 | tail -3`
Expected: `built xcframework at …`. Takes ~5 min.

- [ ] **Step 8: Build and test the Apple side.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed" | tail -3`
Expected: all passing. `decodedForNativeCanvas` already handles the half-vs-native case (it scales up when the decoded extent is smaller than the metadata-reported native size).

- [ ] **Step 9: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/pipeline.rs
git commit -m "$(cat <<'EOF'
perf(raw-core): stop pixel-doubling preview output back to native dims

The `Preview` branch ran every stage at half-res (the perf win),
then `upsample_2x_nearest_rgb8` doubled the buffer back to native
sensor dimensions before returning. For a 100 MP RAW that's ~300 MB
of FFI traffic and 4× allocator pressure for no extra information.
Both Apple's `decodedForNativeCanvas` and the Web path already
handle the resolution gap through their lazy display transform.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 10: Commit the rebuilt xcframework binary slices (if the build script regenerates them under version control).**

Run: `git status src/apple/Frameworks/RawPipeline.xcframework`

If the headers / module.modulemap changed but the static libs are gitignored (per the project's convention — they're 200–500 MB and over GitHub's limit), commit only the headers:

```bash
git add src/apple/Frameworks/RawPipeline.xcframework/Headers src/apple/Frameworks/RawPipeline.xcframework/*/module.modulemap
git diff --cached --stat
git commit -m "chore(apple): sync xcframework headers after preview-output change"
```

---

## Task 4: Regression test for embedded-preview-first invariant

**Files:**
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/EditSessionTests.swift`

**Why this matters:** The instant-first-paint behavior already exists (`seedFromCachedPreview` and `seedFromEmbeddedPreview` run before the Rust task in `openAssetPipelineAsync`), but there's no test guarding it. A future refactor could easily reorder the awaits and silently regress to "user waits for Rust." Lock the invariant down with a test.

- [ ] **Step 1: Add the regression test.**

Open `src/apple/Packages/MapleCore/Tests/MapleCoreTests/EditSessionTests.swift`. Add this test:

```swift
    /// On a cold open (no `.maple/previews` cache hit), the embedded JPEG
    /// preview should publish to `renderedPreview` *before* the Rust
    /// decode lands — that's the difference between a 50 ms first paint
    /// and a multi-second one on a 100 MP RAW. This test captures the
    /// ordering invariant by asserting `renderedPreview != nil` within
    /// a tight window (well under any plausible Rust decode time, even
    /// on cached fixtures).
    ///
    /// Requires a real .dng with an embedded JPEG preview. Uses
    /// `test-fixtures/raws/test_0002.dng` if present; skips otherwise so
    /// CI without fixtures still runs.
    func testColdOpenPaintsEmbeddedPreviewBeforeRustDecode() async throws {
        let fixturePath = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("raw-pipeline/test-fixtures/raws/test_0002.dng")

        guard FileManager.default.fileExists(atPath: fixturePath.path) else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }

        let asset = AssetRef(url: fixturePath)
        let session = await EditSession(asset: asset)

        // Trigger the open path. The Rust decode runs in a background
        // task; the embedded-preview path runs sequentially in the
        // foreground task before awaiting Rust.
        await session.ensureRenderStarted()

        // Poll for `renderedPreview` to land. Embedded preview via
        // ImageIO is ~50 ms; Rust on this small fixture is ~3–5 s.
        // 300 ms is comfortably between the two — if `renderedPreview`
        // hasn't published by then, the embedded path is broken.
        let deadline = Date().addingTimeInterval(0.3)
        while Date() < deadline {
            if await session.renderedPreview != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }

        let preview = await session.renderedPreview
        XCTAssertNotNil(preview, "Embedded preview must publish within 300 ms; otherwise cold open regressed to wait for Rust")
    }
```

- [ ] **Step 2: Run the new test.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testColdOpenPaintsEmbeddedPreviewBeforeRustDecode 2>&1 | tail -10`
Expected: passes if fixture is present; skipped if not.

- [ ] **Step 3: Run the full suite.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed" | tail -3`
Expected: all tests pass.

- [ ] **Step 4: Commit.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/EditSessionTests.swift
git commit -m "$(cat <<'EOF'
test(apple): lock down embedded-preview-first invariant on cold open

Today `openAssetPipelineAsync` runs cache + embedded-preview seeds
before awaiting the Rust task, so cold opens paint within ~50 ms.
Add a regression test asserting `renderedPreview` publishes within
300 ms — well under any plausible Rust decode time — so a future
refactor that reorders the awaits trips a clear failure instead of
silently regressing to multi-second cold opens.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Per-stage timing instrumentation in `raw-core`

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs`

**Why this matters:** Tasks 1–3 attack obvious waste, but the *necessary* work — `sensor_linearize` → `demosaic` → `dcp` → `agx` → `encode` — is a black box from Instruments today. The Apple-side `editSessionSignposter` ([EditSession.swift:34](src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift:34)) emits `decode` as a single interval, with no breakdown of where those seconds actually go. Without per-stage timings we can't make informed decisions about pipeline tiling, P-core pinning, or which stage to attack next. Stderr-based logging keeps this cross-platform (raw-core also compiles to WASM where OS signposts don't exist) and zero-cost when disabled.

**Activation:** Set `MAPLE_PROFILE=1` in the environment before running `maple-cli` or launching the Apple app from a terminal. Unset → no allocations, no syscalls, no logs.

- [ ] **Step 1: Add a `stage` timing helper to `pipeline.rs`.**

Open `src/raw-pipeline/raw-core/src/pipeline.rs`. Just below the existing `use` block (around line 13, after the `rayon` import is removed in Task 3), add:

```rust
use std::time::Instant;

/// Wraps a pipeline stage with `Instant::now()` timing, emitting one line
/// to stderr when `MAPLE_PROFILE` is set in the environment. When unset
/// the only cost is a single `Instant::now()` call and a `getenv` —
/// negligible relative to per-pixel work, so we leave it on in release
/// builds and let the env var gate the actual output.
///
/// Format: `[raw-core] <stage_name>            <elapsed>`. The width is
/// chosen so a 30-char name and a 10-char duration line up in a
/// monospace terminal — easy to eyeball "demosaic dominates" vs.
/// "every stage is 200 ms."
#[inline]
fn stage<T>(name: &'static str, f: impl FnOnce() -> T) -> T {
    let t = Instant::now();
    let r = f();
    if std::env::var_os("MAPLE_PROFILE").is_some() {
        eprintln!("[raw-core] {:<30} {:>10.2?}", name, t.elapsed());
    }
    r
}
```

- [ ] **Step 2: Wrap every stage call in `render_from_raw_with_quality`.**

Replace the body of `render_from_raw_with_quality` (the part from `let mosaic = …` through `let bytes = …`) so each stage runs through `stage(name, || …)`. The math is unchanged; only the call shape changes.

Old (around lines 44-95):

```rust
    let mosaic = linearize::sensor_linearize(raw);
    let mut camera_rgb = match quality {
        RenderQuality::Preview => demosaic::half_res(&mosaic, raw.cfa),
        #[cfg(feature = "high-quality-demosaic")]
        RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
        #[cfg(not(feature = "high-quality-demosaic"))]
        RenderQuality::Full => demosaic::bilinear(&mosaic, raw.cfa),
    };

    // … BaselineExposure comment block …
    if raw.baseline_exposure.abs() > 1e-4 {
        let be_gain = raw.baseline_exposure.exp2();
        for p in &mut camera_rgb.pixels {
            p[0] *= be_gain;
            p[1] *= be_gain;
            p[2] *= be_gain;
        }
    }
    highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery);
    let profile = dcp::profile_for(raw)?;
    let mut scene = dcp::apply(&camera_rgb, &profile)?;
    white_balance::apply(&mut scene, model.temperature, model.tint);
    scene_tone_controls::apply(&mut scene, model);
    vibrance::apply(&mut scene, model.vibrance);
    saturation::apply(&mut scene, model.saturation);
    clarity::apply(&mut scene, model.clarity);
    texture::apply(&mut scene, model.texture);
    dehaze::apply(&mut scene, model.dehaze);
    sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking);
    noise_reduction::apply_luminance(&mut scene, model.nr_luminance);
    noise_reduction::apply_color(&mut scene, model.nr_color);
    agx::apply(&mut scene, model.contrast);
    encode::rec2020_to_srgb(&mut scene);
    let bytes = encode::quantize_u8(&mut scene);
```

New:

```rust
    let mosaic = stage("linearize", || linearize::sensor_linearize(raw));
    let mut camera_rgb = stage("demosaic", || match quality {
        RenderQuality::Preview => demosaic::half_res(&mosaic, raw.cfa),
        #[cfg(feature = "high-quality-demosaic")]
        RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
        #[cfg(not(feature = "high-quality-demosaic"))]
        RenderQuality::Full => demosaic::bilinear(&mosaic, raw.cfa),
    });

    // … BaselineExposure comment block (unchanged) …
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }
    stage("highlight_recovery", || highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery));
    let profile = stage("dcp::profile_for", || dcp::profile_for(raw))?;
    let mut scene = stage("dcp::apply", || dcp::apply(&camera_rgb, &profile))?;
    stage("white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    stage("scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    stage("vibrance", || vibrance::apply(&mut scene, model.vibrance));
    stage("saturation", || saturation::apply(&mut scene, model.saturation));
    stage("clarity", || clarity::apply(&mut scene, model.clarity));
    stage("texture", || texture::apply(&mut scene, model.texture));
    stage("dehaze", || dehaze::apply(&mut scene, model.dehaze));
    stage("sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    stage("nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    stage("nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    stage("agx", || agx::apply(&mut scene, model.contrast));
    stage("rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    let bytes = stage("quantize_u8", || encode::quantize_u8(&mut scene));
```

Also wrap the `apply_orientation` call at line 98:

Old:

```rust
    let (w, h, bytes) = apply_orientation(&bytes, scene.width, scene.height, raw.orientation);
```

New:

```rust
    let (w, h, bytes) = stage("apply_orientation", || apply_orientation(&bytes, scene.width, scene.height, raw.orientation));
```

- [ ] **Step 3: Build the crate.**

Run: `cd src/raw-pipeline && cargo build -p raw-core 2>&1 | tail -5`
Expected: `Finished` with no warnings about unused variables. (The `stage` helper is `#[inline]` and used at every call site; no dead-code warning.)

- [ ] **Step 4: Run the existing test suite.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -3`
Expected: all passing. Stage timing is stderr-only; tests don't observe stderr by default.

- [ ] **Step 5: Manually verify the output via `maple-cli` on the reference fixture.**

Run:

```bash
cd src/raw-pipeline && \
  MAPLE_PROFILE=1 cargo run --release --bin maple-cli -- \
  batch <(echo '{"entries":[{"raw":"../../test-fixtures/raws/dji-mavic3pro-100mp.dng","xmp":null,"out":"/tmp/profile-out.png"}]}') \
  --out-dir /tmp/profile/ 2>&1 | grep '\[raw-core\]'
```

Expected: 18 lines, one per stage, with a `[raw-core] <name>     <elapsed>` shape. Total of those numbers should be in the same ballpark as the wall-clock decode time (~2s on this fixture after the rayon work).

If the fixture isn't present, substitute any DNG you have locally — the relative timings are what matters, not absolute numbers.

Note for traceability: paste the output into the commit body in Step 7. That's the baseline that next-round optimizations (P-core pinning, stage tiling) get measured against.

- [ ] **Step 6: Verify the gate works — running without `MAPLE_PROFILE` produces no output.**

Run:

```bash
cd src/raw-pipeline && \
  cargo run --release --bin maple-cli -- \
  batch <(echo '{"entries":[{"raw":"../../test-fixtures/raws/dji-mavic3pro-100mp.dng","xmp":null,"out":"/tmp/profile-out.png"}]}') \
  --out-dir /tmp/profile/ 2>&1 | grep '\[raw-core\]' | head
```

Expected: no lines (the `grep` output is empty).

- [ ] **Step 7: Commit, including the baseline numbers from Step 5 in the commit body.**

```bash
git add src/raw-pipeline/raw-core/src/pipeline.rs
git commit -m "$(cat <<'EOF'
perf(raw-core): per-stage timing via MAPLE_PROFILE env gate

Wraps each pipeline stage in a `stage(name, || …)` helper that
emits stderr lines when MAPLE_PROFILE is set. Cost when unset is
one Instant::now() and a getenv per stage — negligible next to
the per-pixel work. Cross-platform (works under WASM too, where
OS signposts don't exist).

Baseline on dji-mavic3pro-100mp.dng (M-series, release build):
<paste output from Step 5 here>

Use this to inform the next round (stage tiling vs. P-core
pinning vs. attacking the dominant stage).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist

**Spec coverage:**
- Detach storeDecoded from awaited decode ✓ (Task 1)
- Persist preview after fast when refine skips ✓ (Task 2)
- Drop 2× upsample in Rust preview branch ✓ (Task 3)
- Regression test for embedded-preview-first ✓ (Task 4)
- Per-stage timing instrumentation for follow-up profiling ✓ (Task 5)
- Verified each finding against current code before locking the plan ✓

**Placeholders:** none — every step has concrete code or a concrete command.

**Type consistency:**
- `persistCurrentPreviewToCache` is `@MainActor private func` and is called from `decodeAndRender` (already `@MainActor`-isolated) and `_scheduleRefine`'s inner `Task { @MainActor in … }` — both contexts are MainActor, no actor hops needed.
- `RenderedPreviewCache.shared.storePreview(_:for:screenWidth:)` signature unchanged — the helper just wraps the existing call.
- `pipeline.rs::render_from_raw_with_quality` return type `Result<(u32, u32, Vec<u8>)>` unchanged — `(w, h)` is half-res for `Preview`, full for `Full`. Existing tests assert `bytes.len() == w * h * 3` which holds either way.

**Known follow-up not in this plan (from the audit but separate scope):**
- `extendedLinearSRGB` working color space ([ImageEditPipeline.swift:71](src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift:71)) should be Rec.2020 to match the Rust core. Parity issue, not perf.
- Pre-compile Metal kernels at app launch ([MetalKernels.swift:75](src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift:75)) to remove the ~50 ms first-slider stall.
- Shared `CIContext` singleton in `ImageEditPipeline` ([EditSession.swift:347](src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift:347)) so a 100-image grid pre-pop doesn't create 100 contexts.
- Web side: no GPU pipeline, no two-phase render. Plan after the WebGL2 path lands.
- Long-term: split `maple_render_file` into decode-once + apply-adjustments so the interactive open path doesn't run AgX + sRGB encode every cold open.
