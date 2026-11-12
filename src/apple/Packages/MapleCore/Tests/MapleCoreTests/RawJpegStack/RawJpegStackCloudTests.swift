import XCTest

@testable import MapleCore

/// #5050: the Self Hosted listing's `stack.companion` decodes onto the RAW's tile, and the
/// display config round-trips `stack_raw_jpeg`.
final class RawJpegStackCloudTests: XCTestCase {
  private let listingJSON = """
    {"path":"/srv/photos/Library/Trip","parentPath":"/srv/photos/Library","folders":[],
     "images":[
      {"name":"IMG_1.CR3","path":"/srv/photos/Library/Trip/IMG_1.CR3","mtime":"2026-01-01T00:00:00Z",
       "size":300,"ext":"cr3",
       "stack":{"companion":{"name":"IMG_1.JPG","address":"lib:Trip/IMG_1.JPG",
         "path":"/srv/photos/Library/Trip/IMG_1.JPG","size":120,"mtime":"2026-01-01T00:00:00Z",
         "ext":"jpg","id":"0123456789abcdef01234567"}}},
      {"name":"IMG_2.CR3","path":"/srv/photos/Library/Trip/IMG_2.CR3","mtime":"2026-01-01T00:00:00Z",
       "size":50,"ext":"cr3"}]}
    """

  private func listing() throws -> FsDirListing {
    try JSONDecoder().decode(FsDirListing.self, from: Data(listingJSON.utf8))
  }

  func testTheListingDecodesTheCompanionOnTheRawEntryOnly() throws {
    let images = try listing().images

    XCTAssertEqual(images[0].stack?.companion.name, "IMG_1.JPG")
    XCTAssertEqual(images[0].stack?.companion.address, "lib:Trip/IMG_1.JPG")
    XCTAssertEqual(images[0].stack?.companion.size, 120)
    XCTAssertEqual(images[0].stack?.companion.id, "0123456789abcdef01234567")
    XCTAssertNil(images[1].stack)
  }

  func testACompanionNotYetIndexedDecodesWithoutAnID() throws {
    let json = """
      {"name":"IMG_1.CR3","path":"/l/IMG_1.CR3","mtime":"2026-01-01T00:00:00Z","size":1,"ext":"cr3",
       "stack":{"companion":{"name":"IMG_1.JPG","address":"lib:IMG_1.JPG","path":"/l/IMG_1.JPG",
         "size":2,"mtime":"2026-01-01T00:00:00Z","ext":"jpg"}}}
      """

    let entry = try JSONDecoder().decode(FsImageEntry.self, from: Data(json.utf8))

    XCTAssertNil(entry.stack?.companion.id)
  }

  func testTheRawsStackCarriesBothFilesAndTheCompanionsServerLocation() throws {
    let entry = try XCTUnwrap(listing().images.first)

    let stack = try XCTUnwrap(RawJpegStacking.cloudStack(for: entry))

    XCTAssertEqual(stack.primary, .init(name: "IMG_1.CR3", size: 300))
    XCTAssertEqual(stack.companion, .init(name: "IMG_1.JPG", size: 120))
    XCTAssertEqual(
      stack.location,
      .cloud(
        address: "lib:Trip/IMG_1.JPG", path: "/srv/photos/Library/Trip/IMG_1.JPG",
        id: "0123456789abcdef01234567"))
  }

  func testRenamingTheRawMovesTheCompanionsAddressAndPathToTheNewStem() throws {
    let entry = try XCTUnwrap(listing().images.first)
    let stack = try XCTUnwrap(RawJpegStacking.cloudStack(for: entry))
    let response = try JSONDecoder().decode(
      RenameAssetResponse.self,
      from: Data(
        """
        {"new_abs_path":"/srv/photos/Library/Trip/Beach.CR3","new_path":"Trip/Beach.CR3",
         "new_filename":"Beach.CR3","renamed_on_collision":false,"extension_changed":false}
        """.utf8))

    let renamed = stack.relocatedCloud(afterRenameTo: response)

    XCTAssertEqual(renamed.primary.name, "Beach.CR3")
    XCTAssertEqual(renamed.companion.name, "Beach.JPG")
    XCTAssertEqual(
      renamed.location,
      .cloud(
        address: "lib:Trip/Beach.JPG", path: "/srv/photos/Library/Trip/Beach.JPG",
        id: "0123456789abcdef01234567"))
  }

  func testDisplayConfigDecodesTheStackSwitch() throws {
    let config = try JSONDecoder().decode(
      DisplayConfig.self,
      from: Data(#"{"show_hidden_images":false,"stack_raw_jpeg":true}"#.utf8))

    XCTAssertEqual(config, DisplayConfig(showHiddenImages: false, stackRawJpeg: true))
  }

  func testTheDisplayConfigPatchSendsOnlyTheSwitchItChanges() throws {
    let data = try JSONEncoder().encode(DisplayConfigPatch(stackRawJpeg: false))

    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(object["stack_raw_jpeg"] as? Bool, false)
    XCTAssertNil(object["show_hidden_images"])
  }
}
