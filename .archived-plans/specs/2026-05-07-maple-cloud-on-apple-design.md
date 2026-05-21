# Maple Cloud on Apple — Design

Status: approved 2026-05-07. Implementation plan to follow.

## Problem

The Apple app's "Connect to a Maple Cloud server" flow in Settings is broken — tapping the connect button does nothing visible. The current entry point also asks for a URL plus an optional bearer token, which is the wrong user model: Maple Cloud uses passkeys, not opaque tokens. The sidebar groups remote servers under a generic "Connections" leaf, with no view-mode affordance and no way to browse a server chronologically.

We want the Apple app to be a first-class Maple Cloud client: type a domain, sign in with a passkey, and browse libraries either as a folder tree (existing behavior) or as a year/month timeline (the existing web feature, ported native). Cloud-resident XMP edits round-trip through the existing `/api/assets/:id/xmp` endpoints.

## Goals

1. Replace the broken Settings → Connect sheet with a single domain-entry flow that handles owner-claim, sign-in, and invite-join via the existing native passkey APIs.
2. Restructure the sidebar so each connected Maple Cloud server appears as a collapsible section with its libraries listed under it and a per-server **Timeline / Folder** view-mode toggle.
3. Port the web Timeline (`timeline-view.component.ts`) to native SwiftUI, backed by the same `/api/search/buckets` + `/api/search` + `/api/fs/thumb` endpoints.
4. Edit cloud-resident assets non-destructively — sidecar reads/writes go to `/api/assets/:id/xmp`.
5. Cache aggressively for browsing perf — bucket aggregations, per-month results, thumbnails, and last-known sidecar XML all survive app restart and serve stale-while-revalidate.

## Non-goals

- **Full offline editing.** Sidecar writes require connectivity. Read-only browsing of previously-cached months is supported; making a fresh server's first scroll work offline is not.
- **Combined "all libraries" timeline at the domain level.** Domain header is a label only; timeline always scopes to a single library.
- **Search / filter UI in cloud Timeline.** v1 is chronological only, default sort, no facets.
- **Migration UI for legacy bearer-token servers.** Existing `SelfHostedCredentialStore` entries surface as "Sign in again" prompts — we do not write a one-shot migration sheet.
- **Cross-platform UI changes.** Web app's existing Timeline view is unchanged; this design only changes the Apple shell.

## Out-of-scope user instructions

The user explicitly removed "API key" / bearer-token entry from the entry-point UI and explicitly added cloud editing. Both are reflected above.

## Architecture

### Sidebar

```
┌───────────────────────────────────────────┐
│ ▾ myserver.com           [Timeline|Folder]│  domain header — collapsible, no main-view action
│     ▸ Library A                           │
│     ▸ Library B                           │
│ ▾ another.maple.io       [Timeline|Folder]│
│     ▸ Family Photos                       │
│ ─────────────────                         │
│ ▸ Folders                                 │  existing local sections preserved
│ ▸ Photos Library                          │
│ ▸ Connections (SMB)                       │
│ ─────────────────                         │
│ [+ Add Maple Cloud]                       │  same entry available in Settings
└───────────────────────────────────────────┘
```

- Domain row is decorative + collapsible only; clicking does not change the main view.
- Per-server `[Timeline|Folder]` segmented control on the header row, right-aligned, persisted to `UserDefaults` under key `cloud.<host>.viewMode`.
- Library rows are clickable. The selected library plus the server's view mode determines the main pane.
- Right-click on a domain header → context menu with "Sign out" and "Remove server".
- Multi-server: each connected server gets its own header section. No upper bound enforced.
- Existing local sections (Folders, Photos Library, SMB Connections) stay below the cloud sections, unchanged.

### Selection model

The existing `LibrarySelection` enum (in `src/apple/Sources/MapleApp/State/LibrarySelection.swift`) gains a new case:

```swift
case cloudLibrary(serverID: URL, folderID: String)
```

The existing `case selfHostedServer(URL)` is removed; legacy entries from `SelfHostedCredentialStore` are migrated lazily — when the user clicks one, we trigger the new sign-in sheet against the saved URL. After the user signs in once, the legacy entry is replaced with a proper `AuthSession`-backed server.

