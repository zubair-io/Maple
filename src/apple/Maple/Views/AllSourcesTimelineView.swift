// AllSourcesTimelineView.swift
//
// #2271/#2273 — renders `AllSourcesTimelineViewModel`'s unified
// cross-source Timeline: every library on every connected Maple Cloud
// server, unioned with PhotoKit. Structurally mirrors `CloudTimelineView` +
// `CloudTimelineMonthSection` (same LazyVStack-of-month-sections shape,
// same shared `PhotoGrid`/`PhotoGridItem`/`CloudTimelineViewVM` helpers) but
// can't reuse that view unmodified: `CloudTimelineView` bakes in a single
// fixed `host`/`CloudThumbClient` for its ONE library, whereas a section
// here can hold cells from several different servers at once. The two
// deltas this view carries over its single-library sibling:
//   - a per-cell host resolver (`vm.host(for:)`) instead of one flat
//     `host: String`, so `ThumbnailProvider` (built with
//     `thumbClientsByHost`) routes each cell's thumb fetch to the server
//     that actually owns it;
//   - `onSelectAsset` resolves the asset's owning server via
//     `vm.server(for:)` before calling back, since a bare `SearchAsset`
//     carries no server of its own.
//
// The cloud-only `cloudGrid` fallback `CloudTimelineMonthSection` has (for
// a library whose PhotoKit merge isn't active) is dropped here: this VM
// always runs the merge, even with an empty local stream, so
// `mergedCells` is never nil once a month has loaded.

import SwiftUI
import MapleCore
import OSLog

private let allSourcesTimelineLog = Logger(subsystem: "app.justmaple.aperture", category: "AllSourcesTimeline")

struct AllSourcesTimelineView: View {
    @State var vm: AllSourcesTimelineViewModel
    let thumbCache: CloudThumbCache
    let displayMode: GridDisplayMode
    let onSelectAsset: (SearchAsset, URL) -> Void
    let onSelectLocalAsset: (ImageRef) -> Void

    /// Multi-host provider — one `CloudThumbClient` per connected server,
    /// keyed by cache-host, so a single grid can fetch thumbs across
    /// several servers. Created once and reused for the view's lifetime.
    @State private var provider: ThumbnailProvider

