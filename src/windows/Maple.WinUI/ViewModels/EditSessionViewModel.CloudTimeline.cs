using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        [ObservableProperty] private bool _hasMoreTimeline;
        private string? _timelineCursor;

        public async Task LoadCloudTimelineAsync()
        {
            _libraryCts?.Cancel();
            _libraryCts = new CancellationTokenSource();
            _libraryWatcher?.Stop();
            BeginBrowse(timeline: true);
            CurrentFolderPath = string.Empty;
            ActiveSectionName = "Timeline";
            _timelineCursor = null;
            if (_cloud == null || !CloudConnected)
            {
                FinishBrowse(_libraryCts, "Connect to Maple Cloud to view your timeline.");
                return;
            }
            await LoadTimelinePageAsync(_libraryCts);
        }

        public async Task LoadMoreTimelineAsync()
        {
            if (!_isCloudTimeline || IsLibraryLoading || !HasMoreTimeline || _libraryCts == null) return;
            IsLibraryLoading = true;
            LibraryLoadStatus = "Loading…";
            await LoadTimelinePageAsync(_libraryCts);
        }

        private async Task LoadTimelinePageAsync(CancellationTokenSource owner)
        {
            var client = _cloud!;
            try
            {
                var page = await client.GetTimelineAsync(_timelineCursor, owner.Token);
                if (_libraryCts != owner || owner.IsCancellationRequested) return;
                if (page == null) throw new InvalidOperationException("The server could not load the timeline.");
                var items = page.NewPhotos(AllPhotos.Select(photo => photo.FilePath))
                    .Select(TimelinePhotoItem).ToList();
                AllPhotos.AddRange(items);
                _timelineCursor = page.NextCursor;
                HasMoreTimeline = !string.IsNullOrEmpty(_timelineCursor);
                ApplyFilters();
                FinishBrowse(owner, string.Empty);
                _ = Task.Run(() => HydrateCloudThumbnailsAsync(items, owner.Token), owner.Token);
            }
            catch (OperationCanceledException) when (owner.IsCancellationRequested) { }
            catch (Exception)
            {
                FinishBrowse(owner, "Could not load the timeline. Select Timeline to retry.");
            }
        }

        private static PhotoItem TimelinePhotoItem(CloudTimelinePhoto image)
        {
            var item = CloudDirPhotoItem(new CloudDirImage
            {
                Name = image.Filename,
                Path = image.Path,
                Size = image.Size,
                Ext = Path.GetExtension(image.Filename).TrimStart('.'),
                Mtime = DateTimeOffset.FromUnixTimeMilliseconds((long)image.Mtime).ToString("O"),
                Exif = new CloudDirExif
                {
                    CapturedAt = image.CapturedAt, CameraMake = image.Camera?.Make,
                    CameraModel = image.Camera?.Model, Lens = image.Lens, Iso = image.Iso,
                    Aperture = image.Aperture, Shutter = image.Shutter,
                },
            }, new CloudFolderNode(), image.Address);
            item.Rating = image.Rating;
            item.FlagStatus = image.Flag switch { 1 => "pick", -1 => "reject", _ => "none" };
            item.ColorLabel = image.ColorLabel;
            return item;
        }
    }
}
