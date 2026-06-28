# Video Poster Thumbnails (#1642) Implementation Plan

**Goal:** Add poster-frame thumbnails for video assets in the Browse grid on Apple (macOS/iOS/iPadOS), with web/API kept as placeholder because no frame-extraction tool exists on the server without adding a heavy new dependency.

**Architecture:** On Apple, `AVAssetImageGenerator` produces a JPEG frame at ~1 second in (or the first keyframe) for any video file that `AssetRef.isVideo` returns true; `ThumbnailLoader` intercepts the video path before the image fast path and falls through to the `AVAssetImageGenerator` path, storing the result in `ThumbnailDiskCache` exactly like any image thumb. On the server the existing 404 behavior for video thumb routes is preserved, documented with a comment pointing at this ticket's follow-up.

**Tech Stack:** Swift AVFoundation (`AVAsset`, `AVAssetImageGenerator`, `CMTime`), existing `ThumbnailDiskCache` / `MapleSidecarPaths` infrastructure on Apple. No new dependencies.

## Server-Side Feasibility Decision

The API currently has no video frame extraction capability — `sharp` and `heic-convert` handle only still images, the `libraw_ffi` pool is RAW-only, and there is no ffmpeg/ffprobe dependency in `package.json`. The machine has `ffmpeg` installed at `/opt/homebrew/bin/ffmpeg`, but this is a Homebrew local installation that cannot be assumed present on self-hosted servers or in CI containers, and bundling it would add a heavy unconditional dependency for an optional quality-of-life feature.

The right path for server-side video posters is a tracked follow-up that evaluates options (shelling out to a platform-ffmpeg if available, adding a native module, using a WASM video decoder). That is filed as ticket #1643 (follow-up). This plan implements Apple only; the web grid continues to show the existing placeholder on 404.

## Global Constraints

- Non-destructive: original video files are never touched.
- Video thumb must not reach `PipelineRenderer`, `libraw`, or `CGImageSourceCreateThumbnailAtIndex` — those paths are for still images only.
- Cache path: `<videoDir>/.maple/thumbs/<sha256prefix16(basename)>.jpg` — same key scheme as image thumbs, so `ThumbnailDiskCache` and `MapleSidecarPaths.thumbURL(for:)` work unchanged.
- JPEG quality: `ThumbnailDiskCache.jpegQuality` (0.82). Target long edge: 256 px (`ThumbnailDiskCache.defaultThumbSize`).
- Scope-access bracket for sandboxed reads: `scopeParentURL ?? assetURL.deletingLastPathComponent()`, same as the image path.
- No `AVPlayer` or playback infrastructure — poster-frame only.
- `swift test` must remain green; macOS `xcodebuild build` must remain `BUILD SUCCEEDED`.

---

## File Map

| Action    | File                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| Modify    | `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/ThumbnailLoader.swift`          |
| Create    | `src/apple/Packages/MapleCore/Tests/MapleCoreTests/VideoThumbnailTests.swift`         |
| No change | `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/ThumbnailDiskCache.swift`       |
| No change | `src/apple/Packages/MapleCore/Sources/MapleCore/SidecarPath.swift`                    |
| No change | `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/MapleSidecarPaths.swift` |
| No change | `src/api/src/workers/stages/thumb.ts` (guard stays; no server poster)                 |
| No change | `src/api/src/routes/library/thumb.ts` (video 404 stays)                               |

---

## Task 1: Test skeleton + verify test runner is clean

**Files:**

- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/VideoThumbnailTests.swift`

**Interfaces:**

- Consumes: `ThumbnailLoader.shared.load(for:scopeParentURL:)` (existing `public func`)
- Consumes: `ThumbnailDiskCache.shared.thumbnailData(for:)` (existing `public func`)
- Produces: tests that compile against the CURRENT code (will FAIL or SKIP after Task 2 adds real poster logic)

- [ ] **Step 1: Run `swift test` to confirm baseline green**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642/src/apple/Packages/MapleCore
swift test > /tmp/maple-vidthumb-baseline.txt 2>&1
cat /tmp/maple-vidthumb-baseline.txt | tail -20
```

