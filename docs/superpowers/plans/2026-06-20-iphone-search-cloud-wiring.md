# iPhone Search → Cloud Account Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the iPhone bottom-bar **Search** tab issue real, account-wide `/api/search` queries against the active Maple Cloud account, render results with real cloud thumbnails, and open a tapped result in the editor.

**Architecture:** The iPhone Search tab currently renders `SearchView()` with no view model ("shell mode" — no network calls). We give the tab a dedicated, account-wide `SearchViewModel` (no `libraryID`) built by an AppShell factory that resolves the active cloud server and bootstraps its auth session. We fix `SearchView` to drive the content-search field (`placeQuery`, not `q`), thread real thumbnails into its result tiles, wire the scope chips to the server `scope` param, and host the tab in its own `NavigationStack` that pushes results into the existing `EditorDestination`.

**Tech Stack:** Swift 6 / SwiftUI, `@Observable`, MapleCore Swift package, `/api/search` (Elysia) wire contract. Apple is not gated by cloud CI — verify locally with `swift test` (MapleCore) and `xcodebuild` (app target).

---

## Spec

`docs/superpowers/specs/2026-06-20-iphone-search-cloud-wiring-design.md`

## File Structure

**MapleCore package (`src/apple/Packages/MapleCore`)** — unit-tested via `swift test`:

- Modify `Sources/MapleCore/Cloud/SearchParams.swift` — add `scope` field + serialization.
- Modify `Sources/MapleCore/Cloud/SearchViewModel.swift` — make `libraryID` optional (enables account-wide construction).
- Modify `Tests/MapleCoreTests/SearchParamsTests.swift` — scope serialization tests.
- Modify `Tests/MapleCoreTests/SearchViewModelTests.swift` — account-wide construction test.

**App target (`src/apple/Maple`)** — verified via `xcodebuild build`:

- Create `Maple/Views/CloudThumbTile.swift` — reusable cloud-thumbnail loader/render + `SearchThumbContext`.
- Modify `Maple/Views/SearchPhotoResultsSection.swift` — real thumbnails in tiles; `SearchResultTile.absPath`.
- Modify `Maple/Views/SearchTopHitsSection.swift` — real thumbnails in top-hit rows; `SearchTopHit.absPath`.
- Modify `Maple/Views/SearchView.swift` — thread thumbnails, fix `q`→`placeQuery`, wire scope chips.
- Modify `Maple/Views/AppShell+CloudActions.swift` — `PhoneSearchSession` + server resolver + factory.
- Modify `Maple/Views/PhoneSearchStub.swift` — replace shell with real `PhoneSearchTab` host (own `NavigationStack`, editor push, empty state).
- Modify `Maple/Views/PhoneTabShell.swift` — thread the new inputs and host `PhoneSearchTab`.
- Modify `Maple/Views/AppShell.swift` — pass factory/resolver/asset closures into `PhoneTabShell`.

## Pre-flight

- [ ] **Step 0a: Ensure a tracking ticket exists.** Every PR closes a ticket.

```bash
gh issue create \
  --title "iPhone Search tab: wire to cloud account (account-wide search)" \
  --body "The iPhone bottom-bar Search tab renders a search box that issues no calls (SearchView in shell mode, no view model). Wire it to a real account-wide SearchViewModel against the active Maple Cloud account, render real thumbnails, and open results in the editor. Spec: docs/superpowers/specs/2026-06-20-iphone-search-cloud-wiring-design.md"
# Then tag the board (KTLO = bug/hygiene). Capture the issue number as <N>.
gh issue edit <N> --add-project "KTLO"
```

Record `<N>`; use `Closes #<N>` in the PR body later.

- [ ] **Step 0b: Confirm the app target builds clean before changes** (baseline).

Run:

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/friendly-pike-f34415/src/apple/Packages/MapleCore && swift build
```

Expected: builds (warnings OK). If `RawPipeline` header errors appear during the later app build, regenerate per CLAUDE.md (`build-xcframework.sh`); MapleCore alone does not need the framework.

---

## Task 1: Add `scope` to `SearchParams`

**Files:**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/SearchParams.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SearchParamsTests.swift`

- [ ] **Step 1: Write the failing tests**

Add to `SearchParamsTests.swift` (inside `final class SearchParamsTests`):

