using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.ViewModels
{
    /// <summary>Maple Cloud folder browsing (#3082) — the file-browser half of
    /// the cloud source, split out of EditSessionViewModel.Cloud.cs (auth,
    /// sidecars, download-to-edit) for the file-size budget.
    ///
    /// This is a Finder / File Explorer view of the server, and it walks the
    /// unified `slug:relPath` routes every other client reads (#1325):
    /// registered libraries from GET /api/folders are the roots, and each level
    /// below comes from GET /api/folder/:slug/* — immediate children only,
    /// subfolders listed separately from the images so the sidebar renders a
    /// tree while the grid shows one directory. The listing carries each
    /// image's size, mtime and EXIF, and the absolute path that keys the
    /// sidecar and asset routes. Thumbnails and previews are fetched by the
    /// same address (GET /api/thumb, /api/preview), so they share the web's
    /// server cache entries.
    ///
    /// It deliberately does NOT go through /api/search: that returns a
    /// capture-sorted feed of a whole library with no directory structure at
    /// all, which is the timeline — its own sidebar section — not a browser.
    /// </summary>
    public partial class EditSessionViewModel
    {
        /// <summary>Roots (registered libraries) of the MAPLE CLOUD tree.</summary>
        public ObservableCollection<CloudFolderNode> CloudTree { get; } = new();

        /// <summary>The browsed directory's immediate subfolders, rendered as
        /// folder tiles above the photo grid — the Finder contract
        /// (docs/spec/13-windows-shell.md): a directory view shows its
        /// folders AND its images. Holds <see cref="FolderNode"/> for local
        /// browse and <see cref="CloudFolderNode"/> for cloud; the tile
        /// template binds the Name/ToolTipText both carry, and the click
        /// handler dispatches on the node type.</summary>
        public ObservableCollection<object> BrowseFolders { get; } = new();

        /// <summary>Directory page size for the folder listing. The server
        /// clamps to 2000; a directory bigger than one page keeps paging
        /// below.</summary>
        private const int CloudDirPageLimit = 500;

        /// <summary>Ceiling on how much of one directory is loaded into the
        /// grid. A folder holding more than this is truncated with a status
        /// line rather than paged forever.</summary>
        private const int CloudDirMaxImages = 5000;

        private void RebuildCloudTree(CloudFolder[]? folders)
        {
            CloudTree.Clear();
            foreach (var folder in folders ?? Array.Empty<CloudFolder>())
            {
                var node = new CloudFolderNode
                {
                    Name = folder.DisplayName,
                    Path = folder.Path,
                    LibrarySlug = folder.Slug,
                };
                // Every server node gets an expander stub: unlike the local
                // tree, which stats for subdirectories while building the
                // node, finding out costs a round-trip here. First expand
                // resolves it — to the real children, or to a leaf.
                node.Children.Add(new CloudFolderNode { Name = "…", IsPlaceholder = true });
                CloudTree.Add(node);
            }
        }

        /// <summary>Lazy expand: replace the stub with this directory's
        /// immediate subdirectories.</summary>
        public void LoadCloudFolderChildren(CloudFolderNode node)
        {
            if (node.ChildrenLoaded || node.IsPlaceholder || _cloud == null)
                return;
            node.ChildrenLoaded = true;
            _ = Task.Run(async () =>
            {
                // Nothing awaits this task, so an exception escaping it would
                // be an unobserved one — invisible until it surfaces somewhere
                // unrelated. A failed listing resets ChildrenLoaded so the
                // NEXT expand retries: a blip of flaky Wi-Fi must not freeze
                // the node as a leaf for the rest of the session.
                try
                {
                    var children = await ListCloudChildFolderNodesAsync(node, CancellationToken.None);
                    App.MainDispatcherQueue?.TryEnqueue(() =>
                    {
                        if (children == null)
                        {
                            node.ChildrenLoaded = false;
                            return;
                        }
                        node.Children.Clear();
                        foreach (var child in children)
                            node.Children.Add(child);
                        SynchronizeFolderSelection();
                    });
                }
                catch (Exception ex)
                {
                    DiagLog.Write($"[cloud] expanding {node.Path} failed: {ex.Message}");
                    App.MainDispatcherQueue?.TryEnqueue(() => node.ChildrenLoaded = false);
                }
            });
        }

        /// <summary>One directory's immediate subdirectories as fresh nodes,
        /// inheriting the library identity of their parent. Null when any page
        /// of the listing failed — the caller resets ChildrenLoaded so the
        /// next expand retries, rather than mistaking a failed listing for a
        /// genuinely childless directory.</summary>
        private async Task<List<CloudFolderNode>?> ListCloudChildFolderNodesAsync(
            CloudFolderNode node, CancellationToken ct)
        {
            var dirs = new List<CloudFolderEntry>();
            var paging = new CloudListingPaging();
            string? cursor = null;
            do
            {
                var listing = await ListCloudPageAsync(node, cursor, ct);
                if (listing == null)
                {
                    DiagLog.Write($"[cloud] dir listing failed for {node.Path}");
                    return null;
                }
                dirs.AddRange(listing.Folders.Where(d => paging.AcceptAddress(d.Address)));
                cursor = listing.NextCursor;
                if (!paging.AcceptCursor(cursor))
                {
                    DiagLog.Write($"[cloud] dir listing for {node.Path} repeated a cursor");
                    return null;
                }
            }
            while (!string.IsNullOrEmpty(cursor) && !ct.IsCancellationRequested);

            return dirs
                .OrderBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
                .Select(d => ChildNode(node, d))
                .ToList();
        }

        /// <summary>One page of <paramref name="node"/>'s level through the
        /// unified listing. Null when the request failed, and for a library
        /// the server reported without a slug, which has no address to
        /// list.</summary>
        private Task<CloudFolderListing?> ListCloudPageAsync(
            CloudFolderNode node, string? cursor, CancellationToken ct)
        {
            if (string.IsNullOrEmpty(node.LibrarySlug))
            {
                DiagLog.Write($"[cloud] cannot list {node.Path}: the library has no slug");
                return Task.FromResult<CloudFolderListing?>(null);
            }
            return _cloud!.ListFolderAddressAsync(
                $"{node.LibrarySlug}:{node.RelativePath}", cursor, CloudDirPageLimit, ct);
        }

        private static CloudFolderNode ChildNode(CloudFolderNode parent, CloudFolderEntry dir)
        {
            var node = new CloudFolderNode
            {
                Name = dir.Name,
                Path = dir.Path,
                LibrarySlug = parent.LibrarySlug,
                RelativePath = parent.RelativePath.Length == 0
                    ? dir.Name
                    : $"{parent.RelativePath}/{dir.Name}",
            };
            node.Children.Add(new CloudFolderNode { Name = "…", IsPlaceholder = true });
            return node;
        }

        /// <summary>Load one server directory's images into the browse grid.
        /// Immediate children only — subfolders are reached through the tree,
        /// exactly as on the local FOLDERS side and on the other platforms.
        /// </summary>
        public async Task LoadCloudDirectoryAsync(CloudFolderNode node)
        {
            if (_cloud == null)
                return;

            _libraryCts?.Cancel();
            var cts = new CancellationTokenSource();
            _libraryCts = cts;

            BeginBrowse(cloud: node);
            CurrentFolderPath = $"{_cloud.ServerUrl} · {node.Path}";
            ActiveSectionName = node.Name;
            _libraryWatcher?.Stop();    // no local directory to watch
            AllPhotos.Clear();
            BrowseFolders.Clear();

            _cloudFoldsRawJpegStacks = false;
            _cloudListingComplete = false;
            var foldsStacks = CloudFoldsRawJpegStacksAsync(_cloud, cts.Token);
            var truncated = false;
            var failed = false;
            var paging = new CloudListingPaging();
            string? cursor = null;
            try
            {
                do
                {
                    var listing = await ListCloudPageAsync(node, cursor, cts.Token);
                    // Ownership check, not just a cancellation check: if a
                    // newer load superseded this one while the page was in
                    // flight, the request may still have COMPLETED normally —
                    // cancellation only faults an await that hasn't finished.
                    // Resuming here on the UI thread after the newer load has
                    // cleared and begun filling AllPhotos would append this
                    // load's page into the other folder's grid and then
                    // overwrite its status line. The CTS field is the grid's
                    // ownership token; the moment it isn't ours, every write
                    // below belongs to someone else.
                    if (_libraryCts != cts)
                        return;
                    if (listing == null)
                    {
                        failed = true;
                        break;
                    }
                    foreach (var dir in listing.Folders.Where(d => paging.AcceptAddress(d.Address)))
                        BrowseFolders.Insert(
                            CloudListingPaging.InsertIndex(BrowseFolders, tile => ((CloudFolderNode)tile).Name, dir.Name),
                            ChildNode(node, dir));
                    foreach (var image in listing.Images.Where(i => paging.AcceptAddress(i.Address)))
                    {
                        // Everything the listing returns is shown, video and
                        // audio included: this is a file browser, and a
                        // browser that hides files is lying about the
                        // directory. Editing a container the RAW pipeline
                        // can't decode fails at open time with its own
                        // message — the honest place for that limit to
                        // surface, not a silently shorter grid.
                        if (AllPhotos.Count >= CloudDirMaxImages)
                        {
                            truncated = true;
                            break;
                        }
                        AllPhotos.Add(CloudPhotoMapper.FromDirectory(image));
                    }
                    cursor = listing.NextCursor;
                    if (!paging.AcceptCursor(cursor))
                    {
                        DiagLog.Write($"[cloud] listing for {node.Path} repeated a cursor");
                        failed = true;
                    }
                }
                while (!truncated && !failed && !string.IsNullOrEmpty(cursor) && !cts.Token.IsCancellationRequested);
                var folds = await foldsStacks;
                if (_libraryCts != cts)
                    return;
                _cloudFoldsRawJpegStacks = folds;
                _cloudListingComplete = RawJpegStackFold.IsCloudListingComplete(
                    truncated, failed, cts.Token.IsCancellationRequested, cursor);
            }
            catch (OperationCanceledException)
            {
                // Another folder was picked while a page was in flight. This
                // load no longer owns the grid — the newer one has already
                // cleared it and is filling it — so return without touching
                // any of the view state below. Absorbed here because the
                // caller is an `async void` event handler, where an escaping
                // exception takes the whole process down.
                return;
            }

            ApplyFilters();
            var photos = RawJpegStackFold.Tiles(AllPhotos).ToList();
            // A failed page must win over the count: a partial (or empty) grid
            // described as "0 photos" reads as an empty folder, which is a
            // different and much more alarming fact than a request that
            // didn't answer.
            CloudStatus = failed
                ? $"Couldn't list {node.Name} — see maple.log"
                : truncated
                    ? $"Showing the first {CloudDirMaxImages} photos in {node.Name}."
                    : $"{node.Name} — {photos.Count} photo{(photos.Count == 1 ? "" : "s")}.";

            FinishBrowse(cts, failed ? "Could not load this folder. Select it to retry." : string.Empty);
            Timeline.GroupPhotosByDate(AllPhotos);
        }

        // Called from ApplyFilters, the one place every filter, search and fold
        // change passes through: a tile hidden at load costs nothing until it
        // becomes visible, and each tile is requested once.
        private void HydrateNewCloudTiles(CancellationToken ct)
        {
            var needing = RawJpegStackFold.NeedingCloudThumbnails(Photos, _cloudThumbnailRequests);
            if (needing.Count > 0)
                _ = Task.Run(() => HydrateCloudThumbnailsAsync(needing, ct), ct);
        }

        /// <summary>Fill the grid's thumbnails from GET /api/thumb/:slug/*,
        /// keyed by the item's `slug:relPath` address — the unified route the
        /// web grid reads, which renders a file the indexer hasn't reached
        /// yet on the fly. An item with no address (a library the server
        /// reported without a slug) has nothing to ask for and keeps the
        /// placeholder.</summary>
        private async Task HydrateCloudThumbnailsAsync(List<PhotoItem> items, CancellationToken ct)
        {
            // Disposed only after WhenAll: every task that took the gate has
            // released it by then, and a task cancelled while waiting never
            // took it. Cancellation is the normal end of this work — the user
            // picked another folder — so it is swallowed rather than left to
            // fault an unawaited task.
            using var gate = new SemaphoreSlim(4);
            var tasks = items.Where(item => item.CloudAddress != null).Select(async item =>
            {
                await gate.WaitAsync(ct);
                try
                {
                    var path = await _cloud!.FetchImageAsync("thumb", item.CloudAddress!, ct);
                    path = await DisplayImageCache.PrepareAsync(path, ThumbnailService.ThumbnailMaxPx, ct);
                    if (path != null)
                        App.MainDispatcherQueue?.TryEnqueue(() =>
                            item.ThumbnailPath = new Uri(path).AbsoluteUri);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    DiagLog.Write($"[cloud] thumb failed for {item.FileName}: {ex.Message}");
                }
                finally
                {
                    gate.Release();
                }
            });
            try
            {
                await Task.WhenAll(tasks);
            }
            catch (OperationCanceledException)
            {
                // Folder switched mid-hydration. Expected, not a failure.
            }
        }
    }
}
