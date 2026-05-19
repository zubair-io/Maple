// src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift
import XCTest
@testable import MapleCore

final class RemoteCatalogTests: XCTestCase {
    func testDecodeFoldersArray() throws {
        let json = """
        [
          {"id":"abc","label":"Photos","path":"/photos","file_count":1234,"last_scan":null,"created_at":"2024-01-15T10:00:00Z"}
        ]
        """.data(using: .utf8)!
        let folders = try JSONDecoder().decode([LibraryRoot].self, from: json)
        XCTAssertEqual(folders.count, 1)
        XCTAssertEqual(folders[0].id, "abc")
        XCTAssertEqual(folders[0].path, "/photos")
        XCTAssertEqual(folders[0].label, "Photos")
        XCTAssertEqual(folders[0].fileCount, 1234)
    }

    func testDecodeDirContents() throws {
        let json = """
        {
          "path": "/photos/2024",
          "parent": "/photos",
          "dirs": [{"name":"2024-01-15","path":"/photos/2024/2024-01-15","mtime":"2024-01-15T10:00:00Z"}],
          "images": [
            {"name":"IMG_1.ARW","path":"/photos/2024/IMG_1.ARW","mtime":"2024-01-15T10:00:00Z","size":40000000,"ext":"arw","id":"650a"}
          ]
        }
        """.data(using: .utf8)!
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        let contents = try d.decode(DirContents.self, from: json)
        XCTAssertEqual(contents.path, "/photos/2024")
        XCTAssertEqual(contents.parent, "/photos")
        XCTAssertEqual(contents.dirs.count, 1)
        XCTAssertEqual(contents.dirs[0].name, "2024-01-15")
        XCTAssertEqual(contents.images.count, 1)
        XCTAssertEqual(contents.images[0].assetID, "650a")
        XCTAssertEqual(contents.images[0].size, 40_000_000)
        XCTAssertEqual(contents.images[0].ext, "arw")
    }

    func testDecodeImageWithoutAssetID() throws {
        // Image file present on disk but not yet indexed — id omitted.
        let json = """
        {"name":"IMG_2.ARW","path":"/p/IMG_2.ARW","mtime":"2024-01-15T10:00:00Z","size":100,"ext":"arw"}
        """.data(using: .utf8)!
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        let img = try d.decode(ImageChild.self, from: json)
        XCTAssertNil(img.assetID)
    }

    func testDecodeRootDirContentsNullParent() throws {
        let json = """
        {"path":"/photos","parent":null,"dirs":[],"images":[]}
        """.data(using: .utf8)!
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        let contents = try d.decode(DirContents.self, from: json)
        XCTAssertNil(contents.parent)
    }

    func testDecodeDirContentsWithSidecars() throws {
        let json = """
        {
          "path": "/photos",
          "parent": null,
          "dirs": [],
          "images": [
            {"name":"IMG_1.ARW","path":"/photos/IMG_1.ARW","mtime":"2026-05-15T10:00:00Z","size":100,"ext":"arw","id":"650a"}
          ],
          "sidecars": [
            {"name":"IMG_1.xmp","path":"/photos/IMG_1.xmp","mtime":"2026-05-15T10:00:00Z","size":50,"asset_id":"650a"}
          ]
        }
        """.data(using: .utf8)!
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        let contents = try d.decode(DirContents.self, from: json)
        XCTAssertEqual(contents.sidecars.count, 1)
        XCTAssertEqual(contents.sidecars[0].name, "IMG_1.xmp")
        XCTAssertEqual(contents.sidecars[0].assetID, "650a")
        XCTAssertEqual(contents.sidecars[0].size, 50)
    }

    func testDecodeDirContentsWithoutSidecarsField() throws {
        // The server omits sidecars[] on older versions of the API — the
        // client must tolerate that by defaulting to an empty array.
        let json = """
        {"path":"/p","parent":null,"dirs":[],"images":[]}
        """.data(using: .utf8)!
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        let contents = try d.decode(DirContents.self, from: json)
        XCTAssertEqual(contents.sidecars, [])
    }

    func testDecodeTrashList() throws {
        // Server emits ISO-8601 with fractional seconds for both `mtime`
        // and `deleted_at` (the format `Date.toISOString()` produces).
        let json = """
        {"items":[
          {"asset_id":"a1","filename":"IMG_1.ARW","original_relative_path":"2024/IMG_1.ARW",
           "trash_relative_path":".maple/trash/2024/IMG_1.ARW","size":40000000,
           "mtime":"2026-05-15T10:00:00.123Z","deleted_at":"2026-05-15T10:00:00.456Z"}
        ],"next_cursor":null}
        """.data(using: .utf8)!
        let resp = try Self.fractionalISODecoder().decode(TrashListResponse.self, from: json)
        XCTAssertEqual(resp.items.count, 1)
        XCTAssertEqual(resp.items[0].assetID, "a1")
        XCTAssertEqual(resp.items[0].originalRelativePath, "2024/IMG_1.ARW")
        XCTAssertNil(resp.nextCursor)
    }

