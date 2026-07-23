import Foundation
import MapleCloudKit
import Testing

struct CloudVideoClientTests {
  @Test func searchAssetClassifiesVideoCaseInsensitively() {
    #expect(asset(filename: "CLIP.MOV").isVideo)
    #expect(asset(filename: "export.webm").isVideo)
    #expect(!asset(filename: "frame.dng").isVideo)
  }

  @Test func streamingURLPreservesPathAndToken() {
    let url = CloudVideoClient.streamingURL(
      server: URL(string: "https://maple.example/base")!,
      absPath: "/Library/Trips/clip one.mov",
      token: "header.payload.signature"
    )
    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    #expect(url.path == "/api/video/fs")
    #expect(
      components?.queryItems?.first(where: { $0.name == "path" })?.value
        == "/Library/Trips/clip one.mov")
    #expect(
      components?.queryItems?.first(where: { $0.name == "token" })?.value
        == "header.payload.signature")
  }

  private func asset(filename: String) -> SearchAsset {
    SearchAsset(
      id: "asset", folder_id: "folder", abs_path: "/Library/\(filename)", filename: filename)
  }
}
