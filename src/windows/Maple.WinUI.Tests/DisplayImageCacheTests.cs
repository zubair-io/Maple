using System.Buffers.Binary;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class DisplayImageCacheTests
{
    [Fact]
    public async Task Cancellation_precedes_cache_access_and_non_avif_is_unchanged()
    {
        Assert.Equal("image.jpg", await DisplayImageCache.PrepareAsync("image.jpg", 512, default));
        Assert.Null(await DisplayImageCache.PrepareAsync(null, 512, default));
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            DisplayImageCache.PrepareAsync("missing.avif", 512, cancelled.Token));
    }

    [NativeDisplayFact]
    public async Task Concurrent_avif_reads_preserve_source_and_share_bounded_png_then_recover_after_failure()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var root = Path.Combine(Path.GetTempPath(), "maple-display-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var input = ExportRasterNativeTests.WriteTiff(root);
            var avif = Path.Combine(root, "shared.avif");
            Assert.Equal(0, RawFfi.maple_raster_resize_to_file(input, avif, 16, 16, 0, "avif", 55));
            var original = SHA256.HashData(await File.ReadAllBytesAsync(avif));
            var cache = Path.Combine(root, "display");
            var paths = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ =>
                DisplayImageCache.PrepareAsync(avif, 8, default, cache)));
            var result = Assert.Single(paths.Distinct());
            Assert.NotNull(result);
            var png = await File.ReadAllBytesAsync(result);
            Assert.Equal(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, png[..8]);
            Assert.Equal(8u, BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(16)));
            Assert.Equal(8u, BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(20)));
            var stamp = File.GetLastWriteTimeUtc(result);
            Assert.Equal(result, await DisplayImageCache.PrepareAsync(avif, 8, default, cache));
            Assert.Equal(stamp, File.GetLastWriteTimeUtc(result));
            Assert.Equal(original, SHA256.HashData(await File.ReadAllBytesAsync(avif)));
            var broken = Path.Combine(root, "broken.avif");
            await File.WriteAllTextAsync(broken, "invalid");
            Assert.Null(await DisplayImageCache.PrepareAsync(broken, 8, default, cache));
            File.Copy(avif, broken, overwrite: true);
            Assert.NotNull(await DisplayImageCache.PrepareAsync(broken, 8, default, cache));
            Assert.Empty(Directory.GetFiles(cache, "*.tmp"));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private sealed class NativeDisplayFactAttribute : FactAttribute
    {
        public NativeDisplayFactAttribute()
        {
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
                Skip = "Set MAPLE_RAW_FFI_DLL to test shared AVIF decoding.";
        }
    }
}