```swift
func test_scope_serialisesWhenSet() {
    var p = SearchParams(libraryID: "lib-1")
    p.scope = "places"
    let d = dict(p.listQueryItems(page: 0, limit: 100))
    XCTAssertEqual(d["scope"], "places")
}

func test_scope_omittedWhenNilOrEmpty() {
    var p = SearchParams(libraryID: "lib-1")
    XCTAssertNil(dict(p.listQueryItems(page: 0, limit: 100))["scope"])
    p.scope = ""
    XCTAssertNil(dict(p.listQueryItems(page: 0, limit: 100))["scope"])
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd src/apple/Packages/MapleCore && swift test --filter SearchParamsTests 2>&1 | grep -E "error:|test_scope"
```

Expected: compile error — `value of type 'SearchParams' has no member 'scope'`.

- [ ] **Step 3: Add the field + serialization**

In `SearchParams.swift`, add the property next to the other vision fields (after `activity`, before `subjects` is fine — placement is cosmetic):

```swift
  /// UI scope chip (S7): `places` / `people` / `albums`. nil / empty = the
  /// full live set (the server treats absent and `photos` identically). Raw
  /// server tokens — see `SEARCH_SCOPES` in src/api/src/routes/search/query.ts.
  public var scope: String?
```

In `baseItems()`, add a line alongside the other `add(...)` calls (e.g. after `add("activity", activity)`):

```swift
    add("scope", scope)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd src/apple/Packages/MapleCore && swift test --filter SearchParamsTests 2>&1 | tail -5
```

Expected: all `SearchParamsTests` pass (no failures).

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/SearchParams.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/SearchParamsTests.swift
git commit -m "feat(search): add scope param to SearchParams (Swift)"
```

---

## Task 2: Make `SearchViewModel.libraryID` optional (account-wide)

**Files:**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/SearchViewModel.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SearchViewModelTests.swift`

- [ ] **Step 1: Write the failing test**

Add to `SearchViewModelTests.swift`:

```swift
@MainActor
func test_accountWideInit_omitsLibraryIdOnWire() {
    let server = URL(string: "https://acct.example")!
    let vm = SearchViewModel(
        server: server,
        libraryID: nil,
        searchClient: CloudSearchClient.preview(server: server))
    let items = vm.params.listQueryItems(page: 0, limit: 100)
    XCTAssertFalse(items.contains { $0.name == "libraryId" },
                   "account-wide search must not send a libraryId")
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd src/apple/Packages/MapleCore && swift test --filter SearchViewModelTests 2>&1 | grep -E "error:|nil"
```

Expected: compile error — `'nil' is not compatible with expected argument type 'String'`.

- [ ] **Step 3: Make `libraryID` optional**

In `SearchViewModel.swift`:

Change the stored property:

```swift
  public let libraryID: String?
```

Change the initializer signature + default:

```swift
  public init(server: URL,
              libraryID: String? = nil,
              searchClient: CloudSearchClient,
              limit: Int = 100) {
    self.server = server
    self.libraryID = libraryID
    self.searchClient = searchClient
    self.limit = limit
    self.params = SearchParams(libraryID: libraryID)
  }
```

`SearchParams(libraryID:)` already takes `String?`, and `clearFilters()`’s `SearchParams(libraryID: libraryID)` is now passing a `String?` to a `String?` parameter — no further change needed there.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd src/apple/Packages/MapleCore && swift test --filter SearchViewModelTests 2>&1 | tail -5
```

Expected: all `SearchViewModelTests` pass. (The desktop caller passes a non-nil String, which still binds fine.)

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/SearchViewModel.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/SearchViewModelTests.swift
git commit -m "feat(search): allow account-wide SearchViewModel (optional libraryID)"
```

---

## Task 3: Reusable `CloudThumbTile` + `SearchThumbContext`

**Files:**

- Create: `src/apple/Maple/Views/CloudThumbTile.swift`

- [ ] **Step 1: Create the file**

```swift
// CloudThumbTile.swift — reusable cloud-thumbnail loader/render.
//
// Extracts the cache→client thumb fetch + ThumbnailImage render that
// CloudTimelineCell uses (CloudTimelineView.swift), so the S7 phone Search
// results can show real cloud thumbnails instead of the grey placeholder.
// Parameterised by the same (thumbClient, thumbCache, host, absPath) tuple
// the timeline cells use.

import SwiftUI
import MapleCore

/// Bundles everything a Search result cell needs to fetch a cloud thumbnail.
/// A nil context at a call site means "no live cloud session" → render the
/// neutral placeholder (keeps `#Preview`s and shell-mode usable).
struct SearchThumbContext {
    let client: CloudThumbClient
    let cache: CloudThumbCache
    let host: String
}

