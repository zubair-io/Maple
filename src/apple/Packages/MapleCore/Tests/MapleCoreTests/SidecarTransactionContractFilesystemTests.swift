// SidecarTransactionContractFilesystemTests.swift — the local-filesystem
// adapter's transaction contract (#2431). See `SidecarContractSupport.swift`
// for the shared vectors/helpers and the recipe every adapter file follows.
//
// Local filesystem is `FilesystemSource` + `XMPSidecarStore`
// (`Sources/FilesystemSource.swift`, `XMPSidecarStore.swift`) — the atomic
// write is temp-file + `FileManager.replaceItemAt`.

import XCTest

@testable import MapleCore

@MainActor
final class SidecarTransactionContractFilesystemTests: XCTestCase {

  private func makeDir() throws -> URL {
    let dir = try SidecarContractIO.makeTempDirectory(prefix: "sidecar-contract-fs")
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    return dir
  }

  // MARK: - 100-cycle transaction contract (acceptance criterion #2)

  /// Runs the full 7-step transaction contract 100 times: write the
  /// versioned vector (model + culling + passthrough) through a store
  /// instance, reopen with a BRAND NEW `XMPSidecarStore` (a real "new
  /// session" — no shared in-memory cache), assert the semantic model and
  /// the passthrough bytes both survived, and assert the original asset's
  /// digest never moved. Render + export runs once (cycle 0) and once more
  /// after the last cycle (cycle 99) — full-pipeline decode/develop/encode
  /// on every one of 100 cycles would multiply this suite's runtime for no
  /// additional signal beyond what the first and last cycle already prove.
  func test100CycleTransactionContract() async throws {
    let dir = try makeDir()
    let originalURL = dir.appendingPathComponent("original.png")
    let originalBytes = try SidecarContractIO.makeSyntheticOriginal(at: originalURL)
    let originalDigest = try SidecarContractIO.sha256(of: originalURL)

    let sidecarURL = SidecarPath.sidecarURL(for: originalURL)
    try SidecarContractVectors.passthroughLadenDocument
      .write(to: sidecarURL, atomically: true, encoding: .utf8)

    let vectorModel = SidecarContractVectors.fullyAuthoredModel()
    let vectorCulling = SidecarContractVectors.fullyAuthoredCulling()

    for cycle in 0..<100 {
      // Step 3: commit through the adapter's atomic-write mechanism.
      let writer = XMPSidecarStore(rawURL: originalURL)
      _ = try await writer.load()  // captures existing passthrough, like a real session open
      await writer.update(model: vectorModel, culling: vectorCulling)
      await writer.flush()

      // Step 4: reopen in a new session — a fresh actor, no carried cache.
      let reader = XMPSidecarStore(rawURL: originalURL)
      let (reloadedModel, reloadedCulling) = try await reader.load()

      // Step 5: compare semantic adjustments...
      XCTAssertEqual(
        reloadedModel.exposure, vectorModel.exposure, accuracy: 1e-9,
        "cycle \(cycle): exposure must round-trip")
      XCTAssertEqual(
        reloadedModel.temperature, vectorModel.temperature, accuracy: 1e-9,
        "cycle \(cycle): temperature must round-trip")
      XCTAssertEqual(reloadedModel.crop, vectorModel.crop, "cycle \(cycle): crop must round-trip")
      XCTAssertEqual(
        reloadedCulling.stars, vectorCulling.stars,
        "cycle \(cycle): culling must round-trip")
      XCTAssertEqual(reloadedCulling.keywords, vectorCulling.keywords)

      // ...and preserved (unknown) content, byte-for-byte. `crs:ToneCurvePV2012`
      // is excluded: #2232 made it a MODELED field (`displayToneCurveLuma`), so
      // an `update(model: vectorModel, ...)` legitimately overwrites it with
      // the vector model's own curve value — exactly like `crs:Exposure2012`
      // already does above — rather than preserving the original bytes.
      let onDisk = try String(contentsOf: sidecarURL, encoding: .utf8)
      let sourceNodes = XMPChildElementScanner.descriptionChildren(
        in: SidecarContractVectors.passthroughLadenDocument)
      XCTAssertEqual(sourceNodes.map(\.qName), SidecarContractVectors.passthroughNodeNames)
      for node in sourceNodes where node.qName != "crs:ToneCurvePV2012" {
        XCTAssertTrue(
          onDisk.contains(node.source),
          "cycle \(cycle): \(node.qName) must survive verbatim")
      }

      // Step 7: original bytes are a hard-fail if they moved.
      XCTAssertEqual(
        try SidecarContractIO.sha256(of: originalURL), originalDigest,
        "cycle \(cycle): original asset bytes must never change")

      if cycle == 0 || cycle == 99 {
        // Step 6: render preview and export from the reopened state.
        let exported = try await SidecarContractRender.renderAndExport(
          originalURL: originalURL, model: reloadedModel)
        XCTAssertGreaterThan(exported.count, 0, "cycle \(cycle): export must produce bytes")
      }
    }

    XCTAssertEqual(
      try Data(contentsOf: originalURL), originalBytes,
      "original bytes must be byte-identical after 100 cycles")
  }

