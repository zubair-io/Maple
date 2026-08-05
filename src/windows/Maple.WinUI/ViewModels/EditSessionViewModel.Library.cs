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

    public partial class EditSessionViewModel
    {
        public ObservableCollection<PhotoItem> Photos { get; } = new();
        public ObservableCollection<PhotoDayGroup> PhotoGroups { get; } = new();
        public List<PhotoItem> AllPhotos { get; } = new();
        public ObservableCollection<string> LibraryFolders { get; } = new();
        public TimelineViewModel Timeline { get; } = new();

        private readonly ThumbnailService _thumbnails = new();
        private CancellationTokenSource? _libraryCts;

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
            foreach (var folder in AppSettings.Load().LibraryFolders.Where(Directory.Exists))
                LibraryFolders.Add(folder);
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
            }
            LoadDirectory(folderPath);
        }

        public void LoadDirectory(string folderPath)
        {
            if (string.IsNullOrWhiteSpace(folderPath) || !Directory.Exists(folderPath))
                return;

            _libraryCts?.Cancel();
            var cts = new CancellationTokenSource();
            _libraryCts = cts;

            CurrentFolderPath = folderPath;
            ActiveSectionName = Path.GetFileName(folderPath) is { Length: > 0 } name ? name : folderPath;

            AllPhotos.Clear();
            var files = EnumerateImageFiles(folderPath).ToList();
            foreach (var filePath in files)
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
                AllPhotos.Add(item);
            }

            ApplyFilters();
            Timeline.GroupPhotosByDate(AllPhotos);
            _ = Task.Run(() => HydrateLibraryAsync(AllPhotos.ToList(), cts.Token), cts.Token);
        }

        private static IEnumerable<string> EnumerateImageFiles(string folderPath)
        {
            try
            {
                return Directory.EnumerateFiles(folderPath, "*.*", SearchOption.TopDirectoryOnly)
                    .Where(f => SupportedExtensions.Contains(Path.GetExtension(f)))
                    .OrderBy(f => f, StringComparer.OrdinalIgnoreCase);
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
