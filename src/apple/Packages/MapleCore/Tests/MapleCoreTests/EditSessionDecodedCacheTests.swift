// EditSessionDecodedCacheTests.swift — invariants for the decoded-image
// cache rework.
//
// EditSession caches the Rust scene-linear FFI's full-native output as
// the actor's `decodedImage` so subsequent slider/zoom/pan calls reuse
// it instead of re-crossing the FFI per tick. The load-bearing invariants:
//
//   1. Same asset twice → second open hits the cache (fresh check
//      returns true; the cold-path `sharedDecode` short-circuits).
//   2. A change to a BAKED (KEPT) field — `highlightRecovery`,
//      `captureSharpeningAmount/Sigma`, the unsharp radius/detail/masking
//      — invalidates the cache (fresh check returns false). Those bake
//      into the decoded buffer, so editing one demands a fresh decode.
//   3. (#950) A change to a STRIPPED field — exposure, nrColor,
//      sharpenAmount, WB, … — does NOT invalidate the cache. Those are
//      stripped before decode and re-applied LIVE per tick
//      (`maple_apply_scene_linear_chain`), so the decoded buffer is
//      unchanged. The old freshness key was sidecar MTIME, which the
//      750 ms-debounced autosave bumps on *every* save (including saves of
//      stripped fields), forcing a spurious ~15 s re-decode on the first
//      edit after a drag pause. #950 re-keys on the *baked* model (the
//      `stripAppleGPUStages` of the sidecar model) so only invariant-2
//      edits invalidate.
//
// These tests exercise the freshness state machine directly. The
// fixture-gated companion test `testColdOpenSecondRenderUsesCachedDecode`
// runs the full Rust decode once on a real RAW and verifies the second
// render lands in <1.5 s — proof that the FFI was not re-entered.
//
// Slice 2 of issue #194: the cache fields moved off EditSession onto
// `RenderActor`. The test surface is `session.renderActor.…` instead of
// `session.…`.

import CoreImage
import XCTest

@testable import MapleCore

@MainActor
final class EditSessionDecodedCacheTests: XCTestCase {

  // MARK: - Helpers

  /// Synthesise a temp `.dng` so `AssetRef(url:)` has a real file
  /// path to key against. Bytes don't matter for the freshness tests
  /// — they never invoke the Rust FFI; the cache fields are seeded
  /// directly via the actor's `_testSeedDecodedCache` hook.
  private func makeAsset() throws -> (asset: AssetRef, dir: URL) {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("decoded-cache.dng")
    try Data([0x44, 0x4E, 0x47]).write(to: url)
    return (AssetRef(url: url), dir)
  }

  private func makeDecoded(_ size: CGSize = CGSize(width: 100, height: 100)) -> CIImage {
    CIImage(color: .gray)
      .cropped(to: CGRect(x: 0, y: 0, width: size.width, height: size.height))
  }

  private func writeSidecar(at url: URL, content: String = "<x:xmpmeta/>") throws -> Date {
    try content.write(to: url, atomically: true, encoding: .utf8)
    let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
    return (attrs[.modificationDate] as? Date) ?? Date()
  }

  /// Write a real XMP sidecar serialised from `model` so the freshness
  /// key (`RenderActor.bakedModel(for:)` → `stripAppleGPUStages(parse)`)
  /// sees the exact baked-vs-stripped field values under test (#950).
  @discardableResult
  private func writeSidecar(at url: URL, model: AdjustmentModel) throws -> Date {
    let xml = XMPSerializer.serialize(model: model, culling: CullingState())
    return try writeSidecar(at: url, content: xml)
  }

  // MARK: - Tests

  /// A freshly-seeded cache (no sidecar on disk) is fresh — the
  /// freshness check sees `decodedBakedModel == nil` and the live baked
  /// model is also `nil` (no sidecar on disk), so they match (#950).
  func testFreshlySeededCacheIsFreshWhenNoSidecarPresent() async throws {
    let (asset, dir) = try makeAsset()
    defer { try? FileManager.default.removeItem(at: dir) }

    let session = EditSession(asset: asset)
    await session.renderActor._testSeedDecodedCache(
      asset: asset,
      decoded: makeDecoded(),
      rawResolution: CGSize(width: 100, height: 100)
    )

    let populated = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
    XCTAssertTrue(populated)
    let fresh = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertTrue(
      fresh,
      "cache with no sidecar at decode and no sidecar live should be fresh")
  }

