import FileProvider
import XCTest
@testable import MapleCore

final class MapleItemTests: XCTestCase {
    // MARK: - itemVersion / modifyItem precondition contract
    //
    // `MapleItem.itemVersion.contentVersion` is the bytes the OS hands
    // back to `modifyItem` as `version.contentVersion`. The XMP write
    // path decodes those bytes to a Unix epoch and forwards it to the
    // server as the `ifMtimeMatches` precondition. If the decoded value
    // is nil, the server skips conflict detection and silently
    // overwrites — so the encode/decode pair MUST round-trip mtime.

    func testSidecarItemVersionRoundTripsMtime() throws {
        // Fixed mtime so the assertion is stable across machines.
        let mtime = Date(timeIntervalSince1970: 1_700_000_000)
        let sidecar = SidecarChild(
            name: "IMG_1.xmp",
            path: "IMG_1.xmp",
            mtime: mtime,
            size: 1234,
            assetID: "650a1b2c3d4e5f6071829304"
        )
        let parent = NSFileProviderItemIdentifier("folder/x:")
        let item = MapleItem(sidecar: sidecar,
                             parentImageBase: "IMG_1",
                             parentIdentifier: parent)
        let version = item.itemVersion
        let decoded = MapleItem.decodePriorMtime(version.contentVersion)
        XCTAssertNotNil(decoded, "sidecar itemVersion must decode to a non-nil mtime (the modifyItem path uses it as the XMP write precondition; nil silently disables conflict detection)")
        XCTAssertEqual(
            decoded.map { Int($0.timeIntervalSince1970) },
            Int(mtime.timeIntervalSince1970)
        )
    }

    func testAssetItemVersionRoundTripsMtime() throws {
        let mtime = Date(timeIntervalSince1970: 1_700_000_500)
        let meta = AssetMetadata(
            id: "650a1b2c3d4e5f6071829304",
            folderID: "folder-x",
            filename: "IMG_1.dng",
            absPath: "/srv/photos/Library/IMG_1.dng",
            size: 50_000_000,
            mtimeMS: mtime.timeIntervalSince1970 * 1000.0,
            rating: 0
        )
        let item = MapleItem(assetMetadata: meta)
        let decoded = MapleItem.decodePriorMtime(item.itemVersion.contentVersion)
        XCTAssertNotNil(decoded)
        XCTAssertEqual(
            decoded.map { Int($0.timeIntervalSince1970) },
            Int(mtime.timeIntervalSince1970)
        )
    }

    /// Synthetic-stub items (no real mtime, identifier-only seed) must
    /// decode to nil so the modifyItem path treats them as "no
    /// precondition known" rather than silently using a bogus epoch.
    func testStubItemVersionDecodesToNil() throws {
        let item = MapleItem(stubAssetID: "650a1b", cursor: 0)
        // stub uses cursor as mtime; with cursor=0 the prior-mtime decoder
        // should bail (epoch > 0 guard).
        let decoded = MapleItem.decodePriorMtime(item.itemVersion.contentVersion)
        XCTAssertNil(decoded)
    }

    /// Regression guard: the pre-fix `modifyItem` decoder was
    ///     `Int(String(data: contentVersion, encoding: .utf8) ?? "")`
    /// Against the post-Phase-5 itemVersion seed `"<epoch>-<identifier>"`
    /// that parses to nil → XMP precondition silently omitted → server
    /// can clobber concurrent writes. This test pins the shape so a
    /// future change that drops the helper without re-checking the
    /// seed format fails loudly.
    func testNaiveIntDecoderReturnsNilForCurrentSeed() throws {
        let mtime = Date(timeIntervalSince1970: 1_700_000_000)
        let sidecar = SidecarChild(
            name: "IMG_1.xmp",
            path: "IMG_1.xmp",
            mtime: mtime,
            size: 100,
            assetID: "abc"
        )
        let item = MapleItem(sidecar: sidecar,
                             parentImageBase: "IMG_1",
                             parentIdentifier: NSFileProviderItemIdentifier("folder/x:"))
        let s = String(data: item.itemVersion.contentVersion, encoding: .utf8) ?? ""
        XCTAssertNil(Int(s),
            "If the bare-Int decode somehow succeeds, the format has reverted to a pure epoch — modifyItem can use the simpler decoder and this test (plus the dedicated helper) is no longer needed.")
        // And the actual helper should succeed where the naive form fails.
        XCTAssertNotNil(MapleItem.decodePriorMtime(item.itemVersion.contentVersion))
    }
}
