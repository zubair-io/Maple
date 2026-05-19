import XCTest
@testable import MapleCore

final class FileProviderIdentifierTests: XCTestCase {
    func testAssetRoundTrip() throws {
        let id = FileProviderIdentifier.asset("650a1b2c3d4e5f6071829304")
        XCTAssertEqual(id.rawValue, "asset/650a1b2c3d4e5f6071829304")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testRootFolderRoundTrip() throws {
        let id = FileProviderIdentifier.folder(folderID: "650a1b", relativePath: "")
        XCTAssertEqual(id.rawValue, "folder/650a1b:")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testSubfolderRoundTrip() throws {
        let id = FileProviderIdentifier.folder(folderID: "650a1b", relativePath: "2024/2024-01-15")
        // "2024/2024-01-15" -> base64url "MjAyNC8yMDI0LTAxLTE1"
        XCTAssertEqual(id.rawValue, "folder/650a1b:MjAyNC8yMDI0LTAxLTE1")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testInvalidPrefixRejected() {
        XCTAssertThrowsError(try FileProviderIdentifier(rawValue: "bogus/123")) { error in
            XCTAssertEqual(error as? FileProviderIdentifier.DecodeError, .invalidPrefix)
        }
    }

    func testFolderWithoutColonRejected() {
        XCTAssertThrowsError(try FileProviderIdentifier(rawValue: "folder/650a1b")) { error in
            XCTAssertEqual(error as? FileProviderIdentifier.DecodeError, .malformedFolder)
        }
    }

    func testFolderWithInvalidBase64Rejected() {
        // "@@@" is not valid base64url (contains invalid char `@`)
        XCTAssertThrowsError(try FileProviderIdentifier(rawValue: "folder/650a1b:@@@")) { error in
            XCTAssertEqual(error as? FileProviderIdentifier.DecodeError, .badBase64)
        }
    }

    func testCanonicalSidecarRoundTrip() throws {
        let id = FileProviderIdentifier.sidecar(assetID: "650a1b", conflictBasename: nil)
        XCTAssertEqual(id.rawValue, "sidecar/650a1b")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testConflictSidecarRoundTrip() throws {
        let id = FileProviderIdentifier.sidecar(
            assetID: "650a1b",
            conflictBasename: "IMG_1 (conflict from MacBook)"
        )
        XCTAssertTrue(id.rawValue.hasPrefix("sidecar/650a1b:"))
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testSidecarPrefixWithoutPayloadIsCanonical() throws {
        // Bare "sidecar/<id>" with no trailing colon is canonical.
        let id = try FileProviderIdentifier(rawValue: "sidecar/abc")
        XCTAssertEqual(id, .sidecar(assetID: "abc", conflictBasename: nil))
    }

    func testSidecarWithEmptyPayloadIsAlsoCanonical() throws {
        // Defensive: "sidecar/<id>:" with empty payload should still decode
        // as canonical.
        let id = try FileProviderIdentifier(rawValue: "sidecar/abc:")
        XCTAssertEqual(id, .sidecar(assetID: "abc", conflictBasename: nil))
    }

    func testTrashRoundTrip() throws {
        let id = FileProviderIdentifier.trash(folderID: "650a1b2c3d4e5f6071829304")
        XCTAssertEqual(id.rawValue, "trash/650a1b2c3d4e5f6071829304")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testTrashWithoutFolderIDRejected() {
        XCTAssertThrowsError(try FileProviderIdentifier(rawValue: "trash/")) { error in
            XCTAssertEqual(error as? FileProviderIdentifier.DecodeError, .malformedTrash)
        }
    }

    // MARK: - .maple/ identifiers (issue #102)

    func testMapleDirRootRoundTrip() throws {
        let id = FileProviderIdentifier.mapleDir(folderID: "f1", parentRelativePath: "")
        XCTAssertEqual(id.rawValue, "mapledir/f1:")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testMapleDirNestedRoundTrip() throws {
        let id = FileProviderIdentifier.mapleDir(folderID: "f1", parentRelativePath: "2026/04-30")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testMapleThumbsDirRoundTrip() throws {
        let id = FileProviderIdentifier.mapleThumbsDir(folderID: "f1", parentRelativePath: "sub")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
        // Critical: the `mapledirthumbs/` prefix must NOT be decoded as
        // `.mapleDir(folderID: "thumbs/…", …)` — the longer prefix
        // must be matched first. Reversed order would silently break
        // thumb enumeration.
        let parsed = try FileProviderIdentifier(rawValue: id.rawValue)
        switch parsed {
        case .mapleThumbsDir: break
        default: XCTFail("expected .mapleThumbsDir, got \(parsed)")
        }
    }

    func testThumbRoundTrip() throws {
        let id = FileProviderIdentifier.thumb(assetID: "650a1b2c3d4e5f6071829304")
        XCTAssertEqual(id.rawValue, "thumb/650a1b2c3d4e5f6071829304")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testThumbWithoutAssetIDRejected() {
        XCTAssertThrowsError(try FileProviderIdentifier(rawValue: "thumb/")) { error in
            XCTAssertEqual(error as? FileProviderIdentifier.DecodeError, .malformedThumb)
        }
    }
}
