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
    /// same endpoints every other platform walks: registered libraries from
    /// GET /api/folders are the roots, and each level below comes from
    /// GET /api/fs/dir — immediate children only, subdirectories listed
    /// separately from the images so the sidebar renders a tree while the grid
    /// shows one directory. Apple's CloudSource (MapleCore/Cloud/
    /// CloudSource.swift) and the web's FilesystemBrowseService are the same
    /// walk against the same routes (the web uses the /dir-fast variant, which
    /// drops the EXIF and asset ids this grid does want).
    ///
    /// It deliberately does NOT go through /api/search: that returns a
    /// capture-sorted feed of a whole library with no directory structure at
    /// all, which is the timeline — its own sidebar section — not a browser.
    /// </summary>
    public partial class EditSessionViewModel
    {
        /// <summary>Roots (registered libraries) of the MAPLE CLOUD tree.</summary>
        public ObservableCollection<CloudFolderNode> CloudTree { get; } = new();

        /// <summary>Directory page size for /api/fs/dir. The server clamps to
        /// 2000; a directory bigger than one page keeps paging below.</summary>
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
                    LibraryPath = folder.Path,
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
                var children = await ListCloudChildFolderNodesAsync(node, CancellationToken.None);
                App.MainDispatcherQueue?.TryEnqueue(() =>
                {
                    node.Children.Clear();
                    foreach (var child in children)
                        node.Children.Add(child);
                });
            });
        }

        /// <summary>One directory's immediate subdirectories as fresh nodes,
        /// inheriting the library identity of their parent. A failed listing
        /// yields no children (the row collapses to a leaf) — the reason is in
        /// maple.log, and the folder is still selectable.</summary>
        private async Task<List<CloudFolderNode>> ListCloudChildFolderNodesAsync(
            CloudFolderNode node, CancellationToken ct)
        {
            var dirs = new List<CloudDirChild>();
            string? cursor = null;
            do
            {
                var listing = await _cloud!.ListDirAsync(node.Path, cursor, CloudDirPageLimit, ct);
                if (listing == null)
                {
                    DiagLog.Write($"[cloud] dir listing failed for {node.Path}");
                    break;
                }
                dirs.AddRange(listing.Dirs);
                cursor = listing.NextCursor;
            }
            while (!string.IsNullOrEmpty(cursor) && !ct.IsCancellationRequested);

            return dirs
                .OrderBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
                .Select(d => ChildNode(node, d))
                .ToList();
        }

        private static CloudFolderNode ChildNode(CloudFolderNode parent, CloudDirChild dir)
        {
            var node = new CloudFolderNode
            {
                Name = dir.Name,
                Path = dir.Path,
                LibrarySlug = parent.LibrarySlug,
                LibraryPath = parent.LibraryPath,
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

            CurrentFolderPath = $"{_cloud.ServerUrl} · {node.Path}";
            ActiveSectionName = node.Name;
            _libraryWatcher?.Stop();    // no local directory to watch
            AllPhotos.Clear();

            var truncated = false;
            string? cursor = null;
            do
            {
                var listing = await _cloud.ListDirAsync(node.Path, cursor, CloudDirPageLimit, cts.Token);
                if (listing == null)
                {
                    CloudStatus = "Listing failed — see maple.log";
                    break;
                }
                foreach (var image in listing.Images)
                {
                    // The listing carries every file the File Provider syncs,
                    // including containers this app has no decoder for. The
                    // local FOLDERS browse only ever shows stills for the same
                    // reason (SupportedExtensions in .Library.cs), and a
                    // thumbnail that can't be opened is worse than an absent
                    // one. Trust the server's own classification rather than
                    // re-deriving it from the extension.
                    if (image.IsVideo || image.IsAudio || image.IsStub)
                        continue;
                    if (AllPhotos.Count >= CloudDirMaxImages)
                    {
                        truncated = true;
                        break;
                    }
                    AllPhotos.Add(CloudDirPhotoItem(image, node));
                }
                cursor = listing.NextCursor;
            }
            while (!truncated && !string.IsNullOrEmpty(cursor) && !cts.Token.IsCancellationRequested);

            CloudStatus = truncated
                ? $"Showing the first {CloudDirMaxImages} photos in {node.Name}."
                : $"{node.Name} — {AllPhotos.Count} photo{(AllPhotos.Count == 1 ? "" : "s")}.";

            ApplyFilters();
            Timeline.GroupPhotosByDate(AllPhotos);
            _ = Task.Run(() => HydrateCloudThumbnailsAsync(AllPhotos.ToList(), cts.Token), cts.Token);
        }

        private static PhotoItem CloudDirPhotoItem(CloudDirImage image, CloudFolderNode node)
        {
            var exif = image.Exif;
            var captured = exif?.CapturedAtLocal;
            var item = new PhotoItem
            {
                IsCloud = true,
                CloudAddress = CloudAddressFor(node, image.Path),
                FilePath = image.Path,
                FileName = image.Name,
                Format = image.Ext.Length > 0 ? image.Ext.ToUpperInvariant() : "RAW",
                FileSizeBytes = image.Size,
                FileModifiedUtc = captured?.ToUniversalTime() ?? DateTime.UtcNow,
                CaptureDate = captured,
            };
            // The filesystem listing carries no culling state — rating, flag
            // and colour label live in the sidecar, which the editor fetches
            // (LoadCloudSidecarAsync) when the photo is opened. Leaving the
            // grid's defaults in place is honest: nothing here claims a photo
            // is unrated, it simply hasn't been read yet.
            item.CameraModel = exif is { } e && (e.CameraMake != null || e.CameraModel != null)
                ? $"{e.CameraMake} {e.CameraModel}".Trim()
                : "—";
            item.LensInfo = exif?.Lens ?? "—";
            item.IsoDisplay = exif?.Iso is { } iso ? $"ISO {iso}" : "—";
            item.Aperture = exif?.Aperture is { } f ? $"f/{f:0.#}" : "—";
            item.ShutterSpeed = exif?.Shutter ?? "—";
            item.DateTaken = captured?.ToString("yyyy-MM-dd HH:mm") ?? "—";
            item.Dimensions = $"{image.Size / (1024.0 * 1024.0):0.0} MB";
            return item;
        }

        /// <summary>`slug:relPath` — the addressing scheme the culling route
        /// (POST /api/xmp/batch) understands. Derived here rather than read
        /// off the listing because /api/fs/dir answers in absolute paths; the
        /// relative half is what remains after the owning library's root, with
        /// separators normalised the way the server writes them.</summary>
        private static string? CloudAddressFor(CloudFolderNode node, string absPath)
        {
            if (string.IsNullOrEmpty(node.LibrarySlug))
                return null;
            var root = node.LibraryPath.TrimEnd('/');
            if (!absPath.StartsWith(root + "/", StringComparison.Ordinal))
                return null;
            return $"{node.LibrarySlug}:{absPath[(root.Length + 1)..]}";
        }

        /// <summary>Fill the grid's thumbnails from GET /api/fs/thumb, keyed
        /// by server path so files the indexer hasn't reached yet still get a
        /// picture (an address-keyed thumb needs an indexed asset).</summary>
        private async Task HydrateCloudThumbnailsAsync(List<PhotoItem> items, CancellationToken ct)
        {
            var gate = new SemaphoreSlim(4);
            var tasks = items.Select(async item =>
            {
                await gate.WaitAsync(ct);
                try
                {
                    var path = await _cloud!.FetchFsImageAsync("thumb", item.FilePath, ct);
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
            await Task.WhenAll(tasks);
        }
    }
}
