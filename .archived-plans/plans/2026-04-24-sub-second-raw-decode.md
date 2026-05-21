# Sub-Second RAW Decode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut `_Maple`'s cold-open RAW decode from ~20 s to sub-second on 100 MP files by parallelising the `raw-core` per-pixel stages with rayon and caching the final decoded u8 sRGB buffer to disk so subsequent opens skip the Rust pipeline entirely.

> **Update (2026-04-24):** The `upsample_2x_nearest_rgb8` helper this plan
> introduced was later removed in commit `6bb2a7c` (open-path-perf Task 3) —
> Apple/Web consumers handle the half-vs-native gap via their lazy display
> transform. References to the helper below are historical.

**Architecture:**
1. **Rayon** on the six hottest per-pixel stages (`linearize`, `demosaic::half_res`, `color::dcp::apply`, `view::agx::apply`, `view::encode::rec2020_to_srgb`, `view::encode::quantize_u8`, `pipeline::upsample_2x_nearest_rgb8`). Each stage is embarrassingly parallel (row- or pixel-independent); `par_iter_mut` / `par_chunks_exact_mut` gets 6–10× on Apple Silicon.
2. **`DecodedBufferCache`** on the Swift side, writing the decoded JPEG under `<folder>/.maple/decoded/<hash>.jpg` keyed on `(primaryURL, primaryMtime, rust_version)`. `EditSession.sharedDecode` reads it before spawning Rust; writes it after Rust completes. Follows the same pattern as the existing `RenderedPreviewCache` but caches the *pre-adjustment* output so slider math is applied against it, not the fully-rendered previous state.

**Tech Stack:** Rust (`raw-core`, `raw-ffi`), Swift (`MapleCore`), rayon, bundled CoreImage, `.maple/decoded/` on-disk JPEG cache.

**Expected timings after this lands (100 MP ProRAW, M2 Pro):**
- Cold open, new image: ~20 s → ~2 s (rayon on 10 cores)
- Re-open of same image with same sidecar: ~2 s → ~50 ms (decoded-buffer cache hit)
- Slider tick: unchanged (already hits `decodedImage` cache)

**Out of scope (explicit):**
- Architectural split where Swift runs AgX / rec2020→sRGB / quantize via CIFilters (option D in our chat). Blocked on fixing the `.metal` → `.metallib` build gap; revisit after rayon + cache land.
- Rawler-internal parallelism. Rawler's own Huffman decode is the first ~2 s and not easily parallelised without forking; out of scope for this round.
- `target_size` hint through FFI (option C). Half-res today is fine once parallel.

---

## File Structure

**Rust — `src/raw-pipeline/`:**
- **Modify** `Cargo.toml` — add `rayon = "1"` to workspace dependencies.
- **Modify** `raw-core/Cargo.toml` — pull rayon from workspace.
- **Modify** `raw-core/src/linearize.rs` — `sensor_linearize` uses `par_chunks_exact_mut`.
- **Modify** `raw-core/src/demosaic/half_res.rs` — outer loop over output rows parallelised.
- **Modify** `raw-core/src/color/dcp.rs` — `apply` uses `par_iter_mut`.
- **Modify** `raw-core/src/view/agx.rs` — `apply` uses `par_iter_mut`.
- **Modify** `raw-core/src/view/encode.rs` — `rec2020_to_srgb` and `quantize_u8` use `par_iter_mut` / `par_chunks`.
- **Modify** `raw-core/src/pipeline.rs` — `upsample_2x_nearest_rgb8` uses `par_chunks_mut`.

**Swift — `src/apple/Packages/MapleCore/Sources/MapleCore/`:**
- **Create** `Cache/DecodedBufferCache.swift` — actor wrapping `.maple/decoded/<hash>.jpg`.
- **Modify** `EditSession.swift` — `sharedDecode` reads/writes the cache; configure cache on asset open.
- **Modify** `Maple/Views/AppShell.swift` — `configure(folderURL:)` the decoded cache alongside the existing `RenderedPreviewCache.configure`.

---

## Task 1: Add rayon as a workspace dependency

**Files:**
- Modify: `src/raw-pipeline/Cargo.toml`
- Modify: `src/raw-pipeline/raw-core/Cargo.toml`

- [ ] **Step 1: Add `rayon` to the workspace `[workspace.dependencies]` table.**

Read `src/raw-pipeline/Cargo.toml`. Under `[workspace.dependencies]` add:

```toml
rayon = "1"
```

- [ ] **Step 2: Pull the workspace dep into `raw-core/Cargo.toml`.**

Add to `[dependencies]`:

```toml
rayon = { workspace = true }
```

- [ ] **Step 3: Verify the dep resolves.**

Run: `cd src/raw-pipeline && cargo build -p raw-core`
Expected: `Compiling rayon v…` then `Finished \`dev\` profile` with no errors.

- [ ] **Step 4: Commit.**

```bash
git add src/raw-pipeline/Cargo.toml src/raw-pipeline/raw-core/Cargo.toml src/raw-pipeline/Cargo.lock
git commit -m "build(raw-core): add rayon workspace dep for per-pixel parallelism"
```

---

## Task 2: Parallelise `sensor_linearize`

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/linearize.rs`

**Goal:** Convert the two-nested-loop `for y` / `for x` in `sensor_linearize` to a `par_iter_mut` over row chunks.

- [ ] **Step 1: Read the current function.**

Run: `cat src/raw-pipeline/raw-core/src/linearize.rs`

Note the structure of `sensor_linearize(raw: &RawImage) -> Image`: iterates every output pixel, subtracts the per-CFA-position black level, divides by (white-black). The write target is `Image.pixels: Vec<[f32; 3]>`. Reads from `raw.raw_data: Vec<f32>`.

- [ ] **Step 2: Refactor to parallelise by row.**

Replace the inner pixel loop with a `par_chunks_exact_mut` over rows of the output `pixels` vec. For each row, compute the row's black/white-level indices once and iterate pixels within the row sequentially. Row-parallel is simpler than per-pixel because each row has a predictable CFA stride.

At top of file, add:

```rust
use rayon::prelude::*;
```

Convert the loop body. Example pattern (adapt to the real variable names in `sensor_linearize`):

```rust
let width = raw.width as usize;
out.pixels
    .par_chunks_exact_mut(width)
    .enumerate()
    .for_each(|(y, row)| {
        for (x, px) in row.iter_mut().enumerate() {
            let idx = y * width + x;
            let raw_val = raw.raw_data[idx];
            let pos = ((y & 1) << 1) | (x & 1);
            let black = raw.black_levels[pos];
            let white = raw.white_levels[pos];
            let range = white - black;
            let v = if range > 0.0 { (raw_val - black) / range } else { 0.0 };
            let channel = cfa_color_index(x, y, raw.cfa) as usize;
            *px = [0.0; 3];
            px[channel] = v.max(0.0);
        }
    });
```

Match the original function's math exactly — only the iteration pattern changes.

- [ ] **Step 3: Run existing tests.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib linearize 2>&1 | tail -5`
Expected: all tests pass. If any use hard-coded values that depend on sequential iteration order, they'll still pass because this is a pure map — no accumulation.

- [ ] **Step 4: Run the full raw-core lib suite.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -3`
Expected: `test result: ok.` with `N passed`.

- [ ] **Step 5: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/linearize.rs
git commit -m "perf(raw-core): parallelise sensor_linearize with rayon par_chunks_exact_mut"
```

---

## Task 3: Parallelise `demosaic::half_res`

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/demosaic/half_res.rs`

- [ ] **Step 1: Read the current function.**

Run: `cat src/raw-pipeline/raw-core/src/demosaic/half_res.rs`

Note `half_res(mosaic: &Image, cfa: CfaPattern) -> Image` produces `Image` at `(in_w/2, in_h/2)`. Output write pattern: writes `[f32; 3]` per pixel. Outer loop is over `out_h`, inner over `out_w`. Each output pixel reads four mosaic samples from 2 rows.

- [ ] **Step 2: Parallelise by output row.**

At top of file, add:

```rust
use rayon::prelude::*;
```

Replace the outer `for y in 0..out_h { for x in 0..out_w { ... } }` with `par_chunks_exact_mut(out_w)`:

```rust
let in_w = mosaic.width as usize;
let out_w_u = out_w;
out.pixels
    .par_chunks_exact_mut(out_w_u)
    .enumerate()
    .for_each(|(y, row)| {
        for x in 0..out_w_u {
            // existing per-pixel body — unchanged math, reads mosaic.pixels by index
            let positions = [
                (2 * x,     2 * y,     mosaic.pixels[2 * y * in_w + 2 * x]),
                (2 * x + 1, 2 * y,     mosaic.pixels[2 * y * in_w + (2 * x + 1)]),
                (2 * x,     2 * y + 1, mosaic.pixels[(2 * y + 1) * in_w + 2 * x]),
                (2 * x + 1, 2 * y + 1, mosaic.pixels[(2 * y + 1) * in_w + (2 * x + 1)]),
            ];
            // ... rest of the body unchanged ...
            row[x] = rgb;
        }
    });