  /// A freshly-seeded cache (sidecar on disk, baked model captured) is
  /// fresh while the sidecar's baked fields are unchanged (#950).
  func testFreshlySeededCacheIsFreshWhenBakedModelMatches() async throws {
    let (asset, dir) = try makeAsset()
    defer { try? FileManager.default.removeItem(at: dir) }

    guard let sidecarURL = asset.sidecarURL else {
      return XCTFail("file-backed asset must have a sidecar URL")
    }
    _ = try writeSidecar(at: sidecarURL)

    let session = EditSession(asset: asset)
    await session.renderActor._testSeedDecodedCache(
      asset: asset,
      decoded: makeDecoded(),
      rawResolution: CGSize(width: 100, height: 100)
    )

    let fresh = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertTrue(
      fresh,
      "cache baked model equal to live sidecar baked model should be fresh")
  }

  // MARK: - #950: baked vs stripped field freshness

  /// THE WIN (#950): editing a STRIPPED field (exposure / nrColor /
  /// sharpenAmount / WB) rewrites the sidecar — bumping its mtime — but
  /// does NOT change the decoded buffer (those stages are stripped before
  /// decode and re-applied live per tick). So the in-memory decode cache
  /// must stay FRESH. Under the old sidecar-mtime key this returned stale
  /// and forced a spurious ~15 s re-decode on the first edit after a
  /// drag pause; the baked-model key fixes it.
  func testStrippedFieldEditKeepsCacheFresh() async throws {
    let (asset, dir) = try makeAsset()
    defer { try? FileManager.default.removeItem(at: dir) }
    guard let sidecarURL = asset.sidecarURL else {
      return XCTFail("file-backed asset must have a sidecar URL")
    }

    // Decode-time sidecar: a non-default STRIPPED field already set.
    try writeSidecar(
      at: sidecarURL,
      model: {
        var m = AdjustmentModel()
        m.exposure = 0.4
        return m
      }())
    let session = EditSession(asset: asset)
    await session.renderActor._testSeedDecodedCache(
      asset: asset,
      decoded: makeDecoded(),
      rawResolution: CGSize(width: 100, height: 100)
    )
    let freshBefore = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertTrue(
      freshBefore,
      "precondition: cache fresh before the stripped-field edit")

    // The autosave lands a DIFFERENT stripped-field value (the slider
    // moved). Under the baked-model key the mtime change is irrelevant;
    // no sleep needed (#950 — the cache key is the baked model, not mtime).
    try writeSidecar(
      at: sidecarURL,
      model: {
        var m = AdjustmentModel()
        m.exposure = 1.9  // exposure  — stripped
        m.nrColor = 80  // nrColor   — stripped
        m.saturation = -30  // saturation — stripped
        m.temperature = 5200  // WB        — stripped
        return m
      }())

    let freshAfter = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertTrue(
      freshAfter,
      "a stripped-field edit must NOT invalidate the decode cache (#950) — "
        + "the buffer is unchanged; the stages are re-applied live per tick")
  }

  /// The other half of #950: editing a BAKED (KEPT) field DOES change
  /// the decoded buffer (those stages run inside the decode and have no
  /// live Apple-GPU equivalent), so the cache must go STALE and force a
  /// re-decode. This is the bug we must NOT introduce by dropping mtime.
  func testKeptFieldEditInvalidatesCache() async throws {
    let (asset, dir) = try makeAsset()
    defer { try? FileManager.default.removeItem(at: dir) }
    guard let sidecarURL = asset.sidecarURL else {
      return XCTFail("file-backed asset must have a sidecar URL")
    }

    try writeSidecar(at: sidecarURL, model: AdjustmentModel())
    let session = EditSession(asset: asset)
    await session.renderActor._testSeedDecodedCache(
      asset: asset,
      decoded: makeDecoded(),
      rawResolution: CGSize(width: 100, height: 100)
    )
    let freshBefore = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertTrue(
      freshBefore,
      "precondition: cache fresh before the kept-field edit")

    // highlightRecovery is a KEPT field (pre-DCP, no chain equivalent).
    // No sleep needed — freshness is keyed on the baked model, not mtime (#950).
    try writeSidecar(
      at: sidecarURL,
      model: {
        var m = AdjustmentModel()
        m.highlightRecovery = .blend
        return m
      }())
    let staleAfterHR = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertFalse(
      staleAfterHR,
      "editing highlightRecovery (a baked/KEPT field) must invalidate the "
        + "decode cache — it bakes into the buffer (#950)")

    // captureSharpeningAmount is the other classic KEPT field (runs in
    // the Rust develop, post-DCP). Re-seed, then flip it.
    // No sleep needed — freshness is keyed on the baked model, not mtime (#950).
    await session.renderActor._testSeedDecodedCache(
      asset: asset,
      decoded: makeDecoded(),
      rawResolution: CGSize(width: 100, height: 100))
    try writeSidecar(
      at: sidecarURL,
      model: {
        var m = AdjustmentModel()
        m.highlightRecovery = .blend
        m.captureSharpeningAmount = 50
        return m
      }())
    let staleAfterCS = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertFalse(
      staleAfterCS,
      "editing captureSharpeningAmount (a baked/KEPT field) must invalidate "
        + "the decode cache (#950)")
  }

