using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Services.Metadata;

namespace Maple.WinUI.ViewModels
{
    /// <summary>Off-UI-thread thumbnail + EXIF hydration for a freshly
    /// scanned folder (or an incremental watcher batch), plus the small
    /// display-string formatters (camera make/model join, shutter speed)
    /// the hydrated PhotoItem fields use. Split out of
    /// EditSessionViewModel.Library.cs (#3120) to stay under the file-size
    /// budget.</summary>
    public partial class EditSessionViewModel
    {
        private sealed record HydratedPhoto(
            ExifData? Exif, string? Thumbnail, bool HasSidecar, string? OriginalThumbnail, string OriginalPath);

        /// <summary>Thumbnails + EXIF, off the UI thread, cancellable when the
        /// user navigates to another folder. Photos are prepared a few at a
        /// time and reach the grid in listing order, in batches.
        /// <paramref name="folderPath"/>, given, persists a #2657 fingerprint
        /// snapshot for a later scan; null for the live-watcher arrival path
        /// (an incremental batch, not the folder's full contents). Returns
        /// once the first fill is done; edited photos are developed afterwards
        /// in the background.</summary>
        private async Task HydrateLibraryAsync(List<PhotoItem> items, string? folderPath, CancellationToken ct)
        {
            var snapshot = new ConcurrentDictionary<string, RenameReconciliationLogic.Fingerprint>(StringComparer.OrdinalIgnoreCase);
            try
            {
                await Services.LibraryHydration.RunAsync<PhotoItem, HydratedPhoto>(
                    items,
                    Services.LibraryHydration.Width,
                    Services.LibraryHydration.BatchSize,
                    (item, token) => HydratePhotoAsync(item, snapshot, token),
                    batch => OnUiAcknowledgedAsync(() => ApplyHydrated(batch, ct)),
                    () => OnUiAcknowledgedAsync(() => RegroupAfterHydration(ct)),
                    (item, error) => Services.DiagLog.Write($"[library] hydration failed for {item.FilePath}: {error.Message}"),
                    ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            if (ct.IsCancellationRequested)
                return;
            if (folderPath != null)
                SaveRenameSnapshot(folderPath, snapshot);
            // Populate the whole library before serialized RAW development.
            // Otherwise one edited 100MP photo blocks every following cell.
            _ = Services.LibraryHydration.RunInBackground(
                items,
                async (item, token) =>
                {
                    if (System.IO.File.Exists(Services.Xmp.SidecarStore.SidecarPathFor(item.FilePath)))
                        await RefreshLocalThumbnailAsync(item, token);
                },
                (item, error) => Services.DiagLog.Write($"[library] edited thumbnail failed for {item.FilePath}: {error.Message}"),
                ct);
        }

        private async Task<HydratedPhoto> HydratePhotoAsync(
            PhotoItem item, ConcurrentDictionary<string, RenameReconciliationLogic.Fingerprint> snapshot, CancellationToken ct)
        {
            // SafeReadExif (#2754 pattern): one locked or since-vanished
            // file must not abort hydration for the rest of the folder.
            var exif = SafeReadExif(item.FilePath);
            snapshot[item.FileName] = new RenameReconciliationLogic.Fingerprint(
                item.FileSizeBytes, exif?.DateTimeOriginal, exif?.CameraSerial);
            var originalThumbnail = item.ThumbnailPath;
            var originalPath = item.FilePath;
            // Authored shared derivatives now use the export renderer on
            // a cold miss. Do not block the rest of the library on that
            // work: the second pass develops bounded edited previews.
            var hasSidecar = true;
            string? thumb = null;
            try
            {
                hasSidecar = !Services.ThumbnailRenderer.CanDevelopUneditedFallback(originalPath);
                thumb = hasSidecar ? _thumbnails.GetCachedThumbnail(originalPath)
                    : await _thumbnails.GetOrCreateAsync(originalPath, ct);
            }
            catch (Exception error) when (error is System.IO.IOException or UnauthorizedAccessException)
            {
                // One inaccessible sidecar/cache must not stop the folder
                // or cause an unedited JPEG to masquerade as the edit.
                Services.DiagLog.Write($"[thumb] library cache unavailable: {error.Message}");
            }
            thumb = await Services.DisplayImageCache.PrepareAsync(thumb, Services.ThumbnailService.ThumbnailMaxPx, ct);
            return new HydratedPhoto(exif, thumb, hasSidecar, originalThumbnail, originalPath);
        }

        private void ApplyHydrated(IReadOnlyList<(PhotoItem Item, HydratedPhoto Result)> batch, CancellationToken ct)
        {
            if (_disposed || ct.IsCancellationRequested) return;
            foreach (var (item, hydrated) in batch)
            {
                if (item.FilePath != hydrated.OriginalPath) continue;
                var exif = hydrated.Exif;
                // JPEGs are directly displayable, so a missing embedded
                // preview falls back to the file itself.
                var effectiveThumb = hydrated.Thumbnail
                    ?? (!hydrated.HasSidecar && (item.Format is "JPG" or "JPEG") ? item.FilePath : null);
                if (effectiveThumb != null && hydrated.OriginalThumbnail == null && item.ThumbnailPath == null)
                    item.ThumbnailPath = new Uri(effectiveThumb).AbsoluteUri;
                if (exif != null)
                {
                    item.CameraModel = Join(exif.CameraMake, exif.CameraModel) ?? "—";
                    item.LensInfo = exif.LensModel ?? "—";
                    item.IsoDisplay = exif.Iso is { } iso ? $"ISO {iso}" : "—";
                    item.Aperture = exif.FNumber is { } f ? $"f/{f:0.#}" : "—";
                    item.ShutterSpeed = FormatShutter(exif.ExposureTimeSeconds);
                    item.FocalLengthMm = exif.FocalLengthMm;
                    item.CaptureDate = exif.DateTimeOriginal;
                    item.DateTaken = exif.DateTimeOriginal?.ToString("yyyy-MM-dd HH:mm")
                        ?? "—";
                    item.Dimensions = exif is { PixelWidth: { } w, PixelHeight: { } h }
                        ? $"{w} × {h}"
                        : "—";
                }
            }
        }

        private void RegroupAfterHydration(CancellationToken ct)
        {
            if (_disposed || ct.IsCancellationRequested || !(IsDateGrouped || !string.IsNullOrWhiteSpace(SearchText))) return;
            // EXIF capture dates are now in; regroup the timeline
            // and the grid sections (mtime was the placeholder).
            Timeline.GroupPhotosByDate(AllPhotos);
            ApplyFilters();
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
    }
}
