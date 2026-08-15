// ImportsTests.swift
//
// Wire shapes and the client-side rules for the Imports wizard (#2773).
//
// The two rules that carry real risk: a blank bucket label must never
// reach the create request (it means "use the default," not "override to
// an empty string"), and the source-inside-library check is asymmetric —
// it must reject the library and everything inside it while still allowing
// ancestors like `/`.

import XCTest

@testable import MapleCore

// MARK: - Wire decode

final class ImportsModelsDecodeTests: XCTestCase {

  func test_decode_scanResult_camelCaseBucketsSnakeCaseRoot() throws {
    let json = """
      {"source_root":"/mnt/sd","buckets":[
        {"key":"2026/07","year":"2026","mm":"07","fileCount":12,"imageCount":10,
         "movieCount":1,"sidecarCount":1,"totalBytes":1048576,
         "defaultDest":"2026/misc/sd","nearbyMatchCount":3,
         "nearbyMatchFolders":["2026/Wedding"]}],
       "totals":{"files":12,"images":10,"movies":1,"sidecars":1,"bytes":1048576}}
      """
    let result = try JSONDecoder().decode(ImportScanResult.self, from: Data(json.utf8))
    XCTAssertEqual(result.sourceRoot, "/mnt/sd")
    XCTAssertEqual(result.totals.files, 12)
    let bucket = try XCTUnwrap(result.buckets.first)
    XCTAssertEqual(bucket.key, "2026/07")
    XCTAssertEqual(bucket.defaultDest, "2026/misc/sd")
    XCTAssertEqual(bucket.nearbyMatchCount, 3)
    XCTAssertEqual(bucket.nearbyMatchFolders, ["2026/Wedding"])
  }

  func test_decode_dirListing_ignoresImagesField() throws {
    // The real /api/fs/dir-fast response also carries `images`; the
    // picker never reads it, so the type must decode fine without it.
    let json = """
      {"path":"/mnt","parent":"/","dirs":[{"name":"sd","path":"/mnt/sd","mtime":"2026-01-01T00:00:00.000Z"}],
       "images":[{"name":"a.jpg","path":"/mnt/a.jpg","size":1,"mtime":"2026-01-01T00:00:00.000Z","ext":"jpg"}]}
      """
    let listing = try JSONDecoder().decode(ImportsDirListing.self, from: Data(json.utf8))
    XCTAssertEqual(listing.path, "/mnt")
    XCTAssertEqual(listing.parent, "/")
    XCTAssertEqual(listing.dirs.first?.name, "sd")
  }

  func test_decode_dirListing_nullParentMeansJailRoot() throws {
    let json = #"{"path":"/","parent":null,"dirs":[],"images":[]}"#
    let listing = try JSONDecoder().decode(ImportsDirListing.self, from: Data(json.utf8))
    XCTAssertNil(listing.parent)
  }

  func test_decode_summary_snakeCaseFields() throws {
    let json = """
      {"id":"64f0","status":"running","source_root":"/mnt/sd","library_id":"64a1",
       "library_root":"/photos","scan_pending":false,"progress":{"current":5,"total":20},
       "counts":{"copied":4,"skipped":1,"failed":0},"error":null,
       "cancel_requested":false,"created_at":"2026-08-01T00:00:00.000Z",
       "updated_at":"2026-08-01T00:00:05.000Z"}
      """
    let summary = try JSONDecoder().decode(ImportSummary.self, from: Data(json.utf8))
    XCTAssertEqual(summary.id, "64f0")
    XCTAssertEqual(summary.status, .running)
    XCTAssertEqual(summary.libraryID, "64a1")
    XCTAssertEqual(summary.libraryRoot, "/photos")
    XCTAssertFalse(summary.scanPending)
    XCTAssertEqual(summary.percent, 25)
    XCTAssertFalse(summary.isTerminal)
    XCTAssertFalse(summary.isRetryable)
  }
}

// MARK: - ImportSummary derived rules

final class ImportsSummaryDerivedTests: XCTestCase {

