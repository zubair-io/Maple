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
}
