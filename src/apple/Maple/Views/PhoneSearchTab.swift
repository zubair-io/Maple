// PhoneSearchTab.swift — iPhone Search tab host (responsive-program S7).
//
// `PhoneSearchTab` is the production view — the ONLY search surface on
// iPhone (#3163; the mac/iPad three-column shell's `CloudSearchView`
// overlay never renders here). It owns the account-wide `SearchViewModel`,
// its own NavigationStack, and the open route for tapped results. The
// search FIELD and the bottom nav are the native system tab bar — this tab
// lives inside a `Tab(role: .search)` in `PhoneTabShell` and carries the
// `.searchable` field whose text is bound here as `query`.
//
// Open presentation (#2371): a tapped result pushes `.preview` onto this
// tab's own `[LibraryDestination]` stack, exactly as `PhoneLibraryView`
// does for the Library tab — Preview first, and the editor only from
// Preview's Edit button (Fast Preview §1). Each destination hides the tab
// bar (and with it the search field) so it owns the whole screen.
//
// This replaced the search-only `HeroZoomEditorOverlay` presentation
// (#1489), which zoomed a tapped tile straight into the editor and so was
// the one surface in the app that skipped Preview.
//
// Deep-link / Map pin-tap seeding (#3163): the widget's `maple://search?…`
// tap and a Map pin/cluster tap both switch to this tab and hand it a
// `SearchParams` via `pendingSeed` (set by `AppShell.switchToPhoneSearchTab
// (seeding:)`) instead of opening the mac/iPad overlay. See
// `applySeedIfNeeded()`.

