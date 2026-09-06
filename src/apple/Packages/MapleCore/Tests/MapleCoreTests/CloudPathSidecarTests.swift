import Foundation
import XCTest

@testable import MapleCore

final class CloudPathSidecarTests: XCTestCase {
  @MainActor
  func testFailedSidecarReadSurfacesErrorWithoutReplacingEdits() async {
    let server = URL(string: "https://cloud.example.test")!
    let transport = URLSession.stubbed(
      response: "Forbidden", contentType: "text/plain", status: 403)
    let store = CloudSidecarStore(
      server: server, assetID: "fs:/Photos/image.CR2",
      httpClient: .unauthenticated(server: server, urlSession: transport))
    let asset = AssetRef(displayName: "image.CR2", hintExtension: "cr2", bytesProvider: { Data() })
    var model = AdjustmentModel.default
    model.exposure = 1.5
    let session = EditSession(asset: asset, model: model, remoteSidecarStore: store)
    await session.loadSidecar()
    XCTAssertNotNil(session.sidecarError)
    XCTAssertEqual(session.model.exposure, 1.5)
  }

  @MainActor
  func testFolderSidecarLoadsAndSavesByPath() async throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "cloud-path")
    defer { try? FileManager.default.removeItem(at: directory) }
    let xmp = directory.appendingPathComponent("image.xmp")
    var saved = AdjustmentModel.default
    saved.exposure = 1.25
    saved.saturation = 23
    saved.crop = Crop(top: 0.1, left: 0.2, bottom: 0.9, right: 0.8, angle: 0)
    try XMPSerializer.serialize(model: saved, culling: CullingState())
      .write(to: xmp, atomically: true, encoding: .utf8)
    let path = "/Photos/Shrek & friends/084A9984 #1.CR2"
    let server = URL(string: "https://cloud.example.test")!
    let transport = URLSession.stubbedSequence { request in
      do {
        let url = try XCTUnwrap(request.url)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.path, "/api/xmp")
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "path", value: path)])
        if request.httpMethod == "POST" {
          let body = try XCTUnwrap(URLProtocolStub.capturedBodies[url.absoluteString])
          try body.write(to: xmp, options: .atomic)
        } else {
          XCTAssertEqual(request.httpMethod, "GET")
        }
        let response = HTTPURLResponse(
          url: url, statusCode: 200, httpVersion: nil,
          headerFields: ["Content-Type": "application/xml"])!
        return (try Data(contentsOf: xmp), response)
      } catch {
        XCTFail("Sidecar transport failed: \(error)")
        return (
          Data(),
          HTTPURLResponse(
            url: request.url!, statusCode: 500,
            httpVersion: nil, headerFields: nil)!
        )
      }
    }
    let client = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: transport)
    let store = CloudSidecarStore(server: server, assetID: "fs:\(path)", httpClient: client)
    let asset = AssetRef(
      displayName: "084A9984.CR2", hintExtension: "cr2",
      stableID: "fs:\(path)", bytesProvider: { Data() })
    let session = EditSession(asset: asset, remoteSidecarStore: store)
    await session.loadSidecar()
    XCTAssertEqual(session.model.exposure, saved.exposure)
    XCTAssertEqual(session.model.saturation, saved.saturation)
    XCTAssertEqual(session.model.crop, saved.crop)

    var edited = saved
    edited.exposure = 2.5
    await store.update(model: edited, culling: CullingState())
    await store.flush()
    let reopened = CloudSidecarStore(server: server, assetID: "fs:\(path)", httpClient: client)
    let (loaded, _) = try await reopened.load()
    XCTAssertEqual(loaded.exposure, edited.exposure)
    XCTAssertEqual(loaded.crop, saved.crop)
  }
}