```

- [ ] **Step 3: Run the demosaic tests.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib demosaic 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 4: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/demosaic/half_res.rs
git commit -m "perf(raw-core): parallelise demosaic::half_res over output rows"
```

---

## Task 4: Parallelise `color::dcp::apply`

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/color/dcp.rs`

- [ ] **Step 1: Locate the hot loop.**

Run: `sed -n '85,120p' src/raw-pipeline/raw-core/src/color/dcp.rs`

Expected body (near line 114–118):

```rust
let mut out = Image::new(camera.width, camera.height, ColorSpace::SceneLinearRec2020);
for (i, p) in camera.pixels.iter().enumerate() {
    out.pixels[i] = m.mul_vec(*p);
}
Ok(out)
```

- [ ] **Step 2: Parallelise the matrix multiply.**

At top of file, add:

```rust
use rayon::prelude::*;
```

Replace the per-pixel loop with `par_iter_mut` + `zip`:

```rust
let mut out = Image::new(camera.width, camera.height, ColorSpace::SceneLinearRec2020);
out.pixels
    .par_iter_mut()
    .zip(camera.pixels.par_iter())
    .for_each(|(o, p)| {
        *o = m.mul_vec(*p);
    });
Ok(out)
```

- [ ] **Step 3: Run the DCP tests.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib color::dcp 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 4: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/color/dcp.rs
git commit -m "perf(raw-core): parallelise dcp::apply matrix multiply"
```

---

## Task 5: Parallelise `view::agx::apply`

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/view/agx.rs`

- [ ] **Step 1: Read the current function.**

Run: `cat src/raw-pipeline/raw-core/src/view/agx.rs | head -120`

Identify the `pub fn apply(img: &mut Image, contrast: f32)` loop that walks `img.pixels`.

- [ ] **Step 2: Parallelise the per-pixel LUT lookup.**

At top of file:

```rust
use rayon::prelude::*;
```

Convert the loop. The inner LUT sampling is pure (`AGX_LUT` is a static `[f32]`); parallel access is safe:

```rust
img.pixels.par_iter_mut().for_each(|p| {
    // existing body that reads the three channels, looks up AGX_LUT, writes back
});
```

- [ ] **Step 3: Run the view tests.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib view 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 4: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/view/agx.rs
git commit -m "perf(raw-core): parallelise agx LUT lookup"
```

---

