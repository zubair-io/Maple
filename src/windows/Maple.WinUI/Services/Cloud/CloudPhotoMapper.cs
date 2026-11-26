using System;
using System.IO;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI.Services.Cloud;

internal static class CloudPhotoMapper
{
    internal static PhotoItem FromDirectory(CloudFolderImage image)
    {
        var exif = image.Exif;
        var captured = exif?.CapturedAtLocal;
        var item = new PhotoItem
        {
            IsCloud = true,
            CloudAddress = string.IsNullOrEmpty(image.Address) ? null : image.Address,
            FilePath = image.Path,
            FileName = image.Name,
            Format = image.Ext.Length > 0 ? image.Ext.ToUpperInvariant() : "RAW",
            FileSizeBytes = image.Size,
            // The listing's own mtime, exactly as the local browse uses
            // File.LastWriteTimeUtc. Capture date stays capture date: for
            // a file the indexer hasn't reached there is no EXIF, and
            // dating it "now" would reshuffle the day groups on every
            // reload (grouping falls back to this field).
            FileModifiedUtc = ParseMtimeUtc(image.Mtime),
            CaptureDate = captured,
        };
        // Culling fields stay at their defaults until the editor loads the sidecar.
        item.CameraModel = exif is { } e && (e.CameraMake != null || e.CameraModel != null)
            ? $"{e.CameraMake} {e.CameraModel}".Trim()
            : "—";
        item.LensInfo = exif?.Lens ?? "—";
        item.IsoDisplay = exif?.Iso is { } iso ? $"ISO {iso}" : "—";
        item.Aperture = exif?.Aperture is { } f ? $"f/{f:0.#}" : "—";
        item.ShutterSpeed = exif?.Shutter ?? "—";
        item.FocalLengthMm = exif?.FocalLengthMm;
        item.DateTaken = captured?.ToString("yyyy-MM-dd HH:mm") ?? "—";
        item.Dimensions = "—";
        return item;
    }

    internal static PhotoItem FromTimeline(CloudTimelinePhoto image)
    {
        var item = FromDirectory(new CloudFolderImage
        {
            Name = image.Filename,
            Address = image.Address ?? string.Empty,
            Path = image.Path,
            Size = image.Size,
            Ext = Path.GetExtension(image.Filename).TrimStart('.'),
            Mtime = DateTimeOffset.FromUnixTimeMilliseconds((long)image.Mtime).ToString("O"),
            Exif = new CloudImageExif
            {
                CapturedAt = image.CapturedAt, CameraMake = image.Camera?.Make,
                CameraModel = image.Camera?.Model, Lens = image.Lens, Iso = image.Iso,
                Aperture = image.Aperture, Shutter = image.Shutter,
                FocalLengthMm = image.FocalLengthMm,
            },
        });
        item.Rating = image.Rating;
        item.FlagStatus = image.Flag switch { 1 => "pick", -1 => "reject", _ => "none" };
        item.ColorLabel = image.ColorLabel;
        return item;
    }
    /// <summary>The listing's ISO-8601 mtime. Falls back to epoch, not to
    /// "now": a missing mtime must sort deterministically rather than jump
    /// to the top of the grid on each reload.</summary>
    private static DateTime ParseMtimeUtc(string? mtime) =>
        DateTime.TryParse(mtime, null,
            System.Globalization.DateTimeStyles.RoundtripKind, out var dt)
            ? dt.ToUniversalTime()
            : DateTime.UnixEpoch;

}
