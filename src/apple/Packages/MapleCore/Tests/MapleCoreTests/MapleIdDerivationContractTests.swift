// MapleIdDerivationContractTests.swift — the cross-client maple_id derivation
// corpus (#5079). `test-fixtures/ids/derivation.json` lists files whose capture
// date and id the server's `readExif` / `deriveId` produced; the API, raw-core
// and web suites pin the same file. Each case runs through the real
// FilesystemSource, so the id is what a device mints for the same bytes.

import XCTest

@testable import MapleCore

final class MapleIdDerivationContractTests: XCTestCase {
  private struct Corpus: Decodable {
    struct Case: Decodable {
      let file: String
      let capturedAt: String?
      let id: String
      let optional: Bool?
    }
    let cases: [Case]
  }

  private func corpus() throws -> Corpus {
    let url = try WorkflowFixture.root().appendingPathComponent("ids/derivation.json")
    return try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: url))
  }

  func testFilesystemSourceMintsTheCorpusIds() async throws {
    // The source lists only the extensions it browses; a WebP is dated by
    // `testCapturedAtMatchesTheCorpusDates` instead.
    let listed = try corpus().cases.filter {
      $0.optional != true
        && SupportedImageExtensions.all.contains(($0.file as NSString).pathExtension.lowercased())
    }
    let folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-id-derivation-contract-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let fixtures = try WorkflowFixture.root().appendingPathComponent("ids")
    for entry in listed {
      try FileManager.default.copyItem(
        at: fixtures.appendingPathComponent(entry.file),
        to: folder.appendingPathComponent(entry.file))
    }

    let source = FilesystemSource()
    try await source.open(folderURL: folder)
    let ids = Dictionary(
      uniqueKeysWithValues: try await source.images().map {
        ($0.url?.lastPathComponent ?? "", $0.id)
      })

    for entry in listed {
      XCTAssertEqual(ids[entry.file], entry.id, entry.file)
    }
  }

  func testCapturedAtMatchesTheCorpusDates() async throws {
    let fixtures = try WorkflowFixture.root().appendingPathComponent("ids")
    for entry in try corpus().cases {
      let url = fixtures.appendingPathComponent(entry.file)
      // Optional cases are gitignored RAWs; skip them when they are absent.
      if entry.optional == true, !FileManager.default.fileExists(atPath: url.path) { continue }
      let capturedAt = try await ByteRangeReader.withFile(at: url) { reader in
        try await MapleIdDerivation.capturedAt(fileExtension: url.pathExtension, reader: reader)
      }
      XCTAssertEqual(capturedAt, entry.capturedAt, entry.file)
    }
  }
}
