using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Services.Metadata;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels
{
    // PhotoItem, PhotoDayGroup, and FolderNode live in PhotoItem.cs (#2639
    // split, to stay under the file-size budget after adding inline-rename
    // state to PhotoItem).

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
        /// <summary>True while a Timeline period is selected — the grid shows
        /// day-group headers. False in folder browse, where the Finder
        /// contract applies: one flat, name-sorted grid
        /// (docs/spec/13-windows-shell.md).</summary>
        [ObservableProperty] private bool _isDateGrouped;
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

        public void AddLibraryFolder(string folderPath, Action? onReady = null)
        {
            if (!LibraryFolders.Contains(folderPath, StringComparer.OrdinalIgnoreCase))
            {
                LibraryFolders.Add(folderPath);
                var settings = AppSettings.Load();
                settings.LibraryFolders = LibraryFolders.ToList();
                settings.Save();
                RebuildFolderTree();
            }
            LoadDirectory(folderPath, onReady);
        }

        // AddLibraryFolderAsync / LoadDirectoryAsync — the awaitable
        // wrappers #2651's drop-to-mount flow needs — live in
        // EditSessionViewModel.DropMount.cs, to stay under this file's
        // line-budget split (see that file's header).

        public void LoadDirectory(string folderPath) => LoadDirectory(folderPath, onReady: null);

        /// <summary><paramref name="onReady"/> (#2651) fires once — on the
        /// dispatcher — after this call's own AllPhotos/ApplyFilters update
        /// has landed, or immediately (off the UI thread) on any early-out
        /// (blank path, missing folder, superseded by a newer LoadDirectory
        /// call) so an awaiting caller can never hang. It fires BEFORE the
        /// fire-and-forget thumbnail/EXIF hydration starts, not after —
        /// callers that need to select or open a specific dropped file only
        /// need FilePath/FileName to exist in <see cref="Photos"/>, not the
        /// full hydration. Both the background scan and the dispatcher
        /// apply step are wrapped in a broad try/catch (#2754): an
        /// unexpected exception mid-scan — something not scoped to a
        /// single file, since per-file failures are now caught below —
        /// must still invoke onReady, or an awaiting
        /// AddLibraryFolderAsync/LoadDirectoryAsync (and whatever gate the
        /// caller holds, e.g. MainWindow.DropMount.cs's _dropGate) would
        /// hang forever.</summary>
        private void LoadDirectory(string folderPath, Action? onReady)
        {
            if (string.IsNullOrWhiteSpace(folderPath))
            {
                onReady?.Invoke();
                return;
            }

            _libraryCts?.Cancel();
            var cts = new CancellationTokenSource();
            _libraryCts = cts;

            BeginBrowse(local: folderPath);
            CurrentFolderPath = folderPath;
            ActiveSectionName = Path.GetFileName(folderPath) is { Length: > 0 } name ? name : folderPath;
            BrowseFolders.Clear();  // repopulated with this folder's children below
            WatchBrowsedFolder(folderPath);

            // The scan (recursive enumeration + sidecar reads) runs off the UI
            // thread — a slow or dead network folder must never freeze the
            // shell. Results land back on the dispatcher unless superseded.
            _ = Task.Run(() =>
            {
                try
                {
                    if (!Directory.Exists(folderPath))
                    {
                        DiagLog.Write($"[library] folder unavailable: {folderPath}");
                        App.MainDispatcherQueue?.TryEnqueue(() => FinishBrowse(cts, "Folder is not available."));
                        onReady?.Invoke();
                        return;
                    }
                    // #2657 closed-app rename fallback lives in EnumerateAndReconcile.
                    var filePaths = EnumerateAndReconcile(folderPath);
                    // Finder contract (docs/spec/13-windows-shell.md): the
                    // grid shows this folder's subfolders as tiles above its
                    // images — same enumeration the sidebar tree uses.
                    var subfolderNodes = EnumerateChildFolderNodes(folderPath);

                    // Per-item try/catch (#2754), mirroring EditSessionViewModel.
                    // Watcher.cs's ChangesReady handler: one unreadable file
                    // (a transient FileInfo failure, a sidecar SidecarStore.Load
                    // doesn't already swallow) skips that file rather than
                    // aborting the whole folder's load — the outer try/catch
                    // around this Task.Run body still exists as the backstop
                    // for anything NOT scoped to a single file.
                    var items = filePaths
                        .TakeWhile(_ => !cts.Token.IsCancellationRequested)
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
                                DiagLog.Write($"[library] skipped unreadable file: {filePath}: {ex.Message}");
                                return null;
                            }
                        })
                        .Where(item => item != null)
                        .Select(item => item!)
                        .ToList();
                    if (cts.Token.IsCancellationRequested)
                    {
                        onReady?.Invoke();
                        return;
                    }

                    // TryEnqueue's return is captured (#2754):
                    // App.MainDispatcherQueue can be null, or TryEnqueue
                    // can return false (the dispatcher
                    // is shutting down), in which case the lambda — and the
                    // onReady?.Invoke() inside it — never runs at all. Left
                    // unchecked, that permanently hangs whatever awaits
                    // AddLibraryFolderAsync/LoadDirectoryAsync's
                    // TaskCompletionSource, and with it MainWindow.
                    // DropMount.cs's _dropGate, silently disabling drop-to-
                    // mount for the rest of the session.
                    var enqueued = App.MainDispatcherQueue?.TryEnqueue(() =>
                    {
                        try
                        {
                            if (cts.Token.IsCancellationRequested)
                            {
                                onReady?.Invoke();
                                return;
                            }
                            AllPhotos.Clear();
                            foreach (var item in items)
                                AllPhotos.Add(item);
                            BrowseFolders.Clear();
                            foreach (var sub in subfolderNodes)
                                BrowseFolders.Add(sub);
                            ApplyFilters();
                            FinishBrowse(cts, string.Empty);
                            Timeline.GroupPhotosByDate(AllPhotos);
                            onReady?.Invoke();
                            _ = Task.Run(() => HydrateLibraryAsync(items, folderPath, cts.Token), cts.Token);
                        }
                        catch (Exception ex)
                        {
                            DiagLog.Write($"[library] applying scanned folder failed: {folderPath}: {ex.Message}");
                            FinishBrowse(cts, "Could not load this folder. Select it to retry.");
                            onReady?.Invoke();
                        }
                    }) ?? false;
                    if (!enqueued)
                    {
                        // Resolved successfully, not exceptionally: every
                        // caller of the awaitable wrappers already treats
                        // "nothing resolved in AllPhotos" as a graceful,
                        // expected outcome (MainWindow.DropMount.cs's
                        // OpenDroppedFileAsync/BrowseDroppedFilesAsync fall
                        // back to Browse / an announcement, never a thrown
                        // exception) — this is that exact same case, just
                        // reached a different way, so it degrades through
                        // the same path rather than adding a new faulted-
                        // Task surface an async void event handler would
                        // have to catch.
                        DiagLog.Write($"[library] dispatcher enqueue failed applying scanned folder: {folderPath}");
                        onReady?.Invoke();
                    }
                }
                catch (Exception ex)
                {
                    DiagLog.Write($"[library] folder scan failed: {folderPath}: {ex.Message}");
                    App.MainDispatcherQueue?.TryEnqueue(() => FinishBrowse(cts, "Could not load this folder. Select it to retry."));
                    onReady?.Invoke();
                }
            }, cts.Token);
        }

        // WatchBrowsedFolder / CreateLibraryWatcher (#2585 live grid updates)
        // moved to EditSessionViewModel.Watcher.cs — split out (#2754) to
        // stay under this file's line-budget after the #2651 drop-to-mount
        // additions.

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

            // Two presentations (docs/spec/13-windows-shell.md, matching the
            // Mac BrowseGrid/AllSourcesTimeline split):
            //
            //  - Timeline selected → date-grouped, newest day first, capture
            //    order within the day. Day headers are the Timeline's
            //    presentation.
            //  - Browsing a folder → the Finder contract: ONE flat grid,
            //    name-ascending, no headers (Mac BrowseViewModel's
            //    `.nameAscending` default). Folder tiles render above via
            //    BrowseFolders.
            //
            // Photos (the flat list) is always the grid's traversal order, so
            // the filmstrip and arrow keys agree with what's on screen in
            // both presentations.
            IsDateGrouped = _isCloudTimeline || DateFilterStart != null;
            var groups = IsDateGrouped
                ? query
                    .GroupBy(TimelineViewModel.CaptureDay)
                    .OrderByDescending(g => g.Key)
                    .Select(g =>
                    {
                        var dayGroup = new PhotoDayGroup
                        {
                            Label = g.Key.ToString("dddd, MMMM d, yyyy"),
                            Day = g.Key,
                        };
                        var ordered = _isCloudTimeline
                            ? g.OrderByDescending(p => p.CaptureDate ?? p.FileModifiedUtc.ToLocalTime())
                            : g.OrderBy(p => p.CaptureDate ?? p.FileModifiedUtc.ToLocalTime());
                        foreach (var item in ordered.ThenBy(p => p.FileName, StringComparer.OrdinalIgnoreCase))
                            dayGroup.Add(item);
                        return dayGroup;
                    })
                    .ToList()
                : new List<PhotoDayGroup>
                {
                    BuildFlatGroup(query),
                };

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

        private static PhotoDayGroup BuildFlatGroup(IEnumerable<PhotoItem> query)
        {
            var flat = new PhotoDayGroup();
            foreach (var item in query.OrderBy(p => p.FileName, StringComparer.OrdinalIgnoreCase))
                flat.Add(item);
            return flat;
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
