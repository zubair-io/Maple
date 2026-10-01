using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services;
using Windows.Graphics.Imaging;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyThumbnailFallbackAsync(string raw, string output)
    {
        var fixture = Path.Combine(output, "thumbnail-source.dng");
        File.Copy(raw, fixture);
        var before = SHA256.HashData(await File.ReadAllBytesAsync(fixture));
        var thumbnails = new ThumbnailService();
        var path = await thumbnails.GetOrCreateAsync(fixture, CancellationToken.None)
            ?? throw new InvalidOperationException("Valid RAW did not produce a thumbnail");
        var display = await DisplayImageCache.PrepareAsync(path, ThumbnailService.ThumbnailMaxPx, CancellationToken.None)
            ?? throw new InvalidOperationException("Thumbnail display decode failed");
        using (var file = File.OpenRead(display))
        {
            var decoder = await BitmapDecoder.CreateAsync(file.AsRandomAccessStream());
            if (decoder.PixelWidth == 0 || decoder.PixelHeight == 0 ||
                Math.Max(decoder.PixelWidth, decoder.PixelHeight) > ThumbnailService.ThumbnailMaxPx)
                throw new InvalidOperationException("Thumbnail is not bounded to the grid tier");
        }
        var stamp = File.GetLastWriteTimeUtc(path);
        if (path != await thumbnails.GetOrCreateAsync(fixture, CancellationToken.None)
            || File.GetLastWriteTimeUtc(path) != stamp)
            throw new InvalidOperationException("Thumbnail cache hit regenerated the file");
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        try
        {
            await thumbnails.GetOrCreateAsync(fixture, cancelled.Token);
            throw new InvalidOperationException("Cancelled thumbnail request was accepted");
        }
        catch (OperationCanceledException) { }
        if (!before.SequenceEqual(SHA256.HashData(await File.ReadAllBytesAsync(fixture)))
            || File.Exists(Services.Xmp.SidecarStore.SidecarPathFor(fixture)))
            throw new InvalidOperationException("Thumbnail generation changed the original or created a sidecar");
        VerifyBrowseDetailImageReuse(display, output);
        await VerifyAdjustedBrowsePreviewAsync(fixture, thumbnails);
        await ViewModels.EditSessionViewModel.VerifyLocalPreviewAsync(fixture);
        await ViewModels.EditSessionViewModel.VerifySavedCloudPreviewAsync(fixture, output);
        await VerifyInvalidSidecarThumbnailAsync(fixture, thumbnails);
    }

    private static async Task VerifyInvalidSidecarThumbnailAsync(string fixture, ThumbnailService thumbnails)
    {
        var sidecar = Services.Xmp.SidecarStore.SidecarPathFor(fixture);
        var original = SHA256.HashData(await File.ReadAllBytesAsync(fixture));
        await File.WriteAllTextAsync(sidecar, "<broken");
        File.SetLastWriteTimeUtc(sidecar, DateTime.UtcNow.AddMinutes(1));
        if (await thumbnails.GetOrCreateAsync(fixture, CancellationToken.None) != null)
            throw new InvalidOperationException("Invalid sidecar fell back to an unedited thumbnail");
        if (await File.ReadAllTextAsync(sidecar) != "<broken"
            || !original.SequenceEqual(SHA256.HashData(await File.ReadAllBytesAsync(fixture))))
            throw new InvalidOperationException("Failed thumbnail recovery changed original or sidecar");
    }

    private static async Task VerifyAdjustedBrowsePreviewAsync(string fixture, ThumbnailService thumbnails)
    {
        var original = SHA256.HashData(await File.ReadAllBytesAsync(fixture));
        var baseline = new Models.AdjustmentState { Profile = Models.ProfileMode.Neutral };
        var edited = baseline.Clone();
        edited.Exposure = 2;
        var first = await thumbnails.GetOrCreateAdjustedPreviewAsync(fixture, baseline, CancellationToken.None)
            ?? throw new InvalidOperationException("Baseline derivative missing");
        var brighter = await thumbnails.GetOrCreateAdjustedPreviewAsync(fixture, edited, CancellationToken.None)
            ?? throw new InvalidOperationException("Edited derivative missing");
        var firstPixels = await ReadDerivativePixelsAsync(first);
        var editedPixels = await ReadDerivativePixelsAsync(brighter);
        if (first == brighter || firstPixels.SequenceEqual(editedPixels))
            throw new InvalidOperationException("Browse derivative ignored the exposure adjustment");
        var thumbnail = await thumbnails.GetOrCreateAdjustedThumbnailAsync(fixture, edited, CancellationToken.None)
            ?? throw new InvalidOperationException("Edited thumbnail missing");
        using (var file = File.OpenRead(thumbnail))
        {
            var decoder = await BitmapDecoder.CreateAsync(file.AsRandomAccessStream());
            if (decoder.PixelWidth == 0 || decoder.PixelHeight == 0 ||
                Math.Max(decoder.PixelWidth, decoder.PixelHeight) > ThumbnailService.ThumbnailMaxPx)
                throw new InvalidOperationException("Edited thumbnail exceeds grid tier");
        }
        var thumbnailStamp = File.GetLastWriteTimeUtc(thumbnail);
        if (thumbnail != await thumbnails.GetOrCreateAdjustedThumbnailAsync(fixture, edited, CancellationToken.None)
            || File.GetLastWriteTimeUtc(thumbnail) != thumbnailStamp)
            throw new InvalidOperationException("Edited thumbnail cache hit regenerated pixels");
        var stamp = File.GetLastWriteTimeUtc(brighter);
        if (brighter != await thumbnails.GetOrCreateAdjustedPreviewAsync(fixture, edited, CancellationToken.None)
            || stamp != File.GetLastWriteTimeUtc(brighter)
            || first != await thumbnails.GetOrCreateAdjustedPreviewAsync(fixture, baseline, CancellationToken.None))
            throw new InvalidOperationException("Browse derivative cache or reset identity failed");
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        try
        {
            await thumbnails.GetOrCreateAdjustedPreviewAsync(fixture, edited, cancelled.Token);
            throw new InvalidOperationException("Cancelled edited derivative request was accepted");
        }
        catch (OperationCanceledException) { }
        if (!original.SequenceEqual(SHA256.HashData(await File.ReadAllBytesAsync(fixture)))
            || File.Exists(Services.Xmp.SidecarStore.SidecarPathFor(fixture)))
            throw new InvalidOperationException("Browse derivative changed source or created a sidecar");
    }

    private static async Task<byte[]> ReadDerivativePixelsAsync(string path)
    {
        using var stream = File.OpenRead(path);
        var decoder = await BitmapDecoder.CreateAsync(stream.AsRandomAccessStream());
        if (Math.Max(decoder.PixelWidth, decoder.PixelHeight) > ThumbnailService.PreviewMaxPx)
            throw new InvalidOperationException("Edited Browse preview exceeds its bounded tier");
        return (await decoder.GetPixelDataAsync()).DetachPixelData();
    }

    private void VerifyBrowseDetailImageReuse(string thumbnail, string output)
    {
        var photo = ViewModel.SelectedPhoto ?? throw new InvalidOperationException("Missing browse photo");
        var oldThumbnail = photo.ThumbnailPath;
        var oldPreview = photo.PreviewPath;
        var preview = Path.Combine(output, "browse-detail-preview.jpg");
        File.Copy(thumbnail, preview);
        try
        {
            photo.PreviewPath = null;
            photo.ThumbnailPath = thumbnail;
            UpdateBrowseDetailImage();
            var source = BrowseDetailImage.Source;
            if (source == null) throw new InvalidOperationException("Browse thumbnail was not displayed");
            UpdateBrowsePresentation();
            if (!ReferenceEquals(source, BrowseDetailImage.Source))
                throw new InvalidOperationException("Browse presentation recreated the unchanged image source");
            photo.PreviewPath = preview;
            var upgraded = BrowseDetailImage.Source;
            if (upgraded is not Microsoft.UI.Xaml.Media.Imaging.BitmapImage bitmap ||
                bitmap.UriSource != new Uri(preview) || ReferenceEquals(source, upgraded))
                throw new InvalidOperationException("Browse did not upgrade its thumbnail to the preview");
            photo.ThumbnailPath = null;
            if (!ReferenceEquals(upgraded, BrowseDetailImage.Source))
                throw new InvalidOperationException("Thumbnail update replaced the higher-quality preview");
            photo.PreviewPath = null;
            if (BrowseDetailImage.Source != null)
                throw new InvalidOperationException("Browse retained a stale image after both sources cleared");
        }
        finally
        {
            photo.ThumbnailPath = oldThumbnail;
            photo.PreviewPath = oldPreview;
        }
    }
}