### Add Maple Cloud sheet (state machine)

Replaces three existing sheets (`SelfHostedPickerSheet`, `JoinWithInviteView`, `SignInView`). One `@Observable` view model drives a state machine:

```
.idle
  ─ user enters domain, taps Continue ──▶ .checkingBootstrap(host)
.checkingBootstrap(host)
  ─ GET /api/auth/bootstrap returns ────▶ .needsOwnerClaim(host)         if !claimed
                                       ─▶ .ready(host)                    if claimed
                                       ─▶ .error(message)                 on network/HTTP error
.needsOwnerClaim(host)
  ─ user enters email, taps Create ─────▶ .registeringOwner(host, email)
.registeringOwner(host, email)
  ─ passkey ceremony succeeds ──────────▶ .signedIn(host, tokens)
                                       ─▶ .error(message)                 on cancel/failure
.ready(host)
  ─ silent passkey attempt succeeds ────▶ .signedIn(host, tokens)
  ─ silent passkey unavailable ─────────▶ .needsAuth(host)                shows Sign in / Join buttons
.needsAuth(host)
  ─ Sign in tapped ──────────────────────▶ .enteringSignInEmail(host)
  ─ Join tapped ─────────────────────────▶ .enteringInviteDetails(host)
.enteringSignInEmail(host)
  ─ user enters email, taps Continue ───▶ .signingIn(host, email)
.signingIn(host, email)
  ─ passkey ceremony succeeds ──────────▶ .signedIn(host, tokens)
                                       ─▶ .error(message)
.enteringInviteDetails(host)
  ─ user enters email + invite ─────────▶ .registeringInvitee(host, email, code)
.registeringInvitee(host, email, code)
  ─ passkey ceremony succeeds ──────────▶ .signedIn(host, tokens)
                                       ─▶ .error(message)
.signedIn(host, tokens)
  ─ tokens persisted, server registered ▶ sheet dismissed; sidebar refreshes.
.error(message)
  ─ user taps Retry ────────────────────▶ previous state's entry conditions
```

Errors are always rendered inline on the current step. The state machine is the structural fix for the "nothing happens" bug — every transition has a visible UI state and every failure has a visible error path.

The sheet is reachable from:
- Settings → Maple Cloud → Add server
- Sidebar → "+ Add Maple Cloud" button (visible when no cloud servers connected; otherwise lives in the section header overflow menu)

### Server registry

`AuthSession` already exists per-server. We add a top-level `CloudServerRegistry` (singleton, `@Observable`) that:

- Owns the set of connected servers, persisted to `UserDefaults` under `cloud.connectedServers` (an array of host strings).
- Maps host → `AuthSession` (created lazily, restored from `TokenStore` on first access).
- Maps host → `CloudFoldersClient` (caches the folder list per server).
- Drives sidebar rendering and provides the read API (`servers`, `folders(for:)`, `viewMode(for:)`, etc.).
- Removes a server: clears `TokenStore`, drops from `connectedServers`, evicts caches.

### Folder view mode

When `viewMode(for: serverID) == .folder` and a `cloudLibrary(serverID, folderID)` is selected:

- `browseVM.loadSource(CloudSource(server: serverID, folderID: folderID))` — `CloudSource` is a new conformer to the existing `Source` protocol.
- `CloudSource` paginates `GET /api/folders/<folderID>/assets?page=N&limit=200` into the existing grid view model. Subfolder drill-down uses `GET /api/fs/dir?path=<abs>` (already wired on the web side).
- Edits go through `PUT /api/assets/:id/xmp` (see "Cloud editing" below).

This is the lowest-risk path: `Source` already has the right shape and the existing grid is reused. No timeline machinery touches Folder mode.

### Timeline view mode

Native port of [timeline-view.component.ts](src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.component.ts). When `viewMode(for: serverID) == .timeline` and a `cloudLibrary` is selected:

**Data layer.** Three typed clients in `MapleCore/Sources/CloudClient/`:

