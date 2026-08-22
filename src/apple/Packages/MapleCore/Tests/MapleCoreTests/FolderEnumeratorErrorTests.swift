import XCTest
import FileProvider
@testable import MapleCore

final class FolderEnumeratorErrorTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubURLProtocol.register()
        StubURLProtocol.reset()
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testHTTP400BecomesSupportedFileProviderErrorAndKeepsServerMessage() async throws {
        StubURLProtocol.handler = { _ in
            let body = #"{"error":"Path /srv/photos is outside MAPLE_ROOTS"}"#
            return (400, Data(body.utf8), [:])
        }
        let session = TestURLSession.make()
        let http = AuthenticatedHTTPClient(
            server: URL(string: "https://x.test")!,
            urlSession: session,
            tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
            onTokensRefreshed: { _ in },
            onSignOut: {})
        let catalog = RemoteCatalog(
            http: http,
            server: URL(string: "https://x.test")!,
            downloadURLSession: session)
        let enumerator = FolderEnumerator(
            catalog: catalog,
            folderID: "library-id",
            relativePath: "",
            absolutePath: "/srv/photos",
            containerIdentifier: NSFileProviderItemIdentifier("folder/library-id:"),
            pageSize: 500)
        let observer = TestEnumerationObserver()

        enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))

        let finished = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(finished)
        let error = try XCTUnwrap(observer.error as NSError?)
        XCTAssertEqual(error.domain, NSFileProviderErrorDomain)
        XCTAssertEqual(error.code, NSFileProviderError.serverUnreachable.rawValue)
        XCTAssertTrue(error.localizedDescription.contains("outside MAPLE_ROOTS"))

        let underlying = try XCTUnwrap(error.userInfo[NSUnderlyingErrorKey] as? NSError)
        XCTAssertEqual(underlying.code, 400)
        XCTAssertTrue(underlying.localizedDescription.contains("outside MAPLE_ROOTS"))
    }
}
