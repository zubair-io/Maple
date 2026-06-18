# Pano render-time derivatives (thumbnail + preview) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a 256 px thumbnail + 1600 px preview at pano stitch time, written to the canonical `.maple/thumbs|previews/` cache, so a merged pano's grid tile is no longer a blank ghost and its editor cold-open is instant.

**Architecture:** Rust generates both derivatives from the already-developed display buffer (no gigapixel re-decode) and writes them to `<panoDir>/.maple/{thumbs,previews}/<sha256prefix16(basename)>{,_1600}.jpg`. Swift's `ThumbnailLoader` and `EditSession` cold-open gain **asset-relative** lookups (the cache singletons are configured for the open folder, but a pano lives in a `Panoramas/` subfolder). Native only.

**Tech Stack:** Rust (`maple-pano`, `raw-ffi`; `image` 0.25 + `raw_core::jpeg` + `sha2`), Swift (`MapleCore`).

**Spec:** `docs/superpowers/specs/2026-06-17-pano-render-derivatives-design.md`
**Ticket:** #1365. **Follow-up (NOT in this plan):** #1366.

---

## File structure

**Rust:**
- Modify `src/raw-pipeline/maple-pano/src/stitch/io.rs` — add `sha256_prefix16` + `write_display_sidecars` (next to `develop_for_display`); both compile only under the ml-gated `stitch` module, where `sha2` is already a dependency.
- Modify `src/raw-pipeline/maple-pano/src/stitch/mod.rs` — re-export `write_display_sidecars`.
- Modify `src/raw-pipeline/raw-ffi/src/pano_apple.rs` — call it (non-fatal) after `write_frame_png`.

**Swift (`Packages/MapleCore`):**
- Create `Sources/MapleCore/FileProvider/MapleSidecarPaths.swift` — asset-relative `.maple/thumbs|previews` URL builders (uses the existing `MapleThumbCacheKey.sha256Prefix16`).
- Modify `Sources/MapleCore/Cache/ThumbnailLoader.swift` — asset-relative thumb fallback in the miss path.
- Modify `Sources/MapleCore/EditSession+Hydration.swift` — `readMapleSidecarPreview` + `seedFromMapleSidecarPreview`, wired into the cold-open seed sequence.
- Add tests under `Tests/MapleCoreTests/`.

**Cross-language parity:** Rust `sha256_prefix16("panorama-test.png")` and Swift `MapleThumbCacheKey.sha256Prefix16("panorama-test.png")` are both asserted equal to the frozen literal `88bab9b0d022c93c` (the actual SHA-256 prefix), so the 4th hash copy cannot drift.

---

## Task 1: Rust `sha256_prefix16` key helper + parity test

**Files:**
- Modify: `src/raw-pipeline/maple-pano/src/stitch/io.rs`

- [ ] **Step 1: Write the failing test**

Add inside the existing `#[cfg(test)] mod tests { ... }` in `io.rs` (after the `develop_for_display_tone_maps_and_encodes` test):

```rust
    #[test]
    fn sha256_prefix16_matches_frozen_cross_platform_value() {
        // MUST equal Apple's MapleThumbCacheKey.sha256Prefix16 and the API's
        // sha256Prefix16 for the same input — the .maple/ cache key contract.
        assert_eq!(sha256_prefix16("panorama-test.png"), "88bab9b0d022c93c");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/raw-pipeline && cargo test -p maple-pano --features ml,testkit sha256_prefix16 2>&1 | grep -E "error|test result|cannot find"`
Expected: FAIL — `cannot find function sha256_prefix16`.

- [ ] **Step 3: Write minimal implementation**

Add to `io.rs` (module level, e.g. just above `develop_for_display`):

