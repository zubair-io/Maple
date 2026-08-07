// PhotoItem.cs — the library grid's per-photo view-model, plus its two
// small satellite types (PhotoDayGroup, FolderNode). Split out of
// EditSessionViewModel.Library.cs (#2639) purely to stay under the 600-line
// hard budget after adding inline-rename state — no behavior moved, just
// location.

using System;
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Maple.WinUI.ViewModels
{
    public partial class PhotoItem : ObservableObject
    {
        // Settable (not `init`), not [ObservableProperty]: a successful
        // inline rename (#2639) needs to update these post-construction.
        // Property-changed notification still fires — SetProperty(...) in
        // the setters below routes through ObservableObject's own
        // SetProperty — so the grid cell's `{Binding FileName}` and the
        // Preview/Edit top bar's `{Binding SelectedPhoto.FileName}` follow
        // the new name rather than holding the stale one.
        private string _filePath = string.Empty;
        public string FilePath
        {
            get => _filePath;
            set => SetProperty(ref _filePath, value);
        }

        private string _fileName = string.Empty;
        public string FileName
        {
            get => _fileName;
            set => SetProperty(ref _fileName, value);
        }

        public string Format { get; init; } = string.Empty;
        public long FileSizeBytes { get; init; }
        public DateTime FileModifiedUtc { get; init; }

        [ObservableProperty] private string? _thumbnailPath;
        /// <summary>Full-screen embedded-JPEG preview (extracted on demand when
        /// the photo is opened in Preview mode).</summary>
        [ObservableProperty] private string? _previewPath;

        // --- Inline rename (#2639) ---

        /// <summary>True while the grid cell's filename TextBlock is swapped
        /// for an editable TextBox (F2 or double-click the filename).</summary>
        [ObservableProperty] private bool _isRenaming;
        /// <summary>The rename field's live text, two-way bound to the
        /// TextBox — seeded with the current FileName on entry, committed
        /// (or discarded) on Enter/Escape.</summary>
        [ObservableProperty] private string _renameText = string.Empty;
        /// <summary>Non-null while the current RenameText is rejected
        /// (invalid name, collision, same-file) — surfaced next to the
        /// field as a ToolTip; null once the field is clean or closed.</summary>
        [ObservableProperty] private string? _renameError;

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
}