  private func summary(
    status: ImportStatus, current: Int = 0, total: Int = 0, failed: Int = 0
  ) -> ImportSummary {
    let json = """
      {"id":"1","status":"\(status.rawValue)","source_root":"/s","library_id":"l",
       "library_root":"/lib","scan_pending":false,
       "progress":{"current":\(current),"total":\(total)},
       "counts":{"copied":0,"skipped":0,"failed":\(failed)},"error":null,
       "cancel_requested":false,"created_at":"x","updated_at":"x"}
      """
    return try! JSONDecoder().decode(ImportSummary.self, from: Data(json.utf8))
  }

  func test_percent_zeroWhenTotalIsZero() {
    XCTAssertEqual(summary(status: .pending, current: 0, total: 0).percent, 0)
  }

  func test_percent_roundsToNearestInt() {
    XCTAssertEqual(summary(status: .running, current: 1, total: 3).percent, 33)
  }

  func test_isTerminal_trueForDoneFailedCancelled() {
    XCTAssertTrue(summary(status: .done).isTerminal)
    XCTAssertTrue(summary(status: .failed).isTerminal)
    XCTAssertTrue(summary(status: .cancelled).isTerminal)
  }

  func test_isTerminal_falseForPendingRunning() {
    XCTAssertFalse(summary(status: .pending).isTerminal)
    XCTAssertFalse(summary(status: .running).isTerminal)
  }

  func test_isRetryable_alwaysTrueForFailed() {
    XCTAssertTrue(summary(status: .failed, failed: 0).isRetryable)
  }

  func test_isRetryable_doneOnlyWhenFailedFilesRemain() {
    XCTAssertFalse(summary(status: .done, failed: 0).isRetryable)
    XCTAssertTrue(summary(status: .done, failed: 2).isRetryable)
  }

  func test_isRetryable_falseWhileRunning() {
    XCTAssertFalse(summary(status: .running, failed: 3).isRetryable)
  }
}

// MARK: - Source-inside-library guard

final class ImportSourceGuardTests: XCTestCase {

  func test_rejectsTheLibraryItself() {
    XCTAssertTrue(ImportSourceGuard.isInsideLibrary(source: "/photos", library: "/photos"))
  }

  func test_rejectsAFolderInsideTheLibrary() {
    XCTAssertTrue(
      ImportSourceGuard.isInsideLibrary(source: "/photos/2026/07", library: "/photos"))
  }

  func test_allowsAnAncestorOfTheLibraryIncludingRoot() {
    // The asymmetric part: `/` is an ancestor of every library, and must
    // stay browsable/usable as a source.
    XCTAssertFalse(ImportSourceGuard.isInsideLibrary(source: "/", library: "/photos"))
    XCTAssertFalse(ImportSourceGuard.isInsideLibrary(source: "/mnt", library: "/mnt/photos"))
  }

  func test_doesNotFalsePositiveOnASiblingWithASharedPrefix() {
    // "/ab" must not be treated as inside "/a".
    XCTAssertFalse(ImportSourceGuard.isInsideLibrary(source: "/ab", library: "/a"))
  }

  func test_toleratesTrailingSlashesOnEitherSide() {
    XCTAssertTrue(ImportSourceGuard.isInsideLibrary(source: "/photos/", library: "/photos"))
    XCTAssertTrue(ImportSourceGuard.isInsideLibrary(source: "/photos", library: "/photos/"))
  }

  func test_disjointPathsAreAllowed() {
    XCTAssertFalse(ImportSourceGuard.isInsideLibrary(source: "/mnt/sd", library: "/photos"))
  }
}

// MARK: - Review form (blank-label contract)

final class ImportsReviewFormTests: XCTestCase {

  private let bucket = ImportScanBucket(
    key: "2026/07", year: "2026", mm: "07", fileCount: 3, imageCount: 2, movieCount: 0,
    sidecarCount: 1, totalBytes: 100, defaultDest: "2026/misc/sd", nearbyMatchCount: 2,
    nearbyMatchFolders: ["2026/Wedding"])