```rust
/// First 8 bytes of `SHA256(name)` as lowercase hex — the canonical
/// `.maple/{thumbs,previews}/` cache-key derivation, single-sourced by
/// contract with Apple (`MapleThumbCacheKey.sha256Prefix16`), the API
/// (`src/api/src/fs/xmp.ts`), and the web (`maple-cache/sha.ts`). The Rust
/// copy is guarded by `sha256_prefix16_matches_frozen_cross_platform_value`.
pub(crate) fn sha256_prefix16(name: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(name.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/raw-pipeline && cargo test -p maple-pano --features ml,testkit sha256_prefix16 2>&1 | grep -E "test result|FAILED"`
Expected: PASS (`test result: ok. 1 passed`).

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/maple-pano/src/stitch/io.rs
git commit -m "feat(pano): add sha256_prefix16 cache-key helper (#1365)"
```

---

## Task 2: Rust `write_display_sidecars` + test

**Files:**
- Modify: `src/raw-pipeline/maple-pano/src/stitch/io.rs`

- [ ] **Step 1: Write the failing test**

Add inside `#[cfg(test)] mod tests` in `io.rs`:

```rust
    #[test]
    fn write_display_sidecars_writes_canonical_thumb_and_preview() {
        use image::GenericImageView;
        // 400x200 scene-linear mid-grey pano: thumb downsizes (long edge 256),
        // preview stays native (400 < 1600 → no upscale).
        let (w, h) = (400u32, 200u32);
        let n = (w * h) as usize;
        let pano = PlanarImage::from_planes(
            w, h,
            vec![0.18_f32; n], vec![0.18_f32; n], vec![0.18_f32; n],
            ValidityMask::new_filled(w, h, true),
        );
        let display = develop_for_display(&pano);

        let dir = std::env::temp_dir()
            .join(format!("maple_pano_sidecar_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let png_path = dir.join("panorama-test.png");

        write_display_sidecars(display, w, h, &png_path).unwrap();

        let key = sha256_prefix16("panorama-test.png");
        let thumb = dir.join(".maple/thumbs").join(format!("{key}.jpg"));
        let preview = dir.join(".maple/previews").join(format!("{key}_1600.jpg"));
        assert!(thumb.exists(), "thumb missing: {thumb:?}");
        assert!(preview.exists(), "preview missing: {preview:?}");

        let t = image::open(&thumb).unwrap();
        assert_eq!(t.dimensions().0.max(t.dimensions().1), 256, "thumb long edge");
        let p = image::open(&preview).unwrap();
        assert_eq!(p.dimensions(), (400, 200), "preview must not upscale");

        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/raw-pipeline && cargo test -p maple-pano --features ml,testkit write_display_sidecars 2>&1 | grep -E "error\[|cannot find|test result"`
Expected: FAIL — `cannot find function write_display_sidecars`.

- [ ] **Step 3: Write minimal implementation**

Add to `io.rs` (module level). Note: takes the display buffer **by value** and moves it into an `ImageBuffer` (zero-copy) so there is no gigapixel clone; resizes by borrow:

```rust
use std::path::Path;

/// Write the canonical `.maple/thumbs` + `.maple/previews` JPEG derivatives
/// for the pano at `png_path`, downscaled from the already-developed sRGB
/// display buffer (interleaved RGB16, as returned by `develop_for_display`).
///
/// Consumes `display` (moved into an `ImageBuffer` — no full-frame clone;
/// peak RSS matters on a 100MP+ pano). Non-fatal to the caller: a stitch has
/// already succeeded by the time this runs, so callers log + ignore `Err`.
pub fn write_display_sidecars(
    display: Vec<u16>,
    width: u32,
    height: u32,
    png_path: &Path,
) -> Result<(), String> {
    use image::{imageops::FilterType, DynamicImage, ImageBuffer, Rgb};

    let basename = png_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("bad pano path: {png_path:?}"))?;
    let key = sha256_prefix16(basename);

    let src = ImageBuffer::<Rgb<u16>, _>::from_raw(width, height, display)
        .ok_or_else(|| "display buffer length != width*height*3".to_string())?;

    // (subdir, filename, target long edge, JPEG quality)
    let variants = [
        ("thumbs", format!("{key}.jpg"), 256u32, 82u8),
        ("previews", format!("{key}_1600.jpg"), 1600u32, 85u8),
    ];

    for (subdir, filename, target, quality) in variants {
        let (tw, th) = fit_long_edge(width, height, target);
        let resized: ImageBuffer<Rgb<u16>, Vec<u16>> = if (tw, th) == (width, height) {
            src.clone() // only when the pano is already ≤ target (tiny) — cheap
        } else {
            image::imageops::resize(&src, tw, th, FilterType::Triangle)
        };
        let rgb8 = DynamicImage::ImageRgb16(resized).into_rgb8().into_raw();
        let jpeg = raw_core::jpeg::encode(tw, th, &rgb8, quality).map_err(|e| e.to_string())?;

        let dir = png_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(".maple")
            .join(subdir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(filename), jpeg).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Fit `(width, height)` to a max long edge, preserving aspect, never upscaling.
fn fit_long_edge(width: u32, height: u32, target: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= target {
        return (width, height);
    }
    let scale = target as f64 / long as f64;
    let w = ((width as f64 * scale).round() as u32).max(1);
    let h = ((height as f64 * scale).round() as u32).max(1);
    (w, h)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/raw-pipeline && cargo test -p maple-pano --features ml,testkit write_display_sidecars 2>&1 | grep -E "test result|FAILED|panicked"`
