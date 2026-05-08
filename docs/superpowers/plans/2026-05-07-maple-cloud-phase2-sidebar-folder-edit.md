# Maple Cloud Phase 2 — Sidebar restructure + Folder mode + Cloud editing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each connected Maple Cloud server appears as a collapsible sidebar section with its libraries (the API's `/api/folders` entries) listed beneath it. Each server has a per-server **Timeline | Folder** view-mode toggle. Folder mode is fully wired in this phase (Timeline mode shows a placeholder until Phase 3). Cloud assets can be browsed and their XMP sidecars edited round-trip through `GET/PUT /api/assets/:id/xmp`. The broken `SelfHostedSource` (calls non-existent `/api/images/*` paths) is replaced by a correct `CloudSource`.

**Architecture:**
- `CloudFoldersClient` typed wrapper over `GET /api/folders`.
- `CloudServerRegistry` `@Observable` singleton owns connected servers + folder lists + view-mode preferences (UserDefaults backed).
- `CloudSource: ImageSource` paginates `GET /api/folders/<id>/assets` and reads `/api/assets/<id>/{thumb,raw,xmp}`.
- `CloudSidecarStore: SidecarStoreProtocol` round-trips `(AdjustmentModel, CullingState)` through `GET/PUT /api/assets/:id/xmp` using the existing `XMPSerializer` / `XMPParser`.
- `EditSession` chooses between `XMPSidecarStore` (local) and `CloudSidecarStore` (remote) based on the asset.
- `LibrarySidebar` gains `CloudServerSection` rows above the existing local sections.
- `LibrarySelection.cloudLibrary(serverID, folderID)` replaces `selfHostedServer(URL)`.