- `CloudSearchClient.buckets(libraryId:) -> [TimelineBucket]` calls `GET /api/search/buckets?libraryId=<id>`.
- `CloudSearchClient.page(libraryId:, year:, month:, page:) -> SearchPage` calls `GET /api/search?libraryId=<id>&from=<YYYY-MM-01>&to=<YYYY-MM-31>&page=N&limit=200&sort=captured_desc`.
- `CloudThumbCache.thumb(server:, absPath:, size:) -> Data` fetches `GET /api/fs/thumb?path=<abs>&size=512`, caches on disk under `~/Library/Caches/app.justmaple.aperture/cloud-thumbs/<host>/<sha256(path)>.jpg`.

**View.** `CloudTimelineView` is a `LazyVStack` of month sections; each month is a `LazyVGrid` of asset cells.

- `onAppear` on a month section schedules a fetch (debounced, generation-counter-guarded) if results aren't cached.
- `onDisappear` ≥1 month off-screen evicts in-memory grid items but keeps the section's height. Disk caches survive.
- `CloudTimelineViewModel` (`@Observable`) holds: `buckets`, `pages: [BucketKey: SearchPage]`, `inFlight: Set<BucketKey>`, `generation: Int`. A semaphore caps in-flight `/api/search` per server at 2.
- Stale-request guard: every fetch closure captures `let g = generation`; on completion if `g != generation` the response is dropped.

**Caching for perf (revised per user feedback).** Three on-disk tiers, all keyed by `(server, libraryId)`:

| Tier | Location | TTL | Strategy |
|---|---|---|---|
| Buckets | `~/Library/Caches/.../cloud-buckets/<host>/<libraryID>.json` | infinite (revalidated on view appear) | stale-while-revalidate: render cached immediately, refetch in background, swap in new buckets when they arrive |
| Per-month pages | `.../cloud-pages/<host>/<libraryID>/<YYYY-MM>-<page>.json` | infinite | same — render cached, revalidate, swap |
| Thumbs | `.../cloud-thumbs/<host>/<sha256(absPath)>.jpg` | infinite | content-addressed by absPath; eviction by total-size LRU (capped at 2 GB, configurable) |

This is *not* full offline support: the first time a server / library / month is opened we still need network. But scrolling a previously-visited month is instant, and re-opening the app shows the most recent timeline state without flicker. A refresh control forces a full revalidate — pull-to-refresh on iOS/iPadOS, ⌘R or a toolbar button on macOS.

**No XMP/edits in Timeline cells** — Timeline is a browse surface; tapping a cell opens the existing Full Image view, which handles editing.

### Cloud editing (XMP write-back)

The Apple app already has a non-destructive editor backed by local `.xmp` sidecars. For cloud assets we route the same sidecar I/O through the API.

**New `CloudAssetSidecarStore` conforms to the existing `SidecarStore` protocol:**

- `read(asset: CloudAsset) async -> XMPDocument` calls `GET /api/assets/<id>/xmp` (the API returns the on-disk XML or a synthesized empty doc), caches the response on disk, returns parsed `XMPDocument`.
- `write(asset: CloudAsset, doc: XMPDocument) async throws` serializes the doc to XML and calls `PUT /api/assets/<id>/xmp` (the API writes atomically server-side). On success, updates the on-disk cache.
- Failed writes surface as a non-blocking toast with retry. The local cache is treated as the truth until the next successful sync from the server.

**Coalescing.** Slider drags can produce hundreds of XMP changes per second. We coalesce per-asset writes with a 500ms debounce — only the last value in the debounce window goes to the server. Slider feedback stays local (driven by the in-memory `XMPDocument`); the network call is best-effort persistence.

**Conflict handling.** If a `PUT` returns a conflict (the API may detect a server-side mtime mismatch), we re-fetch the server's XML, surface "Edits conflicted with another device — keep local or remote?" dialog, default to keep-local. v1 prompts on every conflict; v2 may add a smarter merge.

**No new API endpoints.** All editing goes through existing `/api/assets/:id/xmp`. If a future field needs server-side awareness (e.g. ratings index), that's an indexer change, not a sidecar-API change.

### Authentication

