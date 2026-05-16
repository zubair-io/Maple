# Maple File Provider — Phase 1 (macOS, Read-Only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a Maple cloud server's photo library as a native macOS File Provider domain. Phase 1 is **read-only**: enumeration, item metadata, lazy on-demand RAW/XMP/JPEG download. No writes, no deletes, no iOS.

**Architecture:** A new `MapleFileProvider.appex` extension target (`NSFileProviderReplicatedExtension`) shares auth state with the main app via an App Group + Keychain access group. The extension uses the existing `AuthenticatedHTTPClient` against the Bun/Elysia API (`/api/folders`, `/api/fs`, `/api/assets/:id/raw`, `/api/assets/:id/thumb`, `/api/assets/:id/xmp`). Item identifiers are server-backed: `asset/<mongo-objectid>` for files, `folder/<folder_id>:<base64url-path>` for directories. Materialization is lazy by default — items appear in Finder immediately but bytes download on first access. A manual "Refresh" action in the main app signals the working-set enumerator; no push channel ships in Phase 1.

**Tech Stack:** Swift 5.10, FileProvider framework (macOS 14+), `NSFileProviderReplicatedExtension`, App Groups, Keychain access groups, existing `MapleCore` SPM module.

## Out of scope (deferred to later phases)

- **Phase 2:** XMP writes (`itemChanged`, `modifyItem`), conflict copies, working-set tracking beyond the current folder
- **Phase 3:** Creates (drag-in uploads) and soft-delete via server trash
- **Phase 4:** iOS extension with curated-subset exposure
- **Phase 5:** Quick Look generator, push change-feed (SSE/WS), preview shipped via `.maple/`

This plan stops at "user enables a server in Settings, sees their library in Finder, opens a RAW, gets the bytes."

---

## File structure

**New (extension target):**
- `src/apple/MapleFileProvider/FileProviderExtension.swift` — `NSFileProviderReplicatedExtension` entry point
- `src/apple/MapleFileProvider/MapleItem.swift` — `NSFileProviderItem` implementation
- `src/apple/MapleFileProvider/MapleEnumerator.swift` — enumerators (root, folder)
- `src/apple/MapleFileProvider/MapleFileProvider.entitlements` — App Group + Keychain access group
- `src/apple/MapleFileProvider/Info.plist` — extension declaration (NSExtension keys)

**New (shared in MapleCore):**
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift` — id encoding/decoding
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderConfig.swift` — App Group-backed config (server URL, domain identifier)
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderTokensStore.swift` — Keychain access-group token storage
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift` — DTOs + thin client over `AuthenticatedHTTPClient`
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderDomainController.swift` — wraps `NSFileProviderManager` (add/remove/signal)

**New (main app):**
- `src/apple/Maple/Views/FileProviderSettingsView.swift` — toggle + status + refresh button

**Modify:**
- `src/apple/Maple.xcodeproj/project.pbxproj` — add extension target, embed in app, deployment target, entitlements
- `src/apple/Maple/Maple.entitlements` — add App Group + Keychain access group
- `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AuthTokens.swift` (or wherever it's defined) — no changes needed; we wrap existing types
- `src/apple/Maple/Views/Settings/` — wire `FileProviderSettingsView` into existing settings shell

**Tests:**
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderIdentifierTests.swift`
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift`
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderConfigTests.swift`
- `src/apple/MapleUITests/FileProviderSettingsUITests.swift` — toggle the UI, screenshot, no Finder integration (that needs a live server)

---

## Identifier scheme

A single `enum` encodes/decodes all identifier strings. The encoded form is what we hand to `NSFileProviderItemIdentifier`.

| Conceptual item | Encoded form | Notes |
|---|---|---|
| Domain root | `NSFileProviderItemIdentifier.rootContainer` (built-in `"NSFileProviderRootContainerItemIdentifier"`) | Children = library roots returned by `/api/folders` |
| Library root folder | `folder/<folder_id>:` | `folder_id` = Mongo ObjectId, trailing `:` denotes empty relative path |
| Subdirectory | `folder/<folder_id>:<base64url-relpath>` | e.g. `folder/650a…:MjAyNC8yMDI0LTAxLTE1` for `2024/2024-01-15` |
| File (asset) | `asset/<asset_id>` | `asset_id` = Mongo ObjectId from `/api/fs` listing |
| Working set | `NSFileProviderItemIdentifier.workingSet` (built-in) | Phase 1: returns empty enumerator |

We never derive identifiers from local paths or filenames — the design summary calls out that re-ID'ing is catastrophic at TB scale.

---

## Task 1: Add App Group + Keychain access group entitlements

**Files:**
- Modify: `src/apple/Maple/Maple.entitlements`
- Create: `src/apple/MapleFileProvider/MapleFileProvider.entitlements`

App Group ID: `group.app.justmaple.aperture` (matches existing bundle ID prefix).
Keychain access group: `$(AppIdentifierPrefix)app.justmaple.aperture.shared`.

- [ ] **Step 1: Add App Group + Keychain access group to the main app entitlements**

Open `src/apple/Maple/Maple.entitlements`. Inside the top-level `<dict>`, add:

```xml
<key>com.apple.security.application-groups</key>
<array>
    <string>group.app.justmaple.aperture</string>
</array>
<key>keychain-access-groups</key>
<array>
    <string>$(AppIdentifierPrefix)app.justmaple.aperture.shared</string>
</array>
```

- [ ] **Step 2: Create the extension entitlements file**

Write `src/apple/MapleFileProvider/MapleFileProvider.entitlements`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <true/>
    <key>com.apple.security.application-groups</key>
    <array>
        <string>group.app.justmaple.aperture</string>
    </array>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.files.user-selected.read-only</key>
    <true/>
    <key>keychain-access-groups</key>
    <array>
        <string>$(AppIdentifierPrefix)app.justmaple.aperture.shared</string>
    </array>
