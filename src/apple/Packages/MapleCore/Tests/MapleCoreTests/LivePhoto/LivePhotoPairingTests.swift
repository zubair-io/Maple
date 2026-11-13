import Foundation
import XCTest

@testable import MapleCore

final class LivePhotoPairingTests: XCTestCase {
  private struct Corpus: Decodable {
    struct Entry: Decodable {
      struct File: Decodable {
        let path: String
        let contentId: String?
      }

      let name: String
      let files: [File]
      let pairs: [String: Pair]
    }

    struct Pair: Decodable, Equatable {
      let role: String
      let partner: String
    }

    let cases: [Entry]
  }

  func testTheSharedPairingCorpus() throws {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: "live-photo-pairing", withExtension: "json"))
    let corpus = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: url))
    XCTAssertFalse(corpus.cases.isEmpty)

    for entry in corpus.cases {
      let found = LivePhotoPairing.pair(
        entry.files.map { LivePhotoPairing.Candidate(path: $0.path, contentID: $0.contentId) })

      XCTAssertEqual(
        found.mapValues { Corpus.Pair(role: $0.role.rawValue, partner: $0.partner) }, entry.pairs,
        entry.name)
    }
  }

  func testOnlyAStemSharedByAStillAndAClipIsReadForAnIdentifier() async {
    let reads = ReadLog()
    let paths = [
      "/a/IMG_1.HEIC", "/a/IMG_1.MOV",  // nominated
      "/a/IMG_2.MOV",  // orphan clip
      "/a/IMG_3.HEIC",  // orphan still
      "/a/IMG_4.DNG", "/a/IMG_4.MOV",  // not a still
      "/b/IMG_1.MOV",  // same stem, another folder, no still beside it
    ]

    let links = await LivePhotoPairing.links(for: paths) { path in
      await reads.record(path)
      return "ID-0123456789"
    }

    let read = await reads.paths
    XCTAssertEqual(read, ["/a/IMG_1.HEIC", "/a/IMG_1.MOV"])
    XCTAssertEqual(
      links,
      [
        "/a/IMG_1.HEIC": LivePhotoLink(role: .still, partner: "IMG_1.MOV"),
        "/a/IMG_1.MOV": LivePhotoLink(role: .clip, partner: "IMG_1.HEIC"),
      ])
  }

  func testALibraryWithoutLivePhotosCostsNoReads() async {
    let reads = ReadLog()

    let links = await LivePhotoPairing.links(for: ["/a/x.DNG", "/a/y.HEIC", "/a/z.MOV"]) { path in
      await reads.record(path)
      return "ID-0123456789"
    }

    let read = await reads.paths
    XCTAssertTrue(links.isEmpty)
    XCTAssertTrue(read.isEmpty)
  }

  func testAFileWhoseIdentifierCannotBeReadLeavesItsGroupUnpaired() async {
    let links = await LivePhotoPairing.links(for: ["/a/IMG_1.HEIC", "/a/IMG_1.MOV"]) { path in
      path.hasSuffix("HEIC") ? "ID-0123456789" : nil
    }

    XCTAssertTrue(links.isEmpty)
  }
}

private actor ReadLog {
  private var recorded: Set<String> = []
  var paths: [String] { recorded.sorted() }
  func record(_ path: String) { recorded.insert(path) }
}