    init(
        vm: AllSourcesTimelineViewModel,
        thumbCache: CloudThumbCache,
        displayMode: GridDisplayMode,
        onSelectAsset: @escaping (SearchAsset, URL) -> Void,
        onSelectLocalAsset: @escaping (ImageRef) -> Void
    ) {
        self.vm = vm
        self.thumbCache = thumbCache
        self.displayMode = displayMode
        self.onSelectAsset = onSelectAsset
        self.onSelectLocalAsset = onSelectLocalAsset
        self._provider = State(initialValue: ThumbnailProvider(
            thumbClientsByHost: vm.thumbClientsByHost, thumbCache: thumbCache))
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                if vm.isLoadingBuckets && vm.buckets.isEmpty {
                    ProgressView().padding(40)
                }
                ForEach(vm.buckets, id: \.allSourcesBucketKey) { bucket in
                    let bucketKey = AllSourcesTimelineViewModel.BucketKey(year: bucket.year, month: bucket.month)
                    let sectionTaskID = CloudTimelineViewVM.bucketKey(year: bucket.year, month: bucket.month)
                    AllSourcesTimelineMonthSection(
                        year: bucket.year,
                        month: bucket.month,
                        count: bucket.count,
                        assets: vm.pagesByBucket[bucketKey] ?? [],
                        mergedCells: vm.mergedPagesByBucket[bucketKey],
                        hasLoaded: vm.pagesByBucket[bucketKey] != nil
                            || vm.mergedPagesByBucket[bucketKey] != nil,
                        displayMode: displayMode,
                        provider: provider,
                        hostResolver: { vm.host(for: $0) },
                        onSelectAsset: { asset in
                            guard let server = vm.server(for: asset) else {
                                allSourcesTimelineLog.error(
                                    "no known server for asset \(asset.id, privacy: .public) — dropping open")
                                return
                            }
                            onSelectAsset(asset, server)
                        },
                        onSelectLocalAsset: onSelectLocalAsset
                    )
                    .task(id: sectionTaskID) {
                        await vm.loadPage(year: bucket.year, month: bucket.month)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .task { await vm.loadBuckets() }
        .refreshable { await vm.loadBuckets() }
    }
}

extension TimelineBucket {
    /// Stable identity for SwiftUI ForEach — same key shape as
    /// `CloudTimelineView`'s `bucketKey`, named distinctly here only to
    /// avoid a duplicate-`fileprivate`-extension-member clash between the
    /// two sibling files.
    fileprivate var allSourcesBucketKey: String {
        CloudTimelineViewVM.bucketKey(year: year, month: month)
    }
}

// MARK: - MonthSection

struct AllSourcesTimelineMonthSection: View {
    let year: Int
    let month: Int
    let count: Int
    let assets: [SearchAsset]
    let mergedCells: [MergedTimelineCell]?
    let hasLoaded: Bool
    let displayMode: GridDisplayMode
    let provider: ThumbnailProvider
    /// Resolves the cache-host key for a merged cell's cloud side. Unlike
    /// `CloudTimelineMonthSection`'s flat `host: String`, a section here can
    /// hold cells from several different Maple Cloud servers, so the host
    /// must be looked up per-cell.
    let hostResolver: (MergedTimelineCell) -> String
    let onSelectAsset: (SearchAsset) -> Void
    let onSelectLocalAsset: (ImageRef) -> Void

    private var hasContent: Bool {
        CloudTimelineViewVM.hasContent(assets: assets, mergedCells: mergedCells)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(monthLabel).font(.title3.bold())
                Text("\(count)")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
                if !hasLoaded {
                    ProgressView()
                        .controlSize(.small)
                        .padding(.leading, 4)
                } else if !hasContent {
                    Text("no results")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 4)
                }
                Spacer()
            }
            if hasContent, let merged = mergedCells {
                mergedGrid(cells: merged)
            }
        }
    }

    /// Grid for the month: maps `MergedTimelineCell`s to
    /// `PhotoGridItem(merged:host:sync:style:.desktop)` via the shared
    /// `PhotoGrid`. Tap routing mirrors `CloudTimelineMonthSection.mergedGrid`
    /// exactly — the same pure `CloudTimelineViewVM.selectionTarget` helper.
    @ViewBuilder
    private func mergedGrid(cells: [MergedTimelineCell]) -> some View {
        let absPathToAsset = CloudTimelineViewVM.absPathMap(from: assets)
        PhotoGrid(
            data: cells,
            columns: .fixed(CloudTimelineViewVM.columnCount, spacing: 6),
            provider: provider,
            displayMode: displayMode,
            onTap: { cell in
                switch CloudTimelineViewVM.selectionTarget(for: cell, absPathMap: absPathToAsset) {
                case .cloud(let asset):
                    onSelectAsset(asset)
                case .local(let local):
                    onSelectLocalAsset(local)
                case .none:
                    break
                }
            },
            makeItem: { cell in
                PhotoGridItem(merged: cell, host: hostResolver(cell), sync: syncBadge(for: cell), style: .desktop)
            }
        )
    }

    private var monthLabel: String {
        CloudTimelineViewVM.monthLabel(year: year, month: month)
    }

    private func syncBadge(for cell: MergedTimelineCell) -> SyncBadge {
        switch cell {
        case .synced:    return .synced
        case .cloudOnly: return .cloudOnly
        case .localOnly: return .localOnly
        }
    }
}

// MARK: - Previews
//
// #2271/#2273 — mirrors CloudTimelineView's preview coverage (empty /
// loading / loaded). `AllSourcesTimelineViewModel.preview()` seeds staged
// state directly; a preview client array with no real sources means any
// network call fails fast and the loaded case's cells render placeholders.

#Preview("Loaded — months") {
    AllSourcesTimelineView(
        vm: AllSourcesTimelineViewModel.preview(.loaded),
        thumbCache: CloudThumbCache.preview(),
        displayMode: .fill,
        onSelectAsset: { _, _ in },
        onSelectLocalAsset: { _ in }
    )
    .frame(width: 720, height: 540)
}

#Preview("Empty (no months)") {
    AllSourcesTimelineView(
        vm: AllSourcesTimelineViewModel.preview(.empty),
        thumbCache: CloudThumbCache.preview(),
        displayMode: .fill,
        onSelectAsset: { _, _ in },
        onSelectLocalAsset: { _ in }
    )
    .frame(width: 720, height: 540)
}

#Preview("Loading") {
    AllSourcesTimelineView(
        vm: AllSourcesTimelineViewModel.preview(.loading),
        thumbCache: CloudThumbCache.preview(),
        displayMode: .fill,
        onSelectAsset: { _, _ in },
        onSelectLocalAsset: { _ in }
    )
    .frame(width: 720, height: 540)
}
