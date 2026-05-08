# Maple Cloud Phase 3 — Native Timeline + on-disk caches

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Light up the **Timeline** view-mode toggle (placeholder shipped in Phase 2) with a native SwiftUI port of the web app's [`timeline-view.component.ts`](../../src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.component.ts). Year/month buckets streamed from `GET /api/search/buckets`; per-month asset pages from `GET /api/search`; thumbnails from `GET /api/fs/thumb`. Three on-disk caches keep scrolling instant after the first visit.

**Architecture:** Three new typed clients (`CloudSearchClient`, `CloudThumbClient`) and three caches (`CloudBucketsCache`, `CloudPagesCache`, `CloudThumbCache`) under `MapleCore/Cloud/`. A new `CloudTimelineViewModel` (`@Observable`) drives bucket fetching, per-month page fetching, generation-counter-guarded cancellation, and an in-flight cap of 2 per server. `CloudTimelineView` renders a `LazyVStack` of month sections backed by the view model. `AppShell.loadCloudLibrary`'s `.timeline` branch swaps the placeholder for `CloudTimelineView`.

**Tech Stack:** Swift, SwiftUI, XCTest. No new third-party dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-07-maple-cloud-on-apple-design.md`](../specs/2026-05-07-maple-cloud-on-apple-design.md)

**Depends on:** Phase 2 (CloudFolders, CloudServerRegistry, CloudSource, view-mode toggle).

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `…/MapleCore/Cloud/CloudSearchClient.swift` | Create | Typed wrapper for `/api/search/buckets` and `/api/search`. |
| `…/MapleCore/Cloud/CloudSearchTypes.swift` | Create | `TimelineBucket`, `TimelineBuckets`, `SearchResult`, `SearchResponse` DTOs. |
| `…/MapleCore/Cloud/CloudThumbClient.swift` | Create | `GET /api/fs/thumb?path=<abs>&size=512` wrapper. |
| `…/MapleCore/Cloud/CloudBucketsCache.swift` | Create | On-disk JSON cache, key=`(host, libraryID)`. |
| `…/MapleCore/Cloud/CloudPagesCache.swift` | Create | On-disk JSON cache, key=`(host, libraryID, year, month, page)`. |
| `…/MapleCore/Cloud/CloudThumbCache.swift` | Create | On-disk JPEG cache, key=`sha256(absPath)`, size-capped LRU. |
| `…/MapleCore/Cloud/CloudTimelineViewModel.swift` | Create | `@Observable` driver — buckets + per-month pages + generation. |
| `…/Maple/Views/CloudTimelineView.swift` | Create | SwiftUI `LazyVStack` of month sections. |
| `…/Maple/Views/CloudTimelineMonthSection.swift` | Create | One month: header + `LazyVGrid` of cells. |
| `…/Maple/Views/CloudTimelineCell.swift` | Create | One asset cell with async thumb loader. |
| `…/Maple/Views/AppShell.swift` | Modify | `loadCloudLibrary`'s `.timeline` branch renders `CloudTimelineView`. |
| `…/MapleCore/Tests/MapleCoreTests/CloudSearchClientTests.swift` | Create | URLProtocol stub. |
| `…/MapleCore/Tests/MapleCoreTests/CloudBucketsCacheTests.swift` | Create | Disk round-trip. |
| `…/MapleCore/Tests/MapleCoreTests/CloudPagesCacheTests.swift` | Create | Disk round-trip. |
| `…/MapleCore/Tests/MapleCoreTests/CloudThumbCacheTests.swift` | Create | Disk + LRU eviction. |
| `…/MapleCore/Tests/MapleCoreTests/CloudTimelineViewModelTests.swift` | Create | Stale-guarded fetch + concurrency cap. |

---

## Task 1: Search DTOs

**File:** `…/MapleCore/Cloud/CloudSearchTypes.swift`

```swift
import Foundation

public struct TimelineBucket: Decodable, Equatable, Sendable {
  public let year: Int
  public let month: Int   // 1...12
  public let count: Int
}

public struct TimelineBuckets: Decodable, Sendable {
  public let total: Int
  public let buckets: [TimelineBucket]
  public let untimed_count: Int
}

public struct SearchAssetCamera: Decodable, Equatable, Sendable {
  public let make: String?
  public let model: String?
}

public struct SearchAsset: Decodable, Equatable, Sendable {
  public let id: String
  public let folder_id: String
  public let abs_path: String
  public let filename: String
  public let size: Int64?
  public let mtime: String?
  public let captured_at: String?
  public let camera: SearchAssetCamera?
  public let lens: String?
  public let iso: Int?
  public let aperture: Double?
  public let shutter: String?
  public let focal_length: Double?
  public let rating: Int?
  public let flag: String?
  public let color_label: String?
}