#if os(iOS)

  import MapleUI
  import SwiftUI
  import MapleCore
  import UIKit

  struct PhoneSearchTab: View {
    @Binding var sessions: [AssetRef.ID: EditSession]
    /// Live query text, bound to the host's `.searchable` search field.
    @Binding var query: String
    /// A widget deep-link or Map pin tap's `SearchParams`, waiting to be
    /// applied to `session.vm.params` and submitted (#3163). Set by
    /// `AppShell.switchToPhoneSearchTab(seeding:)`; cleared here once
    /// applied so a later tab re-appearance doesn't replay it.
    @Binding var pendingSeed: SearchParams?
    /// Stable id for the resolved cloud account and the library its
    /// generated-search cards come from; nil → no account → empty state.
    let sessionKey: String?
    /// Builds the account-wide search session for the resolved server.
    let makeSession: () async -> PhoneSearchSession?
    /// Resolve a tapped result into an openable asset — its `AssetRef`
    /// (populating `sessions` with a CloudSidecarStore-backed EditSession)
    /// plus the `CloudSource` Preview needs for its image tiers.
    let resolveAsset: (SearchAsset, URL) -> ResolvedCloudAsset
    /// The containing-folder sibling list for a tapped result (#3551) —
    /// `AppShell.searchPreviewSiblingAssets`. Async: it lists the folder on
    /// the server, so Preview is pushed with the tapped asset alone first and
    /// the strip fills in when the listing lands.
    let loadSiblingAssets: (AssetRef, URL) async -> [AssetRef]
    /// Prime a real `EditSession` (with a `CloudSidecarStore`) for a sibling
    /// the moment it becomes the shown asset, so a later Edit tap on it
    /// doesn't fall back to `EditorDestination`'s no-remote-store session.
    let onPrimeSession: (AssetRef) async -> Void

    @State private var session: PhoneSearchSession?
    @State private var didLoad = false
    /// This tab's navigation stack. Empty → the result grid is the whole tab;
    /// `[.preview(a)]` → Preview; `[.preview(a), .edit(a)]` → the editor
    /// reached from Preview's Edit button. Same typed route the Library tab
    /// uses, so back pops `editor → Preview → grid`.
    @State private var path: [LibraryDestination] = []
    /// `CloudSource` for the result currently pushed on `path`. A search result
    /// has no `primaryURL`, so Preview dispatches BOTH its image tiers on this:
    /// without it there is no display tier and the thumbnail tier falls back to
    /// downloading the entire RAW through `bytesProvider` (#2376).
    @State private var previewSource: (any ImageSource)?
    /// Preview's swipe/filmstrip domain for the pushed result: `[ref]` at push
    /// time, replaced by the containing folder's listing (with `ref` spliced
    /// in at its own position) once `loadSiblingAssets` returns (#3551).
    @State private var previewAssets: [AssetRef] = []
    /// The generated-search card whose first page is being fetched — its
    /// cover fetch hasn't landed yet — so the card can show it's working.
    @State private var openingCollectionID: String?
    /// The text the host last set programmatically (deep link, Map pin,
    /// card). `SearchView` reads a change TO this value as a seed, not as the
    /// user clearing the field, so a seed with filters but no text keeps them.
    @State private var seededQuery: String?

    var body: some View {
      NavigationStack(path: $path) {
        content
          .navigationTitle("Search")
          .navigationBarTitleDisplayMode(.inline)
          // Mirrors `PhoneLibraryView`'s resolution (Fast Preview §1):
          // `.preview` → the fast static surface, `.edit` → the editor.
          // Both hide the tab bar and ship their own back control.
          // Preview hides the native nav bar; EditorView restores it
          // only for the open Duo's landscape tool rail.
          .navigationDestination(for: LibraryDestination.self) { destination in
            Group {
              switch destination {
              case .preview(let ref):
                PreviewDestination(
                  asset: ref,
                  // The result's containing folder (#3551), once
                  // listed; the tapped asset alone until then and
                  // whenever the listing doesn't contain it.
                  assets: previewAssets.contains(ref) ? previewAssets : [ref],
                  source: previewSource,
                  sessions: $sessions,
                  onClose: popPreview,
                  onEdit: { path.append(.edit($0)) },
                  // A sibling became the shown asset: give it a
                  // real session so Edit on it persists to the
                  // server. The search grid keeps its own
                  // selection state.
                  onSelectionChanged: { asset in Task { await onPrimeSession(asset) } }
                )
                .toolbar(.hidden, for: .navigationBar)
              case .edit(let ref):
                EditorDestination(
                  asset: ref,
                  filmstripAssets: previewAssets.contains(ref) ? previewAssets : [ref],
                  filmstripSource: previewSource,
                  onSelectAsset: { sibling in
                    guard sibling.id != ref.id else { return }
                    Task { await onPrimeSession(sibling) }
                    path = LibraryDestination.replacingAsset(in: path, with: sibling)
                  },
                  sessions: $sessions
                )
                .id(ref.id)
              }
            }
            .toolbar(.hidden, for: .tabBar)
          }
      }
      // The native search field for the `Tab(role: .search)` this view
      // lives in — its text drives the same `query` the content reads.
      .searchable(text: $query, prompt: "Search your library")
      // Build the account-wide session once per account + library. Guard on
      // the existing session's own key so a tab re-appearance KEEPS the
      // current view model — and its results — instead of rebuilding an
      // empty one. Rebuild only when the account or the library changes
      // (the cards are per library), or none exists yet.
      .task(id: sessionKey) {
        guard let key = sessionKey else {
          session = nil
          didLoad = true
          return
        }
        // Same account and library as the current session — keep it.
        if session?.key == key {
          didLoad = true
          applySeedIfNeeded()
          return
        }
        // Account or library changed: clear the stale session so the loading state
        // shows (not the previous account's results) while the new one
        // builds.
        session = nil
        didLoad = false
        let newSession = await makeSession()
        // `.task(id:)` cancels this when sessionKey changes again; don't let
        // a superseded build overwrite a newer session.
        guard !Task.isCancelled else { return }
        session = newSession
        didLoad = true
        applySeedIfNeeded()
      }
      // Covers the already-mounted case: the session exists (built by the
      // `.task` above on an earlier appearance) and a NEW seed arrives
      // while this tab is already alive — `.task(id:)` won't re-run since
      // `sessionKey` hasn't changed.
      .onChange(of: pendingSeed) { _, _ in applySeedIfNeeded() }
    }

    /// Apply a pending deep-link/Map-pin seed (#3163). Two halves, split
    /// because they have different readiness requirements:
    ///
    ///  1. The visible query TEXT updates unconditionally, the moment a
    ///     seed arrives — no session needed, mirroring `PhoneTabShell
    ///     .searchFor(_:)`'s unconditional `searchQuery = text` for the
    ///     face-chip case. A widget tap while signed out still shows the
    ///     intended query rather than an unexplained blank field.
    ///  2. Actually RUNNING the search (seeding `session.vm.params` and
    ///     submitting) needs the account-wide session, which may not exist
    ///     yet (no cloud account) or not be ready yet (cold-start widget tap
    ///     races the session build against `AppShell` setting the seed).
    ///     The seed stays pending — re-applying step 1 harmlessly each call
    ///     — until a session shows up; only then does it clear. Called from
    ///     both the `.task` above and `.onChange(of: pendingSeed)` so
    ///     whichever side (seed arrival, session readiness) resolves second
    ///     is the one that completes it.
    private func applySeedIfNeeded() {
      guard let seed = pendingSeed else { return }
      seedQuery(seed.placeQuery)
      guard let session else { return }
      pendingSeed = nil
      run(seed, in: session)
    }

    /// Set the field's text for a seed and mark it so `SearchView` doesn't
    /// read the change as the user clearing the field. The marker lives for
    /// exactly one render: `SearchView` consumes it when it observes the
    /// change, and the host drops it on the next main-actor turn regardless
    /// — so a seed applied while no `SearchView` exists (cold start, session
    /// still building) can't leave a marker that masks a later real clear.
    private func seedQuery(_ text: String) {
      guard text != query else { return }
      seededQuery = text
      query = text
      Task { @MainActor in seededQuery = nil }
    }

    /// Run a stored search from a deep-link/Map seed.
    private func run(_ seed: SearchParams, in session: PhoneSearchSession) {
      seedQuery(seed.placeQuery)
      // Pop any pushed Preview/editor so the user lands on the fresh
      // results, mirroring `PhoneTabShell.searchFor(_:)`'s `libraryPath = []`
      // for the face-chip text-seed case.
      path = []
      session.vm.params = seed
      Task { await session.vm.submit() }
    }

    /// Open a generated-search card on its collection's own results. Always
    /// through the collection endpoint, never a search rebuilt from
    /// `card.query`: the server forces the hidden-people and screenshot
    /// exclusions and newest-first order there, so the grid matches the
    /// card's cover and count.
    private func openCollection(
      _ card: GeneratedSearchCard,
      from collections: GeneratedSearchCollectionsViewModel,
      in session: PhoneSearchSession
    ) {
      guard let firstPage = collections.firstPages[card.id] else {
        openingCollectionID = card.id
        Task { @MainActor in
          let page = await collections.firstPage(of: card)
          // A later tap, or a second tap on this card, superseded this one.
          guard openingCollectionID == card.id else { return }
          openingCollectionID = nil
          // An empty page for a non-empty card is a failed fetch; stay put.
          guard !page.results.isEmpty || card.result_count == 0 else { return }
          show(card, page: page, from: collections, in: session)
        }
        return
      }
      openingCollectionID = nil
      show(card, page: firstPage, from: collections, in: session)
    }

    private func show(
      _ card: GeneratedSearchCard,
      page: GeneratedSearchAssetPage,
      from collections: GeneratedSearchCollectionsViewModel,
      in session: PhoneSearchSession
    ) {
      var seed = SearchParams.fromDeepLinkQuery(card.query)
      // A card's query is per library; scoping the seed to it keeps an
      // edited query on that library — the widget link does the same.
      seed.libraryID = collections.libraryID
      path = []
      // Params first: the `query` change below then matches them, so
      // SearchView's debounce has nothing to submit.
      session.vm.showCollection(
        params: seed,
        firstPage: page,
        nextPage: { offset, limit in
          try await collections.page(of: card.id, offset: offset, limit: limit)
        },
        liveFirstPage: page.isSnapshot
          ? { await collections.liveFirstPage(of: card.id) } : nil)
      seedQuery(seed.placeQuery)
    }

    @ViewBuilder
    private var content: some View {
      if let session {
        SearchView(
          viewModel: session.vm,
          thumbClient: session.thumbClient,
          thumbCache: session.thumbCache,
          query: $query,
          collections: session.collections,
          openingCollectionID: openingCollectionID,
          onSelectCollection: { card in
            guard let collections = session.collections else { return }
            openCollection(card, from: collections, in: session)
          },
          seededQuery: seededQuery,
          onSeedApplied: { seededQuery = nil },
          onSelectAsset: { asset in
            let resolved = resolveAsset(asset, session.server)
            previewSource = resolved.source
            previewAssets = [resolved.ref]
            path.append(.preview(resolved.ref))
            let server = session.server
            Task { @MainActor in
              let siblings = await loadSiblingAssets(resolved.ref, server)
              // Still previewing the result this listing was for —
              // not a later tap's, and not popped back to the grid.
              guard case .preview(let shown)? = path.first, shown.id == resolved.ref.id
              else { return }
              previewAssets = siblings
            }
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

    /// Pop Preview with the stack's own transition (Preview no longer fakes
    /// its own close animation). Same helper as `PhoneLibraryView.popPreview`.
    private func popPreview() {
      guard case .preview? = path.last else { return }
      _ = path.removeLast()
    }
  }

  /// Shown when no Maple Cloud account is connected/signed-in.
  private struct PhoneSearchEmptyState: View {
    var body: some View {
      VStack(spacing: 12) {
        MuiIcon(name: "search", size: .xl)
          .font(.system(size: 40))
          .foregroundStyle(MapleTokens.textMuted)
        Text("Search your cloud account")
          .font(MapleTokens.Typography.sheetTitle)
          .foregroundStyle(MapleTokens.textMain)
        Text(
          "Connect a Maple Cloud account to search your photos by place, person, camera, and more."
        )
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