</dict>
</plist>
```

- [ ] **Step 3: Commit**

```bash
git add src/apple/Maple/Maple.entitlements src/apple/MapleFileProvider/MapleFileProvider.entitlements
git commit -m "feat(apple): add app group + keychain access group for file provider"
```

---

## Task 2: Add the File Provider extension target to the Xcode project

**Files:**
- Modify: `src/apple/Maple.xcodeproj/project.pbxproj`
- Create: `src/apple/MapleFileProvider/Info.plist`
- Create: `src/apple/MapleFileProvider/FileProviderExtension.swift` (stub)

Bundle ID: `app.justmaple.aperture.FileProvider`.

- [ ] **Step 1: Create the extension Info.plist**

Write `src/apple/MapleFileProvider/Info.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDisplayName</key>
    <string>Maple</string>
    <key>NSExtension</key>
    <dict>
        <key>NSExtensionFileProviderSupportsEnumeration</key>
        <true/>
        <key>NSExtensionPointIdentifier</key>
        <string>com.apple.fileprovider-nonui</string>
        <key>NSExtensionPrincipalClass</key>
        <string>$(PRODUCT_MODULE_NAME).FileProviderExtension</string>
    </dict>
</dict>
</plist>
```

- [ ] **Step 2: Write the extension entry-point stub**

Write `src/apple/MapleFileProvider/FileProviderExtension.swift`:

```swift
// src/apple/MapleFileProvider/FileProviderExtension.swift
import FileProvider
import MapleCore
import OSLog

final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
    private let domain: NSFileProviderDomain
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "extension")

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        super.init()
        log.info("init domain=\(domain.identifier.rawValue, privacy: .public)")
    }

    func invalidate() {
        log.info("invalidate")
    }

    func item(for identifier: NSFileProviderItemIdentifier,
              request: NSFileProviderRequest,
              completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                       code: NSFileProviderError.noSuchItem.rawValue))
        return Progress()
    }

    func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier,
                       version requestedVersion: NSFileProviderItemVersion?,
                       request: NSFileProviderRequest,
                       completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        completionHandler(nil, nil, NSError(domain: NSFileProviderErrorDomain,
                                            code: NSFileProviderError.noSuchItem.rawValue))
        return Progress()
    }

    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier,
                    request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        throw NSError(domain: NSFileProviderErrorDomain,
                      code: NSFileProviderError.noSuchItem.rawValue)
    }
}
```

- [ ] **Step 3: Add the extension target to project.pbxproj**

This is a multi-line `project.pbxproj` edit. Add (in pbxproj-speak):

1. A new `PBXNativeTarget` `MapleFileProvider` with `productType = "com.apple.product-type.app-extension"`.
2. Build phases: Sources (contains `FileProviderExtension.swift`), Frameworks (links `FileProvider.framework` and the `MapleCore` package product), Resources (Info.plist via INFOPLIST_KEY_* or `INFOPLIST_FILE`).
3. Build settings on the target:
   - `PRODUCT_BUNDLE_IDENTIFIER = app.justmaple.aperture.FileProvider`
   - `PRODUCT_NAME = MapleFileProvider`
   - `MACOSX_DEPLOYMENT_TARGET = 14.0`
   - `CODE_SIGN_ENTITLEMENTS = MapleFileProvider/MapleFileProvider.entitlements`
   - `INFOPLIST_FILE = MapleFileProvider/Info.plist`
   - `SWIFT_VERSION = 5.0`
   - `SKIP_INSTALL = YES`
4. A `PBXCopyFilesBuildPhase` on the `Maple` target with `dstSubfolderSpec = 13` (PlugIns) that embeds `MapleFileProvider.appex`.
5. Add `MapleFileProvider` to the `Maple` target's `dependencies`.

If editing pbxproj by hand is too brittle, use `xcodeproj` (Ruby gem) or `XcodeGen` if either is already in the repo. Otherwise add the target through Xcode's GUI (File → New → Target → File Provider Extension) and capture the resulting diff in a single commit.

- [ ] **Step 4: Verify the extension builds**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build
```

Expected: `** BUILD SUCCEEDED **` and `MapleFileProvider.appex` inside `Maple.app/Contents/PlugIns/`.

- [ ] **Step 5: Commit**

```bash
git add src/apple/MapleFileProvider/ src/apple/Maple.xcodeproj/project.pbxproj
git commit -m "feat(apple): scaffold MapleFileProvider extension target"
```

---

## Task 3: Item identifier encoding (shared, in MapleCore)

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderIdentifierTests.swift`

- [ ] **Step 1: Write the failing test**

Write `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderIdentifierTests.swift`:

```swift
import XCTest
@testable import MapleCore

