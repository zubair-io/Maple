// CloudSidecarStoreTests.swift
import XCTest

@testable import MapleCore

final class CloudSidecarStoreTests: XCTestCase {

  func test_load_404_returnsDefaults() async throws {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: "", contentType: "text/plain", status: 404)
    let store = CloudSidecarStore(
      server: server, assetID: "a1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let (model, culling) = try await store.load()
    XCTAssertEqual(model.exposure, AdjustmentModel.default.exposure)
    XCTAssertEqual(culling.stars, 0)
  }

  func test_loadIfPresent_404_returnsNil() async throws {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: "", contentType: "text/plain", status: 404)
    let store = CloudSidecarStore(
      server: server, assetID: "a1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let result = try await store.loadIfPresent()
    XCTAssertNil(result, "404 must surface as nil so EditSession can seed from as-shot WB")
  }

  func test_loadIfPresent_200_parsesAndReturnsModel() async throws {
    // Sidecar returned by the server: exposure=1.5, stars=4. The
    // pre-fix bug discarded these because EditSession's filesystem
    // gate was always false for cloud assets.
    var seedModel = AdjustmentModel.default
    seedModel.exposure = 1.5
    var seedCulling = CullingState()
    seedCulling.stars = 4
    let xml = XMPSerializer.serialize(model: seedModel, culling: seedCulling)

    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: xml, contentType: "application/xml", status: 200)
    let store = CloudSidecarStore(
      server: server, assetID: "a1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let result = try await store.loadIfPresent()
    let unwrapped = try XCTUnwrap(result)
    XCTAssertEqual(unwrapped.0.exposure, 1.5, accuracy: 0.0001)
    XCTAssertEqual(unwrapped.1.stars, 4)
  }

  func test_flush_PUTsSerializedXml() async throws {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbedSequence { req in
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: req.httpMethod == "GET" ? 404 : 204,
        httpVersion: "HTTP/1.1", headerFields: nil)!
      return (Data(), resp)
    }
    let store = CloudSidecarStore(
      server: server, assetID: "a1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    var model = AdjustmentModel.default
    model.exposure = 1.5
    var culling = CullingState()
    culling.stars = 4
    await store.update(model: model, culling: culling)
    await store.flush()

    let body = URLProtocolStub.capturedBodies["https://x/api/assets/a1/xmp"]
    XCTAssertNotNil(body)
    let xml = String(data: body ?? Data(), encoding: .utf8) ?? ""
    XCTAssertTrue(xml.contains("xmpmeta"))
  }
  func testConfirmedWritePreservesMetadataAndForeignXMLUpdatedAfterLoad() async throws {
    let server = URL(string: "https://batch-preservation")!
    let document = TransferRemoteDocument(
      XMPSerializer.serialize(model: .default, culling: CullingState()))
    let session = URLSession.stubbedSequence { request in
      if request.httpMethod == "GET" {
        return (
          Data(document.read().utf8),
          HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        )
      }
      return (
        Data(),
        HTTPURLResponse(url: request.url!, statusCode: 204, httpVersion: nil, headerFields: nil)!
      )
    }
    let store = CloudSidecarStore(
      server: server, assetID: "asset",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    _ = try await store.load()
    document.write(XMPPassthroughTests.lightroomSidecar)
    var model = AdjustmentModel.default
    model.exposure = 1.75
    try await store.writeConfirmed(model: model, culling: CullingState(stars: 4))
    let body = try XCTUnwrap(
      URLProtocolStub.capturedBodies["https://batch-preservation/api/assets/asset/xmp"])
    let written = String(decoding: body, as: UTF8.self)
    XCTAssertEqual(XMPParser.parseMetadata(written), XMPParser.parseMetadata(document.read()))
    XCTAssertEqual(
      XMPParser.parsePassthrough(data: body),
      XMPParser.parsePassthrough(data: Data(document.read().utf8)))
    XCTAssertEqual(try XMPParser.parse(data: body).0.exposure, 1.75)
  }

}

private final class TransferRemoteDocument: @unchecked Sendable {
  private let lock = NSLock()
  private var xml: String
  init(_ xml: String) { self.xml = xml }
  func read() -> String { lock.withLock { xml } }
  func write(_ value: String) { lock.withLock { xml = value } }
}