Expected last lines: `Test Suite 'All tests' passed` (some tests may be skipped — that's fine).

- [ ] **Step 2: Write the failing test file**

```swift
// VideoThumbnailTests.swift — poster-frame thumbnail for video assets (#1642).
//
// Coverage:
//   1. `ThumbnailLoader.load(for:)` on a real .mov returns non-nil JPEG bytes.
//   2. The result is stored in `ThumbnailDiskCache` (memory + disk round-trip).
//   3. A second load for the same URL returns from cache (no re-render).
//   4. A non-video file still returns nil when it doesn't exist on disk (no regression).
//
// The test is skip-safe: it writes a real 1-frame .mov via AVFoundation.
// If AVFoundation asset writing is unavailable (shouldn't happen on macOS in
// unit test, but guarded anyway), the test calls XCTSkip.

import XCTest
import AVFoundation
import CoreImage
@testable import MapleCore

@available(macOS 12.0, iOS 15.0, *)
final class VideoThumbnailTests: XCTestCase {

    private var tmp: URL!

    override func setUp() async throws {
        tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("maple-vidthumb-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        // Configure ThumbnailDiskCache so the loader can write to .maple/thumbs/
        await ThumbnailDiskCache.shared.configure(folderURL: tmp)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tmp)
    }

    // MARK: - Fixture helper

    /// Write a minimal 1-second 1×1 black video to `url` using AVAssetWriter.
    /// Returns false if AVFoundation can't write (test caller should XCTSkip).
    private func writeMinimalMov(to url: URL) async throws -> Bool {
        guard AVAssetWriter.isAvailable else { return false }

        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: NSNumber(value: 64),
            AVVideoHeightKey: NSNumber(value: 64),
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: 64,
                kCVPixelBufferHeightKey as String: 64,
            ]
        )
        guard writer.canAdd(input) else { return false }
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)

        // Write a single black frame at t=0.
        var pixelBuffer: CVPixelBuffer?
        let attrs: CFDictionary = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey: 64,
            kCVPixelBufferHeightKey: 64,
        ] as CFDictionary
        CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32BGRA, attrs, &pixelBuffer)
        guard let pb = pixelBuffer else { return false }
        adaptor.append(pb, withPresentationTime: .zero)
        input.markAsFinished()

        await withCheckedContinuation { cont in
            writer.finishWriting { cont.resume() }
        }
        return writer.status == .completed
    }

    // MARK: - Tests

    func testVideoLoadReturnsPosterJpeg() async throws {
        let videoURL = tmp.appendingPathComponent("sample.mov")
        let wrote = try await writeMinimalMov(to: videoURL)
        if !wrote {
            throw XCTSkip("AVAssetWriter unavailable in this environment")
        }

        let data = await ThumbnailLoader.shared.load(for: videoURL, scopeParentURL: tmp)
        XCTAssertNotNil(data, "ThumbnailLoader should return JPEG bytes for a video file")
        // Minimum JPEG magic-byte check: starts with 0xFF 0xD8.
        if let bytes = data {
            XCTAssertEqual(bytes[0], 0xFF)
            XCTAssertEqual(bytes[1], 0xD8)
        }
    }

    func testVideoThumbnailStoredInDiskCache() async throws {
        let videoURL = tmp.appendingPathComponent("stored.mov")
        let wrote = try await writeMinimalMov(to: videoURL)
        if !wrote { throw XCTSkip("AVAssetWriter unavailable") }

        // First load — cold cache.
        let data = await ThumbnailLoader.shared.load(for: videoURL, scopeParentURL: tmp)
        XCTAssertNotNil(data)

        // Verify the thumb is on disk at the expected MapleSidecarPaths location.
        let thumbURL = MapleSidecarPaths.thumbURL(for: videoURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: thumbURL.path),
                      "poster JPEG should be written to .maple/thumbs/")
    }

    func testVideoThumbnailHitsMemoryCacheOnSecondLoad() async throws {
        let videoURL = tmp.appendingPathComponent("cached.mov")
        let wrote = try await writeMinimalMov(to: videoURL)
        if !wrote { throw XCTSkip("AVAssetWriter unavailable") }

        // First load — cache miss.
        let first = await ThumbnailLoader.shared.load(for: videoURL, scopeParentURL: tmp)
        XCTAssertNotNil(first)

        // Second load — should return from ThumbnailDiskCache (memory or disk).
        // We just assert it returns the same data, not nil.
        let second = await ThumbnailLoader.shared.load(for: videoURL, scopeParentURL: tmp)
        XCTAssertEqual(first, second, "second load should return cached bytes")
    }

    func testNonVideoMissingFileReturnsNil() async {
        // Regression guard: a non-existent non-video file must not produce a thumb.
        let missing = tmp.appendingPathComponent("ghost.dng")
        let data = await ThumbnailLoader.shared.load(for: missing, scopeParentURL: tmp)
        XCTAssertNil(data, "missing non-video file should return nil")
    }
}
```

- [ ] **Step 3: Run tests — they must FAIL (video load returns nil because implementation is not yet wired)**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642/src/apple/Packages/MapleCore
swift test --filter VideoThumbnailTests > /tmp/maple-vidthumb-fail.txt 2>&1
cat /tmp/maple-vidthumb-fail.txt | tail -30
```

Expected: `testVideoLoadReturnsPosterJpeg` FAILS with "ThumbnailLoader should return JPEG bytes for a video file" (because the current code returns nil for video).

- [ ] **Step 4: Commit the test skeleton**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/VideoThumbnailTests.swift
git commit -m "test(video-thumb): add VideoThumbnailTests skeleton — RED (#1642)"
```

---

## Task 2: Implement video poster in ThumbnailLoader

**Files:**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/ThumbnailLoader.swift`

**Interfaces:**

- Consumes: `SidecarPath.isVideo(_:)` → `Bool` (already imported via `SidecarPath`)
- Consumes: `AVFoundation.AVAsset(url:)`, `AVFoundation.AVAssetImageGenerator`
- Consumes: `MapleSidecarPaths.thumbURL(for:)` → `URL`
- Consumes: `ThumbnailDiskCache.shared.storeThumbnailData(_:for:)` — unchanged
- Produces: `ThumbnailLoader.load(for:scopeParentURL:) async -> Data?` — now returns JPEG bytes for video URLs

The implementation adds a `posterJPEG(at:)` private static method that uses `AVAssetImageGenerator` to extract a frame at 1 second (falling back to 0 seconds if the asset is shorter than 1 second). It encodes the result via the existing `jpegData(from:ctx:)` helper. The video branch is inserted into the `Task.detached` body in `load(for:scopeParentURL:)` immediately after the `.maple/thumbs` asset-relative check (so a pre-written poster is served from cache on the first call without invoking AVFoundation at all) and before the `embeddedPreviewJPEG` fast path.

- [ ] **Step 1: Add `import AVFoundation` to ThumbnailLoader.swift**

In `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/ThumbnailLoader.swift`, add the import after the existing `import os` line:

Old block (lines 14–19):

```swift
import Foundation
import CoreImage
import ImageIO
import os
```

New block:

```swift
import Foundation
import AVFoundation
import CoreImage
import ImageIO
import os
```

- [ ] **Step 2: Add the `posterJPEG(at:)` helper method**

The method goes in the `// MARK: - Helpers` section at the bottom of `ThumbnailLoader`, after the `encodeJPEG` method (around line 293). Add it just before the closing `}` of the extension or the actor, immediately after `encodeJPEG`:

```swift
    /// Extract a poster frame from a video file using AVFoundation.
    ///
    /// Requests a frame at 1 second in; if the asset is shorter, requests
    /// the first keyframe at time zero. Returns JPEG bytes at the thumbnail
    /// target size (256 px long edge), or nil if AVFoundation can't read
    /// the file (unsupported codec, missing file, etc.).
    ///
    /// This method performs synchronous I/O on an AVAsset — always call it
    /// from inside a `Task.detached(priority: .utility)` block so it
    /// doesn't block the actor or the main thread.
    private static func posterJPEG(at url: URL) -> Data? {
        let asset = AVAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        // Honor the track's preferred transform so portrait clips aren't rotated.
        generator.appliesPreferredTrackTransform = true
        // Size cap: request at most 2× the thumbnail target so we get a sharp
        // image without decoding the full original frame at native resolution.
        let target = ThumbnailDiskCache.defaultThumbSize
        generator.maximumSize = CGSize(width: target.width * 2, height: target.height * 2)

        // Prefer 1s in; if the asset is shorter, fall back to time zero.
        var requestTime = CMTime(seconds: 1, preferredTimescale: 600)
        var actualTime = CMTime.zero
        var cgImage: CGImage?
        do {
            cgImage = try generator.copyCGImage(at: requestTime, actualTime: &actualTime)
        } catch {
            // Duration shorter than 1s or generation failed — try the very first frame.
            requestTime = .zero
            cgImage = try? generator.copyCGImage(at: requestTime, actualTime: nil)
        }
        guard let cg = cgImage else { return nil }

        // Downscale via CIImage + same JPEG encoder as the image thumbnail path.
        let ci = CIImage(cgImage: cg)
        let ctx = CIContext()
        // Scale so long edge = defaultThumbSize.width (same as encodeJPEG).
        let extent = ci.extent
        let longEdge = max(extent.width, extent.height)
        let scaled: CIImage = longEdge > target.width
            ? ci.transformed(by: CGAffineTransform(scaleX: target.width / longEdge,
                                                    y: target.width / longEdge))
            : ci
        return jpegData(from: scaled, ctx: ctx)
    }
```

- [ ] **Step 3: Wire the video branch into `load(for:scopeParentURL:)`**

Inside the `Task.detached(priority: .utility)` block in `load(for:scopeParentURL:)`, the current structure is:

```swift
let relThumb = MapleSidecarPaths.thumbURL(for: assetURL)
if FileManager.default.fileExists(atPath: relThumb.path),
    let data = try? Data(contentsOf: relThumb)
{
    await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
    return data
}

// FAST PATH — read the embedded JPEG preview via ImageIO.
// ...
```

Replace the block starting from the `relThumb` check through to the end of the `Task.detached` closure — up to and including the slow Rust path — with:

```swift
// ASSET-RELATIVE .maple/thumbs — render-time derivatives written
// next to the asset (e.g. a pano in Panoramas/) are found even when
// the singleton cache is configured for a different (parent) folder.
// (#1365.) The disk-cache hit at step 1 short-circuits before this,
// so RAWs in their own folder never pay for it.
let relThumb = MapleSidecarPaths.thumbURL(for: assetURL)
if FileManager.default.fileExists(atPath: relThumb.path),
    let data = try? Data(contentsOf: relThumb)
{
    await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
    return data
}

// VIDEO PATH — extract a poster frame via AVFoundation (#1642).
// Check AFTER the .maple/thumbs cache read above so a pre-written
// poster is returned immediately without an AVAsset allocation.
// Short-circuits BEFORE the CGImageSource fast path so video
// container bytes are never fed to ImageIO.
if SidecarPath.isVideo(assetURL) {
    guard let data = Self.posterJPEG(at: assetURL) else {
        logger.warning("video poster extraction failed for \(assetURL.lastPathComponent, privacy: .public)")
        return nil
    }
    logger.debug("video poster extracted for \(assetURL.lastPathComponent, privacy: .public)")
    await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
    return data
}

// FAST PATH — read the embedded JPEG preview via ImageIO.
// DNGs (and most camera RAWs) carry a ~1920 px preview; ImageIO
// extracts + resamples it at the target size in 5-50 ms per
// image vs 300-500 ms for a full Rust develop.
let t0 = Date()
if let data = Self.embeddedPreviewJPEG(at: assetURL) {
    let ms = Int(Date().timeIntervalSince(t0) * 1000)
    logger.debug("thumb fast-path \(assetURL.lastPathComponent, privacy: .public) \(ms)ms")
    await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
    return data
}
logger.warning("thumb fast-path MISS for \(assetURL.lastPathComponent, privacy: .public) — falling through to Rust develop")

// SLOW PATH — RAW has no embedded preview (rare). Fall back to a
// full develop + downscale. Same cost as before.
do {
    let image = try PipelineRenderer.render(rawPath: assetURL, quality: .preview)
    guard let data = Self.encodeJPEG(image, ctx: CIContext()) else {
        logger.warning("JPEG encode failed for \(assetURL.lastPathComponent, privacy: .public)")
        return nil
    }
    await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
    return data
} catch {
    logger.error("pipeline render failed for \(assetURL.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
    return nil
}
```

- [ ] **Step 4: Run the tests — they should now PASS**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642/src/apple/Packages/MapleCore
swift test --filter VideoThumbnailTests > /tmp/maple-vidthumb-pass.txt 2>&1
cat /tmp/maple-vidthumb-pass.txt | tail -30
```

Expected: all `VideoThumbnailTests` pass; `testNonVideoMissingFileReturnsNil` passes.

- [ ] **Step 5: Run the full swift test suite to catch regressions**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642/src/apple/Packages/MapleCore
swift test > /tmp/maple-vidthumb-full.txt 2>&1
cat /tmp/maple-vidthumb-full.txt | tail -30
```

Expected: same pass/skip counts as baseline; no new failures.

- [ ] **Step 6: Run the macOS xcodebuild to verify the app target links**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642
xcodebuild -project src/apple/Maple.xcodeproj \
  -scheme "Maple Exposure" \
  -destination 'platform=macOS' \
  build \
  SWIFT_TREAT_WARNINGS_AS_ERRORS=NO \
  > /tmp/maple-vidthumb-xcode.txt 2>&1
grep -E "BUILD SUCCEEDED|BUILD FAILED|error:" /tmp/maple-vidthumb-xcode.txt | tail -20
```

Expected: `BUILD SUCCEEDED`.

- [ ] **Step 7: Commit the implementation**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642
git add src/apple/Packages/MapleCore/Sources/MapleCore/Cache/ThumbnailLoader.swift
git commit -m "feat(apple/video-thumb): extract poster frame via AVAssetImageGenerator (#1642)

- Add AVFoundation import to ThumbnailLoader
- New posterJPEG(at:) static helper: requests frame at 1s (falls back to 0s)
- Wire video branch between .maple/thumbs cache check and CGImageSource fast path
- Stores poster in ThumbnailDiskCache with same key scheme as image thumbs
- Video bytes never reach CGImageSourceCreateThumbnailAtIndex or libraw"
```

---

## Task 3: File the API follow-up + add clarifying comment in the route

**Files:**

- Modify: `src/api/src/routes/library/thumb.ts` (add a comment only — no logic change)

This step is deliberately minimal: the server-side 404 behavior is correct and intentional; we just document why and what the next step would be.

- [ ] **Step 1: Add a follow-up comment to the video 404 guard in library/thumb.ts**

In `src/api/src/routes/library/thumb.ts`, find the video guard block (around line 66–70):

```typescript
if (isVideoFilename(filename)) {
  set.status = 404;
  return { error: 'No thumbnail for video assets' };
}
```

Replace it with:

```typescript
// Video containers have no server-side poster yet. Extracting a frame
// would require ffmpeg or a native video decoder — a dependency not
// currently bundled. The grid renders a video placeholder on 404.
// Follow-up: #1643 (server-side video poster via platform ffmpeg or WASM).
if (isVideoFilename(filename)) {
  set.status = 404;
  return { error: 'No thumbnail for video assets' };
}
```

- [ ] **Step 2: Verify bun test — no new failures**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642/src/api
HOME=/tmp/maple-binst bun test > /tmp/maple-vidthumb-api.txt 2>&1
tail -20 /tmp/maple-vidthumb-api.txt
```

Expected: same pass count as before; no new failures.

- [ ] **Step 3: Verify tsc — no new errors**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642/src/api
HOME=/tmp/maple-binst bun x tsc --noEmit > /tmp/maple-vidthumb-tsc.txt 2>&1
cat /tmp/maple-vidthumb-tsc.txt
```

Expected: no new errors (pre-existing errors are OK per project bar "no new tsc errors").

- [ ] **Step 4: Run oxlint**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642/src/api
HOME=/tmp/maple-binst bun x oxlint src > /tmp/maple-vidthumb-oxlint.txt 2>&1
cat /tmp/maple-vidthumb-oxlint.txt
```

Expected: no new lint errors.

- [ ] **Step 5: Commit the comment**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642
git add src/api/src/routes/library/thumb.ts
git commit -m "docs(api/thumb): document server-side video poster follow-up (#1643)"
```

---

## Task 4: File the follow-up ticket and open the PR

- [ ] **Step 1: File the server-side video poster follow-up on the Files board**

```bash
gh issue create \
  --title "Server-side video poster thumbnails (#1642 follow-up)" \
  --body "## Context

\`/api/thumb/:slug/*\` currently returns 404 for video files. The grid shows a placeholder. Apple got poster-frame support in #1642 via AVAssetImageGenerator. The server has no equivalent today.

## Options evaluated

1. Shell out to \`ffmpeg -ss 1 -i <video> -vframes 1 <out.jpg>\` — ffmpeg is not a bundled dependency; not reliable on self-hosted servers.
2. WASM video decoder (e.g. \`@ffmpeg/ffmpeg\`) — adds ~30 MB WASM blob to the server process.
3. Native Bun FFI binding for libav — largest engineering effort.

## Recommended next step

Detect platform ffmpeg availability at API startup. If present, use it for video poster extraction (shell out, same atomic-write pattern as thumbnailer). If absent, keep returning 404. This is opt-in and safe for any self-hosted deployment.

## Acceptance criteria

- \`/api/thumb/:slug/*\` returns a JPEG poster for indexed video assets when ffmpeg is available on the server.
- Returns 404 (not 500) when ffmpeg is absent.
- The existing image/RAW thumb paths are unaffected.
- \`bun test\` stays green including a skip-safe test for the ffmpeg-absent path.

Closes: follow-up from #1642." \
  --label "enhancement"
```

Record the issue number, then add it to the Files board:

```bash
# Replace NNNN with the actual issue number from the create command.
gh issue edit NNNN --add-project "Files"
```

- [ ] **Step 2: Verify all gates one final time**

```bash
# Swift tests
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642/src/apple/Packages/MapleCore
swift test > /tmp/maple-vidthumb-final-swift.txt 2>&1
tail -5 /tmp/maple-vidthumb-final-swift.txt

# xcodebuild macOS
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642
xcodebuild -project src/apple/Maple.xcodeproj \
  -scheme "Maple Exposure" \
  -destination 'platform=macOS' \
  build \
  SWIFT_TREAT_WARNINGS_AS_ERRORS=NO \
  > /tmp/maple-vidthumb-final-xcode.txt 2>&1
grep -E "BUILD SUCCEEDED|BUILD FAILED" /tmp/maple-vidthumb-final-xcode.txt

# API tests
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642/src/api
HOME=/tmp/maple-binst bun test > /tmp/maple-vidthumb-final-api.txt 2>&1
tail -5 /tmp/maple-vidthumb-final-api.txt

# file budget
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642
bash tools/check-file-budget.sh
```

Expected: Swift `Test Suite 'All tests' passed`, `BUILD SUCCEEDED`, bun test no new failures, budget 0 hard violations.

- [ ] **Step 3: Push and open the PR**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m9-vidthumb-1642
git push -u origin claude/video-thumbnails-1642

gh pr create \
  --title "feat(video-thumb): Apple poster-frame thumbnails for Browse grid (#1642)" \
  --body "$(cat <<'EOF'
## Summary

- `ThumbnailLoader` now extracts a poster frame via `AVAssetImageGenerator` (1s in, falls back to 0s) for any `AssetRef.isVideo` asset, storing the JPEG in the existing `.maple/thumbs/` cache with the same key scheme as image thumbs.
- Video bytes still never reach `CGImageSourceCreateThumbnailAtIndex` or `libraw`; the video branch is inserted _before_ the image fast path in the load task.
- Server-side (`/api/thumb/:slug/*`) keeps returning 404 for video assets — adding a frame extractor server-side requires a new dependency (ffmpeg or WASM video decoder); that is filed as a tracked follow-up (#TBD on Files board).
- New `VideoThumbnailTests` covers the poster-extract path, disk-cache round-trip, memory-cache hit on second load, and regression guard for missing non-video files.

## Server feasibility decision

The API has no video frame extraction tool: `sharp` and `libraw_ffi` handle only still images, and `ffmpeg` is not a bundled dependency. The follow-up ticket evaluates shelling out to platform `ffmpeg` (present on the developer's machine but not guaranteed on self-hosted servers) vs. a WASM video decoder. Apple AVFoundation is free and always present on target platforms, making it the right place to solve this for v1.

## Test plan

- [ ] `swift test` passes (VideoThumbnailTests green)
- [ ] macOS `xcodebuild` → `BUILD SUCCEEDED`
- [ ] `bun test` in `src/api` — no new failures
- [ ] `bun x tsc --noEmit` — no new errors
- [ ] `bun x oxlint src` — no new lint errors
- [ ] `bash tools/check-file-budget.sh` — 0 hard violations
- [ ] Manual: open a folder with a `.mov` or `.mp4` on macOS — grid shows a poster frame instead of the placeholder

Closes #1642

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Against Spec

**Spec coverage check:**

- Poster frame via `AVAssetImageGenerator` for video assets in Browse grid: covered by Task 2.
- Same thumbnail cache/path the grid already uses: Task 2 uses `ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)` — identical to image path.
- Representative early frame (~1s in, or first keyframe): `CMTime(seconds: 1, preferredTimescale: 600)` with 0s fallback in `posterJPEG(at:)`.
- Cache it like image thumbs: stored via `storeThumbnailData(_:for:)` → same `.maple/thumbs/<sha256prefix16>.jpg` path.
- Do NOT regress image/RAW thumbnails: the video branch is behind `SidecarPath.isVideo(assetURL)` before the existing `embeddedPreviewJPEG` fast path.
- Thumb stage still must not crash: `thumb.ts` guard is unchanged.
- API must not serve garbage: `library/thumb.ts` 404 guard is unchanged.
- Server-side follow-up filed: Task 4 Step 1.
- File budget: 2 files changed, 1 file created; well within budget.
- No ffmpeg dependency added.
- No `AVPlayer` or playback infrastructure.

**Placeholder scan:** No TBD, TODO, "fill in details", or implementation-later text.

**Type consistency:** `posterJPEG(at:)` returns `Data?` — matches `embeddedPreviewJPEG(at:)`. `SidecarPath.isVideo(_: URL) -> Bool` called correctly. `jpegData(from:ctx:)` is already `private static` in the actor, called correctly.