public struct SearchResponse: Decodable, Sendable {
  public let total: Int
  public let page: Int
  public let limit: Int
  public let results: [SearchAsset]
}
```

Build, commit.

---

## Task 2: `CloudSearchClient` + tests

**File:** `…/MapleCore/Cloud/CloudSearchClient.swift`

```swift
import Foundation

public actor CloudSearchClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  public func buckets(libraryID: String) async throws -> TimelineBuckets {
    let url = server.appending(path: "/api/search/buckets")
      .appending(queryItems: [URLQueryItem(name: "libraryId", value: libraryID)])
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    try Self.checkOK(resp, data: data)
    return try JSONDecoder().decode(TimelineBuckets.self, from: data)
  }

  public func page(libraryID: String, year: Int, month: Int,
                   page: Int = 1, limit: Int = 200,
                   sort: String = "captured_desc") async throws -> SearchResponse {
    let from = String(format: "%04d-%02d-01", year, month)
    let to = Self.lastDay(year: year, month: month)
    let items: [URLQueryItem] = [
      URLQueryItem(name: "libraryId", value: libraryID),
      URLQueryItem(name: "from", value: from),
      URLQueryItem(name: "to", value: to),
      URLQueryItem(name: "page", value: "\(page)"),
      URLQueryItem(name: "limit", value: "\(limit)"),
      URLQueryItem(name: "sort", value: sort),
    ]
    let url = server.appending(path: "/api/search").appending(queryItems: items)
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    try Self.checkOK(resp, data: data)
    return try JSONDecoder().decode(SearchResponse.self, from: data)
  }

  private static func lastDay(year: Int, month: Int) -> String {
    var c = DateComponents(); c.year = year; c.month = month
    let cal = Calendar(identifier: .gregorian)
    let d = cal.date(from: c)!
    let last = cal.range(of: .day, in: .month, for: d)!.upperBound - 1
    return String(format: "%04d-%02d-%02d", year, month, last)
  }

  private static func checkOK(_ resp: URLResponse, data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw NSError(domain: "CloudSearchClient",
                    code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                    userInfo: [NSLocalizedDescriptionKey: body])
    }
  }
}
```

Tests cover happy path for both endpoints (URL params + JSON parse).

Commit.

---

## Task 3: `CloudThumbClient`

```swift
public actor CloudThumbClient {
  public let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  public func thumb(absPath: String, size: Int = 512) async throws -> Data {
    let url = server.appending(path: "/api/fs/thumb")
      .appending(queryItems: [
        URLQueryItem(name: "path", value: absPath),
        URLQueryItem(name: "size", value: "\(size)"),
      ])
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      throw NSError(domain: "CloudThumbClient", code: http.statusCode)
    }
    return data
  }
}
```

Commit.

---

## Task 4: `CloudBucketsCache` (on-disk JSON, stale-while-revalidate)

```swift
public actor CloudBucketsCache {
  private let baseDir: URL

  public init(baseDir: URL? = nil) {
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
    self.baseDir = baseDir ?? caches
      .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
      .appendingPathComponent("cloud-buckets", isDirectory: true)
  }

  public func read(host: String, libraryID: String) -> TimelineBuckets? {
    let url = path(host: host, libraryID: libraryID)
    guard FileManager.default.fileExists(atPath: url.path),
          let data = try? Data(contentsOf: url),
          let buckets = try? JSONDecoder().decode(TimelineBuckets.self, from: data)
    else { return nil }
    return buckets
  }

  public func write(host: String, libraryID: String, _ buckets: TimelineBuckets) {
    let url = path(host: host, libraryID: libraryID)
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    if let data = try? JSONEncoder().encode(buckets) {
      try? data.write(to: url, options: .atomic)
    }
  }

  private func path(host: String, libraryID: String) -> URL {
    baseDir.appendingPathComponent(host).appendingPathComponent("\(libraryID).json")
  }
}

