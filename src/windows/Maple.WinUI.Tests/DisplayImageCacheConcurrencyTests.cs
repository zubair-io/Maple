using System.Diagnostics;
using System.Runtime.CompilerServices;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

[Collection(Bench.CollectionName)]
public sealed class DisplayImageCacheConcurrencyTests(ITestOutputHelper output)
{
    private const int Tiles = 48;

    [NativeDisplayFact]
    public async Task Concurrent_grid_conversion_matches_one_at_a_time_byte_for_byte()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var root = Path.Combine(Path.GetTempPath(), "maple-display-grid-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var avifs = Enumerable.Range(0, Tiles).Select(seed => WriteAvifTile(root, seed)).ToArray();
            var serialCache = Path.Combine(root, "serial");
            var serialClock = Stopwatch.StartNew();
            var serial = new List<string?>();
            foreach (var avif in avifs)
                serial.Add(await DisplayImageCache.PrepareAsync(avif, 512, default, serialCache));
            serialClock.Stop();

            var gridCache = Path.Combine(root, "grid");
            var gridClock = Stopwatch.StartNew();
            var grid = await Task.WhenAll(avifs.Select(avif =>
                DisplayImageCache.PrepareAsync(avif, 512, default, gridCache)));
            gridClock.Stop();

            output.WriteLine($"{Tiles} tiles: one-at-a-time {serialClock.ElapsedMilliseconds} ms, grid {gridClock.ElapsedMilliseconds} ms, cores {Environment.ProcessorCount}");
            Assert.All(serial, path => Assert.NotNull(path));
            Assert.All(grid, path => Assert.NotNull(path));
            for (var index = 0; index < Tiles; index++)
                Assert.Equal(await File.ReadAllBytesAsync(serial[index]!), await File.ReadAllBytesAsync(grid[index]!));
            Assert.Empty(Directory.GetFiles(gridCache, "*.tmp"));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    internal static string WriteAvifTile(string root, int seed)
    {
        const int width = 640, height = 427;
        var tiff = Path.Combine(root, $"tile-{seed}.tif");
        using (var writer = new BinaryWriter(File.Create(tiff)))
        {
            writer.Write(new byte[] { 0x49, 0x49, 42, 0 }); writer.Write(8u); writer.Write((ushort)10);
            void Tag(ushort tag, ushort type, uint count, uint value)
            { writer.Write(tag); writer.Write(type); writer.Write(count); writer.Write(value); }
            Tag(256, 4, 1, width); Tag(257, 4, 1, height); Tag(258, 3, 3, 134);
            Tag(259, 3, 1, 1); Tag(262, 3, 1, 2); Tag(273, 4, 1, 140);
            Tag(277, 3, 1, 3); Tag(278, 4, 1, height); Tag(279, 4, 1, width * height * 3); Tag(284, 3, 1, 1);
            writer.Write(0u);
            for (var channel = 0; channel < 3; channel++) writer.Write((ushort)8);
            var random = new Random(seed);
            var row = new byte[width * 3];
            for (var y = 0; y < height; y++)
            {
                for (var x = 0; x < width; x++)
                    for (var channel = 0; channel < 3; channel++)
                        row[x * 3 + channel] = (byte)(((x + y * 2 + channel * 40 + seed * 7) % 256 + random.Next(0, 24)) & 0xFF);
                writer.Write(row);
            }
        }
        var avif = Path.Combine(root, $"tile-{seed}.avif");
        Assert.Equal(0, RawFfi.maple_raster_resize_to_file(tiff, avif, 512, 512, 2, "avif", 55));
        return avif;
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