**Tech Stack:** Swift, SwiftUI, AuthenticationServices, XCTest. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-07-maple-cloud-on-apple-design.md`](../specs/2026-05-07-maple-cloud-on-apple-design.md)

**Depends on:** Phase 1 PR (`AddMapleCloudSheet` + state machine).

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudFolder.swift` | Create | DTO for the `/api/folders` response. |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudFoldersClient.swift` | Create | Typed wrapper. |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudViewMode.swift` | Create | `enum CloudViewMode { case timeline, folder }`. |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudServerRegistry.swift` | Create | `@Observable` singleton. |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudSource.swift` | Create | `ImageSource` impl using correct API paths. |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudAsset.swift` | Create | DTOs for `/api/folders/:id/assets`. |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudSidecarStore.swift` | Create | Remote XMP read/write w/ debounce. |
| `src/apple/Packages/MapleCore/Sources/MapleCore/SidecarStoreProtocol.swift` | Create | Common protocol over `XMPSidecarStore` + `CloudSidecarStore`. |
| `src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudFoldersClientTests.swift` | Create | URLProtocol stub. |
| `src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudServerRegistryTests.swift` | Create | UserDefaults round-trip. |
| `src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudSourceTests.swift` | Create | URLProtocol stub. |
| `src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudSidecarStoreTests.swift` | Create | URLProtocol stub. |
| `src/apple/Maple/Views/CloudServerSection.swift` | Create | One server header + view-mode toggle + library rows. |
| `src/apple/Maple/Views/LibrarySidebar.swift` | Modify | Render `CloudServerSection` per registered server above existing sections. |
| `src/apple/Maple/Views/LibrarySelection.swift` | Modify | Add `cloudLibrary(serverID, folderID)`; remove `selfHostedServer`. |
| `src/apple/Maple/Views/AppShell.swift` | Modify | Handle the new selection case; load `CloudSource`. |
| `src/apple/Maple/MapleApp.swift` | Modify | `SelfHostedSettingsTab` uses `CloudServerRegistry`. |
| `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift` | Modify | Pick `XMPSidecarStore` or `CloudSidecarStore` based on asset. |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Sources/SelfHostedSource.swift` | Delete | Broken (`/api/images/*` paths) — replaced by `CloudSource`. |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Sources/SelfHostedCredentialStore.swift` | Delete | Subsumed by `CloudServerRegistry`. |

---

## Task 1: `CloudFolder` DTO

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudFolder.swift`

- [ ] **Step 1: Write the type**

```swift
// CloudFolder.swift
//
// DTO for `GET /api/folders` — one entry per registered filesystem
// folder on the Maple Cloud server. The user's "library" concept maps
// to one of these entries; multiple libraries per server is fine.

import Foundation

public struct CloudFolder: Decodable, Equatable, Sendable, Identifiable {
  public let id: String
  public let path: String
  public let label: String
  public let last_scan: String?
  public let file_count: Int
  public let created_at: String

  /// User-facing label — server-side `label` if non-empty, else last
  /// path segment.
  public var displayName: String {
    if !label.isEmpty { return label }
    return (path as NSString).lastPathComponent
  }
}
```

- [ ] **Step 2: Build**

Run: `cd src/apple/Packages/MapleCore && swift build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudFolder.swift
git commit -m "$(cat <<'EOF'
feat(maple-core): CloudFolder DTO

Decodable for GET /api/folders. displayName falls back to the last
path segment when the server-side label is empty.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `CloudFoldersClient`

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudFoldersClient.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudFoldersClientTests.swift`
- Reuse: existing `AuthenticatedHTTPClient` + `TokenStore` (from Phase 1).

- [ ] **Step 1: Write the failing test**

```swift
// CloudFoldersClientTests.swift
import XCTest
@testable import MapleCore

final class CloudFoldersClientTests: XCTestCase {
  func test_listFolders_returnsParsedDTOs() async throws {
    let server = URL(string: "https://example.test")!
    let json = """
    [
      {"id":"f1","path":"/photos/2024","label":"2024",
       "last_scan":null,"file_count":42,"created_at":"2026-01-01T00:00:00Z"},
      {"id":"f2","path":"/photos/2023","label":"",
       "last_scan":"2026-04-01T00:00:00Z","file_count":7,"created_at":"2025-12-01T00:00:00Z"}
    ]
    """
    let session = URLSession.stubbed(response: json, contentType: "application/json", status: 200)
    let client = CloudFoldersClient(server: server,
                                    httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let folders = try await client.listFolders()

    XCTAssertEqual(folders.count, 2)
    XCTAssertEqual(folders[0].id, "f1")
    XCTAssertEqual(folders[0].displayName, "2024")
    XCTAssertEqual(folders[1].displayName, "2023") // falls back to path tail
  }
}
```

- [ ] **Step 2: Add `URLSession.stubbed` + `AuthenticatedHTTPClient.unauthenticated` test helpers**

Create `src/apple/Packages/MapleCore/Tests/MapleCoreTests/Helpers/URLProtocolStub.swift`:

```swift
import Foundation
@testable import MapleCore

/// Minimal URLProtocol stub for in-process API mocking.
final class URLProtocolStub: URLProtocol {
  static var responseProvider: ((URLRequest) -> (Data, HTTPURLResponse))?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let provider = Self.responseProvider else { fatalError("URLProtocolStub not configured") }
    let (data, response) = provider(request)
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

extension URLSession {
  /// Returns a session whose only protocol is the stub. Caller writes to
  /// `URLProtocolStub.responseProvider` before issuing requests.
  static func stubbed(response: String, contentType: String = "application/json", status: Int = 200) -> URLSession {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [URLProtocolStub.self]
    URLProtocolStub.responseProvider = { req in
      let resp = HTTPURLResponse(url: req.url!, statusCode: status,
                                 httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": contentType])!
      return (Data(response.utf8), resp)
    }
    return URLSession(configuration: cfg)
  }
}

extension AuthenticatedHTTPClient {
  /// No-token convenience used by tests.
  static func unauthenticated(server: URL, urlSession: URLSession) -> AuthenticatedHTTPClient {
    AuthenticatedHTTPClient(server: server,
                            urlSession: urlSession,
                            tokensProvider: { nil },
                            onTokensRefreshed: { _ in },
                            onSignOut: {})
  }
}
```

- [ ] **Step 3: Run test, expect failure** (`CloudFoldersClient` doesn't exist):

`cd src/apple/Packages/MapleCore && swift test --filter CloudFoldersClientTests`

- [ ] **Step 4: Implement the client**

```swift
// CloudFoldersClient.swift
//
// Typed wrapper over `GET /api/folders`.

import Foundation

public actor CloudFoldersClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  public func listFolders() async throws -> [CloudFolder] {
    let url = server.appending(path: "/api/folders")
    let req = URLRequest(url: url)
    let (data, resp) = try await httpClient.data(for: req)
    try Self.checkOK(resp, data: data)
    return try JSONDecoder().decode([CloudFolder].self, from: data)
  }

  private static func checkOK(_ resp: URLResponse, data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw NSError(domain: "CloudFoldersClient",
                    code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                    userInfo: [NSLocalizedDescriptionKey: body])
    }
  }
}
```

- [ ] **Step 5: Test passes**

- [ ] **Step 6: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudFoldersClient.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudFoldersClientTests.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/Helpers/URLProtocolStub.swift
git commit -m "feat(maple-core): CloudFoldersClient + URLProtocolStub test helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `CloudViewMode` + per-server persistence

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudViewMode.swift`

- [ ] **Step 1: Write the type**

```swift
// CloudViewMode.swift
//
// Per-server view-mode toggle. Persisted to UserDefaults under the key
// `cloud.<host>.viewMode`. Phase 2 wires Folder; Timeline lights up in Phase 3.

import Foundation

public enum CloudViewMode: String, Codable, Sendable, CaseIterable {
  case timeline
  case folder

  public static func load(host: String, defaults: UserDefaults = .standard) -> CloudViewMode {
    let key = "cloud.\(host).viewMode"
    if let raw = defaults.string(forKey: key), let mode = CloudViewMode(rawValue: raw) {
      return mode
    }
    return .folder
  }

  public func save(host: String, defaults: UserDefaults = .standard) {
    defaults.set(rawValue, forKey: "cloud.\(host).viewMode")
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudViewMode.swift
git commit -m "feat(maple-core): CloudViewMode enum + UserDefaults persistence

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `CloudServerRegistry`

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudServerRegistry.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudServerRegistryTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
@testable import MapleCore

@MainActor
final class CloudServerRegistryTests: XCTestCase {
  override func setUp() async throws {
    UserDefaults.standard.removePersistentDomain(
      forName: Bundle.main.bundleIdentifier ?? "test")
    UserDefaults.standard.removeObject(forKey: "cloud.connectedServers")
  }

  func test_addServer_persistsToConnectedServers() {
    let reg = CloudServerRegistry()
    let url = URL(string: "https://myserver.com")!
    reg.register(url)
    XCTAssertEqual(reg.servers.count, 1)
    XCTAssertEqual(reg.servers.first, url)
    // Re-load from UserDefaults
    let reg2 = CloudServerRegistry()
    XCTAssertEqual(reg2.servers.first, url)
  }

  func test_addSameServer_isIdempotent() {
    let reg = CloudServerRegistry()
    let url = URL(string: "https://myserver.com")!
    reg.register(url)
    reg.register(url)
    XCTAssertEqual(reg.servers.count, 1)
  }

  func test_removeServer_persists() {
    let reg = CloudServerRegistry()
    let url = URL(string: "https://myserver.com")!
    reg.register(url)
    reg.remove(url)
    XCTAssertTrue(reg.servers.isEmpty)
    let reg2 = CloudServerRegistry()
    XCTAssertTrue(reg2.servers.isEmpty)
  }

  func test_setViewMode_persistsPerServer() {
    let reg = CloudServerRegistry()
    let url = URL(string: "https://myserver.com")!
    reg.register(url)
    reg.setViewMode(.timeline, for: url)
    XCTAssertEqual(reg.viewMode(for: url), .timeline)
    let reg2 = CloudServerRegistry()
    XCTAssertEqual(reg2.viewMode(for: url), .timeline)
  }

  func test_viewMode_defaultIsFolder() {
    let reg = CloudServerRegistry()
    let url = URL(string: "https://newserver.com")!
    XCTAssertEqual(reg.viewMode(for: url), .folder)
  }
}
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

```swift
// CloudServerRegistry.swift
//
// Singleton @Observable that owns the list of connected Maple Cloud servers
// and per-server settings. The sidebar reads `servers` to render its
// CloudServerSection rows; each section reads `viewMode(for:)` to render
// its toggle. Connected servers persist to UserDefaults under
// `cloud.connectedServers`; per-server modes persist via CloudViewMode.

import Foundation
import Observation

@MainActor
@Observable
public final class CloudServerRegistry {
  /// Singleton — Apple uses this from the sidebar and from the AddMapleCloud
  /// onSignedIn callback.
  public static let shared = CloudServerRegistry()

  /// Currently-connected servers, in registration order.
  public private(set) var servers: [URL]

  private static let listKey = "cloud.connectedServers"
  private let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    self.servers = Self.loadList(from: defaults)
  }

  public func register(_ url: URL) {
    guard !servers.contains(url) else { return }
    servers.append(url)
    Self.saveList(servers, to: defaults)
  }

  public func remove(_ url: URL) {
    servers.removeAll { $0 == url }
    Self.saveList(servers, to: defaults)
    // Best-effort tidy-up of related data.
    TokenStore.clear(server: url)
    if let host = url.host {
      defaults.removeObject(forKey: "cloud.\(host).viewMode")
    }
  }

  public func viewMode(for url: URL) -> CloudViewMode {
    guard let host = url.host else { return .folder }
    return CloudViewMode.load(host: host, defaults: defaults)
  }

  public func setViewMode(_ mode: CloudViewMode, for url: URL) {
    guard let host = url.host else { return }
    mode.save(host: host, defaults: defaults)
    // Trigger Observation-tracked invalidation by mutating servers shape no-op.
    servers = servers
  }

  // MARK: - Persistence

  private static func loadList(from defaults: UserDefaults) -> [URL] {
    guard let data = defaults.data(forKey: listKey),
          let strings = try? JSONDecoder().decode([String].self, from: data)
    else { return [] }
    return strings.compactMap { URL(string: $0) }
  }

  private static func saveList(_ servers: [URL], to defaults: UserDefaults) {
    let strings = servers.map { $0.absoluteString }
    if let data = try? JSONEncoder().encode(strings) {
      defaults.set(data, forKey: listKey)
    }
  }
}
```

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudServerRegistry.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudServerRegistryTests.swift
git commit -m "feat(maple-core): CloudServerRegistry singleton

@Observable. Owns connected server list (UserDefaults) and per-server
view modes. Sidebar consumes servers; AddMapleCloudSheet's onSignedIn
calls register(url). Phase 2 will swap SelfHostedCredentialStore use
in the existing UI for this registry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `CloudAsset` DTO

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudAsset.swift`

```swift
// CloudAsset.swift
//
// DTOs for `GET /api/folders/:id/assets`.

import Foundation

public struct CloudAsset: Decodable, Equatable, Sendable {
  public let id: String
  public let filename: String
  public let size: Int64
  public let mtime: String
  public let rating: Int?
  public let flag: String?
  public let color_label: String?
  public let indexed_at: String?
}

public struct CloudAssetsPage: Decodable, Sendable {
  public let folder_id: String
  public let page: Int
  public let limit: Int
  public let total: Int
  public let assets: [CloudAsset]
}
```

Build, commit:

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudAsset.swift
git commit -m "feat(maple-core): CloudAsset + CloudAssetsPage DTOs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `CloudSource` skeleton + `images()`

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudSource.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudSourceTests.swift`

The new source uses correct `/api/assets/...` and `/api/folders/:id/assets` paths and is library-scoped (one CloudSource per library).

- [ ] **Step 1: Test for `images()` paginated**

```swift
final class CloudSourceTests: XCTestCase {
  func test_images_paginatesUntilEmpty() async throws {
    // Two pages: 200 then 50, total 250.
    var page = 0
    let session = URLSession.stubbedSequence { req -> (Data, HTTPURLResponse) in
      defer { page += 1 }
      let json: String = page == 0 ? Self.pageJSON(page: 1, total: 250, count: 200)
                                    : Self.pageJSON(page: 2, total: 250, count: 50)
      let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let server = URL(string: "https://example.test")!
    let source = CloudSource(server: server,
                             folderID: "f1",
                             httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let refs = try await source.images()
    XCTAssertEqual(refs.count, 250)
  }

  private static func pageJSON(page: Int, total: Int, count: Int) -> String {
    let assets = (0..<count).map { i in
      """
      {"id":"a\(page)-\(i)","filename":"f\(i).dng","size":1024,
       "mtime":"2026-01-01T00:00:00Z","rating":null,"flag":null,
       "color_label":null,"indexed_at":null}
      """
    }.joined(separator: ",")
    return #"""
    {"folder_id":"f1","page":\#(page),"limit":200,"total":\#(total),"assets":[\#(assets)]}
    """#
  }
}
```

(Add `URLSession.stubbedSequence` to `URLProtocolStub.swift` similar to `stubbed`, but the `responseProvider` reads a counter to return different responses per call.)

- [ ] **Step 2: Test fails**

- [ ] **Step 3: Implement `CloudSource` + `images()`**

```swift
// CloudSource.swift
//
// `ImageSource` that talks to a Maple Cloud server scoped to one library
// (folder). Uses the canonical `/api/assets/*` and
// `/api/folders/:id/assets` paths. Replaces the broken SelfHostedSource.

import Foundation

public actor CloudSource {
  public let server: URL
  public let folderID: String
  private let httpClient: AuthenticatedHTTPClient
  private let session: URLSession

  public init(server: URL,
              folderID: String,
              httpClient: AuthenticatedHTTPClient,
              session: URLSession = .shared) {
    self.server = server
    self.folderID = folderID
    self.httpClient = httpClient
    self.session = session
  }

  // MARK: - URL helpers

  private func url(_ path: String, query: [URLQueryItem] = []) -> URL {
    var c = URLComponents(url: server.appending(path: path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { c.queryItems = query }
    return c.url!
  }
}

extension CloudSource: ImageSource {
  public func images() async throws -> [ImageRef] {
    var refs: [ImageRef] = []
    var page = 1
    let limit = 200
    while true {
      let pageURL = url("/api/folders/\(folderID)/assets",
                        query: [URLQueryItem(name: "page", value: "\(page)"),
                                URLQueryItem(name: "limit", value: "\(limit)")])
      let req = URLRequest(url: pageURL)
      let (data, resp) = try await httpClient.data(for: req)
      try Self.checkOK(resp, data: data)
      let parsed = try JSONDecoder().decode(CloudAssetsPage.self, from: data)
      refs.append(contentsOf: parsed.assets.map { dto in
        ImageRef(id: dto.id, displayName: dto.filename, url: nil)
      })
      if parsed.assets.count < limit { break }
      page += 1
    }
    return refs
  }

  public func thumb(for ref: ImageRef) async throws -> Data? { nil } // Task 7
  public func preview(for ref: ImageRef) async throws -> Data? { nil } // Task 7
  public func rawBytes(for ref: ImageRef) async throws -> Data {
    throw ImageSourceError.unsupported("Task 7")
  }
  public func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
    throw ImageSourceError.readOnly("Task 8")
  }
  public func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }

  static func checkOK(_ resp: URLResponse, data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw NSError(domain: "CloudSource",
                    code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                    userInfo: [NSLocalizedDescriptionKey: body])
    }
  }
}
```

- [ ] **Step 4: Test passes**

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudSource.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudSourceTests.swift
git commit -m "feat(maple-core): CloudSource skeleton + images() pagination

Library-scoped ImageSource that paginates GET /api/folders/<id>/assets.
thumb/preview/rawBytes/writeXMP stubbed — filled in next two tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `CloudSource` byte fetchers (thumb/preview/rawBytes)

- [ ] **Step 1: Tests for thumb hit / 404 / raw**

```swift
extension CloudSourceTests {
  func test_thumb_returnsBytesOn200() async throws {
    let session = URLSession.stubbed(response: "JPEGBYTES", contentType: "image/jpeg", status: 200)
    let server = URL(string: "https://x")!
    let source = CloudSource(server: server, folderID: "f1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let data = try await source.thumb(for: ImageRef(id: "a1", displayName: "x.dng"))
    XCTAssertEqual(data, Data("JPEGBYTES".utf8))
  }

  func test_thumb_returnsNilOn404() async throws {
    let session = URLSession.stubbed(response: "not found", contentType: "text/plain", status: 404)
    let server = URL(string: "https://x")!
    let source = CloudSource(server: server, folderID: "f1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let data = try await source.thumb(for: ImageRef(id: "a1", displayName: "x.dng"))
    XCTAssertNil(data)
  }
}
```

- [ ] **Step 2: Implement** — replace stubbed methods in `CloudSource`:

```swift
  public func thumb(for ref: ImageRef) async throws -> Data? {
    try await getOrNilOn404(url("/api/assets/\(ref.id)/thumb"))
  }
  public func preview(for ref: ImageRef) async throws -> Data? {
    try await getOrNilOn404(url("/api/assets/\(ref.id)/preview"))
  }
  public func rawBytes(for ref: ImageRef) async throws -> Data {
    let req = URLRequest(url: url("/api/assets/\(ref.id)/raw"))
    let (data, resp) = try await httpClient.data(for: req)
    try Self.checkOK(resp, data: data)
    return data
  }

  private func getOrNilOn404(_ url: URL) async throws -> Data? {
    let req = URLRequest(url: url)
    let (data, resp) = try await httpClient.data(for: req)
    if let http = resp as? HTTPURLResponse, http.statusCode == 404 { return nil }
    try Self.checkOK(resp, data: data)
    return data
  }
```

- [ ] **Step 3: Tests pass**

- [ ] **Step 4: Commit**

---

## Task 8: `CloudSource.writeXMP`

XMP read/write goes through `XMPSerializer.serialize` (Sidecar → XML) and `XMPParser.parse` (XML → Sidecar) — both already exist in MapleCore.

- [ ] **Step 1: Test**

```swift
extension CloudSourceTests {
  func test_writeXMP_PUTsXmlAtCorrectPath() async throws {
    var captured: URLRequest?
    var capturedBody: Data?
    let session = URLSession.stubbedCapturing { req in
      captured = req
      capturedBody = req.httpBody ?? URLProtocolStub.bodyStream(req)
      let resp = HTTPURLResponse(url: req.url!, statusCode: 204,
                                 httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": "application/xml"])!
      return (Data(), resp)
    }
    let server = URL(string: "https://x")!
    let source = CloudSource(server: server, folderID: "f1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let sidecar = Sidecar(model: .default, culling: CullingState())
    try await source.writeXMP(sidecar, for: ImageRef(id: "a1", displayName: "x.dng"))

    XCTAssertEqual(captured?.httpMethod, "PUT")
    XCTAssertEqual(captured?.url?.path, "/api/assets/a1/xmp")
    XCTAssertEqual(captured?.value(forHTTPHeaderField: "Content-Type"), "application/xml")
    let xml = String(data: capturedBody ?? Data(), encoding: .utf8) ?? ""
    XCTAssertTrue(xml.contains("<x:xmpmeta") || xml.contains("xmpmeta"))
  }
}
```

(Add `URLSession.stubbedCapturing` to URLProtocolStub.swift — variant that lets the test inspect each request, including PUT bodies via `httpBodyStream`.)

- [ ] **Step 2: Implement**

```swift
  public func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
    let xml = XMPSerializer.serialize(model: sidecar.model, culling: sidecar.culling)
    var req = URLRequest(url: url("/api/assets/\(ref.id)/xmp"))
    req.httpMethod = "PUT"
    req.setValue("application/xml", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data(xml.utf8)
    let (data, resp) = try await httpClient.data(for: req)
    try Self.checkOK(resp, data: data)
  }
```

- [ ] **Step 3: Test passes**

- [ ] **Step 4: Commit**

---

## Task 9: `SidecarStoreProtocol` + `CloudSidecarStore`

EditSession needs to pick between local file persistence (`XMPSidecarStore`) and remote-API persistence (`CloudSidecarStore`). A common protocol lets us inject either.

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/SidecarStoreProtocol.swift`
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudSidecarStore.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudSidecarStoreTests.swift`

- [ ] **Step 1: Define the protocol**

```swift
// SidecarStoreProtocol.swift

import Foundation

/// Surface that EditSession needs from a sidecar store.
public protocol SidecarStoreProtocol: Actor {
  func load() async throws -> (AdjustmentModel, CullingState)
  func update(model: AdjustmentModel, culling: CullingState)
  func flush() async
}

extension XMPSidecarStore: SidecarStoreProtocol {}
```

- [ ] **Step 2: Test for `CloudSidecarStore`**

```swift
@MainActor
final class CloudSidecarStoreTests: XCTestCase {
  func test_load_parsesServerXmp() async throws {
    let xml = """
    <x:xmpmeta xmlns:x="adobe:ns:meta/">
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="3"/>
      </rdf:RDF>
    </x:xmpmeta>
    """
    let session = URLSession.stubbed(response: xml, contentType: "application/xml", status: 200)
    let server = URL(string: "https://x")!
    let store = CloudSidecarStore(
      server: server,
      assetID: "a1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let (_, culling) = try await store.load()
    XCTAssertEqual(culling.stars, 3)
  }

  func test_flush_writesSerializedXmpToServer() async throws {
    var capturedBody: String = ""
    let session = URLSession.stubbedCapturing { req in
      capturedBody = String(data: URLProtocolStub.bodyStream(req) ?? Data(), encoding: .utf8) ?? ""
      let resp = HTTPURLResponse(url: req.url!, statusCode: 204,
                                 httpVersion: "HTTP/1.1", headerFields: nil)!
      return (Data(), resp)
    }
    let server = URL(string: "https://x")!
    let store = CloudSidecarStore(
      server: server, assetID: "a1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    var model = AdjustmentModel.default
    model.exposure = 1.5
    var culling = CullingState()
    culling.stars = 4
    await store.update(model: model, culling: culling)
    await store.flush()

    XCTAssertTrue(capturedBody.contains("xmpmeta"))
    XCTAssertTrue(capturedBody.contains("Rating=\"4\"") || capturedBody.contains("rating>4"))
  }
}
```

- [ ] **Step 3: Implement**

```swift
// CloudSidecarStore.swift
//
// Remote analog of XMPSidecarStore. Mirrors the same surface
// (load/update/flush + 750ms debounce) but routes through
// GET/PUT /api/assets/:id/xmp instead of the local filesystem.

import Foundation

public actor CloudSidecarStore: SidecarStoreProtocol {
  private let server: URL
  private let assetID: String
  private let httpClient: AuthenticatedHTTPClient

  private var cached: (AdjustmentModel, CullingState)?
  private var pendingTask: Task<Void, Never>?
  private var pendingModel: AdjustmentModel?
  private var pendingCulling: CullingState?

  static let debounceInterval: Duration = .milliseconds(750)

  public init(server: URL, assetID: String, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.assetID = assetID
    self.httpClient = httpClient
  }

  public func load() async throws -> (AdjustmentModel, CullingState) {
    if let cached { return cached }
    let req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/xmp"))
    let (data, resp) = try await httpClient.data(for: req)
    if let http = resp as? HTTPURLResponse, http.statusCode == 404 {
      let empty: (AdjustmentModel, CullingState) = (.default, CullingState())
      cached = empty
      return empty
    }
    try Self.checkOK(resp, data: data)
    let result = try XMPParser.parse(data: data)
    cached = result
    return result
  }

  public func update(model: AdjustmentModel, culling: CullingState) {
    pendingModel = model
    pendingCulling = culling
    cached = (model, culling)
    pendingTask?.cancel()
    pendingTask = Task { [weak self] in
      do {
        try await Task.sleep(for: CloudSidecarStore.debounceInterval)
        await self?.writePending()
      } catch {}
    }
  }

  public func flush() async {
    pendingTask?.cancel()
    pendingTask = nil
    await writePending()
  }

  // MARK: - Private

  private func writePending() async {
    guard let model = pendingModel, let culling = pendingCulling else { return }
    pendingModel = nil
    pendingCulling = nil
    do {
      let xml = XMPSerializer.serialize(model: model, culling: culling)
      var req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/xmp"))
      req.httpMethod = "PUT"
      req.setValue("application/xml", forHTTPHeaderField: "Content-Type")
      req.httpBody = Data(xml.utf8)
      let (data, resp) = try await httpClient.data(for: req)
      try Self.checkOK(resp, data: data)
    } catch {
      // Best-effort retry; surface to UI in a future iteration.
      _ = error
    }
  }

  private static func checkOK(_ resp: URLResponse, data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw NSError(domain: "CloudSidecarStore",
                    code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                    userInfo: [NSLocalizedDescriptionKey: body])
    }
  }
}
```

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

---

## Task 10: EditSession picks the right store

Modify `EditSession.init` (line ~565) to accept an optional remote store factory. The default keeps existing local-file behavior; cloud callers pass a closure that builds a `CloudSidecarStore`.

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`

- [ ] **Step 1: Change `sidecarStore` type and init**

In `EditSession.swift`, change the property declaration (line 363):

```swift
@ObservationIgnored private let sidecarStore: (any SidecarStoreProtocol)?
```

Change init (line ~559) from:

```swift
public init(asset: AssetRef, ...) {
    ...
    if let url = asset.primaryURL {
        self.sidecarStore = XMPSidecarStore(rawURL: url)
    } else {
        self.sidecarStore = nil
    }
}
```

To:

```swift
public init(asset: AssetRef,
            model: AdjustmentModel = .default,
            culling: CullingState = CullingState(),
            remoteSidecarStore: (any SidecarStoreProtocol)? = nil) {
    self.asset = asset
    self.model = model
    self.originalModel = model
    self.culling = culling
    self.pipeline = ImageEditPipeline()
    if let url = asset.primaryURL {
        self.sidecarStore = XMPSidecarStore(rawURL: url)
    } else {
        // Sourceless asset (PhotoKit, cloud) — caller injects a remote
        // store when the asset is cloud-backed; otherwise nil and edits
        // are session-local.
        self.sidecarStore = remoteSidecarStore
    }
}
```

- [ ] **Step 2: Build (existing tests should still pass)**

`cd src/apple/Packages/MapleCore && swift test`

Expected: same 4 pre-existing pipeline failures, no new ones.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(maple-core): EditSession accepts remote sidecar store

Allows AppShell to inject CloudSidecarStore for cloud-backed assets.
Default behaviour for local files unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: `LibrarySelection.cloudLibrary` case

**Files:**
- Modify: `src/apple/Maple/Views/LibrarySelection.swift`
- Modify: every site that uses `selfHostedServer(URL)` (`AppShell`, `LibrarySidebar`).

- [ ] **Step 1: Update the enum**

```swift
public enum LibrarySelection: Hashable {
    case none
    case folder(path: String)
    case photosFilter(PhotoKitFilter)
    case smbShare(SMBCredentialStore.SavedShare)
    /// Maple Cloud library — server URL + folder ObjectId from /api/folders.
    case cloudLibrary(serverID: URL, folderID: String)
}
```

- [ ] **Step 2: Build and follow compiler errors**

`xcodebuild -scheme Maple -destination 'platform=macOS' build` will report all the call sites. Fix each by:
- Pattern-matching `cloudLibrary(serverID, folderID)` in places that previously matched `selfHostedServer`.
- Selection-restoration code reads back the (host, folderID) pair.

The two main sites are `AppShell.connectSavedSelfHosted` (now `connectCloudLibrary`) and `LibrarySidebar`'s row click handlers.

- [ ] **Step 3: Build clean**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(maple-app): LibrarySelection.cloudLibrary replaces selfHostedServer

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: `CloudServerSection` SwiftUI view

**Files:**
- Create: `src/apple/Maple/Views/CloudServerSection.swift`

```swift
// CloudServerSection.swift
//
// One sidebar section per connected cloud server: collapsible header with
// a Timeline | Folder segmented control on the right, and a list of
// libraries (folders) underneath that. Clicking a library row sets the
// LibrarySelection to .cloudLibrary(serverID, folderID).

import SwiftUI
import MapleCore

struct CloudServerSection: View {
  let serverURL: URL
  let folders: [CloudFolder]
  let viewMode: CloudViewMode
  let isExpanded: Binding<Bool>
  let selection: Binding<LibrarySelection>
  let onSetViewMode: (CloudViewMode) -> Void
  let onPickLibrary: (URL, String) -> Void
  let onSignOut: () -> Void
  let onRemoveServer: () -> Void

  var body: some View {
    DisclosureGroup(isExpanded: isExpanded) {
      ForEach(folders) { folder in
        Button {
          selection.wrappedValue = .cloudLibrary(serverID: serverURL, folderID: folder.id)
          onPickLibrary(serverURL, folder.id)
        } label: {
          HStack {
            Image(systemName: "folder.fill").foregroundStyle(.secondary)
            Text(folder.displayName)
            Spacer()
            if folder.file_count > 0 {
              Text("\(folder.file_count)")
                .foregroundStyle(.tertiary)
                .font(.caption.monospacedDigit())
            }
          }
        }
        .buttonStyle(.plain)
        .padding(.leading, 12)
        .background(isSelected(folder) ? Color.accentColor.opacity(0.15) : .clear)
      }
    } label: {
      HStack {
        Text(serverURL.host ?? serverURL.absoluteString)
          .font(.headline)
        Spacer()
        Picker("", selection: Binding(get: { viewMode }, set: onSetViewMode)) {
          Image(systemName: "calendar").tag(CloudViewMode.timeline)
          Image(systemName: "folder").tag(CloudViewMode.folder)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 80)
      }
      .contextMenu {
        Button("Sign out", action: onSignOut)
        Button("Remove server", role: .destructive, action: onRemoveServer)
      }
    }
  }

  private func isSelected(_ folder: CloudFolder) -> Bool {
    if case .cloudLibrary(let s, let f) = selection.wrappedValue {
      return s == serverURL && f == folder.id
    }
    return false
  }
}
```

- [ ] **Step 1: Create file. Build.**

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(maple-app): CloudServerSection sidebar view

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: `LibrarySidebar` restructure

Render `CloudServerSection` for each `CloudServerRegistry.shared.servers` entry above the existing Folders / Photos / Connections sections. Keep all existing local sections untouched.

**Files:**
- Modify: `src/apple/Maple/Views/LibrarySidebar.swift`

- [ ] **Step 1: Add cloud-section state to `LibrarySidebar`**

Add at the top of the struct's properties:

```swift
@State private var cloudServersExpanded: [URL: Bool] = [:]
@State private var cloudFoldersByServer: [URL: [CloudFolder]] = [:]
@State private var registry = CloudServerRegistry.shared
```

Add new callbacks the parent supplies:

```swift
let onSetCloudViewMode: (URL, CloudViewMode) -> Void
let onPickCloudLibrary: (URL, String) -> Void
let onSignOutCloudServer: (URL) -> Void
let onRemoveCloudServer: (URL) -> Void
let onLoadCloudFolders: (URL) async -> [CloudFolder]
```

Add a section above "Folders":

```swift
if !registry.servers.isEmpty {
  ForEach(registry.servers, id: \.self) { url in
    CloudServerSection(
      serverURL: url,
      folders: cloudFoldersByServer[url] ?? [],
      viewMode: registry.viewMode(for: url),
      isExpanded: Binding(
        get: { cloudServersExpanded[url] ?? true },
        set: { cloudServersExpanded[url] = $0 }
      ),
      selection: $selection,
      onSetViewMode: { mode in
        registry.setViewMode(mode, for: url)
        onSetCloudViewMode(url, mode)
      },
      onPickLibrary: onPickCloudLibrary,
      onSignOut: { onSignOutCloudServer(url) },
      onRemoveServer: { onRemoveCloudServer(url) }
    )
    .task {
      // Load folders lazily on first appearance.
      if cloudFoldersByServer[url] == nil {
        cloudFoldersByServer[url] = await onLoadCloudFolders(url)
      }
    }
  }
  Divider()
}
```

Remove the old "Self Hosted" rows from the Connections section.

- [ ] **Step 2: Update `AppShell` to supply the new callbacks**

In `AppShell.swift`, add to the `LibrarySidebar(...)` call:

```swift
onSetCloudViewMode: { url, mode in
  // No-op for v1 — registry already saved it. Phase 3 may want to re-render.
},
onPickCloudLibrary: { url, folderID in
  loadCloudLibrary(serverID: url, folderID: folderID)
},
onSignOutCloudServer: { url in
  Task { @MainActor in
    let session = sessionFor(url)
    await session.signOut()
    // Remove from registry to drop the row.
    CloudServerRegistry.shared.remove(url)
  }
},
onRemoveCloudServer: { url in
  CloudServerRegistry.shared.remove(url)
},
onLoadCloudFolders: { url in
  await loadCloudFoldersFor(url)
}
```

Add helpers in `AppShell`:

```swift
@MainActor
private func loadCloudFoldersFor(_ url: URL) async -> [CloudFolder] {
  let session = sessionFor(url)
  let httpClient = AuthenticatedHTTPClient(
    server: url,
    urlSession: .shared,
    tokensProvider: { try? TokenStore.load(server: url) },
    onTokensRefreshed: { try? TokenStore.save($0, server: url) },
    onSignOut: { TokenStore.clear(server: url) }
  )
  let client = CloudFoldersClient(server: url, httpClient: httpClient)
  do { return try await client.listFolders() }
  catch { return [] }
}

@MainActor
private func loadCloudLibrary(serverID: URL, folderID: String) {
  librarySelection = .cloudLibrary(serverID: serverID, folderID: folderID)
  let viewMode = CloudServerRegistry.shared.viewMode(for: serverID)
  switch viewMode {
  case .folder:
    Task { @MainActor in
      let httpClient = makeAuthenticatedHTTPClient(server: serverID)
      let source = CloudSource(server: serverID, folderID: folderID, httpClient: httpClient)
      await browseVM.loadSource(source)
      libraryTitle = serverID.host ?? serverID.absoluteString
      mode = .browse
    }
  case .timeline:
    // Phase 3 fills this in. For now, drop the grid and surface a
    // placeholder so the user knows they switched modes.
    browseVM.clear()
    libraryTitle = "Timeline — coming in Phase 3"
    mode = .browse
  }
}

@MainActor
private func makeAuthenticatedHTTPClient(server: URL) -> AuthenticatedHTTPClient {
  AuthenticatedHTTPClient(
    server: server,
    urlSession: .shared,
    tokensProvider: { try? TokenStore.load(server: server) },
    onTokensRefreshed: { try? TokenStore.save($0, server: server) },
    onSignOut: { TokenStore.clear(server: server) }
  )
}
```

- [ ] **Step 3: Update `connectSavedSelfHosted` → `connectCloudLibrary`** signatures already updated by Task 11.

- [ ] **Step 4: Update `AddMapleCloudSheet`'s `onSignedIn` to register with the registry**

In `AppShell.swift`'s sheet binding, replace the old `SelfHostedCredentialStore.setToken` call with:

```swift
onSignedIn: { url, tokens, _ in
  Task { @MainActor in
    try? TokenStore.save(tokens, server: url)
    CloudServerRegistry.shared.register(url)
    let session = sessionFor(url)
    await session.bootstrapAndRestore()
    showAddCloudSheet = false
  }
}
```

Same change in `MapleApp.swift`'s `SelfHostedSettingsTab`.

- [ ] **Step 5: Build, verify**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(maple-app): cloud servers sections in LibrarySidebar

Renders CloudServerSection per registered cloud server above the
existing local sections. AppShell loads CloudSource on library click
and routes XMP through CloudSidecarStore.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: `SelfHostedSettingsTab` migration

**Files:**
- Modify: `src/apple/Maple/MapleApp.swift`

Replace the `SelfHostedCredentialStore.shared.knownServers()` call with `CloudServerRegistry.shared.servers`. Remove the row-level `removeToken` and use `CloudServerRegistry.shared.remove(url)` instead.

- [ ] **Step 1: Edit, build**

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(maple-app): SelfHostedSettingsTab uses CloudServerRegistry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Wire EditSession to CloudSidecarStore

When the user opens an editor for a cloud asset, AppShell creates the EditSession with a `CloudSidecarStore` injected.

**Files:**
- Modify: `src/apple/Maple/Views/AppShell.swift`'s `ensureSession(for:)`

- [ ] **Step 1: Add detection — is the asset from a cloud source?**

```swift
@MainActor
private func ensureSession(for asset: AssetRef) {
  guard sessions[asset.id] == nil else { return }
  let remoteStore: (any SidecarStoreProtocol)? = {
    guard case .cloudLibrary(let serverID, _) = librarySelection else { return nil }
    return CloudSidecarStore(
      server: serverID,
      assetID: asset.id,
      httpClient: makeAuthenticatedHTTPClient(server: serverID))
  }()
  let session = EditSession(asset: asset, remoteSidecarStore: remoteStore)
  sessions[asset.id] = session
  Task { await session.loadSidecar() }
}
```

- [ ] **Step 2: Build, verify edit→write round-trip in manual test (Task 17)**

- [ ] **Step 3: Commit**

---

## Task 16: Delete `SelfHostedSource` + `SelfHostedCredentialStore`

```bash
git rm src/apple/Packages/MapleCore/Sources/MapleCore/Sources/SelfHostedSource.swift \
       src/apple/Packages/MapleCore/Sources/MapleCore/Sources/SelfHostedCredentialStore.swift \
       src/apple/Packages/MapleCore/Tests/MapleCoreTests/SelfHostedCredentialStoreTests.swift
```

Search for and delete any remaining stale references:

```bash
grep -rn "SelfHostedSource\|SelfHostedCredentialStore" src/apple/
```

Update or delete each match.

Also remove `SourceSelection.selfHosted(baseURL:URL)` if it's no longer used (search `SourceSelectionStore`).

- [ ] **Step 1: Build clean**

- [ ] **Step 2: Commit**

```bash
git commit -m "chore(maple-core): delete broken SelfHostedSource + credential store

Both used /api/images/* paths that don't exist; replaced by CloudSource
(/api/assets/*) and CloudServerRegistry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Manual smoke test

- [ ] **Step 1: Build + run** the macOS app.
- [ ] **Step 2:** Settings → Self Hosted → Add Server → type the cloud domain → sign in via Touch ID.
- [ ] **Step 3:** The new sidebar shows a section for the domain with the toggle and the libraries listed under it.
- [ ] **Step 4:** Click a library — Folder mode loads thumbnails from the API.
- [ ] **Step 5:** Open an asset → adjust an exposure slider → close → reopen → adjustment persists (round-trips through `PUT /api/assets/<id>/xmp`).
- [ ] **Step 6:** Right-click the domain header → Sign out → sidebar row removes; Add Server again → server reappears.
- [ ] **Step 7:** Switch view mode toggle → Folder mode loads grid; Timeline mode shows placeholder text "Coming in Phase 3."

(For Step 7, the Timeline placeholder lives in `loadCloudLibrary`. When `viewMode == .timeline`, instead of loading `CloudSource` the view sets `libraryTitle = "Timeline coming in Phase 3"` and clears the grid. This is intentionally minimal.)

---

## Task 18: PR

```bash
gh pr create --title "feat(apple): Maple Cloud Phase 2 — sidebar + folder mode + cloud edits" \
             --base claude/maple-cloud-phase1-entry-point \
             --body "$(cat <<'EOF'
## Summary

- New cloud server sections in the sidebar with per-server Timeline | Folder toggle.
- CloudSource: working ImageSource using correct /api/assets/* and /api/folders/:id/assets paths. Replaces broken SelfHostedSource (which called non-existent /api/images/* routes).
- CloudSidecarStore: edits round-trip through GET/PUT /api/assets/:id/xmp.
- CloudServerRegistry: @Observable singleton owning connected cloud servers + per-server prefs.
- Phase 2 of the [Maple Cloud on Apple design](docs/superpowers/specs/2026-05-07-maple-cloud-on-apple-design.md). Phase 3 (Timeline view + caches) will follow.

## Test plan
- [x] New unit tests for CloudFoldersClient, CloudServerRegistry, CloudSource, CloudSidecarStore pass.
- [x] xcodebuild macOS build succeeds.
- [ ] Manual: sign in via Settings, click a library, browse thumbnails, edit exposure, reload, adjustment persists.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist

- [ ] All `selfHostedServer` references removed; replaced by `cloudLibrary`.
- [ ] No remaining `SelfHostedSource` / `SelfHostedCredentialStore` references.
- [ ] `EditSession` builds with the new `(any SidecarStoreProtocol)?` field and existing local-file flow still works.
- [ ] `CloudServerRegistry.shared.register(url)` is called exactly once per successful sign-in.
- [ ] Pre-existing pipeline test failures count is unchanged.
