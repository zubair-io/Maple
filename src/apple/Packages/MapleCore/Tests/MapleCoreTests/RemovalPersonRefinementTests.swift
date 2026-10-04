import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class RemovalPersonRefinementTests: XCTestCase {
  private func circle(_ x: Double, _ y: Double, radius: Double = 0.07) throws -> Data {
    try RemovalBridge.selection(
      width: 16, height: 8,
      request:
        "{\"schema\":1,\"strokes\":[{\"points\":[[\(x),\(y)]],\"radius\":\(radius),\"subtract\":false}]}"
    )
  }

  func testMaskRolesDistinguishIntersectingBoxesFromActualProtectionOverlap() async throws {
    let people = [
      RemovalSession.Person(
        id: 1, detection: NativeRemovalDetection(class: 0, bounds: [0, 0, 8, 8], score: 0.98),
        keep: true),
      RemovalSession.Person(
        id: 2, detection: NativeRemovalDetection(class: 0, bounds: [6, 2, 7, 5], score: 0.92),
        keep: true),
    ]
    let left = try circle(3.5 / 16, 3.5 / 8)
    let right = try circle(6.5 / 16, 3.5 / 8)
    let engine = NativeRemovalEditorEngine()
    let disjoint = try await engine.peopleMaskSuggestions(
      people, masks: [.init(id: 1, mask: left), .init(id: 2, mask: right)], width: 16, height: 8)
    XCTAssertEqual(disjoint.map(\.id), [1, 2])
    XCTAssertEqual(disjoint.map(\.role), [.subject, .background])
    XCTAssertEqual(disjoint.map(\.keep), [true, false])
    let overlapping = try await engine.peopleMaskSuggestions(
      people, masks: [.init(id: 1, mask: left), .init(id: 2, mask: left)], width: 16, height: 8)
    XCTAssertEqual(overlapping.map(\.role), [.subject, .uncertain])
    XCTAssertEqual(overlapping.map(\.keep), [true, true])
    let missingSubject = try await engine.peopleMaskSuggestions(
      people, masks: [.init(id: 1, mask: Data()), .init(id: 2, mask: right)], width: 16, height: 8)
    XCTAssertEqual(missingSubject.map(\.keep), [true, true])
    XCTAssertTrue(people.allSatisfy(\.keep))
  }

  func testPersonRefinementKeepsIndependentWindowsAndProtectedPixelsWithUndoRedo() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixture = try XCTUnwrap(
      Bundle.module.url(
        forResource: "source", withExtension: "dng", subdirectory: "removal/calibration"))
    let raw = directory.appendingPathComponent("photo.dng")
    try FileManager.default.copyItem(at: fixture, to: raw)
    let original = try Data(contentsOf: raw)
    let session = EditSession(asset: AssetRef(url: raw))
    let removal = RemovalSession(session: session)
    await removal.open()
    XCTAssertEqual(removal.phase, .ready, removal.message)
    await removal.setMode(.people)
    let left = try circle(3.5 / 16, 3.5 / 8)
    let right = try circle(12.5 / 16, 3.5 / 8)
    removal.personMasks = [left, right]
    removal.selection = try RemovalBridge.combineMasks(left, right)
    removal.resetPersonRefinement([
      RemovalPersonSelection(id: 1, mask: left), RemovalPersonSelection(id: 2, mask: right),
    ])
    removal.protection = try circle(7.5 / 16, 3.5 / 8)
    let initial = removal.selection
    removal.refinePerson(1)
    removal.radius = 0.07
    await removal.paint([[3.5 / 16, 6.5 / 8]], cropInputSize: [16, 8])
    let added = removal.selection
    XCTAssertNotEqual(added, initial)
    XCTAssertEqual(removal.personMasks.count, 2)
    XCTAssertEqual(
      removal.personMasks[1], right, "The other person's native window stays unchanged")
    await removal.undoSelection()
    XCTAssertEqual(removal.selection, initial)
    await removal.redoSelection()
    XCTAssertEqual(removal.selection, added)
    await removal.paint([[7.5 / 16, 3.5 / 8]], cropInputSize: [16, 8])
    XCTAssertTrue(
      try RemovalBridge.combineMasks(removal.selection, removal.protection, subtract: true)
        == removal.selection)
    removal.refinePerson(2)
    removal.subtract = true
    await removal.paint([[12.5 / 16, 3.5 / 8]], cropInputSize: [16, 8])
    XCTAssertEqual(removal.personMasks.count, 1)
    await removal.undoSelection()
    XCTAssertEqual(
      removal.personMasks.count, 2, "Undo targets the correct person after switching refinement")
    let confirmedSelection = removal.selection
    let confirmedGestures = removal.personGestures.count
    let confirmedRedo = removal.redoPersonGestures.count
    removal.personBases = [RemovalPersonSelection(id: 1, mask: Data([0]))]
    removal.refinePerson(1)
    await removal.paint([[0.5, 0.5]], cropInputSize: [16, 8])
    XCTAssertEqual(removal.phase, .ready)
    XCTAssertFalse(removal.message.isEmpty)
    XCTAssertEqual(removal.selection, confirmedSelection)
    XCTAssertEqual(removal.personGestures.count, confirmedGestures)
    XCTAssertEqual(removal.redoPersonGestures.count, confirmedRedo)
    removal.personBases = [
      RemovalPersonSelection(id: 1, mask: left), RemovalPersonSelection(id: 2, mask: right),
    ]
    await removal.redoSelection()
    XCTAssertTrue(removal.message.isEmpty)
    XCTAssertEqual(removal.personMasks.count, 1)
    await removal.undoSelection()
    XCTAssertTrue(removal.message.isEmpty)
    XCTAssertEqual(removal.selection, confirmedSelection)
    removal.refinePerson(nil)
    XCTAssertFalse(removal.canPaint)
    XCTAssertTrue(removal.canUndoSelection)
    removal.cancel()
    XCTAssertNil(removal.preview)
    XCTAssertEqual(try Data(contentsOf: raw), original)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: directory.appendingPathComponent("photo.xmp").path))
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: directory.appendingPathComponent(".maple/inpaint").path))
    removal.close()
    XCTAssertFalse(removal.canUndoSelection)
    await session.releaseTransientMemory()
  }

  func testInvalidRefinementLeavesPreviousMaskUntouched() throws {
    let base = try circle(0.5, 0.5)
    XCTAssertThrowsError(
      try RemovalBridge.refineSelection(
        base, strokes: [RemovalStroke(points: [], radius: 0.1, subtract: false)]))
    XCTAssertEqual(try RemovalBridge.refineSelection(base, strokes: []), base)
  }

  func testChangingAnotherPersonChoicePreservesRefinementAndItsUndoRedo() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixture = try XCTUnwrap(
      Bundle.module.url(
        forResource: "source", withExtension: "dng", subdirectory: "removal/calibration"))
    let raw = directory.appendingPathComponent("photo.dng")
    try FileManager.default.copyItem(at: fixture, to: raw)
    let original = try Data(contentsOf: raw)
    let session = EditSession(asset: AssetRef(url: raw))
    let removal = RemovalSession(session: session)
    await removal.open()
    await removal.setMode(.people)
    let left = try circle(3.5 / 16, 3.5 / 8)
    let right = try circle(12.5 / 16, 3.5 / 8)
    removal.people = (1...2).map {
      RemovalSession.Person(
        id: $0, detection: NativeRemovalDetection(class: 0, bounds: [0, 0, 16, 8], score: 0.9),
        keep: false)
    }
    removal.detectedPersonMasks = [.init(id: 1, mask: left), .init(id: 2, mask: right)]
    removal.personChoicesNeedApply = true
    await removal.beginPersonRefinement(1)
    removal.radius = 0.07
    await removal.paint([[3.5 / 16, 6.5 / 8]], cropInputSize: [16, 8])
    let refinedLeft = try RemovalBridge.refineSelection(
      left, strokes: [RemovalStroke(points: [[3.5 / 16, 6.5 / 8]], radius: 0.07, subtract: false)])
    XCTAssertEqual(removal.personMasks[0], refinedLeft)
    removal.keepPerson(2)
    let pending = try await removal.overlay(cropInputSize: [16, 8], aspect: 2)
    XCTAssertEqual(pending.selection[(104 * 256 + 56) * 4 + 3], 255)
    XCTAssertEqual(pending.protection[(56 * 256 + 200) * 4 + 3], 255)
    await removal.beginPersonRefinement(1)
    XCTAssertEqual(removal.phase, .ready, removal.message)
    XCTAssertEqual(removal.selection, refinedLeft, "Another checkbox cannot discard painted edges")
    XCTAssertEqual(removal.protection, right)
    XCTAssertTrue(removal.canUndoSelection)
    await removal.undoSelection()
    XCTAssertEqual(removal.selection, left)
    XCTAssertEqual(removal.protection, right, "Selection undo cannot undo list choices")
    await removal.redoSelection()
    XCTAssertEqual(removal.selection, refinedLeft)
    // Undo/redo also apply a pending checkbox change before replaying a brush.
    removal.keepPerson(2)
    await removal.undoSelection()
    XCTAssertEqual(removal.selection, try RemovalBridge.combineMasks(left, right))
    removal.keepPerson(2)
    await removal.redoSelection()
    XCTAssertEqual(removal.selection, refinedLeft)
    XCTAssertEqual(removal.detectedPersonMasks.map(\.mask), [left, right])
    XCTAssertEqual(try Data(contentsOf: raw), original)
    XCTAssertFalse(FileManager.default.fileExists(atPath: SidecarPath.sidecarURL(for: raw).path))
    removal.close()
    await session.releaseTransientMemory()
  }

  func testRetainedRefinementRechecksChangedProtectionFromOriginalMasks() async throws {
    let left = try circle(3.5 / 16, 3.5 / 8)
    let below = try circle(3.5 / 16, 6.5 / 8)
    let masks = [RemovalPersonSelection(id: 1, mask: left), .init(id: 2, mask: below)]
    let gesture = RemovalPersonGesture(
      id: 1, strokes: [RemovalStroke(points: [[3.5 / 16, 6.5 / 8]], radius: 0.07, subtract: false)])
    let engine = NativeRemovalEditorEngine()
    func choices(keepSecond: Bool) -> [RemovalSession.Person] {
      (1...2).map {
        .init(
          id: $0, detection: .init(class: 0, bounds: [0, 0, 16, 8], score: 0.9),
          keep: $0 == 2 && keepSecond)
      }
    }
    let kept = try await engine.refinedPeopleSelection(
      choices(keepSecond: true), masks: masks, gestures: [gesture], manualProtection: Data())
    XCTAssertEqual(kept.selection, left, "A retained Add cannot paint over a newly kept person")
    XCTAssertEqual(kept.protection, below)
    let removed = try await engine.refinedPeopleSelection(
      choices(keepSecond: false), masks: masks, gestures: [gesture], manualProtection: Data())
    XCTAssertEqual(removed.selection, try RemovalBridge.combineMasks(left, below))
    XCTAssertEqual(removed.people[0], try RemovalBridge.combineMasks(left, below))
    XCTAssertEqual(removed.people[1], below)
    XCTAssertEqual(
      masks.map(\.mask), [left, below], "Replaying choices never rewrites detector masks")
  }

  func testMultiselectMasksKeepUnselectedPeopleAndManualProtection() async throws {
    let left = try circle(3.5 / 16, 3.5 / 8)
    let middle = try circle(7.5 / 16, 3.5 / 8)
    let right = try circle(12.5 / 16, 3.5 / 8)
    let masks = [left, middle, right].enumerated().map {
      RemovalPersonSelection(id: $0.offset + 1, mask: $0.element)
    }
    let people = (1...3).map { id in
      RemovalSession.Person(
        id: id, detection: NativeRemovalDetection(class: 0, bounds: [0, 0, 16, 8], score: 0.9),
        keep: id == 2)
    }
    let result = try await NativeRemovalEditorEngine().peopleSelection(
      people, masks: masks, manualProtection: left)
    XCTAssertEqual(result.selection, right)
    XCTAssertEqual(result.bases.map(\.id), [3])
    XCTAssertEqual(result.protection, try RemovalBridge.combineMasks(left, middle))
    XCTAssertEqual(
      result.conflicts,
      [
        RemovalPersonProtectionConflict(
          id: 1, keptPersonIDs: [], manualProtection: true, fullyProtected: true)
      ])
    XCTAssertEqual(
      masks.map(\.mask), [left, middle, right], "List changes preserve detected masks")
  }

  func testProtectionConflictsNameActualKeptMasksAndPreserveDetectedInputs() async throws {
    let left = try circle(3.5 / 16, 3.5 / 8)
    let middle = try circle(7.5 / 16, 3.5 / 8)
    let target = try RemovalBridge.combineMasks(left, middle)
    let people = (1...3).map { id in
      RemovalSession.Person(
        id: id, detection: NativeRemovalDetection(class: 0, bounds: [0, 0, 16, 8], score: 0.9),
        keep: id != 1)
    }
    let masks = [
      RemovalPersonSelection(id: 1, mask: target),
      RemovalPersonSelection(id: 2, mask: left),
      RemovalPersonSelection(id: 3, mask: try circle(12.5 / 16, 3.5 / 8)),
    ]
    let result = try await NativeRemovalEditorEngine().peopleSelection(
      people, masks: masks, manualProtection: Data())
    XCTAssertEqual(
      result.conflicts,
      [
        RemovalPersonProtectionConflict(
          id: 1, keptPersonIDs: [2], manualProtection: false, fullyProtected: false)
      ])
    XCTAssertTrue(try RemovalBridge.combineMasks(result.selection, middle, subtract: true).isEmpty)
    XCTAssertTrue(try RemovalBridge.combineMasks(middle, result.selection, subtract: true).isEmpty)
    XCTAssertEqual(masks[0].mask, target)
    XCTAssertTrue(result.conflicts[0].detail.contains("Person 2"))
  }

  func testRemoveAppliesChoicesButStopsBeforeModelWorkForProtectedOverlap() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixture = try XCTUnwrap(
      Bundle.module.url(
        forResource: "source", withExtension: "dng", subdirectory: "removal/calibration"))
    let raw = directory.appendingPathComponent("photo.dng")
    try FileManager.default.copyItem(at: fixture, to: raw)
    let original = try Data(contentsOf: raw)
    let session = EditSession(asset: AssetRef(url: raw))
    let removal = RemovalSession(session: session)
    await removal.open()
    await removal.setMode(.people)
    let mask = try circle(0.5, 0.5)
    removal.people = (1...2).map { id in
      RemovalSession.Person(
        id: id, detection: NativeRemovalDetection(class: 0, bounds: [0, 0, 16, 8], score: 0.9),
        keep: true)
    }
    removal.detectedPersonMasks = (1...2).map { RemovalPersonSelection(id: $0, mask: mask) }
    removal.keepPerson(1)
    await removal.remove()
    XCTAssertEqual(removal.phase, .ready, removal.message)
    XCTAssertFalse(removal.personChoicesNeedApply)
    XCTAssertTrue(removal.requiresProtectionReview)
    XCTAssertEqual(
      removal.personProtectionConflicts,
      [
        RemovalPersonProtectionConflict(
          id: 1, keptPersonIDs: [2], manualProtection: false, fullyProtected: true)
      ])
    XCTAssertTrue(removal.selection.isEmpty)
    XCTAssertTrue(removal.proposals.isEmpty)
    XCTAssertFalse(removal.canRefinePerson(1))
    XCTAssertFalse(removal.canRemove)
    await removal.removeUnprotectedParts()
    XCTAssertTrue(removal.proposals.isEmpty)
    removal.keepPerson(2)
    XCTAssertFalse(removal.requiresProtectionReview, "New choices invalidate prior overlap review")
    await removal.remove()
    XCTAssertTrue(removal.personProtectionConflicts.isEmpty)
    XCTAssertFalse(removal.selection.isEmpty)
    XCTAssertTrue(removal.message.contains("Import local AI models"))
    XCTAssertEqual(try Data(contentsOf: raw), original)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: directory.appendingPathComponent("photo.xmp").path))
    removal.close()
    await session.releaseTransientMemory()
  }
}