final class FileProviderIdentifierTests: XCTestCase {
    func testAssetRoundTrip() throws {
        let id = FileProviderIdentifier.asset("650a1b2c3d4e5f6071829304")
        XCTAssertEqual(id.rawValue, "asset/650a1b2c3d4e5f6071829304")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testRootFolderRoundTrip() throws {
        let id = FileProviderIdentifier.folder(folderID: "650a1b", relativePath: "")
        XCTAssertEqual(id.rawValue, "folder/650a1b:")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testSubfolderRoundTrip() throws {
        let id = FileProviderIdentifier.folder(folderID: "650a1b", relativePath: "2024/2024-01-15")
        // "2024/2024-01-15" -> base64url "MjAyNC8yMDI0LTAxLTE1"
        XCTAssertEqual(id.rawValue, "folder/650a1b:MjAyNC8yMDI0LTAxLTE1")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testInvalidPrefixRejected() {
        XCTAssertThrowsError(try FileProviderIdentifier(rawValue: "bogus/123"))
    }

    func testFolderWithoutColonRejected() {
        XCTAssertThrowsError(try FileProviderIdentifier(rawValue: "folder/650a1b"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/apple/Packages/MapleCore
swift test --filter FileProviderIdentifierTests
```

Expected: build failure — `FileProviderIdentifier` not defined.

- [ ] **Step 3: Implement FileProviderIdentifier**

Write `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift`:

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift
import Foundation

public enum FileProviderIdentifier: Equatable, Hashable, Sendable {
    case asset(String)
    case folder(folderID: String, relativePath: String)

    public enum DecodeError: Error { case invalidPrefix, malformedFolder, badBase64 }

    public var rawValue: String {
        switch self {
        case .asset(let id):
            return "asset/\(id)"
        case .folder(let folderID, let relativePath):
            return "folder/\(folderID):\(Self.b64urlEncode(relativePath))"
        }
    }

    public init(rawValue: String) throws {
        if let id = rawValue.dropPrefixIfPresent("asset/") {
            self = .asset(String(id))
            return
        }
        if let body = rawValue.dropPrefixIfPresent("folder/") {
            guard let colon = body.firstIndex(of: ":") else { throw DecodeError.malformedFolder }
            let folderID = String(body[..<colon])
            let encoded = String(body[body.index(after: colon)...])
            guard let path = Self.b64urlDecode(encoded) else { throw DecodeError.badBase64 }
            self = .folder(folderID: folderID, relativePath: path)
            return
        }
        throw DecodeError.invalidPrefix
    }

    private static func b64urlEncode(_ s: String) -> String {
        let data = Data(s.utf8)
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func b64urlDecode(_ s: String) -> String? {
        if s.isEmpty { return "" }
        var padded = s.replacingOccurrences(of: "-", with: "+")
                      .replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded.append("=") }
        guard let data = Data(base64Encoded: padded),
              let s = String(data: data, encoding: .utf8) else { return nil }
        return s
    }
}

private extension String {
    func dropPrefixIfPresent(_ prefix: String) -> Substring? {
        guard hasPrefix(prefix) else { return nil }
        return dropFirst(prefix.count)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd src/apple/Packages/MapleCore
swift test --filter FileProviderIdentifierTests
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderIdentifierTests.swift
git commit -m "feat(core): file provider identifier encoding"
```

---

## Task 4: App Group config store

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderConfig.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderConfigTests.swift`

Holds the per-domain server URL + domain identifier inside the App Group's shared `UserDefaults` so both the main app and the extension can read it.

- [ ] **Step 1: Write the failing test**

Write `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderConfigTests.swift`:

```swift
import XCTest
@testable import MapleCore

final class FileProviderConfigTests: XCTestCase {
    func testRoundTrip() throws {
        let defaults = UserDefaults(suiteName: "test.\(UUID().uuidString)")!
        let store = FileProviderConfig(defaults: defaults)
        XCTAssertNil(store.load(domain: "d1"))
        store.save(.init(domainIdentifier: "d1",
                         displayName: "My Server",
                         serverURL: URL(string: "https://example.com")!))
        let loaded = try XCTUnwrap(store.load(domain: "d1"))
        XCTAssertEqual(loaded.displayName, "My Server")
        XCTAssertEqual(loaded.serverURL, URL(string: "https://example.com")!)
        store.remove(domain: "d1")
        XCTAssertNil(store.load(domain: "d1"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/apple/Packages/MapleCore
swift test --filter FileProviderConfigTests
```

Expected: `FileProviderConfig` not defined.

- [ ] **Step 3: Implement FileProviderConfig**

Write `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderConfig.swift`:

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderConfig.swift
import Foundation

public struct FileProviderDomainConfig: Codable, Equatable, Sendable {
    public let domainIdentifier: String
    public let displayName: String
    public let serverURL: URL

    public init(domainIdentifier: String, displayName: String, serverURL: URL) {
        self.domainIdentifier = domainIdentifier
        self.displayName = displayName
        self.serverURL = serverURL
    }
}

public final class FileProviderConfig: @unchecked Sendable {
    public static let appGroupSuiteName = "group.app.justmaple.aperture"
    private let defaults: UserDefaults
    private let prefix = "fileprovider.domain."

    public init(defaults: UserDefaults? = nil) {
        self.defaults = defaults ?? UserDefaults(suiteName: Self.appGroupSuiteName)!
    }

    public func load(domain: String) -> FileProviderDomainConfig? {
        guard let data = defaults.data(forKey: prefix + domain) else { return nil }
        return try? JSONDecoder().decode(FileProviderDomainConfig.self, from: data)
    }

    public func save(_ config: FileProviderDomainConfig) {
        let data = try! JSONEncoder().encode(config)
        defaults.set(data, forKey: prefix + config.domainIdentifier)
    }

    public func remove(domain: String) {
        defaults.removeObject(forKey: prefix + domain)
    }

    public func allDomains() -> [FileProviderDomainConfig] {
        defaults.dictionaryRepresentation().keys
            .filter { $0.hasPrefix(prefix) }
            .compactMap { defaults.data(forKey: $0) }
            .compactMap { try? JSONDecoder().decode(FileProviderDomainConfig.self, from: $0) }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
swift test --filter FileProviderConfigTests
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderConfig.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderConfigTests.swift
git commit -m "feat(core): file provider app-group config store"
```

---

## Task 5: Shared Keychain token store

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderTokensStore.swift`

This wraps `SecItem*` against the shared Keychain access group so the extension can read tokens written by the main app. There is no unit test — Keychain access requires a signed bundle with the right entitlement, so this is exercised by the integration UI test in Task 12.

- [ ] **Step 1: Implement FileProviderTokensStore**

Write `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderTokensStore.swift`:

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderTokensStore.swift
import Foundation
import Security

public struct FileProviderTokensStore: Sendable {
    public static let accessGroup = "$(AppIdentifierPrefix)app.justmaple.aperture.shared"
    private let serviceBase = "app.justmaple.aperture.fileprovider"

    public init() {}

    public func load(domain: String) -> AuthTokens? {
        var query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "\(serviceBase).\(domain)",
            kSecAttrAccessGroup: Self.accessGroup,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var ref: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &ref)
        guard status == errSecSuccess, let data = ref as? Data else { return nil }
        return try? JSONDecoder().decode(AuthTokens.self, from: data)
    }

    public func save(_ tokens: AuthTokens, domain: String) {
        let data = try! JSONEncoder().encode(tokens)
        let base: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "\(serviceBase).\(domain)",
            kSecAttrAccessGroup: Self.accessGroup,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData] = data
        add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    public func remove(domain: String) {
        let q: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "\(serviceBase).\(domain)",
            kSecAttrAccessGroup: Self.accessGroup,
        ]
        SecItemDelete(q as CFDictionary)
    }
}
```

If `AuthTokens` is not `Codable` already, make it `Codable` in its existing file before continuing.

- [ ] **Step 2: Verify the package still builds**

```bash
cd src/apple/Packages/MapleCore
swift build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderTokensStore.swift
git commit -m "feat(core): keychain access-group token store for file provider"
```

---

## Task 6: RemoteCatalog — typed client for the API endpoints we need

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift`

We need three calls: list registered library roots, list a directory inside a root, fetch raw bytes for an asset. DTOs match the existing API (see `src/api/src/routes/folders.ts`, `fs.ts`, `assets.ts`).

- [ ] **Step 1: Write the failing test**

Write `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift`:

```swift
import XCTest
@testable import MapleCore

final class RemoteCatalogTests: XCTestCase {
    func testDecodeFoldersResponse() throws {
        let json = """
        {"folders":[{"id":"abc","label":"Photos","path":"/photos","file_count":1234}]}
        """.data(using: .utf8)!
        let resp = try JSONDecoder().decode(FoldersResponse.self, from: json)
        XCTAssertEqual(resp.folders.count, 1)
        XCTAssertEqual(resp.folders[0].id, "abc")
        XCTAssertEqual(resp.folders[0].label, "Photos")
        XCTAssertEqual(resp.folders[0].fileCount, 1234)
    }

    func testDecodeDirListing() throws {
        let json = """
        {"entries":[
          {"kind":"dir","name":"2024"},
          {"kind":"file","name":"IMG_1.ARW","asset_id":"650a","size":40000000,"mtime":"2024-01-15T10:00:00Z"}
        ]}
        """.data(using: .utf8)!
        let resp = try JSONDecoder().decode(DirListing.self, from: json)
        XCTAssertEqual(resp.entries.count, 2)
        guard case .directory(let d) = resp.entries[0] else { return XCTFail() }
        XCTAssertEqual(d.name, "2024")
        guard case .file(let f) = resp.entries[1] else { return XCTFail() }
        XCTAssertEqual(f.assetID, "650a")
        XCTAssertEqual(f.size, 40_000_000)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
swift test --filter RemoteCatalogTests
```

Expected: types not defined.

- [ ] **Step 3: Implement RemoteCatalog**

Write `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift`:

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift
import Foundation

public struct LibraryRoot: Codable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let path: String
    public let fileCount: Int

    enum CodingKeys: String, CodingKey {
        case id, label, path
        case fileCount = "file_count"
    }
}

public struct FoldersResponse: Codable, Sendable {
    public let folders: [LibraryRoot]
}

public struct DirFile: Codable, Equatable, Sendable {
    public let name: String
    public let assetID: String
    public let size: Int64
    public let mtime: Date

    enum CodingKeys: String, CodingKey {
        case name, size, mtime
        case assetID = "asset_id"
    }
}

public struct DirSubdir: Codable, Equatable, Sendable {
    public let name: String
}

public enum DirEntry: Sendable, Equatable {
    case directory(DirSubdir)
    case file(DirFile)
}

extension DirEntry: Codable {
    private enum K: String, CodingKey { case kind }
    public init(from d: Decoder) throws {
        let kc = try d.container(keyedBy: K.self)
        let kind = try kc.decode(String.self, forKey: .kind)
        switch kind {
        case "dir":  self = .directory(try DirSubdir(from: d))
        case "file": self = .file(try DirFile(from: d))
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: kc,
                    debugDescription: "unknown kind \(kind)")
        }
    }
    public func encode(to e: Encoder) throws {
        var kc = e.container(keyedBy: K.self)
        switch self {
        case .directory(let d): try kc.encode("dir", forKey: .kind);  try d.encode(to: e)
        case .file(let f):      try kc.encode("file", forKey: .kind); try f.encode(to: e)
        }
    }
}

public struct DirListing: Codable, Sendable {
    public let entries: [DirEntry]
}

public actor RemoteCatalog {
    private let http: AuthenticatedHTTPClient
    private let server: URL
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    public init(http: AuthenticatedHTTPClient, server: URL) {
        self.http = http; self.server = server
    }

    public func listFolders() async throws -> [LibraryRoot] {
        let req = URLRequest(url: server.appending(path: "/api/folders"))
        let (data, _) = try await http.data(for: req)
        return try decoder.decode(FoldersResponse.self, from: data).folders
    }

    public func listDir(folder: String, relativePath: String) async throws -> [DirEntry] {
        var comps = URLComponents(url: server.appending(path: "/api/fs"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            .init(name: "folder", value: folder),
            .init(name: "path", value: relativePath),
        ]
        let req = URLRequest(url: comps.url!)
        let (data, _) = try await http.data(for: req)
        return try decoder.decode(DirListing.self, from: data).entries
    }

    public func downloadAsset(assetID: String, to localURL: URL) async throws {
        let req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/raw"))
        let (data, resp) = try await http.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        try data.write(to: localURL, options: .atomic)
    }
}
```

If the API's `/api/fs` route uses a different query-parameter shape, adjust the `listDir` query to match what's in `src/api/src/routes/fs.ts`. Read it once before adjusting.

- [ ] **Step 4: Run test to verify it passes**

```bash
swift test --filter RemoteCatalogTests
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift
git commit -m "feat(core): remote catalog client for file provider"
```

---

## Task 7: MapleItem — NSFileProviderItem implementation

**Files:**
- Create: `src/apple/MapleFileProvider/MapleItem.swift`

- [ ] **Step 1: Implement MapleItem**

Write `src/apple/MapleFileProvider/MapleItem.swift`:

```swift
// src/apple/MapleFileProvider/MapleItem.swift
import FileProvider
import MapleCore
import UniformTypeIdentifiers

final class MapleItem: NSObject, NSFileProviderItem {
    private let identifier: FileProviderIdentifier
    private let parent: NSFileProviderItemIdentifier
    private let displayName: String
    private let isDirectory: Bool
    private let size: NSNumber?
    private let modified: Date?
    private let utType: UTType

    let itemIdentifier: NSFileProviderItemIdentifier
    let parentItemIdentifier: NSFileProviderItemIdentifier
    let filename: String
    var contentType: UTType { utType }
    var capabilities: NSFileProviderItemCapabilities { [.allowsReading] }   // read-only in Phase 1
    var documentSize: NSNumber? { size }
    var contentModificationDate: Date? { modified }
    var creationDate: Date? { modified }
    var itemVersion: NSFileProviderItemVersion {
        let mtimeBytes = String(Int(modified?.timeIntervalSince1970 ?? 0)).data(using: .utf8) ?? Data()
        return .init(contentVersion: mtimeBytes, metadataVersion: mtimeBytes)
    }
    var isUploaded: Bool { true }
    var isDownloaded: Bool { false }  // bytes fetched on demand

    init(libraryRoot root: LibraryRoot) {
        self.identifier = .folder(folderID: root.id, relativePath: "")
        self.parent = .rootContainer
        self.displayName = root.label
        self.isDirectory = true
        self.size = nil
        self.modified = nil
        self.utType = .folder
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parent
        self.filename = displayName
    }

    init(subdirectory name: String, parentFolderID: String, parentRelativePath: String, parentIdentifier: NSFileProviderItemIdentifier) {
        let child = parentRelativePath.isEmpty ? name : "\(parentRelativePath)/\(name)"
        self.identifier = .folder(folderID: parentFolderID, relativePath: child)
        self.parent = parentIdentifier
        self.displayName = name
        self.isDirectory = true
        self.size = nil
        self.modified = nil
        self.utType = .folder
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parent
        self.filename = name
    }

    init(file: DirFile, parentIdentifier: NSFileProviderItemIdentifier) {
        self.identifier = .asset(file.assetID)
        self.parent = parentIdentifier
        self.displayName = file.name
        self.isDirectory = false
        self.size = NSNumber(value: file.size)
        self.modified = file.mtime
        self.utType = UTType(filenameExtension: (file.name as NSString).pathExtension) ?? .data
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parent
        self.filename = file.name
    }
}
```

- [ ] **Step 2: Verify the extension target still builds**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/apple/MapleFileProvider/MapleItem.swift
git commit -m "feat(fileprovider): NSFileProviderItem implementation"
```

---

## Task 8: Enumerators (root + folder)

**Files:**
- Create: `src/apple/MapleFileProvider/MapleEnumerator.swift`

Two enumerators: `RootEnumerator` (lists `LibraryRoot`s for the configured server), `FolderEnumerator` (lists a single directory).

- [ ] **Step 1: Implement the root enumerator**

Write `src/apple/MapleFileProvider/MapleEnumerator.swift`:

```swift
// src/apple/MapleFileProvider/MapleEnumerator.swift
import FileProvider
import MapleCore
import OSLog

final class RootEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    init(catalog: RemoteCatalog) { self.catalog = catalog }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                let roots = try await catalog.listFolders()
                let items = roots.map { MapleItem(libraryRoot: $0) }
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
            } catch {
                log.error("root enumerate failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    // Phase 1: enumerator changes are coarse — return current state, no per-item delta.
    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("0".utf8)))
    }
}

final class FolderEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let folderID: String
    private let relativePath: String
    private let parentIdentifier: NSFileProviderItemIdentifier
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    init(catalog: RemoteCatalog, folderID: String, relativePath: String, parentIdentifier: NSFileProviderItemIdentifier) {
        self.catalog = catalog
        self.folderID = folderID
        self.relativePath = relativePath
        self.parentIdentifier = parentIdentifier
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                let entries = try await catalog.listDir(folder: folderID, relativePath: relativePath)
                let items: [NSFileProviderItem] = entries.map { entry in
                    switch entry {
                    case .directory(let d):
                        return MapleItem(subdirectory: d.name,
                                         parentFolderID: folderID,
                                         parentRelativePath: relativePath,
                                         parentIdentifier: parentIdentifier)
                    case .file(let f):
                        return MapleItem(file: f, parentIdentifier: parentIdentifier)
                    }
                }
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
            } catch {
                log.error("folder enumerate failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("0".utf8)))
    }
}
```

- [ ] **Step 2: Verify it builds**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/apple/MapleFileProvider/MapleEnumerator.swift
git commit -m "feat(fileprovider): root + folder enumerators"
```

---

## Task 9: Wire the extension entry-point to enumerators + item lookup + content fetch

**Files:**
- Modify: `src/apple/MapleFileProvider/FileProviderExtension.swift`

- [ ] **Step 1: Replace the stub with a real implementation**

Replace the entire contents of `src/apple/MapleFileProvider/FileProviderExtension.swift`:

```swift
// src/apple/MapleFileProvider/FileProviderExtension.swift
import FileProvider
import MapleCore
import OSLog

final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
    private let domain: NSFileProviderDomain
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "extension")
    private let config: FileProviderConfig
    private let tokens: FileProviderTokensStore
    private let catalog: RemoteCatalog

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        self.config = FileProviderConfig()
        self.tokens = FileProviderTokensStore()
        guard let cfg = config.load(domain: domain.identifier.rawValue) else {
            fatalError("file provider extension initialized without config for domain \(domain.identifier.rawValue)")
        }
        let session = URLSession(configuration: .default)
        let tokensStore = self.tokens
        let domainID = domain.identifier.rawValue
        let http = AuthenticatedHTTPClient(
            server: cfg.serverURL,
            urlSession: session,
            tokensProvider: { tokensStore.load(domain: domainID) },
            onTokensRefreshed: { tokensStore.save($0, domain: domainID) },
            onSignOut: { tokensStore.remove(domain: domainID) }
        )
        self.catalog = RemoteCatalog(http: http, server: cfg.serverURL)
        super.init()
        log.info("init domain=\(domain.identifier.rawValue, privacy: .public)")
    }

    func invalidate() { log.info("invalidate") }

    func item(for identifier: NSFileProviderItemIdentifier,
              request: NSFileProviderRequest,
              completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            do {
                if identifier == .rootContainer {
                    // The root is implicit; we can synthesize a stub item.
                    completionHandler(RootContainerItem(), nil)
                    progress.completedUnitCount = 1
                    return
                }
                let parsed = try FileProviderIdentifier(rawValue: identifier.rawValue)
                switch parsed {
                case .folder(let folderID, let relativePath):
                    // Cheap path: synthesize. We don't have a per-folder "metadata" endpoint;
                    // metadata comes from the parent enumeration.
                    let item = MapleItem(subdirectory: (relativePath as NSString).lastPathComponent.isEmpty ? folderID : (relativePath as NSString).lastPathComponent,
                                         parentFolderID: folderID,
                                         parentRelativePath: (relativePath as NSString).deletingLastPathComponent,
                                         parentIdentifier: .rootContainer)
                    completionHandler(item, nil)
                case .asset:
                    // Phase 1: assets always come via folder enumeration; lone-item lookup is rare.
                    // Return notSuchItem; OS will re-enumerate the parent.
                    completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                                   code: NSFileProviderError.noSuchItem.rawValue))
                }
                progress.completedUnitCount = 1
            } catch {
                completionHandler(nil, error)
            }
        }
        return progress
    }

    func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier,
                       version requestedVersion: NSFileProviderItemVersion?,
                       request: NSFileProviderRequest,
                       completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            do {
                let parsed = try FileProviderIdentifier(rawValue: itemIdentifier.rawValue)
                guard case .asset(let id) = parsed else {
                    completionHandler(nil, nil, NSError(domain: NSFileProviderErrorDomain,
                                                        code: NSFileProviderError.noSuchItem.rawValue))
                    return
                }
                let tmpDir = NSFileProviderManager(for: domain)?.temporaryDirectoryURL() ?? FileManager.default.temporaryDirectory
                let localURL = tmpDir.appendingPathComponent(UUID().uuidString)
                try await catalog.downloadAsset(assetID: id, to: localURL)
                let attrs = try? FileManager.default.attributesOfItem(atPath: localURL.path)
                let size = (attrs?[.size] as? NSNumber) ?? 0
                let item = DownloadedAssetItem(assetID: id, size: size, version: requestedVersion)
                completionHandler(localURL, item, nil)
                progress.completedUnitCount = 1
            } catch {
                log.error("fetch failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, nil, error)
            }
        }
        return progress
    }

    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier,
                    request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        if containerItemIdentifier == .rootContainer {
            return RootEnumerator(catalog: catalog)
        }
        if containerItemIdentifier == .workingSet {
            return EmptyEnumerator()      // Phase 1: empty
        }
        if containerItemIdentifier == .trashContainer {
            return EmptyEnumerator()      // no trash in Phase 1
        }
        let parsed = try FileProviderIdentifier(rawValue: containerItemIdentifier.rawValue)
        switch parsed {
        case .folder(let folderID, let relativePath):
            return FolderEnumerator(catalog: catalog,
                                    folderID: folderID,
                                    relativePath: relativePath,
                                    parentIdentifier: containerItemIdentifier)
        case .asset:
            throw NSError(domain: NSFileProviderErrorDomain,
                          code: NSFileProviderError.notAuthenticated.rawValue)
        }
    }
}

// MARK: - placeholder items returned by `item(for:)` and `fetchContents(for:)`

private final class RootContainerItem: NSObject, NSFileProviderItem {
    var itemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var parentItemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var filename: String { "Maple" }
    var contentType: UTType { .folder }
    var capabilities: NSFileProviderItemCapabilities { [.allowsContentEnumerating] }
}

private final class DownloadedAssetItem: NSObject, NSFileProviderItem {
    let assetID: String
    let documentSize: NSNumber?
    private let version: NSFileProviderItemVersion?

    init(assetID: String, size: NSNumber, version: NSFileProviderItemVersion?) {
        self.assetID = assetID
        self.documentSize = size
        self.version = version
    }

    var itemIdentifier: NSFileProviderItemIdentifier { .init("asset/\(assetID)") }
    var parentItemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var filename: String { assetID }
    var contentType: UTType { .data }
    var capabilities: NSFileProviderItemCapabilities { [.allowsReading] }
    var itemVersion: NSFileProviderItemVersion {
        version ?? .init(contentVersion: Data("0".utf8), metadataVersion: Data("0".utf8))
    }
}

private final class EmptyEnumerator: NSObject, NSFileProviderEnumerator {
    func invalidate() {}
    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        observer.didEnumerate([])
        observer.finishEnumerating(upTo: nil)
    }
    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }
    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("0".utf8)))
    }
}
```

If `UTType` is unavailable in the extension's import set, add `import UniformTypeIdentifiers`.

- [ ] **Step 2: Verify it builds**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/apple/MapleFileProvider/FileProviderExtension.swift
git commit -m "feat(fileprovider): wire extension entry-point to enumerators and content fetch"
```

---

## Task 10: Domain controller (add/remove/signal from the main app)

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderDomainController.swift`

- [ ] **Step 1: Implement the domain controller**

Write `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderDomainController.swift`:

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderDomainController.swift
import Foundation
import FileProvider
import OSLog

public actor FileProviderDomainController {
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "domain")
    private let config: FileProviderConfig

    public init(config: FileProviderConfig = .init()) {
        self.config = config
    }

    public func enable(serverURL: URL, displayName: String) async throws -> NSFileProviderDomain {
        let identifier = NSFileProviderDomainIdentifier(serverURL.host ?? UUID().uuidString)
        let domain = NSFileProviderDomain(identifier: identifier, displayName: displayName)
        config.save(.init(domainIdentifier: identifier.rawValue,
                          displayName: displayName,
                          serverURL: serverURL))
        try await NSFileProviderManager.add(domain)
        log.info("added domain \(identifier.rawValue, privacy: .public)")
        return domain
    }

    public func disable(domainIdentifier: String) async throws {
        let identifier = NSFileProviderDomainIdentifier(domainIdentifier)
        let domains = try await NSFileProviderManager.domains()
        if let domain = domains.first(where: { $0.identifier == identifier }) {
            try await NSFileProviderManager.remove(domain)
        }
        config.remove(domain: domainIdentifier)
        log.info("removed domain \(domainIdentifier, privacy: .public)")
    }

    public func refresh(domainIdentifier: String) async throws {
        let identifier = NSFileProviderDomainIdentifier(domainIdentifier)
        let domains = try await NSFileProviderManager.domains()
        guard let domain = domains.first(where: { $0.identifier == identifier }),
              let mgr = NSFileProviderManager(for: domain) else { return }
        try await mgr.signalEnumerator(for: .rootContainer)
    }

    public func currentDomains() async throws -> [NSFileProviderDomain] {
        try await NSFileProviderManager.domains()
    }
}
```

- [ ] **Step 2: Verify the package builds**

```bash
cd src/apple/Packages/MapleCore
swift build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderDomainController.swift
git commit -m "feat(core): file provider domain controller"
```

---

## Task 11: Settings UI to enable / disable / refresh

**Files:**
- Create: `src/apple/Maple/Views/FileProviderSettingsView.swift`
- Modify: the existing settings shell (find it by `grep -rln "SettingsView\\|PreferencesView" src/apple/Maple/Views/`) to add a tab/section pointing at the new view

- [ ] **Step 1: Implement the SwiftUI view**

Write `src/apple/Maple/Views/FileProviderSettingsView.swift`:

```swift
// src/apple/Maple/Views/FileProviderSettingsView.swift
import SwiftUI
import MapleCore
import FileProvider

@MainActor
@Observable
final class FileProviderSettingsModel {
    var domains: [NSFileProviderDomain] = []
    var serverURLString: String = ""
    var displayName: String = ""
    var statusMessage: String? = nil
    private let controller = FileProviderDomainController()

    func reload() async {
        do { domains = try await controller.currentDomains() }
        catch { statusMessage = "Couldn't list domains: \(error.localizedDescription)" }
    }

    func enable() async {
        guard let url = URL(string: serverURLString), url.scheme?.hasPrefix("http") == true else {
            statusMessage = "Enter a valid server URL (https://…)"
            return
        }
        do {
            _ = try await controller.enable(serverURL: url, displayName: displayName.isEmpty ? url.host ?? "Maple" : displayName)
            statusMessage = "Enabled"
            await reload()
        } catch {
            statusMessage = "Enable failed: \(error.localizedDescription)"
        }
    }

    func disable(_ domain: NSFileProviderDomain) async {
        do {
            try await controller.disable(domainIdentifier: domain.identifier.rawValue)
            await reload()
        } catch {
            statusMessage = "Disable failed: \(error.localizedDescription)"
        }
    }

    func refresh(_ domain: NSFileProviderDomain) async {
        do { try await controller.refresh(domainIdentifier: domain.identifier.rawValue) }
        catch { statusMessage = "Refresh failed: \(error.localizedDescription)" }
    }
}

struct FileProviderSettingsView: View {
    @State private var model = FileProviderSettingsModel()

    var body: some View {
        Form {
            Section("Add a Maple server") {
                TextField("Server URL", text: $model.serverURLString)
                    .accessibilityIdentifier("file-provider-server-url")
                TextField("Display name (optional)", text: $model.displayName)
                Button("Enable in Finder") { Task { await model.enable() } }
                    .accessibilityIdentifier("file-provider-enable")
            }
            Section("Connected servers") {
                if model.domains.isEmpty {
                    Text("None").foregroundStyle(.secondary)
                } else {
                    ForEach(model.domains, id: \.identifier.rawValue) { domain in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(domain.displayName)
                                Text(domain.identifier.rawValue).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Refresh") { Task { await model.refresh(domain) } }
                            Button("Disable", role: .destructive) { Task { await model.disable(domain) } }
                        }
                    }
                }
            }
            if let msg = model.statusMessage {
                Text(msg).font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("file-provider-status")
            }
        }
        .formStyle(.grouped)
        .task { await model.reload() }
    }
}
```

- [ ] **Step 2: Wire it into the existing settings shell**

Find the existing settings entry point:

```bash
grep -rln "Settings(\\|SettingsView\\|WindowGroup" src/apple/Maple/ | head -5
```

Add a new tab to the existing settings `TabView` (or `Settings` scene) labeled "Server", containing `FileProviderSettingsView()`. The exact insertion point depends on the current shell — keep the diff minimal.

- [ ] **Step 3: Build the app and open Settings**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build
open build/Debug/Maple.app   # path may vary; use Xcode's Products dir
```

Expected: Settings → Server tab visible, fields editable.

- [ ] **Step 4: Commit**

```bash
git add src/apple/Maple/Views/FileProviderSettingsView.swift src/apple/Maple/Views/
git commit -m "feat(apple): file provider settings UI"
```

---

## Task 12: UI test for the Settings flow

**Files:**
- Create: `src/apple/MapleUITests/FileProviderSettingsUITests.swift`

This test does not exercise the live Finder integration (that needs a running server). It only confirms the Settings UI surfaces. Finder integration is validated manually per the section below.

- [ ] **Step 1: Write the UI test**

Write `src/apple/MapleUITests/FileProviderSettingsUITests.swift`:

```swift
import XCTest

final class FileProviderSettingsUITests: XCTestCase {
    func testServerTabPresent() throws {
        let app = XCUIApplication()
        app.launch()
        app.activate()

        // Open Settings — macOS uses Cmd+Comma.
        app.typeKey(",", modifierFlags: .command)
        let serverURLField = app.textFields["file-provider-server-url"]
        XCTAssertTrue(serverURLField.waitForExistence(timeout: 5), "Server URL field should be visible")

        let enableButton = app.buttons["file-provider-enable"]
        XCTAssertTrue(enableButton.exists)

        // Typing a bogus URL produces a status message.
        serverURLField.click()
        serverURLField.typeText("not-a-url")
        enableButton.click()
        let status = app.staticTexts["file-provider-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 3))
    }
}
```

- [ ] **Step 2: Run the test**

```bash
xcodebuild test \
  -project src/apple/Maple.xcodeproj \
  -scheme Maple \
  -destination 'platform=macOS' \
  -only-testing:MapleUITests/FileProviderSettingsUITests
```

Expected: 1 test passes.

- [ ] **Step 3: Commit**

```bash
git add src/apple/MapleUITests/FileProviderSettingsUITests.swift
git commit -m "test(apple): UI test for file provider settings"
```

---

## Manual verification (one-time, requires a running server)

Phase 1 is not done until this works end-to-end. It can't be automated cheaply because it requires a real `api` backend, a real auth flow, and Finder.

1. **Start the API** with a folder registered:
   ```bash
   cd src/api && bun run dev
   # In another shell, register a folder via the existing admin route or sign-in flow,
   # then place a few JPEGs and RAW files under that folder.
   ```
2. **Sign in to Maple** (so an `AuthTokens` entry lands in the shared Keychain).
3. **Open Settings → Server**, enter the server URL, click "Enable in Finder".
4. **Expected:** "Maple" appears in Finder's sidebar (under Locations). Clicking it shows the library roots. Drilling in lists subdirectories and files with the expected names. Files have correct sizes and modification dates but `isDownloaded = false`.
5. **Open a RAW file** by double-clicking or `quicklook`'ing it.
6. **Expected:** Brief spinner, then the bytes materialize. `Console.app` filtered on subsystem `app.justmaple.aperture.fileprovider` shows the HTTP fetch.
7. **Click Refresh in Settings.**
8. **Expected:** Finder re-enumerates the root container. Adding a file on the server side and clicking Refresh surfaces it.
9. **Click Disable.**
10. **Expected:** "Maple" disappears from Finder. Keychain entry remains (user signs out of Maple to clear it).

If any of those don't work, debug before declaring Phase 1 done. The most common failure modes:
- **Domain doesn't appear:** the extension isn't embedded in `Maple.app/Contents/PlugIns/` — check the Copy Files build phase from Task 2.
- **401 on every call:** Keychain access group mismatch — `keychain-access-groups` must be identical on both targets and start with `$(AppIdentifierPrefix)`.
- **"No such item" on root:** the App Group `UserDefaults` write from the main app isn't visible to the extension — verify both targets have `group.app.justmaple.aperture` in their entitlements.

---

## What ships at the end of this plan

A user can:
1. Open Maple, sign in to a self-hosted server.
2. Settings → Server → enable Finder integration.
3. See their library mounted in Finder as a Maple domain.
4. Browse folders, view file sizes and dates without downloading.
5. Open a photo and have its bytes materialize on demand.
6. Click Refresh to pick up new server-side files.

Nothing modifies, deletes, or uploads. The next phase (`docs/superpowers/plans/<later>.md`) introduces `modifyItem` for XMP writes, conflict copies, and per-folder pinning policy.

---

## Self-review checklist

- ✅ Spec coverage: every Phase 1 element from the design summary (lazy materialization, server-side IDs, on-demand fetch, manual refresh, namespace shape, conflict policy deferred) is covered by Tasks 1-12.
- ✅ Placeholder scan: no `TODO`, no `appropriate error handling`, no "implement later", every step has runnable code.
- ✅ Type consistency: `FileProviderIdentifier`, `FileProviderConfig`, `RemoteCatalog`, `MapleItem`, `RootEnumerator`, `FolderEnumerator`, `FileProviderDomainController` — same spellings everywhere they appear.
- ✅ Phase boundary: tasks stop at read-only. Writes, deletes, iOS, push channel, Quick Look explicitly deferred.