Expected: PASS (`test result: ok. 1 passed`).

- [ ] **Step 5: Lint + format**

Run: `cd src/raw-pipeline && cargo fmt -p maple-pano && cargo clippy -p maple-pano --features ml,testkit 2>&1 | grep -E "warning:|error:" | head`
Expected: no new warnings/errors in `io.rs`.

- [ ] **Step 6: Commit**

```bash
git add src/raw-pipeline/maple-pano/src/stitch/io.rs
git commit -m "feat(pano): write 256px thumb + 1600px preview .maple sidecars at stitch (#1365)"
```

---

## Task 3: Re-export + wire into the Apple FFI

**Files:**
- Modify: `src/raw-pipeline/maple-pano/src/stitch/mod.rs:53`
- Modify: `src/raw-pipeline/raw-ffi/src/pano_apple.rs:44,149-156`

- [ ] **Step 1: Re-export from `stitch/mod.rs`**

Change the existing re-export line (currently `pub use io::{develop_for_display, interleave_planar, quantize_to_u16};`) to:

```rust
pub use io::{develop_for_display, interleave_planar, quantize_to_u16, write_display_sidecars};
```

- [ ] **Step 2: Import in `pano_apple.rs`**

Change the import (currently `use maple_pano::stitch::{develop_for_display, stitch, StitchError, StitchOptions, StitchSuccess};`) to add `write_display_sidecars`:

```rust
use maple_pano::stitch::{
    develop_for_display, stitch, write_display_sidecars, StitchError, StitchOptions, StitchSuccess,
};
```

- [ ] **Step 3: Call it after the PNG write (non-fatal)**

In the `write_out` closure, the current tail is:

```rust
        let data = develop_for_display(img);
        // Embed EXIF from the first source frame + tag as sRGB (#1333).
        if let Err(e) = write_frame_png(out_path, img.width(), img.height(), &data, &display_meta) {
            set_last_error(format!("maple_pano_stitch: write PNG: {e}"));
            return -7;
        }
        0
```

Replace it with (move `data` into the sidecar writer after the PNG borrow completes):

```rust
        let data = develop_for_display(img);
        // Embed EXIF from the first source frame + tag as sRGB (#1333).
        if let Err(e) = write_frame_png(out_path, img.width(), img.height(), &data, &display_meta) {
            set_last_error(format!("maple_pano_stitch: write PNG: {e}"));
            return -7;
        }
        // Render-time derivatives (#1365): 256px thumb + 1600px preview into
        // <dir>/.maple/{thumbs,previews}/ so the grid tile isn't a blank ghost
        // and cold-open is instant. Non-fatal — the pano itself already wrote.
        if let Err(e) = write_display_sidecars(data, img.width(), img.height(), out_path) {
            eprintln!("maple_pano_stitch: derivative generation failed (non-fatal): {e}");
        }
        0
```

- [ ] **Step 4: Verify it compiles (host macOS, `pano` feature = maple-pano/ml)**