  /// Belt-and-braces on the strip contract: a KEPT *detail* field
  /// (`sharpenRadius`) invalidates while its STRIPPED sibling
  /// (`sharpenAmount`) does not — the two live on the same tool but split
  /// across the strip boundary (`RawCoreBridge` header).
  func testSharpenRadiusKeptButAmountStripped() async throws {
    let (asset, dir) = try makeAsset()
    defer { try? FileManager.default.removeItem(at: dir) }
    guard let sidecarURL = asset.sidecarURL else {
      return XCTFail("file-backed asset must have a sidecar URL")
    }

    try writeSidecar(at: sidecarURL, model: AdjustmentModel())
    let session = EditSession(asset: asset)
    await session.renderActor._testSeedDecodedCache(
      asset: asset, decoded: makeDecoded(),
      rawResolution: CGSize(width: 100, height: 100))

    // sharpenAmount (stripped) → still fresh.
    // No sleep needed — freshness is keyed on the baked model, not mtime (#950).
    try writeSidecar(
      at: sidecarURL,
      model: {
        var m = AdjustmentModel()
        m.sharpenAmount = 120
        return m
      }())
    let freshAfterAmount = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertTrue(
      freshAfterAmount,
      "sharpenAmount is stripped → no invalidation (#950)")

    // sharpenRadius (kept) → stale. Re-seed against the current sidecar
    // first so we isolate the radius change.
    await session.renderActor._testSeedDecodedCache(
      asset: asset, decoded: makeDecoded(),
      rawResolution: CGSize(width: 100, height: 100))
    try writeSidecar(
      at: sidecarURL,
      model: {
        var m = AdjustmentModel()
        m.sharpenAmount = 120
        m.sharpenRadius = 2.5
        return m
      }())
    let staleAfterRadius = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertFalse(
      staleAfterRadius,
      "sharpenRadius is KEPT → must invalidate (#950)")
  }

  /// `profile` must be normalised OUT of the baked-model freshness key:
  /// a sidecar edit that changes ONLY the profile must keep the in-memory
  /// decode cache FRESH (#950). Profile freshness is owned separately by
  /// `decodedProfile` / `profileMatches` (#871); the decode's profile
  /// comes from the live override, not the sidecar, and the autosave is
  /// debounced — so if the sidecar profile were in the key, a profile
  /// toggle would force a wasteful re-decode ~750 ms later (when the save
  /// lands) even though the #871 path already produced the right buffer.
  func testProfileOnlySidecarChangeKeepsCacheFresh() async throws {
    let (asset, dir) = try makeAsset()
    defer { try? FileManager.default.removeItem(at: dir) }
    guard let sidecarURL = asset.sidecarURL else {
      return XCTFail("file-backed asset must have a sidecar URL")
    }

    // Decode-time sidecar: explicit Neutral profile.
    try writeSidecar(
      at: sidecarURL,
      model: {
        var m = AdjustmentModel()
        m.profile = .neutral
        return m
      }())
    let session = EditSession(asset: asset)
    await session.renderActor._testSeedDecodedCache(
      asset: asset, decoded: makeDecoded(),
      rawResolution: CGSize(width: 100, height: 100))
    let freshBefore = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertTrue(freshBefore, "precondition: cache fresh before the profile flip")

    // The debounced autosave lands the toggled profile (Neutral → Auto)
    // and NOTHING else. The baked-model key must ignore it.
    // No sleep needed — freshness is keyed on the baked model, not mtime (#950).
    try writeSidecar(
      at: sidecarURL,
      model: {
        var m = AdjustmentModel()
        m.profile = .auto
        return m
      }())
    let freshAfter = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertTrue(
      freshAfter,
      "a profile-only sidecar change must NOT invalidate the decode cache "
        + "(#950 / #871) — profile freshness is keyed separately via decodedProfile")
  }

