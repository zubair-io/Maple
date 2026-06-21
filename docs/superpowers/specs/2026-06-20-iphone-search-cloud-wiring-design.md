# iPhone Search tab → cloud-account wiring

**Date:** 2026-06-20
**Status:** Design approved, pending implementation plan
**Platform:** Apple (iOS / iPhone shell only)

## Problem

On the iPhone shell the bottom-bar **Search** tab presents a search box that
accepts text and shows recent queries, but never queries the user's cloud
account. Typing returns nothing.

Root cause, two layers:

1. **No view model is ever injected.** The Search tab renders
   `PhoneSearchStub` → `SearchView()` with a `nil` `viewModel`
   (`src/apple/Maple/Views/PhoneSearchStub.swift`). Per `SearchView`'s own
   contract, in that "shell mode" it _"renders the UI scaffold but doesn't
   issue search calls."_ Nothing on the phone constructs a `SearchViewModel`
   — only the desktop toolbar's `activateSearch()`
   (`AppShell+CloudActions.swift`) does, and that path is library-scoped and
   tied to the desktop center-column overlay (`isSearchActive`), not the
   phone tab.

2. **The query targets the wrong field.** Even the half-wired path routes the
   text box into `params.q` (filename/path substring) at
   `src/apple/Maple/Views/SearchView.swift:179`. The real content search
   (places, captions, OCR, people) is driven by `params.placeQuery` — what
   the web `/search` page and the desktop `CloudSearchView` bind the box to.
   So with a VM injected but this bug present, "beach" would only match
   filenames.

Additionally, the S7 result tiles render a grey `photo` SF Symbol
placeholder, not a real thumbnail
(`src/apple/Maple/Views/SearchPhotoResultsSection.swift:61-68`), so wiring the
VM alone yields working-but-thumbnail-less results.

## Decisions (settled during brainstorming)

- **Surface:** iPhone Search tab only. Mac/iPad search is already wired (the
  toolbar magnifying-glass → `CloudSearchView`, gated to cloud libraries) and
  is out of scope.
- **Scope:** search the **active cloud account, account-wide** — the cloud
  server currently open in the Library tab if there is one, else the first
  connected cloud account; **no `libraryId`** on the wire (matches the web
  `/search` account-wide default; server omits the library filter when
  `libraryId` is absent — see `src/api/src/routes/search/query.ts`
  `buildFilter`).
- **UI direction:** enrich the purpose-built S7 `SearchView` (recent queries,
  scope chips, top hits, autofocus, accessibility hooks) rather than reuse the
  desktop-styled `CloudSearchView`. `SearchView` is the intended phone search
  surface.

## Design

### 1. Resolve the target server (AppShell)

A helper resolves the cloud server to search:

- If `librarySelection == .cloudLibrary(serverID, _)`, use `serverID`.
- Otherwise use `CloudServerRegistry.shared.servers.first`.
- Ensure that server's `AuthSession` is bootstrapped/signed-in before the
  first query, reusing the cold-start `bootstrapAndRestore()` dance that
  `loadCloudLibrary` / `loadCloudFoldersFor` use (otherwise a cold-launch
  query races out before keychain tokens are restored and 401s).
- If no cloud account is connected, the tab shows an empty state
  ("Connect a Maple Cloud account to search") rather than a dead box.

### 2. Build a dedicated phone-search session

A factory on `AppShell` constructs, for the resolved server:

- a `SearchViewModel` initialized with **no `libraryID`** (account-wide),
- a `CloudThumbClient` + `CloudThumbCache`,

all sharing **one** `AuthenticatedHTTPClient` (single-flighted 401-refresh
coalescer, same rationale as the Timeline/desktop-search sessions). This phone
session is kept **separate** from the desktop overlay's
`searchVM`/`searchThumbClient`/`searchThumbCache`/`isSearchActive` so the phone
tab and the desktop center-column overlay do not entangle.

### 3. Fix the query field bug

`SearchView.scheduleSearch` sets `viewModel?.params.q = trimmed`. Change it to
`params.placeQuery = trimmed` so the box drives the unified content search,
matching `CloudSearchView` and the web. Keep autofocus, recent-query capture,
and the debounce behavior; avoid double-debounce by driving the VM through a
single debounce path (either `SearchView`'s task + `vm.submit()`, or mirror
into `vm.params.placeQuery` + `vm.queryChanged()` — pick one in the plan so
keystrokes coalesce once, not twice).

### 4. Real thumbnails in results

Thread the `CloudThumbClient` + `CloudThumbCache` (and the VM's `server`) into
`SearchPhotoResultsSection` and the top-hits row so result tiles render actual
cloud thumbnails via the same fetch path the Timeline / desktop-search cells
use, replacing the grey `photo` placeholder. Keep the 3-column S7 layout and
the stale-dim behavior.

### 5. Replace `PhoneSearchStub` with a real tab host

The Search tab host:

- owns the `SearchViewModel` in `@State`, built via the AppShell factory on
  appear and rebuilt when the active server changes,
- owns its own `NavigationStack(path:)`,
- wires `SearchView.onSelectAsset` to resolve the asset via the existing
  `prepareCloudSession(_:server:)` and push `EditorDestination → EditorView`
  onto the Search tab's stack (Back returns to results) — mirroring the
  Library tab's `onOpenEditor` push pattern in `PhoneTabShell`.

The file may keep the `PhoneSearchStub.swift` name for git/Xcode-group
continuity (a later PR renames it), or be renamed now — plan's choice.

### 6. Scope chips

Today `SearchView.applyScopeParams` is a no-op and the Swift `SearchParams`
struct has no `scope` field, so the chips are present but inert. To avoid a
dead control:

- add a `scope` field to `SearchParams` (Swift) and serialize it in
  `baseItems()` (the server already accepts `scope` —
  `SEARCH_SCOPES = {photos, places, people, albums}`),
- wire `applyScopeParams` so `places`/`people` narrow server-side,
  `photos`/`all` map to the full set (no `scope` param), and `albums`
  surfaces the server's not-implemented state.

## Testing

- Unit: the phone factory builds an account-wide `SearchViewModel` — assert no
  `libraryId` appears in the issued query items
  (`SearchParams.listQueryItems`), and that the text box drives `placeQuery`
  not `q`. Extend `SearchViewModelTests` / `SearchParamsTests`.
- Scope: `SearchParamsTests` asserts `scope` serializes for `places`/`people`
  and is omitted for `photos`/`all`.
- No new fixtures; the cloud client is exercised with the existing preview /
  unreachable-server harness.

## Out of scope

- Multi-account picker (active-account chosen).
- Mac/iPad changes (already wired).
- The "See all" filtered-grid destination (remains a documented no-op,
  `SearchView.seeAll`, spec §6.5 follow-up).

## Affected files (anticipated)

- `src/apple/Maple/Views/PhoneSearchStub.swift` (→ real tab host)
- `src/apple/Maple/Views/PhoneTabShell.swift` (Search tab NavigationStack + factory wiring)
- `src/apple/Maple/Views/SearchView.swift` (`q` → `placeQuery`, thumb wiring, scope)
- `src/apple/Maple/Views/SearchPhotoResultsSection.swift` (real thumbnails)
- `src/apple/Maple/Views/SearchTopHitsSection.swift` (real thumbnails)
- `src/apple/Maple/Views/AppShell.swift` / `AppShell+CloudActions.swift` (server resolver + phone-search factory)
- `src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/SearchParams.swift` (`scope` field)
- Tests: `SearchViewModelTests`, `SearchParamsTests`