Run: `cd src/raw-pipeline && cargo build -p raw-ffi --features gpu,pano 2>&1 | grep -E "error|warning: unused|Compiling raw-ffi|Finished"`
Expected: compiles (`Finished`), no errors, no unused-import warning for `write_display_sidecars`.

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/maple-pano/src/stitch/mod.rs src/raw-pipeline/raw-ffi/src/pano_apple.rs
git commit -m "feat(pano): wire render-time derivatives into the Apple stitch FFI (#1365)"
```

---

## Task 4: Swift `MapleSidecarPaths` + parity/path tests

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/MapleSidecarPaths.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/MapleSidecarPathsTests.swift`

- [ ] **Step 1: Write the failing test**

Create `MapleSidecarPathsTests.swift`:

```swift
import XCTest
@testable import MapleCore

final class MapleSidecarPathsTests: XCTestCase {
    func testKeyMatchesFrozenCrossPlatformValue() {
        // MUST equal the Rust sha256_prefix16 and API/web values.
        XCTAssertEqual(MapleThumbCacheKey.sha256Prefix16("panorama-test.png"), "88bab9b0d022c93c")
    }

    func testThumbURLIsAssetRelativeCanonical() {
        let pano = URL(fileURLWithPath: "/a/b/Panoramas/panorama-test.png")
        XCTAssertEqual(
            MapleSidecarPaths.thumbURL(for: pano).path,
            "/a/b/Panoramas/.maple/thumbs/88bab9b0d022c93c.jpg"
        )
    }

    func testPreviewURLIsAssetRelativeCanonical() {
        let pano = URL(fileURLWithPath: "/a/b/Panoramas/panorama-test.png")
        XCTAssertEqual(
            MapleSidecarPaths.previewURL(for: pano).path,
            "/a/b/Panoramas/.maple/previews/88bab9b0d022c93c_1600.jpg"
        )
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/apple/Packages/MapleCore && swift test --filter MapleSidecarPathsTests 2>&1 | grep -E "error:|cannot find|Compiling|failed"`
Expected: FAIL — `cannot find 'MapleSidecarPaths' in scope`.

- [ ] **Step 3: Write minimal implementation**

Create `MapleSidecarPaths.swift`:

