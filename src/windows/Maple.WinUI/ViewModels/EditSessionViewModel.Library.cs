using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Metadata;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels
{
    public partial class PhotoItem : ObservableObject
    {
        public string FilePath { get; init; } = string.Empty;
        public string FileName { get; init; } = string.Empty;
        public string Format { get; init; } = string.Empty;
        public long FileSizeBytes { get; init; }
        public DateTime FileModifiedUtc { get; init; }

        [ObservableProperty] private string? _thumbnailPath;
        /// <summary>Full-screen embedded-JPEG preview (extracted on demand when
        /// the photo is opened in Preview mode).</summary>
        [ObservableProperty] private string? _previewPath;

        /// <summary>Cloud asset marker (#2588): the photo lives on a Maple
        /// Self-Hosted server, addressed by slug:relPath. Cloud assets browse,
        /// preview and cull; editing needs the original locally.</summary>
        public bool IsCloud { get; init; }
        public string? CloudAddress { get; init; }
        /// <summary>Locally cached original for a cloud asset (download-to-edit).
        /// Null until the first Edit entry downloads it.</summary>
        public string? LocalCachePath { get; set; }
        /// <summary>The path decode/develop/export should read: the local cache
        /// for a downloaded cloud asset, the file itself otherwise.</summary>
        public string EditPath => LocalCachePath ?? FilePath;
        [ObservableProperty] private int _rating;
        [ObservableProperty] private string _flagStatus = "none";   // pick | reject | none
        [ObservableProperty] private string? _colorLabel;

        // EXIF (populated asynchronously; empty until read)
        [ObservableProperty] private string _cameraModel = "—";
        [ObservableProperty] private string _lensInfo = "—";
        [ObservableProperty] private string _isoDisplay = "—";
        [ObservableProperty] private string _aperture = "—";
        [ObservableProperty] private string _shutterSpeed = "—";
        [ObservableProperty] private string _dateTaken = "—";
        [ObservableProperty] private string _dimensions = "—";
        public DateTime? CaptureDate { get; set; }

        public string RatingStars =>
            Rating <= 0 ? string.Empty : new string('★', Rating) + new string('☆', 5 - Rating);

        partial void OnRatingChanged(int value) => OnPropertyChanged(nameof(RatingStars));
    }

    /// <summary>One capture-day section of the grouped browse grid (#2570).
    /// Extends ObservableCollection so CollectionViewSource.IsSourceGrouped can
    /// enumerate it directly; the header template binds Label/Count.</summary>
    public sealed class PhotoDayGroup : ObservableCollection<PhotoItem>
    {
        public string Label { get; init; } = string.Empty;
        public DateTime Day { get; init; }
    }

    /// <summary>One node of the sidebar folder tree: a library root or one of
    /// its subfolders. Invoking a node loads that folder's own photos; children
    /// materialize lazily on expand so a huge tree is never walked eagerly.</summary>
    public sealed class FolderNode
    {
        public string Name { get; init; } = string.Empty;
        public string Path { get; init; } = string.Empty;
        public ObservableCollection<FolderNode> Children { get; } = new();
        /// <summary>True once the real children replaced the expander stub.</summary>
        public bool ChildrenLoaded { get; set; }
        /// <summary>Marker child that makes the expander chevron show before
        /// the real children have been enumerated.</summary>
        public bool IsPlaceholder { get; init; }
    }

    public partial class EditSessionViewModel
    {
        public ObservableCollection<PhotoItem> Photos { get; } = new();
        public ObservableCollection<PhotoDayGroup> PhotoGroups { get; } = new();
        public ObservableCollection<FolderNode> FolderTree { get; } = new();

        public List<PhotoItem> AllPhotos { get; } = new();
        public ObservableCollection<string> LibraryFolders { get; } = new();
        public TimelineViewModel Timeline { get; } = new();

        private readonly ThumbnailService _thumbnails = new();
        private CancellationTokenSource? _libraryCts;
        private LibraryWatcher? _libraryWatcher;

        [ObservableProperty] private string _currentFolderPath = string.Empty;
        [ObservableProperty] private string _activeSectionName = "All Photos";
        [ObservableProperty] private bool _hasPhotos;
        [ObservableProperty] private string _formatFilter = "All";
        [ObservableProperty] private int _minRatingFilter;
        [ObservableProperty] private string _flagFilter = "all";    // all | pick | reject
        [ObservableProperty] private string _searchText = string.Empty;
        public DateTime? DateFilterStart { get; private set; }
        public DateTime? DateFilterEndExclusive { get; private set; }

        private static readonly HashSet<string> SupportedExtensions = new(StringComparer.OrdinalIgnoreCase)
        {
            ".dng", ".arw", ".cr3", ".cr2", ".nef", ".orf", ".rw2", ".pef", ".raf", ".srw",
            ".tif", ".tiff", ".jpg", ".jpeg",
        };

        private void InitializeLibrary()
        {
            // No filesystem calls on the UI thread here: a dead network drive
            // (e.g. a mapped X:\ share) blocks Directory.Exists/enumeration for
            // tens of seconds and hangs startup. Roots are added verbatim; the
            // tree build and the existence checks happen on the thread pool.
            foreach (var folder in AppSettings.Load().LibraryFolders)
                LibraryFolders.Add(folder);
            RebuildFolderTree();
            var first = LibraryFolders.FirstOrDefault();
            if (first != null)
                LoadDirectory(first);
        }

        public void AddLibraryFolder(string folderPath)
        {
            if (!LibraryFolders.Contains(folderPath, StringComparer.OrdinalIgnoreCase))
            {
                LibraryFolders.Add(folderPath);
                var settings = AppSettings.Load();
                settings.LibraryFolders = LibraryFolders.ToList();
                settings.Save();
                RebuildFolderTree();
            }
            LoadDirectory(folderPath);
        }

        private void RebuildFolderTree()
        {
            FolderTree.Clear();
            foreach (var root in LibraryFolders.ToList())
            {
                _ = Task.Run(() =>
                {
                    // Off the UI thread: Exists + enumeration can block on
                    // unreachable network roots without freezing the shell.
                    if (!Directory.Exists(root))
                    {
                        DiagLog.Write($"[library] root unavailable: {root}");
                        return;
                    }
                    var node = BuildFolderNode(root);
                    App.MainDispatcherQueue?.TryEnqueue(() => FolderTree.Add(node));
                });
            }
        }

        /// <summary>Build ONE tree node: name + an expander stub when the
        /// folder has subfolders. No recursion — children load on expand.</summary>
        private static FolderNode BuildFolderNode(string path)
        {
            var name = Path.GetFileName(path.TrimEnd(Path.DirectorySeparatorChar));
            var node = new FolderNode
            {
                Name = name.Length > 0 ? name : path,
                Path = path,
            };
            if (HasVisibleSubdirectory(path))
                node.Children.Add(new FolderNode { Name = "…", IsPlaceholder = true });
            return node;
        }

        private static bool HasVisibleSubdirectory(string path)
        {
            try
            {
                return Directory.EnumerateDirectories(path).Any(d => !IsSkippableDirectory(d));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return false;
            }
        }

        public bool IsLibraryRoot(string path) =>
            LibraryFolders.Contains(path, StringComparer.OrdinalIgnoreCase);

        /// <summary>Unregister a library root. Never touches the folder on
        /// disk — originals and sidecars stay exactly where they are.</summary>
        public void RemoveLibraryFolder(string path)
        {
            var match = LibraryFolders.FirstOrDefault(
                f => string.Equals(f, path, StringComparison.OrdinalIgnoreCase));
            if (match == null)
                return;
            LibraryFolders.Remove(match);
            var settings = AppSettings.Load();
            settings.LibraryFolders = LibraryFolders.ToList();
            settings.Save();

            var node = FolderTree.FirstOrDefault(
                n => string.Equals(n.Path, path, StringComparison.OrdinalIgnoreCase));
            if (node != null)
                FolderTree.Remove(node);

            if (CurrentFolderPath.StartsWith(path, StringComparison.OrdinalIgnoreCase))
            {
                _libraryCts?.Cancel();
                AllPhotos.Clear();
                ApplyFilters();
                Timeline.GroupPhotosByDate(AllPhotos);
                CurrentFolderPath = string.Empty;
                ActiveSectionName = "All Photos";
                var first = LibraryFolders.FirstOrDefault();
                if (first != null)
                    LoadDirectory(first);
            }
        }

        /// <summary>Lazy expand: replace the stub with the folder's immediate
        /// subfolders, enumerated off the UI thread.</summary>
        public void LoadFolderChildren(FolderNode node)
        {
            if (node.ChildrenLoaded || node.IsPlaceholder)
                return;
            node.ChildrenLoaded = true;
            _ = Task.Run(() =>
            {
                List<FolderNode> children;
                try
                {
                    children = Directory.EnumerateDirectories(node.Path)
                        .Where(d => !IsSkippableDirectory(d))
                        .OrderBy(d => d, StringComparer.OrdinalIgnoreCase)
                        .Select(BuildFolderNode)
                        .ToList();
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    children = new List<FolderNode>();
                }
                App.MainDispatcherQueue?.TryEnqueue(() =>
                {
                    node.Children.Clear();
                    foreach (var child in children)
                        node.Children.Add(child);
                });
            });
        }

        private static bool IsSkippableDirectory(string dir)
        {
            var name = Path.GetFileName(dir);
            if (name.StartsWith('.'))
                return true;
            try
            {
                var attrs = File.GetAttributes(dir);
                // ReparsePoint skip keeps the walk out of junction cycles and
                // cloud-placeholder mounts below a root.
                return attrs.HasFlag(FileAttributes.Hidden)
                    || attrs.HasFlag(FileAttributes.System)
                    || attrs.HasFlag(FileAttributes.ReparsePoint);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return true;
            }
        }

        public void LoadDirectory(string folderPath)
        {
            if (string.IsNullOrWhiteSpace(folderPath))
                return;

            _libraryCts?.Cancel();
            var cts = new CancellationTokenSource();
            _libraryCts = cts;

            CurrentFolderPath = folderPath;
            ActiveSectionName = Path.GetFileName(folderPath) is { Length: > 0 } name ? name : folderPath;
            WatchBrowsedFolder(folderPath);

            // The scan (recursive enumeration + sidecar reads) runs off the UI
            // thread — a slow or dead network folder must never freeze the
            // shell. Results land back on the dispatcher unless superseded.
            _ = Task.Run(() =>
            {
                if (!Directory.Exists(folderPath))
                {
                    DiagLog.Write($"[library] folder unavailable: {folderPath}");
                    return;
                }
                var items = EnumerateImageFiles(folderPath)
                    .TakeWhile(_ => !cts.Token.IsCancellationRequested)
                    .Select(filePath =>
                    {
                        var info = new FileInfo(filePath);
                        var item = new PhotoItem
                        {
                            FilePath = filePath,
                            FileName = info.Name,
                            Format = info.Extension.TrimStart('.').ToUpperInvariant(),
                            FileSizeBytes = info.Length,
                            FileModifiedUtc = info.LastWriteTimeUtc,
                        };
                        var sidecar = SidecarStore.Load(filePath);
                        if (sidecar != null)
                        {
                            item.Rating = sidecar.Rating ?? 0;
                            item.FlagStatus = sidecar.Flag ?? "none";
                            item.ColorLabel = sidecar.ColorLabel;
                        }
                        return item;
                    })
                    .ToList();
                if (cts.Token.IsCancellationRequested)
                    return;

                App.MainDispatcherQueue?.TryEnqueue(() =>
                {
                    if (cts.Token.IsCancellationRequested)
                        return;
                    AllPhotos.Clear();
                    foreach (var item in items)
                        AllPhotos.Add(item);
                    ApplyFilters();
                    Timeline.GroupPhotosByDate(AllPhotos);
                    _ = Task.Run(() => HydrateLibraryAsync(items, cts.Token), cts.Token);
                });
            }, cts.Token);
        }

        /// <summary>Live grid updates for the browsed folder (#2585): new files
        /// join the grid (sorted, hydrated), deleted files leave it. Cloud
        /// browsing stops the watcher (LoadCloudFolderAsync has no local dir).</summary>
        private void WatchBrowsedFolder(string folderPath)
        {
            _libraryWatcher ??= CreateLibraryWatcher();
            _libraryWatcher.Watch(folderPath);
        }

        private LibraryWatcher CreateLibraryWatcher()
        {
            var watcher = new LibraryWatcher(
                path => SupportedExtensions.Contains(Path.GetExtension(path)));
            watcher.ChangesReady += (added, removed) =>
            {
                // Build the new items off the watcher thread (FileInfo + sidecar
                // read), then apply the whole batch on the dispatcher.
                var folder = CurrentFolderPath;
                var items = added
                    .Where(p => string.Equals(Path.GetDirectoryName(p), folder, StringComparison.OrdinalIgnoreCase))
                    .Select(filePath =>
                    {
                        try
                        {
                            var info = new FileInfo(filePath);
                            var item = new PhotoItem
                            {
                                FilePath = filePath,
                                FileName = info.Name,
                                Format = info.Extension.TrimStart('.').ToUpperInvariant(),
                                FileSizeBytes = info.Length,
                                FileModifiedUtc = info.LastWriteTimeUtc,
                            };
                            var sidecar = SidecarStore.Load(filePath);
                            if (sidecar != null)
                            {
                                item.Rating = sidecar.Rating ?? 0;
                                item.FlagStatus = sidecar.Flag ?? "none";
                                item.ColorLabel = sidecar.ColorLabel;
                            }
                            return item;
                        }
                        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                        {
                            return null;
                        }
                    })
                    .Where(item => item != null)
                    .Select(item => item!)
                    .ToList();

                App.MainDispatcherQueue?.TryEnqueue(() =>
                {
                    if (!string.Equals(CurrentFolderPath, folder, StringComparison.OrdinalIgnoreCase))
                        return;    // user navigated away while the batch settled
                    var changed = false;
                    foreach (var path in removed)
                    {
                        var victim = AllPhotos.FirstOrDefault(p =>
                            string.Equals(p.FilePath, path, StringComparison.OrdinalIgnoreCase));
                        if (victim == null)
                            continue;
                        AllPhotos.Remove(victim);
                        if (ReferenceEquals(SelectedPhoto, victim))
                            SelectedPhoto = null;
                        changed = true;
                    }
                    foreach (var item in items)
                    {
                        if (AllPhotos.Any(p => string.Equals(p.FilePath, item.FilePath, StringComparison.OrdinalIgnoreCase)))
                            continue;
                        var at = AllPhotos.TakeWhile(p =>
                            string.Compare(p.FilePath, item.FilePath, StringComparison.OrdinalIgnoreCase) < 0).Count();
                        AllPhotos.Insert(at, item);
                        changed = true;
                    }
                    if (!changed)
                        return;
                    ApplyFilters();
                    Timeline.GroupPhotosByDate(AllPhotos);
                    if (items.Count > 0)
                        _ = Task.Run(() => HydrateLibraryAsync(items, CancellationToken.None));
                });
            };
            return watcher;
        }

        /// <summary>A folder shows its OWN images only — subfolders are reached
        /// through the tree. No recursion: a click on a huge library root must
        /// never trigger a full subtree walk.</summary>
        private static IEnumerable<string> EnumerateImageFiles(string folderPath)
        {
            try
            {
                return Directory.EnumerateFiles(folderPath, "*.*", SearchOption.TopDirectoryOnly)
                    .Where(f => SupportedExtensions.Contains(Path.GetExtension(f)))
                    .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
                    .ToList();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return Enumerable.Empty<string>();
            }
        }

        /// <summary>Thumbnails + EXIF, off the UI thread, cancellable when the
        /// user navigates to another folder.</summary>
        private async Task HydrateLibraryAsync(List<PhotoItem> items, CancellationToken ct)
        {
            foreach (var item in items)
            {
                if (ct.IsCancellationRequested)
                    return;

                var exif = ExifReader.Read(item.FilePath);
                var thumb = await _thumbnails.GetOrCreateAsync(item.FilePath, ct);

                App.MainDispatcherQueue?.TryEnqueue(() =>
                {
                    // JPEGs are directly displayable, so a missing embedded
                    // preview falls back to the file itself.
                    var effectiveThumb = thumb
                        ?? (item.Format is "JPG" or "JPEG" ? item.FilePath : null);
                    if (effectiveThumb != null)
                        item.ThumbnailPath = new Uri(effectiveThumb).AbsoluteUri;
                    if (exif != null)
                    {
                        item.CameraModel = Join(exif.CameraMake, exif.CameraModel) ?? "—";
                        item.LensInfo = exif.LensModel ?? "—";
                        item.IsoDisplay = exif.Iso is { } iso ? $"ISO {iso}" : "—";
                        item.Aperture = exif.FNumber is { } f ? $"f/{f:0.#}" : "—";
                        item.ShutterSpeed = FormatShutter(exif.ExposureTimeSeconds);
                        item.CaptureDate = exif.DateTimeOriginal;
                        item.DateTaken = exif.DateTimeOriginal?.ToString("yyyy-MM-dd HH:mm")
                            ?? item.FileModifiedUtc.ToLocalTime().ToString("yyyy-MM-dd HH:mm");
                        item.Dimensions = exif is { PixelWidth: { } w, PixelHeight: { } h }
                            ? $"{w} × {h}"
                            : $"{item.FileSizeBytes / (1024.0 * 1024.0):0.0} MB";
                    }
                    if (ReferenceEquals(item, items[^1]))
                    {
                        // EXIF capture dates are now in; regroup the timeline
                        // and the grid sections (mtime was the placeholder).
                        Timeline.GroupPhotosByDate(AllPhotos);
                        ApplyFilters();
                    }
                });
            }
        }

        private static string? Join(string? a, string? b) =>
            (a, b) switch
            {
                (null or "", null or "") => null,
                (null or "", _) => b,
                (_, null or "") => a,
                _ => b!.StartsWith(a!, StringComparison.OrdinalIgnoreCase) ? b : $"{a} {b}",
            };

        private static string FormatShutter(double? seconds) => seconds switch
        {
            null => "—",
            >= 1 => $"{seconds:0.#}s",
            _ => $"1/{Math.Round(1 / seconds.Value):0}s",
        };

        // --- Filtering ---

        partial void OnFormatFilterChanged(string value) => ApplyFilters();
        partial void OnMinRatingFilterChanged(int value) => ApplyFilters();
        partial void OnFlagFilterChanged(string value) => ApplyFilters();
        partial void OnSearchTextChanged(string value) => ApplyFilters();

        /// <summary>Filter to a timeline period (month or day), or clear with
        /// (null, null).</summary>
        public void SetDateFilter(DateTime? start, DateTime? endExclusive)
        {
            DateFilterStart = start;
            DateFilterEndExclusive = endExclusive;
            ApplyFilters();
        }

        public void ApplyFilters()
        {
            var query = AllPhotos.AsEnumerable();
            if (FormatFilter != "All")
                query = query.Where(p => p.Format.Equals(FormatFilter, StringComparison.OrdinalIgnoreCase));
            if (MinRatingFilter > 0)
                query = query.Where(p => p.Rating >= MinRatingFilter);
            if (FlagFilter == "pick")
                query = query.Where(p => p.FlagStatus == "pick");
            else if (FlagFilter == "reject")
                query = query.Where(p => p.FlagStatus == "reject");
            if (DateFilterStart is { } start && DateFilterEndExclusive is { } end)
                query = query.Where(p =>
                    TimelineViewModel.CaptureDay(p) >= start && TimelineViewModel.CaptureDay(p) < end);
            if (!string.IsNullOrWhiteSpace(SearchText))
            {
                var needle = SearchText.Trim();
                query = query.Where(p =>
                    p.FileName.Contains(needle, StringComparison.OrdinalIgnoreCase)
                    || p.CameraModel.Contains(needle, StringComparison.OrdinalIgnoreCase)
                    || p.LensInfo.Contains(needle, StringComparison.OrdinalIgnoreCase));
            }

            // Timeline order: newest day first, capture order within the day.
            // The flat list is the concatenation of the day groups so the grid,
            // filmstrip, and arrow-key navigation all agree on ordering.
            var groups = query
                .GroupBy(TimelineViewModel.CaptureDay)
                .OrderByDescending(g => g.Key)
                .Select(g =>
                {
                    var dayGroup = new PhotoDayGroup
                    {
                        Label = g.Key.ToString("dddd, MMMM d, yyyy"),
                        Day = g.Key,
                    };
                    foreach (var item in g.OrderBy(p => p.CaptureDate ?? p.FileModifiedUtc.ToLocalTime())
                                          .ThenBy(p => p.FileName, StringComparer.OrdinalIgnoreCase))
                        dayGroup.Add(item);
                    return dayGroup;
                })
                .ToList();

            PhotoGroups.Clear();
            Photos.Clear();
            foreach (var dayGroup in groups)
            {
                PhotoGroups.Add(dayGroup);
                foreach (var item in dayGroup)
                    Photos.Add(item);
            }
            HasPhotos = Photos.Count > 0;
        }

        public void SelectNeighbor(int delta)
        {
            if (Photos.Count == 0)
                return;
            var index = SelectedPhoto == null ? 0 : Photos.IndexOf(SelectedPhoto);
            var next = Math.Clamp(index + delta, 0, Photos.Count - 1);
            SelectedPhoto = Photos[next];
        }
    }
}
