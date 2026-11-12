// PanoServerUploadRemovalTests.swift — the requests that take an uploaded
// panorama back out of the server library when its crop sidecar does not get
// there (#5628). Uses `URLProtocolStub`: no network.

import FileProvider
import XCTest
import os

@testable import MapleCore

final class PanoServerUploadRemovalTests: XCTestCase {
  private let server = URL(string: "https://example.test")!
  private let assetID = "650a1b2c3d4e5f6071829304"
  private let folders = """
    [{"id":"lib","path":"/srv/photos","label":"Photos","last_scan":null,"file_count":1,
      "created_at":"2026-01-01T00:00:00Z"}]
    """
  private let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "removal-\(UUID().uuidString)", isDirectory: true)

  override func tearDown() {
    try? FileManager.default.removeItem(at: directory)
  }

  private func uploadBody(assetID: String?) -> String {
    let asset = assetID.map { #""asset_id":"\#($0)","# } ?? ""
    return #"{\#(asset)"abs_path":"/srv/photos/2026/Sumac/Panoramas/p.png","size":1,"#
      + #""mtime":"2026-01-01T00:00:00Z"}"#
  }

  /// Adds a real stitched panorama, with its crop sidecar, beside a frame on
  /// a stubbed server: the PNG upload answers `upload`, the sidecar upload
  /// `sidecarStatus`, and every DELETE what `delete` says. Returns the
  /// requests after the folder listing, and how the add ended.
  private func add(
    upload: String, sidecarStatus: Int = 409,
    delete: @escaping @Sendable (URLRequest) -> (Int, String) = { _ in (204, "") }
  ) async throws -> (requests: [String], outcome: Result<PanoResult, any Error>) {
    let panorama = try PanoTestPanorama.stitched(in: directory)
    let requests = OSAllocatedUnfairLock<[String]>(initialState: [])
    let folders = self.folders
    let session = URLSession.stubbedSequence { request in
      let url = request.url!
      let target = request.value(forHTTPHeaderField: "X-Maple-Target-Path")
      let answer: (status: Int, body: String)
      switch (request.httpMethod, target) {
      case ("GET", _): answer = (200, folders)
      case ("POST", let target?) where target.hasSuffix(".png"): answer = (201, upload)
      case ("POST", _): answer = (sidecarStatus, upload)
      default: answer = delete(request)
      }
      if request.httpMethod != "GET" {
        requests.withLock {
          $0.append(
            [request.httpMethod, url.path, url.query, target].compactMap { $0 }
              .joined(separator: " "))
        }
      }
      let response = HTTPURLResponse(
        url: url, statusCode: answer.status, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(answer.body.utf8), response)
    }
    let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
    let frame = CatalogRef(
      serverID: server, folderID: "lib", absPath: "/srv/photos/2026/Sumac/PANO_0001.DNG",
      address: nil)
    let outcome: Result<PanoResult, any Error>
    do {
      outcome = .success(
        try await PanoServerUpload.add(
          panorama, beside: frame, remote: RemoteCatalog(http: http, server: server),
          folders: CloudFoldersClient(server: server, httpClient: http)))
    } catch {
      outcome = .failure(error)
    }
    return (requests.withLock { $0 }, outcome)
  }

  private let pngUpload = "POST /api/folders/lib/upload 2026/Sumac/Panoramas/p.png"
  private let sidecarUpload = "POST /api/folders/lib/upload 2026/Sumac/Panoramas/p.xmp"
  private let fileDelete = "DELETE /api/folders/lib/file path=2026/Sumac/Panoramas/p.png"
  private var assetTrash: String { "DELETE /api/assets/\(assetID) intent=trash" }

  /// The add failed with the sidecar upload's own error, the server's 409.
  private func assertSidecarRefusalSurfaced(
    _ outcome: Result<PanoResult, any Error>, line: UInt = #line
  ) {
    XCTAssertThrowsError(try outcome.get(), line: line) { error in
      XCTAssertEqual((error as NSError).domain, NSFileProviderErrorDomain, line: line)
      XCTAssertEqual(
        (error as NSError).code, NSFileProviderError.filenameCollision.rawValue, line: line)
    }
  }

  func testAPanoramaWhoseSidecarArrivesStaysOnTheServer() async throws {
    let (requests, outcome) = try await add(
      upload: uploadBody(assetID: assetID), sidecarStatus: 201)

    XCTAssertEqual(requests, [pngUpload, sidecarUpload])
    let added = try outcome.get()
    XCTAssertEqual(added.serverAssetID, assetID)
    XCTAssertEqual(added.outputURL.path, "/srv/photos/2026/Sumac/Panoramas/p.png")
  }

  func testARefusedSidecarTrashesThePanoramaByTheAssetIDItsUploadAnswered() async throws {
    let (requests, outcome) = try await add(upload: uploadBody(assetID: assetID))

    XCTAssertEqual(requests, [pngUpload, sidecarUpload, assetTrash])
    assertSidecarRefusalSurfaced(outcome)
  }

  func testAPanoramaTheServerDidNotCatalogueIsTrashedByItsPath() async throws {
    let (requests, outcome) = try await add(upload: uploadBody(assetID: nil))

    XCTAssertEqual(requests, [pngUpload, sidecarUpload, fileDelete])
    assertSidecarRefusalSurfaced(outcome)
  }

  func testAPanoramaCataloguedAfterItsUploadIsTrashedByTheAssetIDTheServerNames() async throws {
    let assetID = self.assetID
    let (requests, outcome) = try await add(upload: uploadBody(assetID: nil)) { request in
      request.url?.path.hasSuffix("/file") == true
        ? (409, #"{"error":"path is an indexed asset","asset_id":"\#(assetID)"}"#) : (204, "")
    }

    XCTAssertEqual(requests, [pngUpload, sidecarUpload, fileDelete, assetTrash])
    assertSidecarRefusalSurfaced(outcome)
  }

  func testAPanoramaAlreadyInTheTrashCountsAsRemoved() async throws {
    let (_, outcome) = try await add(upload: uploadBody(assetID: assetID)) { _ in
      (409, #"{"error":"Asset is already trashed","state":"trashed"}"#)
    }

    assertSidecarRefusalSurfaced(outcome)
  }

  func testAPanoramaTheServerWouldNotTrashIsReportedAsAddedWithoutItsCrop() async throws {
    let (requests, outcome) = try await add(upload: uploadBody(assetID: assetID)) { _ in
      (500, #"{"error":"Asset's folder is missing — refusing to trash"}"#)
    }

    XCTAssertEqual(requests, [pngUpload, sidecarUpload, assetTrash])
    XCTAssertThrowsError(try outcome.get()) { error in
      guard case .addedWithoutCrop("p.png", _)? = error as? PanoFrameDownloadError else {
        return XCTFail("expected addedWithoutCrop, got \(error)")
      }
      XCTAssertTrue(error.localizedDescription.contains("without its Auto Crop"))
      XCTAssertTrue(error.localizedDescription.contains("couldn’t remove it"))
    }
  }
}