Existing `AuthClient`, `AuthSession`, `TokenStore`, `PasskeyCeremony`, `AuthenticatedHTTPClient` are reused unchanged. The new sheet is purely a UI layer over those types. Tokens are keychain-backed per server.

The `rpId` mismatch risk (user types `myserver.com` but WebAuthn rpId is `cloud.myserver.com`) is handled by reading the canonical `rp_id` field from the bootstrap response — the bootstrap endpoint must return the rpId the server expects. If it doesn't today, we add it (one-line API change).

## Components

### New files

| File | Purpose |
|---|---|
| `src/apple/Maple/Views/AddMapleCloudSheet.swift` | one sheet for the entire entry-point flow |
| `src/apple/Maple/Views/AddMapleCloudViewModel.swift` | `@Observable` state machine described above |
| `src/apple/Maple/Views/CloudServerSection.swift` | renders one domain header + library list + view-mode toggle |
| `src/apple/Maple/Views/CloudTimelineView.swift` | native timeline grid |
| `src/apple/Maple/Views/CloudTimelineViewModel.swift` | bucket + per-month fetch + cancellation |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudServerRegistry.swift` | top-level `@Observable` server registry |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudFoldersClient.swift` | typed wrapper over `/api/folders` |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudSearchClient.swift` | typed wrapper over `/api/search` and `/api/search/buckets` |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudThumbCache.swift` | LRU-capped on-disk cache for remote thumbs |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudAssetSidecarStore.swift` | `SidecarStore` impl that round-trips XMP through the API |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudSource.swift` | `Source` impl for Folder mode |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudBucketsCache.swift` | on-disk JSON cache for `/api/search/buckets` responses |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudPagesCache.swift` | on-disk JSON cache for `/api/search` page responses |

### Files modified

| File | Change |
|---|---|
| `src/apple/Maple/Views/AppShell.swift` | remove `SelfHostedPickerSheet`, wire new `AddMapleCloudSheet` from Settings entry and sidebar `+` button |
| `src/apple/Maple/Views/LibrarySidebar.swift` | render `CloudServerSection` for each connected server above the existing local sections; remove "Self Hosted" leaf under Connections |
| `src/apple/Maple/Views/LibrarySelection.swift` | add `case cloudLibrary(serverID, folderID)`, remove `case selfHostedServer` |
| `src/apple/Maple/Views/SignInView.swift` | delete (logic merged into `AddMapleCloudViewModel`) |
| `src/apple/Maple/Views/JoinWithInviteView.swift` | delete (logic merged into `AddMapleCloudViewModel`) |
| `src/api/src/routes/auth.ts` | extend `/api/auth/bootstrap` response with `rp_id` field if not present |

### Data flow — Timeline

```
user clicks Library A in Timeline mode
  ─▶ CloudTimelineView appears, asks viewModel.load(libraryId: "lib-A")
       ─▶ vm.buckets = CloudBucketsCache.read(host, libraryId)   // immediate, possibly nil
       ─▶ if cache hit: render skeleton with cached counts
       ─▶ vm.refetchBuckets() → CloudSearchClient.buckets(libraryId) → swap in new buckets
            └─ CloudBucketsCache.write(host, libraryId, response)
       ─▶ as user scrolls: month sections fire onAppear(year, month)
            ─▶ vm.loadPage(year, month) →
                 CloudPagesCache.read(host, libraryId, year, month) // immediate
                 ─▶ render cached cells
                 ─▶ semaphore-bounded fetch → swap in fresh page
            ─▶ each cell asks CloudThumbCache.thumb(host, absPath)
                 ─▶ disk hit: return JPEG immediately
                 ─▶ disk miss: fetch /api/fs/thumb, write to disk, return
       ─▶ on filter / library / server change: vm.generation += 1; in-flight closures noop on completion.
```

### Error handling

- **Network errors during bootstrap or auth:** inline error on the sheet, Retry button. Never silent.
- **401 mid-session:** existing `AuthenticatedHTTPClient` refresh path. If refresh also fails, server is marked needs-reauth, sidebar shows lock icon, clicking opens `SignInView` (now part of the merged sheet).
- **Network error while loading buckets/pages:** keep showing cached data, surface a small "offline" indicator on the timeline header. Pull-to-refresh retries.
- **Network error while saving XMP:** queue the write in a per-asset retry queue, show toast, retry on connectivity restore.
- **Conflict on PUT XMP:** dialog "keep local / keep remote" (defaults to local).

