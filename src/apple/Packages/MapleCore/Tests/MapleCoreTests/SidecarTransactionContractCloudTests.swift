// SidecarTransactionContractCloudTests.swift — the cloud adapter's
// transaction contract (#2431). See `SidecarContractSupport.swift` for the
// shared vectors/helpers and the recipe every adapter file follows.
//
// Cloud is `CloudSource` + `CloudSidecarStore` (`Cloud/CloudSidecarStore.swift`),
// routing GET/PUT `/api/assets/:id/xmp` through `AuthenticatedHTTPClient`.
// No live server in a unit test — the accepted exception to "no mocks for
// the sidecar layer" (CLAUDE.md) is faking only the HTTP transport, never
// the XMP parse/serialize logic, exactly as `CloudSidecarStoreTests`
// already does with `URLProtocolStub`. Here the stub is stateful — GET
// returns whatever the last PUT body was, keyed by URL — so the cycle is a
// genuine write → reopen → read round trip against an in-process fake
// server, not just "the client formats a PUT correctly."
//
// Cloud has no filesystem-shared "original asset" either (same reasoning as
// the PhotoKit adapter file): the server-side RAW bytes are never touched by
// this write path at all, by construction — `CloudSidecarStore` only ever
// issues requests to `/api/assets/:id/xmp`, never to the asset's own bytes.

import XCTest

@testable import MapleCore

final class SidecarTransactionContractCloudTests: XCTestCase {

  private let server = URL(string: "https://cloud.example.test")!

  /// A fake in-process cloud server: GET replays the last PUT body for the
  /// same URL, 404 if nothing was ever PUT. Reuses `URLProtocolStub`'s own
  /// `capturedBodies` map as the storage — it already records every PUT
  /// body keyed by URL before the response provider runs.
  private func fakeCloudSession() -> URLSession {
    URLSession.stubbedSequence { req in
      let key = req.url?.absoluteString ?? ""
      if req.httpMethod == "PUT" {
        let resp = HTTPURLResponse(
          url: req.url!, statusCode: 204, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (Data(), resp)
      }
      if let data = URLProtocolStub.capturedBodies[key] {
        let resp = HTTPURLResponse(
          url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
          headerFields: ["Content-Type": "application/xml"])!
        return (data, resp)
      }
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
      return (Data(), resp)
    }
  }

  private func makeStore(assetID: String, session: URLSession) -> CloudSidecarStore {
    CloudSidecarStore(
      server: server, assetID: assetID,
      httpClient: .unauthenticated(server: server, urlSession: session))
  }

  /// Seeds the fake server's storage directly with raw XML content, as if
  /// some other client (Lightroom, a prior Maple session) had already PUT
  /// it — establishes a test's starting state before the real read/write
  /// cycles under test begin.
  private func seedFakeServer(assetID: String, xml: String) {
    let key = "\(server.absoluteString)/api/assets/\(assetID)/xmp"
    URLProtocolStub.capturedBodies[key] = Data(xml.utf8)
  }

  // MARK: - 100-cycle transaction contract (acceptance criterion #2)

  func test100CycleTransactionContract() async throws {
    let session = fakeCloudSession()
    let assetID = "a-2431"

    // Seed the fake server with a real Lightroom-authored sidecar, so
    // the first `load()` below reads it back exactly like a real reopen
    // of a foreign-authored asset would.
    seedFakeServer(assetID: assetID, xml: SidecarContractVectors.passthroughLadenDocument)

    let vectorModel = SidecarContractVectors.fullyAuthoredModel()
    let vectorCulling = SidecarContractVectors.fullyAuthoredCulling()

    for cycle in 0..<100 {
      // Step 3: commit through the adapter's write mechanism (PUT).
      let writer = makeStore(assetID: assetID, session: session)
      _ = try await writer.load()  // captures existing passthrough
      await writer.update(model: vectorModel, culling: vectorCulling)
      await writer.flush()

      // Step 4: reopen in a new session — a fresh actor, no shared cache.
      let reader = makeStore(assetID: assetID, session: session)
      let (reloadedModel, reloadedCulling) = try await reader.load()

      // Step 5: semantic adjustments...
      XCTAssertEqual(
        reloadedModel.exposure, vectorModel.exposure, accuracy: 1e-9,
        "cycle \(cycle): exposure must round-trip")
      XCTAssertEqual(reloadedCulling.stars, vectorCulling.stars, "cycle \(cycle)")

      // ...and preserved content, byte-for-byte, from the fake server's
      // stored bytes.
      let onServer = try XCTUnwrap(
        URLProtocolStub.capturedBodies["\(server.absoluteString)/api/assets/\(assetID)/xmp"])
      let onServerXML = try XCTUnwrap(String(data: onServer, encoding: .utf8))
      let sourceNodes = XMPChildElementScanner.descriptionChildren(
        in: SidecarContractVectors.passthroughLadenDocument)
      for node in sourceNodes {
        XCTAssertTrue(
          onServerXML.contains(node.source),
          "cycle \(cycle): \(node.qName) must survive verbatim")
      }

      if cycle == 0 || cycle == 99 {
        // Step 6: render + export from the reopened state, against a
        // stand-in image (Cloud has no local original in this test).
        let dir = try SidecarContractIO.makeTempDirectory(
          prefix: "sidecar-contract-cloud-render")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let standIn = dir.appendingPathComponent("render-check.png")
        try SidecarContractIO.makeSyntheticOriginal(at: standIn)
        let exported = try await SidecarContractRender.renderAndExport(
          originalURL: standIn, model: reloadedModel)
        XCTAssertGreaterThan(exported.count, 0, "cycle \(cycle): export must produce bytes")
      }
    }
  }

  // MARK: - Golden migration fixture readability (acceptance criterion #6)

  func testGoldenMigrationFixtureRemainsReadable() async throws {
    let session = fakeCloudSession()
    seedFakeServer(assetID: "legacy-a1", xml: SidecarContractVectors.passthroughLadenDocument)

    let store = makeStore(assetID: "legacy-a1", session: session)
    let result = try await store.loadIfPresent()
    let unwrapped = try XCTUnwrap(result)
    XCTAssertEqual(unwrapped.0.exposure, 0.35, accuracy: 1e-9)
    XCTAssertEqual(unwrapped.1.stars, 3)
  }

  // MARK: - Fault states are deterministic and observable (acceptance criterion #4)

  /// A real transport-level failure (network drop mid-request) must
  /// surface through `errors()`, not disappear — and must not corrupt
  /// whatever the fake server already held (a failed PUT never overwrites
  /// the prior stored body, since the client never received a success).
  func testTransportFailureIsDeterministicAndObservable() async throws {
    StubURLProtocol.register()
    defer { StubURLProtocol.reset() }
    StubURLProtocol.responder = { _ in .failure(URLError(.networkConnectionLost)) }
    let session = TestURLSession.make()
    let store = makeStore(assetID: "disconnect-a1", session: session)

    let errorStream = await store.errors()
    await store.update(model: SidecarContractVectors.fullyAuthoredModel(), culling: CullingState())
    await store.flush()

    let observed = await SidecarContractFault.firstError(from: errorStream)
    XCTAssertNotNil(observed, "a dropped connection during flush must be observable, not silent")
  }
}