```swift
// MapleSidecarPaths.swift — asset-relative locations of the canonical
// `.maple/{thumbs,previews}/` derivative cache, computed from an asset's own
// directory (not a singleton's configured folder). This is what lets an
// injected pano — which lives in a `Panoramas/` subfolder while the cache
// singletons are configured for the open folder — resolve its render-time
// derivatives. Mirrors the Rust writer in
// `maple-pano/src/stitch/io.rs::write_display_sidecars` (#1365).

import Foundation

public enum MapleSidecarPaths {
    /// `<assetDir>/.maple/thumbs/<sha256prefix16(basename)>.jpg`
    public static func thumbURL(for assetURL: URL) -> URL {
        let key = MapleThumbCacheKey.sha256Prefix16(assetURL.lastPathComponent)
        return assetURL.deletingLastPathComponent()
            .appendingPathComponent(".maple/thumbs/\(key).jpg")
    }

    /// `<assetDir>/.maple/previews/<sha256prefix16(basename)>_1600.jpg`
    public static func previewURL(for assetURL: URL) -> URL {
        let key = MapleThumbCacheKey.sha256Prefix16(assetURL.lastPathComponent)
        return assetURL.deletingLastPathComponent()
            .appendingPathComponent(".maple/previews/\(key)_1600.jpg")
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/apple/Packages/MapleCore && swift test --filter MapleSidecarPathsTests 2>&1 | grep -E "Test Suite.*passed|failed|error:"`
Expected: PASS (all 3 tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/MapleSidecarPaths.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/MapleSidecarPathsTests.swift
git commit -m "feat(pano): MapleSidecarPaths asset-relative .maple URL builders (#1365)"
```

---

## Task 5: `ThumbnailLoader` asset-relative thumb fallback

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/ThumbnailLoader.swift:119-130`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/ThumbnailLoaderSidecarTests.swift`

- [ ] **Step 1: Write the failing test**

Create `ThumbnailLoaderSidecarTests.swift`:

```swift
import XCTest
@testable import MapleCore

final class ThumbnailLoaderSidecarTests: XCTestCase {
    func testLoadReturnsAssetRelativeMapleThumb() async throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("ttl-\(UUID().uuidString)")
        // Configure the singleton cache for a DIFFERENT folder (mirrors the
        // open-folder vs Panoramas/-subfolder mismatch).
        let openFolder = base.appendingPathComponent("open")
        let panoFolder = base.appendingPathComponent("open/Panoramas")
        try fm.createDirectory(at: openFolder, withIntermediateDirectories: true)
        try fm.createDirectory(at: panoFolder, withIntermediateDirectories: true)
        await ThumbnailDiskCache.shared.configure(folderURL: openFolder)

        // Write a canonical asset-relative thumb next to the pano.
        let panoURL = panoFolder.appendingPathComponent("panorama-test.png")
        try Data([1, 2, 3, 4, 5]).write(to: panoURL) // stand-in pano bytes
        let thumbURL = MapleSidecarPaths.thumbURL(for: panoURL)
        try fm.createDirectory(at: thumbURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let expected = Data([0xFF, 0xD8, 0x42, 0x99]) // arbitrary "jpeg" bytes
        try expected.write(to: thumbURL)

        let got = await ThumbnailLoader.shared.load(for: panoURL)
        XCTAssertEqual(got, expected)

        try? fm.removeItem(at: base)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/apple/Packages/MapleCore && swift test --filter ThumbnailLoaderSidecarTests 2>&1 | grep -E "failed|passed|error:"`
Expected: FAIL — `load` falls through to the embedded/RAW path (the stand-in PNG has no embedded preview and isn't a RAW) and returns `nil`, so `XCTAssertEqual(nil, expected)` fails.

- [ ] **Step 3: Write minimal implementation**

In `ThumbnailLoader.swift`, the miss-path detached task currently starts the fast path like this:

```swift
            // FAST PATH — read the embedded JPEG preview via ImageIO.
            // DNGs (and most camera RAWs) carry a ~1920 px preview; ImageIO
            // extracts + resamples it at the target size in 5-50 ms per
            // image vs 300-500 ms for a full Rust develop.
            let t0 = Date()
            if let data = Self.embeddedPreviewJPEG(at: assetURL) {
```

Insert the asset-relative `.maple/thumbs` check immediately BEFORE `let t0 = Date()`:

```swift
            // ASSET-RELATIVE .maple/thumbs — render-time derivatives written
            // next to the asset (e.g. a pano in Panoramas/) are found even when
            // the singleton cache is configured for a different (parent) folder.
            // (#1365.) The disk-cache hit at step 1 short-circuits before this,
            // so RAWs in their own folder never pay for it.
            let relThumb = MapleSidecarPaths.thumbURL(for: assetURL)
            if FileManager.default.fileExists(atPath: relThumb.path),
               let data = try? Data(contentsOf: relThumb) {
                await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
                return data
            }

            // FAST PATH — read the embedded JPEG preview via ImageIO.
            // DNGs (and most camera RAWs) carry a ~1920 px preview; ImageIO
            // extracts + resamples it at the target size in 5-50 ms per
            // image vs 300-500 ms for a full Rust develop.
            let t0 = Date()
            if let data = Self.embeddedPreviewJPEG(at: assetURL) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/apple/Packages/MapleCore && swift test --filter ThumbnailLoaderSidecarTests 2>&1 | grep -E "Test Suite.*passed|failed|error:"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Cache/ThumbnailLoader.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/ThumbnailLoaderSidecarTests.swift
git commit -m "feat(pano): ThumbnailLoader asset-relative .maple/thumbs fallback (#1365)"
```

---

## Task 6: `EditSession` cold-open preview seed

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession+Hydration.swift:221-237,386-417`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/MapleSidecarPreviewReadTests.swift`

- [ ] **Step 1: Write the failing test**

Create `MapleSidecarPreviewReadTests.swift` (tests the testable seam — reading a `CIImage` from the canonical preview path; the full renderActor seed is covered by the manual acceptance run since it mirrors the already-by-use-verified `seedFromEmbeddedPreview`):

```swift
import XCTest
import CoreImage
@testable import MapleCore

final class MapleSidecarPreviewReadTests: XCTestCase {
    func testReadMapleSidecarPreviewDecodesJPEGAtCanonicalPath() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("mspr-\(UUID().uuidString)/Panoramas")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let panoURL = dir.appendingPathComponent("panorama-test.png")

        // Encode a real 8x4 JPEG at the canonical preview path.
        let ci = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 4))
        let previewURL = MapleSidecarPaths.previewURL(for: panoURL)
        try fm.createDirectory(at: previewURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let jpeg = CIContext().jpegRepresentation(
            of: ci, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, options: [:])!
        try jpeg.write(to: previewURL)

        let decoded = EditSession.readMapleSidecarPreview(from: panoURL)
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded?.extent.width, 8)

        // Missing file → nil.
        let missing = dir.appendingPathComponent("panorama-absent.png")
        XCTAssertNil(EditSession.readMapleSidecarPreview(from: missing))

        try? fm.removeItem(at: dir.deletingLastPathComponent())
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/apple/Packages/MapleCore && swift test --filter MapleSidecarPreviewReadTests 2>&1 | grep -E "error:|cannot find|failed|passed"`
Expected: FAIL — `cannot find 'readMapleSidecarPreview'`.

- [ ] **Step 3: Add the reader + the seed function**

In `EditSession+Hydration.swift`, after the existing `readEmbeddedPreview(from:)` (around line 418) add the canonical-path reader:

```swift
    /// Read the render-time `.maple/previews/<key>_1600.jpg` baked preview for
    /// an asset and decode it to a `CIImage`. Asset-relative (resolves next to
    /// the asset, e.g. a pano in `Panoramas/`). Returns nil when absent. (#1365.)
    nonisolated static func readMapleSidecarPreview(from url: URL) -> CIImage? {
        let preview = MapleSidecarPaths.previewURL(for: url)
        guard FileManager.default.fileExists(atPath: preview.path),
              let data = try? Data(contentsOf: preview) else { return nil }
        return CIImage(data: data)
    }
```

Then add the seed function next to `seedFromEmbeddedPreview` (mirrors it exactly, swapping the reader):

```swift
    /// Returns true if the `.maple/previews` baked preview was loaded and
    /// seeded into the actor's decoded-image cache. Same atomicity contract as
    /// `seedFromEmbeddedPreview`. Primary instant cold-open path for a pano,
    /// whose 16-bit PNG has no embedded JPEG and whose full develop is slow. (#1365.)
    func seedFromMapleSidecarPreview(for asset: AssetRef) async -> Bool {
        guard let url = asset.primaryURL else { return false }
        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        let ci: CIImage? = await Task.detached(priority: .userInitiated) { () -> CIImage? in
            let accessing = scope.startAccessingSecurityScopedResource()
            defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
            return EditSession.readMapleSidecarPreview(from: url)
        }.value
        guard let ci else { return false }
        guard self.asset.id == asset.id else { return false }
        let normalized = decodedForNativeCanvas(ci, asset: asset)
        let accepted = await renderActor.seedIfUnpopulated(
            asset: asset,
            decoded: normalized,
            rawResolution: ci.extent.size
        )
        guard accepted else { return false }
        renderedPreview = ci
        return true
    }
```

> If `seedFromEmbeddedPreview`'s tail (after `guard let ci`) differs from the above in the current source, match it exactly — read lines 394-417 first and mirror the real seeding/normalization calls.

- [ ] **Step 4: Wire it into the cold-open sequence**

In `EditSession+Hydration.swift`, between the cached-preview block (ends line 226) and the embedded-preview block (starts line 228), insert:

```swift
        // .maple/previews baked preview (#1365) — instant cold-open for assets
        // with no embedded JPEG (panos). Tried after the rendered-preview cache
        // (which is the best, last-develop result) and before the embedded path.
        let sidecarHit = await mapleStageAsync("maple sidecar preview seed") {
            await self.seedFromMapleSidecarPreview(for: openedAsset)
        }
        if sidecarHit {
            self._scheduleRender(phase: .fast)
        }
```

- [ ] **Step 5: Run the reader test to verify it passes**

Run: `cd src/apple/Packages/MapleCore && swift test --filter MapleSidecarPreviewReadTests 2>&1 | grep -E "Test Suite.*passed|failed|error:"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/EditSession+Hydration.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/MapleSidecarPreviewReadTests.swift
git commit -m "feat(pano): seed cold-open from .maple/previews baked preview (#1365)"
```

---

## Task 7: Full build + test sweep

**Files:** none (verification only)

- [ ] **Step 1: Rust unit tests (the new ones, isolated by name)**

Run: `cd src/raw-pipeline && cargo test -p maple-pano --features ml,testkit sidecar 2>&1 | tail -5; cargo test -p maple-pano --features ml,testkit sha256_prefix16 2>&1 | tail -3`
Expected: both PASS.

- [ ] **Step 2: Rust FFI compiles**

Run: `cd src/raw-pipeline && cargo build -p raw-ffi --features gpu,pano 2>&1 | tail -3`
Expected: `Finished`.

- [ ] **Step 3: Swift package tests**

Run: `cd src/apple/Packages/MapleCore && swift test --filter "MapleSidecar|ThumbnailLoaderSidecar|MapleSidecarPreviewRead" 2>&1 | tail -8`
Expected: all PASS. (Per `project_uitest_needs_unlocked_screen`, `swift test` is headless — no unlocked screen needed.)

- [ ] **Step 4: Confirm no Apple build regression**

Run: `cd src/apple && xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" -destination 'platform=macOS' build 2>&1 | tail -3`
Expected: `BUILD SUCCEEDED`. (Apple is not in cloud CI — `project_apple_not_gated_by_cloud_ci`.)
> If `xcodebuild` fails with `RawPipeline.h not found` / `could not build module`, regenerate the xcframework header per `project_xcframework_rebuild_workflow`; an undefined `maple_*` symbol means the `.a` is stale → `FORCE_XCFRAMEWORK_REBUILD=1 ./src/apple/scripts/build-xcframework.sh --release`.

---

## Task 8: Manual acceptance (Apple, on-device pixels)

**Files:** none (acceptance only — Apple pano needs the ML environment + real fixtures, so this isn't a unit test).

- [ ] **Step 1:** Build + run Maple (Mac), select ≥2 overlapping source RAWs, run "Merge to panorama."
- [ ] **Step 2:** Confirm the new pano tile shows a real thumbnail (NOT a blank grey ghost) immediately after the merge completes.
- [ ] **Step 3:** Confirm `Panoramas/.maple/thumbs/<key>.jpg` and `Panoramas/.maple/previews/<key>_1600.jpg` exist on disk next to the output PNG.
- [ ] **Step 4:** Open the pano; confirm an instant fast-phase preview appears before the full develop lands (no long grey/loading gap).
- [ ] **Step 5 (optional):** Repeat on iPad per `project_ios_device_deploy_debug`.

---

## Task 9: PR

- [ ] **Step 1:** Push the branch and open a PR (ready, not draft) with `Closes #1365`, the spec/plan links, and a note that Apple isn't cloud-CI-gated so the Swift tests + macOS build were run locally (paste the results). Do NOT merge (default-branch — needs explicit user authorization).

---

## Self-review notes

- **Spec coverage:** thumbnail generation (Tasks 2-3,5), preview generation (Tasks 2-3,6), canonical `.maple/thumbs|previews` + `sha256prefix16` key (Tasks 1-2,4), asset-relative lookup for the subfolder/singleton mismatch (Tasks 5-6), Rust↔Swift key parity (Tasks 1,4), memory-safe no-clone generation (Task 2), non-fatal (Task 3), native-only (no web/API touched), #1366 deferred (not in plan). ✓
- **Types/signatures consistent:** `sha256_prefix16(&str)->String`, `write_display_sidecars(Vec<u16>,u32,u32,&Path)->Result<(),String>`, `MapleSidecarPaths.{thumbURL,previewURL}(for:)->URL`, `EditSession.readMapleSidecarPreview(from:)->CIImage?`, `seedFromMapleSidecarPreview(for:)->Bool` — used identically across tasks. ✓
- **No placeholders.** ✓