    func testDecodeRestoreResponse() throws {
        let json = """
        {"asset_id":"a1","abs_path":"/library/2024/IMG_1.restored.ARW",
         "filename":"IMG_1.restored.ARW","size":40000000,"mtime":"2026-05-15T10:00:00.789Z"}
        """.data(using: .utf8)!
        let resp = try Self.fractionalISODecoder().decode(RestoreResponse.self, from: json)
        XCTAssertEqual(resp.assetID, "a1")
        XCTAssertEqual(resp.absPath, "/library/2024/IMG_1.restored.ARW")
        XCTAssertEqual(resp.filename, "IMG_1.restored.ARW")
        XCTAssertEqual(resp.size, 40000000)
    }

    func testDecodeUploadResponse() throws {
        let json = """
        {"asset_id":"a1","abs_path":"/library/2024/IMG_2.ARW","size":12345,
         "mtime":"2026-05-15T10:00:00.000Z"}
        """.data(using: .utf8)!
        let resp = try Self.fractionalISODecoder().decode(UploadResponse.self, from: json)
        XCTAssertEqual(resp.assetID, "a1")
        XCTAssertEqual(resp.size, 12345)
    }

    func testDecodeMakeDirResponse() throws {
        let json = #"{"abs_path":"/library/2026/Adam/04-02"}"#.data(using: .utf8)!
        let resp = try Self.fractionalISODecoder().decode(MakeDirResponse.self, from: json)
        XCTAssertEqual(resp.absPath, "/library/2026/Adam/04-02")
    }

    /// Locks in the X-Maple-Target-Path encoding contract shared by
    /// `uploadFile` and `makeDir`. Server-side `decodeURIComponent`
    /// must round-trip every case below.
    func testEncodeTargetPathRoundTrips() throws {
        let cases: [(input: String, encoded: String)] = [
            ("test_0017.dng", "test_0017.dng"),
            ("2026/Adam/04-02", "2026/Adam/04-02"),                      // separators preserved
            ("Adam's Photos/x.dng", "Adam's%20Photos/x.dng"),            // spaces encoded
            ("café/x.dng", "caf%C3%A9/x.dng"),                            // UTF-8
            ("100%/foo.dng", "100%25/foo.dng"),                          // `%` encoded — round-trips through decodeURIComponent
            ("a+b/c&d.dng", "a+b/c&d.dng"),                              // sub-delims left alone (decodeURIComponent passes them through)
        ]
        for c in cases {
            let actual = try RemoteCatalog.encodeTargetPath(c.input)
            XCTAssertEqual(actual, c.encoded, "encode mismatch for \(c.input)")
            // Verify the decoded round-trip matches the input — this
            // is what the server does with `decodeURIComponent`.
            let decoded = actual.removingPercentEncoding
            XCTAssertEqual(decoded, c.input, "round-trip mismatch for \(c.input)")
        }
    }

    /// Regression: `JSONDecoder.DateDecodingStrategy.iso8601` does NOT
    /// parse fractional seconds. The server's `Date.toISOString()`
    /// always emits them. RemoteCatalog uses a custom strategy that
    /// accepts both fractional and plain ISO-8601 — this test exercises
    /// the same logic against a UploadResponse that mixes both forms.
    func testDateDecoderAcceptsFractionalAndPlain() throws {
        let withFractional = """
        {"asset_id":"a","abs_path":"/x","size":1,"mtime":"2026-05-15T10:00:00.123Z"}
        """.data(using: .utf8)!
        let withoutFractional = """
        {"asset_id":"a","abs_path":"/x","size":1,"mtime":"2026-05-15T10:00:00Z"}
        """.data(using: .utf8)!
        let decoder = Self.fractionalISODecoder()
        XCTAssertNoThrow(try decoder.decode(UploadResponse.self, from: withFractional))
        XCTAssertNoThrow(try decoder.decode(UploadResponse.self, from: withoutFractional))
    }

    /// Mirrors `RemoteCatalog`'s actor-private decoder. Kept in lockstep
    /// with that definition; if you change one, change both.
    private static func fractionalISODecoder() -> JSONDecoder {
        let d = JSONDecoder()
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let raw = try c.decode(String.self)
            if let dt = withFractional.date(from: raw) { return dt }
            if let dt = plain.date(from: raw) { return dt }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Invalid ISO-8601: \(raw)")
        }
        return d
    }
}
