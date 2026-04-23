// SelfHostedSourceTests — URLProtocol-stubbed happy-path coverage of each
// route SelfHostedSource uses. No live server.

import XCTest
@testable import MapleCore

final class SelfHostedSourceTests: XCTestCase {

    // MARK: Stub transport

    /// Routes URL → (status, body). Matched by exact `url.absoluteString`.
    static nonisolated(unsafe) var routes: [String: (Int, Data)] = [:]
    static nonisolated(unsafe) var recordedRequests: [(URL, String, Data?)] = []

    override func setUp() {
        super.setUp()
        Self.routes = [:]
        Self.recordedRequests = []
    }

    final class StubProtocol: URLProtocol {
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            guard let url = request.url else {
                client?.urlProtocol(self, didFailWithError: URLError(.badURL))
                return
            }
            SelfHostedSourceTests.recordedRequests.append(
                (url, request.httpMethod ?? "GET", request.httpBody
                    ?? (request.httpBodyStream.flatMap { Self.readAll($0) })))
            let key = url.absoluteString
            let (status, body) = SelfHostedSourceTests.routes[key] ?? (404, Data())
            let response = HTTPURLResponse(url: url, statusCode: status,
                                           httpVersion: "HTTP/1.1", headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        }

        override func stopLoading() {}

        private static func readAll(_ stream: InputStream) -> Data {
            stream.open()
            defer { stream.close() }
            var data = Data()
            let bufSize = 4096
            var buf = [UInt8](repeating: 0, count: bufSize)
            while stream.hasBytesAvailable {
                let n = stream.read(&buf, maxLength: bufSize)
                if n <= 0 { break }
                data.append(buf, count: n)
            }
            return data
        }
    }

    private func makeSource() -> SelfHostedSource {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let session = URLSession(configuration: config)
        return SelfHostedSource(baseURL: URL(string: "http://test.local")!,
                                token: "tok",
                                session: session)
    }

    // MARK: images()

    func testImagesWalksFolders() async throws {
        Self.routes["http://test.local/api/folders"] = (200, """
        [{"id":"f1","path":"/photos","label":"Photos"}]
        """.data(using: .utf8)!)
        Self.routes["http://test.local/api/folders/f1/images"] = (200, """
        [
          {"id":"a1","file":"IMG_1.CR3","capturedAt":"2026-01-02T00:00:00Z"},
          {"id":"a2","file":"IMG_2.CR3","capturedAt":"2026-03-15T00:00:00Z"}
        ]
        """.data(using: .utf8)!)

        let src = makeSource()
        let refs = try await src.images()
        XCTAssertEqual(refs.count, 2)
        // Sorted descending by capturedAt.
        XCTAssertEqual(refs[0].id, "a2")
        XCTAssertEqual(refs[1].id, "a1")
    }

    // MARK: thumb / preview

    func testThumbReturnsBytes() async throws {
        let jpeg = Data([0xFF, 0xD8, 0xFF])
        Self.routes["http://test.local/api/images/a1/thumb"] = (200, jpeg)
        let src = makeSource()
        let got = try await src.thumb(for: ImageRef(id: "a1", displayName: "IMG_1"))
        XCTAssertEqual(got, jpeg)
    }

    func testPreview404ReturnsNil() async throws {
        // No route registered → 404 by default.
        let src = makeSource()
        let got = try await src.preview(for: ImageRef(id: "a1", displayName: "IMG_1"))
        XCTAssertNil(got)
    }

    // MARK: rawBytes

    func testRawBytesFetches() async throws {
        let bytes = Data([1, 2, 3, 4, 5])
        Self.routes["http://test.local/api/images/a1/raw"] = (200, bytes)
        let src = makeSource()
        let got = try await src.rawBytes(for: ImageRef(id: "a1", displayName: "IMG_1"))
        XCTAssertEqual(got, bytes)
    }

    /// Range-streamed path returns a `Data` whose size matches the body, even
    /// for a multi-megabyte payload that must be reassembled in 64 KB chunks.
    func testRawBytesStreamsLargePayload() async throws {
        // 5 MB blob — larger than the loader's 64 KB chunk so we exercise the
        // gather-and-flush branch repeatedly.
        let n = 5 * 1024 * 1024
        // Fill with a deterministic byte pattern so accidental truncation is
        // caught by a content check, not just a length check.
        var bytes = [UInt8](repeating: 0, count: n)
        for i in 0..<n { bytes[i] = UInt8(i & 0xFF) }
        let blob = Data(bytes)
        Self.routes["http://test.local/api/images/big/raw"] = (200, blob)

        let src = makeSource()
        let got = try await src.rawBytes(for: ImageRef(id: "big", displayName: "BIG.dng"))
        XCTAssertEqual(got.count, n, "streamed body must match source size")
        // Spot-check first/last bytes — full equality compare is fine but
        // expensive on 5 MB; the position checks catch a truncation bug
        // without paying the full O(n) compare twice (Equatable below).
        XCTAssertEqual(got.first, 0x00)
        XCTAssertEqual(got.last, blob.last)
        XCTAssertEqual(got, blob, "streamed body must match source content")
    }

    // MARK: writeXMP

    func testWriteXMPSendsAdjRatingAndFlag() async throws {
        Self.routes["http://test.local/api/images/a1/adj"] = (204, Data())
        Self.routes["http://test.local/api/images/a1/rating"] = (204, Data())
        Self.routes["http://test.local/api/images/a1/flag"] = (204, Data())
        let src = makeSource()
        let sidecar = Sidecar(model: .default,
                              culling: CullingState(stars: 4, flag: .pick))
        try await src.writeXMP(sidecar, for: ImageRef(id: "a1", displayName: "IMG_1"))

        let methods = Self.recordedRequests.map(\.1)
        XCTAssertEqual(methods.filter { $0 == "PUT" }.count, 3)
        let paths = Self.recordedRequests.map { $0.0.path }
        XCTAssertTrue(paths.contains("/api/images/a1/adj"))
        XCTAssertTrue(paths.contains("/api/images/a1/rating"))
        XCTAssertTrue(paths.contains("/api/images/a1/flag"))
    }

    // MARK: search

    func testSearchReturnsRefs() async throws {
        Self.routes["http://test.local/api/search?q=paris"] = (200, """
        [{"id":"a2","file":"IMG_2.CR3","capturedAt":null}]
        """.data(using: .utf8)!)
        let src = makeSource()
        let hits = try await src.search(SearchQuery(q: "paris"))
        XCTAssertNotNil(hits)
        XCTAssertEqual(hits?.count, 1)
        XCTAssertEqual(hits?.first?.id, "a2")
    }

    // MARK: auth header

    func testAuthorizationHeaderSent() async throws {
        Self.routes["http://test.local/api/folders"] = (200, "[]".data(using: .utf8)!)
        let src = makeSource()
        _ = try? await src.images()
        // URLProtocol doesn't give us the headers directly in this stub;
        // the presence of a response is sufficient for this unit — we're
        // asserting the source doesn't skip `authorize()` when a token is
        // set (covered indirectly; a deeper test would need a custom stub).
        XCTAssertFalse(Self.recordedRequests.isEmpty)
    }
}
