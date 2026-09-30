using System.Runtime.CompilerServices;
using Maple.WinUI.Generated;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class FilmLutCacheTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "maple-film-cache-" + Guid.NewGuid().ToString("N"));
    public FilmLutCacheTests() => Directory.CreateDirectory(_directory);
    public void Dispose() => Directory.Delete(_directory, true);

    [Fact]
    public void EveryGeneratedLookHasAShippedResourceAndUniqueIdentity()
    {
        Assert.NotEmpty(FilmCatalog.All);
        Assert.Equal(FilmCatalog.All.Count, FilmCatalog.All.Select(entry => entry.Id).Distinct().Count());
        foreach (var entry in FilmCatalog.All)
            Assert.True(File.Exists(Path.Combine(AppContext.BaseDirectory, "film-luts", entry.Id + ".mlut")), entry.Id);
    }

    [Fact]
    public async Task ConcurrentRequestsDecodeOnceAndSwitchingBackReusesTheSameLattice()
    {
        var id = FilmCatalog.All[0].Id;
        await File.WriteAllBytesAsync(Path.Combine(_directory, id + ".mlut"), new byte[] { 1 });
        var reads = 0;
        var cache = new FilmLutCache(_directory, _ => { Interlocked.Increment(ref reads); return (2, new float[24]); });
        var results = await Task.WhenAll(Enumerable.Range(0, 30).Select(_ => cache.LoadAsync(id)));
        Assert.Equal(1, reads);
        Assert.All(results, result => Assert.Same(results[0], result));
        Assert.Same(results[0], await cache.LoadAsync(id));
        Assert.NotEqual(0u, results[0]!.Key);
        Assert.Null(await cache.LoadAsync(""));
    }

    [Fact]
    public async Task MissingAndCorruptResourcesCanBeRepairedAndRetried()
    {
        var id = FilmCatalog.All[0].Id;
        var cache = new FilmLutCache(_directory, bytes => bytes[0] == 1
            ? (2u, new float[24]) : throw new InvalidDataException("Corrupt resource"));
        await Assert.ThrowsAsync<FileNotFoundException>(() => cache.LoadAsync(id));
        await File.WriteAllBytesAsync(Path.Combine(_directory, id + ".mlut"), new byte[] { 0 });
        await Assert.ThrowsAsync<InvalidDataException>(() => cache.LoadAsync(id));
        await File.WriteAllBytesAsync(Path.Combine(_directory, id + ".mlut"), new byte[] { 1 });
        Assert.NotNull(await cache.LoadAsync(id));
        await Assert.ThrowsAsync<InvalidDataException>(() => cache.LoadAsync("../outside"));
    }

    [Fact]
    public async Task CancellingOneWaiterDoesNotCancelAnotherConsumersLoad()
    {
        var id = FilmCatalog.All[0].Id;
        await File.WriteAllBytesAsync(Path.Combine(_directory, id + ".mlut"), new byte[] { 1 });
        using var started = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var cache = new FilmLutCache(_directory, _ =>
        {
            started.Set();
            if (!release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException();
            return (2, new float[24]);
        });
        using var cancel = new CancellationTokenSource();
        var first = cache.LoadAsync(id, cancel.Token);
        Assert.True(started.Wait(TimeSpan.FromSeconds(5)));
        var second = cache.LoadAsync(id);
        cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        release.Set();
        Assert.Same(await second, await cache.LoadAsync(id));
    }

    [NativeFilmFact]
    public async Task SharedCoreDecodesEveryShippedFilmResource()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var cache = new FilmLutCache();
        var keys = new HashSet<uint>();
        foreach (var entry in FilmCatalog.All)
        {
            var lut = await cache.LoadAsync(entry.Id);
            Assert.NotNull(lut);
            Assert.Equal(33u, lut.Size);
            Assert.Equal(33 * 33 * 33 * 3, lut.Data.Length);
            Assert.True(keys.Add(lut.Key), "Film cache keys must not collide in the shipped catalog.");
        }
    }
}

public sealed class NativeFilmFactAttribute : FactAttribute
{
    public NativeFilmFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
            Skip = "Set MAPLE_RAW_FFI_DLL to exercise the shared native film decoder.";
    }
}