  func test_bucketsStartWithNoLabel_notPrefilledWithTheMonth() {
    let form = ImportReviewForm()
    XCTAssertEqual(form.label(for: bucket.key), "")
    XCTAssertNotEqual(form.label(for: bucket.key), bucket.mm)
  }

  func test_requestLabels_omitsBlankEntries() {
    var form = ImportReviewForm()
    form.setLabel("", for: "2026/07")
    form.setLabel("   ", for: "2026/08")
    XCTAssertNil(form.requestLabels())
  }

  func test_requestLabels_omitsOnlyTheBlankKeysAmongMultiple() {
    var form = ImportReviewForm()
    form.setLabel("", for: "2026/07")
    form.setLabel("Wedding", for: "2026/08")
    let labels = try! XCTUnwrap(form.requestLabels())
    XCTAssertEqual(labels, ["2026/08": "Wedding"])
  }

  func test_requestLabels_trimsWhitespaceAroundAKeptValue() {
    var form = ImportReviewForm()
    form.setLabel("  Wedding  ", for: "2026/07")
    XCTAssertEqual(form.requestLabels(), ["2026/07": "Wedding"])
  }

  func test_requestLabels_nilWhenEverythingIsBlank() {
    XCTAssertNil(ImportReviewForm().requestLabels())
  }

  func test_hasOverride_falseUntilANonBlankLabelIsTyped() {
    var form = ImportReviewForm()
    XCTAssertFalse(form.hasOverride(for: bucket))
    form.setLabel("   ", for: bucket.key)
    XCTAssertFalse(form.hasOverride(for: bucket))
    form.setLabel("Wedding", for: bucket.key)
    XCTAssertTrue(form.hasOverride(for: bucket))
  }

  func test_effectiveDest_isTheServerDefaultWithoutAnOverride() {
    XCTAssertEqual(ImportReviewForm().effectiveDest(for: bucket), bucket.defaultDest)
  }

  func test_effectiveDest_reflectsATypedOverride() {
    var form = ImportReviewForm()
    form.setLabel("Wedding", for: bucket.key)
    XCTAssertEqual(form.effectiveDest(for: bucket), "2026/Wedding")
  }
}

// MARK: - Request body encoding

final class ImportsRequestEncodingTests: XCTestCase {

  private func encoded<T: Encodable>(_ value: T) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func test_scanRequest_omitsLibraryIDWhenNil() throws {
    let obj = try encoded(ImportScanRequest(sourceRoot: "/mnt/sd", libraryID: nil))
    XCTAssertFalse(obj.keys.contains("library_id"))
    XCTAssertEqual(obj["source_root"] as? String, "/mnt/sd")
  }

  func test_scanRequest_includesLibraryIDWhenPresent() throws {
    let obj = try encoded(ImportScanRequest(sourceRoot: "/mnt/sd", libraryID: "64a1"))
    XCTAssertEqual(obj["library_id"] as? String, "64a1")
  }

  func test_createRequest_manualPathOmitsAuto() throws {
    let obj = try encoded(
      ImportCreateRequest(
        sourceRoot: "/mnt/sd", libraryID: "64a1", labels: ["2026/07": "Wedding"], auto: nil))
    XCTAssertFalse(obj.keys.contains("auto"))
    XCTAssertEqual((obj["labels"] as? [String: String])?["2026/07"], "Wedding")
  }

  func test_createRequest_autoPathOmitsLabels() throws {
    let obj = try encoded(
      ImportCreateRequest(sourceRoot: "/mnt/sd", libraryID: "64a1", labels: nil, auto: true))
    XCTAssertFalse(obj.keys.contains("labels"))
    XCTAssertEqual(obj["auto"] as? Bool, true)
  }

  func test_createRequest_omitsLabelsWhenNoOverridesEvenOnManualPath() throws {
    // A manual import with every bucket left blank: labels() -> nil, so
    // the create body must omit the key entirely, not send `{}`.
    let obj = try encoded(
      ImportCreateRequest(sourceRoot: "/mnt/sd", libraryID: "64a1", labels: nil, auto: nil))
    XCTAssertFalse(obj.keys.contains("labels"))
    XCTAssertFalse(obj.keys.contains("auto"))
  }
}