extension TimelineBuckets: Encodable {}
extension TimelineBucket: Encodable {}
```

Tests: round-trip read/write, miss returns nil.

Commit.

---

## Task 5: `CloudPagesCache`

Same shape as `CloudBucketsCache` but keyed on `(host, libraryID, year, month, page)`. Persists `SearchResponse`.

```swift
public actor CloudPagesCache {
  private let baseDir: URL

  public init(baseDir: URL? = nil) { … }

  public func read(host: String, libraryID: String,
                   year: Int, month: Int, page: Int) -> SearchResponse? { … }

  public func write(host: String, libraryID: String,
                    year: Int, month: Int, page: Int, _ resp: SearchResponse) { … }
}
```

Tests + commit.

---

## Task 6: `CloudThumbCache` with LRU cap

```swift
public actor CloudThumbCache {
  private let baseDir: URL
  private let maxBytes: Int64

  public init(baseDir: URL? = nil, maxBytes: Int64 = 2 * 1024 * 1024 * 1024) {
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
    self.baseDir = baseDir ?? caches
      .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
      .appendingPathComponent("cloud-thumbs", isDirectory: true)
    self.maxBytes = maxBytes
  }

  public func get(host: String, absPath: String) -> Data? {
    let url = path(host: host, absPath: absPath)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    // Touch mtime so LRU sees the access.
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
    return try? Data(contentsOf: url)
  }

  public func put(host: String, absPath: String, _ jpeg: Data) {
    let url = path(host: host, absPath: absPath)
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? jpeg.write(to: url, options: .atomic)
    Task { await self.evictIfNeeded() }
  }

  private func evictIfNeeded() {
    // Walk baseDir, sort by mtime, drop oldest until <= maxBytes.
    // Implementation: enumerate files, build (url, size, mtime) tuples, sort,
    // sum, evict from oldest. Avoid loading all files into memory at once
    // (only the metadata).
    …
  }

  private func path(host: String, absPath: String) -> URL {
    let hash = SHA256.hash(data: Data(absPath.utf8))
      .map { String(format: "%02x", $0) }.joined()
    return baseDir.appendingPathComponent(host)
      .appendingPathComponent(String(hash.prefix(2)))
      .appendingPathComponent("\(hash).jpg")
  }
}
```

Tests: round-trip put/get + LRU eviction. Smaller `maxBytes` to keep tests fast.

Commit.

---

## Task 7: `CloudTimelineViewModel` skeleton

```swift
@MainActor
@Observable
public final class CloudTimelineViewModel {
  public private(set) var buckets: [TimelineBucket] = []
  public private(set) var pagesByBucket: [BucketKey: [SearchAsset]] = [:]
  public private(set) var inFlight: Set<BucketKey> = []
  public private(set) var loadError: Error?

  public struct BucketKey: Hashable, Sendable {
    public let year: Int
    public let month: Int
  }

  private let server: URL
  private let libraryID: String
  private let searchClient: CloudSearchClient
  private let bucketsCache: CloudBucketsCache
  private let pagesCache: CloudPagesCache

  /// Bumps when the source library changes; in-flight closures check
  /// before mutating state, so stale completions are dropped.
  private var generation: Int = 0
  /// Bound concurrency: at most 2 concurrent /api/search calls per server.
  private let semaphore = AsyncSemaphore(value: 2)

  public init(server: URL, libraryID: String,
              searchClient: CloudSearchClient,
              bucketsCache: CloudBucketsCache = CloudBucketsCache(),
              pagesCache: CloudPagesCache = CloudPagesCache()) {
    self.server = server; self.libraryID = libraryID
    self.searchClient = searchClient
    self.bucketsCache = bucketsCache
    self.pagesCache = pagesCache
  }

  public func loadBuckets() async {
    let g = bumpGeneration()
    if let cached = await bucketsCache.read(host: server.host ?? "", libraryID: libraryID) {
      guard g == generation else { return }
      buckets = cached.buckets
    }
    do {
      let fresh = try await searchClient.buckets(libraryID: libraryID)
      guard g == generation else { return }
      buckets = fresh.buckets
      await bucketsCache.write(host: server.host ?? "", libraryID: libraryID, fresh)
    } catch {
      guard g == generation else { return }
      loadError = error
    }
  }

  public func loadPage(year: Int, month: Int) async {
    let key = BucketKey(year: year, month: month)
    let g = generation
    guard !inFlight.contains(key) else { return }
    if let cached = await pagesCache.read(host: server.host ?? "", libraryID: libraryID,
                                          year: year, month: month, page: 1) {
      guard g == generation else { return }
      pagesByBucket[key] = cached.results
    }
    inFlight.insert(key)
    defer { inFlight.remove(key) }
    do {
      try await semaphore.withSlot {
        let fresh = try await searchClient.page(libraryID: libraryID, year: year, month: month)
        guard g == generation else { return }
        pagesByBucket[key] = fresh.results
        await pagesCache.write(host: server.host ?? "", libraryID: libraryID,
                               year: year, month: month, page: 1, fresh)
      }
    } catch {
      guard g == generation else { return }
      loadError = error
    }
  }

  private func bumpGeneration() -> Int {
    generation &+= 1
    return generation
  }
}