  // MARK: - Golden migration fixture readability (acceptance criterion #6)

  /// A pre-#2233 Lightroom-authored sidecar — the same fixture every
  /// adapter test in this suite drives — must still open through the
  /// filesystem adapter's real store.
  func testGoldenMigrationFixtureRemainsReadable() async throws {
    let dir = try makeDir()
    let originalURL = dir.appendingPathComponent("legacy.dng")
    try SidecarContractIO.makeSyntheticOriginal(at: originalURL)
    let sidecarURL = SidecarPath.sidecarURL(for: originalURL)
    try SidecarContractVectors.passthroughLadenDocument
      .write(to: sidecarURL, atomically: true, encoding: .utf8)

    let store = XMPSidecarStore(rawURL: originalURL)
    let (model, culling) = try await store.load()
    XCTAssertEqual(model.exposure, 0.35, accuracy: 1e-9)
    XCTAssertEqual(culling.stars, 3)
  }

  // MARK: - Fault states are deterministic and observable (acceptance criterion #4)

  /// A write into a read-only directory must surface a real, observable
  /// error through the store's `errors()` stream — never fail silently —
  /// and the atomic temp+rename mechanism must leave no partial file
  /// behind. No mocks: this is a genuine OS-level permission failure
  /// against a real temp directory.
  func testPermissionDeniedIsDeterministicAndObservable() async throws {
    let dir = try makeDir()
    let originalURL = dir.appendingPathComponent("locked.png")
    try SidecarContractIO.makeSyntheticOriginal(at: originalURL)

    let fm = FileManager.default
    try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: dir.path)
    addTeardownBlock { try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path) }

    let store = XMPSidecarStore(rawURL: originalURL)
    let errorStream = await store.errors()

    await store.update(model: SidecarContractVectors.fullyAuthoredModel(), culling: CullingState())
    await store.flush()

    let observed = await SidecarContractFault.firstError(from: errorStream)
    XCTAssertNotNil(observed, "a permission-denied write must be observable, not silent")

    try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)
    let sidecarURL = SidecarPath.sidecarURL(for: originalURL)
    let tmpURL = sidecarURL.deletingLastPathComponent()
      .appendingPathComponent(".\(sidecarURL.lastPathComponent).tmp")
    XCTAssertFalse(
      fm.fileExists(atPath: tmpURL.path),
      "no partial temp file should survive a failed write")
  }

  /// Disk-full must be deterministic and observable too, and must not
  /// corrupt whatever the sidecar already held (atomic temp+rename means a
  /// failed write never replaces a good file). Runs against a real,
  /// tiny HFS+ ramdisk — a genuine ENOSPC, not a simulated one — and
  /// skip-passes when `hdiutil` is unavailable (sandboxed CI), matching
  /// this repo's fixture-absence skip-pass convention.
  func testDiskFullIsDeterministicAndObservable() async throws {
    guard let ramdisk = RamdiskFixture.makeTiny() else {
      throw XCTSkip("hdiutil unavailable in this environment — cannot create a real ENOSPC")
    }
    defer { ramdisk.eject() }

    let originalURL = ramdisk.mountPoint.appendingPathComponent("original.png")
    try SidecarContractIO.makeSyntheticOriginal(at: originalURL)
    let sidecarURL = SidecarPath.sidecarURL(for: originalURL)
    try SidecarContractVectors.passthroughLadenDocument
      .write(to: sidecarURL, atomically: true, encoding: .utf8)
    let goodContent = try String(contentsOf: sidecarURL, encoding: .utf8)

    try ramdisk.fillToNearCapacity()

    let store = XMPSidecarStore(rawURL: originalURL)
    let errorStream = await store.errors()
    await store.update(model: SidecarContractVectors.fullyAuthoredModel(), culling: CullingState())
    await store.flush()

    let observed = await SidecarContractFault.firstError(from: errorStream)
    XCTAssertNotNil(observed, "ENOSPC must be observable, not silent")

    let stillGood = try String(contentsOf: sidecarURL, encoding: .utf8)
    XCTAssertEqual(
      stillGood, goodContent,
      "a failed disk-full write must not corrupt the previous good sidecar")
  }
}
