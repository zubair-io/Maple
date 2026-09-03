// SidecarTransactionContractPhotoKitTests.swift — the PhotoKit adapter's
// transaction contract (#2431). See `SidecarContractSupport.swift` for the
// shared vectors/helpers and the recipe every adapter file follows.
//
// PhotoKit is `PhotoKitSource` + `PhotoKitSidecarStore`
// (`PhotoKitSidecarStore.swift`), backed by `AppSupportSidecarStore`
// (MapleBackup) — a file-per-`phassetLocalId` store in the App Support
// directory, since PHAsset-backed images have no stable filesystem URL to
// place a sibling `.xmp` beside. A real `PHPhotoLibrary` isn't available in
// a headless `swift test` run, so — exactly like the pre-existing
// `PhotoKitSidecarStoreTests` this suite's shape follows — the backing
// `AppSupportSidecarStore` is rooted at a real temp directory instead of
// the default `~/Library/Application Support/...` location. This is the
// real on-disk store class; only the *root path* is redirected, matching
// CLAUDE.md's no-mocks-for-the-sidecar-layer rule.
//
// The PhotoKit adapter has no filesystem-shared "original asset" — the
// PHAsset's pixel bytes live in the Photos library, entirely outside
// `AppSupportSidecarStore`'s reach. So "original bytes unchanged" is
// structural here rather than something to digest-check: this store can
// only ever write inside its own `root`, never anywhere else. That's
// asserted directly below rather than skipped.

import MapleBackup
import XCTest

@testable import MapleCore

final class SidecarTransactionContractPhotoKitTests: XCTestCase {

  /// Returns a `PhotoKitSidecarStore` backing, its root, and a dedicated
  /// SANDBOX parent directory that only this test process ever touches.
  /// `test100CycleTransactionContract`'s "nothing escaped this store's own
  /// root" check needs to list a directory's contents before and after —
  /// listing the shared system temp directory (`tmpRoot`'s literal parent
  /// would be `NSTemporaryDirectory()`) races every other test and
  /// background process on the machine that creates or removes its own
  /// temp entries during the run (jules review). Nesting `tmpRoot` one
  /// level inside a freshly minted, single-purpose `sandbox` directory
  /// makes that listing deterministic: nothing else on the system has any
  /// reason to write into this UUID-named directory.
  private func freshBacking() throws -> (
    backing: AppSupportSidecarStore, tmpRoot: URL, sandbox: URL
  ) {
    let sandbox = try SidecarContractIO.makeTempDirectory(
      prefix: "sidecar-contract-photokit-sandbox")
    addTeardownBlock { try? FileManager.default.removeItem(at: sandbox) }
    let tmpRoot = sandbox.appendingPathComponent("store-root", isDirectory: true)
    try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
    return (AppSupportSidecarStore(root: tmpRoot), tmpRoot, sandbox)
  }

  // MARK: - 100-cycle transaction contract (acceptance criterion #2)

