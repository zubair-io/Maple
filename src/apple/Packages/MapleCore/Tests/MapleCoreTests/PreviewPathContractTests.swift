// Cross-platform preview path-derivation contract (#1997, epic #1993 stage 5).
//
// Server, web, and Apple each independently compute
// `<relDir>/.maple/previews/<filename>.avif` for a given asset. This test
// pins the APPLE half of that contract (`MapleSidecarPaths.previewURL`)
// against the SAME golden fixture the server (`tests/preview-path-contract.test.ts`)
// and web (`preview-path-contract.spec.ts`) resolvers are pinned against, so
// a change to any one implementation's path scheme fails loudly here instead
// of silently diverging from the other two. See `preview-path-contract.json`'s
// header for the shared-fixture convention (mirrors `auth-contract.json`,
// `AuthContractTests.swift`).
//
// `MapleSidecarPathsTests.swift` already hand-checks a couple of literal
// cases; this file is the fixture-driven counterpart that keeps ALL THREE
// platforms' resolvers pinned to one shared source of truth instead of three
// independently-authored literals that could drift apart unnoticed.

import XCTest

@testable import MapleCore

private struct PreviewPathContract: Decodable {
    struct Case: Decodable {
        let id: String
        let relDir: String
        let filename: String
        let relPath: String
    }
    let version: Int
    let cases: [Case]
}

final class PreviewPathContractTests: XCTestCase {
    private func loadContract() throws -> PreviewPathContract {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "preview-path-contract", withExtension: "json")
        )
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(PreviewPathContract.self, from: data)
    }

    func testFixtureLoadsAndIsNonEmpty() throws {
        let contract = try loadContract()
        XCTAssertGreaterThan(contract.cases.count, 0)
    }

    func testPreviewURLAgreesWithTheSharedGoldenForEveryCase() throws {
        let contract = try loadContract()
        // An arbitrary library root — the fixture's `relPath` is relative to
        // it, mirroring how the server test resolves against `LIBRARY_ROOT`
        // and the web test resolves against the folder handle's own root.
        let libraryRoot = URL(fileURLWithPath: "/lib/photos")

        for c in contract.cases {
            let segments = c.relDir.isEmpty ? [] : c.relDir.split(separator: "/").map(String.init)
            var assetURL = libraryRoot
            for segment in segments {
                assetURL = assetURL.appendingPathComponent(segment)
            }
            assetURL = assetURL.appendingPathComponent(c.filename)

            let resolved = MapleSidecarPaths.previewURL(for: assetURL)
            let expected = libraryRoot.appendingPathComponent(c.relPath).path

            XCTAssertEqual(
                resolved.path, expected,
                "case \(c.id): expected \(expected), got \(resolved.path)"
            )
        }
    }
}