actor AsyncSemaphore {
  private let value: Int
  private var current: Int
  private var waiters: [CheckedContinuation<Void, Never>] = []
  init(value: Int) { self.value = value; self.current = 0 }
  func acquire() async { … }
  func release() { … }
  func withSlot<T>(_ body: () async throws -> T) async rethrows -> T { … }
}
```

Tests: stale-guarded completion (start load, bump generation, complete — state unchanged); cache-hit-then-fresh-replaces; concurrency cap respected.

Commit.

---

## Task 8: `CloudTimelineView` SwiftUI tree

```swift
struct CloudTimelineView: View {
  @State var vm: CloudTimelineViewModel
  let onSelectAsset: (SearchAsset) -> Void

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 24) {
        ForEach(vm.buckets, id: \.bucketKey) { bucket in
          CloudTimelineMonthSection(
            year: bucket.year, month: bucket.month, count: bucket.count,
            assets: vm.pagesByBucket[.init(year: bucket.year, month: bucket.month)] ?? [],
            onSelectAsset: onSelectAsset
          )
          .onAppear { Task { await vm.loadPage(year: bucket.year, month: bucket.month) } }
        }
      }
      .padding(.horizontal, 16)
    }
    .task { await vm.loadBuckets() }
    .refreshable { await vm.loadBuckets() }
  }
}

extension TimelineBucket { var bucketKey: String { "\(year)-\(month)" } }

struct CloudTimelineMonthSection: View {
  let year: Int; let month: Int; let count: Int
  let assets: [SearchAsset]
  let onSelectAsset: (SearchAsset) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("\(monthLabel) — \(count)")
        .font(.title3).bold()
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4),
                spacing: 8) {
        ForEach(assets, id: \.id) { asset in
          CloudTimelineCell(asset: asset, onSelect: { onSelectAsset(asset) })
        }
      }
    }
  }

  private var monthLabel: String {
    let f = DateFormatter()
    f.dateFormat = "MMMM yyyy"
    var c = DateComponents(); c.year = year; c.month = month; c.day = 1
    return f.string(from: Calendar.current.date(from: c)!)
  }
}

struct CloudTimelineCell: View {
  let asset: SearchAsset
  let onSelect: () -> Void
  @State private var thumb: Image?

  var body: some View {
    Button(action: onSelect) {
      Group {
        if let thumb {
          thumb.resizable().aspectRatio(1, contentMode: .fill).clipped()
        } else {
          Color.gray.opacity(0.15).aspectRatio(1, contentMode: .fill)
        }
      }
      .cornerRadius(4)
    }
    .buttonStyle(.plain)
    .task { await loadThumb() }
  }

  private func loadThumb() async {
    // ... goes through CloudThumbCache + CloudThumbClient, decoded to UIImage/NSImage.
  }
}
```

Commit.

---

## Task 9: AppShell wires Timeline mode

Replace the `.timeline` placeholder branch in `loadCloudLibrary` with construction of `CloudTimelineViewModel` + presentation of `CloudTimelineView` instead of the BrowseGrid. Likely needs a new `mode` case (`.cloudTimeline`) on AppShell or a wrapper view that the existing `.browse` mode renders for cloud-timeline selections.

Concretely: introduce `@State var cloudTimelineVM: CloudTimelineViewModel?` on `AppShell`. Set it on `.timeline` branch; clear it on every other selection. Add a content-column branch that renders `CloudTimelineView(vm: vm) { asset in openCloudAsset(asset) }` when `cloudTimelineVM != nil`.

`openCloudAsset` builds an `AssetRef` (with bytesProvider that calls `CloudSource.rawBytes`) and opens the existing FullImage editor. Reuses the existing edit flow.

Commit.

---

## Task 10: Manual smoke test

- Settings → Add Server → sign in.
- Click a library → Timeline mode → year/month sections render with thumbnails.
- Scroll down — months load incrementally.
- Toggle Folder mode → grid loads (Phase 2 path).
- Toggle back to Timeline — restore from disk caches, no network flicker.
- Tap an asset → editor opens; edit exposure; close; reopen — adjustment persisted via Phase 2's CloudSidecarStore.

---

## Task 11: PR

Same shape as Phases 1+2. Mention dependence on Phase 2 (`--base claude/maple-cloud-phase2`).

---

## Self-review checklist

- [ ] All three caches survive app restart.
- [ ] Generation counter prevents stale fetches from mutating state.
- [ ] In-flight cap of 2 per server holds during scroll.
- [ ] Refreshable forces full revalidate.
- [ ] No regressions in Phase 1 / Phase 2 acceptance criteria.