/// Fetch JPEG thumb bytes: cache first, then the network client (populating
/// the cache on a hit). Returns nil on any error so the caller renders the
/// placeholder. Mirrors `CloudTimelineCell.fetchThumbBytes`.
func fetchCloudThumbBytes(
    host: String,
    absPath: String,
    cache: CloudThumbCache,
    client: CloudThumbClient
) async -> Data? {
    if let cached = await cache.get(host: host, absPath: absPath) {
        return cached
    }
    do {
        let bytes = try await client.thumb(absPath: absPath)
        await cache.put(host: host, absPath: absPath, bytes)
        return bytes
    } catch {
        return nil
    }
}

/// Cloud thumbnail view. Loads on attachment via `.task(id:)`, renders
/// `ThumbnailImage` (the same JPEG-bytes renderer BrowseGrid / Timeline use),
/// and shows a neutral placeholder until bytes arrive. The caller imposes
/// size / aspect / clipping.
struct CloudThumbTile: View {
    let absPath: String
    let thumbClient: CloudThumbClient
    let thumbCache: CloudThumbCache
    let host: String
    var displayMode: GridDisplayMode = .fill

    @State private var thumbData: Data?

    var body: some View {
        ThumbnailImage(jpegData: thumbData, displayMode: displayMode)
            .task(id: absPath) {
                let bytes = await fetchCloudThumbBytes(
                    host: host, absPath: absPath, cache: thumbCache, client: thumbClient)
                guard !Task.isCancelled else { return }
                withAnimation(.easeInOut(duration: 0.18)) { thumbData = bytes }
            }
    }
}
```

- [ ] **Step 2: Add the file to the Xcode target**

The Maple app target adds `Maple/Views/*.swift` via a folder reference / file-system synced group (other `Maple/Views/*.swift` files compile without manual `project.pbxproj` edits). Confirm after the first app build (Task 8) that `CloudThumbTile` symbols resolve. If the target uses explicit file references and the build reports "cannot find 'CloudThumbTile'", add the file to the `Maple` target in `Maple.xcodeproj` (Xcode: drag into the `Views` group, check the `Maple` target).

- [ ] **Step 3: Commit**

```bash
git add src/apple/Maple/Views/CloudThumbTile.swift
git commit -m "feat(search): add reusable CloudThumbTile + SearchThumbContext"
```

(Build verification for app-target Swift happens in Task 8, where the full target links.)

---

## Task 4: Real thumbnails in the result sections

**Files:**

- Modify: `src/apple/Maple/Views/SearchPhotoResultsSection.swift`
- Modify: `src/apple/Maple/Views/SearchTopHitsSection.swift`

- [ ] **Step 1: Add `absPath` to `SearchResultTile` + a thumbnail-aware tile**

In `SearchPhotoResultsSection.swift`, change the tile model:

```swift
struct SearchResultTile: Identifiable, Hashable {
    let id: String
    let displayName: String
    let absPath: String
}
```

Add a `thumb` input to the section:

```swift
struct SearchPhotoResultsSection: View {
    let results: [SearchResultTile]
    let total: Int
    let isStale: Bool
    let hasQuery: Bool
    let query: String
    let onTap: (SearchResultTile) -> Void
    let onSeeAll: () -> Void
    /// Live cloud session for thumbnails; nil → grey placeholders (previews).
    var thumb: SearchThumbContext? = nil
```

Replace the tile `Button { … } label: { RoundedRectangle… }` body with a thumbnail-or-placeholder:

```swift
                LazyVGrid(columns: columns, spacing: 4) {
                    ForEach(results.prefix(9)) { tile in
                        Button {
                            onTap(tile)
                        } label: {
                            Group {
                                if let thumb {
                                    CloudThumbTile(
                                        absPath: tile.absPath,
                                        thumbClient: thumb.client,
                                        thumbCache: thumb.cache,
                                        host: thumb.host)
                                } else {
                                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                                        .fill(MapleTokens.surfaceAlt)
                                        .overlay(
                                            Image(systemName: "photo")
                                                .font(.system(size: 22))
                                                .foregroundStyle(MapleTokens.textMuted.opacity(0.5))
                                        )
                                }
                            }
                            .aspectRatio(1, contentMode: .fill)
                            .frame(maxWidth: .infinity)
                            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("search-tile-\(tile.id)")
                        .accessibilityLabel(tile.displayName)
                    }
                }
                .opacity(isStale ? 0.6 : 1.0)
                .animation(.linear(duration: 0.12), value: isStale)
```

Update the two `#Preview` blocks’ `SearchResultTile(...)` calls to pass `absPath`:

```swift
        results: (1...6).map { SearchResultTile(id: "r\($0)", displayName: "img-\($0).dng", absPath: "/p/img-\($0).dng") },
```

and for the empty preview leave `results: []` unchanged.

- [ ] **Step 2: Add `absPath` to `SearchTopHit` + thumbnail in the row**

In `SearchTopHitsSection.swift`, extend the model:

```swift
struct SearchTopHit: Identifiable, Hashable {
    let id: String
    let kind: SearchTopHitKind
    let label: String
    let subLabel: String?
    let assetID: String?
    /// Cloud abs_path for `.photo` hits (drives the row thumbnail). nil for
    /// non-photo kinds.
    let absPath: String?
}
```

Add the `thumb` input to the section:

```swift
struct SearchTopHitsSection: View {
    let hits: [SearchTopHit]
    let query: String
    let onTap: (SearchTopHit) -> Void
    /// Live cloud session for thumbnails; nil → glyph placeholder (previews).
    var thumb: SearchThumbContext? = nil
```

Replace the 36pt `RoundedRectangle` thumb in `row(for:)` with a thumbnail when available:

```swift
            HStack(spacing: 12) {
                Group {
                    if let thumb, hit.kind == .photo, let absPath = hit.absPath {
                        CloudThumbTile(
                            absPath: absPath,
                            thumbClient: thumb.client,
                            thumbCache: thumb.cache,
                            host: thumb.host)
                    } else {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(MapleTokens.surfaceAlt)
                            .overlay(
                                Image(systemName: hit.kind == .photo ? "photo" : "tag")
                                    .font(.system(size: 14))
                                    .foregroundStyle(MapleTokens.textMuted)
                            )
                    }
                }
                .frame(width: 36, height: 36)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
```

Update the `#Preview` `SearchTopHit(...)` calls to pass `absPath`:

```swift
            SearchTopHit(id: "1", kind: .photo, label: "paris-rooftop.dng",
                         subLabel: "Hasselblad L3D-100c", assetID: "1", absPath: "/p/paris-rooftop.dng"),
            SearchTopHit(id: "2", kind: .photo, label: "paris-night.dng",
                         subLabel: "Hasselblad L3D-100c", assetID: "2", absPath: "/p/paris-night.dng"),
```

- [ ] **Step 3: Commit** (compiles together with Task 5; the `SearchView` call sites are updated next.)

```bash
git add src/apple/Maple/Views/SearchPhotoResultsSection.swift \
        src/apple/Maple/Views/SearchTopHitsSection.swift
git commit -m "feat(search): render real cloud thumbnails in result sections"
```

---

## Task 5: Wire `SearchView` — thumbnails, `placeQuery`, scope

**Files:**

- Modify: `src/apple/Maple/Views/SearchView.swift`

- [ ] **Step 1: Add thumbnail inputs + a derived context**

Add two optional inputs next to `viewModel` / `onSelectAsset`:

```swift
    var viewModel: SearchViewModel?
    /// Cloud thumb client + cache for result thumbnails. nil → placeholders.
    var thumbClient: CloudThumbClient?
    var thumbCache: CloudThumbCache?
    var onSelectAsset: (SearchAsset) -> Void = { _ in }
```

Add a computed context (host comes from the VM's server):

```swift
    private var thumbContext: SearchThumbContext? {
        guard let vm = viewModel, let client = thumbClient, let cache = thumbCache else { return nil }
        return SearchThumbContext(client: client, cache: cache, host: vm.server.cacheHostKey)
    }
```

- [ ] **Step 2: Carry `absPath` into the tile/hit view models**

Update `resultTiles`:

```swift
    private var resultTiles: [SearchResultTile] {
        results.map { SearchResultTile(id: $0.id, displayName: $0.filename, absPath: $0.abs_path) }
    }
```

Update `topHits` (add `absPath: asset.abs_path` to the `SearchTopHit(...)` init):

```swift
            return SearchTopHit(
                id: asset.id,
                kind: .photo,
                label: asset.filename,
                subLabel: camera.isEmpty ? nil : camera,
                assetID: asset.id,
                absPath: asset.abs_path
            )
```

- [ ] **Step 3: Pass the context into the sections**

In `body`, update the two section call sites:

```swift
                    SearchTopHitsSection(hits: topHits, query: query, onTap: tapTopHit, thumb: thumbContext)
                    SearchPhotoResultsSection(
                        results: resultTiles,
                        total: total,
                        isStale: isStale,
                        hasQuery: !query.isEmpty,
                        query: query,
                        onTap: tapTile,
                        onSeeAll: seeAll,
                        thumb: thumbContext
                    )
```

- [ ] **Step 4: Fix the query field (`q` → `placeQuery`) and wire scope**

In `scheduleSearch`, change the submission body:

```swift
            await MainActor.run {
                viewModel?.params.placeQuery = trimmed
                applyScopeParams(scope, on: viewModel)
            }
            await viewModel?.submit()
```

Replace `applyScopeParams` with real scope mapping:

```swift
    /// Map the S7 scope chip into the server `scope` param. `all` / `photos`
    /// = the full live set (no scope token, matching the web + server, which
    /// treat absent and `photos` identically). `places` / `people` narrow
    /// server-side; `albums` is server-not-implemented (returns empty).
    private func applyScopeParams(_ scope: SearchScope, on vm: SearchViewModel?) {
        guard let vm else { return }
        switch scope {
        case .all, .photos: vm.params.scope = nil
        case .places:       vm.params.scope = "places"
        case .people:       vm.params.scope = "people"
        case .albums:       vm.params.scope = "albums"
        }
    }
```

- [ ] **Step 5: Commit**

```bash
git add src/apple/Maple/Views/SearchView.swift
git commit -m "fix(search): drive placeQuery + thumbnails + scope in SearchView"
```

---

## Task 6: AppShell phone-search factory + server resolver

**Files:**

- Modify: `src/apple/Maple/Views/AppShell+CloudActions.swift`

- [ ] **Step 1: Add the session type + resolver + factory**

Append to `AppShell+CloudActions.swift` (after the existing `// MARK: - Cloud search` section, before the closing brace of the file is fine — it’s a top-level type + an `extension AppShell`):

```swift
#if os(iOS)
// MARK: - iPhone global Search tab session

/// Everything the iPhone Search tab needs: an account-wide SearchViewModel
/// plus a thumb client/cache, all sharing one AuthenticatedHTTPClient.
struct PhoneSearchSession {
    let server: URL
    let vm: SearchViewModel
    let thumbClient: CloudThumbClient
    let thumbCache: CloudThumbCache
}

@MainActor
extension AppShell {
    /// Resolve the cloud server the global phone Search tab queries: the
    /// currently-open cloud library's server if there is one, else the first
    /// connected cloud account. nil → no cloud account → empty state.
    func resolveSearchServerURL() -> URL? {
        if case .cloudLibrary(let serverID, _) = librarySelection { return serverID }
        return CloudServerRegistry.shared.servers.first
    }

    /// Stable identity for the resolved server. Drives the Search tab's
    /// `.task(id:)` so the session rebuilds when the active account changes
    /// (open a cloud library, sign in). nil → empty state.
    var phoneSearchServerKey: String? { resolveSearchServerURL()?.absoluteString }

    /// Build an account-wide (no libraryID) search session for the resolved
    /// server. Bootstraps the auth session first (cold-start keychain
    /// restore) so the first query carries a bearer token — same dance as
    /// `loadCloudLibrary`. nil when no cloud account is connected/signed-in.
    func makePhoneSearchSession() async -> PhoneSearchSession? {
        guard let serverID = resolveSearchServerURL() else { return nil }
        let session = sessionFor(serverID)
        if !session.isSignedIn { await session.bootstrapAndRestore() }
        guard session.isSignedIn else { return nil }

        let httpClient = makeAuthenticatedHTTPClient(server: serverID)
        let vm = SearchViewModel(
            server: serverID,
            libraryID: nil, // account-wide
            searchClient: CloudSearchClient(server: serverID, httpClient: httpClient))
        return PhoneSearchSession(
            server: serverID,
            vm: vm,
            thumbClient: CloudThumbClient(server: serverID, httpClient: httpClient),
            thumbCache: CloudThumbCache())
    }
}
#endif
```

- [ ] **Step 2: Commit** (links in Task 8.)

```bash
git add src/apple/Maple/Views/AppShell+CloudActions.swift
git commit -m "feat(search): AppShell factory for account-wide phone search session"
```

---

## Task 7: `PhoneSearchTab` host + tab-shell wiring

**Files:**

- Modify: `src/apple/Maple/Views/PhoneSearchStub.swift`
- Modify: `src/apple/Maple/Views/PhoneTabShell.swift`
- Modify: `src/apple/Maple/Views/AppShell.swift`

- [ ] **Step 1: Replace the stub with the real tab host**

Rewrite `PhoneSearchStub.swift` body:

```swift
// PhoneSearchStub.swift — iPhone Search tab host (responsive-program S7).
//
// The file name is retained for git/Xcode-group continuity (a later PR
// renames it). `PhoneSearchTab` is the production view: it owns the
// account-wide `SearchViewModel` (built by AppShell's factory), its own
// NavigationStack, and the editor push for tapped results.

#if os(iOS)

import SwiftUI
import MapleCore

struct PhoneSearchTab: View {
    @Binding var sessions: [AssetRef.ID: EditSession]
    /// Stable id for the resolved cloud account; nil → no account → empty state.
    let serverKey: String?
    /// Builds the account-wide search session for the resolved server.
    let makeSession: () async -> PhoneSearchSession?
    /// Resolve a tapped result into an editor-ready AssetRef (populates
    /// `sessions` with a CloudSidecarStore-backed EditSession).
    let resolveAsset: (SearchAsset, URL) -> AssetRef

    @State private var session: PhoneSearchSession?
    @State private var path: [AssetRef] = []
    @State private var didLoad = false

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("Search")
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: AssetRef.self) { ref in
                    EditorDestination(asset: ref, sessions: $sessions)
                        .toolbar(.hidden, for: .tabBar)
                        .toolbar(.hidden, for: .navigationBar)
                }
        }
        // Rebuild whenever the resolved account changes (open a cloud library,
        // sign in). serverKey == nil short-circuits to the empty state with no
        // network attempt.
        .task(id: serverKey) {
            didLoad = false
            session = serverKey == nil ? nil : await makeSession()
            didLoad = true
        }
    }

    @ViewBuilder
    private var content: some View {
        if let session {
            SearchView(
                viewModel: session.vm,
                thumbClient: session.thumbClient,
                thumbCache: session.thumbCache,
                onSelectAsset: { asset in
                    path.append(resolveAsset(asset, session.server))
                }
            )
        } else if !didLoad {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(MapleTokens.bg.ignoresSafeArea())
        } else {
            PhoneSearchEmptyState()
        }
    }
}

/// Shown when no Maple Cloud account is connected/signed-in.
private struct PhoneSearchEmptyState: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 40))
                .foregroundStyle(MapleTokens.textMuted)
            Text("Search your cloud account")
                .font(MapleTokens.Typography.sheetTitle)
                .foregroundStyle(MapleTokens.textMain)
            Text("Connect a Maple Cloud account to search your photos by place, person, camera, and more.")
                .font(MapleTokens.Typography.rowLabel)
                .foregroundStyle(MapleTokens.textMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapleTokens.bg.ignoresSafeArea())
        .accessibilityIdentifier("search-empty-no-account")
    }
}

#endif
```

- [ ] **Step 2: Thread inputs through `PhoneTabShell`**

In `PhoneTabShell.swift`, add three stored inputs (near the other search inputs):

```swift
    /// iPhone Search tab (S7): resolved-account key, session factory, and
    /// result-tap resolver. Distinct from the desktop overlay's `searchVM`.
    let phoneSearchServerKey: String?
    let makePhoneSearchSession: () async -> PhoneSearchSession?
    let resolveSearchAsset: (SearchAsset, URL) -> AssetRef
```

Replace the Search tab entry in `tabView` (the `NavigationStack { PhoneSearchStub() } …` block):

```swift
            PhoneSearchTab(
                sessions: $sessions,
                serverKey: phoneSearchServerKey,
                makeSession: makePhoneSearchSession,
                resolveAsset: resolveSearchAsset
            )
            .tabItem { Label("Search", systemImage: "magnifyingglass") }
            .tag("search")
```

(`PhoneSearchTab` owns its own `NavigationStack`, so the outer `NavigationStack { }` wrapper is removed.)

- [ ] **Step 3: Supply the inputs from `AppShell`**

In `AppShell.swift`, inside `phoneTabShell`’s `PhoneTabShell(...)` call, add the three arguments (e.g. right after `sessions: $sessions,`):

```swift
            phoneSearchServerKey: phoneSearchServerKey,
            makePhoneSearchSession: { await makePhoneSearchSession() },
            resolveSearchAsset: { asset, server in prepareCloudSession(asset, server: server) },
```

- [ ] **Step 4: Commit**

```bash
git add src/apple/Maple/Views/PhoneSearchStub.swift \
        src/apple/Maple/Views/PhoneTabShell.swift \
        src/apple/Maple/Views/AppShell.swift
git commit -m "feat(search): host account-wide Search tab on iPhone with editor push"
```

---

## Task 8: Full verification

**Files:** none (verification only).

- [ ] **Step 1: MapleCore unit tests**

Run:

```bash
cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -20
```

Expected: all tests pass (including the new `SearchParamsTests` / `SearchViewModelTests` cases). No piping through `tail` mid-stream of a long compile if a watchdog is present — this is a final summary tail only; if the runner is sensitive, run `swift test` plain and read the summary.

- [ ] **Step 2: App target builds for iOS simulator**

Run:

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" \
           -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build 2>&1 | tail -30
```

Expected: `** BUILD SUCCEEDED **`. If `RawPipeline.h not found` / `could not build module`, regenerate the xcframework headers per CLAUDE.md (`./src/apple/scripts/build-xcframework.sh`) and rebuild. If `cannot find 'CloudThumbTile' / 'PhoneSearchTab' / 'PhoneSearchSession' in scope`, add the new file to the `Maple` target in `Maple.xcodeproj` (Task 3 Step 2) and rebuild.

- [ ] **Step 3: Manual smoke (simulator, if fixtures/account available)**

On a simulator signed into a Maple Cloud account: open the app → **Search** tab → the box auto-focuses → type a place/person/camera term → results appear with real thumbnails → tap a result → it opens in the editor → Back returns to the results. With no cloud account connected, the tab shows the "Search your cloud account" empty state. (Note: simulator synthetic taps are constrained on this machine per project notes; this step is best-effort — the build + unit tests are the hard gate.)

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "iPhone Search tab: account-wide cloud search" \
  --body "Wires the iPhone Search tab to a real account-wide SearchViewModel against the active Maple Cloud account: fixes the dead shell-mode SearchView, drives placeQuery (content search) instead of q (filename), renders real cloud thumbnails, wires the scope chips to the server scope param, and opens tapped results in the editor via the tab's own NavigationStack.

Closes #<N>

Spec: docs/superpowers/specs/2026-06-20-iphone-search-cloud-wiring-design.md
Plan: docs/superpowers/plans/2026-06-20-iphone-search-cloud-wiring.md"
```

Open as ready for review (not draft). Do not merge without explicit approval.

---

## Self-Review (completed during planning)

**Spec coverage:**

- §"Resolve target server" → Task 6 (`resolveSearchServerURL`, bootstrap).
- §"Dedicated phone-search session" → Task 6 (`makePhoneSearchSession`, shared httpClient, no libraryID) + Task 2 (optional libraryID).
- §"Fix the query field bug" → Task 5 Step 4 (`q`→`placeQuery`).
- §"Real thumbnails" → Task 3 + Task 4 + Task 5 Steps 1–3.
- §"Replace PhoneSearchStub" → Task 7 (own NavigationStack, EditorDestination push, empty state).
- §"Scope chips" → Task 1 (`scope` field) + Task 5 Step 4 (`applyScopeParams`).
- §"Testing" → Tasks 1/2 unit tests + Task 8 build.

**Placeholder scan:** No TBD/TODO; every code step shows complete code.

**Type consistency:** `SearchThumbContext` (client/cache/host) defined in Task 3, consumed identically in Tasks 4/5. `PhoneSearchSession` (server/vm/thumbClient/thumbCache) defined in Task 6, consumed in Task 7. `SearchResultTile.absPath` / `SearchTopHit.absPath` added in Task 4, populated in Task 5. `makePhoneSearchSession` / `resolveSearchAsset` / `phoneSearchServerKey` names match across Tasks 6/7.

**Known judgment calls (intentional):**

- `albums` scope sends the token; the server currently returns empty (no album backing) — chip is no longer inert but shows "No matches". Documented in Task 5.
- Empty state covers both "no account" and "signed-out account" (no separate sign-in affordance — the user signs in via the Library tab). YAGNI per spec.
