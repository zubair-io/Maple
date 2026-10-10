// #3941 / #3984: real photographic detector/SAM/planner/model/state/save path.
// This verifies grouped instance choices, not distinct-person ownership or fill quality.
import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class PhotographicRemovalGroupTests: XCTestCase {
  private struct Window: Decodable {
    let x: UInt32
    let y: UInt32
    let width: UInt32
    let height: UInt32

    func separated(from other: Self) -> Bool {
      x + width <= other.x || other.x + other.width <= x
        || y + height <= other.y || other.y + other.height <= y
    }
  }

  private struct Plan: Decodable { let window: Window }

  private func plan(_ mask: Data, source: String) throws -> Window {
    let request = try NativeRemovalGeneration.plan(
      source: source, intent: mask,
      holeRadius: ExperimentalRemovalModels.holeRadius,
      fringeRadius: ExperimentalRemovalModels.fringeRadius)
    return try JSONDecoder().decode(Plan.self, from: Data(request.utf8)).window
  }

  private func separatedPeople(_ removal: RemovalSession, source: String) throws -> [Int] {
    let candidates = removal.detectedPersonMasks.compactMap { person -> (Int, Data, Window)? in
      guard let window = try? plan(person.mask, source: source) else { return nil }
      return (person.id, person.mask, window)
    }
    for (index, first) in candidates.enumerated() {
      for second in candidates.dropFirst(index + 1) where first.2.separated(from: second.2) {
        let union = try RemovalBridge.combineMasks(first.1, second.1)
        if (try? plan(union, source: source)) == nil { return [first.0, second.0] }
      }
    }
    throw RemovalError.invalid(
      "Photographic corpus lacks two separated bounded person masks; detected \(removal.people.count), bounded \(candidates.count)"
    )
  }

  func testActualPartialPersonCorrectionSurvivesAnotherCheckbox() async throws {
    #if os(macOS)
      let repository = (0..<7).reduce(URL(fileURLWithPath: #filePath)) {
        value, _ in value.deletingLastPathComponent()
      }
      let fixture = repository.appendingPathComponent(
        "test-fixtures/raws/removal-photographic/bologna.nef")
      let models = repository.appendingPathComponent("test-fixtures/raws/removal-inference")
      guard FileManager.default.fileExists(atPath: fixture.path),
        (ExperimentalRemovalModels.all.map(\.file) + ["runtime.dylib"]).allSatisfy({
          FileManager.default.fileExists(atPath: models.appendingPathComponent($0).path)
        })
      else { throw XCTSkip("Exact Bologna RAW and pinned models required (#3984)") }
      let original = try Data(contentsOf: fixture)
      XCTAssertEqual(
        try RemovalBridge.digest(original),
        "blake3:2019a5cbd7bcdcf8405528789cde7c05ed4bee8d31c533df786be64f42c97718")
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let raw = directory.appendingPathComponent("photo.nef")
      try original.write(to: raw)
      let session = EditSession(asset: AssetRef(url: raw))
      let removal = RemovalSession(
        session: session,
        modelStore: MacRemovalModelStore(root: directory.appendingPathComponent("models")))
      await removal.open()
      await removal.setMode(.people)
      await removal.chooseModelFolder(models)
      XCTAssertEqual(removal.phase, .ready, removal.message)
      let detected = removal.detectedPersonMasks
      // These retained proposals overlap one wearer. Explicitly select all
      // three so a duplicate keeper does not protect the painted hat. This
      // does not qualify automatic duplicate ownership or complete silhouettes.
      for id in [3, 10, 15] {
        if removal.people.first(where: { $0.id == id })?.keep == true { removal.keepPerson(id) }
      }
      await removal.beginPersonRefinement(3)
      func targetMask() throws -> Data {
        let index = try XCTUnwrap(removal.personBases.firstIndex { $0.id == 3 })
        return try XCTUnwrap(
          removal.personMasks.indices.contains(index) ? removal.personMasks[index] : nil)
      }
      let before = try targetMask()
      removal.radius = 0.01
      await removal.paint(
        [[(37.0 + 0.5) / 1024, (205.0 + 0.5) / 683]], cropInputSize: [6000, 4000])
      let corrected = try targetMask()
      XCTAssertNotEqual(corrected, before, "The actual partial body mask needs the painted hat")
      removal.keepPerson(6)
      let overlay = try await removal.overlay(cropInputSize: [6000, 4000], aspect: 1.5)
      let x = Int(37.5 * Double(overlay.width) / 1024)
      let y = Int(205.5 * Double(overlay.height) / 683)
      XCTAssertEqual(overlay.selection[(y * overlay.width + x) * 4 + 3], 255)
      await removal.beginPersonRefinement(3)
      XCTAssertEqual(try targetMask(), corrected)
      await removal.undoSelection()
      XCTAssertEqual(try targetMask(), before)
      await removal.redoSelection()
      XCTAssertEqual(try targetMask(), corrected)
      XCTAssertEqual(removal.detectedPersonMasks.map(\.mask), detected.map(\.mask))
      XCTAssertEqual(try Data(contentsOf: raw), original)
      XCTAssertFalse(FileManager.default.fileExists(atPath: SidecarPath.sidecarURL(for: raw).path))
      let evidence = repository.appendingPathComponent(
        "test-fixtures/raws/removal-photographic/person-choice-runs/\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
      try before.write(to: evidence.appendingPathComponent("before.mimf"))
      try corrected.write(to: evidence.appendingPathComponent("corrected.mimf"))
      try removal.selection.write(to: evidence.appendingPathComponent("selection.mimf"))
      try removal.protection.write(to: evidence.appendingPathComponent("protection.mimf"))
      let report: [String: Any] = [
        "source": try JSONSerialization.jsonObject(
          with: Data(try XCTUnwrap(removal.context).source.utf8)),
        "target": 3, "explicitDuplicateSelections": [3, 10, 15], "changedChoice": 6,
        "beforeDigest": try RemovalBridge.digest(before),
        "correctedDigest": try RemovalBridge.digest(corrected),
        "afterChoiceDigest": try RemovalBridge.digest(targetMask()),
        "selectionDigest": try RemovalBridge.digest(removal.selection),
        "protectionDigest": try RemovalBridge.digest(removal.protection),
        "originalUnchanged": try Data(contentsOf: raw) == original, "releaseQualified": false,
        "scope":
          "Actual native RAW detector/SAM masks and manual painted correction retained across checkbox, pending overlay and exact undo/redo. No automatic duplicate ownership, complete silhouette, live UI, reconstruction quality or performance qualification.",
      ]
      try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        .write(to: evidence.appendingPathComponent("report.json"))
      print("PHOTOGRAPHIC_PERSON_CHOICE_EVIDENCE \(evidence.path)")
      removal.close()
      await session.releaseTransientMemory()
    #else
      throw XCTSkip("macOS photographic person correction qualification")
    #endif
  }

  func testSeparatedInstanceChoicesUseActualModelAndOneDurableKeep() async throws {
    #if os(macOS)
      let repository = (0..<7).reduce(URL(fileURLWithPath: #filePath)) {
        value, _ in value.deletingLastPathComponent()
      }
      let fixture = repository.appendingPathComponent(
        "test-fixtures/raws/removal-photographic/bologna.nef")
      let models = repository.appendingPathComponent("test-fixtures/raws/removal-inference")
      let required = ExperimentalRemovalModels.all.map(\.file) + ["runtime.dylib"]
      guard FileManager.default.fileExists(atPath: fixture.path),
        required.allSatisfy({
          FileManager.default.fileExists(atPath: models.appendingPathComponent($0).path)
        })
      else { throw XCTSkip("Exact Bologna RAW and native pinned model corpus required (#3941)") }
      let original = try Data(contentsOf: fixture)
      XCTAssertEqual(
        try RemovalBridge.digest(original),
        "blake3:2019a5cbd7bcdcf8405528789cde7c05ed4bee8d31c533df786be64f42c97718")
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let raw = directory.appendingPathComponent("photo.nef")
      try original.write(to: raw)
      let session = EditSession(asset: AssetRef(url: raw))
      let removal = RemovalSession(
        session: session,
        modelStore: MacRemovalModelStore(root: directory.appendingPathComponent("models")))
      await removal.open()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      await removal.setMode(.people)
      await removal.chooseModelFolder(models)
      XCTAssertEqual(removal.phase, .ready, removal.message)
      let context = try XCTUnwrap(removal.context)
      XCTAssertEqual([context.width, context.height], [6000, 4000])
      // Retain the production proxy/tensor, rather than reconstructing SAM's
      // input from a display screenshot when auditing partial person masks.
      let selectionProxy = try await context.saved.selectionProxy(xmp: context.xmp)
      let selectionTensors = try NativeRemovalProxyTensors(
        selectionProxy, width: context.width, height: context.height)
      let encoderBytes = selectionTensors.encoder.withUnsafeBytes { Data($0) }
      XCTAssertEqual(removal.detectedPersonMasks.count, removal.people.count)
      // Actual mask overlap frees the blue-coat proposal from an intersecting
      // foreground box. This is one scene regression, not role-intent truth.
      XCTAssertEqual(removal.people.filter { !$0.keep }.map(\.id), [6])
      XCTAssertEqual(removal.people.first { $0.id == 6 }?.role, .background)
      let detectedMasks = removal.detectedPersonMasks
      let detected = removal.people.map { person -> [String: Any] in
        [
          "id": person.id, "role": person.role.label, "keep": person.keep,
          "bounds": person.detection.bounds, "score": person.detection.score,
        ]
      }
      let engine = NativeRemovalEditorEngine()
      let before = try await engine.review(context)
      let selected = try separatedPeople(removal, source: context.source)
      // Exercise list choices over real detector/SAM instances. Automatic role
      // ownership/closure truth is deliberately not inferred from these masks.
      for person in removal.people where person.keep == selected.contains(person.id) {
        removal.keepPerson(person.id)
      }
      XCTAssertTrue(removal.personChoicesNeedApply)
      XCTAssertTrue(removal.canRemove)
      let sidecar = try XCTUnwrap(session.asset.sidecarURL)
      let started = ContinuousClock.now
      await removal.remove()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertTrue(removal.requiresProtectionReview)
      XCTAssertTrue(removal.proposals.isEmpty)
      XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
      let preparationElapsed = String(describing: started.duration(to: .now))
      let conflicts = removal.personProtectionConflicts
      await removal.removeUnprotectedParts()
      XCTAssertEqual(removal.phase, .review, removal.message)
      XCTAssertFalse(removal.personChoicesNeedApply)
      XCTAssertEqual(removal.proposals.count, 2)
      let review = try XCTUnwrap(removal.preview)
      XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
      XCTAssertFalse(
        FileManager.default.fileExists(
          atPath: directory.appendingPathComponent(".maple/inpaint").path))
      let requests = try removal.proposals.map {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.request.utf8)) as? [String: Any])
      }
      let removeElapsed = String(describing: started.duration(to: .now))
      await removal.keep()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      let accepted = session.model
      let records = try XCTUnwrap(accepted.inpaintRemovals).json
      XCTAssertEqual(
        (try JSONSerialization.jsonObject(with: Data(records.utf8)) as? [Any])?.count, 2)
      XCTAssertEqual(session.undoHistory.count, 1)
      XCTAssertEqual(try XMPParser.parse(data: Data(contentsOf: sidecar)).0, accepted)
      let assets = try await LocalRemovalAssetStore(rawURL: raw).readAssets(records: records)
      XCTAssertEqual(assets.count, 4)
      removal.close()
      let reopened = try await engine.prepare(raw: raw, model: accepted)
      let rendered = try await engine.review(reopened)
      XCTAssertEqual(rendered.width, review.width)
      XCTAssertEqual(rendered.height, review.height)
      XCTAssertEqual(rendered.bytes, review.bytes, "Reopen must use saved pixels without models")
      session.undo()
      await session.flushPendingSidecarWrite()
      XCTAssertNil(session.model.inpaintRemovals)
      session.redo()
      await session.flushPendingSidecarWrite()
      XCTAssertEqual(session.model, accepted)
      XCTAssertEqual(try Data(contentsOf: raw), original)
      // Retain local, gitignored evidence for photographic inspection. Native
      // RGB8 review bytes are recorded directly; no image conversion in tests.
      let evidence = repository.appendingPathComponent(
        "test-fixtures/raws/removal-photographic/group-runs/\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
      for (name, image) in [("before", before), ("review", review), ("reopened", rendered)] {
        try Data(image.bytes).write(to: evidence.appendingPathComponent("\(name).rgb8"))
      }
      for (name, bytes) in assets { try bytes.write(to: evidence.appendingPathComponent(name)) }
      // Preserve the actual masks before kept-instance protection clips them.
      // Pairwise ownership/duplicate diagnostics must use these inputs, not
      // reconstruct selections from detector rectangles or accepted hole masks.
      for person in detectedMasks {
        try person.mask.write(to: evidence.appendingPathComponent("detected-\(person.id).mimf"))
      }
      try Data(selectionProxy.bytes).write(
        to: evidence.appendingPathComponent("selection-proxy.rgb8"))
      try encoderBytes.write(to: evidence.appendingPathComponent("selection-encoder.f32"))
      try Data(contentsOf: sidecar).write(to: evidence.appendingPathComponent("photo.xmp"))
      let report: [String: Any] = [
        "source": try JSONSerialization.jsonObject(with: Data(context.source.utf8)),
        "selectionInput": [
          "proxySize": [selectionProxy.width, selectionProxy.height],
          "proxyDigest": try RemovalBridge.digest(Data(selectionProxy.bytes)),
          "encoderDigest": try RemovalBridge.digest(encoderBytes),
          "contentSize": [selectionTensors.inputWidth, selectionTensors.inputHeight],
          "encoderShape": [1, 3, 1024, 1024], "encoderDomain": "RGB float32 LE 0..255",
        ],
        "detected": detected, "selected": selected, "requests": requests,
        "detectedMasks": try detectedMasks.map {
          [
            "id": $0.id, "file": "detected-\($0.id).mimf",
            "digest": try RemovalBridge.digest($0.mask),
          ] as [String: Any]
        },
        "removeElapsed": removeElapsed, "reviewSize": [review.width, review.height],
        "preparationElapsed": preparationElapsed,
        "protectionReview": conflicts.map {
          [
            "person": $0.id, "keptPeople": $0.keptPersonIDs, "manual": $0.manualProtection,
            "fullyProtected": $0.fullyProtected, "detail": $0.detail,
          ] as [String: Any]
        },
        "beforeSize": [before.width, before.height],
        "records": try JSONSerialization.jsonObject(
          with: Data(records.utf8)),
        "assets": try assets.mapValues { try RemovalBridge.digest($0) },
        "reviewDigest": try RemovalBridge.digest(Data(review.bytes)),
        "reopenedDigest": try RemovalBridge.digest(Data(rendered.bytes)),
        "originalUnchanged": true, "undoSteps": session.undoHistory.count,
        "releaseQualified": false,
        "scope":
          "Actual photographic detection/SAM, explicit list choices, protection-conflict pause and explicit partial-removal choice, native planner/default masks, two sequential deployed model jobs, review and one durable Keep with sidecar/companions, undo/redo and byte-exact reopening. Native UI, automatic role/closure quality, photographic fills and supported-device performance are not qualified.",
      ]
      try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        .write(to: evidence.appendingPathComponent("report.json"))
      print("PHOTOGRAPHIC_GROUP_EVIDENCE \(evidence.path)")
      await session.releaseTransientMemory()
    #else
      throw XCTSkip("macOS photographic native group qualification")
    #endif
  }
}
