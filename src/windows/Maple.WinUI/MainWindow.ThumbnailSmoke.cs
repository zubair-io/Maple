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
    private static async Task VerifyThumbnailFallbackAsync(string raw, string output)
    {
        var fixture = Path.Combine(output, "thumbnail-source.dng");
        File.Copy(raw, fixture);
        var before = SHA256.HashData(await File.ReadAllBytesAsync(fixture));
        var thumbnails = new ThumbnailService();
        var path = await thumbnails.GetOrCreateAsync(fixture, CancellationToken.None)
            ?? throw new InvalidOperationException("Valid RAW did not produce a thumbnail");
        using (var file = File.OpenRead(path))
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
    }
}
