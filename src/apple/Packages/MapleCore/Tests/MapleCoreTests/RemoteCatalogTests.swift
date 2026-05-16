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
        let json = """
        {"items":[
          {"asset_id":"a1","filename":"IMG_1.ARW","original_relative_path":"2024/IMG_1.ARW",
           "trash_relative_path":".maple/trash/2024/IMG_1.ARW","size":40000000,
           "mtime":1700000000000,"deleted_at":"2026-05-15T10:00:00Z"}
        ],"next_cursor":null}
        """.data(using: .utf8)!
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let resp = try decoder.decode(TrashListResponse.self, from: json)
        XCTAssertEqual(resp.items.count, 1)
        XCTAssertEqual(resp.items[0].assetID, "a1")
        XCTAssertEqual(resp.items[0].originalRelativePath, "2024/IMG_1.ARW")
        XCTAssertNil(resp.nextCursor)
    }

    func testDecodeRestoreResponse() throws {
        let json = """
        {"asset_id":"a1","abs_path":"/library/2024/IMG_1.restored.ARW"}
        """.data(using: .utf8)!
        let resp = try JSONDecoder().decode(RestoreResponse.self, from: json)
        XCTAssertEqual(resp.assetID, "a1")
        XCTAssertEqual(resp.absPath, "/library/2024/IMG_1.restored.ARW")
    }

    func testDecodeUploadResponse() throws {
        let json = """
        {"asset_id":"a1","abs_path":"/library/2024/IMG_2.ARW","size":12345,"mtime":1700000000000}
        """.data(using: .utf8)!
        let resp = try JSONDecoder().decode(UploadResponse.self, from: json)
        XCTAssertEqual(resp.assetID, "a1")
        XCTAssertEqual(resp.size, 12345)
    }
}