  /// The same versioned vector driven through `PhotoKitSidecarStore`
  /// instead of `XMPSidecarStore`. Regression coverage for the passthrough
  /// bug fixed alongside this suite: before the fix, `writePending()`
  /// called `XMPSerializer.serialize(model:culling:)` with no captured
  /// passthrough bucket, so a foreign sidecar's unmodelled content was
  /// silently dropped on the very first PhotoKit-adapter edit — this test
  /// would have failed on `cycle == 0`.
  func test100CycleTransactionContract() async throws {
    let (backing, tmpRoot, sandbox) = try freshBacking()
    // Snapshot the dedicated sandbox's entries before any writes — only
    // `store-root` (== `tmpRoot`) should ever appear here, before or after.
    let siblingsBefore = try FileManager.default.contentsOfDirectory(
      at: sandbox, includingPropertiesForKeys: nil)
    let phassetLocalId = "ABCD1234-5678-90AB-CDEF-1234567890AB/L0/001"

    // Seed the backing store with a real Lightroom-authored sidecar —
    // the same passthrough-laden vector every adapter test drives.
    try backing.write(
      phassetLocalId: phassetLocalId, xmp: SidecarContractVectors.passthroughLadenDocument)

    let vectorModel = SidecarContractVectors.fullyAuthoredModel()
    let vectorCulling = SidecarContractVectors.fullyAuthoredCulling()

    for cycle in 0..<100 {
      // Step 3: commit through the adapter's atomic write (temp + replaceItemAt).
      let writer = PhotoKitSidecarStore(phassetLocalId: phassetLocalId, sidecars: backing)
      _ = try await writer.load()  // captures existing passthrough
      await writer.update(model: vectorModel, culling: vectorCulling)
      await writer.flush()

      // Step 4: reopen in a new session — fresh actor instance.
      let reader = PhotoKitSidecarStore(phassetLocalId: phassetLocalId, sidecars: backing)
      let reloaded = try await reader.loadIfPresent()
      let unwrapped = try XCTUnwrap(reloaded, "cycle \(cycle): sidecar must exist after write")

      // Step 5: semantic adjustments...
      XCTAssertEqual(
        unwrapped.0.exposure, vectorModel.exposure, accuracy: 1e-9,
        "cycle \(cycle): exposure must round-trip")
      XCTAssertEqual(unwrapped.1.stars, vectorCulling.stars, "cycle \(cycle)")

      // ...and preserved content, byte-for-byte.
      let onDisk = try XCTUnwrap(try backing.read(phassetLocalId: phassetLocalId))
      let sourceNodes = XMPChildElementScanner.descriptionChildren(
        in: SidecarContractVectors.passthroughLadenDocument)
      // `crs:ToneCurvePV2012` excluded — #2232 made it a MODELED field, so
      // it legitimately takes the vector model's own curve value on update
      // rather than preserving the original document's bytes. `crs:MaskGroup-
      // BasedCorrections` excluded the same way (#3274) — its content in this
      // fixture isn't a shape Maple's local-adjustments reader recognizes
      // (see the filesystem adapter's contract test for the full rationale).
      for node in sourceNodes
      where node.qName != "crs:ToneCurvePV2012" && node.qName != "crs:MaskGroupBasedCorrections" {
        XCTAssertTrue(
          onDisk.contains(node.source),
          "cycle \(cycle): \(node.qName) must survive verbatim — "
            + "this is the #2233-shaped bug the PhotoKit adapter had")
      }

      if cycle == 0 || cycle == 99 {
        // Step 6: render + export from the reopened state. PhotoKit
        // has no on-disk original asset to decode from, so this
        // proves the reopened MODEL is well-formed and render-ready
        // against a stand-in image, mirroring what `EditSession`
        // would do with real PHAsset bytes.
        let standIn = tmpRoot.appendingPathComponent("render-check-\(cycle).png")
        try SidecarContractIO.makeSyntheticOriginal(at: standIn)
        let exported = try await SidecarContractRender.renderAndExport(
          originalURL: standIn, model: unwrapped.0)
        XCTAssertGreaterThan(exported.count, 0, "cycle \(cycle): export must produce bytes")
      }
    }

    // "Original bytes unchanged" is structural for this adapter: the
    // store can only ever write inside its own root, never a new
    // sibling of it — checked against the isolated sandbox, not the
    // shared system temp directory.
    let siblingsAfter = try FileManager.default.contentsOfDirectory(
      at: sandbox, includingPropertiesForKeys: nil)
    XCTAssertEqual(
      Set(siblingsAfter), Set(siblingsBefore),
      "PhotoKitSidecarStore must never write outside its own root")
  }

  // MARK: - Golden migration fixture readability (acceptance criterion #6)

  func testGoldenMigrationFixtureRemainsReadable() async throws {
    let (backing, _, _) = try freshBacking()
    let phassetLocalId = "MIGRATION/L0/001"
    try backing.write(
      phassetLocalId: phassetLocalId, xmp: SidecarContractVectors.passthroughLadenDocument)

    let store = PhotoKitSidecarStore(phassetLocalId: phassetLocalId, sidecars: backing)
    let result = try await store.loadIfPresent()
    let unwrapped = try XCTUnwrap(result)
    XCTAssertEqual(unwrapped.0.exposure, 0.35, accuracy: 1e-9)
    XCTAssertEqual(unwrapped.1.stars, 3)
  }
}