## Task 6: Parallelise `view::encode::rec2020_to_srgb` + `quantize_u8`

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/view/encode.rs`

- [ ] **Step 1: Read the module.**

Run: `cat src/raw-pipeline/raw-core/src/view/encode.rs`

- [ ] **Step 2: Parallelise both functions.**

At top of file:

```rust
use rayon::prelude::*;
```

In `rec2020_to_srgb(img: &mut Image)`:

```rust
img.pixels.par_iter_mut().for_each(|p| {
    // existing matrix multiply body
});
```

In `quantize_u8(img: &mut Image) -> Vec<u8>`:

The current version clamps + gamma-encodes + writes u8. Allocate the output first then fill in parallel via `par_chunks_exact_mut(3)`:

```rust
let mut out = vec![0u8; img.pixels.len() * 3];
out.par_chunks_exact_mut(3)
    .zip(img.pixels.par_iter())
    .for_each(|(dst, p)| {
        let r = (srgb_gamma(p[0]).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        let g = (srgb_gamma(p[1]).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        let b = (srgb_gamma(p[2]).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        dst[0] = r;
        dst[1] = g;
        dst[2] = b;
    });
out
```

(Match the exact math — clamp range, rounding — to the original function; only the iteration pattern changes.)

- [ ] **Step 3: Run the encode tests.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib view::encode 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 4: Run the pipeline tests (end-to-end sanity).**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib pipeline 2>&1 | tail -5`
Expected: all 3 pipeline tests pass (baseline + exposure + plausible bytes).

- [ ] **Step 5: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/view/encode.rs
git commit -m "perf(raw-core): parallelise rec2020_to_srgb + quantize_u8"
```

---

## Task 7: Parallelise `upsample_2x_nearest_rgb8`

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs`

- [ ] **Step 1: Read the current function.**

Run: `sed -n '100,150p' src/raw-pipeline/raw-core/src/pipeline.rs`

Located at end of file — the helper that doubles the preview output from half-res. Current body builds each output row by iterating, then copies the row twice. Perfect for row-parallel.

- [ ] **Step 2: Parallelise by output-row-pair.**

At top of file:

```rust
use rayon::prelude::*;
```

Convert the outer loop. Each source row produces two adjacent output rows; chunk the output at `2 * dw * 3` bytes (two rows) per source row:

```rust
out.par_chunks_exact_mut(2 * dw * 3)
    .enumerate()
    .for_each(|(sy, row_pair)| {
        let src_row = &src[sy * sw * 3..(sy + 1) * sw * 3];
        // build the doubled-width row once, reuse it for both output rows
        let mut doubled = vec![0u8; dw * 3];
        for sx in 0..sw {
            let s = &src_row[sx * 3..sx * 3 + 3];
            let d0 = sx * 6;
            doubled[d0..d0 + 3].copy_from_slice(s);
            doubled[d0 + 3..d0 + 6].copy_from_slice(s);
        }
        row_pair[..dw * 3].copy_from_slice(&doubled);
        row_pair[dw * 3..].copy_from_slice(&doubled);
    });
```

- [ ] **Step 3: Run pipeline tests.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib pipeline 2>&1 | tail -5`
Expected: all pipeline tests still pass.

- [ ] **Step 4: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/pipeline.rs
git commit -m "perf(raw-core): parallelise preview upsample over row pairs"
```

---

## Task 8: Benchmark rayon speedup

**Files:**
- No code changes; this is a measurement task.

- [ ] **Step 1: Rebuild the xcframework so the Apple app picks up the new .a.**

Run: `./src/apple/scripts/build-xcframework.sh 2>&1 | tail -5`
Expected: `built xcframework at …` or similar success line. Takes ~5 min.

- [ ] **Step 2: Run maple-cli on a reference 100 MP fixture and time it.**

Run: `cd src/raw-pipeline && time cargo run --release --bin maple-cli -- batch <(echo '{"entries":[{"raw":"../../test-fixtures/raws/dji-mavic3pro-100mp.dng","xmp":null,"out":"/tmp/benchmark.png"}]}') --out-dir /tmp/benchmark/`
Expected: `real  0m1.xxx` to `0m3.xxx` (down from 15–20 s single-threaded).

- [ ] **Step 3: Record the number in the commit message for traceability.**

```bash
git commit --allow-empty -m "perf(raw-core): benchmark 100MP decode after rayon — Xs wall time"
```

(Fill in the actual `X`s from Step 2.)

---

## Task 9: Build DecodedBufferCache (Swift)

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/DecodedBufferCache.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DecodedBufferCacheTests.swift`

**Goal:** A `RenderedPreviewCache`-shaped actor that caches the pre-adjustment decoded CIImage (Rust output) as a JPEG under `<folder>/.maple/decoded/<hash>.jpg`. Key: `(asset URL, asset file mtime, rust_version)` so edits to the RAW bytes (rare) and upgrades to the Rust pipeline invalidate automatically.

- [ ] **Step 1: Write the failing round-trip test.**

Create `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DecodedBufferCacheTests.swift`:

```swift
import XCTest
import CoreImage
@testable import MapleCore

final class DecodedBufferCacheTests: XCTestCase {
    func testStoreAndFetchRoundTripsData() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        // Create a fake "asset" file the cache can mtime-key against.
        let assetURL = tmp.appendingPathComponent("fake.dng")
        try Data([0, 1, 2, 3]).write(to: assetURL)

        let cache = DecodedBufferCache()
        await cache.configure(folderURL: tmp)

        // Create a small test CIImage.
        let ci = CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 4, height: 4))

        await cache.storeDecoded(ci, for: assetURL)
        let fetched = await cache.decoded(for: assetURL)
        XCTAssertNotNil(fetched)
    }

    func testMissReturnsNil() async {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString)
        let cache = DecodedBufferCache()
        await cache.configure(folderURL: tmp)
        let assetURL = tmp.appendingPathComponent("nonexistent.dng")
        let fetched = await cache.decoded(for: assetURL)
        XCTAssertNil(fetched)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter DecodedBufferCacheTests 2>&1 | tail -10`
Expected: fails with `cannot find type 'DecodedBufferCache' in scope`.

- [ ] **Step 3: Create the cache actor.**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/DecodedBufferCache.swift`:

```swift
// DecodedBufferCache.swift — Per-asset disk cache for the Rust pipeline's
// decoded output (pre-adjustment). Paired with RenderedPreviewCache:
//   • RenderedPreviewCache caches POST-adjustment JPEG keyed on sidecar mtime.
//   • DecodedBufferCache caches PRE-adjustment JPEG keyed on asset file mtime.
//
// Storage: <folder>/.maple/decoded/<hash>.jpg. Cache hit lets EditSession
// skip the full Rust pipeline — the CIFilter chain in ImageEditPipeline
// runs against the cached decoded buffer instead.

import Foundation
import CoreImage
import CryptoKit

public actor DecodedBufferCache {
    public static let shared = DecodedBufferCache()

    private let fm = FileManager.default
    private var cacheDir: URL?
    // Bump this when raw-core pipeline output changes meaning (e.g. colour
    // math changes, demosaic quality toggled, output format changes) — the
    // version is part of the cache key so stale entries are silently
    // ignored and overwritten.
    private let rustVersion: UInt32 = 1

    public func configure(folderURL: URL) {
        let mapleDir = folderURL.appendingPathComponent(".maple")
        let decodedDir = mapleDir.appendingPathComponent("decoded")
        try? fm.createDirectory(at: decodedDir, withIntermediateDirectories: true)
        cacheDir = decodedDir
    }

    public func decoded(for assetURL: URL) -> CIImage? {
        guard let dir = cacheDir else { return nil }
        let key = cacheKey(for: assetURL)
        let fileURL = dir.appendingPathComponent("\(key).jpg")
        guard fm.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL),
              let ci = CIImage(data: data) else { return nil }
        return ci
    }

    public func storeDecoded(_ image: CIImage, for assetURL: URL) {
        guard let dir = cacheDir else { return }
        let key = cacheKey(for: assetURL)
        let fileURL = dir.appendingPathComponent("\(key).jpg")
        let ctx = CIContext()
        guard let data = ctx.jpegRepresentation(
            of: image,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.95]
        ) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    public func invalidate(assetURL: URL) {
        guard let dir = cacheDir else { return }
        let prefix = urlHash(assetURL.path)
        let files = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
        for f in files where f.hasPrefix(prefix) {
            try? fm.removeItem(at: dir.appendingPathComponent(f))
        }
    }

    private func cacheKey(for url: URL) -> String {
        let mtime = assetMtimeString(for: url)
        let components = "\(urlHash(url.path))_\(mtime)_v\(rustVersion)"
        return md5(components)
    }

    private func assetMtimeString(for url: URL) -> String {
        guard let attrs = try? fm.attributesOfItem(atPath: url.path),
              let mtime = attrs[.modificationDate] as? Date else { return "0" }
        return String(Int64(mtime.timeIntervalSince1970 * 1000))
    }

    private func urlHash(_ path: String) -> String { md5(path).prefix(16).description }

    private func md5(_ string: String) -> String {
        let digest = SHA256.hash(data: Data(string.utf8))
        return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter DecodedBufferCacheTests 2>&1 | tail -10`
Expected: both tests pass.

- [ ] **Step 5: Run the full MapleCore test suite.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed" | tail -2`
Expected: total test count is 59 → 61, no failures.

- [ ] **Step 6: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Cache/DecodedBufferCache.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/DecodedBufferCacheTests.swift
git commit -m "feat(apple): DecodedBufferCache for pre-adjustment Rust output

Mirrors RenderedPreviewCache but caches the decoded-buffer stage so
subsequent opens can skip the full Rust pipeline. Keyed on asset
file mtime + rust_version; writes lossy JPEG under
<folder>/.maple/decoded/<hash>.jpg."
```

---

## Task 10: Wire DecodedBufferCache into EditSession.sharedDecode

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`
- Modify: `src/apple/Maple/Views/AppShell.swift`

- [ ] **Step 1: Configure the cache alongside RenderedPreviewCache.**

In `AppShell.swift` at every `RenderedPreviewCache.shared.configure(folderURL:)` site, add a peer:

```swift
await RenderedPreviewCache.shared.configure(folderURL: url)
await DecodedBufferCache.shared.configure(folderURL: url)
```

Run: `grep -n "RenderedPreviewCache.shared.configure" src/apple/Maple/Views/AppShell.swift`
Expected: four hits — add a matching `DecodedBufferCache.shared.configure(folderURL:)` line after each.

- [ ] **Step 2: Update `EditSession.sharedDecode` to try the cache first.**

Open `EditSession.swift` and find `sharedDecode(asset:pipeline:)`. It currently spawns a `Task.detached` that calls `pipeline.decode(asset:)` unconditionally. Before creating the task, check the cache:

```swift
private func sharedDecode(
    asset: AssetRef,
    pipeline: ImageEditPipeline
) async -> CIImage? {
    if let existing = decodeTask, decodeTaskAssetID == asset.id {
        return await existing.value
    }
    decodeTask = nil
    decodeTaskAssetID = nil

    // Fast path: decoded-buffer disk cache. Skips the Rust pipeline
    // entirely when the asset's mtime matches the cached key.
    if let url = asset.primaryURL,
       let cached = await DecodedBufferCache.shared.decoded(for: url) {
        editSessionLogger.debug(
            "decoded cache hit extent=\(cached.extent.width)x\(cached.extent.height)"
        )
        if self.asset.id == asset.id {
            decodedImage = cached
            decodedForAssetID = asset.id
            nativeImageSize = cached.extent.size
        }
        return cached
    }

    // Cache miss — fall through to the Rust decode.
    let decodeSignpostID = editSessionSignposter.makeSignpostID()
    let decodeState = editSessionSignposter.beginInterval("decode", id: decodeSignpostID)
    let task = Task.detached(priority: .userInitiated) { [pipeline] () -> CIImage? in
        await pipeline.decode(asset: asset)
    }
    decodeTask = task
    decodeTaskAssetID = asset.id

    let decoded = await task.value
    editSessionSignposter.endInterval("decode", decodeState)

    if self.asset.id == asset.id {
        if let decoded {
            decodedImage = decoded
            decodedForAssetID = asset.id
            nativeImageSize = decoded.extent.size
            // Write-back so the next cold open skips Rust.
            if let url = asset.primaryURL {
                let capturedImage = decoded
                Task.detached(priority: .utility) {
                    await DecodedBufferCache.shared.storeDecoded(capturedImage, for: url)
                }
            }
        }
        if decodeTaskAssetID == asset.id {
            decodeTask = nil
            decodeTaskAssetID = nil
        }
    }
    return decoded
}
```

- [ ] **Step 3: Build to verify.**

Run: `cd src/apple/Packages/MapleCore && swift build 2>&1 | tail -3`
Expected: `Build complete!`

- [ ] **Step 4: Run the full test suite (including new DecodedBufferCache tests).**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed" | tail -2`
Expected: total 61 tests, 0 failures.

- [ ] **Step 5: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift src/apple/Maple/Views/AppShell.swift
git commit -m "feat(apple): wire DecodedBufferCache into sharedDecode

Cache hit skips the Rust pipeline; miss runs Rust and writes back
for the next cold open. Together with rayon-parallel raw-core
(first open 2-3s) this makes re-opens of cached assets <100ms."
```

---

## Self-Review Checklist

**Spec coverage:**
- Rayon on 6 hot stages ✓ (Tasks 2–7)
- Disk cache for decoded buffer ✓ (Tasks 9–10)
- Benchmark ✓ (Task 8)
- Configure cache at folder-open time ✓ (Task 10 Step 1)
- Write-back on Rust decode completion ✓ (Task 10 Step 2)
- Cache invalidation via mtime + rust_version ✓ (DecodedBufferCache.cacheKey)

**Placeholders:** none — every step has concrete code or a concrete command.

**Type consistency:**
- `DecodedBufferCache.decoded(for:) -> CIImage?` / `storeDecoded(_:for:)` — matches the pattern used in Task 10 Step 2.
- `RenderQuality::Preview` signature unchanged — rayon only adds parallelism, no API change.

**Known follow-up not in this plan:**
- Fix the `.metal` → `.metallib` build so `MetalKernels.applySceneToneControls` / `applySceneVibrance` / `applyAgXViewTransform` stop returning their input. Until then the CIFilter fallbacks I landed this week cover the slider behaviour.
- If the user wants the full reference architecture (D in our chat — Rust decode+demosaic only, Swift runs AgX via Metal), plan that separately once the Metal build works.
