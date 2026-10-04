import Darwin
import Foundation
import ImageIO
import MapleBackup
import UniformTypeIdentifiers
import XCTest

@testable import MapleCore

@MainActor
final class NativeExportSnapshotTests: EditorTestCase {
  func testFailedRecordCaptureRemovesPrivateSourcesWithoutChangingOriginal() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-capture-cleanup")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try Self.jpeg(root)
    let before = try Data(contentsOf: original)
    let session = try await Self.byteSession(original, root: root)
    session.model.filmLook = "missing_native_export_film"
    session.model.filmStrength = 100
    let directory = root.appendingPathComponent("queue")
    let recipe = ExportRecipe(
      destination: "directory", directory: root.path, overwritePolicy: "error")
    do {
      _ = try await NativeExportCapture.record(
        sessions: [session], recipe: recipe, destination: root, workspace: directory)
      XCTFail("Missing film must fail the real record capture")
    } catch { XCTAssertTrue(error.localizedDescription.contains("unavailable")) }
    let jobs = directory.appendingPathComponent("Jobs")
    let remaining =
      FileManager.default.fileExists(atPath: jobs.path)
      ? try FileManager.default.contentsOfDirectory(atPath: jobs.path) : []
    XCTAssertEqual(remaining, [], "Failed capture must not retain private original copies")
    XCTAssertEqual(try Data(contentsOf: original), before)
  }

  func testSupersededCompletedQueueRemovesOnlyUnreferencedPrivateCapture() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-superseded-cleanup")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try Self.jpeg(root)
    let before = try Data(contentsOf: original)
    let session = try await Self.byteSession(original, root: root)
    let directory = root.appendingPathComponent("queue")
    let recipe = ExportRecipe(
      destination: "directory", directory: root.path, overwritePolicy: "error")
    var old = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe, destination: root, workspace: directory)
    old.items[0].status = "failed"
    old.phase = "done"
    let queue = NativeExportQueue(directory: directory)
    try await queue.enqueue(old)
    let next = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe, destination: root, workspace: directory)
    try await queue.enqueue(next)
    XCTAssertFalse(FileManager.default.fileExists(atPath: old.originals[0].url.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: next.originals[0].url.path))
    XCTAssertEqual(try Data(contentsOf: original), before)
    XCTAssertEqual(try Data(contentsOf: next.originals[0].url), before)
  }

  func testFailedOnlyRetryRetainsFullPrivateSnapshotUntilSuperseded() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-retry-cleanup")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try Self.jpeg(root)
    let before = try Data(contentsOf: original)
    let session = try await Self.byteSession(original, root: root)
    let directory = root.appendingPathComponent("queue")
    let recipe = ExportRecipe(
      destination: "directory", directory: root.path, overwritePolicy: "error")
    var old = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe,
      destination: root, workspace: directory)
    old.items[0].status = "failed"
    old.phase = "done"
    let queue = NativeExportQueue(directory: directory)
    try await queue.enqueue(old)
    try await queue.retryFailed()
    let loadedRetry = try await queue.load()
    let retry = try XCTUnwrap(loadedRetry)
    XCTAssertNotEqual(retry.id, old.id)
    XCTAssertEqual(retry.ownedJob, old.ownedJob)
    XCTAssertEqual(retry.originals, old.originals)
    XCTAssertEqual(try Data(contentsOf: retry.originals[0].url), before)
    try await queue.discardRemaining()
    let next = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe,
      destination: root, workspace: directory)
    try await queue.enqueue(next)
    XCTAssertFalse(FileManager.default.fileExists(atPath: old.originals[0].url.path))
    XCTAssertEqual(try Data(contentsOf: original), before)
  }

  func testRetirementPreservesReplacedPrivateCaptureAndRealOriginal() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-replaced-cleanup")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try Self.jpeg(root)
    let before = try Data(contentsOf: original)
    let session = try await Self.byteSession(original, root: root)
    let directory = root.appendingPathComponent("queue")
    let recipe = ExportRecipe(
      destination: "directory", directory: root.path, overwritePolicy: "error")
    var old = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe,
      destination: root, workspace: directory)
    old.items[0].status = "failed"
    old.phase = "done"
    let queue = NativeExportQueue(directory: directory)
    try await queue.enqueue(old)
    let next = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe,
      destination: root, workspace: directory)
    let source = old.originals[0].url
    try FileManager.default.removeItem(at: source)
    try FileManager.default.moveItem(at: original, to: source)
    do {
      try await queue.enqueue(next)
      XCTFail("Unowned replacement must block retirement")
    } catch { XCTAssertTrue(error.localizedDescription.contains("preserved")) }
    let preserved = directory.appendingPathComponent(
      "Jobs/Retired-\(old.id.uuidString)/Sources/\(source.lastPathComponent)")
    XCTAssertEqual(try Data(contentsOf: preserved), before)
    XCTAssertEqual(try Data(contentsOf: next.originals[0].url), before)
    let durable = try JSONDecoder().decode(
      NativeExportRecord.self,
      from: Data(contentsOf: directory.appendingPathComponent("queue.json")))
    XCTAssertEqual(durable.id, next.id)
    XCTAssertEqual(durable.retiredJobs?.count, 1)
    do {
      _ = try await queue.load()
      XCTFail("Changed retired artifacts must remain visibly fail closed")
    } catch { XCTAssertTrue(error.localizedDescription.contains("preserved")) }
    let archived = try await queue.archiveSavedQueue()
    XCTAssertNotNil(archived)
    XCTAssertEqual(try Data(contentsOf: preserved), before)
    XCTAssertEqual(try Data(contentsOf: next.originals[0].url), before)
  }

  func testProcessCrashAfterSupersedingLedgerRecoversArtifactRetirement() async throws {
    let marker = "native-retirement-process-child"
    if let path = ProcessInfo.processInfo.environment["MAPLE_SWIFT_TEST_ROOT"],
      URL(fileURLWithPath: path).lastPathComponent == marker
    {
      let root = URL(fileURLWithPath: path)
      let directory = root.appendingPathComponent("queue")
      let next = try JSONDecoder().decode(
        NativeExportRecord.self,
        from: Data(contentsOf: root.appendingPathComponent("next.json")))
      let afterClaim = ProcessInfo.processInfo.environment["MAPLE_RETIRE_AFTER_CLAIM"] == "1"
      let queue = NativeExportQueue(directory: directory) { value in
        guard let retired = value.retiredJobs?.first else { return }
        if !afterClaim { Darwin._exit(78) }
        let claimed = directory.appendingPathComponent("Jobs/Retired-\(retired.id.uuidString)")
        guard FileManager.default.fileExists(atPath: claimed.path) else { return }
        let replacement = directory.appendingPathComponent("Jobs/\(retired.id.uuidString)")
        do {
          try FileManager.default.createDirectory(
            at: replacement, withIntermediateDirectories: false)
          try Data("foreign public namespace replacement".utf8).write(
            to: replacement.appendingPathComponent("foreign.txt"))
          Darwin._exit(79)
        } catch { Darwin._exit(80) }
      }
      try await queue.enqueue(next)
      XCTFail("Child must exit after durable replacement, before retirement")
      return
    }
    for afterClaim in [false, true] {
      let fixture = try SidecarContractIO.makeTempDirectory(prefix: "native-retirement-crash")
      defer { try? FileManager.default.removeItem(at: fixture) }
      let root = fixture.appendingPathComponent(marker)
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      let original = try Self.jpeg(root)
      let before = try Data(contentsOf: original)
      let session = try await Self.byteSession(original, root: root)
      let directory = root.appendingPathComponent("queue")
      let recipe = ExportRecipe(
        destination: "directory", directory: root.path, overwritePolicy: "error")
      var old = try await NativeExportCapture.record(
        sessions: [session], recipe: recipe,
        destination: root, workspace: directory)
      old.items[0].status = "failed"
      old.phase = "done"
      try await NativeExportQueue(directory: directory).enqueue(old)
      let next = try await NativeExportCapture.record(
        sessions: [session], recipe: recipe,
        destination: root, workspace: directory)
      try JSONEncoder().encode(next).write(to: root.appendingPathComponent("next.json"))
      let child = Process()
      child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
      child.arguments = [
        "-XCTest",
        "MapleCoreTests.NativeExportSnapshotTests/testProcessCrashAfterSupersedingLedgerRecoversArtifactRetirement",
        Bundle(for: NativeExportSnapshotTests.self).bundlePath,
      ]
      var environment = ProcessInfo.processInfo.environment
      environment["MAPLE_SWIFT_TEST_ROOT"] = root.path
      environment["MAPLE_RETIRE_AFTER_CLAIM"] = afterClaim ? "1" : "0"
      child.environment = environment
      child.standardOutput = FileHandle.nullDevice
      child.standardError = FileHandle.nullDevice
      try child.run()
      await Task.detached { child.waitUntilExit() }.value
      XCTAssertEqual(child.terminationStatus, afterClaim ? 79 : 78)
      let oldCopy =
        afterClaim
        ? directory.appendingPathComponent(
          "Jobs/Retired-\(old.id.uuidString)/Sources/\(old.originals[0].url.lastPathComponent)")
        : old.originals[0].url
      XCTAssertEqual(try Data(contentsOf: oldCopy), before)
      let durable = try JSONDecoder().decode(
        NativeExportRecord.self,
        from: Data(contentsOf: directory.appendingPathComponent("queue.json")))
      XCTAssertEqual(durable.id, next.id)
      XCTAssertEqual(durable.retiredJobs?.count, 1)
      let recovered = try await NativeExportQueue(directory: directory).load()
      XCTAssertEqual(recovered?.id, next.id)
      XCTAssertNil(recovered?.retiredJobs)
      XCTAssertFalse(FileManager.default.fileExists(atPath: oldCopy.path))
      if afterClaim {
        let foreign = directory.appendingPathComponent("Jobs/\(old.id.uuidString)/foreign.txt")
        XCTAssertEqual(
          try Data(contentsOf: foreign), Data("foreign public namespace replacement".utf8))
      }
      XCTAssertEqual(try Data(contentsOf: next.originals[0].url), before)
      XCTAssertEqual(try Data(contentsOf: original), before)
    }
  }

  func testLaterUnavailableSourceCleansEarlierPrivateCopy() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-later-source-cleanup")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try Self.jpeg(root)
    let before = try Data(contentsOf: original)
    let first = try await Self.byteSession(original, root: root)
    let second = try await Self.byteSession(root.appendingPathComponent("missing.jpg"), root: root)
    let directory = root.appendingPathComponent("queue")
    let recipe = ExportRecipe(
      destination: "directory", directory: root.path, overwritePolicy: "error")
    do {
      _ = try await NativeExportCapture.record(
        sessions: [first, second], recipe: recipe,
        destination: root, workspace: directory)
      XCTFail("Unavailable later source must fail capture")
    } catch { XCTAssertFalse(error.localizedDescription.contains("cleanup could not")) }
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(
        atPath: directory.appendingPathComponent("Jobs").path), [])
    XCTAssertEqual(try Data(contentsOf: original), before)
  }

  func testCanonicalAliasReferencePreventsRetirementWithoutNewOwnershipField() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-canonical-retention")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try Self.jpeg(root)
    let before = try Data(contentsOf: original)
    let session = try await Self.byteSession(original, root: root)
    let directory = root.appendingPathComponent("queue")
    let recipe = ExportRecipe(
      destination: "directory", directory: root.path, overwritePolicy: "error")
    var old = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe,
      destination: root, workspace: directory)
    old.items[0].status = "failed"
    old.phase = "done"
    let queue = NativeExportQueue(directory: directory)
    try await queue.enqueue(old)
    let captured = old.originals[0]
    let canonical = NativeExportSource(
      id: captured.id, url: captured.url.resolvingSymlinksInPath(),
      scopeURL: captured.scopeURL, bookmark: captured.bookmark, relativePath: captured.relativePath,
      originalHash: captured.originalHash, identity: captured.identity,
      ownedDirectory: captured.ownedDirectory)
    let previousTarget = old.items[0].target
    let target = NativeExportTarget(
      source: canonical, stem: previousTarget.stem, xmp: previousTarget.xmp,
      capturedAt: previousTarget.capturedAt, index: previousTarget.index)
    let next = NativeExportRecord(
      version: 1, id: UUID(), recipe: recipe,
      destinationBookmark: old.destinationBookmark, originals: [canonical], filmDirectory: nil,
      filmHashes: [:], items: [NativeExportItem(target: target)])
    XCTAssertTrue(
      NativeExportArtifacts.referenced(try XCTUnwrap(old.ownedJob), by: next, workspace: directory))
    try await queue.enqueue(next)
    XCTAssertEqual(try Data(contentsOf: canonical.url), before)
    XCTAssertEqual(try Data(contentsOf: original), before)
  }

  func testAuthoredVariantAndRealSidecarFreezeAcrossFailedOnlyRetry() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let sidecar = SidecarPath.sidecarURL(for: fixture.raw)
    try Data(NativeWorkflowControlFixture.input().utf8).write(to: sidecar)
    let session = EditSession(asset: AssetRef(url: fixture.raw))
    await session.loadSidecar()
    await session.workflow.createVariant(name: "Recipe snapshot", session: session)
    session.beginEdit(description: "Captured exposure")
    session.model.exposure = 0.7
    session.endEdit()
    await session.flushPendingSidecarWrite()
    let before = try Data(contentsOf: sidecar)
    let destination = fixture.directory.appendingPathComponent("outputs")
    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
    let recipe = ExportRecipe(
      format: "png", quality: nil, destination: "directory",
      directory: destination.path, overwritePolicy: "error")
    let directory = fixture.directory.appendingPathComponent("queue")
    let record = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe,
      destination: destination, workspace: directory)
    XCTAssertEqual(try XMPParser.parse(record.items[0].target.xmp).0.exposure, 0.7)
    XCTAssertEqual(try Data(contentsOf: sidecar), before)
    let output = destination.appendingPathComponent("photo.png")
    try Data("controlled collision".utf8).write(to: output)
    let queue = NativeExportQueue(directory: directory)
    try await queue.enqueue(record)
    try await queue.run()
    let failure = try await queue.load()
    XCTAssertEqual(failure?.failures, 1)
    session.beginEdit(description: "Later exposure")
    session.model.exposure = -1
    session.endEdit()
    await session.flushPendingSidecarWrite()
    let later = try Data(contentsOf: sidecar)
    try FileManager.default.removeItem(at: output)
    try await queue.retryFailed()
    try await queue.run()
    let completed = try await queue.load()
    XCTAssertEqual(completed?.successes, 1)
    let expected = destination.appendingPathComponent("frozen-control.tmp")
    try NativeExportRecipeBridge.render(
      source: fixture.raw, xmp: record.items[0].target.xmp,
      recipe: recipe, filmDirectory: nil, staging: expected)
    let changed = destination.appendingPathComponent("later-control.tmp")
    try NativeExportRecipeBridge.render(
      source: fixture.raw,
      xmp: XMPSerializer.serialize(model: session.model, culling: session.culling),
      recipe: recipe, filmDirectory: nil, staging: changed)
    XCTAssertEqual(try Data(contentsOf: output), try Data(contentsOf: expected))
    XCTAssertNotEqual(try Data(contentsOf: output), try Data(contentsOf: changed))
    XCTAssertEqual(try Data(contentsOf: sidecar), later)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.cancelAll()
    await session.releaseTransientMemory()
  }

  func testOpaqueBytesSourceCannotReplaceItsActualMountedOriginal() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-byte-original")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try Self.jpeg(root)
    let before = try Data(contentsOf: original)
    let directory = root.appendingPathComponent("queue")
    let session = try await Self.byteSession(original, root: root)
    let recipe = ExportRecipe(
      destination: "directory", directory: root.path, overwritePolicy: "replace")
    let record = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe,
      destination: root, workspace: directory)
    XCTAssertNotEqual(record.originals[0].url, original)
    XCTAssertNotNil(record.originals[0].ownedDirectory)
    let queue = NativeExportQueue(directory: directory)
    try await queue.enqueue(record)
    try await queue.run()
    let failed = try await queue.load()
    XCTAssertEqual(failed?.failures, 1)
    XCTAssertTrue(failed?.items.first?.reason?.contains("byte-only source") == true)
    XCTAssertEqual(try Data(contentsOf: original), before)
    var safe = recipe
    safe.namingTemplate = "{original}-new.{ext}"
    let newRecord = NativeExportQueueFixture.replacingRecipe(record, safe)
    try await queue.enqueue(newRecord)
    try await queue.run()
    let finished = try await queue.load()
    XCTAssertEqual(finished?.successes, 1)
    XCTAssertEqual(try Data(contentsOf: original), before)
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: root.appendingPathComponent("photo-new.jpg").path))
  }

  func testOpaqueSourcePostPublicationProcessCrashReconcilesOwnedInodeWithoutReplacingOriginal()
    async throws
  {
    let marker = "native-export-published-child"
    if let path = ProcessInfo.processInfo.environment["MAPLE_SWIFT_TEST_ROOT"],
      URL(fileURLWithPath: path).lastPathComponent == marker
    {
      let root = URL(fileURLWithPath: path)
      let original = root.appendingPathComponent("photo.jpg")
      let directory = root.appendingPathComponent("queue")
      let session = try await Self.byteSession(original, root: root)
      let recipe = ExportRecipe(
        namingTemplate: "{original}-new.{ext}", destination: "directory",
        directory: root.path, overwritePolicy: "replace")
      let record = try await NativeExportCapture.record(
        sessions: [session], recipe: recipe,
        destination: root, workspace: directory)
      let queue = NativeExportQueue(directory: directory) { value in
        if value.items.first?.status == "applied" { Darwin._exit(78) }
      }
      try await queue.enqueue(record)
      try await queue.run()
      XCTFail("Child must exit after durable publication, before applied ledger acknowledgement")
      return
    }
    let parent = try SidecarContractIO.makeTempDirectory(prefix: "native-published-recovery")
    defer { try? FileManager.default.removeItem(at: parent) }
    let root = parent.appendingPathComponent(marker)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let original = try Self.jpeg(root)
    let before = try Data(contentsOf: original)
    let child = Process()
    child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    child.arguments = [
      "-XCTest",
      "MapleCoreTests.NativeExportSnapshotTests/testOpaqueSourcePostPublicationProcessCrashReconcilesOwnedInodeWithoutReplacingOriginal",
      Bundle(for: NativeExportSnapshotTests.self).bundlePath,
    ]
    var environment = ProcessInfo.processInfo.environment
    environment["MAPLE_SWIFT_TEST_ROOT"] = root.path
    child.environment = environment
    child.standardOutput = FileHandle.nullDevice
    child.standardError = FileHandle.nullDevice
    try child.run()
    await Task.detached { child.waitUntilExit() }.value
    XCTAssertEqual(child.terminationStatus, 78)
    let queue = NativeExportQueue(directory: root.appendingPathComponent("queue"))
    let loaded = try await queue.load()
    let prepared = try XCTUnwrap(loaded?.items.first)
    XCTAssertEqual(prepared.status, "prepared")
    let output = try XCTUnwrap(prepared.output)
    XCTAssertEqual(try NativeExportStorage.hash(output), prepared.afterHash)
    XCTAssertEqual(try NativeExportStorage.identity(output), prepared.stagingIdentity)
    XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(prepared.staging).path))
    let outputBytes = try Data(contentsOf: output)
    try await queue.run()
    let completed = try await queue.load()
    XCTAssertEqual(completed?.successes, 1)
    XCTAssertEqual(try Data(contentsOf: output), outputBytes)
    XCTAssertEqual(try Data(contentsOf: original), before)
  }

  static func jpeg(_ root: URL) throws -> URL {
    let png = root.appendingPathComponent("seed.png")
    try SidecarContractIO.makeSyntheticOriginal(at: png)
    let source = try XCTUnwrap(CGImageSourceCreateWithURL(png as CFURL, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    let jpeg = root.appendingPathComponent("photo.jpg")
    let destination = try XCTUnwrap(
      CGImageDestinationCreateWithURL(
        jpeg as CFURL,
        UTType.jpeg.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return jpeg
  }

  static func byteSession(_ original: URL, root: URL) async throws -> EditSession {
    let support = AppSupportSidecarStore(root: root.appendingPathComponent("sidecars"))
    let sidecar = support.sidecarURL(phassetLocalId: "native/recipe/bytes")
    try FileManager.default.createDirectory(
      at: sidecar.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(NativeWorkflowControlFixture.input().utf8).write(to: sidecar)
    let asset = AssetRef(
      displayName: "photo.jpg", hintExtension: "jpg",
      bytesProvider: { try Data(contentsOf: original) })
    let session = EditSession(
      asset: asset,
      remoteSidecarStore: PhotoKitSidecarStore(
        phassetLocalId: "native/recipe/bytes", sidecars: support))
    await session.loadSidecar()
    XCTAssertTrue(session.hasLoadedSidecar)
    return session
  }

  func testRealCapturedFilmLutIsImmutableAndMissingLookFailsExplicitly() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let directory = fixture.directory.appendingPathComponent("queue")
    let id = UUID()
    let captured = try await NativeExportCapture.captureFilms(
      ids: ["test_lut"],
      workspace: directory, jobID: id, bundle: .module)
    let film = try XCTUnwrap(captured.directory)
    var model = AdjustmentModel.default
    model.filmLook = "test_lut"
    model.filmStrength = 100
    let xmp = XMPSerializer.serialize(model: model, culling: CullingState())
    let base = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory, xmp: xmp)
    let record = NativeExportRecord(
      version: 1, id: base.id, recipe: base.recipe,
      destinationBookmark: base.destinationBookmark, originals: base.originals,
      filmDirectory: film, filmHashes: captured.hashes, items: base.items)
    let access = try NativeExportAccess(record: record)
    let rendering = try NativeExportPublication.prepare(
      record.items[0], record: record, access: access)
    let developed = try NativeExportPublication.render(rendering, record: record, access: access)
    let filmBytes = try Data(contentsOf: XCTUnwrap(developed.staging))
    let plain = fixture.directory.appendingPathComponent("plain.tmp")
    try NativeExportRecipeBridge.render(
      source: fixture.raw, xmp: NativeWorkflowControlFixture.input(),
      recipe: record.recipe, filmDirectory: nil, staging: plain)
    XCTAssertNotEqual(filmBytes, try Data(contentsOf: plain))
    try Data("changed LUT".utf8).write(to: film.appendingPathComponent("test_lut.mlut"))
    XCTAssertThrowsError(
      try NativeExportPublication.render(rendering, record: record, access: access))
    do {
      _ = try await NativeExportCapture.captureFilms(
        ids: ["missing_look"], workspace: directory,
        jobID: UUID(), bundle: .module)
      XCTFail("Missing active look must not silently render without it")
    } catch { XCTAssertTrue(error.localizedDescription.contains("unavailable")) }
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
  }
}