### Testing strategy

- **Unit tests** for the state machine (`AddMapleCloudViewModel`) — every transition exercised against a mock `AuthClient`.
- **Unit tests** for `CloudSearchClient` and `CloudFoldersClient` against a fake `URLSession` returning canned JSON.
- **Unit tests** for `CloudBucketsCache` / `CloudPagesCache` — write/read round-trip, eviction.
- **Integration test** (uses a real `bun run dev` API instance — see `src/api/scripts/`): full sign-in → list folders → load buckets → load month → fetch thumb → write XMP → re-read XMP. Skipped when no API is reachable, mirroring the `test_color_pipeline.sh` skip-pass pattern.
- **UI test** in `MapleUITests` exercising the sheet's happy paths (claim owner, sign in, join via invite). Stubbed `AuthClient` injected via launch arguments.
- **Manual smoke** on `cloud.justmaple.app` — record a 30-second screen capture for the PR.

## Risks & open questions

1. **`/api/fs/thumb` requires absolute path, not asset id.** The `/api/search` response includes `abs_path` so this works, but it means the thumb cache key is the absolute path. If an asset is renamed server-side, the old cached thumb is orphaned (small disk-leak). The LRU cap absorbs this.
2. **SwiftUI `LazyVStack` doesn't unload off-screen rows aggressively.** On 100k-photo libraries we may run into memory pressure that the web's DOM-based virtualization avoids. Plan for a benchmark on a 50k-photo test library before declaring done; if memory growth is unbounded, fall back to a manual viewport tracker driving a windowed array.
3. **Passkey rpId mismatch.** Resolved by reading rpId from the bootstrap response. Requires `/api/auth/bootstrap` to include `rp_id` — small API change tracked in Components → Files modified.
4. **XMP write coalescing window.** 500ms debounce is a guess. May tune in implementation if it feels laggy on macOS or aggressive on iOS (different network conditions).
5. **Migration UX from legacy bearer-token servers.** Lazy migration on click is the lowest-friction path but it does mean a user with N saved bearer-token servers has to sign in N times. Acceptable for v1 — most users have one.
6. **Indexer assumes local FS.** Cloud assets are not indexed by the local indexer; that's correct (the server runs its own indexer). No changes to `SearchIndex` are needed for cloud-only.

## Phasing note

The implementation plan should split this into phases that ship independently:

1. **Entry-point fix.** New `AddMapleCloudSheet` + state machine; replace broken `SelfHostedPickerSheet`. Sidebar still shows servers under the legacy "Connections" leaf.
2. **Sidebar restructure + Folder mode.** Domain headers, view-mode toggle (Folder only at this point), `CloudSource` for the existing grid, cloud XMP editing.
3. **Timeline view mode + caching.** Native port of the web timeline, on-disk caches.

Each phase is independently mergeable behind no flags — the user's existing flow keeps working until the phase that replaces it lands.

## Acceptance

- Settings → "Add Maple Cloud" opens the new sheet. Domain entry works for a fresh server (claim) and an existing server (sign in / join).
- Sidebar shows each connected server as a collapsible section with libraries listed under it.
- Per-server Timeline / Folder toggle persists across app restarts.
- Folder mode: existing grid loads cloud assets via `CloudSource`. XMP edits round-trip to the server.
- Timeline mode: matches the web Timeline layout (year/month sections, folder grouping within month). Smooth scroll on the 50k reference library.
- Buckets, pages, and thumbs are cached on disk and survive app restart. Cache hits make scroll instant.
- Refresh control (pull-to-refresh on iOS, ⌘R / toolbar button on macOS) on Timeline forces a full revalidate.
- Sign out / Remove server context-menu actions work and cleanly evict caches + tokens.
- Existing `JoinWithInviteView` / `SignInView` / `SelfHostedPickerSheet` are removed.
- All new code has unit tests for the state machine, clients, and caches; UI test covers the sheet happy paths.