  /// The per-tick fast path (#950): when the sidecar is byte-identical
  /// since decode (mtime unchanged), repeated freshness checks must return
  /// fresh — this is the common slider-drag case (the decode buffer is
  /// reused while only the stripped chain re-applies). The mtime stat
  /// short-circuits the XMP parse so the hot path stays allocation-free.
  /// Asserting many checks in a row exercises the gate; correctness is the
  /// observable contract (the perf saving is structural).
  func testUnchangedSidecarFastPathStaysFresh() async throws {
    let (asset, dir) = try makeAsset()
    defer { try? FileManager.default.removeItem(at: dir) }
    guard let sidecarURL = asset.sidecarURL else {
      return XCTFail("file-backed asset must have a sidecar URL")
    }
    try writeSidecar(
      at: sidecarURL,
      model: {
        var m = AdjustmentModel()
        m.highlightRecovery = .blend
        return m
      }())
    let session = EditSession(asset: asset)
    await session.renderActor._testSeedDecodedCache(
      asset: asset, decoded: makeDecoded(),
      rawResolution: CGSize(width: 100, height: 100))

    // No sidecar write between checks → mtime unchanged → fast path.
    for tick in 0..<5 {
      let fresh = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
      XCTAssertTrue(
        fresh,
        "tick \(tick): an unchanged sidecar must stay fresh via the mtime fast path (#950)")
    }
  }

  /// Decoding with no sidecar (the FFI uses `AdjustmentModel::default()`,
  /// baked model captured as `nil`), then a sidecar APPEARING, must stale
  /// the cache — the decode call shape differs (null xmp_path vs a temp
  /// XMP) and the new sidecar may carry baked stages. #950 preserves this
  /// nil-vs-present edge by representing "no sidecar" as a `nil` baked
  /// model rather than `stripAppleGPUStages(.default)`.
  func testCacheIsStaleWhenSidecarAppearsAfterDecode() async throws {
    let (asset, dir) = try makeAsset()
    defer { try? FileManager.default.removeItem(at: dir) }

    guard let sidecarURL = asset.sidecarURL else {
      return XCTFail("file-backed asset must have a sidecar URL")
    }

    // Decode happened with no sidecar on disk → captured baked nil.
    let session = EditSession(asset: asset)
    await session.renderActor._testSeedDecodedCache(
      asset: asset,
      decoded: makeDecoded(),
      rawResolution: CGSize(width: 100, height: 100)
    )
    let freshBefore = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertTrue(
      freshBefore,
      "precondition: cache is fresh before sidecar appears")

    // Sidecar now appears (e.g. paste-adjustments wrote one).
    _ = try writeSidecar(at: sidecarURL)
    let freshAfter = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertFalse(
      freshAfter,
      "a sidecar appearing where the decode captured nil should stale the cache")
  }

  /// Conversely, decoding with a sidecar present (baked model captured),
  /// then DELETING the sidecar, should also stale the cache — the cached
  /// buffer was decoded with the sidecar's baked stages, but a fresh
  /// decode would now use the default model via a null xmp_path (#950).
  func testCacheIsStaleWhenSidecarDisappearsAfterDecode() async throws {
    let (asset, dir) = try makeAsset()
    defer { try? FileManager.default.removeItem(at: dir) }

    guard let sidecarURL = asset.sidecarURL else {
      return XCTFail("file-backed asset must have a sidecar URL")
    }
    // Give the decode-time sidecar a non-default BAKED field so its
    // captured baked model is distinct from the post-delete `nil`.
    try writeSidecar(
      at: sidecarURL,
      model: {
        var m = AdjustmentModel()
        m.highlightRecovery = .luminance
        return m
      }())

    let session = EditSession(asset: asset)
    await session.renderActor._testSeedDecodedCache(
      asset: asset,
      decoded: makeDecoded(),
      rawResolution: CGSize(width: 100, height: 100)
    )
    let freshBefore = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertTrue(
      freshBefore,
      "precondition: cache is fresh before sidecar deletion")

    try FileManager.default.removeItem(at: sidecarURL)
    let freshAfter = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertFalse(
      freshAfter,
      "a sidecar disappearing where the decode captured a baked model should stale the cache")
  }

  // `testInvalidateClearsAllCacheFields` and the #2037 memory-pressure
  // eviction tests (releaseTransientMemory — which builds on that same
  // invalidate() postcondition) live in EditSessionMemoryReleaseTests.swift
  // (file-size budget).

  // Real-fixture render checks live in EditSessionDecodedCacheTests+Rendering.swift.

  // #1387's autoExposure re-key test lives in the sibling file
  // EditSessionDecodedCacheAutoExposureTests.swift — this file was already
  // at the 600-line hard budget (CONTRIBUTING.md), same split rationale as
  // the run-stage test files.
}
