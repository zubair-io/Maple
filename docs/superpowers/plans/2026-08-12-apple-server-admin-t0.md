# ServerAdmin Shell + Network Settings Page (T0) Implementation Plan

> This document is a historical record of how T0 was implemented. It was written as a task-by-task plan, which is why the steps carry `- [ ]` checkboxes; they tracked progress during implementation and are all complete as of PR #2852.

**Goal:** Give Maple Exposure a per-server administration surface, entered from the Cloud settings tab, and deliver the Network settings page inside it.

**Architecture:** A new `MapleCloudKit/Admin/` folder holds wire types, a shared HTTP error, and an actor client per API area — all built on the existing `AuthenticatedHTTPClient`, which already solves bearer injection and 401 refresh. Pure form logic lives in `MapleCloudKit` so it is unit-testable without SwiftUI, since XCUITest cannot run on this machine. The app layer adds a `ServerAdmin` surface hosted as a resizable `WindowGroup` on macOS and a sheet on iOS.

**Tech Stack:** Swift 5 language mode, SwiftUI, XCTest, SPM (`src/apple/Packages/MapleCore`), Xcode project with filesystem-synchronized groups.

## Global Constraints

- **Ticket:** every commit on this branch works toward #2766; the PR body must contain `Closes #2766`.
- **File-size budget:** soft 400 lines, headroom 570, hard 600. Split with real margin — aim well under 400, never land at 598. Check with `bash tools/check-file-budget.sh <path>`.
- **Swift is not gated by cloud CI in this repo.** A green GitHub check proves nothing about this code. Verify locally.
- **"Apple build" means all three targets.** macOS-only view modifiers break iOS silently. Build macOS _and_ an iOS simulator destination before claiming done.
- **XCUITest is non-functional on this machine** (#2525 — every class times out "enabling automation mode"). Do not add UI tests or plan verification around them.
- **Conventional Commits** on the first line, enforced by the `commit-msg` lefthook.
- **Language mode is Swift 5** package-wide (`Package.swift`) — do not introduce Swift 6 strict-concurrency-only constructs.
- **New files under `src/apple/Maple/` need no `project.pbxproj` edit** — the Xcode project uses `PBXFileSystemSynchronizedRootGroup`.
- **`MapleCloudKit` must stay dependency-free.** It is linked by the tvOS Maple TV target and must not pull in `RawPipeline` or SwiftUI.
- **API base paths verbatim:** `GET /api/network/config`, `PUT /api/network/config`.
- **Exact copy string for the port validation failure:** `Port must be an integer between 1 and 65535.`

---

## File Structure

**Create — `src/apple/Packages/MapleCore/Sources/MapleCloudKit/Admin/`**

| File                        | Responsibility                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ServerAdminError.swift`    | One error type for every admin client: status code plus the server's `{ "error": ... }` message. Reused by T1–T6.                              |
| `NetworkConfig.swift`       | Wire types for the network config: `NetworkConfig`, `NetworkConfigSource`, `NetworkValueSource`, `NetworkConfigPatch`.                         |
| `NetworkSettingsForm.swift` | Pure form state and its two rules (seed only from `db_override`; port validation). No SwiftUI, no networking — this is the unit-testable core. |
| `NetworkConfigClient.swift` | Actor wrapping the two endpoints.                                                                                                              |

**Create — `src/apple/Maple/Views/ServerAdmin/`**

| File                           | Responsibility                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ServerAdminSection.swift`     | The sidebar model: which sections exist, their titles, icons, and owner-only flag. Later tickets add cases here.                                                                        |
| `ServerAdminView.swift`        | The host: `NavigationSplitView` on macOS, `List` in a `NavigationStack` on iOS. Owns section selection and owner filtering.                                                             |
| `NetworkSettingsView.swift`    | The Network page itself.                                                                                                                                                                |
| `CloudHTTPClientFactory.swift` | Standalone `makeCloudHTTPClient(server:session:)`, extracted from `AppShell+CloudActions.swift` so ServerAdmin builds an identically-configured client without depending on `AppShell`. |

**Modify**

| File                                                   | Change                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `src/apple/Maple/Views/AppShell+CloudActions.swift:44` | `makeAuthenticatedHTTPClient` delegates to the extracted factory instead of duplicating it. |
| `src/apple/Maple/MapleApp.swift`                       | Register the macOS `WindowGroup(id:for:)` scene for ServerAdmin.                            |
| `src/apple/Maple/Views/SelfHostedSettingsTab.swift`    | Each server row gains a "Manage…" affordance.                                               |

**Test — `src/apple/Packages/MapleCore/Tests/MapleCoreTests/`**

| File                             | Covers                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `NetworkConfigClientTests.swift` | Decode of the GET body, PUT body shape including explicit nulls, path targeting, and error surfacing. |
| `NetworkSettingsFormTests.swift` | Seed provenance rule and port validation.                                                             |

Only Network appears in the sidebar in this ticket. Later tickets add their own `ServerAdminSection` case when they deliver the page, so there are no placeholder rows.

---

### Task 1: Shared admin error type

**Files:**

- Create: `src/apple/Packages/MapleCore/Sources/MapleCloudKit/Admin/ServerAdminError.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/NetworkConfigClientTests.swift` (created in Task 3; this task ships the type only)

**Interfaces:**

- Consumes: nothing.
- Produces: `public struct ServerAdminError: Error, LocalizedError, Equatable` with `public let statusCode: Int`, `public let message: String`, and `public static func from(data: Data, response: URLResponse) -> ServerAdminError?` returning nil for a 2xx response.

- [ ] **Step 1: Write the type**

```swift
// ServerAdminError.swift — one error shape for every /api admin client.
//
// The API's failure envelope is `{ "error": "<message>" }` on 4xx/5xx
// (see src/api/src/routes/network.ts and routes/cloudflare.ts). Callers
// render `message` inline, so decoding it here keeps every admin client
// from re-implementing the same unwrap.

import Foundation

public struct ServerAdminError: Error, LocalizedError, Equatable, Sendable {
  public let statusCode: Int
  public let message: String

  public init(statusCode: Int, message: String) {
    self.statusCode = statusCode
    self.message = message
  }

  public var errorDescription: String? { message }

  /// Envelope shape the API returns on failure.
  private struct Envelope: Decodable { let error: String }

  /// Returns an error for any non-2xx response, or nil when the response
  /// succeeded. A body that isn't the `{ error }` envelope falls back to
  /// the raw UTF-8 body, then to a generic status line — a 502 from a
  /// proxy won't be JSON, and an empty message reads as a silent failure.
  public static func from(data: Data, response: URLResponse) -> ServerAdminError? {
    guard let http = response as? HTTPURLResponse else { return nil }
    guard !(200..<300).contains(http.statusCode) else { return nil }
    let decoded = try? JSONDecoder().decode(Envelope.self, from: data)
    let body = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    let message = decoded?.error
      ?? (body?.isEmpty == false ? body! : "Request failed with status \(http.statusCode).")
    return ServerAdminError(statusCode: http.statusCode, message: message)
  }
}
```

- [ ] **Step 2: Build the package**

Run: `cd src/apple/Packages/MapleCore && swift build 2>&1 | tail -20`
Expected: `Build complete`

- [ ] **Step 3: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCloudKit/Admin/ServerAdminError.swift
git commit -m "feat(apple): add ServerAdminError for admin API clients"
```

---

### Task 2: Network wire types

**Files:**

- Create: `src/apple/Packages/MapleCore/Sources/MapleCloudKit/Admin/NetworkConfig.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/NetworkConfigClientTests.swift`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `public enum NetworkValueSource: String, Decodable, Sendable, Equatable` with cases `dbOverride` (`"db_override"`), `autoDetected` (`"auto_detected"`), `unavailable`, `defaultValue` (`"default"`), `unknown`.
  - `public struct NetworkConfigSource: Decodable, Sendable, Equatable` with `localIP: NetworkValueSource`, `localPort: NetworkValueSource`.
  - `public struct NetworkConfig: Decodable, Sendable, Equatable` with `enabled: Bool`, `localIP: String?`, `localPort: Int`, `source: NetworkConfigSource`, and a memberwise `public init`.
  - `public struct NetworkConfigPatch: Encodable, Sendable, Equatable` with `enabled: Bool`, `localIPOverride: String?`, `localPortOverride: Int?`.

- [ ] **Step 1: Write the failing test**

Create the test file with the decode and encode cases:

```swift
// NetworkConfigClientTests.swift
//
// Wire-shape coverage for the Network settings API (#2766). The
// resolution logic lives server-side in network-config.repo.ts — this
// client is "fetch JSON, decode, surface errors", plus one encoding rule
// that matters: an explicit null clears an override, so the PUT body must
// carry nulls rather than omitting the keys.

import XCTest
@testable import MapleCore

final class NetworkConfigTypesTests: XCTestCase {

  func test_decode_autoDetectedConfig() throws {
    let json = """
    {"enabled":true,"local_ip":"192.168.1.42","local_port":3000,
     "source":{"local_ip":"auto_detected","local_port":"default"}}
    """
    let cfg = try JSONDecoder().decode(NetworkConfig.self, from: Data(json.utf8))
    XCTAssertTrue(cfg.enabled)
    XCTAssertEqual(cfg.localIP, "192.168.1.42")
    XCTAssertEqual(cfg.localPort, 3000)
    XCTAssertEqual(cfg.source.localIP, .autoDetected)
    XCTAssertEqual(cfg.source.localPort, .defaultValue)
  }

  func test_decode_nullIPAndUnavailableSource() throws {
    let json = """
    {"enabled":false,"local_ip":null,"local_port":3000,
     "source":{"local_ip":"unavailable","local_port":"default"}}
    """
    let cfg = try JSONDecoder().decode(NetworkConfig.self, from: Data(json.utf8))
    XCTAssertNil(cfg.localIP)
    XCTAssertEqual(cfg.source.localIP, .unavailable)
  }

  func test_decode_unknownSourceDoesNotThrow() throws {
    // Server-side version skew must degrade to a neutral label rather
    // than failing the whole page.
    let json = """
    {"enabled":true,"local_ip":"10.0.0.5","local_port":3000,
     "source":{"local_ip":"something_new","local_port":"default"}}
    """
    let cfg = try JSONDecoder().decode(NetworkConfig.self, from: Data(json.utf8))
    XCTAssertEqual(cfg.source.localIP, .unknown)
  }

  func test_encode_patchEmitsExplicitNulls() throws {
    // Omitting the key leaves the stored override in place server-side,
    // so "clear the override" MUST serialize as null, not as absence.
    let patch = NetworkConfigPatch(enabled: true, localIPOverride: nil, localPortOverride: nil)
    let data = try JSONEncoder().encode(patch)
    let obj = try XCTUnwrap(
      JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertTrue(obj.keys.contains("local_ip_override"))
    XCTAssertTrue(obj.keys.contains("local_port_override"))
    XCTAssertTrue(obj["local_ip_override"] is NSNull)
    XCTAssertTrue(obj["local_port_override"] is NSNull)
    XCTAssertEqual(obj["enabled"] as? Bool, true)
  }

  func test_encode_patchEmitsValues() throws {
    let patch = NetworkConfigPatch(
      enabled: true, localIPOverride: "192.168.1.9", localPortOverride: 8080)
    let data = try JSONEncoder().encode(patch)
    let obj = try XCTUnwrap(
      JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(obj["local_ip_override"] as? String, "192.168.1.9")
    XCTAssertEqual(obj["local_port_override"] as? Int, 8080)
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/apple/Packages/MapleCore && swift test --filter NetworkConfigTypesTests 2>&1 | tail -20`
Expected: compile failure — `cannot find 'NetworkConfig' in scope`

- [ ] **Step 3: Write the implementation**

```swift
// NetworkConfig.swift — wire types for GET/PUT /api/network/config.
//
// The server resolves a LAN address for clients that can reach the box
// locally (src/api/src/routes/network.ts, network-config.repo.ts). A DB
// override wins over auto-detection; the `source` map reports which one
// produced each value, and the UI depends on that provenance — an
// auto-detected value must never be seeded into the override field.

import Foundation

/// Provenance of one resolved value. `local_ip` reports
/// `db_override | auto_detected | unavailable`; `local_port` reports
/// `db_override | default`. Unrecognised values decode to `.unknown` so a
/// newer server can't break the page.
public enum NetworkValueSource: String, Decodable, Sendable, Equatable {
  case dbOverride = "db_override"
  case autoDetected = "auto_detected"
  case unavailable
  case defaultValue = "default"
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = NetworkValueSource(rawValue: raw) ?? .unknown
  }
}

public struct NetworkConfigSource: Decodable, Sendable, Equatable {
  public let localIP: NetworkValueSource
  public let localPort: NetworkValueSource

  public init(localIP: NetworkValueSource, localPort: NetworkValueSource) {
    self.localIP = localIP
    self.localPort = localPort
  }

  enum CodingKeys: String, CodingKey {
    case localIP = "local_ip"
    case localPort = "local_port"
  }
}

public struct NetworkConfig: Decodable, Sendable, Equatable {
  public let enabled: Bool
  public let localIP: String?
  public let localPort: Int
  public let source: NetworkConfigSource

  public init(enabled: Bool, localIP: String?, localPort: Int, source: NetworkConfigSource) {
    self.enabled = enabled
    self.localIP = localIP
    self.localPort = localPort
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case enabled
    case localIP = "local_ip"
    case localPort = "local_port"
    case source
  }
}

/// PUT body. Every field is sent on every save: a null clears the
/// corresponding override and falls back to auto-detection (IP) or the
/// server's listen port (port). Omitting a key would instead preserve the
/// stored override, which is not what the Save button means.
public struct NetworkConfigPatch: Encodable, Sendable, Equatable {
  public let enabled: Bool
  public let localIPOverride: String?
  public let localPortOverride: Int?

  public init(enabled: Bool, localIPOverride: String?, localPortOverride: Int?) {
    self.enabled = enabled
    self.localIPOverride = localIPOverride
    self.localPortOverride = localPortOverride
  }

  enum CodingKeys: String, CodingKey {
    case enabled
    case localIPOverride = "local_ip_override"
    case localPortOverride = "local_port_override"
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(enabled, forKey: .enabled)
    if let ip = localIPOverride {
      try c.encode(ip, forKey: .localIPOverride)
    } else {
      try c.encodeNil(forKey: .localIPOverride)
    }
    if let port = localPortOverride {
      try c.encode(port, forKey: .localPortOverride)
    } else {
      try c.encodeNil(forKey: .localPortOverride)
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/apple/Packages/MapleCore && swift test --filter NetworkConfigTypesTests 2>&1 | tail -20`
Expected: `Executed 5 tests, with 0 failures`

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCloudKit/Admin/NetworkConfig.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/NetworkConfigClientTests.swift
git commit -m "feat(apple): add network config wire types"
```

---

### Task 3: NetworkConfigClient

**Files:**

- Create: `src/apple/Packages/MapleCore/Sources/MapleCloudKit/Admin/NetworkConfigClient.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/NetworkConfigClientTests.swift` (append a second test class)

**Interfaces:**

- Consumes: `NetworkConfig`, `NetworkConfigPatch`, `ServerAdminError` from Tasks 1–2. `AuthenticatedHTTPClient.data(for:)` from `MapleCloudKit/Auth/`.
- Produces: `public actor NetworkConfigClient` with `public init(server: URL, httpClient: AuthenticatedHTTPClient)`, `public func fetch() async throws -> NetworkConfig`, `public func save(_ patch: NetworkConfigPatch) async throws -> NetworkConfig`, and `public static func preview(server:) -> NetworkConfigClient`.

- [ ] **Step 1: Write the failing test**

Append to `NetworkConfigClientTests.swift`:

```swift
final class NetworkConfigClientTests: XCTestCase {

  private let server = URL(string: "https://x")!

  private func client(_ session: URLSession) -> NetworkConfigClient {
    NetworkConfigClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  func test_fetch_targetsConfigPathAndDecodes() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    nonisolated(unsafe) var capturedMethod: String?
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      capturedMethod = req.httpMethod
      let json = """
      {"enabled":true,"local_ip":"192.168.1.42","local_port":3000,
       "source":{"local_ip":"db_override","local_port":"db_override"}}
      """
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let cfg = try await client(session).fetch()
    XCTAssertEqual(capturedURL?.path, "/api/network/config")
    XCTAssertEqual(capturedMethod, "GET")
    XCTAssertEqual(cfg.localIP, "192.168.1.42")
    XCTAssertEqual(cfg.source.localIP, .dbOverride)
  }

  func test_save_sendsPutWithJSONBody() async throws {
    nonisolated(unsafe) var capturedMethod: String?
    nonisolated(unsafe) var capturedContentType: String?
    let session = URLSession.stubbedSequence { req in
      capturedMethod = req.httpMethod
      capturedContentType = req.value(forHTTPHeaderField: "Content-Type")
      let json = """
      {"enabled":true,"local_ip":"10.0.0.5","local_port":8080,
       "source":{"local_ip":"db_override","local_port":"db_override"}}
      """
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let cfg = try await client(session).save(
      NetworkConfigPatch(enabled: true, localIPOverride: "10.0.0.5", localPortOverride: 8080))
    XCTAssertEqual(capturedMethod, "PUT")
    XCTAssertEqual(capturedContentType, "application/json")
    // URLProtocol strips the body off the request once the loader takes
    // it; URLProtocolStub captures it for us, keyed on the URL string.
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/network/config"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(obj["local_ip_override"] as? String, "10.0.0.5")
    XCTAssertEqual(obj["local_port_override"] as? Int, 8080)
    XCTAssertEqual(cfg.localPort, 8080)
  }

  func test_save_400SurfacesServerMessage() async {
    let session = URLSession.stubbed(
      response: #"{"error":"Invalid local_port_override: must be an integer between 1 and 65535"}"#,
      contentType: "application/json",
      status: 400)
    do {
      _ = try await client(session).save(
        NetworkConfigPatch(enabled: true, localIPOverride: nil, localPortOverride: 99999))
      XCTFail("expected throw on 400")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 400)
      XCTAssertTrue(error.message.contains("must be an integer between 1 and 65535"))
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }

  func test_fetch_nonJSONErrorBodyStillSurfaces() async {
    let session = URLSession.stubbed(
      response: "<html>502 Bad Gateway</html>", contentType: "text/html", status: 502)
    do {
      _ = try await client(session).fetch()
      XCTFail("expected throw on 502")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 502)
      XCTAssertFalse(error.message.isEmpty)
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/apple/Packages/MapleCore && swift test --filter NetworkConfigClientTests 2>&1 | tail -20`
Expected: compile failure — `cannot find 'NetworkConfigClient' in scope`

- [ ] **Step 3: Write the implementation**

```swift
// NetworkConfigClient.swift — GET/PUT /api/network/config.
//
// Routes sit under plain `requireAuth` server-side (src/api/src/index.ts
// mounts networkSettingsRoutes inside authedApi), NOT requireOwner. The
// client hides the page from non-owners to match the web's nav filter,
// but that is a presentation choice and not a security boundary.

import Foundation

public actor NetworkConfigClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  private var configURL: URL { server.appending(path: "/api/network/config") }

  public func fetch() async throws -> NetworkConfig {
    let (data, resp) = try await httpClient.data(for: URLRequest(url: configURL))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(NetworkConfig.self, from: data)
  }

  public func save(_ patch: NetworkConfigPatch) async throws -> NetworkConfig {
    var request = URLRequest(url: configURL)
    request.httpMethod = "PUT"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(patch)
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(NetworkConfig.self, from: data)
  }

  /// Sample client for SwiftUI `#Preview` blocks. Points at an
  /// unreachable server so requests fail fast and the preview renders its
  /// error state, mirroring `CloudHistogramClient.preview()`.
  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> NetworkConfigClient {
    NetworkConfigClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.preview(server: server))
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/apple/Packages/MapleCore && swift test --filter NetworkConfigClientTests 2>&1 | tail -20`
Expected: `Executed 4 tests, with 0 failures`

If `test_save_sendsPutWithJSONBody` fails on the `XCTUnwrap` of the captured body, the key is wrong rather than the capture being broken — `capturedBodies` is keyed on the full absolute URL string, so confirm the client is hitting exactly `https://x/api/network/config`. Do not weaken the assertion to skip the body check.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCloudKit/Admin/NetworkConfigClient.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/NetworkConfigClientTests.swift
git commit -m "feat(apple): add NetworkConfigClient"
```

---

### Task 4: Network form logic

**Files:**

- Create: `src/apple/Packages/MapleCore/Sources/MapleCloudKit/Admin/NetworkSettingsForm.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/NetworkSettingsFormTests.swift`

**Interfaces:**

- Consumes: `NetworkConfig`, `NetworkConfigPatch`, `NetworkValueSource` from Task 2.
- Produces:
  - `public struct NetworkSettingsForm: Equatable, Sendable` with `public var ipOverride: String`, `public var portOverride: String`, `public var enabled: Bool`, a `public init(ipOverride:portOverride:enabled:)` defaulting to empty strings and `false`.
  - `public static func seeded(from config: NetworkConfig) -> NetworkSettingsForm`
  - `public enum ValidationResult: Equatable, Sendable { case valid(NetworkConfigPatch); case invalid(String) }`
  - `public func validated() -> ValidationResult`

- [ ] **Step 1: Write the failing test**

```swift
// NetworkSettingsFormTests.swift
//
// The two rules that make the Network page correct rather than merely
// functional (#2766):
//
//   1. Seed the override fields ONLY from `db_override` provenance. If an
//      auto-detected address were seeded into the override box, the next
//      Save would freeze today's DHCP lease as a permanent manual
//      override — the page would silently break itself.
//   2. Blank means "clear the override", which serializes as null, not as
//      an omitted key and not as 0.

import XCTest
@testable import MapleCore

final class NetworkSettingsFormTests: XCTestCase {

  private func config(
    enabled: Bool = true,
    ip: String? = "192.168.1.42",
    port: Int = 3000,
    ipSource: NetworkValueSource,
    portSource: NetworkValueSource
  ) -> NetworkConfig {
    NetworkConfig(
      enabled: enabled, localIP: ip, localPort: port,
      source: NetworkConfigSource(localIP: ipSource, localPort: portSource))
  }

  // MARK: - Seeding

  func test_seed_fromDBOverridePopulatesFields() {
    let form = NetworkSettingsForm.seeded(
      from: config(ipSource: .dbOverride, portSource: .dbOverride))
    XCTAssertEqual(form.ipOverride, "192.168.1.42")
    XCTAssertEqual(form.portOverride, "3000")
    XCTAssertTrue(form.enabled)
  }

  func test_seed_autoDetectedIPLeavesOverrideBlank() {
    let form = NetworkSettingsForm.seeded(
      from: config(ipSource: .autoDetected, portSource: .defaultValue))
    XCTAssertEqual(form.ipOverride, "")
    XCTAssertEqual(form.portOverride, "")
  }

  func test_seed_unavailableIPLeavesOverrideBlank() {
    let form = NetworkSettingsForm.seeded(
      from: config(ip: nil, ipSource: .unavailable, portSource: .defaultValue))
    XCTAssertEqual(form.ipOverride, "")
  }

  func test_seed_mixedProvenanceSeedsOnlyTheOverriddenField() {
    let form = NetworkSettingsForm.seeded(
      from: config(ipSource: .dbOverride, portSource: .defaultValue))
    XCTAssertEqual(form.ipOverride, "192.168.1.42")
    XCTAssertEqual(form.portOverride, "")
  }

  // MARK: - Validation

  func test_validate_blankFieldsClearBothOverrides() {
    let form = NetworkSettingsForm(ipOverride: "", portOverride: "", enabled: false)
    guard case .valid(let patch) = form.validated() else {
      return XCTFail("expected valid")
    }
    XCTAssertNil(patch.localIPOverride)
    XCTAssertNil(patch.localPortOverride)
    XCTAssertFalse(patch.enabled)
  }

  func test_validate_trimsWhitespaceAndTreatsBlankAsCleared() {
    let form = NetworkSettingsForm(ipOverride: "   ", portOverride: "  ", enabled: true)
    guard case .valid(let patch) = form.validated() else {
      return XCTFail("expected valid")
    }
    XCTAssertNil(patch.localIPOverride)
    XCTAssertNil(patch.localPortOverride)
  }

  func test_validate_acceptsBoundaryPorts() {
    for port in ["1", "65535"] {
      let form = NetworkSettingsForm(ipOverride: "", portOverride: port, enabled: true)
      guard case .valid(let patch) = form.validated() else {
        return XCTFail("expected \(port) to validate")
      }
      XCTAssertEqual(patch.localPortOverride, Int(port))
    }
  }

  func test_validate_rejectsOutOfRangeAndNonNumericPorts() {
    for port in ["0", "65536", "-1", "80.5", "abc"] {
      let form = NetworkSettingsForm(ipOverride: "", portOverride: port, enabled: true)
      guard case .invalid(let message) = form.validated() else {
        return XCTFail("expected \(port) to be rejected")
      }
      XCTAssertEqual(message, "Port must be an integer between 1 and 65535.")
    }
  }

  func test_validate_passesTrimmedIPThrough() {
    let form = NetworkSettingsForm(
      ipOverride: "  100.64.0.1  ", portOverride: "", enabled: true)
    guard case .valid(let patch) = form.validated() else {
      return XCTFail("expected valid")
    }
    // Tailscale/CGNAT addresses are legitimate here — the server
    // deliberately does not require RFC1918.
    XCTAssertEqual(patch.localIPOverride, "100.64.0.1")
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/apple/Packages/MapleCore && swift test --filter NetworkSettingsFormTests 2>&1 | tail -20`
Expected: compile failure — `cannot find 'NetworkSettingsForm' in scope`

- [ ] **Step 3: Write the implementation**

```swift
// NetworkSettingsForm.swift — editable state for the Network page.
//
// Kept free of SwiftUI so it can be unit-tested directly; XCUITest is
// unavailable on the primary dev machine (#2525), so view-level rules
// only get coverage if they live in a plain type like this one.

import Foundation

public struct NetworkSettingsForm: Equatable, Sendable {
  public var ipOverride: String
  public var portOverride: String
  public var enabled: Bool

  public init(ipOverride: String = "", portOverride: String = "", enabled: Bool = false) {
    self.ipOverride = ipOverride
    self.portOverride = portOverride
    self.enabled = enabled
  }

  /// Build the editable form from a resolved config.
  ///
  /// Only `db_override` provenance seeds an override field. Seeding an
  /// auto-detected address would turn it into a manual override on the
  /// next save, pinning the page to a stale DHCP lease.
  public static func seeded(from config: NetworkConfig) -> NetworkSettingsForm {
    NetworkSettingsForm(
      ipOverride: config.source.localIP == .dbOverride ? (config.localIP ?? "") : "",
      portOverride: config.source.localPort == .dbOverride ? String(config.localPort) : "",
      enabled: config.enabled)
  }

  public enum ValidationResult: Equatable, Sendable {
    case valid(NetworkConfigPatch)
    case invalid(String)
  }

  /// Validate locally before spending a request. The server re-validates
  /// regardless; this exists so a typo produces an immediate message
  /// rather than a round-trip.
  public func validated() -> ValidationResult {
    let trimmedIP = ipOverride.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedPort = portOverride.trimmingCharacters(in: .whitespacesAndNewlines)

    let resolvedPort: Int?
    if trimmedPort.isEmpty {
      resolvedPort = nil
    } else if let parsed = Int(trimmedPort), (1...65535).contains(parsed) {
      resolvedPort = parsed
    } else {
      return .invalid("Port must be an integer between 1 and 65535.")
    }

    return .valid(
      NetworkConfigPatch(
        enabled: enabled,
        localIPOverride: trimmedIP.isEmpty ? nil : trimmedIP,
        localPortOverride: resolvedPort))
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/apple/Packages/MapleCore && swift test --filter NetworkSettingsFormTests 2>&1 | tail -20`
Expected: `Executed 9 tests, with 0 failures`

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCloudKit/Admin/NetworkSettingsForm.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/NetworkSettingsFormTests.swift
git commit -m "feat(apple): add network settings form seeding and validation"
```

---

### Task 5: Extract the cloud HTTP client factory

**Files:**

- Create: `src/apple/Maple/Views/ServerAdmin/CloudHTTPClientFactory.swift`
- Modify: `src/apple/Maple/Views/AppShell+CloudActions.swift:44-72`

**Interfaces:**

- Consumes: `AuthSession`, `TokenStore`, `CloudTokenPersistence`, `BackgroundExecution`.
- Produces: `@MainActor func makeCloudHTTPClient(server: URL, session: AuthSession) -> AuthenticatedHTTPClient`.

**Why:** ServerAdmin needs an identically-configured client, and `makeAuthenticatedHTTPClient` is an extension on `AppShell`. Copying it would create two constructions that can drift on token rotation and sign-out — the exact failure the existing comments warn about.

- [ ] **Step 1: Write the factory**

```swift
// CloudHTTPClientFactory.swift — one construction site for authenticated
// cloud clients.
//
// Extracted from AppShell+CloudActions so ServerAdmin (#2766) builds an
// identically-configured client without depending on AppShell. Two
// separate constructions would be free to drift on the two behaviours the
// comments below call out — rotation mirroring and sign-out — and both
// failure modes are silent.

import Foundation
import MapleCore

/// Builds an `AuthenticatedHTTPClient` for `server`, wired to the shared
/// Keychain token store and to `session` for terminal-refresh handling.
@MainActor
func makeCloudHTTPClient(server: URL, session: AuthSession) -> AuthenticatedHTTPClient {
  AuthenticatedHTTPClient(
    server: server,
    urlSession: .shared,
    tokensProvider: { try? TokenStore.load(server: server) },
    // Save AND mirror to the File Provider extension's shared store on
    // every rotation, so a background extension never refreshes with a
    // superseded token (→ server reuse-detection → family revoked →
    // sign-out). See CloudTokenPersistence.
    onTokensRefreshed: { try CloudTokenPersistence.persistRotated($0, server: server) },
    // A request 401'd and its refresh was rejected — the refresh token is
    // dead. Drive the OBSERVABLE AuthSession to signed-out (which also
    // clears the Keychain) rather than clearing the Keychain alone, so
    // the UI stops dispatching tokenless requests and offers a way back
    // in.
    onSignOut: {
      Task { @MainActor in await session.handleAuthExpired() }
    },
    refreshExecutor: BackgroundExecution())
}
```

- [ ] **Step 2: Rewrite the AppShell extension to delegate**

Replace the body of `makeAuthenticatedHTTPClient` in `AppShell+CloudActions.swift` (currently lines 44-72) with:

```swift
    @MainActor
    func makeAuthenticatedHTTPClient(server: URL) -> AuthenticatedHTTPClient {
        // Resolve the per-server session up front and capture the instance
        // (a @MainActor, Sendable class) — not `self`, not the resolver — so
        // the escaping onSignOut closure can't drag the AppShell view in.
        makeCloudHTTPClient(server: server, session: sessionFor(server))
    }
```

- [ ] **Step 3: Build both platforms to confirm no regression**

Run:

```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" \
  -destination 'platform=macOS' build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`

- [ ] **Step 4: Commit**

```bash
git add src/apple/Maple/Views/ServerAdmin/CloudHTTPClientFactory.swift \
        src/apple/Maple/Views/AppShell+CloudActions.swift
git commit -m "refactor(apple): extract cloud HTTP client factory from AppShell"
```

---

### Task 6: ServerAdmin section model and shell

**Files:**

- Create: `src/apple/Maple/Views/ServerAdmin/ServerAdminSection.swift`
- Create: `src/apple/Maple/Views/ServerAdmin/ServerAdminView.swift`

**Interfaces:**

- Consumes: `AuthSession` (for `isOwner`), `CloudServerRegistry` (for the display name), `makeCloudHTTPClient` from Task 5.
- Produces:
  - `enum ServerAdminSection: String, CaseIterable, Identifiable, Hashable` with case `network`, and `var title: String`, `var icon: String`, `var isOwnerOnly: Bool`.
  - `static func visible(isOwner: Bool) -> [ServerAdminSection]`
  - `struct ServerAdminView: View` with `init(server: URL, session: AuthSession)`.

Later tickets add their case to this enum when they deliver the page — no placeholder rows.

- [ ] **Step 1: Write the section model**

```swift
// ServerAdminSection.swift — the ServerAdmin sidebar model.
//
// One case per delivered page. Later tickets in epic #2765 add their case
// here as they land (#2767 Cloudflare, #2768 Workers, #2773 Imports), so
// the sidebar never advertises a page that doesn't exist yet.

import Foundation

enum ServerAdminSection: String, CaseIterable, Identifiable, Hashable {
    case network

    var id: String { rawValue }

    var title: String {
        switch self {
        case .network: return "Network"
        }
    }

    var icon: String {
        switch self {
        case .network: return "wifi"
        }
    }

    /// Mirrors the web's `ownerOnly` nav filter. This is presentation
    /// only: `/api/network/config` is `requireAuth` server-side, so a
    /// non-owner is not actually blocked by the API. Never treat a hidden
    /// row as an access control.
    var isOwnerOnly: Bool {
        switch self {
        case .network: return true
        }
    }

    static func visible(isOwner: Bool) -> [ServerAdminSection] {
        allCases.filter { isOwner || !$0.isOwnerOnly }
    }
}
```

- [ ] **Step 2: Write the shell view**

```swift
// ServerAdminView.swift — per-server administration surface (#2766).
//
// Hosted as a resizable window on macOS and a sheet on iOS; see
// ServerAdminSection for what appears in the sidebar. The macOS Settings
// window is a fixed 540×480 (MapleApp.swift), which is why this does not
// live inside it — the Workers table arriving in #2768 is eight columns
// wide.

import SwiftUI
import MapleCore

struct ServerAdminView: View {
    let server: URL
    let session: AuthSession

    @State private var selection: ServerAdminSection?
    @State private var registry = CloudServerRegistry.shared

    private var sections: [ServerAdminSection] {
        ServerAdminSection.visible(isOwner: session.isOwner)
    }

    private var serverName: String {
        registry.displayName(for: server) ?? server.host ?? server.absoluteString
    }

    var body: some View {
        content
            .task {
                if selection == nil { selection = sections.first }
            }
    }

    @ViewBuilder
    private var content: some View {
        #if os(macOS)
        NavigationSplitView {
            List(sections, selection: $selection) { section in
                Label(section.title, systemImage: section.icon)
                    .tag(section)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 260)
            .navigationTitle(serverName)
        } detail: {
            detail
        }
        #else
        NavigationStack {
            List(sections) { section in
                NavigationLink {
                    page(for: section)
                        .navigationTitle(section.title)
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    Label(section.title, systemImage: section.icon)
                }
            }
            .navigationTitle(serverName)
            .navigationBarTitleDisplayMode(.inline)
        }
        #endif
    }

    @ViewBuilder
    private var detail: some View {
        if let selection {
            page(for: selection)
        } else if sections.isEmpty {
            ContentUnavailableView(
                "Owner access required",
                systemImage: "lock",
                description: Text(
                    "Server administration is available to the account that owns this server."))
        } else {
            ContentUnavailableView(
                "Select a section", systemImage: "sidebar.left")
        }
    }

    @ViewBuilder
    private func page(for section: ServerAdminSection) -> some View {
        switch section {
        case .network:
            NetworkSettingsView(
                client: NetworkConfigClient(
                    server: server,
                    httpClient: makeCloudHTTPClient(server: server, session: session)))
        }
    }
}
```

- [ ] **Step 3: Verify it compiles once the page exists**

`NetworkSettingsView` lands in Task 7, so this task does not build on its own. Complete Task 7 before building, then commit both together at the end of Task 7.

Run: `bash tools/check-file-budget.sh src/apple/Maple/Views/ServerAdmin/ServerAdminView.swift`
Expected: pass, well under 400 lines

---

### Task 7: Network settings page

**Files:**

- Create: `src/apple/Maple/Views/ServerAdmin/NetworkSettingsView.swift`

**Interfaces:**

- Consumes: `NetworkConfigClient`, `NetworkConfig`, `NetworkSettingsForm`, `ServerAdminError` from Tasks 1–4.
- Produces: `struct NetworkSettingsView: View` with `init(client: NetworkConfigClient)`.

- [ ] **Step 1: Write the view**

```swift
// NetworkSettingsView.swift — Settings → Cloud → Manage → Network (#2766).
//
// Mirrors the web page at src/web/.../settings/network. The resolved
// section reports what the server actually decided and where each value
// came from; the override section is what the operator can change. The
// seeding rule that keeps those two honest lives in
// NetworkSettingsForm.seeded(from:) — an auto-detected address must never
// appear in an override field.

import SwiftUI
import MapleCore

struct NetworkSettingsView: View {
    let client: NetworkConfigClient

    private enum LoadState: Equatable {
        case loading
        case loaded(NetworkConfig)
        case failed(String)
    }

    @State private var loadState: LoadState = .loading
    @State private var form = NetworkSettingsForm()
    @State private var isSaving = false
    @State private var saveError: String?
    @State private var didSave = false
    @State private var saveConfirmationTask: Task<Void, Never>?

    var body: some View {
        Form {
            switch loadState {
            case .loading:
                Section {
                    HStack {
                        Text("Loading configuration…").foregroundStyle(.secondary)
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
                .listRowBackground(MapleTokens.surface)
            case .failed(let message):
                Section {
                    Text("Failed to load config: \(message)")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("network.loadError")
                    Button("Retry") { Task { await load() } }
                }
                .listRowBackground(MapleTokens.surface)
            case .loaded(let config):
                resolvedSection(config)
                overrideSection
            }
        }
        .formStyle(.grouped)
        .mapleSettingsBackground()
        .task { await load() }
        .onDisappear { saveConfirmationTask?.cancel() }
    }

    // MARK: - Sections

    @ViewBuilder
    private func resolvedSection(_ config: NetworkConfig) -> some View {
        Section("Current (resolved)") {
            LabeledContent("Advertising a LAN address") {
                Text(config.enabled ? "Yes" : "No").foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("network.resolved.enabled")

            LabeledContent("Address") {
                Text(config.localIP ?? "none")
                    .foregroundStyle(config.localIP == nil ? .secondary : .primary)
                + Text(" \(provenance(config.source.localIP))")
                    .foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("network.resolved.address")

            LabeledContent("Port") {
                Text("\(config.localPort)")
                + Text(" \(provenance(config.source.localPort))")
                    .foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("network.resolved.port")

            if config.source.localIP == .unavailable && config.enabled {
                Text("""
                    No LAN address could be detected. This is expected when the \
                    server runs inside a container with a bridge network — set an \
                    override below so clients on the same network can connect \
                    directly.
                    """)
                .font(.caption)
                .foregroundStyle(.orange)
                .accessibilityIdentifier("network.unavailableWarning")
            }
        }
        .listRowBackground(MapleTokens.surface)
    }

    @ViewBuilder
    private var overrideSection: some View {
        Section("Override") {
            TextField("LAN address", text: $form.ipOverride, prompt: Text("192.168.1.42"))
                .font(.system(.body, design: .monospaced))
                .textContentType(.none)
                #if os(iOS)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                #endif
                .accessibilityIdentifier("network.ipOverride")

            TextField("Port", text: $form.portOverride, prompt: Text("3000"))
                .font(.system(.body, design: .monospaced))
                #if os(iOS)
                .keyboardType(.numberPad)
                #endif
                .accessibilityIdentifier("network.portOverride")

            Text("Blank uses the server's listen port.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Toggle("Advertise a LAN address to clients", isOn: $form.enabled)
                .accessibilityIdentifier("network.enabled")

            Button {
                Task { await save() }
            } label: {
                HStack {
                    Text(isSaving ? "Saving…" : "Save")
                    if isSaving {
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .disabled(isSaving)
            .accessibilityIdentifier("network.save")

            if let saveError {
                Label(saveError, systemImage: "xmark.circle")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("network.saveError")
            } else if didSave {
                Label("Saved.", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.green)
                    .accessibilityIdentifier("network.saved")
            }
        }
        .listRowBackground(MapleTokens.surface)
    }

    private func provenance(_ source: NetworkValueSource) -> String {
        switch source {
        case .dbOverride: return "(operator override)"
        case .autoDetected: return "(auto-detected)"
        case .unavailable: return "(unavailable)"
        case .defaultValue: return "(default)"
        case .unknown: return ""
        }
    }

    // MARK: - Actions

    private func load() async {
        loadState = .loading
        do {
            let config = try await client.fetch()
            // Seed once per load. In-progress edits are only discarded by
            // an explicit Retry, never by a background refresh.
            form = NetworkSettingsForm.seeded(from: config)
            loadState = .loaded(config)
        } catch {
            loadState = .failed(error.localizedDescription)
        }
    }

    private func save() async {
        saveError = nil
        didSave = false
        guard case .valid(let patch) = form.validated() else {
            if case .invalid(let message) = form.validated() { saveError = message }
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let config = try await client.save(patch)
            // Re-seed from the server's answer rather than trusting the
            // local form: the server may have resolved a value the patch
            // only cleared.
            form = NetworkSettingsForm.seeded(from: config)
            loadState = .loaded(config)
            didSave = true
            saveConfirmationTask?.cancel()
            saveConfirmationTask = Task {
                try? await Task.sleep(for: .seconds(2))
                if !Task.isCancelled { didSave = false }
            }
        } catch {
            saveError = error.localizedDescription
        }
    }
}

#Preview("Unreachable server") {
    NetworkSettingsView(client: .preview())
        .frame(width: 560, height: 520)
}
```

- [ ] **Step 2: Build for macOS**

Run:

```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" \
  -destination 'platform=macOS' build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`

If `Text(...) + Text(...)` inside `LabeledContent` fails to type-check, replace the concatenation with an `HStack` of two `Text` views — do not drop the provenance suffix.

- [ ] **Step 3: Build for the iOS simulator**

Run:

```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`

This step exists because macOS-only modifiers compile fine on macOS and break iOS silently.

- [ ] **Step 4: Check the file budget**

Run: `bash tools/check-file-budget.sh src/apple/Maple/Views/ServerAdmin/`
Expected: no file over 400 lines

- [ ] **Step 5: Commit**

```bash
git add src/apple/Maple/Views/ServerAdmin/ServerAdminSection.swift \
        src/apple/Maple/Views/ServerAdmin/ServerAdminView.swift \
        src/apple/Maple/Views/ServerAdmin/NetworkSettingsView.swift
git commit -m "feat(apple): add ServerAdmin shell and Network settings page"
```

---

### Task 8: Wire the entry points

**Files:**

- Modify: `src/apple/Maple/MapleApp.swift:103-135`
- Modify: `src/apple/Maple/Views/SelfHostedSettingsTab.swift:66-104`

**Interfaces:**

- Consumes: `ServerAdminView` from Task 6.
- Produces: a macOS window scene with id `"server-admin"` keyed by `URL`; a "Manage…" control on each server row.

**Deviation from the epic text, called out deliberately:** the epic described an iPhone push and an iPad sheet. This uses a sheet on both iOS idioms, because `SelfHostedSettingsTab` is also hosted inside the iPad `SettingsView` modal, which has no `NavigationStack` to push onto. `ServerAdminView` supplies its own `NavigationStack` on iOS, so a sheet works identically in both places.

- [ ] **Step 1: Add the macOS window scene**

In `MapleApp.swift`, immediately after the existing `Settings { SettingsView() }` block inside `body`, add:

```swift
        #if os(macOS)
        // Per-server administration (#2766). A separate resizable window
        // rather than a Settings tab: the Settings scene is a fixed
        // 540×480 and the Workers table arriving in #2768 is eight
        // columns wide. Keyed by server URL so two servers can be
        // administered side by side.
        WindowGroup(id: "server-admin", for: URL.self) { $server in
            if let server {
                ServerAdminView(server: server, session: session(for: server))
            }
        }
        .defaultSize(width: 900, height: 620)
        #endif
```

- [ ] **Step 2: Add the "Manage…" control to each server row**

In `SelfHostedSettingsTab.swift`, add the environment action near the other `@State` properties:

```swift
    #if os(macOS)
    @Environment(\.openWindow) private var openWindow
    #else
    /// Server whose admin sheet is presented. `URL` is not `Identifiable`,
    /// so the row wraps it for `.sheet(item:)`.
    @State private var adminTarget: AdminSheetTarget?

    struct AdminSheetTarget: Identifiable {
        let server: URL
        var id: URL { server }
    }
    #endif
```

Inside the `ForEach` row, between the `Sign In` button and the destructive delete button, add:

```swift
                            Button("Manage…") {
                                #if os(macOS)
                                openWindow(id: "server-admin", value: url)
                                #else
                                adminTarget = AdminSheetTarget(server: url)
                                #endif
                            }
                            .controlSize(.small)
                            .disabled(signedIn[url] == false)
                            .accessibilityIdentifier("cloud.manage.\(url.host ?? url.absoluteString)")
```

On iOS, attach the sheet alongside the existing `.sheet(item: $sheetTarget)` modifier:

```swift
        #if !os(macOS)
        .sheet(item: $adminTarget) { target in
            ServerAdminView(server: target.server, session: sessionFor(target.server))
        }
        #endif
```

- [ ] **Step 3: Thread the session resolver into the tab**

`SelfHostedSettingsTab` has no `AuthSession` today. Add a stored property and pass it from every construction site:

```swift
    /// Resolves the shared per-server `AuthSession` (owner role, sign-out
    /// handling). Supplied by the app so ServerAdmin observes the same
    /// session instance as the rest of the shell.
    var sessionFor: (URL) -> AuthSession
```

Update the three construction sites — `SettingsView` in `MapleApp.swift:294`, `PhoneSettingsView.swift:44`, and any `#Preview` in `SelfHostedSettingsTab.swift` — to pass the resolver. `SettingsView` and `PhoneSettingsView` will each need the same property threaded through from `MapleApp`.

On macOS the `Settings` scene constructs `SettingsView()` directly, so pass `session(for:)` there:

```swift
        Settings {
            SettingsView(sessionFor: { server in session(for: server) })
        }
```

- [ ] **Step 4: Build both platforms**

Run:

```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" \
  -destination 'platform=macOS' build 2>&1 | tail -5
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **` for both

- [ ] **Step 5: Run the full package test suite**

Run: `cd src/apple/Packages/MapleCore && swift test --filter "Network|Auth" 2>&1 | tail -20`
Expected: 0 failures. The `Auth` filter catches regressions from the Task 5 factory extraction.

- [ ] **Step 6: Commit**

```bash
git add src/apple/Maple/MapleApp.swift src/apple/Maple/Views/SelfHostedSettingsTab.swift \
        src/apple/Maple/Views/PhoneSettingsView.swift
git commit -m "feat(apple): open ServerAdmin from the Cloud settings tab"
```

---

### Task 9: End-to-end verification against a real server

**Files:** none — this task produces evidence, not code.

No automated test covers the view layer, because XCUITest cannot run on this machine (#2525). This task is the substitute and is not optional.

- [ ] **Step 1: Start a throwaway Mongo and the API**

```bash
mkdir -p /tmp/maple-t0-mongo
mongod --dbpath /tmp/maple-t0-mongo --port 27077 --fork \
  --logpath /tmp/maple-t0-mongo/mongod.log
cd src/api && MONGO_URL=mongodb://localhost:27077 MAPLE_DEV_AUTH=1 bun run dev
```

Leave it running in a separate shell. Do not pipe this through `tail` — a piped long-running command gets killed.

- [ ] **Step 2: Confirm the endpoint answers**

Run: `curl -s http://localhost:3000/api/network/local-address`
Expected: a JSON object with an `available` key.

- [ ] **Step 3: Launch the built app and pair the local server**

Launch the built macOS app from DerivedData, add `localhost:3000` through Settings → Cloud → Add Server…, and sign in.

- [ ] **Step 4: Walk the acceptance criteria and record the result**

Confirm each of these by hand, noting the actual observed behaviour:

1. "Manage…" on the server row opens a resizable Server Admin window showing Network.
2. Two servers can be open in two admin windows at once without cross-talk. If only one server is paired, pair a second alias (`127.0.0.1:3000`) to exercise this.
3. Network loads and reports provenance. With no override set, the Address row reads `(auto-detected)` and **the override field is empty** — this is the rule that matters most.
4. Setting an override to `10.0.0.5`, saving, and reloading shows `(operator override)` and the override field now populated.
5. Clearing the field and saving returns the row to `(auto-detected)` with an empty override field.
6. Entering `99999` in Port and saving shows `Port must be an integer between 1 and 65535.` and issues no request.
7. Stopping the API and pressing Save surfaces the failure inline rather than showing "Saved."

- [ ] **Step 5: Tear down**

```bash
pkill -f "mongod --dbpath /tmp/maple-t0-mongo" && rm -rf /tmp/maple-t0-mongo
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/apple-server-admin-t0
gh pr create --title "feat(apple): ServerAdmin shell + Network settings page" \
  --body "$(cat <<'PRBODY'
Adds a per-server administration surface to Maple Exposure, entered from Settings → Cloud, and delivers the Network settings page inside it.

Server admin lives in its own resizable window on macOS rather than a Settings tab, because the Settings scene is a fixed 540×480 and the Workers table arriving in #2768 is eight columns wide. On iOS it presents as a sheet, which works identically from the iPhone push list and the iPad Settings modal.

The rule worth reviewing closely is in `NetworkSettingsForm.seeded(from:)`: an override field is populated only when the server reports `db_override` provenance. Seeding an auto-detected address would turn today's DHCP lease into a permanent manual override on the next save.

## Test plan

- `swift test --filter "Network|Auth"` in `Packages/MapleCore` — 18 tests covering wire shapes, explicit-null encoding, seed provenance, and port validation.
- Built for macOS and the iOS simulator.
- Manual pass against a local API with a throwaway mongod: provenance round-trip (auto-detected → override → cleared), local port validation, and save-failure handling with the API stopped.

XCUITest is not used — every class times out on this machine (#2525), which is why the seeding and validation rules live in a plain testable type rather than in the view.

Closes #2766
PRBODY
)"
```

---

## Self-Review

**Spec coverage.** Every element of #2766 maps to a task: the shell to Task 6, per-platform hosting to Tasks 6 and 8, the per-server client to Task 5, owner gating to Task 6 (`visible(isOwner:)`) with 403 surfacing via `ServerAdminError` in Task 1, the Network client to Task 3, the read-only resolved section with provenance and the unavailable warning to Task 7, the override form and its two rules to Tasks 4 and 7, the file budget to Task 7 Step 4, and verification to Task 9.

**One acceptance criterion is carried by Task 9 rather than by a test:** "two macOS admin windows without cross-talk." `WindowGroup(id:for:)` gives this structurally, but nothing asserts it automatically.

**Type consistency.** `NetworkValueSource.defaultValue` is used consistently (not `.default`, which is a Swift keyword). `NetworkSettingsForm.seeded(from:)` and `.validated()` keep those names in Tasks 4, 6, and 7. `ServerAdminError.from(data:response:)` keeps its signature across Tasks 1 and 3. `makeCloudHTTPClient(server:session:)` matches between Tasks 5, 6, and 8.

**Known risk, flagged rather than hidden.** Task 8 Step 3 threads a `sessionFor` closure through `SettingsView` and `PhoneSettingsView`, which touches files outside the ServerAdmin folder and is the most likely place to hit unexpected construction sites. If a fourth construction site appears, add the parameter there too rather than defaulting the closure — a default would silently create a second `AuthSession` per server and break the shared-instance guarantee that sign-out depends on.
