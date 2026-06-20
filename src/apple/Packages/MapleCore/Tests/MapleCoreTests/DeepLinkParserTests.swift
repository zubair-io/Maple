// DeepLinkParserTests.swift — pure URL parsing for the `maple://`
// scheme. Lives in MapleCoreTests so `swift test` covers it without
// the Xcode app-target test plumbing (MapleTests xctest target is
// scheme-skipped today; the SPM package is the canonical unit-test
// surface — see CLAUDE.md § "Build & test — Apple").
//
// Spec: docs/design/responsive-program/deep-links.md §3.
// Closes #624.

import XCTest
@testable import MapleCore

final class DeepLinkParserTests: XCTestCase {
    // MARK: - Valid URLs

    func test_parse_imageURL_returnsImageDestination() throws {
        let url = try XCTUnwrap(URL(string: "maple://image/abc123"))
        XCTAssertEqual(DeepLinkParser.parse(url), .image(id: "abc123"))
    }

    func test_parse_sourceURL_returnsSourceDestination() throws {
        let url = try XCTUnwrap(URL(string: "maple://source/cloud-server-1"))
        XCTAssertEqual(DeepLinkParser.parse(url), .source(id: "cloud-server-1"))
    }

    func test_parse_imageURL_withTrailingSlash_returnsImage() throws {
        // Foundation's `pathComponents` produces ["/", "foo"] for the
        // input — the first non-root component is still "foo". Guard
        // against a regex refactor accidentally rejecting trailing /.
        let url = try XCTUnwrap(URL(string: "maple://image/foo/"))
        XCTAssertEqual(DeepLinkParser.parse(url), .image(id: "foo"))
    }

    func test_parse_idWithSubpath_takesFirstComponent() throws {
        // `maple://image/{id}/{sub}` — v0.1 collapses the edit suffix
        // (out-of-scope per spec §1), so we accept the bare id and
        // ignore extra components rather than fail.
        let url = try XCTUnwrap(URL(string: "maple://image/abc/edit"))
        XCTAssertEqual(DeepLinkParser.parse(url), .image(id: "abc"))
    }

    func test_parse_sourceURL_withAbsoluteFolderPath_rejoinsComponents() throws {
        // `maple://source/%2FUsers%2Falice%2FPhotos` — local folder paths
        // contain `/` so callers must percent-encode the slashes in the id.
        // `.urlPathAllowed` does NOT encode `/`, so we use a custom set.
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        let encoded = "/Users/alice/Photos".addingPercentEncoding(withAllowedCharacters: allowed)!
        let url = try XCTUnwrap(URL(string: "maple://source/\(encoded)"))
        XCTAssertEqual(DeepLinkParser.parse(url), .source(id: "/Users/alice/Photos"))
    }

    func test_parse_sourceURL_smbHostShare_rejoinsComponents() throws {
        // `maple://source/nas/Photos` — SMB `host/share` format uses a
        // slash that would be truncated by a first-component-only parser.
        let url = try XCTUnwrap(URL(string: "maple://source/nas/Photos"))
        XCTAssertEqual(DeepLinkParser.parse(url), .source(id: "nas/Photos"))
    }

    func test_parse_sourceURL_smbUserAtHostShare_rejoinsComponents() throws {
        // `maple://source/alice@nas/Photos` — `user@host/share` format.
        let url = try XCTUnwrap(URL(string: "maple://source/alice@nas/Photos"))
        XCTAssertEqual(DeepLinkParser.parse(url), .source(id: "alice@nas/Photos"))
    }

    // MARK: - Invalid URLs (return nil)

    func test_parse_wrongScheme_returnsNil() throws {
        let url = try XCTUnwrap(URL(string: "https://maple.lawrence.io/i/abc"))
        XCTAssertNil(DeepLinkParser.parse(url))
    }

    func test_parse_unknownHost_returnsNil() throws {
        let url = try XCTUnwrap(URL(string: "maple://settings/general"))
        XCTAssertNil(DeepLinkParser.parse(url))
    }

    func test_parse_imageURL_missingID_returnsNil() throws {
        let url = try XCTUnwrap(URL(string: "maple://image/"))
        XCTAssertNil(DeepLinkParser.parse(url))
    }

    func test_parse_imageURL_noPath_returnsNil() throws {
        let url = try XCTUnwrap(URL(string: "maple://image"))
        XCTAssertNil(DeepLinkParser.parse(url))
    }
}
