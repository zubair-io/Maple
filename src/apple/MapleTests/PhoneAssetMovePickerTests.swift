#if os(iOS)
  import MapleCore
  import XCTest

  @testable import Maple

  final class PhoneAssetMovePickerTests: XCTestCase {
    func testLocalSelectionMustStayInsideAuthorizedRoot() {
      let source = PhoneAssetMoveSource.local(
        rootURL: URL(fileURLWithPath: "/Library/Photos"), rootBookmark: Data([1]))
      let inside = AssetRef(url: URL(fileURLWithPath: "/Library/Photos/Trip/a.dng"))
      let sibling = AssetRef(url: URL(fileURLWithPath: "/Library/Photos-Other/b.dng"))

      XCTAssertTrue(PhoneAssetMoveEligibility.canMove([inside], from: source))
      XCTAssertFalse(PhoneAssetMoveEligibility.canMove([inside, sibling], from: source))
      XCTAssertNil(source.destination(at: "/Library/Photos-Other"))
      XCTAssertNotNil(source.destination(at: "/Library/Photos/Trip"))
    }

    func testNoEmptyOrUnauthenticatedLocalMove() {
      let source = PhoneAssetMoveSource.local(
        rootURL: URL(fileURLWithPath: "/Photos"), rootBookmark: Data())
      XCTAssertFalse(PhoneAssetMoveEligibility.canMove([], from: source))
      XCTAssertFalse(
        PhoneAssetMoveEligibility.canMove(
          [AssetRef(url: URL(fileURLWithPath: "/Photos/a.dng"))], from: source))
    }

    func testCloudMoveRejectsCrossLibraryAndDifferentServer() {
      let source = PhoneAssetMoveSource.cloud(
        server: URL(string: "https://maple.example")!, libraryFolderID: "library-a",
        libraryRootPath: "/shares/a")
      let same = cloudAsset(server: "https://maple.example", folderID: "library-a")
      let otherLibrary = cloudAsset(server: "https://maple.example", folderID: "library-b")
      let otherServer = cloudAsset(server: "https://other.example", folderID: "library-a")

      XCTAssertTrue(PhoneAssetMoveEligibility.canMove([same], from: source))
      XCTAssertFalse(PhoneAssetMoveEligibility.canMove([same, otherLibrary], from: source))
      XCTAssertFalse(PhoneAssetMoveEligibility.canMove([otherServer], from: source))
      XCTAssertNil(source.destination(at: "/shares/b"))
      XCTAssertNotNil(source.destination(at: "/shares/a/Trip"))
    }

    func testDirectChildRequiresOneVisibleLevel() {
      XCTAssertTrue(PhoneAssetMoveEligibility.isDirectChild("/Photos/Trip", of: "/Photos"))
      XCTAssertFalse(PhoneAssetMoveEligibility.isDirectChild("/Photos/Trip/Day", of: "/Photos"))
      XCTAssertFalse(PhoneAssetMoveEligibility.isDirectChild("/Photos/.maple", of: "/Photos"))
      XCTAssertTrue(PhoneAssetMoveEligibility.isWithin("/Photos/Trip", root: "/"))
      XCTAssertFalse(PhoneAssetMoveEligibility.isWithin("../Photos/Trip", root: "/Photos"))
    }

    func testPhotoKitCannotMoveIntoCloud() {
      let source = PhoneAssetMoveSource.cloud(
        server: URL(string: "https://maple.example")!, libraryFolderID: "library-a",
        libraryRootPath: "/shares/a")
      let photoKitAsset = AssetRef(
        displayName: "image.dng", hintExtension: "dng", stableID: "ph-id",
        thumbnailProvenance: .photoKit, bytesProvider: { Data() })

      XCTAssertFalse(PhoneAssetMoveEligibility.canMove([photoKitAsset], from: source))
      XCTAssertNil(source.destination(at: "/Trip"))
    }

    private func cloudAsset(server: String, folderID: String) -> AssetRef {
      AssetRef(
        displayName: "image.dng", hintExtension: "dng", stableID: "asset-id",
        catalog: CatalogRef(
          serverID: URL(string: server)!, folderID: folderID,
          absPath: "/shares/a/image.dng", address: nil),
        bytesProvider: { Data() })
    }
  }
#endif
