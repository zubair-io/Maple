import XCTest

/// MapleCloudKit must stay portable (tvOS-linkable, no RawPipeline).
/// This walks the kit's sources and fails on any forbidden import, so a
/// future edit can't silently re-entangle the layers. Source-scanning is
/// deliberate: a compile-time break on tvOS would only surface on a Mac
/// with the tvOS SDK, while this fails in every `swift test` run.
final class MapleCloudKitPortabilityTests: XCTestCase {
    func testKitHasNoForbiddenImports() throws {
        let forbidden = ["RawPipeline", "OTel", "AMSMB2", "MapleBackup",
                         "MapleCore", "Photos", "FileProvider", "AppKit", "UIKit"]
        let thisFile = URL(fileURLWithPath: #filePath)
        let kitRoot = thisFile
            .deletingLastPathComponent()  // MapleCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // package root
            .appendingPathComponent("Sources/MapleCloudKit")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: kitRoot, includingPropertiesForKeys: nil))
        var checked = 0
        for case let url as URL in files where url.pathExtension == "swift" {
            checked += 1
            let source = try String(contentsOf: url, encoding: .utf8)
            for module in forbidden {
                XCTAssertFalse(
                    source.contains("import \(module)"),
                    "\(url.lastPathComponent) imports \(module) — MapleCloudKit must stay portable"
                )
            }
        }
        XCTAssertGreaterThan(checked, 20, "kit sources not found — path walk broke?")
    }
}
