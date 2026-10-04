using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;

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
        /// <summary>Thumbnails + EXIF, off the UI thread, cancellable when the
        /// user navigates to another folder. <paramref name="folderPath"/>,
        /// given, persists a #2657 fingerprint snapshot for a later scan;
        /// null for the live-watcher arrival path (an incremental batch, not
        /// the folder's full contents).</summary>
        private async Task HydrateLibraryAsync(List<PhotoItem> items, string? folderPath, CancellationToken ct)
        {
            var snapshot = new Dictionary<string, RenameReconciliationLogic.Fingerprint>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in items)
            {
                if (ct.IsCancellationRequested)
                    return;

                // SafeReadExif (#2754 pattern): one locked or since-vanished
                // file must not abort hydration for the rest of the folder.
                var exif = SafeReadExif(item.FilePath);
                snapshot[item.FileName] = new RenameReconciliationLogic.Fingerprint(
                    item.FileSizeBytes, exif?.DateTimeOriginal, exif?.CameraSerial);
                var originalThumbnail = item.ThumbnailPath;
                var originalPath = item.FilePath;
                // Authored shared derivatives now use the export renderer on
                // a cold miss. Do not block the rest of the library on that
                // work: the second pass below develops bounded edited previews.
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

                await OnUiAcknowledgedAsync(() =>
                {
                    if (_disposed || ct.IsCancellationRequested || item.FilePath != originalPath) return;
                    // JPEGs are directly displayable, so a missing embedded
                    // preview falls back to the file itself.
                    var effectiveThumb = thumb
                        ?? (!hasSidecar && (item.Format is "JPG" or "JPEG") ? item.FilePath : null);
                    if (effectiveThumb != null && originalThumbnail == null && item.ThumbnailPath == null)
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
                    if (ReferenceEquals(item, items[^1]) && (IsDateGrouped || !string.IsNullOrWhiteSpace(SearchText)))
                    {
                        // EXIF capture dates are now in; regroup the timeline
                        // and the grid sections (mtime was the placeholder).
                        Timeline.GroupPhotosByDate(AllPhotos);
                        ApplyFilters();
                    }
                });
            }
            if (!ct.IsCancellationRequested && folderPath != null)
                SaveRenameSnapshot(folderPath, snapshot);
            // Populate the whole library before serialized RAW development.
            // Otherwise one edited 100MP photo blocks every following cell.
            foreach (var item in items)
            {
                ct.ThrowIfCancellationRequested();
                if (!System.IO.File.Exists(Services.Xmp.SidecarStore.SidecarPathFor(item.FilePath))) continue;
                await RefreshLocalThumbnailAsync(item, ct);
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
    }
}
